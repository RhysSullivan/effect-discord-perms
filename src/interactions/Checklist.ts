/**
 * The phase-3 checklist (DESIGN §4.14, §6 M9): a `/checklist` command whose prompts a human clicks through in Perms Lab,
 * to see the interaction lifecycle work against live Discord. It is registered and tested offline only; running it is
 * Rhys's (LOG.md "Waiting for Rhys"), through `harness/main.ts checklist`.
 *
 * `/checklist` (with its options filled in) replies with the invocation it decoded (Q-18: the option values a handler
 * receives), then posts the prompts: a button per item, each exercising one path of the runner, on the route whose
 * mode that path needs. Every answer carries two verdict buttons, "As expected" and "Not as expected"; the human's
 * verdicts are kept in {@link Session.verdicts} and logged. {@link items} says what the human should see.
 */
import { Effect, Ref, Schema, type Scope } from "effect"
import type { BotRuntime } from "../bot/Runtime.ts"
import { Channels } from "../channels/Ops.ts"
import { Command } from "../commands/Command.ts"
import { ComponentRoute } from "../components/CustomId.ts"
import { catchCategory } from "../errors/Category.ts"
import type { CustomIdTooLong } from "../errors/Payload.ts"
import { type ActionRow, type InteractiveButton, row } from "../payload/Components.ts"
import { Permissions } from "../permissions/Require.ts"
import { Interactions } from "./Runner.ts"

/** The checklist's items, in prompt order. */
export const itemList = [
  "option-values",
  "autocomplete",
  "click-data",
  "slow-public",
  "slow-ephemeral",
  "update",
  "slow-update",
  "modal",
  "follow-up",
  "defer-edit",
  "expired",
  "app-permissions"
] as const

/** A checklist item. */
export type Item = (typeof itemList)[number]

/** What the human checks for each item. */
export const items: { readonly [K in Item]: string } = {
  "option-values": "the /checklist reply names the options you filled in: the choice, the member's ID and the channel's kind and ID (Q-18)",
  autocomplete: "typing in /checklist's `search` option suggests `search: <what you typed>`",
  "click-data": "the button answers `decoded 42`: its custom_id's data reached the handler (Q-18)",
  "slow-public": "\"thinking...\" for about 4 s, then a public reply `slow public reply` (auto-defer 5, then PATCH @original)",
  "slow-ephemeral": "as slow-public, but only you see `slow ephemeral reply` (auto-defer 5 with EPHEMERAL)",
  update: "the button's message changes to `updated by the button` (callback 7)",
  "slow-update": "after about 4 s the button's message changes to `updated after a deferral` (auto-defer 6, then PATCH @original)",
  modal: "a form titled `Checklist` opens; after you submit it, only you see `you wrote: <your text>`",
  "follow-up": "a reply `first`, then a second message `second, a follow-up` (callback 4, then the webhook)",
  "defer-edit": "only you see \"thinking...\", then `edited after deferring` (defer, then editOriginal)",
  expired: "only you see `This control has expired.` (a custom_id that no longer decodes)",
  "app-permissions": "the reply says whether SendMessages is granted here by app_permissions and by the guild state; both should match the channel (Q-8)"
}

const ItemSchema = Schema.Literals(itemList)

/** The checklist command. */
export const command = Command.chatInput({
  name: "checklist",
  description: "Perms Lab: the phase-3 checklist, for a human to click through",
  options: [
    { type: "string", name: "pick", description: "any choice", required: true, choices: [{ name: "Alpha", value: "alpha" }, { name: "Beta", value: "beta" }] },
    { type: "user", name: "who", description: "any member", required: true },
    { type: "channel", name: "where", description: "any text channel", required: true, channelTypes: ["text"] },
    { type: "string", name: "search", description: "type something to see suggestions", autocomplete: true }
  ]
})

/** The manual-mode prompts (a reply, a modal, a follow-up, a deferral, app_permissions). */
export const manualStep = ComponentRoute.make("checklist-manual", Schema.Struct({ item: Schema.Literals(["click-data", "modal", "follow-up", "defer-edit", "app-permissions"]), n: Schema.optionalKey(Schema.Int) }))
/** The slow public reply ("public" mode). */
export const publicStep = ComponentRoute.make("checklist-public", Schema.Struct({ item: Schema.Literal("slow-public") }))
/** The slow ephemeral reply ("ephemeral" mode). */
export const ephemeralStep = ComponentRoute.make("checklist-ephemeral", Schema.Struct({ item: Schema.Literal("slow-ephemeral") }))
/** The updates ("update" mode). */
export const updateStep = ComponentRoute.make("checklist-update", Schema.Struct({ item: Schema.Literals(["update", "slow-update"]) }))
/** The verdict buttons. */
export const verdict = ComponentRoute.make("checklist-verdict", Schema.Struct({ item: ItemSchema, ok: Schema.Boolean }))
/** The modal's route. */
export const form = ComponentRoute.make("checklist-form", Schema.Struct({ item: Schema.Literal("modal") }))
/** A button built by an older version of a route: its ID no longer decodes under the registered `checklist-old`. */
export const oldControl = ComponentRoute.make("checklist-old", Schema.Struct({ version: Schema.Literal(1) }))
const currentControl = ComponentRoute.make("checklist-old", Schema.Struct({ version: Schema.Literal(2) }))

/** How long the slow items' handlers take: past the runner's 2.5 s auto-defer. */
export const slowFor = "4 seconds"

/** A running checklist. */
export interface Session {
  /** The human's verdicts so far. */
  readonly verdicts: Effect.Effect<ReadonlyMap<Item, boolean>>
  /** Registers every handler for the caller's scope. */
  readonly register: Effect.Effect<void, never, BotRuntime | Scope.Scope>
}

/** The verdict buttons for `item`. */
const verdictRow = (item: Item): Effect.Effect<ActionRow, CustomIdTooLong> =>
  Effect.gen(function* () {
    const yes = yield* verdict.customId({ item, ok: true })
    const no = yield* verdict.customId({ item, ok: false })
    return row([
      { kind: "button", style: "success", label: "As expected", customId: yes },
      { kind: "button", style: "danger", label: "Not as expected", customId: no }
    ])
  })

const button = (label: string, customId: Effect.Effect<InteractiveButton["customId"], CustomIdTooLong>): Effect.Effect<InteractiveButton, CustomIdTooLong> =>
  Effect.map(customId, (id) => ({ kind: "button", style: "primary", label, customId: id }))

/** The prompts' rows: a button per item (the option values and autocomplete are checked on /checklist itself). */
export const promptRows: Effect.Effect<ReadonlyArray<ActionRow>, CustomIdTooLong> = Effect.gen(function* () {
  const first = [
    yield* button("Click data", manualStep.customId({ item: "click-data", n: 42 })),
    yield* button("Slow public", publicStep.customId({ item: "slow-public" })),
    yield* button("Slow ephemeral", ephemeralStep.customId({ item: "slow-ephemeral" })),
    yield* button("Update", updateStep.customId({ item: "update" })),
    yield* button("Slow update", updateStep.customId({ item: "slow-update" }))
  ] as const
  const second = [
    yield* button("Modal", manualStep.customId({ item: "modal" })),
    yield* button("Follow-up", manualStep.customId({ item: "follow-up" })),
    yield* button("Defer, edit", manualStep.customId({ item: "defer-edit" })),
    yield* button("Expired", oldControl.customId({ version: 1 })),
    yield* button("app_permissions", manualStep.customId({ item: "app-permissions" }))
  ] as const
  return [row(first), row(second)]
})

/** The prompts' text: each item and what to see. */
export const promptText = ["Phase-3 checklist: click each button below, then its verdict.", ...itemList.map((item) => `- ${item}: ${items[item]}`)].join("\n")

/** Builds a checklist session (see the module comment). */
export const make: Effect.Effect<Session> = Effect.gen(function* () {
  const verdicts = yield* Ref.make<ReadonlyMap<Item, boolean>>(new Map())
  const failed = (what: string) => Effect.logWarning(`checklist: ${what}`)
  const verdictsFor = (item: Item) => Effect.map(verdictRow(item), (decided) => [decided])

  const onCommand = Interactions.command(command, (ix) =>
    Effect.gen(function* () {
      const { pick, who, where } = ix.invocation.options
      const rows = yield* promptRows
      const components = yield* verdictsFor("option-values")
      return yield* ix.reply({ content: `option-values: pick=${pick}, who=${who.id}, where=${where.kind} ${where.id}`, components }, (answered) =>
        answered.followUp({ content: promptText, components: rows }).pipe(catchCategory(["permission", "state", "payload"], (error) => failed(`the prompts: ${error._tag}`)))
      )
    }).pipe(catchCategory("payload", (error) => ix.reply({ content: `checklist: ${error._tag}` })))
  )

  const onSearch = Interactions.autocomplete(command, (ix) => ix.choices([{ name: `search: ${ix.focused.value}`.slice(0, 100), value: `search: ${ix.focused.value}`.slice(0, 100) }]))

  const onManual = Interactions.component(manualStep, "manual", (ix) =>
    Effect.gen(function* () {
      const item = ix.data.item
      const components = yield* verdictsFor(item)
      switch (item) {
        case "click-data":
          return yield* ix.reply({ content: `decoded ${ix.data.n ?? "nothing"}`, components })
        case "modal":
          return yield* ix.showModal({ customId: yield* form.customId({ item: "modal" }), title: "Checklist", inputs: [{ customId: "text", label: "Write anything", style: "short", required: true }] })
        case "follow-up":
          return yield* ix.reply({ content: "first" }, (answered) =>
            answered.followUp({ content: "second, a follow-up", components }).pipe(catchCategory(["permission", "state"], (error) => failed(`follow-up: ${error._tag}`)))
          )
        case "defer-edit":
          return yield* ix.defer({ ephemeral: true }, (deferred) =>
            Effect.andThen(Effect.sleep("2 seconds"), deferred.editOriginal({ content: "edited after deferring", components })).pipe(Effect.catchTag("InteractionExpired", deferred.giveUp))
          )
        case "app-permissions": {
          const byApp = yield* Permissions.require(ix.channel, ["SendMessages"]).pipe(
            Effect.as("granted"),
            catchCategory(["permission", "state"], (error) => Effect.succeed(`not granted (${error._tag})`))
          )
          const byState = yield* Channels.get(ix.channel.id).pipe(
            Effect.flatMap((channel) => Permissions.require(channel, ["SendMessages"])),
            Effect.as("granted"),
            catchCategory(["permission", "state"], (error) => Effect.succeed(`not granted (${error._tag})`))
          )
          return yield* ix.reply({ content: `app-permissions: SendMessages by app_permissions ${byApp}; by the guild state ${byState}`, components })
        }
      }
    }).pipe(catchCategory("payload", (error) => ix.reply({ content: `checklist: ${error._tag}` })))
  )

  const onPublic = Interactions.component(publicStep, "public", (ix) =>
    Effect.gen(function* () {
      yield* Effect.sleep(slowFor)
      return yield* ix.reply({ content: "slow public reply", components: yield* verdictsFor(ix.data.item) })
    }).pipe(catchCategory("payload", (error) => ix.reply({ content: `checklist: ${error._tag}` })))
  )

  const onEphemeral = Interactions.component(ephemeralStep, "ephemeral", (ix) =>
    Effect.gen(function* () {
      yield* Effect.sleep(slowFor)
      return yield* ix.reply({ content: "slow ephemeral reply", ephemeral: true, components: yield* verdictsFor(ix.data.item) })
    }).pipe(catchCategory("payload", (error) => ix.reply({ content: `checklist: ${error._tag}`, ephemeral: true })))
  )

  const onUpdate = Interactions.component(updateStep, (ix) =>
    Effect.gen(function* () {
      if (ix.data.item === "slow-update") yield* Effect.sleep(slowFor)
      return yield* ix.update({ content: ix.data.item === "update" ? "updated by the button" : "updated after a deferral", components: yield* verdictsFor(ix.data.item) })
    }).pipe(catchCategory("payload", (error) => ix.update({ content: `checklist: ${error._tag}` })))
  )

  const onVerdict = Interactions.component(verdict, (ix) =>
    Effect.gen(function* () {
      yield* Ref.update(verdicts, (all) => new Map(all).set(ix.data.item, ix.data.ok))
      yield* Effect.log(`checklist: ${ix.data.item} ${ix.data.ok ? "as expected" : "NOT as expected"}`)
      return yield* ix.update({ content: `${ix.data.item}: recorded ${ix.data.ok ? "as expected" : "not as expected"}`, components: [] })
    })
  )

  const onForm = Interactions.modal(form, "ephemeral", (ix) =>
    Effect.gen(function* () {
      const components = yield* verdictsFor("modal")
      return yield* ix.reply({ content: `you wrote: ${ix.fields.get("text") ?? "(nothing)"}`.slice(0, 2000), ephemeral: true, components })
    }).pipe(catchCategory("payload", () => ix.reply({ content: "checklist: the reply did not fit", ephemeral: true })))
  )

  // registered only so the old control's prefix is routed: its ID never decodes under this schema
  const onOld = Interactions.component(currentControl, "ephemeral", (ix) => ix.reply({ content: `unexpected: version ${ix.data.version} decoded`, ephemeral: true }))

  return {
    verdicts: Ref.get(verdicts),
    register: Effect.all([onCommand, onSearch, onManual, onPublic, onEphemeral, onUpdate, onVerdict, onForm, onOld], { discard: true })
  }
})
