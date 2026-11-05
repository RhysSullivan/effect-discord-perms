import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { dmEventOf, summary } from "../../harness/ChecklistRun.ts"
import * as Checklist from "../../src/interactions/Checklist.ts"
import { textId } from "../support/guild.ts"
import { callback, followUp, interaction, only, original, settle, withRunner } from "../support/interactions.ts"

/**
 * The phase-3 checklist (DESIGN §4.14, §6 M9), registered and run offline only: `/checklist` decodes its options and
 * posts the prompts, each prompt's button reaches its handler on the route of the mode it exercises, and the human's
 * verdicts are recorded. The live run is Rhys's (LOG.md "Waiting for Rhys").
 */
const checklist = interaction(
  2,
  {
    id: "700000000000000003",
    name: "checklist",
    type: 1,
    options: [
      { name: "pick", type: 3, value: "beta" },
      { name: "who", type: 6, value: "200000000000000077" },
      { name: "where", type: 7, value: textId }
    ],
    resolved: { channels: { [textId]: { id: textId, type: 0, permissions: "3072" } } }
  }
)
const click = (customId: string) => interaction(3, { custom_id: customId, component_type: 2 }, { message: { id: "500000000000000009" } })

const isObject = (value: Schema.Json | undefined): value is Schema.JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)

/** A request body's message content: its own, or its callback data's. */
const contentOf = (body: Schema.Json | undefined): string => {
  if (!isObject(body)) return ""
  const direct = body["content"]
  if (typeof direct === "string") return direct
  const data = body["data"]
  const content = isObject(data) ? data["content"] : undefined
  return typeof content === "string" ? content : ""
}

describe("the checklist", () => {
  it("lists every item with what the human should see, and its command and routes build within Discord's limits", () =>
    Effect.runSync(
      Effect.gen(function* () {
        expect(Object.keys(Checklist.items)).toEqual([...Checklist.itemList])
        for (const item of Checklist.itemList) expect(Checklist.promptText).toContain(`- ${item}: `)
        expect(Checklist.promptText.length).toBeLessThanOrEqual(2000)
        const rows = yield* Checklist.promptRows
        expect(rows.map((row) => row.components.length)).toEqual([5, 5])
      })
    ))

  it.effect("answers /checklist with the decoded options, then follows up with the prompts", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const session = yield* Checklist.make
        yield* session.register
        yield* publish(checklist)
        yield* settle
        const all = yield* sent
        expect(only(all)).toEqual([`POST ${callback}`, `POST ${followUp}`])
        expect(contentOf(all[0]?.body)).toBe(`option-values: pick=beta, who=200000000000000077, where=text ${textId}`)
        expect(contentOf(all[1]?.body)).toBe(Checklist.promptText)
      })
    )
  )

  it.effect("routes each prompt to its handler in the mode it exercises, and records the verdicts", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const session = yield* Checklist.make
        yield* session.register
        // click data (manual): a reply naming the decoded data
        yield* publish(click(yield* Checklist.manualStep.customId({ item: "click-data", n: 42 })))
        yield* settle
        expect(contentOf((yield* sent)[0]?.body)).toBe("decoded 42")
        // slow public: the runner defers (5), then edits the deferred message
        yield* publish(click(yield* Checklist.publicStep.customId({ item: "slow-public" })))
        yield* settle
        yield* TestClock.adjust("4 seconds")
        yield* settle
        const slow = (yield* sent).slice(1)
        expect(only(slow)).toEqual([`POST ${callback}`, `PATCH ${original}`])
        expect(slow[0]?.body).toEqual({ type: 5 })
        expect(contentOf(slow[1]?.body)).toBe("slow public reply")
        // the expired control
        yield* publish(click(yield* Checklist.oldControl.customId({ version: 1 })))
        yield* settle
        expect(contentOf((yield* sent)[3]?.body)).toBe("This control has expired.")
        // a verdict is recorded, and its message updated
        yield* publish(click(yield* Checklist.verdict.customId({ item: "slow-public", ok: true })))
        yield* settle
        expect((yield* sent)[4]?.body).toMatchObject({ type: 7 })
        expect(yield* session.verdicts).toEqual(new Map([["slow-public", true]]))
      })
    )
  )

  it("records only DM events (no guild), with whether a DM's content arrived (Q-17, Q-22), and summarises the run", () => {
    expect(dmEventOf("MESSAGE_CREATE", { channel_id: "1", content: "hello" })).toEqual({ event: "MESSAGE_CREATE", contentDelivered: true })
    expect(dmEventOf("MESSAGE_CREATE", { channel_id: "1", content: "" })).toEqual({ event: "MESSAGE_CREATE", contentDelivered: false })
    expect(dmEventOf("MESSAGE_CREATE", { channel_id: "1", guild_id: "2", content: "hello" })).toBeUndefined()
    expect(dmEventOf("MESSAGE_REACTION_ADD", { user_id: "1" })).toEqual({ event: "MESSAGE_REACTION_ADD" })
    expect(dmEventOf("TYPING_START", { user_id: "1", guild_id: "2" })).toBeUndefined()
    expect(dmEventOf("GUILD_MEMBER_UPDATE", {})).toBeUndefined()
    const lines = summary({ verdicts: new Map([["update", true]]), withIntents: [{ event: "MESSAGE_CREATE", contentDelivered: true }], withoutIntents: [], canary: true })
    expect(lines).toContain("  update: as expected")
    expect(lines).toContain("  modal: no verdict")
    expect(lines.at(-2)).toBe("  DM events with the DM intents: MESSAGE_CREATE (content delivered)")
    expect(lines.at(-1)).toBe("  DM events without them, before the canary: none; canary arrived")
  })
})
