/**
 * One bounded dfx call with its failure classified (DESIGN §4.9, §4.10): the shape M5's `DiscordApi` builds on,
 * used in M3 by `GuildState.refresh`.
 *
 * - The call is bounded by `deadline` (which also bounds dfx's unbounded 429 retries); passing it is
 *   `RequestTimedOut` with a `NoResponse` cause.
 * - A transport failure is `NetworkError`, a 5xx or a non-JSON 4xx is `DiscordUnavailable` (`classify`).
 * - A Discord JSON error answer is returned as `Rejected` with the copied `DiscordResponse`, for the caller to
 *   map: what a code means depends on the operation, and an unmapped code is the caller's defect.
 * - The call is made under its declared route (`RouteCheck.DeclaredRoute`): a bot build's HTTP client holds the
 *   request dfx builds to `method` and `route`, and a request that does not match them is a defect.
 */
import type { DiscordRESTError } from "dfx/DiscordREST"
import { Clock, Duration, Effect, Option } from "effect"
import { type DiscordResponse, type HttpMethod, NoResponse } from "../errors/Cause.ts"
import { DiscordUnavailable, NetworkError, RequestTimedOut, type Transient } from "../errors/Transient.ts"
import { classify } from "./ErrorMap.ts"
import { DeclaredRoute } from "./RouteCheck.ts"

/** A call's outcome when Discord answered. */
export type Answered<A> =
  | { readonly _tag: "Ok"; readonly body: A }
  /** Discord refused; `retryAfterMs` is the body's `retry_after` when it has one (a coded 429's, `Coded429.ts`). */
  | { readonly _tag: "Rejected"; readonly response: DiscordResponse; readonly retryAfterMs: number | undefined }

/**
 * Runs `request` (a dfx call for `method route`, `route` a template such as `/channels/{channel.id}`) within
 * `deadline`. Never fails with a Discord answer; see the module comment.
 */
export const send = <A>(route: string, method: HttpMethod, request: Effect.Effect<A, DiscordRESTError>, deadline: Duration.Duration): Effect.Effect<Answered<A>, Transient> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    return yield* request.pipe(
      Effect.provideService(DeclaredRoute, Option.some({ method, template: route })),
      Effect.map((body): Answered<A> => ({ _tag: "Ok", body })),
      Effect.catch((error) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => classify(error, route, now - started)),
          Effect.flatMap((failure): Effect.Effect<Answered<A>, Transient> => {
            switch (failure._tag) {
              case "Response":
                return Effect.succeed({ _tag: "Rejected", response: failure.response, retryAfterMs: failure.retryAfterMs })
              case "Unavailable":
                return Effect.fail(new DiscordUnavailable({ cause: failure.response }))
              case "NoResponse":
                return Effect.fail(new NetworkError({ cause: failure.cause }))
            }
          })
        )
      ),
      Effect.timeoutOrElse({
        duration: deadline,
        orElse: () => Effect.fail(new RequestTimedOut({ cause: new NoResponse({ route, method, reason: "deadline", afterMs: Duration.toMillis(deadline) }) }))
      })
    )
  })
