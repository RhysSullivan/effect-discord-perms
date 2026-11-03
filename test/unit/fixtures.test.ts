import { describe, expect, it } from "@effect/vitest"
import { DiscordREST } from "dfx/DiscordREST"
import { Effect, Exit, Layer } from "effect"
import * as Fixtures from "../../harness/Fixtures.ts"
import { Setup } from "../../harness/scenario/Dsl.ts"
import { SubjectRaw } from "../../src/bot/Internals.ts"
import { ChannelId, MessageId } from "../../src/Snowflake.ts"
import { json, type Scripted, scriptedRest } from "../support/fakeDiscord.ts"

/**
 * The subject's prior send (DESIGN §5.10 step 2, H-053): the H-053 rows observe something only if the subject
 * really sent a message just before the operation, so the fixture's request is checked here through the subject's
 * REST seam, and the raw call (`Drivers.rawCall`, `test/unit/drivers.test.ts`) refuses to run without its answer.
 */
const channel = ChannelId.make("300000000000000001")
const setup = (fixtures: Setup["fixtures"]) => new Setup({ channel: "text", grants: [], removals: [], memberState: "normal", fixtures })

/** A prior send's fields, without the module's private key. */
const plain = (prior: Fixtures.PriorSend) => {
  switch (prior._tag) {
    case "NotRequested":
      return { _tag: prior._tag }
    case "Sent":
      return { _tag: prior._tag, messageId: prior.messageId }
    case "Refused":
      return { _tag: prior._tag, status: prior.status, code: prior.code }
  }
}

const priorSend = (fixtures: Setup["fixtures"], answer: Scripted) =>
  Effect.gen(function* () {
    const requests: Array<string> = []
    const rest = scriptedRest((method, path) => {
      requests.push(`${method} ${path}`)
      return answer
    })
    const subject = Layer.effect(SubjectRaw, Effect.map(Effect.service(DiscordREST), (client) => SubjectRaw.of(client))).pipe(Layer.provide(rest))
    const exit = yield* Fixtures.subjectPriorSend(setup(fixtures), channel).pipe(Effect.provide(subject), Effect.exit)
    return { exit, requests }
  })

describe("the subject's prior send", () => {
  it.effect("posts one message in the scenario channel when the setup has the fixture", () =>
    Effect.gen(function* () {
      const { exit, requests } = yield* priorSend(["subject-prior-send"], json(200, { id: "600000000000000001" }))
      expect(Exit.map(exit, plain)).toEqual(Exit.succeed({ _tag: "Sent", messageId: MessageId.make("600000000000000001") }))
      expect(requests).toEqual([`POST /channels/${channel}/messages`])
    })
  )

  it.effect("sends nothing without the fixture, and says it was not requested", () =>
    Effect.gen(function* () {
      const { exit, requests } = yield* priorSend(["subject-message"], json(500, {}))
      expect(Exit.map(exit, plain)).toEqual(Exit.succeed({ _tag: "NotRequested" }))
      expect(requests).toEqual([])
    })
  )

  it.effect("reports Discord's refusal with its status and code, for a rejected-by-discord row", () =>
    Effect.gen(function* () {
      const { exit } = yield* priorSend(["subject-prior-send"], json(400, { message: "Slowmode is active", code: 20016 }))
      expect(Exit.map(exit, plain)).toEqual(Exit.succeed({ _tag: "Refused", status: 400, code: 20016 }))
    })
  )
})
