/**
 * Event payloads (DESIGN §2.7, D23, D25; `[sd:src/bot.ts]`): what `Bot.on` hands a handler for each supported
 * event, as a function of the bot's declared intents, and the runtime decoding from Discord's dispatches.
 *
 * - **IDs are branded at decode** (D23), and every channel and message arrives as a library handle closing over
 *   the bot's runtime, so a handler can act on it (`event.channel.send(...)`, `event.message.crosspost()`).
 * - **`MESSAGE_CREATE` has a guild branch and a DM branch**, each only when its intent is declared
 *   (GuildMessages, DirectMessages). The DM branch has `guildId: undefined`, a `DMChannel` and content typed
 *   `string`.
 * - **`message.content` (D25).** Without MessageContent, Discord fills content only for the bot's own messages,
 *   messages that mention it, and DMs (H-172; a ping-on reply mentions the replied-to author, so it is the mention
 *   case). The library computes `contentDelivered` from exactly those (own, the bot in `mentions`, the intent
 *   declared, a DM) and puts a frozen {@link contentUnavailable} in `content` otherwise, so the type never lies
 *   about the runtime value: `if (m.contentDelivered)` narrows `content` to `string`. The live sessions hold the
 *   computation to what Discord delivered (`R-message-content`).
 * - **A dispatch the library cannot decode is dropped** (`Dropped`: a malformed payload, or a channel it cannot
 *   resolve), never passed on half-typed and never a failure of the event stream; `Bot.on` logs it.
 * - **Reaction emoji**: a dispatch does not say whether a custom emoji belongs to the guild, so a reaction's emoji
 *   is `unicode` or `custom` (LOG.md, "Design deviations", M7), not the send-side `guild`/`external` split.
 */
import { Effect, Schema } from "effect"
import { dmChannelHandle, dmMessageHandle } from "../channels/Direct.ts"
import type { DMChannel, GuildChannel, GuildMessageKind, MessageChannel } from "../channels/Channel.ts"
import type { ForeignMessages, OwnMessages } from "../channels/Message.ts"
import { channelHandle, messageHandle, type Runtime } from "../channels/Ops.ts"
import type { Transient } from "../errors/Transient.ts"
import * as Schemas from "../rest/Schemas.ts"
import { ChannelId, EmojiId, GuildId, MessageId, RoleId, UserId } from "../Snowflake.ts"
import { toChannel } from "../state/Reducer.ts"
import type { ChannelKind } from "../state/Snapshot.ts"
import type { EventName, Intent } from "./Intents.ts"

// ---- message content (D25) -------------------------------------------------------------------------------

/** The content of a message Discord did not deliver content for: a real runtime value, never a string. */
export interface ContentUnavailable {
  readonly _tag: "ContentUnavailable"
  readonly reason: "needs the MessageContent intent, or check message.contentDelivered first"
}

/** The one {@link ContentUnavailable} value the library puts in `content` (frozen). */
export const contentUnavailable: ContentUnavailable = Object.freeze({ _tag: "ContentUnavailable", reason: "needs the MessageContent intent, or check message.contentDelivered first" })

/** A message whose content Discord delivered. */
export interface Delivered {
  readonly contentDelivered: true
  readonly content: string
}

/** A message whose content Discord withheld (no MessageContent intent, and none of H-172's exceptions). */
export interface Undelivered {
  readonly contentDelivered: false
  readonly content: ContentUnavailable
}

/**
 * A guild message as a handler receives it: the bot's own (content always delivered), or someone else's (content
 * delivered with the intent; without it, only when the message mentions the bot). Discriminated by `author` and
 * `channelKind`, so narrowing reaches `edit` or `crosspost` (§2.5).
 */
export type ReceivedMessage<WithIntent extends boolean> =
  | (OwnMessages<GuildMessageKind> & Delivered)
  | (ForeignMessages<GuildMessageKind> & (WithIntent extends true ? Delivered : Delivered | Undelivered))

/** A DM: content is always delivered (H-172). */
export type DirectMessage = (OwnMessages<"dm"> | ForeignMessages<"dm">) & Delivered

// ---- payloads -------------------------------------------------------------------------------------------

/** A guild `MESSAGE_CREATE`. */
export interface GuildMessageCreate<WithIntent extends boolean> {
  readonly guildId: GuildId
  readonly channel: MessageChannel
  readonly message: ReceivedMessage<WithIntent>
}

/** A DM `MESSAGE_CREATE`. */
export interface DirectMessageCreate {
  readonly guildId: undefined
  readonly channel: DMChannel
  readonly message: DirectMessage
}

/** `MESSAGE_CREATE` for a bot declaring `I`: the guild branch with GuildMessages, the DM branch with DirectMessages. */
export type MessageCreate<I extends Intent> =
  | ("GuildMessages" extends I ? GuildMessageCreate<"MessageContent" extends I ? true : false> : never)
  | ("DirectMessages" extends I ? DirectMessageCreate : never)

/** `READY`: the session's bot user. */
export interface Ready {
  readonly userId: UserId
}

/** A reaction's emoji as a dispatch names it: unicode by name, or a custom emoji by ID (see the module comment). */
export type ReactionEmoji = { readonly origin: "unicode"; readonly name: string } | { readonly origin: "custom"; readonly id: EmojiId; readonly name: string | undefined }

/** `MESSAGE_REACTION_ADD`. */
export interface ReactionAdd {
  readonly guildId: GuildId | undefined
  readonly channelId: ChannelId
  readonly messageId: MessageId
  readonly userId: UserId
  readonly emoji: ReactionEmoji
}

/** `TYPING_START`. */
export interface TypingStart {
  readonly guildId: GuildId | undefined
  readonly channelId: ChannelId
  readonly userId: UserId
}

/** `GUILD_MEMBER_UPDATE`: a member's roles, nickname and timeout end (ISO 8601). */
export interface MemberUpdate {
  readonly guildId: GuildId
  readonly userId: UserId
  readonly roleIds: ReadonlyArray<RoleId>
  readonly nick: string | null
  readonly timedOutUntil: string | null
}

/**
 * `CHANNEL_UPDATE`: the channel's handle. A channel the bot cannot view arrives obfuscated (H-160, with the codec):
 * `obfuscated` is true, and its operations fail preflight with `MissingViewChannel`.
 */
export interface ChannelUpdate {
  readonly channel: GuildChannel
  readonly obfuscated: boolean
}

/** Each supported event's payload, for a bot declaring `I`. */
export interface EventPayloads<I extends Intent> {
  readonly READY: Ready
  readonly MESSAGE_CREATE: MessageCreate<I>
  readonly MESSAGE_REACTION_ADD: ReactionAdd
  readonly TYPING_START: TypingStart
  readonly GUILD_MEMBER_UPDATE: MemberUpdate
  readonly CHANNEL_UPDATE: ChannelUpdate
}

/**
 * Any decoded payload, as the runtime builds it before `Bot.on`'s typed handler sees it: a guild message's content
 * may be undelivered (it is delivered whenever the bot declares MessageContent, which the typed handler relies on).
 */
export type AnyEvent = Ready | GuildMessageCreate<false> | DirectMessageCreate | ReactionAdd | TypingStart | MemberUpdate | ChannelUpdate

// ---- decoding ---------------------------------------------------------------------------------------------

const ReadyWire = Schema.Struct({ user: Schema.Struct({ id: UserId }) })
const MessageExtras = Schema.Struct({ guild_id: Schema.optionalKey(GuildId), mentions: Schema.optionalKey(Schema.Array(Schemas.User)) })
const ReactionWire = Schema.Struct({
  user_id: UserId,
  channel_id: ChannelId,
  message_id: MessageId,
  guild_id: Schema.optionalKey(GuildId),
  emoji: Schema.Struct({ id: Schema.NullOr(EmojiId), name: Schema.NullOr(Schema.String) })
})
const TypingWire = Schema.Struct({ user_id: UserId, channel_id: ChannelId, guild_id: Schema.optionalKey(GuildId) })
const MemberWire = Schema.Struct({
  guild_id: GuildId,
  user: Schema.Struct({ id: UserId }),
  roles: Schema.Array(RoleId),
  nick: Schema.optionalKey(Schema.NullOr(Schema.String)),
  communication_disabled_until: Schema.optionalKey(Schema.NullOr(Schema.String))
})
const DMRecipients = Schema.Struct({ recipients: Schema.Array(Schema.Struct({ id: UserId })) })

/** A dispatch the library dropped instead of handing it to the handler, and why. */
export class Dropped extends Schema.TaggedError<Dropped>()("Dropped", {
  event: Schema.String,
  reason: Schema.Literals(["malformed", "unresolved"]),
  detail: Schema.String
}) {}

const decodeWith = <S extends Schema.Decoder<unknown>>(schema: S, event: EventName, data: unknown): Effect.Effect<S["Type"], Dropped> =>
  Schema.decodeUnknownEffect(schema)(data).pipe(Effect.mapError((error) => new Dropped({ event, reason: "malformed", detail: error.message })))

const isGuildMessageKind = (kind: ChannelKind): kind is GuildMessageKind => kind !== "category" && kind !== "forum" && kind !== "media"

/** The kind of `channel` from the guild state, refreshed over REST once when the state does not hold it (a thread not synced yet). */
const kindOf = (runtime: Runtime, guildId: GuildId, channel: ChannelId): Effect.Effect<ChannelKind | undefined, Transient> =>
  Effect.gen(function* () {
    const lookup = Effect.map(runtime.guildState.snapshot, (snapshot) => snapshot.guilds.get(guildId)?.channels.get(channel)?.kind)
    const known = yield* lookup
    if (known !== undefined) return known
    yield* runtime.guildState.refresh(guildId, channel)
    return yield* lookup
  })

/** `contentDelivered` (D25): the bot's own message, a mention of the bot, the intent declared, or a DM. */
export const contentDeliveredFor = (runtime: Runtime, message: Schemas.Message, mentions: ReadonlyArray<Schemas.User>, direct: boolean): boolean =>
  direct || message.author.id === runtime.identity.userId || mentions.some((user) => user.id === runtime.identity.userId) || runtime.intents.includes("MessageContent")

/** A received guild message with its content: the bot's own always delivered, another's as `delivered` says. */
const withContent = (handle: OwnMessages<GuildMessageKind> | ForeignMessages<GuildMessageKind>, delivered: boolean, content: string): ReceivedMessage<false> => {
  if (handle.author === "self") return { ...handle, contentDelivered: true, content }
  return delivered ? { ...handle, contentDelivered: true, content } : { ...handle, contentDelivered: false, content: contentUnavailable }
}

const messageCreate = (runtime: Runtime, data: unknown): Effect.Effect<GuildMessageCreate<false> | DirectMessageCreate, Dropped | Transient> =>
  Effect.gen(function* () {
    const message = yield* decodeWith(Schemas.Message, "MESSAGE_CREATE", data)
    const extras = yield* decodeWith(MessageExtras, "MESSAGE_CREATE", data)
    const mentions = extras.mentions ?? []
    const guildId = extras.guild_id
    if (guildId === undefined) {
      // a DM: the other party is the author, or (for the bot's own message) the channel's recipient
      const recipientId =
        message.author.id !== runtime.identity.userId
          ? message.author.id
          : (yield* runtime.api.read({
            route: { method: "GET", template: "/channels/{channel.id}" },
            call: (rest) => rest.getChannel(message.channel_id),
            response: DMRecipients,
            refusal: (response) => new Dropped({ event: "MESSAGE_CREATE", reason: "unresolved", detail: `the DM channel could not be read (${response.status} ${response.code})` })
          })).recipients[0]?.id
      if (recipientId === undefined) return yield* new Dropped({ event: "MESSAGE_CREATE", reason: "unresolved", detail: "a DM channel without a recipient" })
      const direct: DirectMessageCreate = {
        guildId: undefined,
        channel: dmChannelHandle(runtime, { id: message.channel_id, recipientId }),
        message: { ...dmMessageHandle(runtime, message.channel_id, message), contentDelivered: true, content: message.content }
      }
      return direct
    }
    const kind = yield* kindOf(runtime, guildId, message.channel_id)
    if (kind === undefined || !isGuildMessageKind(kind)) {
      return yield* new Dropped({ event: "MESSAGE_CREATE", reason: "unresolved", detail: `channel ${message.channel_id} is ${kind === undefined ? "not in the guild state" : `a ${kind}`}` })
    }
    const guild: GuildMessageCreate<false> = {
      guildId,
      channel: channelHandle(runtime, { guildId, id: message.channel_id, kind }),
      message: withContent(messageHandle(runtime, { guildId, id: message.channel_id, kind }, message), contentDeliveredFor(runtime, message, mentions, false), message.content)
    }
    return guild
  })

const obfuscatedFlag = 1 << 17

const channelUpdate = (runtime: Runtime, data: unknown): Effect.Effect<ChannelUpdate, Dropped> =>
  Effect.gen(function* () {
    const wire = yield* decodeWith(Schemas.Channel, "CHANNEL_UPDATE", data)
    const guildId = wire.guild_id
    const converted = toChannel(wire)
    if (guildId === undefined || converted._tag !== "Channel") {
      return yield* new Dropped({ event: "CHANNEL_UPDATE", reason: "unresolved", detail: `channel ${wire.id} (type ${wire.type}) is not a guild channel the library models` })
    }
    return { channel: channelHandle(runtime, { guildId, id: wire.id, kind: converted.channel.kind }), obfuscated: ((wire.flags ?? 0) & obfuscatedFlag) !== 0 }
  })

/**
 * Decodes the dispatch `event` with payload `data` for the bot of `runtime` (see the module comment): the payload a
 * handler receives, or `Dropped`. A channel lookup that got no answer fails with the `Transient`.
 */
export const decode = (runtime: Runtime, event: EventName, data: unknown): Effect.Effect<AnyEvent, Dropped | Transient> => {
  switch (event) {
    case "READY":
      return Effect.map(decodeWith(ReadyWire, event, data), (wire): Ready => ({ userId: wire.user.id }))
    case "MESSAGE_CREATE":
      return messageCreate(runtime, data)
    case "MESSAGE_REACTION_ADD":
      return Effect.map(decodeWith(ReactionWire, event, data), (wire): ReactionAdd => ({
        guildId: wire.guild_id,
        channelId: wire.channel_id,
        messageId: wire.message_id,
        userId: wire.user_id,
        emoji: wire.emoji.id === null ? { origin: "unicode", name: wire.emoji.name ?? "" } : { origin: "custom", id: wire.emoji.id, name: wire.emoji.name ?? undefined }
      }))
    case "TYPING_START":
      return Effect.map(decodeWith(TypingWire, event, data), (wire): TypingStart => ({ guildId: wire.guild_id, channelId: wire.channel_id, userId: wire.user_id }))
    case "GUILD_MEMBER_UPDATE":
      return Effect.map(decodeWith(MemberWire, event, data), (wire): MemberUpdate => ({
        guildId: wire.guild_id,
        userId: wire.user.id,
        roleIds: wire.roles,
        nick: wire.nick ?? null,
        timedOutUntil: wire.communication_disabled_until ?? null
      }))
    case "CHANNEL_UPDATE":
      return channelUpdate(runtime, data)
  }
}
