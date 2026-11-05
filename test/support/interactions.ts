/**
 * A bot runtime for the interaction runner's tests (DESIGN §4.14, M9): the real `DiscordApi` and route check over a
 * recording fake of Discord, the real dispatch stream, and a stubbed guild state. `publish` hands an INTERACTION_CREATE
 * to the registrations; `sent` lists every request with its JSON body; `logs` every log line, with its annotations.
 */
import { DiscordConfig, DiscordRESTMemoryLive } from "dfx"
import { DiscordREST } from "dfx/DiscordREST"
import { Clock, Effect, Layer, Logger, Redacted, Ref, References, Schema, type Scope } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { BotRuntime } from "../../src/bot/Runtime.ts"
import * as Dispatches from "../../src/gateway/Dispatches.ts"
import * as DiscordApi from "../../src/rest/DiscordApi.ts"
import { checked } from "../../src/rest/RouteCheck.ts"
import { ApplicationId } from "../../src/Snowflake.ts"
import { botId, channel, everyone, guildId, role, set, textId } from "./guild.ts"
import { snapshotOf, stubGuildState } from "./guildStateStub.ts"

export const applicationId = ApplicationId.make("100000000000000002")
export const interactionId = "900000000000000001"
export const token = "aW50ZXJhY3Rpb246dG9rZW4"
export const callback = `/interactions/${interactionId}/${token}/callback`
export const original = `/webhooks/${applicationId}/${token}/messages/@original`
export const followUp = `/webhooks/${applicationId}/${token}`

export interface Sent {
  readonly method: string
  readonly path: string
  readonly body: Schema.Json | undefined
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

/** A message as the webhook routes answer it. */
const messageBody = { id: "500000000000000001", channel_id: textId, type: 0, author: { id: botId, bot: true }, content: "x", tts: false, mention_everyone: false, mention_roles: [], embeds: [], attachments: [], pinned: false }

/**
 * Runs `body` with a bot runtime over a recording fake of Discord (the callback answers 204, the webhook routes a
 * message); `answer` may override an answer by method, path and the interaction's age: the milliseconds since the
 * last `publish`, by `Clock` (so `TestClock` drives it), which is what Discord's 3 s window for the initial response
 * is measured from.
 */
export const withRunner = <A, E>(
  body: (world: { readonly publish: (data: unknown) => Effect.Effect<void>; readonly sent: Effect.Effect<ReadonlyArray<Sent>>; readonly logs: Effect.Effect<ReadonlyArray<string>> }) => Effect.Effect<A, E, BotRuntime | Scope.Scope>,
  answer: (method: string, path: string, ageMs: number) => { readonly status: number; readonly body: Schema.Json } | undefined = () => undefined
) =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<Sent>>([])
    const logs = yield* Ref.make<ReadonlyArray<string>>([])
    const publishedAt = yield* Ref.make(yield* Clock.currentTimeMillis)
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const path = new URL(request.url).pathname.replace(/^\/api\/v\d+/, "")
        const text = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
        yield* Ref.update(sent, (all) => [...all, { method: request.method, path, body: text === undefined ? undefined : decodeJson(text) }])
        const given = answer(request.method, path, (yield* Clock.currentTimeMillis) - (yield* Ref.get(publishedAt)))
        if (given !== undefined) return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(given.body), { status: given.status, headers: { "content-type": "application/json" } }))
        if (path.endsWith("/callback") || request.method === "DELETE") return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(messageBody), { status: 200, headers: { "content-type": "application/json" } }))
      })
    )
    const rest = DiscordRESTMemoryLive.pipe(Layer.provide(DiscordConfig.layer({ token: Redacted.make("fake-token") })), Layer.provide(Layer.succeed(HttpClient.HttpClient, checked(client))))
    const snapshot = snapshotOf({ roles: [role(everyone, set("ViewChannel", "SendMessages"), 0)], channels: [channel("text")], botRoles: [] })
    const stub = yield* stubGuildState(snapshot, snapshot)
    // each line with its annotations (dfx annotates its own log lines with the request's URL and route)
    const collector = Logger.make((options) => {
      const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
      const annotated = Object.keys(annotations).length === 0 ? "" : ` ${JSON.stringify(annotations)}`
      logs.pipe(Ref.update((all) => [...all, `${options.logLevel}: ${[options.message].flat().join(" ")}${annotated}`]), Effect.runSync)
    })
    return yield* Effect.gen(function* () {
      const dispatches = yield* Dispatches.Dispatches
      const api = yield* DiscordApi.make(yield* DiscordREST, stub.state)
      const runtime = BotRuntime.of({
        identity: { userId: botId, username: "bot", applicationId, applicationFlags: 0, guildRoles: [] },
        intents: ["Guilds"],
        guildId,
        guildState: stub.state,
        api,
        events: { subscribe: dispatches.subscribe }
      })
      return yield* Effect.scoped(
        body({
          publish: (data) => Effect.andThen(Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(publishedAt, now)), dispatches.publish({ event: "INTERACTION_CREATE", data })),
          sent: Ref.get(sent),
          logs: Ref.get(logs)
        }).pipe(Effect.provideService(BotRuntime, runtime))
      )
    }).pipe(Effect.provide(Layer.mergeAll(rest, Dispatches.layer)), Effect.provide(Logger.layer([collector])))
  })

/** Lets every forked fiber run as far as it can without the clock moving. */
export const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 200; turn++) yield* Effect.yieldNow
})

export const viewSend = String(set("ViewChannel", "SendMessages"))

/** An INTERACTION_CREATE of `type` with `data`. */
export const interaction = (type: number, data: Schema.Json, extra: Record<string, Schema.Json> = {}) => ({
  id: interactionId,
  application_id: applicationId,
  type,
  token,
  guild_id: guildId,
  channel: { id: textId, type: 0 },
  member: { user: { id: "200000000000000077" } },
  app_permissions: viewSend,
  data,
  ...extra
})

/** The method and path of each request. */
export const only = (sent: ReadonlyArray<Sent>): ReadonlyArray<string> => sent.map((entry) => `${entry.method} ${entry.path}`)
