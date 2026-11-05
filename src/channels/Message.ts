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
 *
 * Every method is one shared method type with a generic `this` that carries the kind and the author, as `send` is
 * (`SendMethod`): every handle has the same property type, so a call on a union of handles (an event's message, or a
 * send's result in a union of channels) has one signature and gives one Effect, which a combinator can be piped onto
 * (after the final audit: each kind had its own function type, so such a call gave a union of Effects, and piping onto
 * it failed with a wall of types). The error union distributes over the handles, kind by kind.
 */
import type { Effect } from "effect"
import type { OpErrors, OpFlags, OpName, OpPermissionErrors, OpTags, Transient } from "../permissions/Operations.ts"
import type { EditArg, EditMessage, Emoji } from "../payload/Message.ts"
import type { ContentTooLongIn, EditEmbedTooLargeIn, EditMessageEmptyIn, NameTooLongIn } from "../payload/PayloadRules.ts"
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

/**
 * What a message method's `this` is: a message handle, by its kind and author. Structural, as `SendReceiver` is; the
 * implementations close over their handle, so a value re-typed to another kind would get that kind's error type for
 * the original's request (a deliberate re-typing; the library's handles never do it).
 */
export interface MessageReceiver {
  readonly channelKind: MessageKind
  readonly author: "self" | "other"
}

/** The kind of a message handle (a union for a union of handles). */
export type KindOf<M extends MessageReceiver> = M["channelKind"]

/** The reaction row of kind `K`. */
export type ReactOp<K extends MessageKind> = MsgOp<K, "message.react.channel", "message.react.thread", "message.react.voice">

/** A reaction's flags: the row's, plus UseExternalEmojis when `"external"` may be the emoji's origin (rule 4 of §2.12). */
export type ReactFlags<K extends MessageKind, E> = OpFlags[ReactOp<K>] | ("external" extends OriginOf<E> ? "UseExternalEmojis" : never)

/** A reaction's errors for handles `M`, kind by kind. */
export type ReactErrors<M extends MessageReceiver, E> = M extends MessageReceiver ? OpPermissionErrors[ReactOp<KindOf<M>>][ReactFlags<KindOf<M>, E>] | OpTags[ReactOp<KindOf<M>>] : never

/**
 * `PUT .../reactions/{emoji}/@me`. Discord needs AddReactions only for an emoji nobody has used on the message yet
 * (H-144), so `MissingAddReactions` stays in the type (a sound over-approximation) while preflight checks it only
 * when the handle's reactions prove the emoji is new (§4.7). A reaction needs no ReadMessageHistory (M4 live).
 */
export interface ReactMethod {
  <M extends MessageReceiver, const E extends Emoji>(this: M, emoji: E): Effect.Effect<void, ReactErrors<M, E> | Transient>
}

/** The pin row of kind `K`. */
export type PinOp<K extends MessageKind> = MsgOp<K, "message.pin.channel", "message.pin.thread">
/** The unpin row of kind `K`. */
export type UnpinOp<K extends MessageKind> = MsgOp<K, "message.unpin.channel", "message.unpin.thread">

/** `PUT /channels/{channel.id}/messages/pins/{message.id}`. ReadMessageHistory is checked as access (M4 live). */
export interface PinMethod {
  <M extends MessageReceiver>(this: M): Effect.Effect<void, OpErrors<never>[PinOp<KindOf<M>>]>
}
/** `DELETE /channels/{channel.id}/messages/pins/{message.id}`. */
export interface UnpinMethod {
  <M extends MessageReceiver>(this: M): Effect.Effect<void, OpErrors<never>[UnpinOp<KindOf<M>>]>
}

/** The thread kind a message's thread gets: an announcement thread in an announcement channel, else public. */
export type ThreadFrom<K extends MessageKind> = K extends "announcement" ? "announcement-thread" : "public-thread"

/** `POST /channels/{channel.id}/messages/{message.id}/threads`. A name that may be outside 1 to 100 characters adds `NameTooLong`. */
export interface CreateThreadFromMessage {
  <M extends MessageReceiver, const T extends { readonly name: string }>(this: M, thread: T): Effect.Effect<
    ChannelKinds<never>[ThreadFrom<KindOf<M>>],
    OpErrors<never>["channel.createThread.public"] | NameTooLongIn<T["name"]>
  >
}

/** Reacting: every kind with a guild. */
export interface Reacts {
  readonly react: ReactMethod
}

/** Pinning: text, announcement and thread messages (voice and stage text chat has no pins, M4 live). */
export interface Pinnable {
  readonly pin: PinMethod
  readonly unpin: UnpinMethod
}

/** Starting a thread from a message: text and announcement messages (threads from a message are public). */
export interface StartsThread {
  readonly createThread: CreateThreadFromMessage
}

/** The guild-only message operations of kind `K`. */
export type GuildOps<K extends MessageKind> = K extends "dm" ? unknown : K extends "voice" | "stage" ? Reacts : K extends "text" | "announcement" ? Reacts & Pinnable & StartsThread : Reacts & Pinnable

/** The crosspost row of a handle's author. */
export type CrosspostOp<M extends MessageReceiver> = M extends { readonly author: "self" } ? "message.crosspostOwn" : "message.crosspostForeign"

/** `POST /channels/{channel.id}/messages/{message.id}/crosspost`. ReadMessageHistory is checked as access (M4 live). */
export interface CrosspostMethod {
  <M extends MessageReceiver>(this: M): Effect.Effect<void, OpErrors<never>[CrosspostOp<M>]>
}

/** `crosspost` exists only on announcement messages (H-085). */
export type Crosspost<K extends MessageKind> = K extends "announcement" ? { readonly crosspost: CrosspostMethod } : unknown

/** The own-edit row of kind `K`. */
export type EditOp<K extends MessageKind> = MsgOp<K, "message.edit.channel", "message.edit.thread", "message.edit.voice">

/** What `edit` can be called on: the bot's own messages. */
export interface OwnReceiver extends MessageReceiver {
  readonly author: "self"
}

/**
 * `PATCH /channels/{channel.id}/messages/{message.id}`, resending `allowed_mentions` (H-111). Content that may be too
 * long adds `ContentTooLong`; non-empty embeds may be too large; content `""` or embeds `[]` may empty the message.
 */
export interface EditOwnMethod {
  <M extends OwnReceiver, const P extends EditMessage>(this: M, patch: EditArg<P>): Effect.Effect<
    OwnMessages<KindOf<M>>,
    | OpErrors<never>[EditOp<KindOf<M>>]
    | ContentTooLongIn<P>
    | EditEmbedTooLargeIn<P>
    | EditMessageEmptyIn<P>
  >
}

/** The own-delete row of kind `K`. */
export type DeleteOwnOp<K extends MessageKind> = MsgOp<K, "message.deleteOwn", "message.deleteOwn.thread", "message.deleteOwn.voice">
/** The foreign-delete row of kind `K`. */
export type DeleteForeignOp<K extends MessageKind> = MsgOp<K, "message.deleteForeign", "message.deleteForeign.thread", "message.deleteForeign.voice">
/** The delete row of handles `M`, kind by kind and author by author. */
export type DeleteOp<M extends MessageReceiver> = M extends { readonly author: "self" } ? DeleteOwnOp<KindOf<M>> : DeleteForeignOp<KindOf<M>>

/**
 * `DELETE /channels/{channel.id}/messages/{message.id}`: one's own message needs no ManageMessages, someone else's
 * does (H-089).
 */
export interface DeleteMethod {
  <M extends MessageReceiver>(this: M): Effect.Effect<void, OpErrors<never>[DeleteOp<M>]>
}

/** The bot's own message in one kind: `edit` exists only here. */
export type OwnMessage<K extends MessageKind> = MessageBase<K> &
  GuildOps<K> &
  Crosspost<K> & {
    readonly author: "self"
    readonly edit: EditOwnMethod
    readonly delete: DeleteMethod
  }

/** Someone else's message in one kind: no `edit`; `delete` adds MissingManageMessages (H-089). */
export type ForeignMessage<K extends MessageKind> = MessageBase<K> &
  GuildOps<K> &
  Crosspost<K> & {
    readonly author: "other"
    readonly authorId: UserId
    readonly authorIsBot: boolean
    readonly delete: DeleteMethod
  }

/** A union of kinds as a union of own-message handles (distributive). */
export type OwnMessages<K extends MessageKind> = K extends MessageKind ? OwnMessage<K> : never
/** A union of kinds as a union of foreign-message handles (distributive). */
export type ForeignMessages<K extends MessageKind> = K extends MessageKind ? ForeignMessage<K> : never
/** Any message of a kind in `K`. */
export type AnyMessage<K extends MessageKind> = OwnMessages<K> | ForeignMessages<K>
