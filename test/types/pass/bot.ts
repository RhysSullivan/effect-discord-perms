// Bot, intents, events, message content and the handler boundary (DESIGN §2.7; [sd:src/bot-use.ts]): every shape
// that must compile, with exact inferred types.
import { Discord } from "dfx"
import { Config, Context, Effect, type Layer, type Scope, Schema } from "effect"
import type * as HttpClient from "effect/http/HttpClient"
import type * as Socket from "effect/socket/Socket"
import { expectTypeOf } from "vitest"
import { Bot, type BotRuntime } from "../../../src/bot/Bot.ts"
import type { Handled, UnhandledErrors } from "../../../src/bot/Handler.ts"
import type { StartupFailed } from "../../../src/bot/Startup.ts"
import type { DMChannel, GuildChannel, GuildMessageKind, MessageChannel } from "../../../src/channels/Channel.ts"
import type { OwnMessages } from "../../../src/channels/Message.ts"
import { isMessageChannel } from "../../../src/channels/Channel.ts"
import { type Categorized, catchCategory, withCategory } from "../../../src/errors/Category.ts"
import type { DiscordUnavailable } from "../../../src/errors/Transient.ts"
import type { ContentUnavailable, DirectMessageCreate, GuildMessageCreate, ReactionEmoji } from "../../../src/gateway/Events.ts"
import { type EventIntents, type Intent, Intents } from "../../../src/gateway/Intents.ts"
import type { OpErrors } from "../../../src/permissions/Operations.ts"
import type { GuildId, MessageId, UserId } from "../../../src/Snowflake.ts"

const withContent = Bot.make({ intents: ["Guilds", "GuildMessages", "MessageContent"] })
const noContent = Bot.make({ intents: ["Guilds", "GuildMessages"] })
const withDMs = Bot.make({ intents: ["Guilds", "GuildMessages", "DirectMessages"] })

// the declared intents are exactly the literal list's (round 2: the check on each element keeps the inference)
expectTypeOf(noContent.intents).toEqualTypeOf<ReadonlyArray<"Guilds" | "GuildMessages">>()
expectTypeOf(Bot.make({ intents: [] }).intents).toEqualTypeOf<ReadonlyArray<never>>()
expectTypeOf(Bot.make({ intents: ["Guilds", "GuildMembers"] as const }).intents).toEqualTypeOf<ReadonlyArray<"Guilds" | "GuildMembers">>()

// the intent names are exactly dfx's (and Discord's)
expectTypeOf<Intent>().toEqualTypeOf<keyof typeof Discord.GatewayIntentBits>()
expectTypeOf(Intents).toEqualTypeOf<typeof Intents>()
// READY needs no intent; the others name theirs
expectTypeOf<EventIntents["READY"]>().toEqualTypeOf<never>()
expectTypeOf<EventIntents["GUILD_MEMBER_UPDATE"]>().toEqualTypeOf<"GuildMembers">()
expectTypeOf<EventIntents["MESSAGE_CREATE"]>().toEqualTypeOf<"GuildMessages" | "DirectMessages">()

// 1. with MessageContent, content is a string; send on the union receiver is one Effect, caught by category
export const r1 = withContent.on("MESSAGE_CREATE", (event) =>
  event.message.content === "!ping" ? event.channel.send({ content: "pong" }).pipe(catchCategory(["permission", "state"], () => Effect.void)) : Effect.void
)
expectTypeOf(r1).toEqualTypeOf<Effect.Effect<void, never, BotRuntime | Scope.Scope>>()

// 2. without it, content is ContentUnavailable until contentDelivered narrows it (own, a mention, a ping-on reply)
export const r2 = noContent.on("MESSAGE_CREATE", (event) => {
  const m = event.message
  if (!m.contentDelivered) {
    expectTypeOf(m.content).toEqualTypeOf<ContentUnavailable>()
    return Effect.void
  }
  expectTypeOf(m.content).toEqualTypeOf<string>()
  return Effect.log(m.content.toUpperCase())
})
expectTypeOf(r2).toEqualTypeOf<Effect.Effect<void, never, BotRuntime | Scope.Scope>>()

// 3. an Effect.fn handler with a service requirement: R is inferred exactly
class Store extends Context.Service<Store, { readonly save: (s: string) => Effect.Effect<void> }>()("x/Store") {}
export const r3 = withContent.on(
  "MESSAGE_CREATE",
  Effect.fn("onMessage")(function* (event) {
    const store = yield* Store
    yield* store.save(event.message.id)
  })
)
expectTypeOf(r3).toEqualTypeOf<Effect.Effect<void, never, Store | BotRuntime | Scope.Scope>>()

// 4. an explicit opt-out is greppable; CHANNEL_UPDATE hands any guild channel, narrowed to send
export const r4 = noContent.on("CHANNEL_UPDATE", (event) => {
  expectTypeOf(event.channel).toEqualTypeOf<GuildChannel>()
  return isMessageChannel(event.channel) ? event.channel.send({ content: "updated" }).pipe(Effect.orDie) : Effect.void
})

// 5. READY needs no intent
export const r5 = Bot.make({ intents: [] }).on("READY", (event) => Effect.log(event.userId))
expectTypeOf(r5).toEqualTypeOf<Effect.Effect<void, never, BotRuntime | Scope.Scope>>()

// 6. received messages are a union by kind and author: narrowing reaches crosspost, and authorIsBot lets a bot ignore bots
export const r6 = withContent.on("MESSAGE_CREATE", (event) => {
  const m = event.message
  if (m.author === "other" && m.authorIsBot) return Effect.void
  if (m.channelKind !== "announcement" || m.author !== "other") return Effect.void
  return m.crosspost().pipe(catchCategory(["permission", "state"], () => Effect.void))
})

// 7. DMs exist only with DirectMessages; the DM branch has content as a string, a DM channel and no guild
export const r7 = withDMs.on("MESSAGE_CREATE", (event) => {
  if (event.guildId !== undefined) return Effect.void
  expectTypeOf(event).toEqualTypeOf<DirectMessageCreate>()
  expectTypeOf(event.message.content).toEqualTypeOf<string>()
  expectTypeOf(event.channel).toEqualTypeOf<DMChannel>()
  return event.channel.send({ content: "hi" }).pipe(catchCategory("state", () => Effect.void))
})
// without DirectMessages there is no DM branch, and the guild branch follows MessageContent
export const r8 = withContent.on("MESSAGE_CREATE", (event) => {
  expectTypeOf(event).toEqualTypeOf<GuildMessageCreate<true>>()
  expectTypeOf(event.guildId).toEqualTypeOf<GuildId>()
  expectTypeOf(event.channel).toEqualTypeOf<MessageChannel>()
  return Effect.void
})
export const r8b = noContent.on("MESSAGE_CREATE", (event) => {
  expectTypeOf(event).toEqualTypeOf<GuildMessageCreate<false>>()
  return Effect.void
})

// 9. event IDs are branded; a reaction's emoji is unicode or custom
export const r9 = Bot.make({ intents: ["GuildMessageReactions"] }).on("MESSAGE_REACTION_ADD", (event) => {
  expectTypeOf(event.messageId).toEqualTypeOf<MessageId>()
  expectTypeOf(event.userId).toEqualTypeOf<UserId>()
  expectTypeOf(event.emoji).toEqualTypeOf<ReactionEmoji>()
  return Effect.log(event.emoji.origin === "unicode" ? event.emoji.name : event.emoji.id)
})

// 10. D6 as researched: an error that is transient AND state must be handled; a purely transient one may escape
class Flaky extends Schema.TaggedError<Flaky>()("Flaky", {}).pipe(withCategory("transient", "state")) {}
class Oops extends Schema.TaggedError<Oops>()("Oops", {}) {}
expectTypeOf<Handled<void, Flaky, never>>().toEqualTypeOf<UnhandledErrors<"state">>()
expectTypeOf<Handled<void, DiscordUnavailable, never>>().toEqualTypeOf<Effect.Effect<void, DiscordUnavailable, never>>()
expectTypeOf<Handled<void, Oops | DiscordUnavailable, never>>().toEqualTypeOf<UnhandledErrors<"Oops">>()
// round 2: the transient marker alone, or a string tag, may stand for Flaky, so it must be handled; a concrete purely
// transient class of the user's may escape
class Blip extends Schema.TaggedError<Blip>()("Blip", {}).pipe(withCategory("transient")) {}
expectTypeOf<Handled<void, Categorized<"transient">, never>>().toEqualTypeOf<UnhandledErrors<"a widened categorised type (keep each error's own class)">>()
expectTypeOf<Handled<void, Categorized<"transient"> & { readonly _tag: string }, never>>().toEqualTypeOf<
  UnhandledErrors<"a widened categorised type (keep each error's own class)">
>()
expectTypeOf<Handled<void, Blip | DiscordUnavailable, never>>().toEqualTypeOf<Effect.Effect<void, Blip | DiscordUnavailable, never>>()
// a handler that leaves only a transient error compiles, and the registration keeps no error
export const r10 = noContent.on("MESSAGE_CREATE", (event) =>
  event.channel.send({ content: "pong" }).pipe(catchCategory(["permission", "access", "state"], () => Effect.void))
)
expectTypeOf(r10).toEqualTypeOf<Effect.Effect<void, never, BotRuntime | Scope.Scope>>()

// 11. the layers (§4.2): `layerWith` leaves the platform open, `layer` needs nothing
const config = { token: Config.Redacted("DISCORD_SUBJECT_TOKEN") }
expectTypeOf(Bot.layerWith(withContent, config)).toEqualTypeOf<Layer.Layer<BotRuntime, StartupFailed | Config.ConfigError, HttpClient.HttpClient | Socket.WebSocketConstructor>>()
expectTypeOf(Bot.layer(withContent, config)).toEqualTypeOf<Layer.Layer<BotRuntime, StartupFailed | Config.ConfigError, never>>()

// 12. every message method is one method type with a generic `this` (after the final audit), so a call on a received
// message of a union kind is one Effect a combinator pipes onto, its errors the union of the kinds' rows
declare const received: GuildMessageCreate<true>["message"]
if (received.author === "self") {
  const deleted = received.delete()
  expectTypeOf<Effect.Error<typeof deleted>>().toEqualTypeOf<OpErrors<never>["message.deleteOwn" | "message.deleteOwn.thread" | "message.deleteOwn.voice"]>()
  const edited = received.edit({ content: "x" })
  expectTypeOf<Effect.Error<typeof edited>>().toEqualTypeOf<OpErrors<never>["message.edit.channel" | "message.edit.thread" | "message.edit.voice"]>()
  expectTypeOf<Effect.Success<typeof edited>>().toEqualTypeOf<OwnMessages<GuildMessageKind>>()
} else {
  const deleted = received.delete()
  expectTypeOf<Effect.Error<typeof deleted>>().toEqualTypeOf<OpErrors<never>["message.deleteForeign" | "message.deleteForeign.thread" | "message.deleteForeign.voice"]>()
}
const reacted = received.react({ origin: "unicode", name: "x" })
expectTypeOf<Effect.Error<typeof reacted>>().toEqualTypeOf<OpErrors<never>["message.react.channel" | "message.react.thread" | "message.react.voice"]>()
export const r12 = [
  withContent.on("MESSAGE_CREATE", (event) =>
    event.message.author === "self" ? event.message.delete().pipe(catchCategory(["permission", "state"], () => Effect.void)) : Effect.void
  ),
  withContent.on("MESSAGE_CREATE", (event) =>
    event.message.author === "other" ? event.message.delete().pipe(catchCategory(["permission", "state"], () => Effect.void)) : Effect.void
  ),
  withContent.on("MESSAGE_CREATE", (event) =>
    event.message.author === "self" ? event.message.edit({ content: "x" }).pipe(catchCategory(["permission", "state"], () => Effect.void)) : Effect.void
  ),
  withContent.on("MESSAGE_CREATE", (event) => event.message.react({ origin: "unicode", name: "x" }).pipe(catchCategory(["permission", "state"], () => Effect.void))),
  withContent.on("MESSAGE_CREATE", (event) => catchCategory(event.message.delete(), ["permission", "state"], () => Effect.void)),
  withContent.on("MESSAGE_CREATE", (event) => event.message.react({ origin: "unicode", name: "x" }).pipe(Effect.catch(() => Effect.void))),
  withContent.on("MESSAGE_CREATE", (event) => Effect.suspend(() => event.message.delete()).pipe(catchCategory(["permission", "state"], () => Effect.void))),
  withContent.on("MESSAGE_CREATE", (event) =>
    event.channel.send({ content: "x" }).pipe(
      Effect.flatMap((sent) => sent.message.delete()),
      catchCategory(["permission", "state"], () => Effect.void)
    )
  ),
  withContent.on("MESSAGE_CREATE", (event) =>
    event.message.channelKind === "announcement" ? event.message.crosspost().pipe(catchCategory(["permission", "state"], () => Effect.void)) : Effect.void
  )
]
expectTypeOf(r12).toEqualTypeOf<Array<Effect.Effect<void, never, BotRuntime | Scope.Scope>>>()
