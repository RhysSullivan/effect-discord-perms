/**
 * Global pacing and request counters for live runs (DESIGN §5.11).
 *
 * One `Pacing` instance serves the whole process. It sits in the shared base `HttpClient`, outside every
 * identity's `Layer.fresh` (§4.2), so it sees the requests of all three identities, including every retry
 * dfx makes after a 429 (dfx re-executes through the base client).
 *
 * - **Bucket.** Request starts are spaced at least `1000 / requestsPerSecond` ms apart across identities
 *   (5 per second by default, configurable lower). dfx's per-route buckets still apply on top.
 * - **Writes.** Every request other than GET and HEAD is counted when it is sent, per route (method plus the
 *   path with snowflakes replaced by `{id}`). `harness:reset` reports this count; a second reset must report
 *   zero (§5.7).
 * - **Invalid requests.** 401, 403 and 429 responses are counted. Discord bans an IP at 10,000 per 10 minutes
 *   (H-094); the run aborts at `invalidCap` (1,500, 15% of that) with a defect, which no scenario can catch.
 * - **Lab-step retries.** A lab step Discord answered with a 5xx and sent again (`Lab.withLabRetries`) is counted
 *   per step, so every run reports how many it needed (§5.11).
 */
import { Clock, Context, Duration, Effect, Layer, Ref } from "effect"

/** What the counters show at one point in time. */
export interface Stats {
  /** Requests started, every identity, every retry. */
  readonly requests: number
  /** Requests other than GET and HEAD. */
  readonly writes: number
  /** Writes per route (`PATCH /channels/{id}`), sorted by route. */
  readonly writesByRoute: ReadonlyArray<readonly [route: string, count: number]>
  /** 401, 403 and 429 responses. */
  readonly invalid: number
  /** 429 responses per route, sorted by route (dfx waits and retries them; each costs time). */
  readonly rateLimitedByRoute: ReadonlyArray<readonly [route: string, count: number]>
  /** Lab steps sent again after a 5xx, per step name, sorted by step (`Lab.withLabRetries`). */
  readonly labRetries: ReadonlyArray<readonly [step: string, count: number]>
}

/** The pacing service. */
export interface Interface {
  /** Waits for the next slot of the global bucket, then counts the request (and the write, if it is one). */
  readonly take: (method: string, url: string) => Effect.Effect<void>
  /**
   * Counts a response's status (and a 429's route). A 429 is also reported at once on stderr with its route
   * template and Discord's rate-limit headers (`retry-after` in seconds, the scope and the bucket), because dfx
   * then waits that long before it retries and a long wait would otherwise look like a hang. Dies when the
   * invalid-request count reaches the cap.
   */
  readonly recordStatus: (status: number, method: string, url: string, limit?: RateLimitHeaders) => Effect.Effect<void>
  /** Counts one retry of lab step `step` after a 5xx. */
  readonly recordRetry: (step: string) => Effect.Effect<void>
  /** The counters so far. */
  readonly stats: Effect.Effect<Stats>
}

/** A 429's rate-limit headers, as Discord sent them (absent ones are `undefined`). */
export interface RateLimitHeaders {
  /** `retry-after`, in seconds. */
  readonly retryAfter: string | undefined
  /** `x-ratelimit-scope`: `user`, `global` or `shared`. */
  readonly scope: string | undefined
  /** `x-ratelimit-bucket`, Discord's bucket hash. */
  readonly bucket: string | undefined
}

/** The process-wide pacing service. */
export class Pacing extends Context.Service<Pacing, Interface>()("harness/Pacing") {}

/** Options for {@link layer}. */
export interface Options {
  /** At most 5; lower values pace the run more gently. */
  readonly requestsPerSecond: number
  /** The run aborts when this many 401/403/429 responses have been seen. */
  readonly invalidCap: number
}

/** The defaults of §5.11. */
export const defaults: Options = { requestsPerSecond: 5, invalidCap: 1500 }

const snowflakeSegment = /^\d{17,20}$/

/**
 * The route a write is counted under: the method and the URL path with every snowflake segment replaced by
 * `{id}`, so counts are stable across runs. The base URL and query are dropped.
 */
export const routeKey = (method: string, url: string): string => {
  const path = new URL(url).pathname.replace(/^\/api\/v\d+/, "")
  const segments = path.split("/").map((segment) => (snowflakeSegment.test(segment) ? "{id}" : segment))
  return `${method.toUpperCase()} ${segments.join("/")}`
}

const isWrite = (method: string): boolean => {
  const upper = method.toUpperCase()
  return upper !== "GET" && upper !== "HEAD"
}

interface Counters {
  readonly nextSlot: number
  readonly requests: number
  readonly writes: ReadonlyMap<string, number>
  readonly invalid: number
  readonly rateLimited: ReadonlyMap<string, number>
  readonly retries: ReadonlyMap<string, number>
}

/** Builds the pacing service. Fails fast (a defect) on options outside 0 < rps <= 5 or a cap below 1. */
export const make = (options: Options): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    if (!(options.requestsPerSecond > 0 && options.requestsPerSecond <= 5)) {
      return yield* Effect.die(new Error(`requestsPerSecond must be in (0, 5], got ${options.requestsPerSecond}`))
    }
    if (!(Number.isInteger(options.invalidCap) && options.invalidCap >= 1)) {
      return yield* Effect.die(new Error(`invalidCap must be a positive integer, got ${options.invalidCap}`))
    }
    const interval = 1000 / options.requestsPerSecond
    const counters = yield* Ref.make<Counters>({ nextSlot: 0, requests: 0, writes: new Map(), invalid: 0, rateLimited: new Map(), retries: new Map() })

    const take = (method: string, url: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const route = isWrite(method) ? routeKey(method, url) : undefined
        const wait = yield* Ref.modify(counters, (current): readonly [number, Counters] => {
          const start = Math.max(now, current.nextSlot)
          const writes = new Map(current.writes)
          if (route !== undefined) writes.set(route, (writes.get(route) ?? 0) + 1)
          return [start - now, { ...current, nextSlot: start + interval, requests: current.requests + 1, writes }]
        })
        if (wait > 0) yield* Effect.sleep(Duration.millis(wait))
      })

    const recordStatus = (status: number, method: string, url: string, limit?: RateLimitHeaders): Effect.Effect<void> =>
      status === 401 || status === 403 || status === 429
        ? Effect.andThen(
          status === 429
            ? Effect.sync(() =>
              console.error(
                `rate limited: ${routeKey(method, url)} retry-after ${limit?.retryAfter ?? "(none)"} s, scope ${limit?.scope ?? "(none)"}, bucket ${limit?.bucket ?? "(none)"}`
              )
            )
            : Effect.void,
          Ref.modify(counters, (current): readonly [number, Counters] => {
          const rateLimited = new Map(current.rateLimited)
          if (status === 429) {
            const route = routeKey(method, url)
            rateLimited.set(route, (rateLimited.get(route) ?? 0) + 1)
          }
          return [current.invalid + 1, { ...current, invalid: current.invalid + 1, rateLimited }]
        }).pipe(
          Effect.flatMap((invalid) =>
            invalid >= options.invalidCap
              ? Effect.die(new Error(`invalid-request budget exhausted: ${invalid} responses with status 401, 403 or 429 (cap ${options.invalidCap})`))
              : Effect.void
          )
        ))
        : Effect.void

    const recordRetry = (step: string): Effect.Effect<void> =>
      Ref.update(counters, (current) => ({ ...current, retries: new Map(current.retries).set(step, (current.retries.get(step) ?? 0) + 1) }))

    const stats = Ref.get(counters).pipe(
      Effect.map((current): Stats => {
        const writesByRoute = [...current.writes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        return {
          requests: current.requests,
          writes: writesByRoute.reduce((sum, [, count]) => sum + count, 0),
          writesByRoute,
          invalid: current.invalid,
          rateLimitedByRoute: [...current.rateLimited.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          labRetries: [...current.retries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        }
      })
    )

    return Pacing.of({ take, recordStatus, recordRetry, stats })
  })

/** The pacing layer with the given options. */
export const layer = (options: Options): Layer.Layer<Pacing> => Layer.effect(Pacing, make(options))
