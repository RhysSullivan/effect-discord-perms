// Intents, message content and the handler boundary (DESIGN §2.7; [sd:src/fail/bot.ts]): an event the declared
// intents do not deliver names the intents that would, content is not a string until `contentDelivered` says so,
// and a handler that leaves a non-transient or uncategorised error unhandled names what to handle.
import { Effect, Schema } from "effect"
import { Bot } from "../../../src/bot/Bot.ts"
import type { MessageChannel } from "../../../src/channels/Channel.ts"
import { type Categorized, catchCategory, withCategory } from "../../../src/errors/Category.ts"
import type { Intent } from "../../../src/gateway/Intents.ts"
import type { CreateMessage } from "../../../src/payload/Message.ts"

const bot = Bot.make({ intents: ["Guilds", "GuildMessages"] })
const quiet = Bot.make({ intents: [] })
class Oops extends Schema.TaggedError<Oops>()("Oops", {}) {}
class Flaky extends Schema.TaggedError<Flaky>()("Flaky", {}).pipe(withCategory("transient", "state")) {}
declare const render: () => CreateMessage
// an error type widened to a categorised supertype carries no category the boundary can read (after the final audit)
const widened = (channel: MessageChannel): Effect.Effect<unknown, Categorized<never>> => channel.send({ content: "pong" })
const widenedAll = (channel: MessageChannel): Effect.Effect<unknown, Categorized<string>> => channel.send({ content: "pong" })
// intents known only at run time (after the final audit): the types read the declared intents off the list's type
declare const fromConfig: ReadonlyArray<Intent>

// @valid
export const ok = [
  bot.on("MESSAGE_CREATE", (event) => event.channel.send(render()).pipe(catchCategory(["permission", "state", "payload"], () => Effect.void))),
  bot.on("MESSAGE_CREATE", (event) => (event.message.contentDelivered ? Effect.log(event.message.content.toUpperCase()) : Effect.void)),
  bot.on("CHANNEL_UPDATE", (event) => Effect.log(event.channel.id)),
  quiet.on("READY", (event) => Effect.log(event.userId)),
  Bot.make({ intents: ["Guilds", "GuildMembers"] as const }).on("GUILD_MEMBER_UPDATE", (event) => Effect.log(event.userId))
]

// @expect-error TS2345 GuildMembers
export const memberUpdate = bot.on("GUILD_MEMBER_UPDATE", (event) => Effect.log(event.userId))
// @expect-error TS2345 GuildMessageReactions
export const reaction = bot.on("MESSAGE_REACTION_ADD", (event) => Effect.log(event.messageId))
// @expect-error TS2345 GuildMessageTyping
export const typing = bot.on("TYPING_START", (event) => Effect.log(event.userId))
// @expect-error TS2345 GuildMessages
export const message = quiet.on("MESSAGE_CREATE", () => Effect.void)
// @expect-error TS2345 Guilds
export const channelUpdate = quiet.on("CHANNEL_UPDATE", () => Effect.void)
// @expect-error TS2339 ContentUnavailable
export const content = bot.on("MESSAGE_CREATE", (event) => Effect.log(event.message.content.toUpperCase()))
// @expect-error TS2741 permission
export const access = bot.on("MESSAGE_CREATE", (event) => event.channel.send({ content: "pong" }).pipe(catchCategory("state", () => Effect.void)))
// @expect-error TS2741 state
export const state = bot.on("MESSAGE_CREATE", (event) => event.channel.send({ content: "pong" }).pipe(catchCategory("permission", () => Effect.void)))
// @expect-error TS2741 Oops
export const oops = bot.on("CHANNEL_UPDATE", () => Effect.fail(new Oops()))
// @expect-error TS2345 permission
export const fn = bot.on(
  "MESSAGE_CREATE",
  Effect.fn("onMessage")(function* (event) {
    yield* event.channel.send({ content: "x", embeds: [{ title: "t" }] }).pipe(catchCategory("state", () => Effect.void))
  })
)
// @expect-error TS2741 UnhandledErrors<"state">
export const flaky = bot.on("CHANNEL_UPDATE", () => Effect.fail(new Flaky()))
// @expect-error TS2741 payload
export const payload = bot.on("MESSAGE_CREATE", (event) => event.channel.send(render()))
// @expect-error TS2741 a widened categorised type
export const widenedNever = bot.on("MESSAGE_CREATE", (event) => widened(event.channel))
// @expect-error TS2741 a widened categorised type
export const widenedString = bot.on("MESSAGE_CREATE", (event) => widenedAll(event.channel))
// @expect-error TS2322 MustReturnEffect
export const plainValue = bot.on("READY", () => 42)
// @expect-error TS2345 a handler must return an Effect
export const promise = bot.on("READY", async () => {})
// @expect-error TS2322 intents must be written as a literal list
export const configured = Bot.make({ intents: fromConfig })
