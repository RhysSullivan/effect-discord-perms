/**
 * The payload rule table (DESIGN §2.3, D21): for each payload feature, the permission it needs and what Discord
 * does without it, `error` (the request fails) or `degrade` (the message is sent without the feature). The
 * live matrix decides each `mode` (open question 4); only this table changes, and the types and preflight
 * follow it.
 *
 * M3 brings the table and the runtime lookups preflight and the matrix read. The payload types and the
 * type-level computations over this table (`PayloadFlags`, `DegradableFlags`, `MayInclude`, ...) arrive with
 * the payload modules in M6.
 */
import type { PermissionFlag } from "../errors/Missing.generated.ts"

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

/** A payload feature with a rule. */
export type PayloadRuleName = keyof typeof PayloadRules

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
export const errorFlags = (features: ReadonlyArray<PayloadRuleName>): ReadonlyArray<PermissionFlag> =>
  flagsWithMode(features, "error")

/** The flags whose absence silently drops part of a request carrying `features`, in rule order, without duplicates. */
export const degradeFlags = (features: ReadonlyArray<PayloadRuleName>): ReadonlyArray<PermissionFlag> =>
  flagsWithMode(features, "degrade")

const flagsWithMode = (features: ReadonlyArray<PayloadRuleName>, mode: PayloadRule["mode"]): ReadonlyArray<PermissionFlag> => {
  const out: Array<PermissionFlag> = []
  for (const name of payloadRuleNames) {
    const rule: PayloadRule = PayloadRules[name]
    if (features.includes(name) && rule.mode === mode && !out.includes(rule.flag)) out.push(rule.flag)
  }
  return out
}
