import { describe, expect, it } from "@effect/vitest"
import { BunFileSystem } from "@effect/platform-bun"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Drivers from "../../harness/Drivers.ts"
import { Capture, DryRun, librarySides, loadCanned, makeCapture, makeRecorder, operationRequest, type Recorded, requestCheck, requestDifferences } from "../../harness/DryRun.ts"
import { matrixRowAgreement } from "../../harness/Agreement.ts"
import * as Fixtures from "../../harness/Fixtures.ts"
import * as Identities from "../../harness/Identities.ts"
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
 * The request check (DESIGN §5.10, the M6 verifier), through the harness's real wiring (`Identities.compose`, the
 * subject's real bot build and its declared-route check) over a fake base client:
 *
 * - offline over the whole catalog: for one scenario of every (operation, lab channel) the catalog has, the
 *   library's operation with preflight bypassed (what step (d) sends) and the raw call of step (c), both over the
 *   dry-run stub, record one request each, and the two are the same request: the method, the path with its IDs and
 *   query, and the body. Nothing is sent;
 * - as the live run does it: steps (c) and (d) under the capture record their requests as sent, (d)'s own request
 *   first, and a `Transient` in (d) is an infrastructure abort.
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

/** The library's and the raw call's contexts for `scenario`, with fresh fixture messages (the bulk delete's age check). */
const contextsFor = (scenario: Scenario, runtime: Library.LibraryContext["runtime"], canned: ReadonlyMap<string, unknown>) =>
  Effect.gen(function* () {
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
    const call: Drivers.CallContext = { ids, state, channelId, subjectMessage: subjectMessage.id, harnessMessage: harnessMessage.id, secondHarnessMessage, stickerId, emojiId, forumTag, roleId, now, priorSend: prior }
    return { library, call, channelId }
  })

/** Runs `body` over the harness's real wiring with a fake base client answering `answer`, the guard armed and the lab admitted. */
const inLab = <A>(answer: (request: HttpClientRequest.HttpClientRequest) => Answer | undefined, body: (runtime: Library.LibraryContext["runtime"], canned: ReadonlyMap<string, unknown>) => Effect.Effect<A, never, Identities.Services>) =>
  Effect.gen(function* () {
    const client = yield* makeRecordingClient((request): Answer => subjectStartupAnswer(request) ?? answer(request) ?? { status: 404, body: { message: "not in the fake", code: 0 } })
    const gateway = yield* makeFakeGateway({ userFor: (token) => (token === "fake-subject-token" ? ids.subjectUserId : undefined), guildsFor: () => [guildCreate()] }, () => 0)
    const canned = yield* loadCanned.pipe(Effect.provide(BunFileSystem.layer))
    const result = yield* Effect.gen(function* () {
      const guard = yield* LabGuard
      yield* guard.arm({ harnessUserId, subjectUserId: ids.subjectUserId, targetUserId: ids.targetUserId, protectedChannels: new Set() })
      for (const [name, id] of ids.channels) yield* guard.admitChannel({ id, name })
      for (const [name, id] of ids.roles) yield* guard.admitRole({ id, name, botId: undefined })
      return yield* body(yield* BotRuntime, canned)
    }).pipe(Effect.provide(Identities.compose(client.layer, gateway.layer, fakeCredentials, { requestsPerSecond: 5, invalidCap: 1500 })))
    return { result, sent: yield* client.recorded }
  })

const startupPaths = ["/applications/@me", "/gateway/bot", `/guilds/${fakeGuildId}/members/${ids.subjectUserId}`, "/users/@me"]
const pathsOf = (sent: ReadonlyArray<{ readonly url: string }>) => sent.map((request) => new URL(request.url).pathname.replace(/^\/api\/v\d+/, ""))

describe("the request check over the catalog", () => {
  it("covers every operation of the catalog", () => {
    expect(new Set(representatives.map((scenario) => scenario.operation._tag))).toEqual(new Set(["send", "createPost", "message", "react", "pins", "createThread", "thread", "channelEdit", "member"]))
    expect(representatives.length).toBeGreaterThan(100)
  })

  it.live("the library sends exactly the raw call's request, for one scenario of each operation and lab channel", () =>
    Effect.gen(function* () {
      const { result, sent } = yield* inLab(
        () => undefined,
        (runtime, canned) =>
          Effect.gen(function* () {
            const problems: Array<string> = []
            const counts: Array<readonly [string, number, number]> = []
            for (const scenario of representatives) {
              const { library, call } = yield* contextsFor(scenario, runtime, canned)
              const bypassed = yield* Library.bypassedRequests(scenario.operation, library, yield* makeRecorder(canned))
              const expected = yield* Drivers.dryRequests(scenario, call, yield* makeRecorder(canned)).pipe(Effect.orDie)
              problems.push(...requestDifferences(scenario.id, bypassed, expected))
              counts.push([scenario.id, bypassed.length, expected.length])
            }
            return { problems, counts }
          })
      )
      expect(result.problems).toEqual([])
      expect(result.counts.filter(([, library, raw]) => library !== 1 || raw !== 1)).toEqual([])
      // nothing but the subject's startup reached the base client
      expect(pathsOf(sent).sort()).toEqual([...startupPaths].sort())
    })
  , 60_000)
})

describe("steps (c) and (d) live, under the capture", () => {
  const send = scenarios.find((scenario) => scenario.operation._tag === "send" && scenario.operation.payload === "plain" && Materialize.labNameOf(scenario.setup) === "lab-text" && !scenario.setup.fixtures.includes("subject-prior-send"))
  const pins = scenarios.find((scenario) => scenario.operation._tag === "pins" && scenario.operation.action === "list" && Materialize.labNameOf(scenario.setup) === "lab-text")
  const textId = ids.channels.get("lab-text")
  // Discord refuses the send, answers the recompute's refresh reads, and has no answer for the pins list
  const answer = (request: HttpClientRequest.HttpClientRequest): Answer | undefined => {
    const path = new URL(request.url).pathname.replace(/^\/api\/v\d+/, "")
    if (request.method === "POST" && path === `/channels/${textId}/messages`) return { status: 403, body: { message: "Missing Permissions", code: 50013 } }
    if (request.method === "GET" && path === `/channels/${textId}`) return { status: 200, body: { id: textId, type: 0, guild_id: fakeGuildId, permission_overwrites: [] } }
    if (request.method === "GET" && path === `/guilds/${fakeGuildId}/members/${ids.subjectUserId}`) return { status: 200, body: { user: { id: ids.subjectUserId }, roles: [] } }
    if (request.method === "GET" && path === `/guilds/${fakeGuildId}`) return { status: 200, body: { id: fakeGuildId, owner_id: ids.ownerId, roles: [{ id: fakeGuildId, permissions: "0", position: 0, managed: false }] } }
    if (request.method === "GET" && path === `/channels/${textId}/messages/pins`) return { status: 503, body: { message: "unavailable", code: 0 } }
    return undefined
  }

  it.live("records each step's request as sent; (d)'s first is its operation's, before the recompute's reads; a Transient in (d) aborts", () =>
    Effect.gen(function* () {
      if (send === undefined || pins === undefined) return yield* Effect.die(new Error("no plain send or pins list in lab-text"))
      const { result } = yield* inLab(answer, (runtime, canned) =>
        Effect.gen(function* () {
          const contexts = yield* contextsFor(send, runtime, canned)
          const capturedC = yield* makeCapture
          const called = yield* Drivers.rawCall(send, contexts.call).pipe(Effect.provideService(Capture, Option.some(capturedC)), Effect.orDie)
          const capturedD = yield* makeCapture
          const stepD = yield* Library.recomputeStep(send.operation, contexts.library).pipe(Effect.provideService(Capture, Option.some(capturedD)))
          const pinsContexts = yield* contextsFor(pins, runtime, canned)
          const aborted = yield* Effect.exit(Library.recomputeStep(pins.operation, pinsContexts.library))
          return { answer: called.answer._tag, c: yield* capturedC.recorded, d: yield* capturedD.recorded, stepD, aborted }
        })
      )
      expect(result.answer).toBe("Rejected")
      expect(result.c.map((entry) => `${entry.method} ${entry.path}`)).toEqual([`POST /channels/${textId}/messages`])
      expect(result.d.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        `POST /channels/${textId}/messages`,
        `GET /channels/${textId}`,
        `GET /guilds/${fakeGuildId}/members/${ids.subjectUserId}`,
        `GET /guilds/${fakeGuildId}`
      ])
      expect(requestDifferences("step (d)", operationRequest(result.d), operationRequest(result.c))).toEqual([])
      expect(result.stepD.record).toEqual({ tag: "MissingViewChannel", categories: ["access", "permission"] })
      expect(Exit.isFailure(result.aborted) && Cause.hasDies(result.aborted.cause)).toBe(true)
      expect(String(Exit.isFailure(result.aborted) ? Cause.squash(result.aborted.cause) : "")).toContain("infrastructure abort: step (d): DiscordUnavailable")
    })
  , 60_000)
})

describe("the request check's decision (pure, as the runner assembles it)", () => {
  const sendRequest = (content: string): Recorded => ({ method: "POST", route: "POST /channels/{id}/messages", path: "/channels/1/messages", body: JSON.stringify({ allowed_mentions: { parse: [] }, content }) })
  const refreshRead: Recorded = { method: "GET", route: "GET /channels/{id}", path: "/channels/1", body: "null" }
  const raw = [sendRequest("hi")]

  it("compares step (b) when it reached the stub, and step (d)'s own request when (d) ran; neither leaves the bypass fallback to the runner", () => {
    expect(librarySides({ reachedStub: true, requests: raw }, undefined).map(([label]) => label)).toEqual(["step (b)"])
    expect(librarySides({ reachedStub: false, requests: [] }, [sendRequest("hi"), refreshRead]).map(([label, requests]) => [label, requests.length])).toEqual([["step (d)", 1]])
    expect(librarySides({ reachedStub: true, requests: raw }, [sendRequest("hi")]).map(([label]) => label)).toEqual(["step (b)", "step (d)"])
    expect(librarySides({ reachedStub: false, requests: [] }, undefined)).toEqual([])
  })

  it("finds a step (d) request that differs from the raw call's, behind the recompute's reads, and passes the same one", () => {
    expect(requestCheck(librarySides({ reachedStub: false, requests: [] }, [sendRequest("hi"), refreshRead]), [...raw, refreshRead])).toEqual([])
    const problems = requestCheck(librarySides({ reachedStub: false, requests: [] }, [sendRequest("other"), refreshRead]), raw)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("step (d): request 1: body")
    expect(requestCheck(librarySides({ reachedStub: true, requests: [{ ...sendRequest("hi"), method: "PUT" }] }, undefined), raw)[0]).toContain("step (b): request 1: method PUT")
  })

  it("makes a row preflight-wiring before request-wiring, and request-wiring before the matrix's own judgment", () => {
    expect(matrixRowAgreement(false, ["x"], "agree")).toBe("preflight-wiring")
    expect(matrixRowAgreement(true, ["step (d): request 1: body ..."], "agree")).toBe("request-wiring")
    expect(matrixRowAgreement(true, [], "level-vs-raw")).toBe("level-vs-raw")
    expect(matrixRowAgreement(true, [], "agree")).toBe("agree")
  })
})
