import * as CommandBudget from "../../harness/CommandBudget.ts"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Option } from "effect"
import * as Headers from "effect/http/Headers"
import { HarnessRest, TargetRest, compose } from "../../harness/Identities.ts"
import { LabGuard } from "../../harness/Lab.ts"
import { Pacing } from "../../harness/Pacing.ts"
import { BotRuntime } from "../../src/bot/Bot.ts"
import { SubjectRaw } from "../../src/bot/Internals.ts"
import { UserId } from "../../src/Snowflake.ts"
import { channelObfuscation } from "../../src/gateway/Codec.ts"
import { type Answer, fakeCredentials, fakeGuildId, fakeSubjectGateway, fakeSubjectUserId, makeRecordingClient, subjectStartupAnswer } from "../support/fakeDiscord.ts"

/**
 * The identity test (DESIGN §4.2, G1): the harness wiring, built from the exported `compose` with only the base
 * HttpClient swapped for a recording fake, the WebSocket for a fake gateway, and fake tokens. Each identity sends
 * its own token, and all three share one base client (one pacing bucket and one set of counters). Without
 * `Layer.fresh` every identity would send the first token. The subject is the library's real bot build: its
 * startup requests go through the same shared client, and `SubjectRaw` is that build's client. M7 re-ran it with
 * the subject's build on the capabilities codec: its Identify carries `capabilities: 32768`.
 */
const pacing = { requestsPerSecond: 5, invalidCap: 1500 } as const
const withStartup = (respond: (request: Parameters<typeof subjectStartupAnswer>[0]) => Answer) => (request: Parameters<typeof subjectStartupAnswer>[0]): Answer =>
  subjectStartupAnswer(request) ?? respond(request)

describe("harness identities", () => {
  it.live("send three distinct Authorization headers through one shared base client", () =>
    Effect.gen(function* () {
      const client = yield* makeRecordingClient(withStartup(() => ({ status: 200, body: { id: "200000000000000009", username: "fake" } })))
      const gateway = yield* fakeSubjectGateway()
      const layer = compose(client.layer, gateway.layer, fakeCredentials, pacing, CommandBudget.layerMemory())
      const { before, after, startup } = yield* Effect.gen(function* () {
        const harness = yield* HarnessRest
        const target = yield* TargetRest
        const subject = yield* SubjectRaw
        const startup = (yield* client.recorded).length
        const before = yield* (yield* Pacing).stats
        yield* harness.getMyUser()
        yield* target.getMyUser()
        yield* subject.getMyUser()
        expect(harness).not.toBe(target)
        expect(harness).not.toBe(subject)
        expect(target).not.toBe(subject)
        expect((yield* BotRuntime).identity.userId).toBe(fakeSubjectUserId)
        return { before, after: yield* (yield* Pacing).stats, startup }
      }).pipe(Effect.provide(layer))

      const recorded = yield* client.recorded
      // the subject's startup went through the shared client too, with the subject's token
      expect(recorded.slice(0, startup).map((entry) => entry.authorization)).toEqual(Array.from({ length: startup }, () => "Bot fake-subject-token"))
      expect(before.requests).toBe(startup)
      expect(recorded.slice(startup).map((entry) => entry.authorization)).toEqual(["Bot fake-harness-token", "Bot fake-target-token", "Bot fake-subject-token"])
      expect(recorded.slice(startup).map((entry) => entry.url)).toEqual([
        "https://discord.com/api/v10/users/@me",
        "https://discord.com/api/v10/users/@me",
        "https://discord.com/api/v10/users/@me"
      ])
      expect(after.requests - before.requests).toBe(3)
      expect(after.writes).toBe(0)
      // the subject is the library's real bot build: it identified through the capabilities codec (M7)
      expect(yield* gateway.identified).toEqual([{ user: fakeSubjectUserId, intents: 3, capabilities: channelObfuscation }])
    })
  )

  it.live("count 401, 403 and 429 answers at the shared client, including the one dfx retries", () =>
    Effect.gen(function* () {
      // the target gets a 403; the subject a 429 (retry at once), then a 200 on dfx's retry; the harness a 200
      let subjectAnswers = 0
      const client = yield* makeRecordingClient(
        withStartup((request) => {
          const authorization = Option.getOrUndefined(Headers.get(request.headers, "authorization"))
          if (authorization === "Bot fake-target-token") return { status: 403, body: { message: "Missing Access", code: 50001 } }
          if (authorization === "Bot fake-subject-token" && subjectAnswers++ === 0) {
            return { status: 429, body: { message: "You are being rate limited.", retry_after: 0, global: false }, headers: { "retry-after": "0" } }
          }
          return { status: 200, body: { id: "300000000000000001", type: 0 } }
        })
      )
      const gateway = yield* fakeSubjectGateway()
      const layer = compose(client.layer, gateway.layer, fakeCredentials, pacing, CommandBudget.layerMemory())
      const { before, after, target, subject } = yield* Effect.gen(function* () {
        const before = yield* (yield* Pacing).stats
        yield* (yield* HarnessRest).getChannel("300000000000000001")
        const target = yield* Effect.exit((yield* TargetRest).getChannel("300000000000000001"))
        const subject = yield* Effect.exit((yield* SubjectRaw).getChannel("300000000000000001"))
        return { before, after: yield* (yield* Pacing).stats, target, subject }
      }).pipe(Effect.provide(layer))
      expect(Exit.isFailure(target)).toBe(true)
      expect(Exit.isSuccess(subject)).toBe(true)
      const recorded = yield* client.recorded
      expect(recorded.slice(before.requests).map((entry) => entry.authorization)).toEqual([
        "Bot fake-harness-token",
        "Bot fake-target-token",
        "Bot fake-subject-token",
        "Bot fake-subject-token"
      ])
      expect(after.requests - before.requests).toBe(4)
      expect(after.invalid - before.invalid).toBe(2)
    })
  )

  it.live("refuse a write before the guard is armed, without sending it", () =>
    Effect.gen(function* () {
      const client = yield* makeRecordingClient(withStartup(() => ({ status: 200, body: {} })))
      const gateway = yield* fakeSubjectGateway()
      const layer = compose(client.layer, gateway.layer, fakeCredentials, pacing, CommandBudget.layerMemory())
      const { exit, sent } = yield* Effect.gen(function* () {
        const startup = (yield* client.recorded).length
        const target = yield* TargetRest
        const exit = yield* Effect.exit(target.createMessage("300000000000000001", { content: "hello" }))
        return { exit, sent: (yield* client.recorded).length - startup }
      }).pipe(Effect.provide(layer))
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("no writes before the identity checks arm the guard")
      expect(sent).toBe(0)
    })
  )

  it.live("count a guild command write of any identity against the create budget, and abort one past the cap before sending it (M8)", () =>
    Effect.gen(function* () {
      const client = yield* makeRecordingClient(withStartup((request) => ({ status: 200, body: request.method === "POST" ? { id: "400000000000000001", name: "x" } : [] })))
      const gateway = yield* fakeSubjectGateway()
      // the ledger other processes left: one create short of the cap
      const now = Date.now()
      const layer = compose(client.layer, gateway.layer, fakeCredentials, pacing, CommandBudget.layerMemory({ entries: [{ at: now, scope: `100000000000000002/${fakeGuildId}`, creates: CommandBudget.dailyCap - 1 }] }))
      const commands = `/applications/100000000000000002/guilds/${fakeGuildId}/commands`
      const { first, second, stats, sent } = yield* Effect.gen(function* () {
        yield* (yield* LabGuard).arm({ harnessUserId: UserId.make("200000000000000000"), subjectUserId: UserId.make(fakeSubjectUserId), targetUserId: UserId.make("200000000000000002"), protectedChannels: new Set() })
        const subject = yield* SubjectRaw
        const startup = (yield* client.recorded).length
        const first = yield* Effect.exit(subject.createGuildApplicationCommand("100000000000000002", fakeGuildId, { name: "one", description: "d" }))
        const second = yield* Effect.exit(subject.createGuildApplicationCommand("100000000000000002", fakeGuildId, { name: "two", description: "d" }))
        return { first, second, stats: yield* (yield* CommandBudget.CommandBudget).stats, sent: (yield* client.recorded).slice(startup) }
      }).pipe(Effect.provide(layer))
      expect(Exit.isSuccess(first)).toBe(true)
      expect(Exit.isFailure(second) && !Exit.hasFails(second)).toBe(true)
      expect(String(second)).toContain("command-create budget")
      expect(stats).toEqual({ last24h: CommandBudget.dailyCap, thisProcess: 1 })
      // the refused write was never sent
      expect(sent.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([`POST /api/v10${commands}`])
    })
  )
})
