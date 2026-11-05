// The interaction state machine (DESIGN §2.10; [sd:src/fail/interactions.ts]): every rule fails with a one-line
// diagnostic that names it, in the arrow and the Effect.fn spelling.
import { Effect, Schema } from "effect"
import { Command } from "../../../src/commands/Command.ts"
import { ComponentRoute } from "../../../src/components/CustomId.ts"
import { Interactions } from "../../../src/interactions/Runner.ts"

const ban = Command.chatInput({ name: "ban", description: "Ban a member", options: [{ type: "user", name: "user", description: "who", required: true }] })
const vote = ComponentRoute.make("vote", Schema.Struct({ poll: Schema.Int, choice: Schema.Literals(["yes", "no"]) }))
declare const dynamic: string

// @valid
export const ok = Interactions.command(ban, (ix) => ix.reply({ content: "hi" }, (answered) => answered.followUp({ content: "done" }).pipe(Effect.orDie)))

// ---- showModal only before answering, with auto-defer off; ix stays typed under Effect.fn ----
// @expect-error TS2339 showModal
export const m1 = Interactions.command(ban, (ix) => ix.showModal({ customId: ix.invocation.options.user.id, title: "t", inputs: [{ customId: "a", label: "A", style: "short" }] }))
// @expect-error TS2339 showModal
export const m1fn = Interactions.command(ban, "ephemeral", Effect.fn("x")(function* (ix) { const open = ix.showModal; return yield* ix.reply({ content: "hi" }) }))
// @expect-error TS2339 thisDoesNotExist
export const x1 = Interactions.command(ban, Effect.fn("x")(function* (ix) { ix.thisDoesNotExist(); return yield* ix.reply({ content: "hi" }) }))

// ---- no modal from a modal submit ----
// @expect-error TS2339 ModalSubmitInteraction
export const m2 = Interactions.modal(vote, (ix) => ix.showModal({ customId: ix.data.choice, title: "t", inputs: [{ customId: "a", label: "A", style: "short" }] }))

// ---- follow-ups only after answering ----
// @expect-error TS2339 followUp
export const f1 = Interactions.command(ban, (ix) => ix.followUp({ content: "too early" }))

// ---- autocomplete answers only with choices ----
// @expect-error TS2339 AutocompleteInteraction
export const a1 = Interactions.autocomplete(ban, (ix) => ix.reply({ content: "no" }))

// ---- handlers must return a response, which only the interaction's methods make ----
// @expect-error TS2741 must return
export const r1 = Interactions.command(ban, () => Effect.void)
// @expect-error TS2741 must return
export const r2 = Interactions.command(ban, () => Effect.succeed({ _tag: "Response" as const, kind: "reply" as const }))

// ---- a deferral must be completed, with editOriginal or giveUp ----
// @expect-error TS2741 editOriginal
export const d1 = Interactions.command(ban, "ephemeral", (ix) => ix.defer({ ephemeral: true }, () => Effect.void))
// @expect-error TS2741 editOriginal
export const d2 = Interactions.component(vote, (ix) => ix.deferUpdate(() => Effect.succeed({ completed: true })))

// ---- a reply or follow-up needs a body; a dynamic one's limits must be handled ----
// @expect-error TS2741 a message needs
export const e1 = Interactions.command(ban, (ix) => ix.reply({}).pipe(Effect.orDie))
// @expect-error TS2741 a message needs
export const e2 = Interactions.command(ban, (ix) => ix.reply({ content: "hi" }, (answered) => answered.followUp({}).pipe(Effect.orDie)))
// @expect-error TS2741 UnhandledErrors<"payload">
export const e4 = Interactions.command(ban, (ix) => ix.reply({ content: dynamic }))

// ---- the mode fixes the response: ephemeral matches it, and "update" offers only update and deferUpdate ----
// @expect-error TS2322 ephemeral must match the registration mode public
export const e3 = Interactions.command(ban, (ix) => ix.reply({ content: "hi", ephemeral: true }))
// @expect-error TS2322 Type 'true' is not assignable to type 'false'
export const e5 = Interactions.command(ban, (ix) => ix.defer({ ephemeral: true }, (deferred) => deferred.editOriginal({ content: "x" }).pipe(Effect.catchTag("InteractionExpired", deferred.giveUp))))
// @expect-error TS2339 Property 'reply' does not exist on type 'UpdateComponentInteraction
export const u1 = Interactions.component(vote, (ix) => ix.reply({ content: "a new message" }))
