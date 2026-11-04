import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Ref } from "effect"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as TestClock from "effect/testing/TestClock"
import { CommandBudget, countSince, dailyCap, type Ledger, layerMemory, make, windowMs } from "../../harness/CommandBudget.ts"

/**
 * The command-create budget (DESIGN §6 M8; H-205): every name a POST or PUT to an application's guild commands may
 * create counts, refused or not; a name a 2xx answer registered does not count again; the count is a rolling 24 hours
 * that survives processes in its ledger; and a request that would take it past 150 aborts before it is sent.
 */
const commands = "https://discord.com/api/v10/applications/100000000000000002/guilds/100000000000000001/commands"
const post = (name: string) => HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(commands), { type: 1, name, description: "d" })
const put = (names: ReadonlyArray<string>) => HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.put(commands), names.map((name) => ({ type: 1, name, description: "d" })))

describe("the command-create budget", () => {
  it.effect("counts each name a write may create, refused or not, and none a 2xx registered", () =>
    Effect.gen(function* () {
      const budget = yield* CommandBudget
      yield* budget.take(put(["a", "b"]))
      expect((yield* budget.stats).thisProcess).toBe(2)
      yield* budget.answered(put(["a", "b"]), 200)
      yield* budget.take(put(["a", "b"]))
      yield* budget.take(post("a"))
      expect((yield* budget.stats).thisProcess).toBe(2)
      // a refused POST of a new name counts, and teaches nothing: the same name counts again
      yield* budget.take(post("Upper"))
      yield* budget.answered(post("Upper"), 400)
      yield* budget.take(post("Upper"))
      expect((yield* budget.stats).thisProcess).toBe(4)
      // a PUT leaves exactly its names: after one of ["c"], "a" is new again
      yield* budget.take(put(["c"]))
      yield* budget.answered(put(["c"]), 200)
      yield* budget.take(post("a"))
      expect((yield* budget.stats).thisProcess).toBe(6)
    }).pipe(Effect.provide(layerMemory())))

  it.effect("ignores reads, other routes and an empty overwrite", () =>
    Effect.gen(function* () {
      const budget = yield* CommandBudget
      yield* budget.take(HttpClientRequest.get(commands))
      yield* budget.take(put([]))
      yield* budget.take(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post("https://discord.com/api/v10/channels/100000000000000003/messages"), { content: "x" }))
      yield* budget.take(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post("https://discord.com/api/v10/applications/100000000000000002/commands"), { name: "global" }))
      expect((yield* budget.stats).thisProcess).toBe(0)
    }).pipe(Effect.provide(layerMemory())))

  it.effect("dies on a command write whose body names no command it could count", () =>
    Effect.gen(function* () {
      const budget = yield* CommandBudget
      const exit = yield* Effect.exit(budget.take(HttpClientRequest.post(commands)))
      expect(Exit.isFailure(exit) && String(exit.cause).includes("the body names no command")).toBe(true)
    }).pipe(Effect.provide(layerMemory())))

  it.effect("aborts before a write that would pass the cap within 24 hours, counting the ledger other processes left", () =>
    Effect.gen(function* () {
      const now = 10 * windowMs
      yield* TestClock.setTime(now)
      const ledger = yield* Ref.make<Ledger>({ entries: [{ at: now - windowMs - 1, scope: "x", creates: 100 }, { at: now - 1000, scope: "x", creates: dailyCap - 1 }] })
      const budget = yield* make({ read: Ref.get(ledger), write: (next) => Ref.set(ledger, next) })
      expect((yield* budget.stats).last24h).toBe(dailyCap - 1)
      yield* budget.take(post("one"))
      // written through, and the entry older than 24 hours dropped
      expect(countSince(yield* Ref.get(ledger), now)).toBe(dailyCap)
      expect((yield* Ref.get(ledger)).entries.length).toBe(2)
      const exit = yield* Effect.exit(budget.take(post("two")))
      expect(Exit.isFailure(exit) && String(exit.cause).includes("command-create budget")).toBe(true)
      // a day after, neither entry counts any more
      yield* TestClock.setTime(now + windowMs + 1)
      yield* budget.take(post("two"))
      expect((yield* budget.stats).last24h).toBe(1)
    }))
})
