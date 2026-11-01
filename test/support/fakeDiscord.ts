/**
 * A recording fake of the base `HttpClient`, for tests that build real dfx stacks (DESIGN §4.2 identity test).
 * Nothing leaves the process: every request is recorded and answered by `respond`.
 */
import { DiscordConfig, DiscordRESTMemoryLive } from "dfx"
import type { DiscordREST } from "dfx/DiscordREST"
import { Effect, Layer, Option, Redacted, Ref } from "effect"
import * as Headers from "effect/http/Headers"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as UrlParams from "effect/http/UrlParams"
import { Credentials } from "../../src/config/Credentials.ts"
import { ApplicationId, GuildId } from "../../src/Snowflake.ts"

/** One request as the base client saw it. */
export interface Recorded {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
}

/** A canned answer, with extra response headers (for example `retry-after` on a 429). */
export interface Answer {
  readonly status: number
  readonly body: unknown
  readonly headers?: Readonly<Record<string, string>>
}

/** A recording client and its log. */
export interface RecordingClient {
  readonly layer: Layer.Layer<HttpClient.HttpClient>
  readonly recorded: Effect.Effect<ReadonlyArray<Recorded>>
}

/** Builds a recording client that answers each request with `respond(request)`. */
export const makeRecordingClient = (respond: (request: HttpClientRequest.HttpClientRequest) => Answer): Effect.Effect<RecordingClient> =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<Recorded>>([])
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const authorization = Option.getOrUndefined(Headers.get(request.headers, "authorization"))
        yield* Ref.update(log, (entries) => [...entries, { method: request.method, url: request.url, authorization }])
        const answer = respond(request)
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(answer.body), { status: answer.status, headers: { ...answer.headers, "content-type": "application/json" } })
        )
      })
    )
    return { layer: Layer.succeed(HttpClient.HttpClient, client), recorded: Ref.get(log) }
  })

/** A fake guild ID (a well-formed snowflake that is not Perms Lab). */
export const fakeGuildId = GuildId.make("111111111111111111")

/** Fake credentials: tokens that are not Perms Lab tokens, so no lock is taken. */
export const fakeCredentials = Layer.succeed(
  Credentials,
  Credentials.of({
    guildId: fakeGuildId,
    harness: { token: Redacted.make("fake-harness-token"), applicationId: ApplicationId.make("100000000000000001") },
    subject: { token: Redacted.make("fake-subject-token"), applicationId: ApplicationId.make("100000000000000002") },
    target: { token: Redacted.make("fake-target-token"), applicationId: ApplicationId.make("100000000000000003") }
  })
)

/** What a scripted fake answers: JSON, a raw text body, a transport failure, or nothing at all. */
export type Scripted =
  | { readonly _tag: "Json"; readonly status: number; readonly body: unknown }
  | { readonly _tag: "Text"; readonly status: number; readonly text: string }
  | { readonly _tag: "Transport" }
  | { readonly _tag: "Never" }

/** A JSON answer. */
export const json = (status: number, body: unknown): Scripted => ({ _tag: "Json", status, body })

/**
 * A dfx REST client (the real `DiscordRESTMemoryLive`, fake token) over a fake base client that answers each
 * request with `script(method, path, query)`. Paths are relative to the API base, without the query; `query`
 * holds the request's URL parameters (`urlParams` and any already in the URL).
 */
export const scriptedRest = (script: (method: string, path: string, query: URLSearchParams) => Scripted): Layer.Layer<DiscordREST> => {
  const client = HttpClient.make((request) => {
    const url = new URL(request.url)
    const query = new URLSearchParams(url.search)
    for (const [key, value] of new URLSearchParams(UrlParams.toString(request.urlParams))) query.append(key, value)
    const answer = script(request.method, url.pathname.replace(/^\/api\/v\d+/, ""), query)
    switch (answer._tag) {
      case "Json":
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }))
        )
      case "Text":
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(answer.text, { status: answer.status, headers: { "content-type": "text/html" } })))
      case "Transport":
        return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "connection refused" }) }))
      case "Never":
        return Effect.never
    }
  })
  return DiscordRESTMemoryLive.pipe(Layer.provide(DiscordConfig.layer({ token: Redacted.make("fake-token") })), Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))
}
