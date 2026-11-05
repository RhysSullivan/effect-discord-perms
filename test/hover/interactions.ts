// Hover markers for interactions (DESIGN §2.10, §5.3; T11): `ix` hovers as its named interaction type with the
// command's invocation, never the option tuple, and a registration as the Effect it is.
import { Effect } from "effect"
import { Command } from "../../src/commands/Command.ts"
import { Interactions } from "../../src/interactions/Runner.ts"

const ban = Command.chatInput({
  name: "ban",
  description: "Ban a member",
  options: [
    { type: "user", name: "user", description: "who", required: true },
    { type: "string", name: "reason", description: "why", choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] }
  ]
})
export const onBan = Interactions.command(ban, "ephemeral", (ix) => {
  const interaction = ix
  //    ^? names: CommandInteraction, ResolvedUser
  return interaction.reply({ content: "noted", ephemeral: true })
})
export const registered = onBan
//           ^? names: Effect, BotRuntime, Scope
export const deferred = Interactions.command(ban, (ix) =>
  ix.defer({ ephemeral: false }, (answered) => {
    const later = answered
    //    ^? names: Answered
    return later.editOriginal({ content: "done" }).pipe(Effect.catchTag("InteractionExpired", later.giveUp))
  })
)
