// Hover markers for channels, payloads, messages, members and require (DESIGN §2.3-§2.6, §5.3; rule 1 of
// §2.12): each hover names classes and the handle types, never a structural object or an alias carrying the
// payload.
import type { Effect } from "effect"
import type { MessageChannel, TextChannel } from "../../src/channels/Channel.ts"
import type { ForeignMessage } from "../../src/channels/Message.ts"
import type { GuildMember } from "../../src/members/Member.ts"
import { Permissions } from "../../src/permissions/Require.ts"
import type { CreateMessage } from "../../src/payload/Message.ts"
import { ChannelId } from "../../src/Snowflake.ts"

declare const text: TextChannel
declare const anyChannel: MessageChannel
declare const foreign: ForeignMessage<"public-thread">
declare const member: GuildMember
declare const dynamic: string
declare const built: CreateMessage
/** The hovers print `Effect.Effect`, as in a file that imports `Effect`. */
export type Program = Effect.Effect<void>

export const id = ChannelId.make("123456789012345678")
//           ^? names: ChannelId

export const literal = text.send({ content: "pong" })
//           ^? names: Effect.Effect, Sent, MissingViewChannel, MissingSendMessages, CommunicationDisabled, Transient; no-object

export const embed = text.send({ content: "hi", embeds: [{ title: "t" }] })
//           ^? names: Effect.Effect, Sent, MissingEmbedLinks, EmbedTooLarge, MissingSendMessages; no-object

export const dynamicSend = text.send({ content: dynamic })
//           ^? names: Effect.Effect, SentDegradable, UseExternalEmojis, ContentTooLong, MessageEmpty; no-object

export const widened = text.send(built)
//           ^? names: Effect.Effect, SentDegradable, SendTTSMessages, MissingAttachFiles, MissingReadMessageHistoryForReply, MissingSendPolls, MissingUseExternalStickers; no-object

export const union = anyChannel.send({ content: "pong" })
//           ^? names: Effect.Effect, Sent, MissingConnect, MissingSendMessagesInThreads, ThreadLocked; no-object

export const required = Permissions.require(text, ["SendMessages", "EmbedLinks"])
//           ^? names: Effect.Effect, TextChannel, MissingEmbedLinks, MissingSendMessages, MissingViewChannel, CommunicationDisabled, UnknownChannel; no-object

declare const checked: TextChannel<"EmbedLinks" | "SendMessages">
export const afterRequire = checked.send({ content: "hi", embeds: [{ title: "t" }] })
//           ^? names: Effect.Effect, PermissionRevokedSinceCheck, EmbedTooLarge, MissingViewChannel; no-object

export const pin = foreign.pin()
//           ^? names: Effect.Effect, MissingPinMessages, MissingReadMessageHistory, ThreadArchived, MaximumPinsReached; no-object

export const kick = member.kick()
//           ^? names: Effect.Effect, MissingKickMembers, TargetAboveInHierarchy, TwoFactorRequired, UnknownMember; no-object
