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
 *
 * `sendJson` is the same for a JSON request dfx's generated types cannot express (M8: a command definition whose
 * channel option allows GuildMedia, type 16, which dfx's `ChannelTypes` lacks), sent through `rest.httpClient`, dfx's
 * authenticated and rate-limited client (a dfx deviation, LOG.md).
 */
import type { DiscordRESTError, DiscordRestService } from "dfx/DiscordREST"
import { Clock, Duration, Effect, Option, Schema } from "effect"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import { DiscordResponse, type HttpMethod, NoResponse } from "../errors/Cause.ts"
import { DiscordUnavailable, NetworkError, RequestTimedOut, type Transient } from "../errors/Transient.ts"
import { classify, type DfxFailure, DiscordErrorBody, flattenFieldErrors } from "./ErrorMap.ts"
import { DeclaredRoute } from "./RouteCheck.ts"

/** A call's outcome when Discord answered. */
export type Answered<A> =
  | { readonly _tag: "Ok"; readonly body: A }
  /** Discord refused; `retryAfterMs` is the body's `retry_after` when it has one (a coded 429's, `Coded429.ts`). */
  | { readonly _tag: "Rejected"; readonly response: DiscordResponse; readonly retryAfterMs: number | undefined }

/** A classified failure as a call's outcome: a Discord answer is `Rejected`, anything else is transient. */
const answeredOf = <A>(failure: DfxFailure): Effect.Effect<Answered<A>, Transient> => {
  switch (failure._tag) {
    case "Response":
      return Effect.succeed({ _tag: "Rejected", response: failure.response, retryAfterMs: failure.retryAfterMs })
    case "Unavailable":
      return Effect.fail(new DiscordUnavailable({ cause: failure.response }))
    case "NoResponse":
      return Effect.fail(new NetworkError({ cause: failure.cause }))
  }
}

const timedOut = (route: string, method: HttpMethod, deadline: Duration.Duration) => () =>
  Effect.fail(new RequestTimedOut({ cause: new NoResponse({ route, method, reason: "deadline", afterMs: Duration.toMillis(deadline) }) }))

/**
 * Runs `request` (a dfx call for `method route`, `route` a template such as `/channels/{channel.id}`) within
 * `deadline`. Never fails with a Discord answer; see the module comment.
 */
export const send = <A>(route: string, method: HttpMethod, request: Effect.Effect<A, DiscordRESTError>, deadline: Duration.Duration): Effect.Effect<Answered<A>, Transient> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    return yield* request.pipe(
      Effect.provideService(DeclaredRoute, Option.some({ method, template: route })),
      Effect.matchEffect({
        onFailure: (error) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => classify(error, route, now - started)), Effect.flatMap(answeredOf<A>)),
        onSuccess: (body) => Effect.succeed<Answered<A>>({ _tag: "Ok", body })
      }),
      Effect.timeoutOrElse({ duration: deadline, orElse: timedOut(route, method, deadline) })
    )
  })

const decodeErrorBody = Schema.decodeUnknownOption(DiscordErrorBody)
const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** A response `rest.httpClient` returned, which it does for every status, as a call's outcome (see {@link sendJson}). */
const answeredFromResponse = (route: string, method: HttpMethod, response: HttpClientResponse.HttpClientResponse): Effect.Effect<Answered<Schema.Json>, Transient> =>
  Effect.gen(function* () {
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
    const json = text === "" ? Option.none<Schema.Json>() : decodeJsonText(text)
    if (response.status >= 200 && response.status < 300) {
      if (text !== "" && Option.isNone(json)) return yield* Effect.die(new Error(`${route}: a ${response.status} body that is not JSON`))
      return { _tag: "Ok", body: Option.getOrElse(json, (): Schema.Json => null) }
    }
    const error = Option.flatMap(json, decodeErrorBody)
    if (response.status >= 500 || Option.isNone(error)) {
      const message = response.status >= 500 ? "Discord unavailable" : "non-JSON error body"
      return yield* new DiscordUnavailable({ cause: new DiscordResponse({ status: response.status, code: 0, message, method, route, fieldErrors: [], attributedBy: "code" }) })
    }
    const body = error.value
    const fieldErrors = body.errors === undefined ? [] : flattenFieldErrors(body.errors)
    return {
      _tag: "Rejected",
      response: new DiscordResponse({ status: response.status, code: body.code, message: body.message, method, route, fieldErrors, attributedBy: "code" }),
      retryAfterMs: body.retry_after === undefined ? undefined : Math.ceil(body.retry_after * 1000)
    }
  })

/**
 * Sends `method path` (under the route template `route`) with the JSON `body` (none when `undefined`) through `rest.httpClient`, within
 * `deadline`, and classifies the answer as {@link send} does: a 2xx is `Ok` with its JSON body (`null` when it has
 * none); a 4xx with Discord's JSON error body is `Rejected`; a 5xx or a 4xx without one is `DiscordUnavailable`; a
 * transport failure `NetworkError`; the deadline `RequestTimedOut`. dfx's client waits out and retries an uncoded
 * 429 itself; a coded one (`Coded429`) is a `Rejected` 429 with its code. A 2xx body that is not JSON is a defect.
 */
export const sendJson = (
  rest: DiscordRestService,
  route: string,
  method: HttpMethod,
  path: string,
  body: unknown,
  deadline: Duration.Duration
): Effect.Effect<Answered<Schema.Json>, Transient> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const base = HttpClientRequest.make(method)(path)
    return yield* rest.httpClient.execute(body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body)).pipe(
      Effect.provideService(DeclaredRoute, Option.some({ method, template: route })),
      Effect.matchEffect({
        onFailure: (error) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => classify(error, route, now - started)), Effect.flatMap(answeredOf<Schema.Json>)),
        onSuccess: (response) => answeredFromResponse(route, method, response)
      }),
      Effect.timeoutOrElse({ duration: deadline, orElse: timedOut(route, method, deadline) })
    )
  })
