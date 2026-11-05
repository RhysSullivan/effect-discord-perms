/**
 * `transient` errors (DESIGN §3.1): network errors, 5xx responses, the per-call deadline and coded rate limits.
 * Handlers may leave them unhandled. Invariant D6: none of them is in another category.
 *
 * Each keeps what Discord, or the transport, said: `DiscordUnavailable` the 5xx or non-JSON response,
 * `RateLimited` the coded-429 body, and `RequestTimedOut` and `NetworkError` a `NoResponse`.
 */
import { Schema } from "effect"
import { CategorizedError } from "./Category.ts"
import { DiscordResponse, NoResponse } from "./Cause.ts"

/** Discord answered 5xx, or a 4xx with a non-JSON body (a Cloudflare page). */
export class DiscordUnavailable extends CategorizedError<DiscordUnavailable>()("DiscordUnavailable", {
  cause: DiscordResponse
}, ["transient"]) {}

/**
 * The per-call deadline (30 s by default, §4.10) passed with no response; this also bounds dfx's unbounded 429
 * retry loop. The outcome is unknown: for a non-idempotent call (create, crosspost, bulk delete) Discord may
 * already have applied it, so retrying can duplicate it.
 */
export class RequestTimedOut extends CategorizedError<RequestTimedOut>()("RequestTimedOut", {
  cause: NoResponse
}, ["transient"]) {}

/** The request could not be sent or its response could not be read (an HTTP transport error). */
export class NetworkError extends CategorizedError<NetworkError>()("NetworkError", {
  cause: NoResponse
}, ["transient"]) {}

/** A coded 429 (20028, 20022, 30046) surfaced by the coded-429 interceptor instead of being retried by dfx (G2). */
export class RateLimited extends CategorizedError<RateLimited>()("RateLimited", {
  retryAfterMs: Schema.Int,
  cause: DiscordResponse
}, ["transient"]) {}

/**
 * The transient errors every REST call can fail with. `RateLimited` is listed per operation row instead,
 * because only some routes return coded 429s.
 */
export type Transient = DiscordUnavailable | RequestTimedOut | NetworkError

/** Every class in this module, keyed by class name. */
export const TransientClasses = { DiscordUnavailable, RequestTimedOut, NetworkError, RateLimited } as const
