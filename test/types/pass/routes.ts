// custom_id routes (DESIGN §2.9): a route builds IDs from schema-typed data, checked against 100 characters when
// built (CustomIdTooLong, a payload error), and decodes them back to the same type.
import { Effect, type Option, Schema } from "effect"
import { expectTypeOf } from "vitest"
import { ComponentRoute } from "../../../src/components/CustomId.ts"
import type { CustomIdTooLong } from "../../../src/errors/Payload.ts"
import type { Categories } from "../../../src/errors/Category.ts"
import type { CustomId } from "../../../src/payload/Components.ts"
import { Bot } from "../../../src/bot/Bot.ts"
import { catchCategory } from "../../../src/errors/Category.ts"
import { row } from "../../../src/payload/Components.ts"

const vote = ComponentRoute.make("vote", Schema.Struct({ choice: Schema.Literals(["yes", "no"]), poll: Schema.Int }))
expectTypeOf(vote.name).toEqualTypeOf<"vote">()
expectTypeOf(vote.customId).toEqualTypeOf<(data: { readonly choice: "yes" | "no"; readonly poll: number }) => Effect.Effect<CustomId, CustomIdTooLong>>()
expectTypeOf(vote.decode).toEqualTypeOf<(customId: string) => Option.Option<{ readonly choice: "yes" | "no"; readonly poll: number }>>()
// CustomIdTooLong is a payload error
expectTypeOf<Categories<CustomIdTooLong>>().toEqualTypeOf<"payload">()

// any schema without services: dates, bigints and sets round-trip through the canonical JSON codec
const dated = ComponentRoute.make("dated", Schema.Struct({ at: Schema.Date, n: Schema.BigInt, ids: Schema.ReadonlySet(Schema.String) }))
expectTypeOf(dated.decode).toEqualTypeOf<(customId: string) => Option.Option<{ readonly at: Date; readonly n: bigint; readonly ids: ReadonlySet<string> }>>()

// a handler that builds an ID and sends it handles CustomIdTooLong with the payload category
const bot = Bot.make({ intents: ["Guilds", "GuildMessages"] })
export const onMessage = bot.on("MESSAGE_CREATE", (event) =>
  vote.customId({ choice: "yes", poll: 1 }).pipe(
    Effect.flatMap((customId) => event.channel.send({ content: "Vote", components: [row([{ kind: "button", style: "success", label: "Yes", customId }])] })),
    catchCategory(["payload", "permission", "state"], () => Effect.void)
  )
)
