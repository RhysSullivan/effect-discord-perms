// Hover markers for the reference bot (DESIGN §2.11, §5.3, §6 M10; examples/reference-bot/bot.ts): what its author
// sees in the editor. The command hovers as its invocation, each registration and the running bot as the Effect or
// Layer they are, with named types only.
import { layer, onPoll, onVote, poll } from "../../examples/reference-bot/bot.ts"
import { Main } from "../../examples/reference-bot/main.ts"

export const command = poll
//           ^? names: ChatInputCommand, TextChannel, AnnouncementChannel
export const registration = onPoll
//           ^? names: Effect, Polls, BotRuntime, Scope; no-object
export const click = onVote
//           ^? names: Effect, Polls, BotRuntime, Scope; no-object
export const running = layer
//           ^? names: Target, Layer, StartupFailed, ConfigError
export const entry = Main
//           ^? names: Layer, StartupFailed, ConfigError, LockHeld, PlatformError
