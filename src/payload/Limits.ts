/**
 * The limits Discord applies to payloads and arguments (DESIGN §3.1, §4.8 step 1; H-120..H-131, H-139), and the
 * local checks the operations run before anything else (basis `payload-check`). The live rule rows send each
 * limit exactly and one over it (`harness/scenario/catalog/rules.ts`), and the offline replay holds these values
 * to them (§5.13).
 *
 * A check finds every problem and returns them in §3.2 tier 7's order (`MessageEmpty`, `ContentTooLong`,
 * `EmbedTooLarge`, `PollTooLarge`, `NameTooLong`, `TopicTooLong`, `SlowmodeOutOfRange`, `NicknameTooLong`,
 * `TimeoutTooLong`, then the bulk-delete limits). They rank last: an operation fails with one only when preflight
 * finds nothing.
 *
 * The type of each operation includes a limit tag only when its value may exceed the limit (`MayExceed`, §2.3):
 * a finite literal over a limit is a bug in the calling code. The run time cannot tell a literal from a computed
 * string of the same value, so the local check fails with the limit's tag all the same, and for such a literal that
 * tag reaches the handler undeclared (§2.3).
 */
import type { ErrorCause } from "../errors/Cause.ts"
import { ContentTooLong, EmbedTooLarge, MessageEmpty, MessagesTooOld, NameTooLong, NicknameTooLong, PollTooLarge, SlowmodeOutOfRange, TimeoutTooLong, TooManyMessagesToDelete, TopicTooLong } from "../errors/Payload.ts"
import type { MessageId } from "../Snowflake.ts"
import { type CreateMessage, type EditMessage, type Embed, isV2, type MessagePayload, type Poll } from "./Message.ts"

/**
 * The limits. `unit` is how Discord counts a string's length (H-121): `code-point` counts each Unicode code
 * point once (an emoji outside the BMP is one), `utf16` counts UTF-16 code units (it is two). The content-length
 * rule pair sends `content` code points of a non-BMP emoji, which a UTF-16 count of 2000 refuses, and `content + 1`
 * ASCII characters, which a UTF-16 count of 4000 accepts (`harness/Probes.ts`); Discord accepted the first and
 * refused the second (M6 live).
 */
export const Limits = {
  unit: "code-point",
  /** Message content (H-120: 2000 for bots, although the OpenAPI spec says 4000). */
  content: 2000,
  /** Embeds (H-123). `total` is across every embed of the message. */
  embeds: { count: 10, title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, total: 6000 },
  /** Polls (H-139). */
  poll: { question: 300, answers: 10, answerText: 55, minHours: 1, maxHours: 768 },
  /** Channel, thread and post names. */
  name: { min: 1, max: 100 },
  /** Channel topics: 1024, 4096 on forum and media channels. */
  topic: { channel: 1024, forum: 4096 },
  /** `rate_limit_per_user`, in seconds. */
  slowmode: { min: 0, max: 21600 },
  /** Nicknames. */
  nickname: 32,
  /** How far ahead a timeout may end (H-025). */
  timeoutDays: 28,
  /** Bulk delete: at most this many IDs, none older than this many days (H-092). */
  bulkDelete: { max: 100, maxAgeDays: 14 },
  /** A component's `custom_id` (H-130). */
  customId: 100
} as const

/** A string's length as Discord counts it (`Limits.unit`). */
export const lengthOf = (text: string): number => (Limits.unit === "code-point" ? [...text].length : text.length)

const embedChars = (embed: Embed): number =>
  lengthOf(embed.title ?? "") +
  lengthOf(embed.description ?? "") +
  (embed.fields ?? []).reduce((sum, field) => sum + lengthOf(field.name) + lengthOf(field.value), 0) +
  lengthOf(embed.footer?.text ?? "") +
  lengthOf(embed.author?.name ?? "")

/** The first embed limit `embeds` exceeds, by `EmbedTooLarge`'s names. */
export const embedLimitExceeded = (embeds: ReadonlyArray<Embed>): EmbedTooLarge["limit"] | undefined => {
  const limits = Limits.embeds
  if (embeds.length > limits.count) return "count"
  for (const embed of embeds) {
    if (lengthOf(embed.title ?? "") > limits.title) return "title"
    if (lengthOf(embed.description ?? "") > limits.description) return "description"
    if ((embed.fields ?? []).length > limits.fields) return "fields"
    for (const field of embed.fields ?? []) {
      if (lengthOf(field.name) > limits.fieldName) return "fieldName"
      if (lengthOf(field.value) > limits.fieldValue) return "fieldValue"
    }
    if (lengthOf(embed.footer?.text ?? "") > limits.footer) return "footer"
    if (lengthOf(embed.author?.name ?? "") > limits.author) return "author"
  }
  return embeds.reduce((sum, embed) => sum + embedChars(embed), 0) > limits.total ? "total" : undefined
}

/** The first poll limit `poll` exceeds, by `PollTooLarge`'s names. */
export const pollLimitExceeded = (poll: Poll): PollTooLarge["limit"] | undefined => {
  const limits = Limits.poll
  if (lengthOf(poll.question) > limits.question) return "question"
  if (poll.answers.length < 1 || poll.answers.length > limits.answers) return "answerCount"
  if (poll.answers.some((answer) => lengthOf(answer) > limits.answerText)) return "answerText"
  if (!Number.isInteger(poll.durationHours) || poll.durationHours < limits.minHours || poll.durationHours > limits.maxHours) return "duration"
  return undefined
}

/** A local failure: one of the payload- and argument-derived tags (§3.1). */
export type LocalFailure =
  | MessageEmpty
  | ContentTooLong
  | EmbedTooLarge
  | PollTooLarge
  | NameTooLong
  | TopicTooLong
  | SlowmodeOutOfRange
  | NicknameTooLong
  | TimeoutTooLong
  | TooManyMessagesToDelete
  | MessagesTooOld

const hasBody = (payload: MessagePayload): boolean => {
  if (isV2(payload)) return payload.componentsV2.length > 0 || (payload.files ?? []).length > 0
  const legacy: CreateMessage = payload
  return (
    (legacy.content ?? "").length > 0 ||
    (legacy.embeds ?? []).length > 0 ||
    (legacy.files ?? []).length > 0 ||
    (legacy.stickers ?? []).length > 0 ||
    legacy.poll !== undefined ||
    (legacy.components ?? []).length > 0
  )
}

/** The local problems of a create payload, in tier 7's order. */
export const checkCreate = (payload: MessagePayload, cause: ErrorCause): ReadonlyArray<LocalFailure> => {
  const out: Array<LocalFailure> = []
  if (!hasBody(payload)) out.push(new MessageEmpty({ cause }))
  if (isV2(payload)) return out
  const content = payload.content
  if (content !== undefined && lengthOf(content) > Limits.content) out.push(new ContentTooLong({ length: lengthOf(content), limit: Limits.content, cause }))
  const embed = embedLimitExceeded(payload.embeds ?? [])
  if (embed !== undefined) out.push(new EmbedTooLarge({ limit: embed, cause }))
  const poll = payload.poll === undefined ? undefined : pollLimitExceeded(payload.poll)
  if (poll !== undefined) out.push(new PollTooLarge({ limit: poll, cause }))
  return out
}

/**
 * The local problems of an edit, in tier 7's order. An edit's emptiness depends on what the message already
 * holds (its attachments), so it is left to Discord (50006, `MessageEmpty` when the type declares it).
 */
export const checkEdit = (patch: EditMessage, cause: ErrorCause): ReadonlyArray<LocalFailure> => {
  const out: Array<LocalFailure> = []
  if (patch.content !== undefined && lengthOf(patch.content) > Limits.content) out.push(new ContentTooLong({ length: lengthOf(patch.content), limit: Limits.content, cause }))
  const embed = embedLimitExceeded(patch.embeds ?? [])
  if (embed !== undefined) out.push(new EmbedTooLarge({ limit: embed, cause }))
  return out
}

/** A name outside 1..100 characters. */
export const checkName = (name: string, cause: ErrorCause): ReadonlyArray<LocalFailure> => {
  const length = lengthOf(name)
  return length < Limits.name.min || length > Limits.name.max ? [new NameTooLong({ length, limit: Limits.name.max, cause })] : []
}

/** A channel edit's problems: its name, topic (`forum`: the forum and media limit) and slowmode, in tier 7's order. */
export const checkChannelEdit = (
  patch: { readonly name?: string; readonly topic?: string; readonly slowmodeSeconds?: number },
  forum: boolean,
  cause: ErrorCause
): ReadonlyArray<LocalFailure> => {
  const out: Array<LocalFailure> = []
  if (patch.name !== undefined) out.push(...checkName(patch.name, cause))
  const topicLimit = forum ? Limits.topic.forum : Limits.topic.channel
  if (patch.topic !== undefined && lengthOf(patch.topic) > topicLimit) out.push(new TopicTooLong({ length: lengthOf(patch.topic), limit: topicLimit, cause }))
  const seconds = patch.slowmodeSeconds
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < Limits.slowmode.min || seconds > Limits.slowmode.max)) out.push(new SlowmodeOutOfRange({ seconds: Math.trunc(seconds), cause }))
  return out
}

/** A nickname over 32 characters (`null` clears it). */
export const checkNickname = (nick: string | null, cause: ErrorCause): ReadonlyArray<LocalFailure> =>
  nick !== null && lengthOf(nick) > Limits.nickname ? [new NicknameTooLong({ length: lengthOf(nick), limit: Limits.nickname, cause })] : []

const dayMs = 86_400_000

/** A timeout ending more than 28 days after `now` (Unix ms; `null` lifts it). */
export const checkTimeout = (until: Date | null, now: number, cause: ErrorCause): ReadonlyArray<LocalFailure> =>
  until !== null && until.getTime() - now > Limits.timeoutDays * dayMs ? [new TimeoutTooLong({ cause })] : []

/** When a snowflake was made (Unix ms): its top 42 bits after Discord's epoch, 2015-01-01. */
export const snowflakeTime = (id: MessageId): number => Number(BigInt(id) >> 22n) + 1_420_070_400_000

/** A bulk delete's problems: more than 100 IDs, or one older than 14 days at `now`. */
export const checkBulkDelete = (ids: ReadonlyArray<MessageId>, now: number, cause: ErrorCause): ReadonlyArray<LocalFailure> => {
  const out: Array<LocalFailure> = []
  if (ids.length > Limits.bulkDelete.max) out.push(new TooManyMessagesToDelete({ count: ids.length, cause }))
  if (ids.some((id) => now - snowflakeTime(id) > Limits.bulkDelete.maxAgeDays * dayMs)) out.push(new MessagesTooOld({ cause }))
  return out
}
