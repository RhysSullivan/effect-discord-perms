/**
 * `payload` errors that are not permissions (DESIGN §3.1): fixable by removing, shortening or changing part of
 * the input. One tag per limit family. Most are checked locally before sending (basis `payload-check`) and are
 * also mapped from Discord's 50035 inner errors by path (§4.9). Limits live in `src/payload/Limits.ts`.
 */
import { Schema } from "effect"
import { CategorizedError } from "./Category.ts"
import { ErrorCause } from "./Cause.ts"

/** Message content is over the limit (H-120, H-121). */
export class ContentTooLong extends CategorizedError<ContentTooLong>()("ContentTooLong", {
  length: Schema.Int,
  limit: Schema.Int,
  cause: ErrorCause
}, ["payload"]) {}

/** An embed limit is exceeded; `limit` names which one. */
export class EmbedTooLarge extends CategorizedError<EmbedTooLarge>()("EmbedTooLarge", {
  limit: Schema.Literals(["count", "title", "description", "fields", "fieldName", "fieldValue", "footer", "author", "total"]),
  cause: ErrorCause
}, ["payload"]) {}

/** No body field is non-empty at run time (50006, H-083). */
export class MessageEmpty extends CategorizedError<MessageEmpty>()("MessageEmpty", { cause: ErrorCause }, ["payload"]) {}

/** A channel or thread name is outside 1..100 characters (createThread, createPost, edit). */
export class NameTooLong extends CategorizedError<NameTooLong>()("NameTooLong", {
  length: Schema.Int,
  limit: Schema.Int,
  cause: ErrorCause
}, ["payload"]) {}

/** A channel topic is over 1024 characters (4096 for forum and media). */
export class TopicTooLong extends CategorizedError<TopicTooLong>()("TopicTooLong", {
  length: Schema.Int,
  limit: Schema.Int,
  cause: ErrorCause
}, ["payload"]) {}

/**
 * `rate_limit_per_user` is outside 0..21600 seconds, or not a whole number (Discord accepts a fraction and stores it
 * truncated, so the local check refuses it rather than send a value Discord would change; live, after the final audit).
 */
export class SlowmodeOutOfRange extends CategorizedError<SlowmodeOutOfRange>()("SlowmodeOutOfRange", {
  seconds: Schema.Int,
  cause: ErrorCause
}, ["payload"]) {}

/** A nickname is over 32 characters. */
export class NicknameTooLong extends CategorizedError<NicknameTooLong>()("NicknameTooLong", {
  length: Schema.Int,
  limit: Schema.Int,
  cause: ErrorCause
}, ["payload"]) {}

/** `communication_disabled_until` is more than 28 days ahead (H-025). */
export class TimeoutTooLong extends CategorizedError<TimeoutTooLong>()("TimeoutTooLong", { cause: ErrorCause }, ["payload"]) {}

/** A poll limit is exceeded; `limit` names which one. */
export class PollTooLarge extends CategorizedError<PollTooLarge>()("PollTooLarge", {
  limit: Schema.Literals(["question", "answerCount", "answerText", "duration"]),
  cause: ErrorCause
}, ["payload"]) {}

/** A message to bulk delete is older than 14 days (50034; checked locally from the snowflake's age). */
export class MessagesTooOld extends CategorizedError<MessagesTooOld>()("MessagesTooOld", { cause: ErrorCause }, ["payload"]) {}

/** Bulk delete takes at most 100 messages (50016). At least 2 is a type rule. */
export class TooManyMessagesToDelete extends CategorizedError<TooManyMessagesToDelete>()("TooManyMessagesToDelete", {
  count: Schema.Int,
  cause: ErrorCause
}, ["payload"]) {}

/**
 * A `ComponentRoute` built a `custom_id` over 100 characters. Local only: no request exists, so there is no
 * cause.
 */
export class CustomIdTooLong extends CategorizedError<CustomIdTooLong>()("CustomIdTooLong", {
  route: Schema.String,
  length: Schema.Int
}, ["payload"]) {}

/** Every class in this module, keyed by class name. */
export const PayloadClasses = {
  ContentTooLong,
  EmbedTooLarge,
  MessageEmpty,
  NameTooLong,
  TopicTooLong,
  SlowmodeOutOfRange,
  NicknameTooLong,
  TimeoutTooLong,
  PollTooLarge,
  MessagesTooOld,
  TooManyMessagesToDelete,
  CustomIdTooLong
} as const
