// Hover markers for commands (DESIGN §2.8, §5.3; T11): a command hovers as its name and invocation, not its option
// tuple, and its options as the values a handler receives (choices as their literals, a channel option as the handles
// of its kinds).
import { Command, type InvocationOf } from "../../src/commands/Command.ts"

export const ban = Command.chatInput({
  name: "ban",
  description: "Ban a member",
  options: [
    { type: "user", name: "user", description: "who", required: true },
    { type: "string", name: "reason", description: "why", choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] },
    { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] },
    { type: "integer", name: "days", description: "history" }
  ]
})
export const banCommand = ban
//           ^? names: ChatInputCommand, ResolvedUser, AnnouncementChannel, TextChannel
export type BanOptions = InvocationOf<typeof ban>["options"]
//          ^? names: ResolvedUser, AnnouncementChannel, TextChannel
export const admin = Command.withSubcommands({
  name: "admin",
  description: "Admin tools",
  subcommands: [
    { type: "subcommand", name: "warn", description: "warn", options: [{ type: "user", name: "user", description: "who", required: true }] },
    { type: "group", name: "role", description: "roles", subcommands: [{ type: "subcommand", name: "add", description: "add", options: [{ type: "role", name: "role", description: "r", required: true }] }] }
  ]
})
export const adminCommand = admin
//           ^? names: ChatInputCommand, ResolvedUser, ResolvedRole
