import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Option } from "effect"
import * as Headers from "effect/http/Headers"
import { HarnessRest, TargetRest, compose } from "../../harness/Identities.ts"
import { Pacing } from "../../harness/Pacing.ts"
import { SubjectRaw } from "../../src/bot/Internals.ts"
import { fakeCredentials, makeRecordingClient } from "../support/fakeDiscord.ts"

/**
 * The identity test (DESIGN §4.2, G1): the harness wiring, built from the exported `compose` with only the base
 * HttpClient swapped for a recording fake and fake tokens, sends each identity's request with its own token,
 * and all three identities share one base client (one pacing bucket and one set of counters). Without
 * `Layer.fresh` every identity would send the first token. M7 re-runs it with the subject as the real bot layer.
 */
describe("harness identities", () => {
  it.live("send three distinct Authorization headers through one shared base client", () =>
    Effect.gen(function* () {
      const client = yield* makeRecordingClient(() => ({ status: 200, body: { id: "200000000000000001", username: "fake" } }))
      const layer = compose(client.layer, fakeCredentials, { requestsPerSecond: 5, invalidCap: 1500 })
      const stats = yield* Effect.gen(function* () {
        const harness = yield* HarnessRest
        const target = yield* TargetRest
        const subject = yield* SubjectRaw
        yield* harness.getMyUser()
        yield* target.getMyUser()
        yield* subject.getMyUser()
        expect(harness).not.toBe(target)
        expect(harness).not.toBe(subject)
        expect(target).not.toBe(subject)
        return yield* (yield* Pacing).stats
      }).pipe(Effect.provide(layer))

      const recorded = yield* client.recorded
      expect(recorded.map((entry) => entry.authorization)).toEqual(["Bot fake-harness-token", "Bot fake-target-token", "Bot fake-subject-token"])
      expect(recorded.map((entry) => entry.url)).toEqual([
        "https://discord.com/api/v10/users/@me",
        "https://discord.com/api/v10/users/@me",
        "https://discord.com/api/v10/users/@me"
      ])
      expect(stats.requests).toBe(3)
      expect(stats.writes).toBe(0)
    })
  )

  it.live("count 401, 403 and 429 answers at the shared client, including the one dfx retries", () =>
    Effect.gen(function* () {
      // the target gets a 403; the subject a 429 (retry at once), then a 200 on dfx's retry; the harness a 200
      let subjectAnswers = 0
      const client = yield* makeRecordingClient((request) => {
        const authorization = Option.getOrUndefined(Headers.get(request.headers, "authorization"))
        if (authorization === "Bot fake-target-token") return { status: 403, body: { message: "Missing Access", code: 50001 } }
        if (authorization === "Bot fake-subject-token" && subjectAnswers++ === 0) {
          return { status: 429, body: { message: "You are being rate limited.", retry_after: 0, global: false }, headers: { "retry-after": "0" } }
        }
        return { status: 200, body: { id: "200000000000000001", username: "fake" } }
      })
      const layer = compose(client.layer, fakeCredentials, { requestsPerSecond: 5, invalidCap: 1500 })
      const { stats, target, subject } = yield* Effect.gen(function* () {
        yield* (yield* HarnessRest).getMyUser()
        const target = yield* Effect.exit((yield* TargetRest).getMyUser())
        const subject = yield* Effect.exit((yield* SubjectRaw).getMyUser())
        return { stats: yield* (yield* Pacing).stats, target, subject }
      }).pipe(Effect.provide(layer))
      expect(Exit.isFailure(target)).toBe(true)
      expect(Exit.isSuccess(subject)).toBe(true)
      expect((yield* client.recorded).map((entry) => entry.authorization)).toEqual(["Bot fake-harness-token", "Bot fake-target-token", "Bot fake-subject-token", "Bot fake-subject-token"])
      expect(stats.requests).toBe(4)
      expect(stats.invalid).toBe(2)
    })
  )

  it.live("refuse a write before the guard is armed, without sending it", () =>
    Effect.gen(function* () {
      const client = yield* makeRecordingClient(() => ({ status: 200, body: {} }))
      const layer = compose(client.layer, fakeCredentials, { requestsPerSecond: 5, invalidCap: 1500 })
      const exit = yield* Effect.gen(function* () {
        const target = yield* TargetRest
        return yield* target.createMessage("300000000000000001", { content: "hello" })
      }).pipe(Effect.provide(layer), Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("no writes before the identity checks arm the guard")
      expect(yield* client.recorded).toEqual([])
    })
  )
})
