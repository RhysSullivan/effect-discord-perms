/**
 * The coded-429 interceptor (DESIGN §4.10, G2; `[cc:src/coded-429-runtime.ts]`): a wrapper of the **base**
 * `HttpClient` the library hands to dfx.
 *
 * dfx retries every 429 after its `retry-after`, forever (dfx.md §3). Most 429s are rate limits that waiting
 * fixes, but some carry a Discord code that names a condition the caller must see: slowmode (20016), the
 * channel write limit (20028), the announcement edit limit (20022), edits of old messages (30046) and the daily
 * command-create allowance (30034). Retrying those only stalls the caller until the request deadline.
 *
 * - A 429 whose JSON body has a nonzero integer `code` fails with `HttpClientError(StatusCodeError)` whose
 *   `cause` is a {@link Coded429} holding the decoded body, so dfx never sees the response and never retries it.
 *   (dfx's rate-limit bucket update for that response is skipped too; LOG.md records the deviation.)
 * - A 429 without a code, with code 0, or with a body that is not such JSON passes through unchanged, and dfx
 *   waits and retries as before. dfx reads only the headers of a 429, so reading the body here is safe.
 *
 * `ErrorMap.classify` turns the `StatusCodeError` back into a Discord answer with status 429, and the error map
 * gives it its tag (`RateLimited`, `SlowmodeActive` while `Observed.slowmodeAppliesToBots`, or a defect).
 */
import { Effect, Layer, Option, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"

/** A coded 429's body (REF "Rate Limits"; `retry_after` in seconds). */
export const Coded429Body = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  retry_after: Schema.Number,
  global: Schema.Boolean
})

/** What a coded 429 said: Discord's code and message, how long to wait, and whether the limit is global. */
export class Coded429 extends Schema.TaggedClass<Coded429>()("Coded429", {
  code: Schema.Int,
  message: Schema.String,
  /** `retry_after`, in milliseconds (rounded up). */
  retryAfterMs: Schema.Int,
  global: Schema.Boolean
}) {}

const decodeBody = Schema.decodeUnknownOption(Coded429Body)

/** The coded 429 in a response, if it is one (see the module comment). */
const codedOf = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<Option.Option<Coded429>> =>
  response.status !== 429
    ? Effect.succeedNone
    : response.json.pipe(
      Effect.option,
      Effect.map((body) =>
        Option.flatMap(Option.flatMap(body, decodeBody), (decoded) =>
          decoded.code === 0
            ? Option.none()
            : Option.some(new Coded429({ code: decoded.code, message: decoded.message, retryAfterMs: Math.ceil(decoded.retry_after * 1000), global: decoded.global }))
        )
      )
    )

/** `client`, with coded 429s surfaced as `StatusCodeError`s carrying a {@link Coded429} (see the module comment). */
export const surface = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  client.pipe(
    HttpClient.transformResponse(
      Effect.flatMap((response) =>
        codedOf(response).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(response),
              onSome: (coded) =>
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.StatusCodeError({ request: response.request, response, cause: coded, description: `Discord code ${coded.code}` })
                  })
                )
            })
          )
        )
      )
    )
  )

/** The interceptor as a layer: the `HttpClient` it needs, wrapped by {@link surface}. */
export const layer: Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient> = Layer.effect(HttpClient.HttpClient, Effect.map(Effect.service(HttpClient.HttpClient), surface))
