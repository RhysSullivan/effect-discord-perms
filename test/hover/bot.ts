// Hover markers for events and registrations (DESIGN §2.7, §5.3; rule 1 of §2.12): a received message and its
// channel hover as the library's named types, and a registration as an Effect that fails with nothing.
import { Effect } from "effect"
import { Bot } from "../../src/bot/Bot.ts"
import { catchCategory } from "../../src/errors/Category.ts"

const bot = Bot.make({ intents: ["Guilds", "GuildMessages"] })

export const onMessage = bot.on("MESSAGE_CREATE", (event) => {
  const message = event.message
  //    ^? names: ReceivedMessage
  const channel = event.channel
  //    ^? names: MessageChannel
  return message.contentDelivered && message.content === "!ping"
    ? channel.send({ content: "pong" }).pipe(catchCategory(["permission", "state"], () => Effect.void))
    : Effect.void
})

export const registration = bot.on("CHANNEL_UPDATE", (event) => Effect.log(event.channel.id))
//           ^? names: Effect.Effect, BotRuntime, Scope; no-object
