/**
 * Message handles (DESIGN §2.5, `[sd:src/channels.ts]`). A message carries its author:
 *
 * - `OwnMessage<K>` is the bot's own message in a channel of kind `K`: only it has `edit`, and its `delete`
 *   needs no ManageMessages;
 * - `ForeignMessage<K>` is anyone else's: its `delete` adds `MissingManageMessages` (H-089), and `authorIsBot`
 *   lets a bot ignore other bots;
 * - `OwnMessages<K>` and `ForeignMessages<K>` distribute over a union of kinds, so `m.channelKind ===
 *   "announcement"` narrows to a handle that has `crosspost`.
 *
 * Operations exist only where Discord allows them: `crosspost` only in announcement channels (H-085), `pin` and
 * `unpin` not in voice or stage text chat, which has no pins (M4 live: 400 50019, H-159 refuted), threads from a
 * message only in text and announcement channels, and nothing but `edit` and `delete` in DMs. Every error union is
 * the operation table's row for the kind (`OpErrors<never>[Op]`) plus the argument-derived terms, written inline
 * so hovers print class names (rule 1 of §2.12). The library decides authorship at decode, by comparing the
 * author with the bot's user ID; `send` and `edit` return own messages.
 */
import type { Effect } from "effect"
import type { ContentTooLong, EmbedTooLarge, MessageEmpty, NameTooLong } from "../errors/Payload.ts"
import type { OpErrors, OpFlags, OpName, OpPermissionErrors, OpTags, Transient } from "../permissions/Operations.ts"
import type { EditArg, EditMessage, Emoji } from "../payload/Message.ts"
import type { EditMayEmpty, MayBeTooLong, MayExceed } from "../payload/PayloadRules.ts"
import type { ChannelId, GuildId, MessageId, UserId } from "../Snowflake.ts"
import type { ChannelKinds, MessageKind, ThreadKind } from "./Channel.ts"

/** The operation-table row a message operation uses in a channel of kind `K`: the thread, voice or channel one. */
export type MsgOp<K extends MessageKind, Channel extends OpName, Thread extends OpName, Voice extends OpName = Channel> = K extends ThreadKind ? Thread : K extends "voice" | "stage" ? Voice : Channel

/** What every message handle has. */
export interface MessageBase<K extends MessageKind> {
  readonly id: MessageId
  readonly channelId: ChannelId
  readonly channelKind: K
  /** `undefined` in a DM. */
  readonly guildId: K extends "dm" ? undefined : GuildId
}

type OriginOf<X> = X extends { readonly origin: infer O } ? O : never

/** The reaction row of kind `K`. */
export type ReactOp<K extends MessageKind> = MsgOp<K, "message.react.channel", "message.react.thread", "message.react.voice">

/** A reaction's flags: the row's, plus UseExternalEmojis when `"external"` may be the emoji's origin (rule 4 of §2.12). */
export type ReactFlags<K extends MessageKind, E> = OpFlags[ReactOp<K>] | ("external" extends OriginOf<E> ? "UseExternalEmojis" : never)

/**
 * `PUT .../reactions/{emoji}/@me`. Discord needs AddReactions only for an emoji nobody has used on the message yet
 * (H-144), so `MissingAddReactions` stays in the type (a sound over-approximation) while preflight checks it only
 * when the handle's reactions prove the emoji is new (§4.7). A reaction needs no ReadMessageHistory (M4 live).
 */
export interface ReactMethod<K extends MessageKind> {
  <const E extends Emoji>(emoji: E): Effect.Effect<void, OpPermissionErrors[ReactOp<K>][ReactFlags<K, E>] | OpTags[ReactOp<K>] | Transient>
}

/** The pin row of kind `K`. */
export type PinOp<K extends MessageKind> = MsgOp<K, "message.pin.channel", "message.pin.thread">
/** The unpin row of kind `K`. */
export type UnpinOp<K extends MessageKind> = MsgOp<K, "message.unpin.channel", "message.unpin.thread">

/** The thread kind a message's thread gets: an announcement thread in an announcement channel, else public. */
export type ThreadFrom<K extends MessageKind> = K extends "announcement" ? "announcement-thread" : "public-thread"

/** `POST /channels/{channel.id}/messages/{message.id}/threads`. A non-literal name may be too long. */
export interface CreateThreadFromMessage<K extends MessageKind> {
  <const T extends { readonly name: string }>(thread: T): Effect.Effect<ChannelKinds<never>[ThreadFrom<K>], OpErrors<never>["channel.createThread.public"] | (MayExceed<T["name"]> extends true ? NameTooLong : never)>
}

/** Reacting: every kind with a guild. */
export interface Reacts<K extends MessageKind> {
  readonly react: ReactMethod<K>
}

/** Pinning: text, announcement and thread messages (voice and stage text chat has no pins, M4 live). */
export interface Pinnable<K extends MessageKind> {
  /** `PUT /channels/{channel.id}/messages/pins/{message.id}`. ReadMessageHistory is checked as access (M4 live). */
  readonly pin: () => Effect.Effect<void, OpErrors<never>[PinOp<K>]>
  /** `DELETE /channels/{channel.id}/messages/pins/{message.id}`. */
  readonly unpin: () => Effect.Effect<void, OpErrors<never>[UnpinOp<K>]>
}

/** Starting a thread from a message: text and announcement messages (threads from a message are public). */
export interface StartsThread<K extends MessageKind> {
  readonly createThread: CreateThreadFromMessage<K>
}

/** The guild-only message operations of kind `K`. */
export type GuildOps<K extends MessageKind> = K extends "dm"
  ? unknown
  : K extends "voice" | "stage"
    ? Reacts<K>
    : K extends "text" | "announcement"
      ? Reacts<K> & Pinnable<K> & StartsThread<K>
      : Reacts<K> & Pinnable<K>

/** `crosspost` exists only on announcement messages (H-085). */
export type Crosspost<K extends MessageKind, Op extends "message.crosspostOwn" | "message.crosspostForeign"> = K extends "announcement"
  ? {
    /** `POST /channels/{channel.id}/messages/{message.id}/crosspost`. ReadMessageHistory is checked as access (M4 live). */
    readonly crosspost: () => Effect.Effect<void, OpErrors<never>[Op]>
  }
  : unknown

/** The own-edit row of kind `K`. */
export type EditOp<K extends MessageKind> = MsgOp<K, "message.edit.channel", "message.edit.thread", "message.edit.voice">

/**
 * `PATCH /channels/{channel.id}/messages/{message.id}`, resending `allowed_mentions` (H-111). Non-literal content
 * may be too long; non-empty embeds may be too large; content `""` or embeds `[]` may empty the message.
 */
export interface EditOwnMethod<K extends MessageKind> {
  <const P extends EditMessage>(patch: EditArg<P>): Effect.Effect<
    OwnMessage<K>,
    | OpErrors<never>[EditOp<K>]
    | (true extends MayBeTooLong<P> ? ContentTooLong : never)
    | (P extends { readonly embeds: infer E } ? (E extends readonly [] ? never : EmbedTooLarge) : never)
    | (EditMayEmpty<P> extends true ? MessageEmpty : never)
  >
}

/** The own-delete row of kind `K`. */
export type DeleteOwnOp<K extends MessageKind> = MsgOp<K, "message.deleteOwn", "message.deleteOwn.thread", "message.deleteOwn.voice">
/** The foreign-delete row of kind `K`. */
export type DeleteForeignOp<K extends MessageKind> = MsgOp<K, "message.deleteForeign", "message.deleteForeign.thread", "message.deleteForeign.voice">

/** The bot's own message in one kind: `edit` exists only here. */
export type OwnMessage<K extends MessageKind> = MessageBase<K> &
  GuildOps<K> &
  Crosspost<K, "message.crosspostOwn"> & {
    readonly author: "self"
    readonly edit: EditOwnMethod<K>
    /** `DELETE /channels/{channel.id}/messages/{message.id}`: one's own message needs no ManageMessages. */
    readonly delete: () => Effect.Effect<void, OpErrors<never>[DeleteOwnOp<K>]>
  }

/** Someone else's message in one kind: no `edit`; `delete` adds MissingManageMessages (H-089). */
export type ForeignMessage<K extends MessageKind> = MessageBase<K> &
  GuildOps<K> &
  Crosspost<K, "message.crosspostForeign"> & {
    readonly author: "other"
    readonly authorId: UserId
    readonly authorIsBot: boolean
    /** `DELETE /channels/{channel.id}/messages/{message.id}`: someone else's message needs ManageMessages. */
    readonly delete: () => Effect.Effect<void, OpErrors<never>[DeleteForeignOp<K>]>
  }

/** A union of kinds as a union of own-message handles (distributive). */
export type OwnMessages<K extends MessageKind> = K extends MessageKind ? OwnMessage<K> : never
/** A union of kinds as a union of foreign-message handles (distributive). */
export type ForeignMessages<K extends MessageKind> = K extends MessageKind ? ForeignMessage<K> : never
/** Any message of a kind in `K`. */
export type AnyMessage<K extends MessageKind> = OwnMessages<K> | ForeignMessages<K>
