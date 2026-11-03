/**
 * Branded snowflake IDs (DESIGN §2.1, D23).
 *
 * Each kind of Discord object has its own brand, so a `UserId` cannot be passed where a `ChannelId` is
 * expected. A branded ID is still a `string`, so it reaches dfx without a cast.
 *
 * IDs are branded in one place only: when a response or an event payload is decoded through these schemas
 * (§4.11). `X.make(s)` is the trusted constructor for tests and literals; it throws on a malformed snowflake.
 */
import { Schema } from "effect"

/** A snowflake as Discord serialises it: a decimal string of 17 to 20 digits. */
const SnowflakeString = Schema.String.check(Schema.isPattern(/^\d{17,20}$/))

/** A channel, thread or DM channel ID. */
export const ChannelId = SnowflakeString.pipe(Schema.brand("ChannelId"))
/** A channel, thread or DM channel ID. */
export type ChannelId = typeof ChannelId.Type

/** A guild ID. It is also the ID of the guild's `@everyone` role. */
export const GuildId = SnowflakeString.pipe(Schema.brand("GuildId"))
/** A guild ID. It is also the ID of the guild's `@everyone` role. */
export type GuildId = typeof GuildId.Type

/** A user ID (bots are users too). */
export const UserId = SnowflakeString.pipe(Schema.brand("UserId"))
/** A user ID (bots are users too). */
export type UserId = typeof UserId.Type

/** A role ID. */
export const RoleId = SnowflakeString.pipe(Schema.brand("RoleId"))
/** A role ID. */
export type RoleId = typeof RoleId.Type

/** A message ID. */
export const MessageId = SnowflakeString.pipe(Schema.brand("MessageId"))
/** A message ID. */
export type MessageId = typeof MessageId.Type

/** An application ID. */
export const ApplicationId = SnowflakeString.pipe(Schema.brand("ApplicationId"))
/** An application ID. */
export type ApplicationId = typeof ApplicationId.Type

/** An application command ID. */
export const CommandId = SnowflakeString.pipe(Schema.brand("CommandId"))
/** An application command ID. */
export type CommandId = typeof CommandId.Type

/** An interaction ID. */
export const InteractionId = SnowflakeString.pipe(Schema.brand("InteractionId"))
/** An interaction ID. */
export type InteractionId = typeof InteractionId.Type

/** A custom emoji ID. */
export const EmojiId = SnowflakeString.pipe(Schema.brand("EmojiId"))
/** A custom emoji ID. */
export type EmojiId = typeof EmojiId.Type

/** A sticker ID. */
export const StickerId = SnowflakeString.pipe(Schema.brand("StickerId"))
/** A sticker ID. */
export type StickerId = typeof StickerId.Type

/** A forum or media channel's tag ID (a post's `applied_tags`). */
export const ForumTagId = SnowflakeString.pipe(Schema.brand("ForumTagId"))
/** A forum or media channel's tag ID (a post's `applied_tags`). */
export type ForumTagId = typeof ForumTagId.Type
