import { describe, expect, it } from "@effect/vitest"
import { DiscordREST } from "dfx/DiscordREST"
import { Duration, Effect, Fiber, Layer } from "effect"
import * as Headers from "effect/http/Headers"
import * as TestClock from "effect/testing/TestClock"
import { HarnessRest } from "../../harness/Identities.ts"
import * as Reset from "../../harness/Reset.ts"
import * as Wire from "../../harness/Wire.ts"
import { ChannelId, MessageId } from "../../src/Snowflake.ts"
import { json, scriptedRest } from "../support/fakeDiscord.ts"

/**
 * Reset's message listing pages at the pace the per-channel bucket allows (M4 verifier; M5 live: a provisioned
 * thread holds hundreds of undeletable "added to the thread" notices, and the sixth page in a row answered 429
 * `remaining 0`, `reset-after` about 4.2 s, because dfx had taken the first page's `remaining 4` as the bucket's
 * limit per second).
 */
const channel = { id: ChannelId.make("300000000000000001"), name: "lab-public-thread" }
const bot = "200000000000000001"
const message = (n: number) => ({ id: MessageId.make(`5000000000000${String(n).padStart(5, "0")}`), type: 1, author: { id: bot }, pinned: false })
const page = (from: number, count: number) => Array.from({ length: count }, (_, index) => message(from - index))

describe("Wire.bucketWait", () => {
  it("is the reset-after when the bucket has no request left, and nothing otherwise", () => {
    expect(Duration.toMillis(Wire.bucketWait(Headers.fromInput({ "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "4.388" })))).toBe(4388)
    expect(Duration.toMillis(Wire.bucketWait(Headers.fromInput({ "x-ratelimit-remaining": "4", "x-ratelimit-reset-after": "1.000" })))).toBe(0)
    expect(Duration.toMillis(Wire.bucketWait(Headers.fromInput({ "x-ratelimit-remaining": "0" })))).toBe(0)
    expect(Duration.toMillis(Wire.bucketWait(Headers.fromInput({})))).toBe(0)
  })
})

describe("Reset.listAllMessages", () => {
  it.effect("waits for the bucket's reset before the next page when a page leaves it empty", () =>
    Effect.gen(function* () {
      const requests: Array<string> = []
      const rest = scriptedRest((method, path, query) => {
        requests.push(`${method} ${path} before=${query.get("before") ?? "-"}`)
        return query.get("before") === null
          ? json(200, page(20000, 100), { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "4.388" })
          : json(200, page(19900, 3), { "x-ratelimit-remaining": "4", "x-ratelimit-reset-after": "1.000" })
      })
      const harness = Layer.effect(HarnessRest, Effect.map(Effect.service(DiscordREST), (client) => HarnessRest.of(client))).pipe(Layer.provide(rest))
      const fiber = yield* Reset.listAllMessages(channel, "reset").pipe(Effect.provide(harness), Effect.forkChild)
      yield* TestClock.adjust("4387 millis")
      expect(requests).toEqual([`GET /channels/${channel.id}/messages before=-`])
      yield* TestClock.adjust("1 millis")
      const messages = yield* Fiber.join(fiber)
      expect(requests).toEqual([`GET /channels/${channel.id}/messages before=-`, `GET /channels/${channel.id}/messages before=${message(19901).id}`])
      expect(messages.length).toBe(103)
    })
  )

  it.effect("asks for the next page at once while the bucket has requests left, and stops at a short page", () =>
    Effect.gen(function* () {
      const requests: Array<string> = []
      const rest = scriptedRest((method, path, query) => {
        requests.push(`${method} ${path}`)
        return json(200, query.get("before") === null ? page(20000, 100) : page(19900, 0), { "x-ratelimit-remaining": "3", "x-ratelimit-reset-after": "1.000" })
      })
      const harness = Layer.effect(HarnessRest, Effect.map(Effect.service(DiscordREST), (client) => HarnessRest.of(client))).pipe(Layer.provide(rest))
      const messages = yield* Reset.listAllMessages(channel, "reset").pipe(Effect.provide(harness))
      expect(requests.length).toBe(2)
      expect(messages.length).toBe(100)
    })
  )
})
