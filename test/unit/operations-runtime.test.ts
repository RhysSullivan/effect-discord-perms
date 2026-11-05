import { describe, expect, it } from "@effect/vitest"
import { DiscordConfig, DiscordRESTMemoryLive } from "dfx"
import { DiscordREST } from "dfx/DiscordREST"
import { Cause, Effect, Exit, Layer, Option, Redacted, Ref, Schema, Tracer } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as TestClock from "effect/testing/TestClock"
import { bodyOf, pathOf } from "../../harness/DryRun.ts"
import { BotRuntime } from "../../src/bot/Bot.ts"
import { Channels, channelHandle, messageHandle, type Runtime } from "../../src/channels/Ops.ts"
import { NoResponse } from "../../src/errors/Cause.ts"
import { categoriesOf } from "../../src/errors/Category.ts"
import type { PermissionFlag } from "../../src/errors/Missing.generated.ts"
import { NetworkError, type Transient } from "../../src/errors/Transient.ts"
import { memberHandle } from "../../src/members/Member.ts"
import * as Preflight from "../../src/permissions/Preflight.ts"
import { Permissions } from "../../src/permissions/Require.ts"
import * as DiscordApi from "../../src/rest/DiscordApi.ts"
import { checked } from "../../src/rest/RouteCheck.ts"
import * as Schemas from "../../src/rest/Schemas.ts"
import { ApplicationId, ChannelId, EmojiId, ForumTagId, MessageId, RoleId, UserId } from "../../src/Snowflake.ts"
import type { Snapshot } from "../../src/state/Snapshot.ts"
import { botId, channel, everyone, guildId, later, now, otherId, role, roleA, roleB, roleOverwrite, set, textId, thread, threadId } from "../support/guild.ts"
import { snapshotOf, stubGuildState } from "../support/guildStateStub.ts"

/**
 * The operations' pipeline (DESIGN §4.7, §4.8) through the public handles, over the real `DiscordApi` and dfx client
 * with a scripted base client: preflight decides from the guild state before anything is sent (with a
 * `PreflightDecision` cause), the local limits rank after it, `"bypass"` sends and lets the recompute decide, the
 * send's readback reports what Discord dropped, a reaction needs AddReactions only for a new emoji, `require`
 * narrows (D8), `Channels.get` refuses a channel the bot cannot see, member operations check the hierarchy, the
 * operation's span carries its attributes, and every operation sends its own method, path and body (the M6
 * verifier), through a client that holds each request to its declared route (`RouteCheck.checked`).
 */
interface Sent {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

interface Answer {
  readonly status: number
  readonly body: unknown
}

const ok = (body: unknown): Answer => ({ status: 200, body })
const empty: Answer = { status: 204, body: null }
const refused = (status: number, code: number): Answer => ({ status, body: { message: "refused", code } })

const messageWire = (overrides: Record<string, unknown> = {}) => ({
  id: "500000000000000001",
  channel_id: textId,
  type: 0,
  author: { id: botId, bot: true },
  content: "hi",
  tts: false,
  mention_everyone: false,
  mention_roles: [],
  embeds: [],
  attachments: [],
  pinned: false,
  ...overrides
})
const decodeMessage = Schema.decodeUnknownSync(Schemas.Message)

/**
 * A runtime over a guild state holding `before` (a refresh gives `after`) and a base client answering with `answer`.
 * Each request is recorded with its path under the API base (and its sorted query) and its body: JSON as sent, a
 * multipart body's parts (`DryRun.bodyOf`), `null` for none. The client is wrapped as a bot build wraps it, by the
 * declared-route check.
 */
const runtimeWith = (options: { readonly before: Snapshot; readonly after?: Snapshot; readonly refreshFails?: Transient; readonly answer: (method: string, path: string) => Answer }) =>
  Effect.gen(function* () {
    const sent: Array<Sent> = []
    const client = HttpClient.make((request) =>
      Effect.map(bodyOf(request.body), (body) => {
        const path = pathOf(request)
        sent.push({ method: request.method, path, body })
        const answer = options.answer(request.method, path)
        return HttpClientResponse.fromWeb(request, new Response(answer.status === 204 ? null : JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }))
      })
    ).pipe(checked)
    const rest = yield* Effect.service(DiscordREST).pipe(
      Effect.provide(DiscordRESTMemoryLive.pipe(Layer.provide(DiscordConfig.layer({ token: Redacted.make("fake-token") })), Layer.provide(Layer.succeed(HttpClient.HttpClient, client))))
    )
    const stub = yield* stubGuildState(options.before, options.after ?? options.before, options.refreshFails)
    const api = yield* DiscordApi.make(rest, stub.state)
    const runtime: Runtime = {
      identity: { userId: botId, username: "bot", applicationId: ApplicationId.make("100000000000000002"), applicationFlags: 0, guildRoles: [] },
      intents: [],
      guildId,
      guildState: stub.state,
      api,
      // these tests run operations only; no dispatch ever arrives
      events: { subscribe: () => Effect.void },
      interactionHandlers: yield* Ref.make<ReadonlySet<string>>(new Set())
    }
    return { runtime, sent, refreshes: stub.refreshes }
  })

const textOf = (runtime: Runtime) => channelHandle(runtime, { guildId, id: textId, kind: "text" })

/** The typed failure of an exit: its tag, categories and its cause's kind. */
const failureOf = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) return "succeeded"
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isNone(error)) return `no typed failure: ${Cause.pretty(exit.cause)}`
  const value: object = error.value
  const cause: unknown = "cause" in value ? value.cause : undefined
  const by = typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : "none"
  return { tag: error.value._tag, categories: [...categoriesOf(error.value)], cause: by }
}

const sendable = (...flags: ReadonlyArray<PermissionFlag>) => snapshotOf({ roles: [role(everyone, set(...flags), 0)], channels: [channel("text")], botRoles: [] })

describe("the pipeline", () => {
  it.effect("fails a send preflight refuses before sending anything, with the D5 variant and a PreflightDecision cause", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const { runtime, sent } = yield* runtimeWith({ before: sendable("ViewChannel", "SendMessages"), answer: () => ok(messageWire()) })
      const embed = yield* textOf(runtime).send({ content: "hi", embeds: [{ title: "t" }] }).pipe(Effect.exit)
      expect(failureOf(embed)).toEqual({ tag: "MissingEmbedLinks", categories: ["payload", "permission"], cause: "PreflightDecision" })
      const reply = yield* textOf(runtime).send({ content: "hi", reply: { messageId: MessageId.make("500000000000000009") } }).pipe(Effect.exit)
      expect(failureOf(reply)).toEqual({ tag: "MissingReadMessageHistory", categories: ["payload", "permission"], cause: "PreflightDecision" })
      expect(sent).toEqual([])
    })
  )

  it.effect("sends what ToDfx builds, and returns the bot's own message with what Discord dropped (§4.12)", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const mentioned = RoleId.make("400000000000000077")
      const { runtime, sent } = yield* runtimeWith({ before: sendable("ViewChannel", "SendMessages"), answer: () => ok(messageWire({ mention_roles: [] })) })
      const result = yield* textOf(runtime).send({ content: `<@&${mentioned}>`, mentions: { roles: [mentioned] } })
      expect(sent).toEqual([{ method: "POST", path: `/channels/${textId}/messages`, body: { allowed_mentions: { parse: [], roles: [mentioned] }, content: `<@&${mentioned}>` } }])
      expect([result.message.author, result.message.channelKind, result.message.id]).toEqual(["self", "text", "500000000000000001"])
      expect(result.degraded).toEqual(["MentionEveryone"])
      const kept = yield* runtimeWith({ before: sendable("ViewChannel", "SendMessages"), answer: () => ok(messageWire({ mention_roles: [mentioned] })) })
      expect((yield* textOf(kept.runtime).send({ content: `<@&${mentioned}>`, mentions: { roles: [mentioned] } })).degraded).toEqual([])
      // TTS Discord sent as a normal message is SendTTSMessages (H-102)
      const tts = yield* runtimeWith({ before: sendable("ViewChannel", "SendMessages"), answer: () => ok(messageWire({ tts: false })) })
      expect((yield* textOf(tts.runtime).send({ content: "hi", tts: true })).degraded).toEqual(["SendTTSMessages"])
    })
  )

  it.effect("reports a custom emoji Discord rewrote to text as UseExternalEmojis, and nothing when the token was kept (H-104)", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const token = "<:party:123456789012345678>"
      const animated = "<a:wave:123456789012345679>"
      const rewritten = yield* runtimeWith({ before: sendable("ViewChannel", "SendMessages"), answer: () => ok(messageWire({ content: `look :party: ${animated}` })) })
      expect((yield* textOf(rewritten.runtime).send({ content: `look ${token} ${animated}` })).degraded).toEqual(["UseExternalEmojis"])
      const kept = yield* runtimeWith({ before: sendable("ViewChannel", "SendMessages"), answer: () => ok(messageWire({ content: `look ${token} ${animated}` })) })
      expect((yield* textOf(kept.runtime).send({ content: `look ${token} ${animated}` })).degraded).toEqual([])
      // content with no custom emoji cannot degrade, whatever Discord answers
      const plain = yield* runtimeWith({ before: sendable("ViewChannel", "SendMessages"), answer: () => ok(messageWire({ content: "other" })) })
      expect((yield* textOf(plain.runtime).send({ content: "look" })).degraded).toEqual([])
    })
  )

  it.effect("ranks the local limits after preflight: a missing flag first, the limit only when preflight passes, nothing sent either way", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const long = "a".repeat(2001)
      const blocked = yield* runtimeWith({ before: sendable("ViewChannel"), answer: () => ok(messageWire()) })
      expect(failureOf(yield* textOf(blocked.runtime).send({ content: long }).pipe(Effect.exit))).toMatchObject({ tag: "MissingSendMessages" })
      const allowed = yield* runtimeWith({ before: sendable("ViewChannel", "SendMessages"), answer: () => ok(messageWire()) })
      expect(failureOf(yield* textOf(allowed.runtime).send({ content: long }).pipe(Effect.exit))).toEqual({ tag: "ContentTooLong", categories: ["payload"], cause: "PreflightDecision" })
      expect([...blocked.sent, ...allowed.sent]).toEqual([])
    })
  )

  it.effect("in bypass mode sends without preflight, and the recompute attributes Discord's refusal from the refreshed state", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const { runtime, sent, refreshes } = yield* runtimeWith({
        before: sendable("ViewChannel", "SendMessages", "EmbedLinks"),
        after: sendable("ViewChannel", "SendMessages"),
        answer: () => refused(403, 50013)
      })
      const exit = yield* textOf(runtime).send({ content: "hi", embeds: [{ title: "t" }] }).pipe(Effect.provideService(Preflight.Mode, "bypass"), Effect.exit)
      expect(failureOf(exit)).toEqual({ tag: "MissingEmbedLinks", categories: ["payload", "permission"], cause: "DiscordResponse" })
      expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([`POST /channels/${textId}/messages`])
      expect(yield* refreshes).toEqual([`refresh ${textId}`])
    })
  )

  it.effect("refreshes a stale guild before deciding", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const stale = sendable("ViewChannel")
      const guild = stale.guilds.get(guildId)
      if (guild === undefined) throw new Error("no guild")
      const { runtime, sent, refreshes } = yield* runtimeWith({ before: { ...stale, guilds: new Map([[guildId, { ...guild, stale: true }]]) }, after: sendable("ViewChannel", "SendMessages"), answer: () => ok(messageWire()) })
      yield* textOf(runtime).send({ content: "hi" })
      expect(yield* refreshes).toEqual([`refresh ${textId}`])
      expect(sent).toHaveLength(1)
    })
  )

  it.effect("runs in a discord.<area>.<op> span with the route, channel kind, guild and required flags, failed even when the caller recovers", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        }
      })
      const { runtime } = yield* runtimeWith({ before: sendable("ViewChannel", "SendMessages"), answer: () => ok(messageWire()) })
      const caught = yield* textOf(runtime)
        .send({ content: "hi", embeds: [{ title: "t" }] })
        .pipe(
          Effect.catchTag("MissingEmbedLinks", () => Effect.succeed("caught")),
          Effect.provideService(Tracer.Tracer, tracer)
        )
      expect(caught).toBe("caught")
      const span = spans.find((candidate) => candidate.name === "discord.channel.send")
      expect(span?.status._tag === "Ended" && Exit.isFailure(span.status.exit)).toBe(true)
      expect(Object.fromEntries(span?.attributes ?? [])).toEqual({
        "discord.route": "/channels/{channel.id}/messages",
        "discord.channel_kind": "text",
        "discord.guild_id": guildId,
        "discord.required_flags": "EmbedLinks,SendMessages,ViewChannel"
      })
    })
  )
})

describe("reactions (conditional AddReactions, §4.7)", () => {
  const foreign = (reactions: ReadonlyArray<unknown> | undefined) => decodeMessage(messageWire({ author: { id: otherId, bot: true }, ...(reactions === undefined ? {} : { reactions }) }))

  it.effect("needs AddReactions for a new emoji, not for one already on the message, and checks nothing it cannot know", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const { runtime, sent } = yield* runtimeWith({ before: sendable("ViewChannel"), answer: () => empty })
      const handleOf = (wire: Schemas.Message) => messageHandle(runtime, { guildId, id: textId, kind: "text" }, wire)
      const fresh = handleOf(foreign([]))
      expect(fresh.author).toBe("other")
      expect(failureOf(yield* fresh.react({ origin: "unicode", name: "👍" }).pipe(Effect.exit))).toMatchObject({ tag: "MissingAddReactions", cause: "PreflightDecision" })
      expect(sent).toEqual([])
      yield* handleOf(foreign([{ count: 1, me: false, emoji: { id: null, name: "👍" } }])).react({ origin: "unicode", name: "👍" })
      expect(sent.map((request) => request.path)).toEqual([`/channels/${textId}/messages/500000000000000001/reactions/${encodeURIComponent("👍")}/@me`])
    })
  )

  it.effect("needs UseExternalEmojis for another guild's emoji", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const { runtime, sent } = yield* runtimeWith({ before: sendable("ViewChannel", "AddReactions"), answer: () => empty })
      const handle = messageHandle(runtime, { guildId, id: textId, kind: "text" }, foreign([]))
      const exit = yield* handle.react({ origin: "external", id: EmojiId.make("123456789012345678"), name: "x" }).pipe(Effect.exit)
      expect(failureOf(exit)).toMatchObject({ tag: "MissingUseExternalEmojis", cause: "PreflightDecision" })
      expect(sent).toEqual([])
      yield* handle.react({ origin: "guild", id: EmojiId.make("123456789012345678"), name: "x" })
      expect(sent.map((request) => request.path)).toEqual([`/channels/${textId}/messages/500000000000000001/reactions/x:123456789012345678/@me`])
    })
  )
})

describe("Permissions.require (§2.6, D8)", () => {
  it.effect("returns the channel with the checked flags granted; a later refusal of a checked flag is PermissionRevokedSinceCheck", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const { runtime } = yield* runtimeWith({ before: sendable("ViewChannel", "SendMessages"), after: sendable("ViewChannel"), answer: () => refused(403, 50013) })
      const checked = yield* Permissions.require(textOf(runtime), ["SendMessages"])
      expect([checked.kind, checked.granted]).toEqual(["text", ["SendMessages"]])
      const exit = yield* checked.send({ content: "hi" }).pipe(Effect.exit)
      expect(failureOf(exit)).toEqual({ tag: "PermissionRevokedSinceCheck", categories: ["permission"], cause: "DiscordResponse" })
    })
  )

  it.effect("fails with the most fundamental problem: ViewChannel, then the timeout, then SendMessages, then the other flags", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const run = (state: Snapshot, flags: Parameters<typeof Permissions.require>[1]) =>
        Effect.flatMap(runtimeWith({ before: state, answer: () => empty }), ({ runtime }) => Permissions.require(textOf(runtime), flags).pipe(Effect.exit))
      expect(failureOf(yield* run(sendable(), ["EmbedLinks", "SendMessages"]))).toMatchObject({ tag: "MissingViewChannel", cause: "PreflightDecision" })
      expect(failureOf(yield* run(sendable("ViewChannel"), ["EmbedLinks", "SendMessages"]))).toMatchObject({ tag: "MissingSendMessages" })
      expect(failureOf(yield* run(sendable("ViewChannel", "SendMessages"), ["EmbedLinks", "SendMessages"]))).toMatchObject({ tag: "MissingEmbedLinks" })
      const timedOut = snapshotOf({ roles: [role(everyone, set("ViewChannel", "SendMessages"), 0)], channels: [channel("text")], botRoles: [], timedOutUntil: later })
      expect(failureOf(yield* run(timedOut, ["SendMessages"]))).toMatchObject({ tag: "CommunicationDisabled" })
      // View and ReadMessageHistory survive a timeout (H-020)
      expect(failureOf(yield* run(timedOut, ["ViewChannel"]))).toBe("succeeded")
    })
  )
})

describe("a state that cannot resolve the channel even after a refresh (§4.7, the M6 verifier)", () => {
  const without = snapshotOf({ roles: [role(everyone, set(), 0)], channels: [], botRoles: [] })

  it.effect("Permissions.require checks nothing, so it fails with UnknownChannel and never grants", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const { runtime, sent, refreshes } = yield* runtimeWith({ before: without, answer: () => ok(messageWire()) })
      const exit = yield* Permissions.require(textOf(runtime), ["SendMessages"]).pipe(Effect.exit)
      expect(failureOf(exit)).toEqual({ tag: "UnknownChannel", categories: ["state"], cause: "PreflightDecision" })
      expect(yield* refreshes).toEqual([`refresh ${textId}`])
      expect(sent).toEqual([])
    })
  )

  it.effect("an operation is sent unchecked, and Discord decides", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const { runtime, sent } = yield* runtimeWith({ before: without, answer: () => ok(messageWire()) })
      expect((yield* textOf(runtime).send({ content: "hi" })).degraded).toEqual([])
      expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([`POST /channels/${textId}/messages`])
    })
  )

  it.effect("the pins readback cannot tell, and reports nothing degraded", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const { runtime } = yield* runtimeWith({ before: without, answer: () => ok({ items: [] }) })
      expect(yield* textOf(runtime).pins()).toEqual({ messages: [], degraded: [] })
    })
  )
})

describe("the pins readback", () => {
  it.effect("reports an empty list read without ReadMessageHistory as degraded (H-107), and fails with the Transient when its refresh gets no answer", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const unread = yield* runtimeWith({ before: sendable("ViewChannel"), answer: () => ok({ items: [] }) })
      expect(yield* textOf(unread.runtime).pins()).toEqual({ messages: [], degraded: ["ReadMessageHistory"] })
      const offline = new NetworkError({ cause: new NoResponse({ route: "/channels/{channel.id}", method: "GET", reason: "transport", afterMs: 1 }) })
      const missing = snapshotOf({ roles: [role(everyone, set("ViewChannel"), 0)], channels: [], botRoles: [] })
      const failing = yield* runtimeWith({ before: missing, refreshFails: offline, answer: () => ok({ items: [] }) })
      const exit = yield* textOf(failing.runtime).pins().pipe(Effect.provideService(Preflight.Mode, "bypass"), Effect.exit)
      expect(failureOf(exit)).toEqual({ tag: "NetworkError", categories: ["transient"], cause: "NoResponse" })
      expect(failing.sent.map((request) => `${request.method} ${request.path}`)).toEqual([`GET /channels/${textId}/messages/pins?limit=50`])
    })
  )
})

describe("Channels.get", () => {
  it.effect("gives a known channel's handle from the state, and MissingViewChannel for an unseen or obfuscated one, without a request", () =>
    Effect.gen(function* () {
      const base = snapshotOf({ roles: [role(everyone, set(), 0)], channels: [channel("text"), { ...channel("voice"), obfuscated: true }], botRoles: [] })
      const guild = base.guilds.get(guildId)
      if (guild === undefined) throw new Error("no guild")
      const state: Snapshot = { ...base, guilds: new Map([[guildId, { ...guild, unseen: new Set([threadId]) }]]) }
      const { runtime, sent } = yield* runtimeWith({ before: state, answer: () => refused(404, 0) })
      const get = (id: ChannelId) => Channels.get(id).pipe(Effect.provideService(BotRuntime, runtime), Effect.exit)
      const text = yield* get(textId)
      expect(Exit.isSuccess(text) ? text.value.kind : text).toBe("text")
      expect(failureOf(yield* get(threadId))).toMatchObject({ tag: "MissingViewChannel" })
      expect(failureOf(yield* get(channel("voice").id))).toMatchObject({ tag: "MissingViewChannel" })
      expect(sent).toEqual([])
    })
  )

  it.effect("reads a channel the state lacks: UnknownChannel for 10003, MissingViewChannel for 50001", () =>
    Effect.gen(function* () {
      const missing = ChannelId.make("300000000000000077")
      const unknown = yield* runtimeWith({ before: sendable(), answer: () => refused(404, 10003) })
      expect(failureOf(yield* Channels.get(missing).pipe(Effect.provideService(BotRuntime, unknown.runtime), Effect.exit))).toMatchObject({ tag: "UnknownChannel", cause: "DiscordResponse" })
      const hidden = yield* runtimeWith({ before: sendable(), answer: () => refused(403, 50001) })
      expect(failureOf(yield* Channels.get(missing).pipe(Effect.provideService(BotRuntime, hidden.runtime), Effect.exit))).toMatchObject({ tag: "MissingViewChannel", cause: "DiscordResponse" })
      expect(unknown.sent.map((request) => request.path)).toEqual([`/channels/${missing}`])
    })
  )
})

describe("members (§2.6)", () => {
  const ranked = snapshotOf({ roles: [role(everyone, set(), 0), role(roleA, set("KickMembers", "ManageRoles", "ManageNicknames"), 2), role(roleB, set(), 5)], channels: [], botRoles: [roleA] })
  const target = (roles: ReadonlyArray<string>) => Schema.decodeUnknownSync(Schemas.Member)({ user: { id: otherId }, roles })

  it.effect("checks the target's rank, and a role's against the bot's highest, before sending", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const { runtime, sent } = yield* runtimeWith({ before: ranked, answer: (method) => (method === "PATCH" ? ok({ user: { id: otherId }, roles: [] }) : empty) })
      const above = memberHandle(runtime, guildId, target([roleB]))
      expect(failureOf(yield* above.kick().pipe(Effect.exit))).toEqual({ tag: "TargetAboveInHierarchy", categories: ["state"], cause: "PreflightDecision" })
      expect(failureOf(yield* above.setNickname("x").pipe(Effect.exit))).toMatchObject({ tag: "TargetAboveInHierarchy" })
      // role assignment ignores the target's rank (H-061) and checks the role (H-060)
      expect(failureOf(yield* above.addRole(roleB).pipe(Effect.exit))).toMatchObject({ tag: "RoleAboveInHierarchy" })
      expect(sent).toEqual([])
      const below = memberHandle(runtime, guildId, target([]))
      yield* below.setNickname(null)
      expect(sent).toEqual([{ method: "PATCH", path: `/guilds/${guildId}/members/${otherId}`, body: { nick: null } }])
    })
  )

  it.effect("checks a nickname's length locally once preflight passes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const { runtime, sent } = yield* runtimeWith({ before: ranked, answer: () => empty })
      expect(failureOf(yield* memberHandle(runtime, guildId, target([])).setNickname("n".repeat(33)).pipe(Effect.exit))).toEqual({ tag: "NicknameTooLong", categories: ["payload"], cause: "PreflightDecision" })
      expect(sent).toEqual([])
    })
  )
})

describe("threads", () => {
  it.effect("leaving needs no View: a thread the bot cannot see is left (M4 live)", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const base = snapshotOf({ roles: [role(everyone, set(), 0)], channels: [channel("text", [roleOverwrite(guildId, set(), set("ViewChannel"))]), thread("public-thread")], botRoles: [] })
      const { runtime, sent } = yield* runtimeWith({ before: base, answer: () => empty })
      yield* channelHandle(runtime, { guildId, id: threadId, kind: "public-thread" }).leave()
      expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([`DELETE /channels/${threadId}/thread-members/@me`])
      expect(failureOf(yield* channelHandle(runtime, { guildId, id: threadId, kind: "public-thread" }).join().pipe(Effect.exit))).toMatchObject({ tag: "MissingViewChannel" })
    })
  )
})

describe("every operation's request (the M6 verifier)", () => {
  // nothing here may depend on preflight: each operation runs in bypass mode, over a client holding it to its route
  const quiet = { allowed_mentions: { parse: [] } }
  const forumId = ChannelId.make("300000000000000005")
  const tag = ForumTagId.make("700000000000000001")
  const emojiId = EmojiId.make("123456789012345678")
  const messageId = "500000000000000001"
  const recentId = (minutesAgo: number) => MessageId.make(String(BigInt(now - minutesAgo * 60_000 - 1_420_070_400_000) << 22n))
  const until = new Date(now + 60_000)
  const state = snapshotOf({ roles: [role(everyone, set(), 0)], channels: [channel("text"), thread("public-thread")], botRoles: [] })
  const threadWire = { id: "300000000000000077", type: 11, guild_id: guildId, parent_id: textId, thread_metadata: { archived: false, locked: false } }
  const memberWire = { user: { id: otherId }, roles: [] }
  const answerFor = (method: string, path: string): Answer => {
    if (path.endsWith("/threads")) return ok(threadWire)
    if (path.startsWith("/channels/") && path.split("/").length === 3) return ok({ id: path.split("/")[2], type: 0, guild_id: guildId })
    if (path.includes("/messages/pins?")) return ok({ items: [] })
    if (method === "PATCH" && path.startsWith("/guilds/")) return ok(memberWire)
    if (method === "POST" && (path.endsWith("/messages") || path.endsWith("/crosspost"))) return ok(messageWire())
    if (method === "PATCH" && path.includes("/messages/")) return ok(messageWire())
    return empty
  }
  const own = (runtime: Runtime) => {
    const handle = messageHandle(runtime, { guildId, id: textId, kind: "text" }, decodeMessage(messageWire()))
    if (handle.author !== "self") throw new Error("not the bot's message")
    return handle
  }
  const foreign = (runtime: Runtime) => messageHandle(runtime, { guildId, id: textId, kind: "text" }, decodeMessage(messageWire({ author: { id: otherId, bot: true } })))
  const announcementMessage = (runtime: Runtime) => {
    const handle = messageHandle(runtime, { guildId, id: textId, kind: "announcement" }, decodeMessage(messageWire()))
    if (handle.author !== "self") throw new Error("not the bot's message")
    return handle
  }
  const publicThread = (runtime: Runtime) => channelHandle(runtime, { guildId, id: threadId, kind: "public-thread" })
  const member = (runtime: Runtime) => memberHandle(runtime, guildId, Schema.decodeUnknownSync(Schemas.Member)(memberWire))
  const messagePath = `/channels/${textId}/messages/${messageId}`
  const memberPath = `/guilds/${guildId}/members/${otherId}`

  const cases: ReadonlyArray<readonly [name: string, run: (runtime: Runtime) => Effect.Effect<unknown, { readonly _tag: string }>, expected: Sent]> = [
    ["channel.send", (runtime) => textOf(runtime).send({ content: "hi" }), { method: "POST", path: `/channels/${textId}/messages`, body: { ...quiet, content: "hi" } }],
    [
      "channel.send with a file",
      (runtime) => textOf(runtime).send({ content: "hi", files: [{ name: "lab.txt", data: new TextEncoder().encode("lab\n"), contentType: "text/plain" }] }),
      { method: "POST", path: `/channels/${textId}/messages`, body: [{ name: "files[0]", file: { name: "lab.txt", type: "text/plain", size: 4 } }, { name: "payload_json", value: { ...quiet, content: "hi" } }] }
    ],
    ["message.edit", (runtime) => own(runtime).edit({ content: "edited" }), { method: "PATCH", path: messagePath, body: { ...quiet, content: "edited" } }],
    ["message.delete (own)", (runtime) => own(runtime).delete(), { method: "DELETE", path: messagePath, body: null }],
    ["message.delete (foreign)", (runtime) => foreign(runtime).delete(), { method: "DELETE", path: messagePath, body: null }],
    ["message.crosspost", (runtime) => announcementMessage(runtime).crosspost(), { method: "POST", path: `${messagePath}/crosspost`, body: null }],
    ["message.react (unicode)", (runtime) => foreign(runtime).react({ origin: "unicode", name: "👍" }), { method: "PUT", path: `${messagePath}/reactions/${encodeURIComponent("👍")}/@me`, body: null }],
    ["message.react (guild emoji)", (runtime) => foreign(runtime).react({ origin: "guild", id: emojiId, name: "lab_emoji" }), { method: "PUT", path: `${messagePath}/reactions/lab_emoji:${emojiId}/@me`, body: null }],
    ["message.pin", (runtime) => own(runtime).pin(), { method: "PUT", path: `/channels/${textId}/messages/pins/${messageId}`, body: null }],
    ["message.unpin", (runtime) => own(runtime).unpin(), { method: "DELETE", path: `/channels/${textId}/messages/pins/${messageId}`, body: null }],
    ["message.createThread", (runtime) => own(runtime).createThread({ name: "lab-thread" }), { method: "POST", path: `${messagePath}/threads`, body: { name: "lab-thread" } }],
    ["channel.pins", (runtime) => textOf(runtime).pins(), { method: "GET", path: `/channels/${textId}/messages/pins?limit=50`, body: null }],
    [
      "channel.bulkDelete",
      (runtime) => textOf(runtime).bulkDelete([recentId(2), recentId(1)]),
      { method: "POST", path: `/channels/${textId}/messages/bulk-delete`, body: { messages: [recentId(2), recentId(1)] } }
    ],
    ["channel.createThread (public)", (runtime) => textOf(runtime).createThread({ name: "lab-thread" }), { method: "POST", path: `/channels/${textId}/threads`, body: { name: "lab-thread", type: 11 } }],
    ["channel.createThread (private)", (runtime) => textOf(runtime).createThread({ name: "lab-thread", private: true }), { method: "POST", path: `/channels/${textId}/threads`, body: { name: "lab-thread", type: 12 } }],
    [
      "channel.createThread (announcement)",
      (runtime) => channelHandle(runtime, { guildId, id: textId, kind: "announcement" }).createThread({ name: "lab-thread" }),
      { method: "POST", path: `/channels/${textId}/threads`, body: { name: "lab-thread", type: 10 } }
    ],
    [
      "forum.createPost",
      (runtime) => channelHandle(runtime, { guildId, id: forumId, kind: "forum" }).createPost({ name: "lab-post", message: { content: "hi" }, tags: [tag] }),
      { method: "POST", path: `/channels/${forumId}/threads`, body: { name: "lab-post", applied_tags: [tag], message: { ...quiet, content: "hi" } } }
    ],
    [
      "forum.createPost (untagged)",
      (runtime) => channelHandle(runtime, { guildId, id: forumId, kind: "forum" }).createPost({ name: "lab-post", message: { content: "hi" } }),
      { method: "POST", path: `/channels/${forumId}/threads`, body: { name: "lab-post", message: { ...quiet, content: "hi" } } }
    ],
    ["thread.join", (runtime) => publicThread(runtime).join(), { method: "PUT", path: `/channels/${threadId}/thread-members/@me`, body: null }],
    ["thread.leave", (runtime) => publicThread(runtime).leave(), { method: "DELETE", path: `/channels/${threadId}/thread-members/@me`, body: null }],
    ["thread.addMember", (runtime) => publicThread(runtime).addMember(UserId.make(otherId)), { method: "PUT", path: `/channels/${threadId}/thread-members/${otherId}`, body: null }],
    ["thread.setArchived(true)", (runtime) => publicThread(runtime).setArchived(true), { method: "PATCH", path: `/channels/${threadId}`, body: { archived: true } }],
    ["thread.setArchived(false)", (runtime) => publicThread(runtime).setArchived(false), { method: "PATCH", path: `/channels/${threadId}`, body: { archived: false } }],
    ["thread.setLocked(true)", (runtime) => publicThread(runtime).setLocked(true), { method: "PATCH", path: `/channels/${threadId}`, body: { locked: true } }],
    ["thread.setLocked(false)", (runtime) => publicThread(runtime).setLocked(false), { method: "PATCH", path: `/channels/${threadId}`, body: { locked: false } }],
    ["thread.delete", (runtime) => publicThread(runtime).delete(), { method: "DELETE", path: `/channels/${threadId}`, body: null }],
    [
      "channel.edit",
      (runtime) => textOf(runtime).edit({ name: "lab-renamed", topic: "lab topic", slowmodeSeconds: 5 }),
      { method: "PATCH", path: `/channels/${textId}`, body: { name: "lab-renamed", topic: "lab topic", rate_limit_per_user: 5 } }
    ],
    ["member.addRole", (runtime) => member(runtime).addRole(roleA), { method: "PUT", path: `${memberPath}/roles/${roleA}`, body: null }],
    ["member.removeRole", (runtime) => member(runtime).removeRole(roleA), { method: "DELETE", path: `${memberPath}/roles/${roleA}`, body: null }],
    ["member.setNickname", (runtime) => member(runtime).setNickname("lab-nick"), { method: "PATCH", path: memberPath, body: { nick: "lab-nick" } }],
    ["member.timeout", (runtime) => member(runtime).timeout(until), { method: "PATCH", path: memberPath, body: { communication_disabled_until: until.toISOString() } }],
    ["member.timeout(null)", (runtime) => member(runtime).timeout(null), { method: "PATCH", path: memberPath, body: { communication_disabled_until: null } }],
    ["member.kick", (runtime) => member(runtime).kick(), { method: "DELETE", path: memberPath, body: null }],
    ["member.ban", (runtime) => member(runtime).ban(), { method: "PUT", path: `/guilds/${guildId}/bans/${otherId}`, body: { delete_message_seconds: 0 } }],
    ["member.ban (deleteMessageSeconds)", (runtime) => member(runtime).ban({ deleteMessageSeconds: 60 }), { method: "PUT", path: `/guilds/${guildId}/bans/${otherId}`, body: { delete_message_seconds: 60 } }]
  ]

  for (const [name, run, expected] of cases) {
    it.effect(`${name}: ${expected.method} ${expected.path}`, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now)
        const { runtime, sent } = yield* runtimeWith({ before: state, answer: answerFor })
        const exit = yield* run(runtime).pipe(Effect.provideService(Preflight.Mode, "bypass"), Effect.exit)
        expect(Exit.isSuccess(exit) ? "succeeded" : Cause.pretty(exit.cause)).toBe("succeeded")
        expect(sent).toEqual([expected])
      })
    )
  }
})
