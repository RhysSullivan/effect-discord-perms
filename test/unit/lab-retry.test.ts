import * as CommandBudget from "../../harness/CommandBudget.ts"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Option, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { compose, HarnessRest } from "../../harness/Identities.ts"
import { CurrentLabStep, isRepeatable, labStep, labStepRetries, LabRequestFailed, withLabRetries } from "../../harness/Lab.ts"
import { Pacing } from "../../harness/Pacing.ts"
import { fakeCredentials, fakeSubjectGateway, makeRecordingClient, subjectStartupAnswer } from "../support/fakeDiscord.ts"

/**
 * Lab-step retries after a 5xx (DESIGN §5.10, §5.11; the M6 verifier): a lab step whose requests are all reads or
 * absolute writes is sent again after a 500-599 answer, at most three times with 1, 2 and 4 s between; a POST, any
 * other status and a step with no answer are never retried. Each retry is counted at the shared client.
 */

/** A lab step that "sends" `method` (as the shared client would record it) and fails with the next of `statuses`. */
const scripted = (method: string, statuses: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const step = Effect.gen(function* () {
      const current = yield* CurrentLabStep
      if (Option.isSome(current)) yield* current.value.record(method)
      const index = yield* Ref.getAndUpdate(calls, (n) => n + 1)
      const status = statuses[index]
      if (status === undefined || (status >= 200 && status < 300)) return "ok"
      return yield* new LabRequestFailed({ step: "test step", status, code: 0, message: "scripted" })
    })
    return { step, calls: Ref.get(calls) }
  })

/** The status of a failed attempt, as `labStep` reads it. */
const statusOf = <A>(exit: Exit.Exit<A, LabRequestFailed>): number | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const reason = exit.cause.reasons[0]
  return reason?._tag === "Fail" ? reason.error.status : undefined
}

/** The retry wrapper `labStep` uses, over a step that already fails with `LabRequestFailed`. */
const labStepLike = <A>(effect: Effect.Effect<A, LabRequestFailed>) => withLabRetries("test step", effect, statusOf)

/** Runs `effect` under the retries, with the clock moved past every backoff. */
const runWithRetries = <A>(effect: Effect.Effect<A, LabRequestFailed>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.exit(labStepLike(effect)))
    yield* TestClock.adjust("8 seconds")
    return yield* Fiber.join(fiber)
  })

describe("which lab steps may be sent again", () => {
  it("reads and the harness's PUT, PATCH and DELETE, never a POST or a step that sent nothing", () => {
    expect(isRepeatable(["GET"])).toBe(true)
    expect(isRepeatable(["PUT", "GET"])).toBe(true)
    expect(isRepeatable(["patch", "DELETE"])).toBe(true)
    expect(isRepeatable(["POST"])).toBe(false)
    expect(isRepeatable(["GET", "POST"])).toBe(false)
    expect(isRepeatable([])).toBe(false)
  })
})

describe("withLabRetries", () => {
  it.effect("sends a repeatable step again after a 5xx, and succeeds when Discord recovers", () =>
    Effect.gen(function* () {
      const { step, calls } = yield* scripted("GET", [503, 500, 200])
      const exit = yield* runWithRetries(step)
      expect(Exit.isSuccess(exit) ? exit.value : exit).toBe("ok")
      expect(yield* calls).toBe(3)
    })
  )

  it.effect("gives up after three retries with the last 5xx", () =>
    Effect.gen(function* () {
      const { step, calls } = yield* scripted("PUT", [502, 502, 502, 502, 200])
      const exit = yield* runWithRetries(step)
      expect(statusOf(exit)).toBe(502)
      expect(yield* calls).toBe(labStepRetries + 1)
    })
  )

  it.effect("never sends a POST again, nor a step answered 4xx or with no response", () =>
    Effect.gen(function* () {
      for (const [method, status] of [["POST", 500], ["GET", 404], ["GET", 429], ["DELETE", 0]] as const) {
        const { step, calls } = yield* scripted(method, [status, 200])
        const exit = yield* runWithRetries(step)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* calls).toBe(1)
      }
    })
  )

  it.effect("waits 1, 2 and 4 s between the attempts", () =>
    Effect.gen(function* () {
      const { step, calls } = yield* scripted("GET", [500, 500, 500, 200])
      const fiber = yield* Effect.forkChild(labStepLike(step))
      yield* TestClock.adjust("999 millis")
      expect(yield* calls).toBe(1)
      yield* TestClock.adjust("1 millis")
      expect(yield* calls).toBe(2)
      yield* TestClock.adjust("1999 millis")
      expect(yield* calls).toBe(2)
      yield* TestClock.adjust("1 millis")
      expect(yield* calls).toBe(3)
      yield* TestClock.adjust("4 seconds")
      expect(yield* Fiber.join(fiber)).toBe("ok")
      expect(yield* calls).toBe(4)
    })
  )
})

describe("lab steps through the shared client", () => {
  it.live("retry a harness GET answered 503 once, count the retry, and never retry a POST", () =>
    Effect.gen(function* () {
      let channelReads = 0
      const client = yield* makeRecordingClient((request) => {
        const startup = subjectStartupAnswer(request)
        if (startup !== undefined) return startup
        if (request.method === "GET" && request.url.endsWith("/channels/300000000000000001")) {
          return channelReads++ === 0 ? { status: 503, body: { message: "upstream connect error", code: 0 } } : { status: 200, body: { id: "300000000000000001", type: 0 } }
        }
        return { status: 500, body: { message: "Internal Server Error", code: 0 } }
      })
      const gateway = yield* fakeSubjectGateway()
      const result = yield* Effect.gen(function* () {
        const rest = yield* HarnessRest
        const before = (yield* client.recorded).length
        const read = yield* rest.getChannel("300000000000000001").pipe(labStep("test: read a channel"))
        const reads = (yield* client.recorded).length - before
        const stats = yield* (yield* Pacing).stats
        return { read, reads, retries: stats.labRetries }
      }).pipe(Effect.provide(compose(client.layer, gateway.layer, fakeCredentials, { requestsPerSecond: 5, invalidCap: 1500 }, CommandBudget.layerMemory())))
      expect(result.read).toMatchObject({ id: "300000000000000001" })
      expect(result.reads).toBe(2)
      expect(result.retries).toEqual([["test: read a channel", 1]])
    })
  , 20_000)
})
