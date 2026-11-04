// custom_id routes (DESIGN §2.9): a route name has no ':' (the separator), an ID's CustomIdTooLong must be handled,
// and the data a route decodes is typed by its schema.
import { Effect, Option, Schema } from "effect"
import { Bot } from "../../../src/bot/Bot.ts"
import { ComponentRoute } from "../../../src/components/CustomId.ts"
import { catchCategory } from "../../../src/errors/Category.ts"
import { row } from "../../../src/payload/Components.ts"

const vote = ComponentRoute.make("vote", Schema.Struct({ choice: Schema.Literals(["yes", "no"]) }))
const bot = Bot.make({ intents: ["Guilds", "GuildMessages"] })
declare const received: string

// @valid
export const ok = [
  ComponentRoute.make("lab-route", Schema.Struct({})),
  bot.on("MESSAGE_CREATE", (event) =>
    vote.customId({ choice: "no" }).pipe(
      Effect.flatMap((customId) => event.channel.send({ content: "Vote", components: [row([{ kind: "button", style: "danger", label: "No", customId }])] })),
      catchCategory(["payload", "permission", "state"], () => Effect.void)
    )
  ),
  Option.map(vote.decode(received), (data) => data.choice === "yes")
]

// @expect-error TS2345 route names cannot contain ':'
export const colon = ComponentRoute.make("vote:2", Schema.Struct({}))
// @expect-error TS2741 UnhandledErrors<"payload">
export const leak = bot.on("MESSAGE_CREATE", () => vote.customId({ choice: "yes" }))
// @expect-error TS2322 Type '"maybe"' is not assignable
export const wrongData = vote.customId({ choice: "maybe" })
// @expect-error TS2367 have no overlap
export const decoded = Option.map(vote.decode(received), (data) => data.choice === "maybe")
