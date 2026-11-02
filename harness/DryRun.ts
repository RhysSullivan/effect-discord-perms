/**
 * The dry-run switch (DESIGN §5.10 step (b)): a `Context.Reference` the shared base `HttpClient` reads for every
 * request. When it holds a recorder, the request still passes the Lab guard, then is recorded and answered
 * with a canned 2xx body from `fixtures/canned/` instead of being sent; nothing is paced or counted, because
 * nothing reaches Discord. A request without a canned body is a defect.
 *
 * M6 runs the real public operation in `"enforce"` mode under it, so the matrix exercises the user-facing path
 * without an extra Discord request. Until then step (b) is `Preflight.decide` alone (§6 M3).
 */
import { Context, Effect, FileSystem, Option, Ref, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import { routeKey } from "./Pacing.ts"

/** One request the stub answered. */
export interface Recorded {
  readonly method: string
  /** The route as the pacing counters key it: `POST /channels/{id}/messages`. */
  readonly route: string
}

/** A dry run in progress: what it recorded, and the canned bodies by route. */
export interface Recorder {
  readonly record: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<void>
  readonly recorded: Effect.Effect<ReadonlyArray<Recorded>>
  readonly canned: (route: string) => Option.Option<unknown>
}

/** The switch: `None` (the default) sends every request; a recorder answers them instead. */
export const DryRun = Context.Reference<Option.Option<Recorder>>("harness/DryRun", { defaultValue: () => Option.none() })

/** The canned 2xx bodies, by route (`fixtures/canned/`). */
export const cannedFiles: Readonly<Record<string, string>> = {
  "POST /channels/{id}/messages": "create-message.json"
}

/** A recorder over `bodies` (route to canned body). */
export const makeRecorder = (bodies: ReadonlyMap<string, unknown>): Effect.Effect<Recorder> =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<Recorded>>([])
    return {
      record: (request) => Ref.update(log, (entries) => [...entries, { method: request.method, route: routeKey(request.method, request.url) }]),
      recorded: Ref.get(log),
      canned: (route) => Option.fromUndefinedOr(bodies.get(route))
    }
  })

/** The canned bodies' directory. */
export const cannedDirectory = new URL("../fixtures/canned/", import.meta.url).pathname

const CannedBody = Schema.fromJsonString(Schema.Unknown)

/** Reads every canned body listed in {@link cannedFiles}. A missing or malformed file is a defect. */
export const loadCanned: Effect.Effect<ReadonlyMap<string, unknown>, PlatformError, FileSystem.FileSystem> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const bodies = new Map<string, unknown>()
  for (const [route, file] of Object.entries(cannedFiles)) {
    const text = yield* fs.readFileString(`${cannedDirectory}${file}`)
    bodies.set(route, yield* Schema.decodeUnknownEffect(CannedBody)(text).pipe(Effect.orDie))
  }
  return bodies
})
