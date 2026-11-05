/**
 * The payload rule table (DESIGN §2.3, D21): for each payload feature, the permission it needs and what Discord
 * does without it, `error` (the request fails) or `degrade` (the message is sent without the feature). The
 * live matrix decides each `mode` (open question 4); only this table changes, and the types and preflight
 * follow it.
 *
 * One table drives both sides:
 *
 * - **types** (`PayloadFlags`, `DegradableFlags`, `MayInclude`): which features a payload type may carry. "May
 *   have" distributes over a union of payloads and is tested as `true extends ...`, so a payload typed as the
 *   union `MessagePayload` is judged member by member (rule 4 of §2.12). Presence is independent of `mode`, so
 *   the limit tags (`EmbedTooLarge`, `PollTooLarge`) and the reply variant never move when a mode flips;
 * - **runtime** (`features`, `errorFlags`, `degradeFlags`): the features a payload value carries, which preflight
 *   and the recompute read. `test/types/pass/payload-flags.ts` and `test/unit/payload.test.ts` hold the two to
 *   the same samples.
 *
 * The limit types (`MayExceed`, `MayBeTooLong`, `MayBeEmpty`, `EditMayEmpty`) decide which limit tags a payload or
 * argument adds: a finite literal within its limit cannot exceed it, so its tag is absent; a finite literal over it,
 * and any other value, may, so the tag is present (after the final audit: an over-limit literal used to compile with
 * no tag, which the local check then failed with undeclared).
 */
import type { PermissionFlag } from "../errors/Missing.generated.ts"
import type {
  ContentTooLong,
  EmbedTooLarge,
  MessageEmpty,
  NameTooLong,
  NicknameTooLong,
  PollTooLarge,
  SlowmodeOutOfRange,
  TimeoutTooLong,
  TopicTooLong
} from "../errors/Payload.ts"
import { type CreateMessage, isV2, type MessagePayload } from "./Message.ts"

/** One rule. */
export interface PayloadRule {
  readonly flag: PermissionFlag
  readonly mode: "error" | "degrade"
}

/** The rules, by payload feature. */
export const PayloadRules = {
  reply: { flag: "ReadMessageHistory", mode: "error" },
  embeds: { flag: "EmbedLinks", mode: "error" },
  files: { flag: "AttachFiles", mode: "error" },
  tts: { flag: "SendTTSMessages", mode: "degrade" },
  poll: { flag: "SendPolls", mode: "error" },
  externalSticker: { flag: "UseExternalStickers", mode: "error" },
  externalEmojiInContent: { flag: "UseExternalEmojis", mode: "degrade" },
  mentionsEveryone: { flag: "MentionEveryone", mode: "degrade" },
  unmentionableRole: { flag: "MentionEveryone", mode: "degrade" }
} as const satisfies Record<string, PayloadRule>

type Rules = typeof PayloadRules

/** A payload feature with a rule. */
export type PayloadRuleName = keyof Rules

/** Every rule name, in the §3.2 order of their flags (ReadMessageHistory for a reply first). */
export const payloadRuleNames: ReadonlyArray<PayloadRuleName> = [
  "reply",
  "embeds",
  "files",
  "tts",
  "poll",
  "externalSticker",
  "externalEmojiInContent",
  "mentionsEveryone",
  "unmentionableRole"
]

/** The flags whose absence fails a request carrying `features`, in rule order, without duplicates. */
export const errorFlags = (features: ReadonlyArray<PayloadRuleName>): ReadonlyArray<PermissionFlag> => flagsWithMode(features, "error")

/** The flags whose absence silently drops part of a request carrying `features`, in rule order, without duplicates. */
export const degradeFlags = (features: ReadonlyArray<PayloadRuleName>): ReadonlyArray<PermissionFlag> => flagsWithMode(features, "degrade")

const flagsWithMode = (features: ReadonlyArray<PayloadRuleName>, mode: PayloadRule["mode"]): ReadonlyArray<PermissionFlag> => {
  const out: Array<PermissionFlag> = []
  for (const name of payloadRuleNames) {
    const rule: PayloadRule = PayloadRules[name]
    if (features.includes(name) && rule.mode === mode && !out.includes(rule.flag)) out.push(rule.flag)
  }
  return out
}

// ---- the type side ------------------------------------------------------------------------------------

type MayHave<P, K extends PropertyKey, Empty> = P extends unknown ? (K extends keyof P ? ([Exclude<P[K], undefined | Empty>] extends [never] ? false : true) : false) : never

type OriginOf<X> = X extends { readonly origin: infer O } ? O : never

/** `true` for a finite string literal (or union of them): `{} extends Record<S, 1>` holds for `string` and template patterns. */
export type IsFiniteLiteral<S> = [S] extends [string] ? ({} extends Record<S, 1> ? false : true) : false

/** Content may carry custom-emoji markup: any non-literal string, or a literal containing `<:x:id>` / `<a:x:id>`. */
type MayHaveCustomEmoji<C> = [C] extends [undefined]
  ? false
  : IsFiniteLiteral<Exclude<C, undefined>> extends false
    ? true
    : Exclude<C, undefined> extends `${string}<${"" | "a"}:${string}:${string}>${string}`
      ? true
      : false

/** Whether payload type `P` may carry each feature (a sound over-approximation, G4). */
interface Present<P> {
  readonly reply: MayHave<P, "reply", never>
  readonly embeds: MayHave<P, "embeds", readonly []>
  readonly files: MayHave<P, "files", readonly []>
  readonly tts: MayHave<P, "tts", false>
  readonly poll: MayHave<P, "poll", never>
  readonly externalSticker: P extends { readonly stickers?: infer S } ? (S extends ReadonlyArray<infer X> ? ("external" extends OriginOf<X> ? true : false) : false) : false
  readonly externalEmojiInContent: P extends { readonly content?: infer C } ? MayHaveCustomEmoji<C> : false
  readonly mentionsEveryone: P extends { readonly mentions?: infer M } ? MayHave<NonNullable<M>, "everyone", never> : false
  readonly unmentionableRole: P extends { readonly mentions?: infer M } ? MayHave<NonNullable<M>, "roles", readonly []> : false
}

/** Feature `K` may be present in `P` (independent of its rule's mode; the limit tags key on it). */
export type MayInclude<P, K extends PayloadRuleName> = true extends Present<P>[K] ? true : false

type FlagsWith<P, Mode> = { [K in PayloadRuleName]: true extends Present<P>[K] ? (Rules[K]["mode"] extends Mode ? Rules[K]["flag"] : never) : never }[PayloadRuleName]

/** Flags whose absence makes a request with payload `P` fail. */
export type PayloadFlags<P> = FlagsWith<P, "error">

/** Flags whose absence silently drops part of a message with payload `P` (reported in `degraded`). */
export type DegradableFlags<P> = FlagsWith<P, "degrade">

type X10 = "xxxxxxxxxx"
type X100 = `${X10}${X10}${X10}${X10}${X10}${X10}${X10}${X10}${X10}${X10}`
type X1000 = `${X100}${X100}${X100}${X100}${X100}${X100}${X100}${X100}${X100}${X100}`

/**
 * Whether the finite literal `S` (or a member of a union of them) is longer than the string `Lim`. tsc splits a literal
 * by code point, as Discord counts (`Limits.unit`). Both are peeled ten characters at a time, `S` first, so a generic
 * `S` defers at once, the recursion stays far under tsc's depth limit, and a short literal costs one step; the limit
 * is a string, not a tuple counter, because every tuple length tsc builds costs it a type per element (compile
 * budget, DESIGN §5.4).
 */
type LongerThan<S extends string, Lim extends string> = S extends `${infer _0}${infer _1}${infer _2}${infer _3}${infer _4}${infer _5}${infer _6}${infer _7}${infer _8}${infer _9}${infer Rest}`
  ? Lim extends `${X10}${infer LimRest}`
    ? LongerThan<Rest, LimRest>
    : true
  : Lim extends `${X10}${string}`
    ? false
    : FewLongerThan<S, Lim>

/** `LongerThan` once both have fewer than ten characters left: one at a time. */
type FewLongerThan<S extends string, Lim extends string> = S extends `${string}${infer Rest}` ? (Lim extends `${string}${infer LimRest}` ? FewLongerThan<Rest, LimRest> : true) : false

/** The string limits of `Limits`, as strings of that many characters (`test/types/pass/payload.ts` holds each to its value). */
export interface StringLimits {
  /** Message content: 2000. */
  readonly content: `${X1000}${X1000}`
  /** Channel, thread and post names: 1 to 100 (the 1 is `MayExceed`'s `Min`). */
  readonly name: X100
  /** Channel topics: 1024 (4096 on forum and media channels; the smaller one is a sound over-approximation there). */
  readonly topic: `${X1000}${X10}${X10}xxxx`
  /** Nicknames: 32. */
  readonly nickname: `${X10}${X10}${X10}xx`
}

/**
 * A number literal the types accept as in range: a non-negative integer of at most four digits (0 to 9999, inside
 * slowmode's 0 to 21600). Any other literal keeps the tag: a negative one or a fraction because the local check refuses
 * it (live, after the final audit: Discord refuses -1, and accepts 1.5 but stores 1), a larger natural as a sound
 * over-approximation.
 */
type SmallNatural<N extends number> = `${N}` extends `${string}${"-" | "." | "e"}${string}` ? false : `${N}` extends `${infer _0}${infer _1}${infer _2}${infer _3}${infer _4}${string}` ? false : true

/**
 * May a value of this type exceed its limit? Distributes over a union, so test it with `true extends`. Strings: unless
 * a finite literal of at most `Max["length"]` characters that is not `Min` (`""` where a value may not be empty);
 * numbers: unless a literal natural under 10,000; dates: always.
 */
export type MayExceed<V, Max extends string, Min extends string = never> = V extends undefined | null
  ? false
  : V extends string
    ? {} extends Record<V, 1>
      ? true
      : V extends Min
        ? true
        : LongerThan<V, Max>
    : V extends number
      ? number extends V
        ? true
        : SmallNatural<V> extends true
          ? false
          : true
      : true

type ContentOf<P> = P extends { readonly content?: infer C } ? C : undefined

/** The content may be over the limit (distributes over `P`). */
export type MayBeTooLong<P> = P extends unknown ? MayExceed<ContentOf<P>, StringLimits["content"]> : never

/** A required key whose type excludes the empty value: `"" extends string` may be empty, `"" extends "pong"` cannot. */
type Definitely<P, K extends PropertyKey, Empty> = K extends keyof P ? ({} extends Pick<P, K> ? false : [Empty] extends [never] ? true : Empty extends P[K] ? false : true) : false

type MayBeEmptyOne<P> =
  true extends
    | Definitely<P, "content", "">
    | Definitely<P, "embeds", readonly []>
    | Definitely<P, "files", readonly []>
    | Definitely<P, "stickers", readonly []>
    | Definitely<P, "poll", never>
    | Definitely<P, "components", readonly []>
    | Definitely<P, "componentsV2", readonly []>
    ? false
    : true

/** Discord refuses an empty body with 50006: true unless every member of `P` has a definitely non-empty field. */
export type MayBeEmpty<P> = P extends unknown ? MayBeEmptyOne<P> : never

/** An edit can empty the message: its content may be `""` or its embeds `[]` (a sound over-approximation). */
export type EditMayEmpty<P> =
  true extends
    | (P extends { readonly content: infer C } ? ("" extends C ? true : false) : false)
    | (P extends { readonly embeds: infer E } ? (readonly [] extends E ? true : false) : false)
    ? true
    : false

/** `ContentTooLong` when the content of payload `P` may be over the limit, else nothing. */
export type ContentTooLongIn<P> = true extends MayBeTooLong<P> ? ContentTooLong : never
/** `MessageEmpty` when payload `P` may be empty, else nothing. */
export type MessageEmptyIn<P> = true extends MayBeEmpty<P> ? MessageEmpty : never
/** `EmbedTooLarge` when payload `P` may carry embeds, else nothing. */
export type EmbedTooLargeIn<P> = MayInclude<P, "embeds"> extends true ? EmbedTooLarge : never
/** `PollTooLarge` when payload `P` may carry a poll, else nothing. */
export type PollTooLargeIn<P> = MayInclude<P, "poll"> extends true ? PollTooLarge : never
/** `NameTooLong` when the name `N` may be over the limit, else nothing. */
export type NameTooLongIn<N> = true extends MayExceed<N, StringLimits["name"], ""> ? NameTooLong : never
/** `EmbedTooLarge` when edit `P` sets embeds that are not `[]`, else nothing. */
export type EditEmbedTooLargeIn<P> = P extends { readonly embeds: infer E } ? (E extends readonly [] ? never : EmbedTooLarge) : never
/** `MessageEmpty` when edit `P` may empty the message, else nothing. */
export type EditMessageEmptyIn<P> = EditMayEmpty<P> extends true ? MessageEmpty : never
/** `NameTooLong` when channel patch `P` sets a name that may be over the limit, else nothing. */
export type PatchNameTooLongIn<P> = P extends { readonly name: infer N } ? NameTooLongIn<N> : never
/** `TopicTooLong` when channel patch `P` sets a topic that may be over the limit, else nothing. */
export type PatchTopicTooLongIn<P> = P extends { readonly topic: infer T } ? (true extends MayExceed<T, StringLimits["topic"]> ? TopicTooLong : never) : never
/** `SlowmodeOutOfRange` when channel patch `P` sets a slowmode that may be out of range, else nothing. */
export type PatchSlowmodeOutOfRangeIn<P> = P extends { readonly slowmodeSeconds: infer S } ? (true extends MayExceed<S, ""> ? SlowmodeOutOfRange : never) : never
/** `NicknameTooLong` when the nickname `N` may be over the limit, else nothing. */
export type NicknameTooLongIn<N> = true extends MayExceed<N, StringLimits["nickname"]> ? NicknameTooLong : never
/** `TimeoutTooLong` when the timeout's end `U` may be too far ahead, else nothing. */
export type TimeoutTooLongIn<U> = true extends MayExceed<U, ""> ? TimeoutTooLong : never

// ---- the runtime side ---------------------------------------------------------------------------------

const customEmoji = /<a?:[^:>\s]+:\d+>/

/**
 * The features a create payload value carries (the runtime mirror of `Present`): a feature is present unless it
 * is absent, empty or false. A role mention is a feature only for a role the guild does not let anyone mention
 * freely, which the payload alone cannot tell, so every mentioned role counts (the degradation readback, §4.12,
 * reports only the roles Discord dropped).
 */
export const features = (payload: MessagePayload): ReadonlyArray<PayloadRuleName> => {
  const out: Array<PayloadRuleName> = []
  const legacy: CreateMessage | undefined = isV2(payload) ? undefined : payload
  if (payload.reply !== undefined) out.push("reply")
  if (legacy?.embeds !== undefined && legacy.embeds.length > 0) out.push("embeds")
  if (payload.files !== undefined && payload.files.length > 0) out.push("files")
  if (legacy?.tts === true) out.push("tts")
  if (legacy?.poll !== undefined) out.push("poll")
  if (legacy?.stickers !== undefined && legacy.stickers.some((sticker) => sticker.origin === "external")) out.push("externalSticker")
  if (legacy?.content !== undefined && customEmoji.test(legacy.content)) out.push("externalEmojiInContent")
  if (payload.mentions?.everyone === true) out.push("mentionsEveryone")
  if (payload.mentions?.roles !== undefined && payload.mentions.roles.length > 0) out.push("unmentionableRole")
  return out
}

/** The custom-emoji tokens (`<:name:id>`, `<a:name:id>`) in `content`, for the degradation readback (H-104). */
export const customEmojiTokens = (content: string): ReadonlyArray<string> => [...content.matchAll(new RegExp(customEmoji.source, "g"))].map((match) => match[0])
