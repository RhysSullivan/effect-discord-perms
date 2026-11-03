import { describe, expect, it } from "@effect/vitest"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Option, Schema } from "effect"
import * as Drivers from "../../harness/Drivers.ts"
import { DryRun, loadCanned, makeRecorder, requestDifferences } from "../../harness/DryRun.ts"
import * as Fixtures from "../../harness/Fixtures.ts"
import { compose } from "../../harness/Identities.ts"
import { LabGuard } from "../../harness/Lab.ts"
import * as LabIds from "../../harness/LabIds.ts"
import * as Library from "../../harness/Library.ts"
import * as Materialize from "../../harness/Materialize.ts"
import * as Predict from "../../harness/Predict.ts"
import { scenarios } from "../../harness/scenario/catalog/index.ts"
import { operationKey, type Scenario } from "../../harness/scenario/Dsl.ts"
import { BotRuntime } from "../../src/bot/Bot.ts"
import * as Schemas from "../../src/rest/Schemas.ts"
import { type ChannelId, EmojiId, ForumTagId, MessageId, StickerId, UserId } from "../../src/Snowflake.ts"
import { type Answer, fakeCredentials, fakeGuildId, makeRecordingClient, subjectStartupAnswer } from "../support/fakeDiscord.ts"
import { makeFakeGateway } from "../support/fakeGateway.ts"

/**
 * The request check (DESIGN §5.10, the M6 verifier) offline, over the whole catalog: for one scenario of every
 * (operation, lab channel) the catalog has, the library's operation with preflight bypassed (what step (d) sends)
 * and the raw call of step (c), both over the dry-run stub of the harness's real wiring (`Identities.compose`, the
 * subject's real bot build and its declared-route check), record one request each, and the two are the same
 * request: the method, the path with its IDs and query, and the body. Nothing is sent.
 */
const ids: Materialize.Ids = { ...Predict.symbolicIds, guildId: fakeGuildId }
const harnessUserId = UserId.make("200000000000000000")

/** A message snowflake from `minutesAgo` minutes ago: the fixtures' messages are fresh, as the bulk delete's age check needs. */
const recentId = (minutesAgo: number): string => String(BigInt(Date.now() - minutesAgo * 60_000 - 1_420_070_400_000) << 22n)

/** The lab as the subject's GUILD_CREATE describes it, so the guild state resolves every lab channel and thread. */
const guildCreate = () => {
  const idOf = (name: Materialize.LabName): ChannelId => {
    const id = ids.channels.get(name)
    if (id === undefined) throw new Error(`no ID for ${name}`)
    return id
  }
  const lab = idOf("lab")
  const channels = LabIds.channelSpecs.filter((spec) => ids.channels.has(spec.name)).map((spec) => ({ id: idOf(spec.name), type: spec.type, parent_id: spec.type === 4 ? null : lab, permission_overwrites: [] }))
  const threads = [...LabIds.threadSpecs, ...LabIds.scenarioThreadSpecs].map((spec) => ({ id: idOf(spec.name), type: spec.type, parent_id: idOf(spec.parent), thread_metadata: { archived: false, locked: false } }))
  return {
    id: fakeGuildId,
    name: "Perms Lab",
    owner_id: ids.ownerId,
    roles: [{ id: fakeGuildId, name: "@everyone", permissions: "0", position: 0, managed: false, mentionable: false }],
    channels,
    threads,
    members: [{ user: { id: ids.subjectUserId }, roles: [], communication_disabled_until: null }]
  }
}

/** The first scenario of each (operation, lab channel) the catalog has, outside the rule rows and the unavailable lab-media. */
const representatives: ReadonlyArray<Scenario> = (() => {
  const seen = new Set<string>()
  return scenarios.filter((scenario) => {
    if (scenario.operation._tag === "rule") return false
    const name = Materialize.labNameOf(scenario.setup)
    if (ids.unavailable.has(name) || ids.unavailable.has(Materialize.overwriteChannelOf(name))) return false
    const key = `${operationKey(scenario.operation)} @ ${name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})()

const message = (id: string, channelId: ChannelId, author: string, reactions: ReadonlyArray<unknown> = []) =>
  Schema.decodeUnknownSync(Schemas.Message)({
    id,
    channel_id: channelId,
    type: 0,
    author: { id: author, bot: true },
    content: "lab",
    tts: false,
    mention_everyone: false,
    mention_roles: [],
    embeds: [],
    attachments: [],
    pinned: false,
    reactions
  })

describe("the request check over the catalog", () => {
  it("covers every operation of the catalog", () => {
    expect(new Set(representatives.map((scenario) => scenario.operation._tag))).toEqual(new Set(["send", "createPost", "message", "react", "pins", "createThread", "thread", "channelEdit", "member"]))
    expect(representatives.length).toBeGreaterThan(100)
  })

  it.live("the library sends exactly the raw call's request, for one scenario of each operation and lab channel", () =>
    Effect.gen(function* () {
      const client = yield* makeRecordingClient((request): Answer => subjectStartupAnswer(request) ?? { status: 404, body: { message: "not in the fake", code: 0 } })
      const gateway = yield* makeFakeGateway({ userFor: (token) => (token === "fake-subject-token" ? ids.subjectUserId : undefined), guildsFor: () => [guildCreate()] }, () => 0)
      const canned = yield* loadCanned.pipe(Effect.provide(BunFileSystem.layer))
      const checked = yield* Effect.gen(function* () {
        const guard = yield* LabGuard
        const runtime = yield* BotRuntime
        yield* guard.arm({ harnessUserId, subjectUserId: ids.subjectUserId, targetUserId: ids.targetUserId, protectedChannels: new Set() })
        for (const [name, id] of ids.channels) yield* guard.admitChannel({ id, name })
        for (const [name, id] of ids.roles) yield* guard.admitRole({ id, name, botId: undefined })
        const problems: Array<string> = []
        const counts: Array<readonly [string, number, number]> = []
        for (const scenario of representatives) {
          const state = Materialize.desired(scenario.setup, ids)
          const channelId = ids.channels.get(state.channel)
          if (channelId === undefined) return yield* Effect.die(new Error(`no ID for ${state.channel}`))
          const assigned = Materialize.assignedRoleOf(scenario.setup)
          const roleId = assigned === undefined ? undefined : ids.roles.get(assigned)
          const subjectMessage = message(recentId(3), channelId, ids.subjectUserId)
          const harnessMessage = message(recentId(2), channelId, harnessUserId, [{ count: 1, me: false, emoji: { id: null, name: Fixtures.emoji.existing } }])
          const secondHarnessMessage = MessageId.make(recentId(1))
          const stickerId = StickerId.make("800000000000000001")
          const emojiId = EmojiId.make("900000000000000001")
          const forumTag = "700000000000000001"
          const now = Date.parse("2026-11-03T12:00:00Z")
          const prior = yield* Fixtures.subjectPriorSend(scenario.setup, channelId).pipe(Effect.provideService(DryRun, Option.some(yield* makeRecorder(canned))), Effect.orDie)
          if (prior._tag === "Refused") return yield* Effect.die(new Error("the dry prior send was refused"))
          const library: Library.LibraryContext = {
            runtime,
            ids,
            state,
            channelId,
            subjectMessage,
            harnessMessage,
            secondHarnessMessage,
            stickerId,
            emojiId,
            forumTag: ForumTagId.make(forumTag),
            roleId,
            target: Schema.decodeUnknownSync(Schemas.Member)({ user: { id: ids.targetUserId }, roles: [] }),
            now
          }
          const call: Drivers.CallContext = {
            ids,
            state,
            channelId,
            subjectMessage: subjectMessage.id,
            harnessMessage: harnessMessage.id,
            secondHarnessMessage,
            stickerId,
            emojiId,
            forumTag,
            roleId,
            now,
            priorSend: prior
          }
          const bypassed = yield* Library.bypassedRequests(scenario.operation, library, yield* makeRecorder(canned))
          const expected = yield* Drivers.dryRequests(scenario, call, yield* makeRecorder(canned)).pipe(Effect.orDie)
          problems.push(...requestDifferences(scenario.id, bypassed, expected))
          counts.push([scenario.id, bypassed.length, expected.length])
        }
        return { problems, counts, sent: yield* client.recorded }
      }).pipe(Effect.provide(compose(client.layer, gateway.layer, fakeCredentials, { requestsPerSecond: 5, invalidCap: 1500 })))
      expect(checked.problems).toEqual([])
      expect(checked.counts.filter(([, library, raw]) => library !== 1 || raw !== 1)).toEqual([])
      // nothing but the subject's startup reached the base client
      expect(checked.sent.map((request) => new URL(request.url).pathname.replace(/^\/api\/v\d+/, "")).sort()).toEqual(["/applications/@me", "/gateway/bot", `/guilds/${fakeGuildId}/members/${ids.subjectUserId}`, "/users/@me"].sort())
    })
  , 60_000)
})
