import * as fs from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { DiscordREST } from "dfx/DiscordREST"
import { Cause, Effect, Exit, Logger, Option, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as Materialize from "../../harness/Materialize.ts"
import * as Predict from "../../harness/Predict.ts"
import { scenarios } from "../../harness/scenario/catalog/index.ts"
import { staticFactsOf } from "../../harness/scenario/Facts.ts"
import * as TruthTable from "../../harness/TruthTable.ts"
import { DiscordResponse, NoResponse } from "../../src/errors/Cause.ts"
import { NetworkError } from "../../src/errors/Transient.ts"
import type { PermissionFlag } from "../../src/errors/Missing.generated.ts"
import { decide } from "../../src/permissions/Preflight.ts"
import * as Recompute from "../../src/permissions/Recompute.ts"
import { inputFromSnapshot, resolve } from "../../src/permissions/Resolver.ts"
import * as Coded429 from "../../src/rest/Coded429.ts"
import * as DiscordApi from "../../src/rest/DiscordApi.ts"
import { type LimitFacts, UnmappedDiscordError } from "../../src/rest/ErrorMap.ts"
import type { Snapshot } from "../../src/state/Snapshot.ts"
import { EmojiId, MessageId } from "../../src/Snowflake.ts"
import { categoriesOf } from "../support/categories.ts"
import { json, type Scripted, scriptedRest } from "../support/fakeDiscord.ts"
import { channel, everyone, guildId, later, now, otherId, role, roleA, roleB, roleOverwrite, set, textId, thread, threadId } from "../support/guild.ts"
import { snapshotOf, stubGuildState } from "../support/guildStateStub.ts"

/**
 * The recompute (DESIGN §4.9, §3.2), through the real `DiscordApi` and dfx client over a scripted fake, with a
 * guild state whose refresh answers what the test says Discord's state is:
 *
 * - 50013 and 50001 are attributed from the refreshed state, never from the stale one, and fall back to
 *   `PermissionDeniedUnattributed` when the fresh state shows nothing wrong;
 * - the dedicated codes 160002, 160005 and 50083 go through the recompute too, and our order decides the tag;
 *   with nothing found, the code's own tag is returned;
 * - a flag `Permissions.require` checked is `PermissionRevokedSinceCheck` (D8);
 * - member operations refresh at guild level and read the target again; a reaction of unknown state reads the
 *   message;
 * - every refusal the M4 truth table recorded, replayed through the same path over the rebuilt state, gives
 *   exactly the error preflight recorded for the row (what the matrix's step (d) checks live, M6).
 */
const refusal = (status: number, code: number, message = "Refused"): Scripted => json(status, { message, code })
const all = set("ViewChannel", "SendMessages", "SendMessagesInThreads", "EmbedLinks", "ReadMessageHistory", "AddReactions", "ManageNicknames", "ManageRoles")
const everyoneWith = (permissions: ReturnType<typeof set>) => role(everyone, permissions, 0)
const textWith = (...denied: ReadonlyArray<PermissionFlag>) => channel("text", denied.length === 0 ? [] : [roleOverwrite(guildId, set(), set(...denied))])
const snapshotWithText = (...denied: ReadonlyArray<PermissionFlag>): Snapshot => snapshotOf({ roles: [everyoneWith(all)], channels: [textWith(...denied)], botRoles: [] })

const target = (op: Recompute.Target["op"], options: Partial<Recompute.Target> = {}): Recompute.Target => ({
  op,
  guildId,
  scope: { _tag: "Channel", channelId: textId },
  granted: [],
  args: { payload: [] },
  completion: { _tag: "Static" },
  ...options
})

interface Run {
  readonly answer: (method: string, path: string) => Scripted
  readonly before: Snapshot
  readonly after: Snapshot
  readonly target: Recompute.Target
  readonly limits?: LimitFacts
  readonly refreshFails?: NetworkError
}

/** Runs one request through `DiscordApi.execute` (the operation's call answered by the script); its exit and the refreshes. */
const run = (options: Run) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now)
    const stub = yield* stubGuildState(options.before, options.after, options.refreshFails)
    const exit = yield* Effect.gen(function* () {
      const rest = yield* DiscordREST
      const api = yield* DiscordApi.make(rest, stub.state)
      return yield* api.execute({
        target: options.target,
        route: { method: "POST", template: "/channels/{channel.id}/messages" },
        call: (client) => client.createMessage(textId, { content: "x" }),
        response: Schema.Void,
        limits: options.limits ?? {}
      })
    }).pipe(Effect.provide(scriptedRest(options.answer, Coded429.surface)), Effect.exit)
    return { exit, refreshes: yield* stub.refreshes }
  })

/** The typed failure of an exit, as `{tag, categories, attributedBy}`. */
const failureOf = <A>(exit: Exit.Exit<A, DiscordApi.ApiError>) => {
  if (Exit.isSuccess(exit)) return "succeeded"
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isNone(error)) return `no typed failure: ${Cause.pretty(exit.cause)}`
  const cause = error.value.cause
  return { tag: error.value._tag, categories: [...categoriesOf(error.value)], attributedBy: cause._tag === "DiscordResponse" ? cause.attributedBy : cause._tag }
}

const onPost = (answer: Scripted, others: (method: string, path: string) => Scripted = () => refusal(404, 0, "404: Not Found")) => (method: string, path: string): Scripted =>
  method === "POST" ? answer : others(method, path)

describe("the recompute after 50013 and 50001", () => {
  it.effect("attributes the refusal from the refreshed state, not the stale one", () =>
    Effect.gen(function* () {
      const before = snapshotWithText()
      const stale = inputFromSnapshot(before, guildId, textId, now)
      if (stale._tag !== "Ready") throw new Error("the stale state resolves")
      expect(decide("channel.send", resolve(stale.input), { payload: ["embeds"] }).failures).toEqual([])
      const { exit, refreshes } = yield* run({ answer: onPost(refusal(403, 50013)), before, after: snapshotWithText("EmbedLinks"), target: target("channel.send", { args: { payload: ["embeds"] } }) })
      expect(failureOf(exit)).toEqual({ tag: "MissingEmbedLinks", categories: ["payload", "permission"], attributedBy: "recompute" })
      expect(refreshes).toEqual([`refresh ${textId}`])
    })
  )

  it.effect("falls back to PermissionDeniedUnattributed, carrying Discord's answer, when the fresh state shows nothing", () =>
    Effect.gen(function* () {
      const { exit } = yield* run({ answer: onPost(refusal(403, 50013, "Missing Permissions")), before: snapshotWithText(), after: snapshotWithText(), target: target("channel.send") })
      expect(failureOf(exit)).toEqual({ tag: "PermissionDeniedUnattributed", categories: ["permission"], attributedBy: "code" })
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
      expect(Option.map(error, (value) => value.cause)).toEqual(
        Option.some(new DiscordResponse({ status: 403, code: 50013, message: "Missing Permissions", method: "POST", route: "/channels/{channel.id}/messages", fieldErrors: [], attributedBy: "code" }))
      )
    })
  )

  it.effect("logs the flags the bot lacks outside the request's requirements when it attributes nothing (§4.9)", () =>
    Effect.gen(function* () {
      const logged: Array<string> = []
      const collector = Logger.make((options) => {
        logged.push(`${options.logLevel}: ${[options.message].flat().join(" ")}`)
      })
      const { exit } = yield* run({ answer: onPost(refusal(403, 50013)), before: snapshotWithText(), after: snapshotWithText(), target: target("channel.send") }).pipe(
        Effect.provide(Logger.layer([collector]))
      )
      expect(failureOf(exit)).toMatchObject({ tag: "PermissionDeniedUnattributed" })
      const warning = logged.find((line) => line.includes("not attributed"))
      expect(warning).toContain("Warn")
      expect(warning).toContain("holds every flag the request needs (ViewChannel, SendMessages)")
      // the bot lacks ManageChannels (among others): a flag outside the requirements is named, never attributed
      expect(warning).toContain("ManageChannels")
      expect(warning).not.toMatch(/outside them: [^\n]*\bSendMessages\b/)
    })
  )

  it.effect("puts the most fundamental failure first (§3.2): View before Send", () =>
    Effect.gen(function* () {
      const { exit } = yield* run({ answer: onPost(refusal(403, 50001)), before: snapshotWithText(), after: snapshotWithText("SendMessages", "ViewChannel"), target: target("channel.send") })
      expect(failureOf(exit)).toEqual({ tag: "MissingViewChannel", categories: ["access", "permission"], attributedBy: "recompute" })
    })
  )

  it.effect("reports a flag Permissions.require checked as PermissionRevokedSinceCheck (D8)", () =>
    Effect.gen(function* () {
      const { exit } = yield* run({ answer: onPost(refusal(403, 50013)), before: snapshotWithText(), after: snapshotWithText("SendMessages"), target: target("channel.send", { granted: ["SendMessages"] }) })
      expect(failureOf(exit)).toEqual({ tag: "PermissionRevokedSinceCheck", categories: ["permission"], attributedBy: "recompute" })
    })
  )

  it.effect("finds a timeout the state had not seen", () =>
    Effect.gen(function* () {
      const after = snapshotOf({ roles: [everyoneWith(all)], channels: [textWith()], botRoles: [], timedOutUntil: later })
      const { exit } = yield* run({ answer: onPost(refusal(403, 50013)), before: snapshotWithText(), after, target: target("channel.send") })
      expect(failureOf(exit)).toEqual({ tag: "CommunicationDisabled", categories: ["state"], attributedBy: "recompute" })
    })
  )

  it.effect("attributes nothing when the refreshed state still lacks the guild (deleted meanwhile)", () =>
    Effect.gen(function* () {
      const empty: Snapshot = { botUserId: undefined, guilds: new Map() }
      const { exit, refreshes } = yield* run({ answer: onPost(refusal(403, 50013)), before: snapshotWithText(), after: empty, target: target("channel.send") })
      expect(failureOf(exit)).toEqual({ tag: "PermissionDeniedUnattributed", categories: ["permission"], attributedBy: "code" })
      expect(refreshes).toEqual([`refresh ${textId}`])
    })
  )

  it.effect("fails with the refresh's transient error when the refresh gets no answer", () =>
    Effect.gen(function* () {
      const offline = new NetworkError({ cause: new NoResponse({ route: "/channels/{channel.id}", method: "GET", reason: "transport", afterMs: 1 }) })
      const { exit } = yield* run({ answer: onPost(refusal(403, 50013)), before: snapshotWithText(), after: snapshotWithText(), target: target("channel.send"), refreshFails: offline })
      expect(failureOf(exit)).toEqual({ tag: "NetworkError", categories: ["transient"], attributedBy: "NoResponse" })
    })
  )
})

describe("the dedicated codes go through the recompute, and our order decides (§3.2)", () => {
  const threadState = (locked: boolean, ...denied: ReadonlyArray<PermissionFlag>) =>
    snapshotOf({
      roles: [everyoneWith(all)],
      channels: [textWith(...denied), thread("public-thread", { locked, ownerId: otherId })],
      botRoles: [],
      threadMembership: [[threadId, true]]
    })
  const inThread = (op: Recompute.Target["op"], options: Partial<Recompute.Target> = {}) => target(op, { scope: { _tag: "Channel", channelId: threadId }, ...options })

  it.effect("160005 on a locked thread where SendMessagesInThreads is also missing is MissingSendMessagesInThreads", () =>
    Effect.gen(function* () {
      const { exit, refreshes } = yield* run({ answer: onPost(refusal(403, 160005, "Thread is locked")), before: threadState(true), after: threadState(true, "SendMessagesInThreads"), target: inThread("thread.send") })
      expect(failureOf(exit)).toEqual({ tag: "MissingSendMessagesInThreads", categories: ["access", "permission"], attributedBy: "recompute" })
      expect(refreshes).toEqual([`refresh ${threadId}`])
    })
  )

  it.effect("160005 is ThreadLocked when the fresh state shows the lock alone, and the code's own tag when it shows nothing", () =>
    Effect.gen(function* () {
      const locked = yield* run({ answer: onPost(refusal(403, 160005)), before: threadState(false), after: threadState(true), target: inThread("thread.send") })
      expect(failureOf(locked.exit)).toEqual({ tag: "ThreadLocked", categories: ["state"], attributedBy: "recompute" })
      const stale = yield* run({ answer: onPost(refusal(403, 160005)), before: threadState(false), after: threadState(false), target: inThread("thread.send") })
      expect(failureOf(stale.exit)).toEqual({ tag: "ThreadLocked", categories: ["state"], attributedBy: "code" })
    })
  )

  it.effect("160002 with nothing found is the reply variant of MissingReadMessageHistory (payload, D5)", () =>
    Effect.gen(function* () {
      const { exit } = yield* run({ answer: onPost(refusal(403, 160002)), before: snapshotWithText(), after: snapshotWithText(), target: target("channel.send", { args: { payload: ["reply"] } }) })
      expect(failureOf(exit)).toEqual({ tag: "MissingReadMessageHistory", categories: ["payload", "permission"], attributedBy: "code" })
    })
  )

  it.effect("160002 with Send also missing is MissingSendMessages", () =>
    Effect.gen(function* () {
      const { exit } = yield* run({ answer: onPost(refusal(403, 160002)), before: snapshotWithText(), after: snapshotWithText("SendMessages", "ReadMessageHistory"), target: target("channel.send", { args: { payload: ["reply"] } }) })
      expect(failureOf(exit)).toEqual({ tag: "MissingSendMessages", categories: ["access", "permission"], attributedBy: "recompute" })
    })
  )

  it.effect("160002 on a send that carries no reply is unmapped: a defect", () =>
    Effect.gen(function* () {
      const { exit, refreshes } = yield* run({ answer: onPost(refusal(403, 160002)), before: snapshotWithText(), after: snapshotWithText(), target: target("channel.send") })
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(UnmappedDiscordError)
      expect(refreshes).toEqual([])
    })
  )

  it.effect("50083 on a reaction in an archived thread is MissingAddReactions when the emoji is new and AddReactions is missing too", () =>
    Effect.gen(function* () {
      const archived = (...denied: ReadonlyArray<PermissionFlag>) =>
        snapshotOf({ roles: [everyoneWith(all)], channels: [textWith(...denied), thread("public-thread", { archived: true })], botRoles: [], threadMembership: [[threadId, true]] })
      const react = inThread("message.react.thread", { args: { payload: [], reaction: "new" } })
      const both = yield* run({ answer: onPost(refusal(400, 50083, "Thread is archived")), before: archived(), after: archived("AddReactions"), target: react })
      expect(failureOf(both.exit)).toEqual({ tag: "MissingAddReactions", categories: ["permission"], attributedBy: "recompute" })
      const alone = yield* run({ answer: onPost(refusal(400, 50083)), before: archived(), after: archived(), target: react })
      expect(failureOf(alone.exit)).toEqual({ tag: "ThreadArchived", categories: ["state"], attributedBy: "recompute" })
    })
  )
})

describe("what the recompute reads beyond the refresh", () => {
  const member = (roles: ReadonlyArray<string>) => ({ user: { id: otherId }, roles, communication_disabled_until: null })
  const ranked = snapshotOf({ roles: [everyoneWith(set()), role(roleA, set("ManageNicknames", "ManageRoles"), 2), role(roleB, set(), 3)], channels: [], botRoles: [roleA] })

  it.effect("a member operation refreshes at guild level and reads the target again: TargetAboveInHierarchy", () =>
    Effect.gen(function* () {
      const reads: Array<string> = []
      const { exit, refreshes } = yield* run({
        answer: onPost(refusal(403, 50013), (method, path) => {
          reads.push(`${method} ${path}`)
          return json(200, member([roleB]))
        }),
        before: ranked,
        after: ranked,
        target: target("member.setNickname", { scope: { _tag: "Guild" }, completion: { _tag: "Member", targetUserId: otherId, role: undefined } })
      })
      expect(failureOf(exit)).toEqual({ tag: "TargetAboveInHierarchy", categories: ["state"], attributedBy: "recompute" })
      expect(refreshes).toEqual(["refreshGuild"])
      expect(reads).toEqual([`GET /guilds/${guildId}/members/${otherId}`])
    })
  )

  it.effect("a role operation checks the role against the bot's highest: RoleAboveInHierarchy", () =>
    Effect.gen(function* () {
      const { exit } = yield* run({
        answer: onPost(refusal(403, 50013), () => json(200, member([]))),
        before: ranked,
        after: ranked,
        target: target("member.addRole", { scope: { _tag: "Guild" }, completion: { _tag: "Member", targetUserId: otherId, role: roleB } })
      })
      expect(failureOf(exit)).toEqual({ tag: "RoleAboveInHierarchy", categories: ["state"], attributedBy: "recompute" })
    })
  )

  it.effect("a target that has left (10007) adds no hierarchy, so nothing is attributed", () =>
    Effect.gen(function* () {
      const { exit } = yield* run({
        answer: onPost(refusal(403, 50013), () => refusal(404, 10007, "Unknown Member")),
        before: ranked,
        after: ranked,
        target: target("member.setNickname", { scope: { _tag: "Guild" }, completion: { _tag: "Member", targetUserId: otherId, role: undefined } })
      })
      expect(failureOf(exit)).toEqual({ tag: "PermissionDeniedUnattributed", categories: ["permission"], attributedBy: "code" })
    })
  )

  it.effect("a reaction whose emoji state was unknown reads the message: a new emoji needs AddReactions, an existing one does not", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("500000000000000001")
      const emojiId = EmojiId.make("700000000000000001")
      const message = (reactions: ReadonlyArray<unknown>) =>
        json(200, { id: messageId, channel_id: textId, type: 0, author: { id: otherId, bot: true }, content: "", tts: false, mention_everyone: false, mention_roles: [], embeds: [], attachments: [], pinned: false, reactions })
      const react = target("message.react.channel", {
        args: { payload: [], reaction: "unknown" },
        completion: { _tag: "Reaction", channelId: textId, messageId, emoji: { _tag: "Custom", id: emojiId } }
      })
      const after = snapshotWithText("AddReactions")
      const fresh = yield* run({ answer: onPost(refusal(403, 50013), () => message([{ count: 1, me: false, emoji: { id: "700000000000000002", name: "other" } }])), before: snapshotWithText(), after, target: react })
      expect(failureOf(fresh.exit)).toEqual({ tag: "MissingAddReactions", categories: ["permission"], attributedBy: "recompute" })
      const existing = yield* run({ answer: onPost(refusal(403, 50013), () => message([{ count: 2, me: false, emoji: { id: emojiId, name: "lab_emoji" } }])), before: snapshotWithText(), after, target: react })
      expect(failureOf(existing.exit)).toEqual({ tag: "PermissionDeniedUnattributed", categories: ["permission"], attributedBy: "code" })
    })
  )
})

// ---- the truth table's refusals, replayed ----------------------------------------------------------------

const tablePath = new URL("../../fixtures/truth-table.json", import.meta.url).pathname
const table = Schema.decodeUnknownSync(Schema.fromJsonString(TruthTable.TruthTable))(fs.readFileSync(tablePath, "utf8"))
const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
const ids = Predict.symbolicIds
const refused = Object.entries(table.scenarios).filter(([, row]) => row.raw.class === "50013" || row.raw.class === "50001" || row.raw.class === "other-error")

describe("every refusal the truth table recorded, through DiscordApi and the recompute", () => {
  it("covers every refusal class the matrix saw", () => {
    expect(new Set(refused.map(([, row]) => row.raw.code))).toEqual(new Set([50013, 50001, 50083, 160002, 160005, 40067]))
  })

  it.effect.each(refused)("%s: gives the error preflight recorded", ([id, row]) =>
    Effect.gen(function* () {
      const scenario = byId.get(id)
      if (scenario === undefined) throw new Error(`${id} is not in the catalog`)
      if (typeof row.preflight !== "object") throw new Error(`${id}: a refused row whose preflight passed`)
      const state = Materialize.desired(scenario.setup, ids)
      const snapshot = Predict.snapshotOf(state, ids, now)
      const facts = staticFactsOf(scenario)
      const channelId = ids.channels.get(state.channel)
      if (channelId === undefined) throw new Error(`${id}: no channel ID`)
      const assigned = Materialize.assignedRoleOf(scenario.setup)
      const targetMember = Materialize.memberOf(state, ids, "target", later)
      const request = target(facts.op, {
        guildId: ids.guildId,
        scope: facts.scope === "guild" ? { _tag: "Guild" } : { _tag: "Channel", channelId },
        args: facts.args,
        completion: facts.onTarget ? { _tag: "Member", targetUserId: ids.targetUserId, role: assigned === undefined ? undefined : ids.roles.get(assigned) } : { _tag: "Static" }
      })
      const { exit, refreshes } = yield* run({
        answer: onPost(refusal(row.raw.status, row.raw.code), (method, path) =>
          method === "GET" && path === `/guilds/${ids.guildId}/members/${ids.targetUserId}`
            ? json(200, { user: { id: targetMember.userId }, roles: targetMember.roleIds, communication_disabled_until: targetMember.timedOutUntil })
            : refusal(404, 0, "404: Not Found")
        ),
        // the subject's state before the request is irrelevant: the recompute reads the refreshed one
        before: snapshotOf({ roles: [], channels: [], botRoles: [] }),
        after: snapshot,
        target: request
      })
      const failure = failureOf(exit)
      expect(typeof failure === "object" ? { tag: failure.tag, categories: failure.categories } : failure).toEqual({ tag: row.preflight.tag, categories: [...row.preflight.categories] })
      const recomputed = row.raw.code !== 40067
      expect(refreshes).toEqual(recomputed ? [facts.scope === "guild" ? "refreshGuild" : `refresh ${channelId}`] : [])
      if (typeof failure === "object") expect(failure.attributedBy).toBe(recomputed ? "recompute" : "code")
    })
  )
})
