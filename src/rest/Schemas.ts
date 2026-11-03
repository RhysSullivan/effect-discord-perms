/**
 * Response schemas (DESIGN §4.11, D12): the Discord objects the library reads, from REST responses and gateway
 * dispatches alike, so the reducer (`state/Reducer.ts`), the guild state's refresh, the recompute and the
 * operations decode one shape.
 *
 * - dfx casts every 2xx body to its generated type without validating it (dfx.md §3); the library decodes each
 *   body it acts on with these schemas instead. A 2xx body that does not decode is a defect naming the route
 *   template (`DiscordApi`).
 * - Snowflakes decode through the branded schemas of `Snowflake.ts`: this is where IDs are branded (D23).
 * - Only the fields the library reads are listed; excess fields are ignored. A channel's `type` is any integer:
 *   `state/Snapshot.ts` maps the modelled kinds (0..16, GuildMedia 16 included, which dfx's types lack) and
 *   leaves the others unmodelled.
 */
import { Schema } from "effect"
import { ChannelId, EmojiId, GuildId, MessageId, RoleId, UserId } from "../Snowflake.ts"

/** A permission bitfield as Discord serialises it: a decimal string. */
export const Bitfield = Schema.String.check(Schema.isPattern(/^\d+$/))

/** A user, as far as authorship needs it: whether it is a bot. */
export const User = Schema.Struct({
  id: UserId,
  bot: Schema.optionalKey(Schema.Boolean)
})
/** A user. */
export type User = typeof User.Type

/** A channel permission overwrite: `type` 0 is a role (the guild ID for `@everyone`), 1 a member. */
export const Overwrite = Schema.Struct({ id: Schema.String, type: Schema.Literals([0, 1]), allow: Bitfield, deny: Bitfield })
/** A channel permission overwrite. */
export type Overwrite = typeof Overwrite.Type

/** A guild channel or thread, from REST or the gateway (GUILD_CREATE's channels carry no `guild_id`). */
export const Channel = Schema.Struct({
  id: ChannelId,
  type: Schema.Int,
  guild_id: Schema.optionalKey(GuildId),
  parent_id: Schema.optionalKey(Schema.NullOr(ChannelId)),
  flags: Schema.optionalKey(Schema.Int),
  permission_overwrites: Schema.optionalKey(Schema.Array(Overwrite)),
  owner_id: Schema.optionalKey(UserId),
  thread_metadata: Schema.optionalKey(Schema.Struct({ archived: Schema.Boolean, locked: Schema.Boolean })),
  /** The bot's thread member object, present when it is a member (on GUILD_CREATE threads and REST reads). */
  member: Schema.optionalKey(Schema.Struct({}))
})
/** A guild channel or thread. */
export type Channel = typeof Channel.Type

/** A guild role. */
export const Role = Schema.Struct({ id: RoleId, permissions: Bitfield, position: Schema.Int, managed: Schema.Boolean })
/** A guild role. */
export type Role = typeof Role.Type

/** A guild member. */
export const Member = Schema.Struct({
  user: Schema.Struct({ id: UserId }),
  roles: Schema.Array(RoleId),
  /** Discord's `communication_disabled_until` (ISO 8601), absent or `null` when the member is not timed out. */
  communication_disabled_until: Schema.optionalKey(Schema.NullOr(Schema.String))
})
/** A guild member. */
export type Member = typeof Member.Type

/** A guild: its owner and roles (`GET /guilds/{guild.id}` and GUILD_UPDATE). */
export const Guild = Schema.Struct({ id: GuildId, owner_id: UserId, roles: Schema.Array(Role) })
/** A guild. */
export type Guild = typeof Guild.Type

/** A reaction on a message: the emoji (a custom one has an ID; a unicode one has only its name). */
export const Reaction = Schema.Struct({
  count: Schema.Int,
  me: Schema.Boolean,
  emoji: Schema.Struct({ id: Schema.NullOr(EmojiId), name: Schema.NullOr(Schema.String) })
})
/** A reaction. */
export type Reaction = typeof Reaction.Type

/**
 * A message: its author (authorship, `authorIsBot`), what the degradation readback compares (§4.12: content,
 * `mention_everyone`, `mention_roles`, `tts`, embeds, attachments, the poll and the reply reference) and its
 * reactions (conditional AddReactions, §4.7). Embeds, attachments and the poll are read for presence only.
 */
export const Message = Schema.Struct({
  id: MessageId,
  channel_id: ChannelId,
  type: Schema.Int,
  author: User,
  content: Schema.String,
  tts: Schema.Boolean,
  mention_everyone: Schema.Boolean,
  mention_roles: Schema.Array(RoleId),
  embeds: Schema.Array(Schema.Struct({})),
  attachments: Schema.Array(Schema.Struct({ id: Schema.String })),
  pinned: Schema.Boolean,
  flags: Schema.optionalKey(Schema.Int),
  reactions: Schema.optionalKey(Schema.Array(Reaction)),
  poll: Schema.optionalKey(Schema.NullOr(Schema.Struct({}))),
  message_reference: Schema.optionalKey(Schema.NullOr(Schema.Struct({ message_id: Schema.optionalKey(MessageId) })))
})
/** A message. */
export type Message = typeof Message.Type
