/**
 * Step (c)'s outcome (DESIGN §5.10, §4.12): the raw call's answer as the truth table records it, and the
 * degradation readback from the subject's own create response (D35).
 *
 * - 2xx: `success`, or `degraded` with the flags whose effect the response lacks: no embeds (EmbedLinks), no
 *   attachments (AttachFiles), no `message_reference` (ReadMessageHistory, for a reply), `tts: false`
 *   (SendTTSMessages), no poll (SendPolls), `mention_everyone: false` (MentionEveryone, H-100). Every requested
 *   feature is read back whatever `PayloadRules.mode` says, so a feature Discord drops instead of refusing is
 *   found (open question 4).
 * - A Discord error answer: `50013`, `50001` or `other-error`, with the status, code and the sorted inner 50035
 *   codes with their paths; `mappedTag` is the dedicated code's tag (`ErrorMap.dedicatedCodeTags`) or `n/a`.
 * - No answer (a 5xx, a transport failure, the deadline) is an infrastructure abort, never a row (§5.10): the
 *   request may have been applied.
 */
import { Schema } from "effect"
import type { DiscordResponse } from "../src/errors/Cause.ts"
import type { PermissionFlag } from "../src/errors/Missing.generated.ts"
import * as Flags from "../src/permissions/Flags.ts"
import { dedicatedCodeTags } from "../src/rest/ErrorMap.ts"
import { MessageId } from "../src/Snowflake.ts"
import type { SendPayload } from "./scenario/Dsl.ts"
import type { RawOutcome } from "./TruthTable.ts"

/** The parts of a created message the readback reads (the subject's own message: content is always there). */
export const CreatedMessage = Schema.Struct({
  id: MessageId,
  tts: Schema.Boolean,
  mention_everyone: Schema.Boolean,
  embeds: Schema.Array(Schema.Unknown),
  attachments: Schema.Array(Schema.Unknown),
  poll: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
  message_reference: Schema.optionalKey(Schema.NullOr(Schema.Unknown))
})
/** A created message. */
export type CreatedMessage = typeof CreatedMessage.Type

/** The flags whose requested effect the created message lacks, sorted. */
export const degradedFlags = (payload: SendPayload, message: CreatedMessage): ReadonlyArray<PermissionFlag> => {
  const dropped: Array<PermissionFlag> = []
  switch (payload) {
    case "embed":
      if (message.embeds.length === 0) dropped.push("EmbedLinks")
      break
    case "file":
      if (message.attachments.length === 0) dropped.push("AttachFiles")
      break
    case "reply":
      if (message.message_reference === undefined || message.message_reference === null) dropped.push("ReadMessageHistory")
      break
    case "tts":
      if (!message.tts) dropped.push("SendTTSMessages")
      break
    case "poll":
      if (message.poll === undefined || message.poll === null) dropped.push("SendPolls")
      break
    case "mention-everyone":
      if (!message.mention_everyone) dropped.push("MentionEveryone")
      break
    case "plain":
    case "guild-sticker":
      break
  }
  return Flags.sortFlags(dropped)
}

/** A 2xx outcome whose response lacks the effect of `degraded` (sorted here). */
export const ok = (degraded: ReadonlyArray<PermissionFlag>): RawOutcome => {
  const sorted = Flags.sortFlags(degraded)
  return { class: sorted.length > 0 ? "degraded" : "success", status: 200, code: 0, inner: [], degraded: [...sorted], mappedTag: "n/a" }
}

/** A send's 2xx outcome, read back from the created message. */
export const succeeded = (payload: SendPayload, message: CreatedMessage): RawOutcome => ok(degradedFlags(payload, message))

/** A Discord error answer. */
export const rejected = (response: DiscordResponse): RawOutcome => ({
  class: response.code === 50013 ? "50013" : response.code === 50001 ? "50001" : "other-error",
  status: response.status,
  code: response.code,
  inner: response.fieldErrors
    .map((error) => ({ path: error.path.join("."), code: error.code }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
  degraded: [],
  mappedTag: dedicatedCodeTags.get(response.code) ?? "n/a"
})

/** A setup Discord would not build (§5.10). */
export const unsupported = (reason: NonNullable<RawOutcome["unsupported"]>, status = 0, code = 0): RawOutcome => ({
  class: "setup-unsupported",
  status,
  code,
  inner: [],
  degraded: [],
  mappedTag: "n/a",
  unsupported: reason
})
