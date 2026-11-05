// Channel kinds, messages carrying their author, members and require (DESIGN §2.4-§2.6; pattern of
// [sd:src/channels-use.ts] §7-§17, updated to the M4 operation table): the union receiver gives one Effect,
// require narrows, foreign deletes add ManageMessages, reactions add UseExternalEmojis only for an external emoji,
// and the argument limits follow the literal rule.
import { Effect } from "effect"
import { expectTypeOf } from "vitest"
import type {
  AnnouncementChannel,
  ForumChannel,
  MessageChannel,
  PrivateThread,
  PublicThread,
  Sent,
  TextChannel,
  VoiceChannel,
  AnnouncementThread
} from "../../../src/channels/Channel.ts"
import type { ForeignMessage, OwnMessage, OwnMessages } from "../../../src/channels/Message.ts"
import {
  catchCategory,
  type CommunicationDisabled,
  type ContentTooLong,
  type EmbedTooLarge,
  type MaximumActiveThreads,
  type MessageEmpty,
  type MissingConnect,
  type MissingEmbedLinks,
  type MissingManageChannels,
  type MissingManageNicknames,
  type MissingManageMessages,
  type MissingModerateMembers,
  type MissingReadMessageHistoryForReply,
  type MissingSendMessages,
  type MissingSendMessagesInThreads,
  type MissingUseExternalEmojis,
  type MissingViewChannel,
  type NameTooLong,
  type NicknameTooLong,
  type PermissionDeniedUnattributed,
  type PermissionRevokedSinceCheck,
  type RateLimited,
  type SlowmodeOutOfRange,
  type TagRequired,
  type TargetAboveInHierarchy,
  type TargetIsAdministrator,
  type ThreadLocked,
  type TimeoutTooLong,
  type TopicTooLong,
  type TwoFactorRequired,
  type UnknownChannel,
  type UnknownMember,
  type UnknownMessage
} from "../../../src/errors/index.ts"
import type { GuildMember } from "../../../src/members/Member.ts"
import type { OpErrors, Transient } from "../../../src/permissions/Operations.ts"
import { Permissions } from "../../../src/permissions/Require.ts"
import type { Emoji } from "../../../src/payload/Message.ts"
import { EmojiId, MessageId } from "../../../src/Snowflake.ts"

declare const text: TextChannel
declare const announcement: AnnouncementChannel
declare const voice: VoiceChannel
declare const forum: ForumChannel
declare const anyChannel: MessageChannel
declare const dynamic: string
declare const seconds: number

// a union receiver: the method spelling gives one Effect (T9), with the union of the kinds' rows
const union = anyChannel.send({ content: "pong" })
expectTypeOf<Effect.Error<typeof union>>().toEqualTypeOf<
  MissingViewChannel | MissingConnect | MissingSendMessages | MissingSendMessagesInThreads | ThreadLocked | PermissionDeniedUnattributed | CommunicationDisabled | RateLimited | UnknownChannel | Transient
>()
expectTypeOf<Effect.Success<typeof union>>().toEqualTypeOf<Sent<"announcement" | "announcement-thread" | "private-thread" | "public-thread" | "stage" | "text" | "voice">>()
// a send's message is the bot's own, of the channel's kind
expectTypeOf<Effect.Success<typeof union>["message"]>().toEqualTypeOf<OwnMessages<"announcement" | "announcement-thread" | "private-thread" | "public-thread" | "stage" | "text" | "voice">>()

// voice and stage text chat needs Connect (H-152)
const voiceSend = voice.send({ content: "hi" })
expectTypeOf<Effect.Error<typeof voiceSend>>().toEqualTypeOf<OpErrors<never>["voice.send"]>()
expectTypeOf<MissingConnect>().toExtend<Effect.Error<typeof voiceSend>>()

// require narrows: the checked flags become one PermissionRevokedSinceCheck (D8); require itself can refresh
const required = Effect.gen(function* () {
  const checked = yield* Permissions.require(text, ["SendMessages", "EmbedLinks"])
  return yield* checked.send({ content: "hi", embeds: [{ title: "t" }] })
})
expectTypeOf<Effect.Error<typeof required>>().toEqualTypeOf<
  MissingViewChannel | MissingSendMessages | MissingEmbedLinks | PermissionRevokedSinceCheck | EmbedTooLarge | PermissionDeniedUnattributed | CommunicationDisabled | RateLimited | UnknownChannel | Transient
>()
// require on a union receiver composes with send (T9: was a 2,864-character error)
const requiredUnion = Effect.gen(function* () {
  const checked = yield* Permissions.require(anyChannel, ["SendMessages"])
  return yield* checked.send({ content: "hi" })
})
expectTypeOf<Effect.Error<typeof requiredUnion>>().toEqualTypeOf<
  | MissingViewChannel
  | MissingConnect
  | MissingSendMessages
  | MissingSendMessagesInThreads
  | PermissionRevokedSinceCheck
  | ThreadLocked
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | RateLimited
  | UnknownChannel
  | Transient
>()
// require's own union, and the handle it returns
const req = Permissions.require(text, ["SendMessages", "EmbedLinks"])
expectTypeOf<Effect.Success<typeof req>>().toEqualTypeOf<TextChannel<"EmbedLinks" | "SendMessages">>()
expectTypeOf<Effect.Error<typeof req>>().toEqualTypeOf<MissingViewChannel | MissingSendMessages | MissingEmbedLinks | CommunicationDisabled | UnknownChannel | Transient>()

// authorship: a foreign delete adds MissingManageMessages (with 2FA and the timeout); an own one does not
declare const own: OwnMessage<"text">
declare const foreign: ForeignMessage<"text">
const foreignDelete = foreign.delete()
expectTypeOf<Effect.Error<typeof foreignDelete>>().toEqualTypeOf<MissingViewChannel | MissingManageMessages | TwoFactorRequired | CommunicationDisabled | PermissionDeniedUnattributed | UnknownChannel | UnknownMessage | Transient>()
const ownDelete = own.delete()
expectTypeOf<Effect.Error<typeof ownDelete>>().toEqualTypeOf<MissingViewChannel | PermissionDeniedUnattributed | UnknownChannel | UnknownMessage | Transient>()
// a reaction adds UseExternalEmojis only when the emoji may be external (rule 4 of §2.12)
const external: Emoji = { origin: "external", id: EmojiId.make("123456789012345678"), name: "x" }
const externalReaction = foreign.react(external)
expectTypeOf<Effect.Error<typeof externalReaction>>().toEqualTypeOf<OpErrors<never>["message.react.channel"] | MissingUseExternalEmojis>()
const unicodeReaction = foreign.react({ origin: "unicode", name: "👍" })
expectTypeOf<Effect.Error<typeof unicodeReaction>>().toEqualTypeOf<OpErrors<never>["message.react.channel"]>()

// a received message's kind narrows to a handle with crosspost (T12)
declare const received: OwnMessages<"text" | "announcement">
if (received.channelKind === "announcement") {
  const published = received.crosspost()
  expectTypeOf<Effect.Error<typeof published>>().toEqualTypeOf<OpErrors<never>["message.crosspostOwn"]>()
}

// catchCategory("payload") removes exactly the payload members of a send
const sendEmbed = text.send({ content: "hi", embeds: [{ title: "t" }] })
const payloadCaught = sendEmbed.pipe(catchCategory("payload", () => Effect.succeed(null)))
expectTypeOf<Effect.Error<typeof payloadCaught>>().toEqualTypeOf<OpErrors<never>["channel.send"]>()

// a forum post: the send-style union for its message (with the reply variant), the name and the row's tags
const post = forum.createPost({ name: dynamic, message: { content: dynamic, reply: { messageId: MessageId.make("123456789012345678") } } })
expectTypeOf<Effect.Error<typeof post>>().toEqualTypeOf<
  | MissingViewChannel
  | MissingSendMessages
  | MissingReadMessageHistoryForReply
  | ContentTooLong
  | MessageEmpty
  | NameTooLong
  | CommunicationDisabled
  | TagRequired
  | MaximumActiveThreads
  | RateLimited
  | PermissionDeniedUnattributed
  | UnknownChannel
  | Transient
>()
expectTypeOf<Effect.Success<typeof post>>().toEqualTypeOf<PublicThread<never>>()

// argument limits: a dynamic name, topic or slowmode may be out of range; a literal within its limit cannot, and one
// outside it may (after the final audit): an empty or 101-character name, a 1025-character topic, a slowmode of
// 99999, -1 or 1.5 (a literal of five digits or more keeps the tag: a sound over-approximation)
type N101 = "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn"
type T1024 = `${N101}${N101}${N101}${N101}${N101}${N101}${N101}${N101}${N101}${N101}tttttttttttttt`
declare const longName: N101
declare const longTopic: `${T1024}t`
const overName = text.createThread({ name: longName })
expectTypeOf<Effect.Error<typeof overName>>().toEqualTypeOf<OpErrors<never>["channel.createThread.public"] | NameTooLong>()
const emptyName = text.createThread({ name: "" })
expectTypeOf<Effect.Error<typeof emptyName>>().toEqualTypeOf<OpErrors<never>["channel.createThread.public"] | NameTooLong>()
const topicAtLimit: T1024 = `${longName}${longName}${longName}${longName}${longName}${longName}${longName}${longName}${longName}${longName}tttttttttttttt`
const fitsTopic = text.edit({ topic: topicAtLimit, slowmodeSeconds: 9999 })
expectTypeOf<Effect.Error<typeof fitsTopic>>().toEqualTypeOf<OpErrors<never>["channel.edit"]>()
const outside = text.edit({ name: longName, topic: longTopic, slowmodeSeconds: 99999 })
expectTypeOf<Effect.Error<typeof outside>>().toEqualTypeOf<OpErrors<never>["channel.edit"] | NameTooLong | TopicTooLong | SlowmodeOutOfRange>()
expectTypeOf<Effect.Error<ReturnType<typeof text.edit<{ readonly slowmodeSeconds: -1 }>>>>().toEqualTypeOf<OpErrors<never>["channel.edit"] | SlowmodeOutOfRange>()
expectTypeOf<Effect.Error<ReturnType<typeof text.edit<{ readonly slowmodeSeconds: 1.5 }>>>>().toEqualTypeOf<OpErrors<never>["channel.edit"] | SlowmodeOutOfRange>()
const dynamicEdit = text.edit({ name: dynamic, topic: dynamic, slowmodeSeconds: seconds })
expectTypeOf<Effect.Error<typeof dynamicEdit>>().toEqualTypeOf<OpErrors<never>["channel.edit"] | NameTooLong | TopicTooLong | SlowmodeOutOfRange>()
const literalEdit = text.edit({ name: "lab-text", topic: "a topic", slowmodeSeconds: 10 })
expectTypeOf<Effect.Error<typeof literalEdit>>().toEqualTypeOf<OpErrors<never>["channel.edit"]>()
const voiceEdit = voice.edit({ slowmodeSeconds: 10 })
expectTypeOf<MissingConnect | MissingManageChannels>().toExtend<Effect.Error<typeof voiceEdit>>()
const announcementEdit = announcement.edit({ topic: dynamic })
expectTypeOf<Effect.Error<typeof announcementEdit>>().toEqualTypeOf<OpErrors<never>["channel.edit"] | TopicTooLong>()

// thread creation: the flag follows the literal `private`; a thread from an announcement channel is an announcement thread
const publicThread = text.createThread({ name: "lab-thread" })
expectTypeOf<Effect.Success<typeof publicThread>>().toEqualTypeOf<PublicThread<never>>()
const privateThread = text.createThread({ name: dynamic, private: true })
expectTypeOf<Effect.Success<typeof privateThread>>().toEqualTypeOf<PrivateThread<never>>()
expectTypeOf<Effect.Error<typeof privateThread>>().toEqualTypeOf<OpErrors<never>["channel.createThread.private"] | NameTooLong>()
const announcementThread = announcement.createThread({ name: "lab-thread" })
expectTypeOf<Effect.Success<typeof announcementThread>>().toEqualTypeOf<AnnouncementThread<never>>()

// own edits: dynamic content may be too long or empty; non-empty embeds may be too large
const ownEdit = own.edit({ content: dynamic, embeds: [{ title: "t" }] })
expectTypeOf<Effect.Error<typeof ownEdit>>().toEqualTypeOf<OpErrors<never>["message.edit.channel"] | ContentTooLong | EmbedTooLarge | MessageEmpty>()
expectTypeOf<Effect.Success<typeof ownEdit>>().toEqualTypeOf<OwnMessage<"text">>()

// members: each union is its row, plus the argument limits (§2.6)
declare const member: GuildMember
const nick = member.setNickname(dynamic)
expectTypeOf<Effect.Error<typeof nick>>().toEqualTypeOf<
  MissingManageNicknames | TargetAboveInHierarchy | NicknameTooLong | PermissionDeniedUnattributed | CommunicationDisabled | UnknownMember | Transient
>()
const nickAtLimit = member.setNickname("kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk")
expectTypeOf<Effect.Error<typeof nickAtLimit>>().toEqualTypeOf<
  MissingManageNicknames | TargetAboveInHierarchy | PermissionDeniedUnattributed | CommunicationDisabled | UnknownMember | Transient
>()
const nickOver = member.setNickname("kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk")
expectTypeOf<Effect.Error<typeof nickOver>>().toEqualTypeOf<
  MissingManageNicknames | TargetAboveInHierarchy | NicknameTooLong | PermissionDeniedUnattributed | CommunicationDisabled | UnknownMember | Transient
>()
const timeout = member.timeout(new Date())
expectTypeOf<Effect.Error<typeof timeout>>().toEqualTypeOf<
  MissingModerateMembers | TargetAboveInHierarchy | TargetIsAdministrator | TimeoutTooLong | PermissionDeniedUnattributed | CommunicationDisabled | UnknownMember | Transient
>()
