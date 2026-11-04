// Command definitions (DESIGN §2.8; [sd:src/fail/commands.ts]): every rule fails on a property of the offending
// element and names the rule, at the top level and nested in subcommands and groups; option values are typed from the
// definition; and only built commands are registered.
import { Config, Effect, Redacted } from "effect"
import type { BotConfig } from "../../../src/bot/Runtime.ts"
import { Command, type InvocationOf } from "../../../src/commands/Command.ts"
import { GuildId } from "../../../src/Snowflake.ts"

const ban = Command.chatInput({
  name: "ban",
  description: "Ban a member",
  options: [
    { type: "user", name: "user", description: "who", required: true },
    { type: "string", name: "reason", description: "why", choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] },
    { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] },
    { type: "integer", name: "days", description: "history" }
  ]
})
declare const options: InvocationOf<typeof ban>["options"]

// @valid
export const ok = [
  Command.withSubcommands({
    name: "mod",
    description: "d",
    subcommands: [
      { type: "subcommand", name: "ban", description: "d", options: [{ type: "user", name: "user", description: "who", required: true }, { type: "string", name: "reason", description: "why" }] },
      { type: "group", name: "role", description: "d", subcommands: [{ type: "subcommand", name: "add", description: "d" }] }
    ]
  }),
  options.reason === "spam" ? options.days?.toFixed() : options.log?.send({ content: "logged" }).pipe(Effect.orDie),
  { token: Config.succeed(Redacted.make("token")), guildId: GuildId.make("100000000000000001"), commands: [ban] } satisfies BotConfig
]

// ---- names: lowercase, no spaces, 1 to 32 characters (command, subcommand and group names) ----
// @expect-error TS2322 '"ban"'
export const upper = Command.chatInput({ name: "Ban", description: "d" })
// @expect-error TS2322 names must be lowercase: add
export const groupedName = Command.withSubcommands({ name: "mod", description: "d", subcommands: [{ type: "group", name: "role", description: "d", subcommands: [{ type: "subcommand", name: "Add", description: "d" }] }] })
// @expect-error TS2322 names cannot contain spaces: ban user
export const spaced = Command.chatInput({ name: "ban user", description: "d" })
// @expect-error TS2322 names cannot contain spaces: lab sub
export const spacedSub = Command.withSubcommands({ name: "mod", description: "d", subcommands: [{ type: "subcommand", name: "lab sub", description: "d" }] })
// @expect-error TS2322 names are 1 to 32 characters
export const long = Command.chatInput({ name: "abcdefghijklmnopqrstuvwxyzabcdefg", description: "d" })
// @expect-error TS2322 names are 1 to 32 characters
export const longSub = Command.withSubcommands({ name: "mod", description: "d", subcommands: [{ type: "subcommand", name: "abcdefghijklmnopqrstuvwxyzabcdefg", description: "d" }] })

// ---- option names are lowercase, at the top level and in a subcommand ----
// @expect-error TS2322 names must be lowercase: reason
export const optName = Command.chatInput({ name: "ban", description: "d", options: [{ type: "string", name: "Reason", description: "why" }] })
// @expect-error TS2322 names must be lowercase: user
export const subOptName = Command.withSubcommands({ name: "mod", description: "d", subcommands: [{ type: "subcommand", name: "ban", description: "d", options: [{ type: "user", name: "User", description: "who" }] }] })

// ---- required options come first, at the top level and in a subcommand ----
// @expect-error TS2322 required option feature must come before every optional option
export const order = Command.chatInput({
  name: "config",
  description: "d",
  options: [
    { type: "boolean", name: "enabled", description: "Turn it on or off" },
    {
      type: "string",
      name: "feature",
      description: "Which feature of the bot you want to configure for this server",
      required: true,
      choices: [{ name: "Welcome messages", value: "welcome" }, { name: "Moderation logging", value: "logging" }, { name: "Starboard", value: "starboard" }, { name: "Auto-publish announcements", value: "autopublish" }]
    }
  ]
})
// @expect-error TS2322 required option user must come before every optional option
export const subOrder = Command.withSubcommands({
  name: "mod",
  description: "d",
  subcommands: [{ type: "subcommand", name: "ban", description: "d", options: [{ type: "string", name: "reason", description: "why" }, { type: "user", name: "user", description: "who", required: true }] }]
})

// ---- at most 25 options and 25 subcommands per level ----
// @expect-error TS2322 at most 25 options per level
export const many = Command.chatInput({ name: "x", description: "d", options: [
  { type: "string", name: "a1", description: "d" }, { type: "string", name: "a2", description: "d" }, { type: "string", name: "a3", description: "d" },
  { type: "string", name: "a4", description: "d" }, { type: "string", name: "a5", description: "d" }, { type: "string", name: "a6", description: "d" },
  { type: "string", name: "a7", description: "d" }, { type: "string", name: "a8", description: "d" }, { type: "string", name: "a9", description: "d" },
  { type: "string", name: "a10", description: "d" }, { type: "string", name: "a11", description: "d" }, { type: "string", name: "a12", description: "d" },
  { type: "string", name: "a13", description: "d" }, { type: "string", name: "a14", description: "d" }, { type: "string", name: "a15", description: "d" },
  { type: "string", name: "a16", description: "d" }, { type: "string", name: "a17", description: "d" }, { type: "string", name: "a18", description: "d" },
  { type: "string", name: "a19", description: "d" }, { type: "string", name: "a20", description: "d" }, { type: "string", name: "a21", description: "d" },
  { type: "string", name: "a22", description: "d" }, { type: "string", name: "a23", description: "d" }, { type: "string", name: "a24", description: "d" },
  { type: "string", name: "a25", description: "d" }, { type: "string", name: "a26", description: "d" }] })
// @expect-error TS2322 at most 25 options per level
export const subMany = Command.withSubcommands({ name: "mod", description: "d", subcommands: [
  { type: "subcommand", name: "x", description: "d", options: [
    { type: "string", name: "o1", description: "d" }, { type: "string", name: "o2", description: "d" }, { type: "string", name: "o3", description: "d" }, { type: "string", name: "o4", description: "d" }, { type: "string", name: "o5", description: "d" },
    { type: "string", name: "o6", description: "d" }, { type: "string", name: "o7", description: "d" }, { type: "string", name: "o8", description: "d" }, { type: "string", name: "o9", description: "d" }, { type: "string", name: "o10", description: "d" },
    { type: "string", name: "o11", description: "d" }, { type: "string", name: "o12", description: "d" }, { type: "string", name: "o13", description: "d" }, { type: "string", name: "o14", description: "d" }, { type: "string", name: "o15", description: "d" },
    { type: "string", name: "o16", description: "d" }, { type: "string", name: "o17", description: "d" }, { type: "string", name: "o18", description: "d" }, { type: "string", name: "o19", description: "d" }, { type: "string", name: "o20", description: "d" },
    { type: "string", name: "o21", description: "d" }, { type: "string", name: "o22", description: "d" }, { type: "string", name: "o23", description: "d" }, { type: "string", name: "o24", description: "d" }, { type: "string", name: "o25", description: "d" },
    { type: "string", name: "o26", description: "d" }] }] })
// @expect-error TS2322 at most 25 subcommands per level
export const manyGrouped = Command.withSubcommands({ name: "mod", description: "d", subcommands: [{ type: "group", name: "g", description: "d", subcommands: [
  { type: "subcommand", name: "s1", description: "d" }, { type: "subcommand", name: "s2", description: "d" }, { type: "subcommand", name: "s3", description: "d" }, { type: "subcommand", name: "s4", description: "d" }, { type: "subcommand", name: "s5", description: "d" },
  { type: "subcommand", name: "s6", description: "d" }, { type: "subcommand", name: "s7", description: "d" }, { type: "subcommand", name: "s8", description: "d" }, { type: "subcommand", name: "s9", description: "d" }, { type: "subcommand", name: "s10", description: "d" },
  { type: "subcommand", name: "s11", description: "d" }, { type: "subcommand", name: "s12", description: "d" }, { type: "subcommand", name: "s13", description: "d" }, { type: "subcommand", name: "s14", description: "d" }, { type: "subcommand", name: "s15", description: "d" },
  { type: "subcommand", name: "s16", description: "d" }, { type: "subcommand", name: "s17", description: "d" }, { type: "subcommand", name: "s18", description: "d" }, { type: "subcommand", name: "s19", description: "d" }, { type: "subcommand", name: "s20", description: "d" },
  { type: "subcommand", name: "s21", description: "d" }, { type: "subcommand", name: "s22", description: "d" }, { type: "subcommand", name: "s23", description: "d" }, { type: "subcommand", name: "s24", description: "d" }, { type: "subcommand", name: "s25", description: "d" },
  { type: "subcommand", name: "s26", description: "d" }] }] })

// ---- nesting: a group holds only subcommands, a subcommand only value options (H-196) ----
// @expect-error TS2322 '"subcommand"'
export const groupInGroup = Command.withSubcommands({ name: "x", description: "d", subcommands: [
  { type: "group", name: "g", description: "g", subcommands: [{ type: "group", name: "h", description: "h", subcommands: [] }] }] })
// @expect-error TS2322 '"group"'
export const groupInSub = Command.withSubcommands({ name: "x", description: "d", subcommands: [
  { type: "subcommand", name: "a", description: "a", options: [{ type: "group", name: "g", description: "g", subcommands: [] }] }] })

// ---- mixing: no value options next to subcommands, at the top level and in a group (H-197) ----
// @expect-error TS2322 subcommands and groups go in Command.withSubcommands
export const mixed = Command.chatInput({ name: "x", description: "d", options: [{ type: "string", name: "s", description: "s" }, { type: "subcommand", name: "a", description: "a" }] })
// @expect-error TS2322 '"string"'
export const mixedInGroup = Command.withSubcommands({ name: "x", description: "d", subcommands: [
  { type: "group", name: "g", description: "g", subcommands: [{ type: "subcommand", name: "a", description: "a" }, { type: "string", name: "s", description: "s" }] }] })

// ---- option values are typed from the definition ----
// @expect-error TS2322 Type 'number' is not assignable to type 'string'
export const wrongChoice = Command.chatInput({ name: "x", description: "d", options: [{ type: "string", name: "s", description: "s", choices: [{ name: "One", value: 1 }] }] })
// @expect-error TS18048 possibly 'undefined'
export const optional = options.days.toFixed()
// @expect-error TS2367 have no overlap
export const notAChoice = options.reason === "other"
// @expect-error TS2339 Property 'createPost' does not exist
export const narrowed = options.log?.createPost({ name: "lab-post", message: { content: "x" } })

// ---- only built commands are registered ----
// @expect-error TS2322 InvocationType
export const forged: BotConfig = { token: Config.succeed(Redacted.make("token")), guildId: GuildId.make("100000000000000001"), commands: [{ kind: "chat-input", name: "x", definition: { name: "x", description: "d", options: [] } }] }
