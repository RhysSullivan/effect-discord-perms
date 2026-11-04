/**
 * Slash command definitions (DESIGN §2.8, D26; `[sd:src/commands.ts]`).
 *
 * Options are const tuples, so their order can be checked (G6). Every rule fails on a message carried by a property
 * of the offending element (rules 2-3 of §2.12), at every nesting level:
 *
 * - names (of the command, of subcommands and groups, of value options) are lowercase, without spaces, 1 to 32
 *   characters, checked only on finite literals (a `string` or a template pattern such as `` `slot${number}` `` passes,
 *   and the registration API is the check for those: a 50035 at startup is `StartupFailed("command-rejected")`);
 * - a required option comes before every optional one;
 * - at most 25 options, or 25 subcommands and groups, per level;
 * - nesting is by construction (H-196, H-197): a subcommand holds only value options, a group only subcommands, and a
 *   command with subcommands (`Command.withSubcommands`) holds no value options next to them.
 *
 * The checks are mapped tuples, not recursion over a growing index: "required after optional" is the adjacent pair
 * (optional at I-1, required at I) through a `Prev` lookup, and "more than 25" an index test.
 *
 * **The command type is opaque.** `ChatInputCommand<N, Invocation>` carries the computed invocation (the option
 * values a handler receives: required versus optional, choices as their literal union, channel options as the
 * handles of the allowed kinds), not the option tuple, so the command hovers as the invocation object (§5.3). Only
 * `Command.*` makes one (its phantom key is a symbol this module does not export), so every command a bot registers
 * passed these checks. Its `definition` is what registration sends (`Canonical.ts`, `Registration.ts`).
 *
 * Context-menu (USER and MESSAGE) commands are not built yet (§2.8's last item; M9 brings them with the interactions
 * that deliver their targets).
 */
import type { ChannelKinds, GuildChannelKind } from "../channels/Channel.ts"
import type { Invalid } from "../payload/Components.ts"
import type { IsFiniteLiteral } from "../payload/PayloadRules.ts"
import type { RoleId, UserId } from "../Snowflake.ts"

interface Base<T extends string> {
  readonly type: T
  readonly name: string
  readonly description: string
  readonly required?: boolean
}
/** A string option: optional choices (the handler gets their values' literal union), autocomplete, a length range. */
export interface StringOption extends Base<"string"> {
  readonly choices?: ReadonlyArray<{ readonly name: string; readonly value: string }>
  readonly autocomplete?: boolean
  readonly minLength?: number
  readonly maxLength?: number
}
/** An integer option: optional choices, autocomplete, a value range. */
export interface IntegerOption extends Base<"integer"> {
  readonly choices?: ReadonlyArray<{ readonly name: string; readonly value: number }>
  readonly autocomplete?: boolean
  readonly minValue?: number
  readonly maxValue?: number
}
/** A number option: optional choices, autocomplete, a value range. */
export interface NumberOption extends Base<"number"> {
  readonly choices?: ReadonlyArray<{ readonly name: string; readonly value: number }>
  readonly autocomplete?: boolean
  readonly minValue?: number
  readonly maxValue?: number
}
/** A boolean option. */
export interface BooleanOption extends Base<"boolean"> {}
/** A user option: the handler gets the user's ID. */
export interface UserOption extends Base<"user"> {}
/** A role option: the handler gets the role's ID. */
export interface RoleOption extends Base<"role"> {}
/** A channel option, optionally restricted to some kinds: the handler gets a handle of one of them. */
export interface ChannelOption extends Base<"channel"> {
  readonly channelTypes?: ReadonlyArray<GuildChannelKind>
}
/** A value option (anything but a subcommand or group). */
export type ValueOption = StringOption | IntegerOption | NumberOption | BooleanOption | UserOption | RoleOption | ChannelOption
/** A subcommand: value options only (H-196). */
export interface SubcommandDef {
  readonly type: "subcommand"
  readonly name: string
  readonly description: string
  readonly options?: ReadonlyArray<ValueOption>
}
/** A subcommand group: subcommands only (H-196). */
export interface GroupDef {
  readonly type: "group"
  readonly name: string
  readonly description: string
  readonly subcommands: ReadonlyArray<SubcommandDef>
}
/** Anything an option list can hold as written (the checks reject what does not belong at its level). */
export type OptionLike = ValueOption | SubcommandDef | GroupDef

// ---- literal checks ---------------------------------------------------------------------------------------

type Len<S extends string, Acc extends ReadonlyArray<0> = []> = Acc["length"] extends 33 ? 33 : S extends `${string}${infer Rest}` ? Len<Rest, [...Acc, 0]> : Acc["length"]

/**
 * A chat-input command's name: lowercase, no spaces, 1 to 32 characters, checked only on finite literals (H-190,
 * H-191). An uppercase literal fails with its lowercase form as the expected type, which is the fix.
 */
export type CheckName<N extends string> =
  IsFiniteLiteral<N> extends false
    ? N
    : N extends Lowercase<N>
      ? N extends `${string} ${string}`
        ? `names cannot contain spaces: ${N}`
        : Len<N> extends 0 | 33
          ? `names are 1 to 32 characters`
          : N
      : Lowercase<N>

type NameMessage<N extends string> =
  IsFiniteLiteral<N> extends false ? never : CheckName<N> extends N ? never : N extends Lowercase<N> ? CheckName<N> : `names must be lowercase: ${Lowercase<N>}`

/** Puts a message on property K of element H. */
type Mark<H, K extends PropertyKey, Msg extends string> = { readonly [P in keyof H]: P extends K ? H[P] & Invalid<Msg> : H[P] }

/** The string index of the previous tuple element (anything past 25 is already an error). */
interface Prev {
  readonly "1": "0"
  readonly "2": "1"
  readonly "3": "2"
  readonly "4": "3"
  readonly "5": "4"
  readonly "6": "5"
  readonly "7": "6"
  readonly "8": "7"
  readonly "9": "8"
  readonly "10": "9"
  readonly "11": "10"
  readonly "12": "11"
  readonly "13": "12"
  readonly "14": "13"
  readonly "15": "14"
  readonly "16": "15"
  readonly "17": "16"
  readonly "18": "17"
  readonly "19": "18"
  readonly "20": "19"
  readonly "21": "20"
  readonly "22": "21"
  readonly "23": "22"
  readonly "24": "23"
  readonly "25": "24"
}
type Over25 = "25" | "26" | "27" | "28" | "29" | "30" | "31" | "32" | "33" | "34" | "35" | "36" | "37" | "38" | "39" | "40"
type IsOptional<X> = X extends { readonly required: true } ? false : true
type PrevIsOptional<O extends ReadonlyArray<unknown>, I> = I extends keyof Prev ? (Prev[I] extends keyof O ? IsOptional<O[Prev[I]]> : false) : false

/** One element of a value-option list at index I. */
type CheckOption<O extends ReadonlyArray<OptionLike>, I extends string, H> =
  I extends Over25
    ? Mark<H, "name", "at most 25 options per level">
    : H extends SubcommandDef | GroupDef
      ? Mark<H, "type", "subcommands and groups go in Command.withSubcommands">
      : H extends { readonly required: true; readonly name: infer N extends string }
        ? PrevIsOptional<O, I> extends true
          ? Mark<H, "required", `required option ${N} must come before every optional option`>
          : CheckOptionName<H>
        : CheckOptionName<H>
type CheckOptionName<H> = H extends { readonly name: infer N extends string } ? ([NameMessage<N>] extends [never] ? H : Mark<H, "name", NameMessage<N>>) : H

/** Value options at one level: count, order, names, no nesting. */
export type Ordered<O extends ReadonlyArray<OptionLike>> = { readonly [I in keyof O]: I extends `${number}` ? CheckOption<O, I, O[I]> : O[I] }

type CheckSub<H, I extends string> =
  I extends Over25
    ? Mark<H, "name", "at most 25 subcommands per level">
    : H extends { readonly type: "subcommand"; readonly name: infer N extends string }
      ? {
          readonly [P in keyof H]: P extends "name"
            ? [NameMessage<N>] extends [never]
              ? H[P]
              : H[P] & Invalid<NameMessage<N>>
            : P extends "options"
              ? H[P] extends ReadonlyArray<OptionLike>
                ? Ordered<H[P]>
                : H[P]
              : H[P]
        }
      : H extends { readonly type: "group"; readonly name: infer N extends string }
        ? {
            readonly [P in keyof H]: P extends "name"
              ? [NameMessage<N>] extends [never]
                ? H[P]
                : H[P] & Invalid<NameMessage<N>>
              : P extends "subcommands"
                ? H[P] extends ReadonlyArray<SubcommandDef | GroupDef>
                  ? CheckedSubs<H[P]>
                  : H[P]
                : H[P]
          }
        : H

/** Subcommands and groups at one level, with every rule applied inside them too. */
export type CheckedSubs<S extends ReadonlyArray<SubcommandDef | GroupDef>> = { readonly [I in keyof S]: I extends `${number}` ? CheckSub<S[I], I> : S[I] }

// ---- the values a handler receives --------------------------------------------------------------------------

/** A user option's value. */
export interface ResolvedUser {
  readonly id: UserId
}
/** A role option's value. */
export interface ResolvedRole {
  readonly id: RoleId
}
interface ValueByType {
  readonly string: string
  readonly integer: number
  readonly number: number
  readonly boolean: boolean
  readonly user: ResolvedUser
  readonly role: ResolvedRole
  readonly channel: ChannelKinds<never>[GuildChannelKind]
}
type ValueOf<P extends ValueOption> = P extends { readonly choices: ReadonlyArray<{ readonly value: infer V }> }
  ? V
  : P extends { readonly type: "channel"; readonly channelTypes: ReadonlyArray<infer K extends GuildChannelKind> }
    ? ChannelKinds<never>[K]
    : ValueByType[P["type"]]
type Simplify<T> = { readonly [K in keyof T]: T[K] } & {}

/** The option values of one level: required options as required keys, the others optional. */
export type OptionsOf<O extends ReadonlyArray<OptionLike>> = Simplify<
  { readonly [P in Extract<O[number], ValueOption> as P extends { readonly required: true } ? P["name"] : never]: ValueOf<P> } & {
    readonly [P in Extract<O[number], ValueOption> as P extends { readonly required: true } ? never : P["name"]]?: ValueOf<P>
  }
>
type SubInvocation<S, Group extends string | undefined> = S extends SubcommandDef
  ? { readonly group: Group; readonly subcommand: S["name"]; readonly options: OptionsOf<S["options"] extends ReadonlyArray<ValueOption> ? S["options"] : readonly []> }
  : never
/** A command with subcommands is invoked as one of them: a discriminated union, so one subcommand never sees another's options. */
export type SubsInvocation<S extends ReadonlyArray<SubcommandDef | GroupDef>> = {
  [I in keyof S]: S[I] extends GroupDef ? SubInvocation<S[I]["subcommands"][number], S[I]["name"]> : SubInvocation<S[I], undefined>
}[number]

// ---- definitions ----------------------------------------------------------------------------------------------

/** What registration sends for a chat-input command: its name, description and options as written. */
export interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly options: ReadonlyArray<OptionLike>
}

/** The phantom key of the invocation type. Not exported, so only `Command.*` can make a command. */
const InvocationType: unique symbol = Symbol.for("effect-discord-perms/InvocationType")

/**
 * An opaque chat-input command, parameterised by its name and its computed invocation (see the module comment).
 * `definition` is what registration sends.
 */
export interface ChatInputCommand<N extends string, Invocation> {
  readonly kind: "chat-input"
  readonly name: N
  readonly definition: CommandDefinition
  /** Phantom: the decoded shape a handler receives. Its value is always `undefined`; nothing reads it. */
  readonly [InvocationType]: Invocation
}

/** The invocation a command's handler receives. */
export type InvocationOf<C> = C extends ChatInputCommand<string, infer I> ? I : never

/** Any chat-input command (what a bot registers). */
export type AnyChatInputCommand = ChatInputCommand<string, unknown>

/** A command with value options. */
function chatInput<const N extends string, const O extends ReadonlyArray<OptionLike> = readonly []>(def: {
  readonly name: CheckName<N>
  readonly description: string
  readonly options?: O & Ordered<O>
}): ChatInputCommand<N, { readonly options: OptionsOf<O> }>
// SAFETY: the overload attaches the name and invocation types to the wide command (rule 7 of §2.12). The name is the
// literal `N` whenever the program compiles (`CheckName<N>` is `N` for every accepted name), the phantom invocation
// is never read at run time, and `definition` is the definition as written.
function chatInput(def: { readonly name: string; readonly description: string; readonly options?: ReadonlyArray<OptionLike> }): AnyChatInputCommand {
  return { kind: "chat-input", name: def.name, definition: { name: def.name, description: def.description, options: def.options ?? [] }, [InvocationType]: undefined }
}

/** A command whose top level is subcommands and groups. */
function withSubcommands<const N extends string, const S extends ReadonlyArray<SubcommandDef | GroupDef>>(def: {
  readonly name: CheckName<N>
  readonly description: string
  readonly subcommands: S & CheckedSubs<S>
}): ChatInputCommand<N, SubsInvocation<S>>
// SAFETY: as for `chatInput`.
function withSubcommands(def: { readonly name: string; readonly description: string; readonly subcommands: ReadonlyArray<SubcommandDef | GroupDef> }): AnyChatInputCommand {
  return { kind: "chat-input", name: def.name, definition: { name: def.name, description: def.description, options: def.subcommands }, [InvocationType]: undefined }
}

/** The command constructors (see the module comment). */
export const Command = {
  /** A command with value options (no subcommands). */
  chatInput,
  /** A command whose top level is subcommands and groups (they cannot be mixed with value options, H-197). */
  withSubcommands
}
