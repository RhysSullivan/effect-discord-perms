import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { type DmEvent, dmEventOf, interactionChannelOf, isDone, labInteractionsOnly, summary } from "../../harness/ChecklistRun.ts"
import { BotRuntime } from "../../src/bot/Runtime.ts"
import * as Checklist from "../../src/interactions/Checklist.ts"
import { textId } from "../support/guild.ts"
import { callback, followUp, interaction, only, original, type Sent, settle, withRunner } from "../support/interactions.ts"

/**
 * The phase-3 checklist (DESIGN §4.14, §6 M9), registered and run offline only: `/checklist` decodes its options and
 * posts the prompts, each prompt's button reaches its handler on the route of the mode it exercises, the human's
 * verdicts are recorded, and a whole simulated sitting reaches `done`. The live run is Rhys's (LOG.md "Waiting for Rhys").
 */
const invocation = {
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
const checklist = interaction(2, invocation)
const suggest = (typed: string) => interaction(4, { ...invocation, options: [{ name: "search", type: 3, value: typed, focused: true }] })
const click = (customId: string, messageId = "500000000000000009") => interaction(3, { custom_id: customId, component_type: 2 }, { message: { id: messageId } })
const submit = (customId: string, text: string) => interaction(5, { custom_id: customId, components: [{ type: 1, components: [{ type: 4, custom_id: "text", value: text }] }] })
const dmEvents: ReadonlyArray<DmEvent> = [{ event: "MESSAGE_CREATE", contentDelivered: true }, { event: "MESSAGE_REACTION_ADD" }, { event: "TYPING_START" }]

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

/** The `custom_id`s of a message body's buttons, or `undefined` when the body does not set its components. */
const buttonsOf = (body: Schema.Json | undefined): ReadonlyArray<string> | undefined => {
  if (!isObject(body)) return undefined
  const rows = body["components"]
  if (!Array.isArray(rows)) return undefined
  return rows.flatMap((row) => {
    const elements = isObject(row) ? row["components"] : undefined
    return Array.isArray(elements) ? elements.flatMap((element) => (isObject(element) && typeof element["custom_id"] === "string" ? [element["custom_id"]] : [])) : []
  })
}

/** A message as the human sees it: its text and its buttons' `custom_id`s. */
interface Shown {
  readonly content: string
  readonly buttons: ReadonlyArray<string>
}

const blank: Shown = { content: "", buttons: [] }

/** `shown` with a message body applied (an edit keeps what it does not set). */
const applied = (shown: Shown, body: Schema.Json | undefined): Shown => ({
  content: isObject(body) && typeof body["content"] === "string" ? body["content"] : shown.content,
  buttons: buttonsOf(body) ?? shown.buttons
})

/**
 * Discord as a human in the channel sees it, rebuilt from the requests the runner sent: a reply (4) or a deferral (5)
 * is a new message and the interaction's original; a deferred update (6) makes the clicked message the original, and an
 * update (7) edits it; `PATCH @original` edits the original; a follow-up is a new message; a modal (9) is open until
 * submitted; an autocomplete's choices (8) are shown.
 */
const discordView = () => {
  const messages = new Map<string, Shown>()
  let applied_ = 0
  let next = 1
  let originalId: string | undefined
  let modal: string | undefined
  let choices: Schema.Json | undefined
  const add = (shown: Shown): string => {
    const id = String(500000000000000100n + BigInt(next++))
    messages.set(id, shown)
    return id
  }
  const edit = (id: string | undefined, body: Schema.Json | undefined) => {
    if (id !== undefined) messages.set(id, applied(messages.get(id) ?? blank, body))
  }
  return {
    messages,
    /** Applies the requests sent since the last call, for an interaction from the message `at`. */
    apply: (sent: ReadonlyArray<Sent>, at: string | undefined) => {
      for (const request of sent.slice(applied_)) {
        const body = request.body
        if (request.method === "POST" && request.path === callback && isObject(body)) {
          const data = body["data"]
          switch (body["type"]) {
            case 4:
              originalId = add(applied(blank, data))
              break
            case 5:
              originalId = add({ content: "thinking...", buttons: [] })
              break
            case 6:
              originalId = at
              break
            case 7:
              originalId = at
              edit(at, data)
              break
            case 8:
              choices = data
              break
            case 9:
              modal = isObject(data) && typeof data["custom_id"] === "string" ? data["custom_id"] : undefined
              break
          }
        } else if (request.method === "PATCH" && request.path === original) edit(originalId, body)
        else if (request.method === "POST" && request.path === followUp) add(applied(blank, body))
      }
      applied_ = sent.length
    },
    takeModal: (): string | undefined => {
      const open = modal
      modal = undefined
      return open
    },
    choices: () => choices
  }
}

const isNegativeVerdict = (customId: string): boolean => Option.match(Checklist.verdict.decode(customId), { onNone: () => false, onSome: (data) => !data.ok })

describe("the checklist", () => {
  it("lists every item with what the human should see; its follow-ups build within Discord's limits and carry every item but option-values once", () =>
    Effect.runSync(
      Effect.gen(function* () {
        expect(Object.keys(Checklist.items)).toEqual([...Checklist.itemList])
        const prompts = yield* Checklist.followUps
        for (const prompt of prompts) {
          expect(prompt.content.length).toBeLessThanOrEqual(2000)
          expect(prompt.components.length).toBeLessThanOrEqual(5)
          for (const row of prompt.components) expect(row.components.length).toBeLessThanOrEqual(5)
        }
        const lines = prompts.flatMap((prompt) => prompt.content.split("\n"))
        for (const item of Checklist.itemList.filter((item) => item !== "option-values")) {
          expect(lines.filter((line) => line === `${item}: ${Checklist.items[item]}`)).toHaveLength(1)
        }
        // an update replaces its message: each update prompt is alone on its message
        const updates = prompts.filter((prompt) => prompt.components.some((row) => row.components.some((element) => "customId" in element && Checklist.updateStep.decode(element.customId)._tag === "Some")))
        expect(updates.map((prompt) => prompt.components.flatMap((row) => row.components).length)).toEqual([1, 1])
      })
    ))

  it.effect("answers /checklist with the decoded options, then follows up with the five prompt messages in order", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const session = yield* Checklist.make
        yield* session.register
        yield* publish(checklist)
        yield* settle
        const all = yield* sent
        expect(only(all)).toEqual([`POST ${callback}`, ...Array.from({ length: 5 }, () => `POST ${followUp}`)])
        expect(contentOf(all[0]?.body)).toBe(Checklist.optionValuesText(`pick=beta, who=200000000000000077, where=text ${textId}`))
        expect(all.slice(1).map((request) => contentOf(request.body))).toEqual((yield* Checklist.followUps).map((prompt) => prompt.content))
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

  it.effect("drives one whole simulated sitting to done: every button the human sees, clicked once, gives every item a verdict", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const session = yield* Checklist.make
        yield* session.register
        const view = discordView()
        const step = (data: unknown, at: string | undefined) =>
          Effect.gen(function* () {
            yield* publish(data)
            // past the slow items' 4 s and the deferral's 2 s, a second at a time
            for (let second = 0; second < 6; second++) {
              yield* settle
              yield* TestClock.adjust("1 second")
            }
            yield* settle
            view.apply(yield* sent, at)
          })
        // the human types in `search`, then runs /checklist
        yield* step(suggest("abc"), undefined)
        expect(view.choices()).toEqual({ choices: [{ name: "search: abc", value: "search: abc" }] })
        yield* step(checklist, undefined)
        expect(view.messages.size).toBe(6)
        // then clicks every button they see once (and "As expected" of each verdict pair), in the order shown
        const clicked = new Set<string>()
        for (let round = 0; round < 100; round++) {
          const nextClick = [...view.messages].flatMap(([id, shown]) => shown.buttons.filter((button) => !clicked.has(`${id} ${button}`) && !isNegativeVerdict(button)).map((button) => [id, button] as const))[0]
          if (nextClick === undefined) break
          const [at, customId] = nextClick
          clicked.add(`${at} ${customId}`)
          expect(isDone(yield* session.verdicts, dmEvents)).toBe(false)
          yield* step(click(customId, at), at)
          const modal = view.takeModal()
          if (modal !== undefined) yield* step(submit(modal, "hello"), undefined)
        }
        const verdicts = yield* session.verdicts
        expect(Checklist.itemList.filter((item) => verdicts.get(item) !== true)).toEqual([])
        expect(isDone(verdicts, dmEvents)).toBe(true)
        expect(isDone(verdicts, dmEvents.slice(1))).toBe(false)
        // every verdict replaced its pair, so no verdict button is left anywhere
        expect([...view.messages.values()].flatMap((shown) => shown.buttons.filter((button) => Checklist.verdict.decode(button)._tag === "Some"))).toEqual([])
      })
    )
  )

  it.effect("drops an interaction from a channel outside the lab before any handler sees it, and answers one in the lab", () =>
    withRunner(({ publish, sent, logs }) =>
      Effect.gen(function* () {
        const runtime = yield* BotRuntime
        const session = yield* Checklist.make
        yield* session.register.pipe(Effect.provideService(BotRuntime, yield* labInteractionsOnly(runtime, (channel) => Effect.succeed(channel === textId))))
        // #rules, say: a guild command can be run in any channel
        yield* publish({ ...checklist, channel: { id: "300000000000000098", type: 0 } })
        yield* settle
        expect(yield* sent).toEqual([])
        expect((yield* logs).filter((line) => line.includes("outside the lab"))).toEqual(["Warn: checklist: ignored an interaction outside the lab's channels (channel 300000000000000098)"])
        yield* publish(checklist)
        yield* settle
        expect(only(yield* sent)[0]).toBe(`POST ${callback}`)
      })
    )
  )

  it("reads an interaction's channel from `channel`, else `channel_id`", () => {
    expect(interactionChannelOf({ channel: { id: "1", type: 0 }, channel_id: "2" })).toBe("1")
    expect(interactionChannelOf({ channel_id: "2" })).toBe("2")
    expect(interactionChannelOf({})).toBeUndefined()
    expect(interactionChannelOf("not an interaction")).toBeUndefined()
  })

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
