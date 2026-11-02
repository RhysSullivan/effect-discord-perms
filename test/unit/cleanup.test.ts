import { describe, expect, it } from "@effect/vitest"
import { DiscordREST } from "dfx/DiscordREST"
import { Effect, Exit, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as Converge from "../../harness/Converge.ts"
import { HarnessRest } from "../../harness/Identities.ts"
import { LabRequestFailed } from "../../harness/Lab.ts"
import { ChannelId, MessageId } from "../../src/Snowflake.ts"
import { json, type Scripted, scriptedRest } from "../support/fakeDiscord.ts"

/**
 * Cleanup's message deletes (DESIGN §5.10 step 9) are idempotent: a message the harness's listing still shows
 * but that is already gone (404 10008) is what the delete wants. M4 live, the M4 verifier's first exit run
 * aborted on exactly that, right after the subject's bulk delete in voice text chat.
 */
const channel = { id: ChannelId.make("300000000000000001"), name: "lab-voice" }
const now = Date.parse("2026-11-02T12:00:00Z")
const idAt = (ms: number, n: number) => MessageId.make((((BigInt(ms) - 1420070400000n) << 22n) | BigInt(n)).toString())
const bot = "200000000000000001"
const listed = (ids: ReadonlyArray<MessageId>) => ids.map((id) => ({ id, type: 0, author: { id: bot }, pinned: false }))
const unknownMessage = json(404, { message: "Unknown Message", code: 10008 })

/** Runs `cleanMessages` against a fake that lists `ids` and answers each delete with `answer`; the exit and the deletes seen. */
const clean = (ids: ReadonlyArray<MessageId>, answer: (method: string, path: string) => Scripted) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now)
    const deletes: Array<string> = []
    const rest = scriptedRest((method, path) => {
      if (method === "GET" && path === `/channels/${channel.id}/messages`) return json(200, listed(ids))
      deletes.push(`${method} ${path}`)
      return answer(method, path)
    })
    const harness = Layer.effect(HarnessRest, Effect.map(Effect.service(DiscordREST), (client) => HarnessRest.of(client))).pipe(Layer.provide(rest))
    const exit = yield* Converge.cleanMessages(channel, new Set([bot])).pipe(Effect.provide(harness), Effect.exit)
    return { exit, deletes }
  })

describe("cleanup's message deletes", () => {
  it.effect("skip a listed message that is already gone (10008)", () =>
    Effect.gen(function* () {
      const gone = idAt(now - 1000, 1)
      const { exit, deletes } = yield* clean([gone], () => unknownMessage)
      expect(exit).toEqual(Exit.void)
      expect(deletes).toEqual([`DELETE /channels/${channel.id}/messages/${gone}`])
    })
  )

  it.effect("fall back to single deletes when a bulk delete answers 10008, skipping the gone ones", () =>
    Effect.gen(function* () {
      const [gone, kept] = [idAt(now - 1000, 1), idAt(now - 2000, 2)]
      const { exit, deletes } = yield* clean([gone, kept], (method, path) =>
        path.endsWith("/bulk-delete") || path.endsWith(`/${gone}`) ? unknownMessage : json(200, {})
      )
      expect(exit).toEqual(Exit.void)
      expect(deletes).toEqual([
        `POST /channels/${channel.id}/messages/bulk-delete`,
        `DELETE /channels/${channel.id}/messages/${gone}`,
        `DELETE /channels/${channel.id}/messages/${kept}`
      ])
    })
  )

  it.effect("still fail on any other refusal", () =>
    Effect.gen(function* () {
      const message = idAt(now - 1000, 1)
      const { exit } = yield* clean([message], () => json(403, { message: "Missing Permissions", code: 50013 }))
      expect(exit).toEqual(Exit.fail(new LabRequestFailed({ step: "cleanup: delete a message in lab-voice", status: 403, code: 50013, message: "Missing Permissions" })))
    })
  )
})
