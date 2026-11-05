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
 * argument adds: a finite literal cannot exceed a limit (a literal over it is a bug in code, a defect at run
 * time), any other value may.
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

/** May a value of this type exceed a limit? Strings: unless a finite literal; numbers: unless a literal; dates: always. */
export type MayExceed<V> = [V] extends [undefined | null]
  ? false
  : [Exclude<V, undefined | null>] extends [string]
    ? IsFiniteLiteral<Exclude<V, undefined | null>> extends true
      ? false
      : true
    : [Exclude<V, undefined | null>] extends [number]
      ? number extends Exclude<V, undefined | null>
        ? true
        : false
      : true

type ContentOf<P> = P extends { readonly content?: infer C } ? C : undefined

/** The content may be over the limit (distributes over `P`). */
export type MayBeTooLong<P> = P extends unknown ? MayExceed<ContentOf<P>> : never

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
export type NameTooLongIn<N> = MayExceed<N> extends true ? NameTooLong : never
/** `EmbedTooLarge` when edit `P` sets embeds that are not `[]`, else nothing. */
export type EditEmbedTooLargeIn<P> = P extends { readonly embeds: infer E } ? (E extends readonly [] ? never : EmbedTooLarge) : never
/** `MessageEmpty` when edit `P` may empty the message, else nothing. */
export type EditMessageEmptyIn<P> = EditMayEmpty<P> extends true ? MessageEmpty : never
/** `NameTooLong` when channel patch `P` sets a name that may be over the limit, else nothing. */
export type PatchNameTooLongIn<P> = P extends { readonly name: infer N } ? NameTooLongIn<N> : never
/** `TopicTooLong` when channel patch `P` sets a topic that may be over the limit, else nothing. */
export type PatchTopicTooLongIn<P> = P extends { readonly topic: infer T } ? (MayExceed<T> extends true ? TopicTooLong : never) : never
/** `SlowmodeOutOfRange` when channel patch `P` sets a slowmode that may be out of range, else nothing. */
export type PatchSlowmodeOutOfRangeIn<P> = P extends { readonly slowmodeSeconds: infer S } ? (MayExceed<S> extends true ? SlowmodeOutOfRange : never) : never
/** `NicknameTooLong` when the nickname `N` may be over the limit, else nothing. */
export type NicknameTooLongIn<N> = MayExceed<N> extends true ? NicknameTooLong : never
/** `TimeoutTooLong` when the timeout's end `U` may be too far ahead, else nothing. */
export type TimeoutTooLongIn<U> = MayExceed<U> extends true ? TimeoutTooLong : never

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
