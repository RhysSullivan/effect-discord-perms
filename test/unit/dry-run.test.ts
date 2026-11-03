import { describe, expect, it } from "@effect/vitest"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Exit, Option } from "effect"
import { DryRun, loadCanned, makeRecorder, type Recorded, requestDifferences } from "../../harness/DryRun.ts"
import { compose, TargetRest } from "../../harness/Identities.ts"
import { LabGuard } from "../../harness/Lab.ts"
import { ChannelId, UserId } from "../../src/Snowflake.ts"
import { type Answer, fakeCredentials, fakeGuildId, fakeSubjectGateway, makeRecordingClient, subjectStartupAnswer } from "../support/fakeDiscord.ts"

/**
 * The dry-run switch (DESIGN §5.10 step (b) and the request check): under it the shared client still applies the
 * Lab guard (as the live request would be judged, with no kick or ban permit used), then records the request's
 * method, path and body, answers with the canned body and sends nothing; without it, requests go out as usual.
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
      expect(yield* recorder.recorded).toEqual([{ method: "POST", route: "POST /channels/{id}/messages", path: `/channels/${labText}/messages`, body: '{\n  "content": "dry"\n}\n' }])
      expect(result.live.id).toBe("600000000000000009")
      expect(result.sentAfter).toBe(1)
    })
  )

  it.live("records a multipart body by its parts and a query by its parameters, and judges a kick of the target as if permitted, without using a permit", () =>
    Effect.gen(function* () {
      const client = yield* makeRecordingClient((request): Answer => subjectStartupAnswer(request) ?? { status: 200, body: { id: "600000000000000009" } })
      const gateway = yield* fakeSubjectGateway()
      const bodies = yield* loadCanned.pipe(Effect.provide(BunFileSystem.layer))
      const recorder = yield* makeRecorder(bodies)
      const targetUser = UserId.make("200000000000000002")
      const result = yield* Effect.gen(function* () {
        const guard = yield* LabGuard
        yield* guard.arm({ harnessUserId: UserId.make("200000000000000000"), subjectUserId: UserId.make("200000000000000001"), targetUserId: targetUser, protectedChannels: new Set() })
        yield* guard.admitChannel({ id: labText, name: "lab-text" })
        const before = (yield* client.recorded).length
        const target = yield* TargetRest
        const dry = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provideService(DryRun, Option.some(recorder)))
        yield* dry(target.withFiles([new File(["lab file\n"], "lab.txt", { type: "text/plain" })])(target.createMessage(labText, { content: "dry" })))
        yield* dry(target.listPins(labText, { limit: 50 }))
        yield* dry(target.deleteGuildMember(fakeGuildId, targetUser))
        const harnessKick = yield* Effect.exit(dry(target.deleteGuildMember(fakeGuildId, "200000000000000000")))
        const sentDuringDryRun = (yield* client.recorded).length - before
        // the dry kick used no permit, and created none: the live kick is refused
        const liveKick = yield* Effect.exit(target.deleteGuildMember(fakeGuildId, targetUser))
        return { harnessKick, sentDuringDryRun, liveKick }
      }).pipe(Effect.provide(compose(client.layer, gateway.layer, fakeCredentials, { requestsPerSecond: 5, invalidCap: 1500 })))
      expect(String(result.harnessKick)).toContain("lab guard refused")
      expect(String(result.liveKick)).toContain("a kick needs a permit")
      expect(result.sentDuringDryRun).toBe(0)
      const recorded = yield* recorder.recorded
      expect(recorded.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        `POST /channels/${labText}/messages`,
        `GET /channels/${labText}/messages/pins?limit=50`,
        `DELETE /guilds/${fakeGuildId}/members/${targetUser}`
      ])
      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual([
        { name: "files[0]", file: { name: "lab.txt", type: "text/plain", size: 9 } },
        { name: "payload_json", value: { content: "dry" } }
      ])
      expect(recorded.slice(1).map((entry) => entry.body)).toEqual(["null\n", "null\n"])
    })
  )
})

describe("requestDifferences", () => {
  const request = (overrides: Partial<Recorded> = {}): Recorded => ({ method: "PATCH", route: "PATCH /channels/{id}", path: "/channels/1", body: '{"locked":true}', ...overrides })

  it("finds nothing for the same requests, and names the method, the path, the body and the count when they differ", () => {
    expect(requestDifferences("lib", [request()], [request()])).toEqual([])
    expect(requestDifferences("lib", [request({ method: "PUT" })], [request()])).toEqual(["lib: request 1: method PUT, the raw call's PATCH"])
    expect(requestDifferences("lib", [request({ path: "/channels/2" })], [request()])).toEqual(["lib: request 1: path /channels/2, the raw call's /channels/1"])
    expect(requestDifferences("lib", [request({ body: '{"archived":true}' })], [request()])).toEqual(['lib: request 1: body {"archived":true}, the raw call\'s {"locked":true}'])
    expect(requestDifferences("lib", [], [request()])).toEqual(["lib: 0 request(s) (none), the raw call 1 (PATCH /channels/{id})"])
  })
})
