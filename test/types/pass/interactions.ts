// Valid interaction handlers (DESIGN §2.10; [sd:src/interactions-use.ts]): every Interactions.* entry, in both
// spellings (an arrow and an Effect.fn handler), with exact types.
import { Context, Effect, Schema, type Scope } from "effect"
import { expectTypeOf } from "vitest"
import type { BotRuntime } from "../../../src/bot/Runtime.ts"
import type { AnnouncementChannel, MessageChannel, TextChannel } from "../../../src/channels/Channel.ts"
import { Command, type ResolvedUser } from "../../../src/commands/Command.ts"
import { ComponentRoute } from "../../../src/components/CustomId.ts"
import { catchCategory } from "../../../src/errors/Category.ts"
import type { ContentTooLong, CustomIdTooLong, MessageEmpty } from "../../../src/errors/Payload.ts"
import type {
  AutocompleteInteraction,
  CommandInteraction,
  Completed,
  ManualCommandInteraction,
  ManualComponentInteraction,
  ModalSubmitInteraction,
  ReplyComponentInteraction,
  Response,
  UpdateComponentInteraction
} from "../../../src/interactions/Interaction.ts"
import { Interactions } from "../../../src/interactions/Runner.ts"
import type { GuildId, UserId } from "../../../src/Snowflake.ts"

const ban = Command.chatInput({
  name: "ban",
  description: "Ban a member",
  options: [
    { type: "user", name: "user", description: "who", required: true },
    { type: "string", name: "reason", description: "why", choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] },
    { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] },
    { type: "integer", name: "days", description: "history", autocomplete: true }
  ]
})
type BanInvocation = { readonly options: { readonly user: ResolvedUser; readonly reason?: "spam" | "abuse"; readonly log?: TextChannel | AnnouncementChannel; readonly days?: number } }
const vote = ComponentRoute.make("vote", Schema.Struct({ poll: Schema.Int, choice: Schema.Literals(["yes", "no"]) }))
type Vote = { readonly poll: number; readonly choice: "yes" | "no" }
type Registered = Effect.Effect<void, never, BotRuntime | Scope.Scope>
declare const dynamic: string

// building a custom_id surfaces the 100-character limit as a typed payload error
export const id = vote.customId({ poll: 1, choice: "yes" })
expectTypeOf<Effect.Error<typeof id>>().toEqualTypeOf<CustomIdTooLong>()

// 1. reply, then follow up: follow-ups exist only inside the continuation; reply is an Effect (validated locally)
export const c1 = Interactions.command(ban, (ix) => {
  expectTypeOf(ix).toEqualTypeOf<CommandInteraction<BanInvocation, "public">>()
  expectTypeOf(ix.guildId).toEqualTypeOf<GuildId>()
  expectTypeOf(ix.user).toEqualTypeOf<{ readonly id: UserId }>()
  expectTypeOf(ix.channel).toEqualTypeOf<MessageChannel>()
  return ix
    .reply({ content: `banning ${ix.invocation.options.user.id}` }, (answered) => answered.followUp({ content: "done", ephemeral: true }).pipe(catchCategory(["permission", "state"], () => Effect.void)))
    .pipe(catchCategory("payload", () => ix.reply({ content: "Could not describe that ban." })))
})
expectTypeOf(c1).toEqualTypeOf<Registered>()

// a literal reply cannot fail; a dynamic one may be too long or empty
declare const ixPublic: CommandInteraction<{ readonly options: {} }, "public">
export const literal = ixPublic.reply({ content: "hi" })
expectTypeOf<Effect.Error<typeof literal>>().toEqualTypeOf<never>()
expectTypeOf<Effect.Success<typeof literal>>().toEqualTypeOf<Response<never>>()
export const dyn = ixPublic.reply({ content: dynamic })
expectTypeOf<Effect.Error<typeof dyn>>().toEqualTypeOf<ContentTooLong | MessageEmpty>()

// 2. defer, then complete with editOriginal, giving up honestly if the token expired (no Effect.die)
export const c2 = Interactions.command(ban, "ephemeral", (ix) =>
  ix.defer({ ephemeral: true }, (deferred) => deferred.editOriginal({ content: "ok" }).pipe(Effect.catchTag("InteractionExpired", deferred.giveUp)))
)
expectTypeOf(c2).toEqualTypeOf<Registered>()
declare const answered: Parameters<Parameters<typeof ixPublic.defer>[1]>[0]
expectTypeOf(answered.editOriginal({ content: "ok" })).toEqualTypeOf<Effect.Effect<Completed, import("../../../src/errors/State.ts").InteractionExpired | import("../../../src/errors/Transient.ts").Transient>>()

// 3. modals only with auto-defer off ("manual"); Effect.fn handlers keep `ix` typed
export const c3 = Interactions.command(
  ban,
  "manual",
  Effect.fn("ban.modal")(function* (ix) {
    expectTypeOf(ix).toEqualTypeOf<ManualCommandInteraction<BanInvocation>>()
    const modalId = yield* vote.customId({ poll: 2, choice: "no" }).pipe(catchCategory("payload", () => Effect.succeed(undefined)))
    if (modalId === undefined) return yield* ix.reply({ content: "Could not open the form." })
    return yield* ix.showModal({ customId: modalId, title: "Why?", inputs: [{ customId: "reason", label: "Reason", style: "paragraph" }] })
  })
)
expectTypeOf(c3).toEqualTypeOf<Registered>()
export const c4 = Interactions.command(
  ban,
  Effect.fn("ban")(function* (ix) {
    return yield* ix.reply({ content: "hi" })
  })
)
expectTypeOf(c4).toEqualTypeOf<Registered>()
export const c5 = Interactions.command(
  ban,
  "ephemeral",
  Effect.fn("ban.ephemeral")(function* (ix) {
    expectTypeOf(ix).toEqualTypeOf<CommandInteraction<BanInvocation, "ephemeral">>()
    return yield* ix.reply({ content: "only you can see this", ephemeral: true })
  })
)
expectTypeOf(c5).toEqualTypeOf<Registered>()

// 4. a component handler receives decoded data; the default mode "update" offers update
export const k1 = Interactions.component(vote, (ix) => {
  expectTypeOf(ix).toEqualTypeOf<UpdateComponentInteraction<Vote>>()
  return ix.update({ content: `you chose ${ix.data.choice}, ${dynamic}`, components: [] }).pipe(catchCategory("payload", () => ix.update({ content: "vote recorded" })))
})
expectTypeOf(k1).toEqualTypeOf<Registered>()
export const k2 = Interactions.component(
  vote,
  "ephemeral",
  Effect.fn("vote")(function* (ix) {
    expectTypeOf(ix).toEqualTypeOf<ReplyComponentInteraction<Vote, "ephemeral">>()
    return yield* ix.reply({ content: `You voted ${ix.data.choice}.` })
  })
)
expectTypeOf(k2).toEqualTypeOf<Registered>()
export const k3 = Interactions.component(vote, "update", (ix) => ix.deferUpdate((deferred) => deferred.editOriginal({ content: "counted" }).pipe(Effect.catchTag("InteractionExpired", deferred.giveUp))))
expectTypeOf(k3).toEqualTypeOf<Registered>()
export const k4 = Interactions.component(
  vote,
  "manual",
  Effect.fn("vote.manual")(function* (ix) {
    expectTypeOf(ix).toEqualTypeOf<ManualComponentInteraction<Vote>>()
    return ix.data.choice === "yes" ? yield* ix.update({ content: "yes" }) : yield* ix.showModal({ customId: yield* vote.customId(ix.data).pipe(Effect.orDie), title: "Why not?", inputs: [{ customId: "why", label: "Why", style: "short" }] })
  })
)
expectTypeOf(k4).toEqualTypeOf<Registered>()

// 5. modal and autocomplete, both spellings
export const m1 = Interactions.modal(vote, (ix) => {
  expectTypeOf(ix).toEqualTypeOf<ModalSubmitInteraction<Vote, "public">>()
  expectTypeOf(ix.fields).toEqualTypeOf<ReadonlyMap<string, string>>()
  return ix.reply({ content: "thanks" })
})
expectTypeOf(m1).toEqualTypeOf<Registered>()
export const m2 = Interactions.modal(
  vote,
  "ephemeral",
  Effect.fn("modal")(function* (ix) {
    return yield* ix.reply({ content: "thanks", ephemeral: true })
  })
)
expectTypeOf(m2).toEqualTypeOf<Registered>()
export const a1 = Interactions.autocomplete(ban, (ix) => {
  expectTypeOf(ix).toEqualTypeOf<AutocompleteInteraction<string | number>>()
  return ix.choices([{ name: ix.focused.value, value: 1 }])
})
expectTypeOf(a1).toEqualTypeOf<Registered>()
export const a2 = Interactions.autocomplete(
  ban,
  Effect.fn("ac")(function* (ix) {
    return yield* ix.choices([])
  })
)
expectTypeOf(a2).toEqualTypeOf<Registered>()

// 6. the interaction context: the invoking channel is a handle (basis app-permissions); its errors must be handled
export const ctx = Interactions.command(ban, (ix) =>
  ix.channel.send({ content: "working on it" }).pipe(
    Effect.andThen(ix.reply({ content: `done in ${ix.guildId}` })),
    catchCategory(["permission", "state", "payload", "access"], () => ix.reply({ content: "I cannot post here." }))
  )
)
expectTypeOf(ctx).toEqualTypeOf<Registered>()

// 7. a continuation's services are the registration's requirement
class Audit extends Context.Service<Audit, { readonly record: (what: string) => Effect.Effect<void> }>()("test/Audit") {}
export const svc = Interactions.command(ban, (ix) => ix.reply({ content: "noted" }, () => Effect.flatMap(Effect.service(Audit), (audit) => audit.record("ban"))))
expectTypeOf(svc).toEqualTypeOf<Effect.Effect<void, never, BotRuntime | Scope.Scope | Audit>>()
