/**
 * The permission oracle (DESIGN §5.10 step 8, D16; H-240, H-241). Harness only; not in the public barrel.
 *
 * `GET /channels/{channel.id}/permissions/member/{user.id}?implicit=false` returns a member's permissions in a
 * channel as Discord computes them: base permissions and overwrites, with threads using their parent's
 * overwrites, and without implicit masking (which Discord never applies to bot targets anyway). The caller
 * needs View (and Connect in voice and stage); the harness, an administrator, makes the call.
 *
 * Neither dfx 1.1.1 nor discord-api-types knows the route (published 2026-10-30), so it goes through the
 * caller's `rest.httpClient`: dfx's authenticated, rate-limited client (a dfx deviation, LOG.md).
 *
 * If the route does not exist (404 with code 0, or 405), the oracle is `Unavailable`; the truth table header
 * records that, and flip controls carry the blame check instead (§5.10).
 */
import type { DiscordRestService } from "dfx/DiscordREST"
import { Clock, Duration, Effect, Option, Schema } from "effect"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { DiscordResponse, NoResponse } from "../errors/Cause.ts"
import type { ChannelId, UserId } from "../Snowflake.ts"
import { DiscordErrorBody, flattenFieldErrors } from "./ErrorMap.ts"

/** The route template, as recorded in causes. */
export const route = "/channels/{channel.id}/permissions/member/{user.id}"

/** One oracle read. */
export type OracleRead =
  /** The member's computed permissions (implicit masking off). */
  | { readonly _tag: "Permissions"; readonly permissions: bigint }
  /** The route does not exist: Discord answered 404 without a code, or 405. */
  | { readonly _tag: "Unavailable"; readonly status: number }

/** The oracle could not be read: Discord answered with an error, or did not answer. */
export class OracleFailed extends Schema.TaggedError<OracleFailed>()("OracleFailed", {
  cause: Schema.Union([DiscordResponse, NoResponse])
}) {}

const PermissionsBody = Schema.Struct({ permissions: Schema.String.check(Schema.isPattern(/^\d+$/)) })
const decodePermissions = Schema.decodeUnknownEffect(PermissionsBody)
const decodeError = Schema.decodeUnknownOption(DiscordErrorBody)

/**
 * Reads `user`'s permissions in `channel` with `rest` (the harness's client). `deadline` bounds the call,
 * including dfx's 429 retries. A 2xx body that does not decode is a defect.
 */
export const memberPermissions = (
  rest: DiscordRestService,
  channel: ChannelId,
  user: UserId,
  deadline: Duration.Duration
): Effect.Effect<OracleRead, OracleFailed> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const noResponse = (reason: "transport" | "deadline", afterMs: number) =>
      new OracleFailed({ cause: new NoResponse({ route, method: "GET", reason, afterMs }) })
    const request = HttpClientRequest.get(`/channels/${channel}/permissions/member/${user}`, { urlParams: { implicit: "false" } })
    const response = yield* rest.httpClient.execute(request).pipe(
      Effect.catch((error) =>
        error.reason._tag === "TransportError"
          ? Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Effect.fail(noResponse("transport", now - started))))
          : Effect.die(new Error(`${route}: ${error.reason._tag}`))
      ),
      Effect.timeoutOrElse({ duration: deadline, orElse: () => Effect.fail(noResponse("deadline", Duration.toMillis(deadline))) })
    )
    const body = yield* response.json.pipe(Effect.option)
    if (response.status >= 200 && response.status < 300) {
      const decoded = yield* Option.match(body, {
        onNone: () => Effect.die(new Error(`${route}: ${response.status} without a JSON body`)),
        onSome: (json) => decodePermissions(json).pipe(Effect.orDie)
      })
      return { _tag: "Permissions", permissions: BigInt(decoded.permissions) }
    }
    const error = Option.flatMap(body, decodeError)
    const code = Option.match(error, { onNone: () => 0, onSome: (decoded) => decoded.code })
    if (response.status === 405 || (response.status === 404 && code === 0)) return { _tag: "Unavailable", status: response.status }
    return yield* new OracleFailed({
      cause: new DiscordResponse({
        status: response.status,
        code,
        message: Option.match(error, { onNone: () => "non-JSON error body", onSome: (decoded) => decoded.message }),
        method: "GET",
        route,
        fieldErrors: Option.match(error, { onNone: () => [], onSome: (decoded) => (decoded.errors === undefined ? [] : flattenFieldErrors(decoded.errors)) }),
        attributedBy: "code"
      })
    })
  })
