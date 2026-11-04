// Command definitions and option typing (DESIGN §2.8; [sd:src/commands-use.ts]): every shape that must compile, with
// exact inferred types, at the top level and nested.
import { Config, Redacted } from "effect"
import { expectTypeOf } from "vitest"
import { Bot } from "../../../src/bot/Bot.ts"
import type { BotConfig } from "../../../src/bot/Runtime.ts"
import type { AnnouncementChannel, ForumChannel, GuildChannel, TextChannel } from "../../../src/channels/Channel.ts"
import { type AnyChatInputCommand, type ChatInputCommand, Command, type InvocationOf, type ResolvedRole, type ResolvedUser } from "../../../src/commands/Command.ts"
import { GuildId } from "../../../src/Snowflake.ts"

// value options: required versus optional, choices as their literal union, a channel option narrowed to its kinds
export const ban = Command.chatInput({
  name: "ban",
  description: "Ban a member",
  options: [
    { type: "user", name: "user", description: "who", required: true },
    { type: "string", name: "reason", description: "why", choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] },
    { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] },
    { type: "integer", name: "days", description: "history", minValue: 0, maxValue: 7 }
  ]
})
expectTypeOf<InvocationOf<typeof ban>>().toEqualTypeOf<{
  readonly options: { readonly user: ResolvedUser; readonly reason?: "spam" | "abuse"; readonly log?: TextChannel | AnnouncementChannel; readonly days?: number }
}>()
expectTypeOf(ban).toEqualTypeOf<ChatInputCommand<"ban", InvocationOf<typeof ban>>>()
expectTypeOf(ban.name).toEqualTypeOf<"ban">()

// every value type; a channel option without kinds is any guild channel; integer choices are their literals
export const kinds = Command.chatInput({
  name: "kinds",
  description: "Every option type",
  options: [
    { type: "string", name: "text", description: "d", required: true, minLength: 1, maxLength: 100 },
    { type: "integer", name: "count", description: "d", required: true, choices: [{ name: "One", value: 1 }, { name: "Two", value: 2 }] },
    { type: "number", name: "ratio", description: "d", minValue: 0, maxValue: 1 },
    { type: "boolean", name: "flag", description: "d" },
    { type: "role", name: "role", description: "d" },
    { type: "channel", name: "anywhere", description: "d" },
    { type: "channel", name: "forum", description: "d", channelTypes: ["forum"] }
  ]
})
expectTypeOf<InvocationOf<typeof kinds>>().toEqualTypeOf<{
  readonly options: {
    readonly text: string
    readonly count: 1 | 2
    readonly ratio?: number
    readonly flag?: boolean
    readonly role?: ResolvedRole
    readonly anywhere?: GuildChannel
    readonly forum?: ForumChannel
  }
}>()

// a command without options has an empty options object
export const ping = Command.chatInput({ name: "ping", description: "Ping" })
expectTypeOf<InvocationOf<typeof ping>>().toEqualTypeOf<{ readonly options: {} }>()

// subcommands and groups: a discriminated union, so narrowing one subcommand hides the others' options
export const admin = Command.withSubcommands({
  name: "admin",
  description: "Admin tools",
  subcommands: [
    { type: "subcommand", name: "warn", description: "warn", options: [{ type: "user", name: "user", description: "who", required: true }] },
    {
      type: "group",
      name: "role",
      description: "roles",
      subcommands: [
        { type: "subcommand", name: "add", description: "add", options: [{ type: "role", name: "role", description: "r", required: true }] },
        { type: "subcommand", name: "list", description: "list" }
      ]
    }
  ]
})
type AdminInvocation = InvocationOf<typeof admin>
expectTypeOf<AdminInvocation>().toEqualTypeOf<
  | { readonly group: undefined; readonly subcommand: "warn"; readonly options: { readonly user: ResolvedUser } }
  | { readonly group: "role"; readonly subcommand: "add"; readonly options: { readonly role: ResolvedRole } }
  | { readonly group: "role"; readonly subcommand: "list"; readonly options: {} }
>()
declare const invocation: AdminInvocation
export const warned = invocation.subcommand === "warn" ? invocation.options.user.id : undefined
expectTypeOf(warned).toEqualTypeOf<ResolvedUser["id"] | undefined>()

// required options before optional ones, at every level; exactly 25 options and 25 subcommands are allowed
export const ordered = Command.withSubcommands({
  name: "mod",
  description: "d",
  subcommands: [
    { type: "subcommand", name: "ban", description: "d", options: [{ type: "user", name: "user", description: "who", required: true }, { type: "string", name: "reason", description: "why" }] }
  ]
})
export const twentyFive = Command.chatInput({
  name: "lab-command-name-at-the-32-limit",
  description: "d",
  options: [
    { type: "string", name: "a1", description: "d", required: true }, { type: "string", name: "a2", description: "d" }, { type: "string", name: "a3", description: "d" },
    { type: "string", name: "a4", description: "d" }, { type: "string", name: "a5", description: "d" }, { type: "string", name: "a6", description: "d" },
    { type: "string", name: "a7", description: "d" }, { type: "string", name: "a8", description: "d" }, { type: "string", name: "a9", description: "d" },
    { type: "string", name: "a10", description: "d" }, { type: "string", name: "a11", description: "d" }, { type: "string", name: "a12", description: "d" },
    { type: "string", name: "a13", description: "d" }, { type: "string", name: "a14", description: "d" }, { type: "string", name: "a15", description: "d" },
    { type: "string", name: "a16", description: "d" }, { type: "string", name: "a17", description: "d" }, { type: "string", name: "a18", description: "d" },
    { type: "string", name: "a19", description: "d" }, { type: "string", name: "a20", description: "d" }, { type: "string", name: "a21", description: "d" },
    { type: "string", name: "a22", description: "d" }, { type: "string", name: "a23", description: "d" }, { type: "string", name: "a24", description: "d" },
    { type: "string", name: "a25", description: "d" }
  ]
})
expectTypeOf(twentyFive.name).toEqualTypeOf<"lab-command-name-at-the-32-limit">()

// template-pattern and dynamic names are not literal-checked (types-dx finding 21)
declare const n: number
export const slot = Command.chatInput({ name: "slots", description: "d", options: [{ type: "string", name: `slot${n}`, description: "d" }] })
declare const dynamicName: string
export const dynamic = Command.chatInput({ name: dynamicName, description: "d" })
expectTypeOf(dynamic.name).toEqualTypeOf<string>()

// a bot registers built commands in its guild; any command is an AnyChatInputCommand
const bot = Bot.make({ intents: ["Guilds"] })
const config: BotConfig = { token: Config.succeed(Redacted.make("token")), guildId: GuildId.make("100000000000000001"), commands: [ban, admin, ping] }
export const layer = Bot.layer(bot, config)
expectTypeOf(ban).toExtend<AnyChatInputCommand>()
expectTypeOf(admin).toExtend<AnyChatInputCommand>()
