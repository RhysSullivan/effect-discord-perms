import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { defaults, make, maxRequestsPerSecond, routeKey } from "../../harness/Pacing.ts"

/**
 * Global pacing and counters (DESIGN §5.11): request starts are spaced across all callers, writes are counted
 * per stable route, and the invalid-request budget aborts the run.
 */
const url = (path: string) => `https://discord.com/api/v10${path}`

describe("pacing", () => {
  it.effect("spaces request starts at 1000 / rps ms across callers", () =>
    Effect.gen(function* () {
      const pacing = yield* make({ requestsPerSecond: 5, invalidCap: 1500 })
      yield* pacing.take("GET", url("/users/@me"))
      const second = yield* Effect.forkChild(pacing.take("GET", url("/users/@me")))
      const third = yield* Effect.forkChild(pacing.take("GET", url("/users/@me")))
      yield* TestClock.adjust("199 millis")
      expect(second.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 millis")
      yield* Fiber.join(second)
      expect(third.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("200 millis")
      yield* Fiber.join(third)
      expect((yield* pacing.stats).requests).toBe(3)
    })
  )

  it.effect("counts writes per route with snowflakes replaced, and never counts reads", () =>
    Effect.gen(function* () {
      const pacing = yield* make({ requestsPerSecond: 5, invalidCap: 1500 })
      const all = Effect.all(
        [
          pacing.take("GET", url("/channels/300000000000000001/messages")),
          pacing.take("PATCH", url("/channels/300000000000000001")),
          pacing.take("PATCH", url("/channels/300000000000000002")),
          pacing.take("DELETE", url("/channels/300000000000000001/messages/500000000000000001"))
        ],
        { concurrency: 1 }
      )
      const fiber = yield* Effect.forkChild(all)
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(fiber)
      const stats = yield* pacing.stats
      expect(stats.requests).toBe(4)
      expect(stats.writes).toBe(3)
      expect(stats.writesByRoute).toEqual([
        ["DELETE /channels/{id}/messages/{id}", 1],
        ["PATCH /channels/{id}", 2]
      ])
    })
  )

  it.effect("dies when the invalid-request count reaches the cap", () =>
    Effect.gen(function* () {
      const pacing = yield* make({ requestsPerSecond: 5, invalidCap: 3 })
      const at = url("/channels/300000000000000001")
      yield* pacing.recordStatus(200, "GET", at)
      yield* pacing.recordStatus(404, "GET", at)
      yield* pacing.recordStatus(401, "GET", at)
      yield* pacing.recordStatus(403, "GET", at)
      expect((yield* pacing.stats).invalid).toBe(2)
      const exit = yield* Effect.exit(pacing.recordStatus(429, "PATCH", at))
      expect(Exit.isFailure(exit) && !Exit.hasFails(exit)).toBe(true)
      expect((yield* pacing.stats).rateLimitedByRoute).toEqual([["PATCH /channels/{id}", 1]])
    })
  )

  it.effect("refuses a rate above 10 per second, and defaults to 10 (§5.11)", () =>
    Effect.gen(function* () {
      expect(maxRequestsPerSecond).toBe(10)
      expect(defaults).toStrictEqual({ requestsPerSecond: 10, invalidCap: 1500 })
      const exit = yield* Effect.exit(make({ requestsPerSecond: 11, invalidCap: 1500 }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isSuccess(yield* Effect.exit(make({ requestsPerSecond: 10, invalidCap: 1500 })))).toBe(true)
    })
  )

  it.effect("spaces the default rate's request starts 100 ms apart", () =>
    Effect.gen(function* () {
      const pacing = yield* make(defaults)
      yield* pacing.take("GET", url("/users/@me"))
      const second = yield* Effect.forkChild(pacing.take("GET", url("/users/@me")))
      yield* TestClock.adjust("99 millis")
      expect(second.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 millis")
      yield* Fiber.join(second)
    })
  )

  it("keys routes without the base URL or the query", () => {
    expect(routeKey("put", url("/applications/100000000000000001/guilds/100000000000000002/commands?x=1"))).toBe("PUT /applications/{id}/guilds/{id}/commands")
    expect(routeKey("PATCH", url("/guilds/100000000000000002/members/@me"))).toBe("PATCH /guilds/{id}/members/@me")
  })
})
