import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
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
