import { describe, expect, it } from "@effect/vitest"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Exit, Option } from "effect"
import { DryRun, loadCanned, makeRecorder } from "../../harness/DryRun.ts"
import { compose, TargetRest } from "../../harness/Identities.ts"
import { LabGuard } from "../../harness/Lab.ts"
import { ChannelId, UserId } from "../../src/Snowflake.ts"
import { type Answer, fakeCredentials, fakeSubjectGateway, makeRecordingClient, subjectStartupAnswer } from "../support/fakeDiscord.ts"

/**
 * The dry-run switch (DESIGN §5.10 step (b)): under it the shared client still applies the Lab guard, then
 * answers with the canned body and sends nothing; without it, requests go out as usual.
 */
const labText = ChannelId.make("300000000000000001")
const elsewhere = "300000000000000099"

describe("the dry run", () => {
  it.live("answers a guarded write with its canned body, sends nothing, and still refuses non-lab writes", () =>
    Effect.gen(function* () {
      const client = yield* makeRecordingClient((request): Answer => subjectStartupAnswer(request) ?? { status: 200, body: { id: "600000000000000009" } })
      const gateway = yield* fakeSubjectGateway()
      const bodies = yield* loadCanned.pipe(Effect.provide(BunFileSystem.layer))
      const recorder = yield* makeRecorder(bodies)
      const result = yield* Effect.gen(function* () {
        const guard = yield* LabGuard
        yield* guard.arm({
          harnessUserId: UserId.make("200000000000000000"),
          subjectUserId: UserId.make("200000000000000001"),
          targetUserId: UserId.make("200000000000000002"),
          protectedChannels: new Set()
        })
        yield* guard.admitChannel({ id: labText, name: "lab-text" })
        const before = (yield* client.recorded).length
        const target = yield* TargetRest
        const dry = yield* target.createMessage(labText, { content: "dry" }).pipe(Effect.provideService(DryRun, Option.some(recorder)))
        const refused = yield* Effect.exit(target.createMessage(elsewhere, { content: "dry" }).pipe(Effect.provideService(DryRun, Option.some(recorder))))
        const sentDuringDryRun = (yield* client.recorded).length - before
        const live = yield* target.createMessage(labText, { content: "live" })
        return { dry, refused, sentDuringDryRun, live, sentAfter: (yield* client.recorded).length - before }
      }).pipe(Effect.provide(compose(client.layer, gateway.layer, fakeCredentials, { requestsPerSecond: 5, invalidCap: 1500 })))
      expect(result.dry.id).toBe("100000000000000001")
      expect(Exit.isFailure(result.refused) && String(result.refused)).toContain("lab guard refused")
      expect(result.sentDuringDryRun).toBe(0)
      expect(yield* recorder.recorded).toEqual([{ method: "POST", route: "POST /channels/{id}/messages" }])
      expect(result.live.id).toBe("600000000000000009")
      expect(result.sentAfter).toBe(1)
    })
  )
})
