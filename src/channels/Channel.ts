/**
 * Channel kinds and their operations (DESIGN §2.4, `[sd:src/channels.ts]`).
 *
 * - Channels are a union keyed on `kind`, and an operation exists only on the kinds Discord allows it on: no
 *   `send` on categories, forums or media channels (forums have `createPost`, H-150, H-151), threads only from
 *   text and announcement channels (private ones only in text, H-041, H-154), thread operations only on threads.
 *   A missing operation is a one-line TS2339 that names the kind.
 * - Every error union is a lookup into the one operation table (`OpErrors<G>[Op]`), plus the payload- and
 *   argument-derived terms, written inline so hovers print class names (rule 1 of §2.12).
 * - `G` is the flags `Permissions.require` checked for the handle (D8): their `Missing*` become one
 *   `PermissionRevokedSinceCheck`. `granted` is a real runtime field.
 * - `send` is one shared method type with a generic `this` (`SendMethod`): every message kind has the same
 *   property type, so a call on a union of handles (an event's channel, or what `require` returns for one) has
 *   one signature and gives one Effect.
 */
import type { Effect } from "effect"
import type { PermissionFlag } from "../errors/Missing.generated.ts"
import type { OpErrors, OpFlags, OpPermissionErrors, OpTags, Revoked, Transient } from "../permissions/Operations.ts"
import type { Invalid } from "../payload/Components.ts"
import type { CreateArg, MessagePayload } from "../payload/Message.ts"
import type { ContentTooLongIn, DegradableFlags, EmbedTooLargeIn, MessageEmptyIn, NameTooLongIn, PatchNameTooLongIn, PatchSlowmodeOutOfRangeIn, PatchTopicTooLongIn, PayloadFlags, PollTooLargeIn } from "../payload/PayloadRules.ts"
import type { ChannelId, ForumTagId, GuildId, MessageId, UserId } from "../Snowflake.ts"
import type { AnyMessage, OwnMessages } from "./Message.ts"

export type { Transient } from "../permissions/Operations.ts"

/** The guild channel kinds the library models (types 0, 2, 4, 5, 10, 11, 12, 13, 15, 16). */
export type GuildChannelKind = "text" | "announcement" | "voice" | "stage" | "category" | "forum" | "media" | "public-thread" | "private-thread" | "announcement-thread"
/** The thread kinds. */
export type ThreadKind = "public-thread" | "private-thread" | "announcement-thread"
/** The kinds that carry messages. `"dm"` has no guild, no overwrites and no permission checks. */
export type MessageKind = "text" | "announcement" | "voice" | "stage" | ThreadKind | "dm"
/** The guild kinds that carry messages. */
export type GuildMessageKind = Exclude<MessageKind, "dm">

/** A successful send: the bot's own message, and the payload features Discord silently dropped (none here). */
export interface Sent<K extends MessageKind> {
  readonly message: OwnMessages<K>
  readonly degraded: ReadonlyArray<never>
}
/**
 * A successful send of a payload that may degrade: `degraded` lists the flags whose absence made Discord drop a
 * feature (D35, §4.12): the message was sent, but, for example, `@everyone` pinged nobody.
 */
export interface SentDegradable<K extends MessageKind, D extends PermissionFlag> {
  readonly message: OwnMessages<K>
  readonly degraded: ReadonlyArray<D>
}

/** The send row of each message kind (§2.4). */
export interface SendOpByKind {
  readonly text: "channel.send"
  readonly announcement: "channel.send"
  readonly voice: "voice.send"
  readonly stage: "voice.send"
  readonly "public-thread": "thread.send"
  readonly "private-thread": "thread.send"
  readonly "announcement-thread": "thread.send"
  readonly dm: "dm.send"
}

/**
 * Anything `send` can be called on: a kind and the flags `require` checked (structural, so `require`'s handles fit).
 * The implementation closes over its handle and ignores `this`, so the error type is the one of the handle's real kind
 * only while `this` is a library handle; a value deliberately re-typed around a handle's `send` (an object literal
 * claiming `kind: "dm"`) gets the type of the kind it claims. That is a trust assumption, not a check: no cast is
 * needed to write one, but nothing in the library or an ordinary bot does (after the final audit; `MessageReceiver`
 * is the same).
 */
export interface SendReceiver {
  readonly kind: MessageKind
  readonly granted: ReadonlyArray<PermissionFlag>
}

/** The flags `Permissions.require` checked for a handle. */
export type GrantedOf<C> = C extends { readonly granted: ReadonlyArray<infer G extends PermissionFlag> } ? G : never

/** Payload permissions apply only in guild channels. */
type GuildPayloadFlags<C extends SendReceiver, P> = [Exclude<C["kind"], "dm">] extends [never] ? never : PayloadFlags<P>

/** Every flag a send of `P` on `C` needs. */
export type SendFlags<C extends SendReceiver, P> = OpFlags[SendOpByKind[C["kind"]]] | GuildPayloadFlags<C, P>

/** What a send of `P` on `C` succeeds with: `Sent`, or `SentDegradable` with the flags when `P` may degrade. */
export type SendSuccess<C extends SendReceiver, P> = [DegradableFlags<P>] extends [never] ? Sent<C["kind"]> : SentDegradable<C["kind"], Extract<DegradableFlags<P>, PermissionFlag>>

/**
 * `POST /channels/{channel.id}/messages`: one method type shared by every message kind; `this` carries the kind
 * and the granted flags, so the same signature serves a narrowed handle, a union, and a handle from `require`.
 * Payload shape rules are checked on the argument (`CheckCreate`); the payload's flags join the row's; a
 * non-literal content may be too long, a payload that may be empty adds `MessageEmpty`, embeds `EmbedTooLarge`
 * and a poll `PollTooLarge` (§2.3). A payload that may degrade returns `SentDegradable` with the flags as a
 * literal union.
 */
export interface SendMethod {
  <C extends SendReceiver, const P extends MessagePayload>(this: C, payload: CreateArg<P>): Effect.Effect<
    SendSuccess<C, P>,
    | OpPermissionErrors[SendOpByKind[C["kind"]]][Exclude<SendFlags<C, P>, GrantedOf<C>>]
    | Revoked<SendFlags<C, P>, GrantedOf<C>>
    | ContentTooLongIn<P>
    | MessageEmptyIn<P>
    | EmbedTooLargeIn<P>
    | PollTooLargeIn<P>
    | OpTags[SendOpByKind[C["kind"]]]
    | Transient
  >
}

/** Where preflight reads a handle's permissions: the gateway state, or an interaction's `app_permissions` (§4.7). */
export type Basis = "gateway-state" | "app-permissions"

interface ChannelBase<K extends GuildChannelKind, G extends PermissionFlag> {
  readonly kind: K
  readonly id: ChannelId
  readonly guildId: GuildId
  /** The flags a `Permissions.require` call checked for this handle (D8; a runtime field). */
  readonly granted: ReadonlyArray<G>
  readonly basis: Basis
}

interface Sendable {
  readonly send: SendMethod
}

/** The fields a channel edit may set. */
export interface ChannelPatch {
  readonly name?: string
  readonly topic?: string
  readonly slowmodeSeconds?: number
}

/** A field the kind does not have is an error at that property. */
export type KnownPatch<P, Fields extends string> = [Exclude<keyof P, Fields>] extends [never] ? unknown : { readonly [K in Exclude<keyof P, Fields>]: P[K] & Invalid<`${K & string} cannot be edited on this channel kind`> }

/** A channel edit argument: the patch with its check (an alias, so the signature relates to itself; see `CreateArg`). */
export type PatchArg<P, Fields extends string> = P & KnownPatch<P, Fields>

/** Editing a channel or thread: only the fields the kind has; non-literal values may exceed their limits. */
export interface Editable<Op extends "channel.edit" | "voice.edit" | "thread.edit", G extends PermissionFlag, Fields extends keyof ChannelPatch> {
  /** `PATCH /channels/{channel.id}`. */
  readonly edit: <const P extends ChannelPatch>(patch: PatchArg<P, Fields>) => Effect.Effect<
    void,
    | OpErrors<G>[Op]
    | PatchNameTooLongIn<P>
    | PatchTopicTooLongIn<P>
    | PatchSlowmodeOutOfRangeIn<P>
  >
}

/** Announcement channels have public threads only (H-041, H-154): `private: true` is an error at the property. */
export type PrivateCheck<T, Private extends boolean> = Private extends false ? (T extends { readonly private: true } ? { readonly private: Invalid<"announcement channels only have public threads"> } : unknown) : unknown

/** A thread creation argument: the thread with its check (an alias, so the signature relates to itself; see `CreateArg`). */
export type ThreadArg<T, Private extends boolean> = T & PrivateCheck<T, Private>

/** What `createThread` makes: a private thread for `private: true`, else the channel's public kind (both for a `boolean`). */
export type ThreadOf<T, Public extends ThreadKind> = T extends { readonly private: true } ? "private-thread" : T extends { readonly private: false } ? Public : boolean extends (T extends { readonly private: infer B } ? B : false) ? Public | "private-thread" : Public

/** The row a thread creation uses. */
export type CreateThreadOp<T> = T extends { readonly private: true }
  ? "channel.createThread.private"
  : T extends { readonly private: false }
    ? "channel.createThread.public"
    : boolean extends (T extends { readonly private: infer B } ? B : false)
      ? "channel.createThread.public" | "channel.createThread.private"
      : "channel.createThread.public"

/** Starting a thread without a message (text: public or private; announcement: public only). */
export interface StartsThreads<Private extends boolean, Public extends ThreadKind, G extends PermissionFlag> {
  /** `POST /channels/{channel.id}/threads`. A non-literal name may be too long. */
  readonly createThread: <const T extends { readonly name: string; readonly private?: boolean }>(thread: ThreadArg<T, Private>) => Effect.Effect<
    ChannelKinds<never>[ThreadOf<T, Public>],
    OpErrors<G>[CreateThreadOp<T>] | NameTooLongIn<T["name"]>
  >
}

/** What a pins list returns: the messages, and `ReadMessageHistory` in `degraded` when it came back empty without it (H-107). */
export interface PinsList {
  readonly messages: ReadonlyArray<AnyMessage<GuildMessageKind>>
  readonly degraded: ReadonlyArray<"ReadMessageHistory">
}

/** Listing a channel's pins. */
export interface Pins<G extends PermissionFlag, Op extends "channel.pins" | "voice.pins" = "channel.pins"> {
  /** `GET /channels/{channel.id}/messages/pins`. Without ReadMessageHistory Discord returns an empty list (H-107). */
  readonly pins: () => Effect.Effect<PinsList, OpErrors<G>[Op]>
}

/** Bulk deletion: at least 2 IDs is a type rule; more than 100, and any older than 14 days, are checked locally. */
export interface BulkDeletes<G extends PermissionFlag, Op extends "channel.bulkDelete" | "thread.bulkDelete" | "voice.bulkDelete"> {
  /** `POST /channels/{channel.id}/messages/bulk-delete`. */
  readonly bulkDelete: (ids: readonly [MessageId, MessageId, ...Array<MessageId>]) => Effect.Effect<void, OpErrors<G>[Op]>
}

/** A forum or media post: a public thread with its first message (H-031: needs SendMessages). */
export interface PostsMessages<G extends PermissionFlag> {
  /** `POST /channels/{channel.id}/threads` with `message`. `tags` are the forum's tag IDs (a channel may require one, H-044). */
  readonly createPost: <const N extends string, const P extends MessagePayload>(post: { readonly name: N; readonly message: CreateArg<P>; readonly tags?: ReadonlyArray<ForumTagId> }) => Effect.Effect<
    PublicThread<never>,
    | OpPermissionErrors["forum.createPost"][Exclude<OpFlags["forum.createPost"] | PayloadFlags<P>, G>]
    | Revoked<OpFlags["forum.createPost"] | PayloadFlags<P>, G>
    | ContentTooLongIn<P>
    | MessageEmptyIn<P>
    | EmbedTooLargeIn<P>
    | PollTooLargeIn<P>
    | NameTooLongIn<N>
    | OpTags["forum.createPost"]
    | Transient
  >
}

/** The operations of a thread. */
export interface ThreadOps<G extends PermissionFlag> {
  /** `PUT /channels/{channel.id}/thread-members/@me`. */
  readonly join: () => Effect.Effect<void, OpErrors<G>["thread.join"]>
  /** `DELETE /channels/{channel.id}/thread-members/@me`: needs no View (M4 live). */
  readonly leave: () => Effect.Effect<void, OpErrors<G>["thread.leave"]>
  /** `PUT /channels/{channel.id}/thread-members/{user.id}`. */
  readonly addMember: (user: UserId) => Effect.Effect<void, OpErrors<G>["thread.addMember"]>
  /** `PATCH /channels/{channel.id}` with `archived`: archiving needs ManageThreads (its creator excepted), unarchiving only SendMessagesInThreads (H-038). */
  readonly setArchived: <const A extends boolean>(archived: A) => Effect.Effect<void, OpErrors<G>[A extends true ? "thread.setArchived" : "thread.unarchive"]>
  /** `PATCH /channels/{channel.id}` with `locked`. */
  readonly setLocked: (locked: boolean) => Effect.Effect<void, OpErrors<G>["thread.setLocked"]>
  /** `DELETE /channels/{channel.id}`: needs ManageThreads, except for its creator (M4 live). */
  readonly delete: () => Effect.Effect<void, OpErrors<G>["thread.delete"]>
}

/** A text channel (type 0). */
export interface TextChannel<G extends PermissionFlag = never>
  extends ChannelBase<"text", G>, Sendable, Editable<"channel.edit", G, "name" | "topic" | "slowmodeSeconds">, StartsThreads<boolean, "public-thread", G>, Pins<G>, BulkDeletes<G, "channel.bulkDelete"> {}
/**
 * An announcement channel (type 5): public threads only (H-154), crossposts. It takes a slowmode too (M6 live:
 * `rule/text-manage-channels/raw-slowmode-announcement` applied `rate_limit_per_user`, H-054 refuted).
 */
export interface AnnouncementChannel<G extends PermissionFlag = never>
  extends ChannelBase<"announcement", G>, Sendable, Editable<"channel.edit", G, "name" | "topic" | "slowmodeSeconds">, StartsThreads<false, "announcement-thread", G>, Pins<G>, BulkDeletes<G, "channel.bulkDelete"> {}
/** A voice channel's text chat (type 2): everything needs Connect (H-152), no topic, no pins (M4 live). */
export interface VoiceChannel<G extends PermissionFlag = never>
  extends ChannelBase<"voice", G>, Sendable, Editable<"voice.edit", G, "name" | "slowmodeSeconds">, Pins<G, "voice.pins">, BulkDeletes<G, "voice.bulkDelete"> {}
/** A stage channel's text chat (type 13): like voice (H-153), but with a topic (M6 live: `raw-topic-stage` applied it). */
export interface StageChannel<G extends PermissionFlag = never>
  extends ChannelBase<"stage", G>, Sendable, Editable<"voice.edit", G, "name" | "topic" | "slowmodeSeconds">, Pins<G, "voice.pins">, BulkDeletes<G, "voice.bulkDelete"> {}
/** A category (type 4): no messages (H-151). */
export interface CategoryChannel<G extends PermissionFlag = never> extends ChannelBase<"category", G>, Editable<"channel.edit", G, "name"> {}
/** A forum (type 15): no messages, only posts (H-150). */
export interface ForumChannel<G extends PermissionFlag = never> extends ChannelBase<"forum", G>, Editable<"channel.edit", G, "name" | "topic" | "slowmodeSeconds">, PostsMessages<G> {}
/** A media channel (type 16): like a forum. */
export interface MediaChannel<G extends PermissionFlag = never> extends ChannelBase<"media", G>, Editable<"channel.edit", G, "name" | "topic" | "slowmodeSeconds">, PostsMessages<G> {}
/** A public thread (type 11), forum posts included. */
export interface PublicThread<G extends PermissionFlag = never>
  extends ChannelBase<"public-thread", G>, Sendable, Editable<"thread.edit", G, "name" | "slowmodeSeconds">, ThreadOps<G>, Pins<G>, BulkDeletes<G, "thread.bulkDelete"> {}
/** A private thread (type 12): visible only to its members and to ManageThreads holders (H-033, H-047). */
export interface PrivateThread<G extends PermissionFlag = never>
  extends ChannelBase<"private-thread", G>, Sendable, Editable<"thread.edit", G, "name" | "slowmodeSeconds">, ThreadOps<G>, Pins<G>, BulkDeletes<G, "thread.bulkDelete"> {}
/** An announcement thread (type 10). */
export interface AnnouncementThread<G extends PermissionFlag = never>
  extends ChannelBase<"announcement-thread", G>, Sendable, Editable<"thread.edit", G, "name" | "slowmodeSeconds">, ThreadOps<G>, Pins<G>, BulkDeletes<G, "thread.bulkDelete"> {}

/** A DM channel: send only; no guild, overwrites or `Permissions.require`. */
export interface DMChannel {
  readonly kind: "dm"
  readonly id: ChannelId
  readonly recipientId: UserId
  readonly granted: ReadonlyArray<never>
  readonly send: SendMethod
}

/** Kind to handle, used to re-type a handle after `require` (hovers show, for example, `TextChannel<"EmbedLinks">`). */
export interface ChannelKinds<G extends PermissionFlag> {
  readonly text: TextChannel<G>
  readonly announcement: AnnouncementChannel<G>
  readonly voice: VoiceChannel<G>
  readonly stage: StageChannel<G>
  readonly category: CategoryChannel<G>
  readonly forum: ForumChannel<G>
  readonly media: MediaChannel<G>
  readonly "public-thread": PublicThread<G>
  readonly "private-thread": PrivateThread<G>
  readonly "announcement-thread": AnnouncementThread<G>
}

/** Any guild channel. */
export type GuildChannel = ChannelKinds<never>[GuildChannelKind]
/** A guild channel where a message can be posted (a guild MESSAGE_CREATE's channel). */
export type MessageChannel = ChannelKinds<never>["text" | "announcement" | "voice" | "stage" | ThreadKind]
/** A thread. */
export type ThreadChannel = ChannelKinds<never>[ThreadKind]

/** A guild channel with `F` checked by `Permissions.require` too (distributes over a union). */
export type WithGranted<C extends GuildChannel, F extends PermissionFlag> = C extends GuildChannel ? ChannelKinds<GrantedOf<C> | F>[C["kind"]] : never

const messageKinds: ReadonlySet<GuildChannelKind> = new Set<GuildChannelKind>(["text", "announcement", "voice", "stage", "public-thread", "private-thread", "announcement-thread"])

/** Whether a guild channel carries messages. */
export const isMessageChannel = (channel: GuildChannel): channel is MessageChannel => messageKinds.has(channel.kind)
