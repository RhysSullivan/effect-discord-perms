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
import { ApplicationFlags } from "discord-api-types/v10"
import { Credentials } from "../../src/config/Credentials.ts"
import { makeFakeGateway } from "./fakeGateway.ts"
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
  | { readonly _tag: "Json"; readonly status: number; readonly body: unknown; readonly headers?: Readonly<Record<string, string>> }
  | { readonly _tag: "Text"; readonly status: number; readonly text: string }
  | { readonly _tag: "Transport" }
  | { readonly _tag: "Never" }

/** A JSON answer, with extra response headers (rate-limit headers, for example). */
export const json = (status: number, body: unknown, headers?: Readonly<Record<string, string>>): Scripted =>
  headers === undefined ? { _tag: "Json", status, body } : { _tag: "Json", status, body, headers }

/**
 * A dfx REST client (the real `DiscordRESTMemoryLive`, fake token) over a fake base client that answers each
 * request with `script(method, path, query)`. Paths are relative to the API base, without the query; `query`
 * holds the request's URL parameters (`urlParams` and any already in the URL).
 */
export const scriptedRest = (
  script: (method: string, path: string, query: URLSearchParams) => Scripted,
  wrap?: (client: HttpClient.HttpClient) => HttpClient.HttpClient
): Layer.Layer<DiscordREST> => scriptedRestEffect((method, path, query) => Effect.succeed(script(method, path, query)), wrap)

/**
 * Like {@link scriptedRest}, but each answer is an effect, so a test can hold a response until it chooses.
 * `wrap` wraps the base client the way a bot build does (the coded-429 interceptor, `Coded429.surface`).
 */
export const scriptedRestEffect = (
  script: (method: string, path: string, query: URLSearchParams) => Effect.Effect<Scripted>,
  wrap: (client: HttpClient.HttpClient) => HttpClient.HttpClient = (client) => client
): Layer.Layer<DiscordREST> => {
  const client = HttpClient.make((request) => {
    const url = new URL(request.url)
    const query = new URLSearchParams(url.search)
    for (const [key, value] of new URLSearchParams(UrlParams.toString(request.urlParams))) query.append(key, value)
    return Effect.flatMap(script(request.method, url.pathname.replace(/^\/api\/v\d+/, ""), query), (answer) => answerWith(request, answer))
  })
  return DiscordRESTMemoryLive.pipe(Layer.provide(DiscordConfig.layer({ token: Redacted.make("fake-token") })), Layer.provide(Layer.succeed(HttpClient.HttpClient, wrap(client))))
}

const answerWith = (request: HttpClientRequest.HttpClientRequest, answer: Scripted) => {
    switch (answer._tag) {
      case "Json":
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(answer.body), { status: answer.status, headers: { ...answer.headers, "content-type": "application/json" } }))
        )
      case "Text":
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(answer.text, { status: answer.status, headers: { "content-type": "text/html" } })))
      case "Transport":
        return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "connection refused" }) }))
      case "Never":
        return Effect.never
    }
}

/** The subject's user ID in the fakes. */
export const fakeSubjectUserId = "200000000000000001"

/**
 * The answers the subject's bot build needs to start (§4.4 checks 1-3, with GuildMembers and MessageContent
 * enabled; dfx's `/gateway/bot`, which it tolerates failing), or `undefined` for any other request.
 */
export const subjectStartupAnswer = (request: HttpClientRequest.HttpClientRequest, subjectUserId: string = fakeSubjectUserId): Answer | undefined => {
  if (Option.getOrUndefined(Headers.get(request.headers, "authorization")) !== "Bot fake-subject-token") return undefined
  const path = new URL(request.url).pathname.replace(/^\/api\/v\d+/, "")
  if (path === "/users/@me") return { status: 200, body: { id: subjectUserId, username: "Perms Subject" } }
  if (path === "/applications/@me") return { status: 200, body: { id: "100000000000000002", flags: ApplicationFlags.GatewayGuildMembers | ApplicationFlags.GatewayMessageContent } }
  if (path === `/guilds/${fakeGuildId}/members/${subjectUserId}`) return { status: 200, body: { user: { id: subjectUserId }, roles: [] } }
  if (path === "/gateway/bot") return { status: 404, body: { message: "404: Not Found", code: 0 } }
  return undefined
}

/** A GUILD_CREATE for the fake guild with only `@everyone` and the subject's member. */
export const fakeGuildCreate = (subjectUserId: string = fakeSubjectUserId) => ({
  id: fakeGuildId,
  name: "Perms Lab",
  owner_id: "200000000000000099",
  roles: [{ id: fakeGuildId, name: "@everyone", permissions: "0", position: 0, managed: false, mentionable: false }],
  channels: [],
  threads: [],
  members: [{ user: { id: subjectUserId }, roles: [], communication_disabled_until: null }]
})

/** A fake gateway where the subject's token identifies as `subjectUserId` and the fake guild arrives. */
export const fakeSubjectGateway = (subjectUserId: string = fakeSubjectUserId) =>
  makeFakeGateway({ userFor: (token) => (token === "fake-subject-token" ? subjectUserId : undefined), guildsFor: () => [fakeGuildCreate(subjectUserId)] }, () => 0)
