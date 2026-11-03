import { describe, expect, it } from "@effect/vitest"
import { DiscordREST } from "dfx/DiscordREST"
import { Cause, Effect, Exit, Layer } from "effect"
import * as Drivers from "../../harness/Drivers.ts"
import * as Fixtures from "../../harness/Fixtures.ts"
import * as Materialize from "../../harness/Materialize.ts"
import * as Predict from "../../harness/Predict.ts"
import { scenarios } from "../../harness/scenario/catalog/index.ts"
import type { Scenario } from "../../harness/scenario/Dsl.ts"
import { SubjectRaw } from "../../src/bot/Internals.ts"
import { json, scriptedRest } from "../support/fakeDiscord.ts"

/**
 * The raw call needs the prior send's answer (M4 verifier): an H-053 row's operation is the subject's second send
 * in a row only if `Fixtures.subjectPriorSend` ran first, and only that function makes the `PriorSend` the raw call
 * takes. The raw call also checks the answer against the setup before it sends anything.
 */
const scenario = (id: string): Scenario => {
  const found = scenarios.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no scenario ${id}`)
  return found
}
const witness = scenario("send/targeted/slowmode-second-send")
const plainSend = scenario("send/targeted/overwrite-everyone-allow")
const ids = Predict.symbolicIds

/** The scripted subject, recording each request. */
const subjectWith = (requests: Array<string>) =>
  Layer.effect(SubjectRaw, Effect.map(Effect.service(DiscordREST), (client) => SubjectRaw.of(client))).pipe(
    Layer.provide(
      scriptedRest((method, path) => {
        requests.push(`${method} ${path}`)
        return json(200, { id: "600000000000000009", tts: false, mention_everyone: false, embeds: [], attachments: [] })
      })
    )
  )

/** Runs the scenario's raw call with the prior send `fixtureSetup` produced; the exit and every request the subject made. */
const rawCallAfter = (target: Scenario, fixtureSetup: Scenario) =>
  Effect.gen(function* () {
    const requests: Array<string> = []
    const subject = subjectWith(requests)
    const state = Materialize.desired(target.setup, ids)
    const channelId = ids.channels.get(state.channel)
    if (channelId === undefined) return yield* Effect.die(new Error("no channel"))
    const prior = yield* Fixtures.subjectPriorSend(fixtureSetup.setup, channelId).pipe(Effect.provide(subject), Effect.orDie)
    if (prior._tag === "Refused") return yield* Effect.die(new Error("refused"))
    const before = requests.length
    const exit = yield* Drivers.rawCall(target, {
      ids,
      state,
      channelId,
      subjectMessage: undefined,
      harnessMessage: undefined,
      secondHarnessMessage: undefined,
      stickerId: undefined,
      emojiId: undefined,
      forumTag: undefined,
      roleId: undefined,
      now: 0,
      priorSend: prior
    }).pipe(Effect.provide(subject), Effect.exit)
    return { exit, prior, priorRequests: requests.slice(0, before), callRequests: requests.slice(before) }
  })

describe("the raw call and the subject's prior send", () => {
  it("the catalog's slowmode witness is a send whose setup has the prior send", () => {
    expect(witness.operation._tag).toBe("send")
    expect(witness.setup.fixtures).toContain("subject-prior-send")
    expect(plainSend.setup.fixtures).not.toContain("subject-prior-send")
  })

  it.effect("an H-053 row sends its operation after the prior send", () =>
    Effect.gen(function* () {
      const result = yield* rawCallAfter(witness, witness)
      expect(result.prior._tag).toBe("Sent")
      expect(result.priorRequests).toEqual([expect.stringMatching(/^POST \/channels\/\d+\/messages$/)])
      expect(Exit.isSuccess(result.exit)).toBe(true)
      expect(result.callRequests).toEqual(result.priorRequests)
    })
  )

  it.effect("an H-053 row without its prior send is a defect, and nothing is sent", () =>
    Effect.gen(function* () {
      const result = yield* rawCallAfter(witness, plainSend)
      expect(result.prior._tag).toBe("NotRequested")
      expect(result.callRequests).toEqual([])
      expect(Exit.isFailure(result.exit) && Cause.hasDies(result.exit.cause)).toBe(true)
      expect(String(Exit.isFailure(result.exit) ? Cause.squash(result.exit.cause) : "")).toContain("subject-prior-send")
    })
  )

  it.effect("a prior send on a row that did not ask for one is a defect too", () =>
    Effect.gen(function* () {
      const result = yield* rawCallAfter(plainSend, witness)
      expect(result.prior._tag).toBe("Sent")
      expect(result.callRequests).toEqual([])
      expect(Exit.isFailure(result.exit) && Cause.hasDies(result.exit.cause)).toBe(true)
    })
  )
})
