// Message payloads and the payload-to-permissions computation (DESIGN §2.3; pattern of [sd:src/channels-use.ts]
// §1-§6): each payload's flags, limit tags and degradable flags, judged member by member for a union payload.
import type { Effect } from "effect"
import { expectTypeOf } from "vitest"
import type { SentDegradable, TextChannel, PublicThread } from "../../../src/channels/Channel.ts"
import type {
  CommunicationDisabled,
  ContentTooLong,
  EmbedTooLarge,
  MessageEmpty,
  MissingAttachFiles,
  MissingEmbedLinks,
  MissingReadMessageHistoryForReply,
  MissingSendMessages,
  MissingSendMessagesInThreads,
  MissingSendPolls,
  MissingUseExternalStickers,
  MissingViewChannel,
  PermissionDeniedUnattributed,
  PollTooLarge,
  RateLimited,
  ThreadLocked,
  UnknownChannel
} from "../../../src/errors/index.ts"
import type { Transient } from "../../../src/permissions/Operations.ts"
import type { CreateMessage, MessagePayload } from "../../../src/payload/Message.ts"
import type { DegradableFlags, MayInclude, PayloadFlags } from "../../../src/payload/PayloadRules.ts"
import { MessageId, RoleId, StickerId } from "../../../src/Snowflake.ts"

declare const text: TextChannel
declare const thread: PublicThread
declare const dynamic: string
type Always = MissingViewChannel | MissingSendMessages | PermissionDeniedUnattributed | CommunicationDisabled | RateLimited | UnknownChannel | Transient

// 1. literal content: no ContentTooLong, no MessageEmpty, nothing degradable
const pong = text.send({ content: "pong" })
expectTypeOf<Effect.Error<typeof pong>>().toEqualTypeOf<Always>()
expectTypeOf<Effect.Success<typeof pong>["degraded"]>().toEqualTypeOf<ReadonlyArray<never>>()
// embeds add MissingEmbedLinks and EmbedTooLarge
const embed = text.send({ content: "hi", embeds: [{ title: "t" }] })
expectTypeOf<Effect.Error<typeof embed>>().toEqualTypeOf<Always | MissingEmbedLinks | EmbedTooLarge>()
// an empty embed list and tts: false add nothing
const quiet = text.send({ content: "hi", embeds: [], tts: false })
expectTypeOf<Effect.Error<typeof quiet>>().toEqualTypeOf<Always>()

// 2. dynamic or templated content may be too long or empty, and may carry a custom emoji (degraded, H-104)
const dyn = text.send({ content: dynamic })
expectTypeOf<Effect.Error<typeof dyn>>().toEqualTypeOf<Always | ContentTooLong | MessageEmpty>()
expectTypeOf<Effect.Success<typeof dyn>>().toEqualTypeOf<SentDegradable<"text", "UseExternalEmojis">>()
const templated = text.send({ content: `hello ${dynamic}` })
expectTypeOf<Effect.Error<typeof templated>>().toEqualTypeOf<Always | ContentTooLong>()
const emoji = text.send({ content: "look <:party:123456789012345678>" })
expectTypeOf<Effect.Success<typeof emoji>["degraded"]>().toEqualTypeOf<ReadonlyArray<"UseExternalEmojis">>()

// 2b. a finite literal is judged by its length (after the final audit): within the limit it carries no limit tag, over
// it it carries the tag, so a literal the local check refuses never fails with a tag its type omits. tsc counts code
// points, as Discord does: 2000 emoji fit.
type X10 = "xxxxxxxxxx"
type X100 = `${X10}${X10}${X10}${X10}${X10}${X10}${X10}${X10}${X10}${X10}`
type X1000 = `${X100}${X100}${X100}${X100}${X100}${X100}${X100}${X100}${X100}${X100}`
type E10 = "😀😀😀😀😀😀😀😀😀😀"
type E100 = `${E10}${E10}${E10}${E10}${E10}${E10}${E10}${E10}${E10}${E10}`
type E1000 = `${E100}${E100}${E100}${E100}${E100}${E100}${E100}${E100}${E100}${E100}`
declare const atLimit: `${X1000}${X1000}`
declare const overLimit: `${X1000}${X1000}x`
declare const emojiAtLimit: `${E1000}${E1000}`
const fits = text.send({ content: atLimit })
expectTypeOf<Effect.Error<typeof fits>>().toEqualTypeOf<Always>()
const fitsEmoji = text.send({ content: emojiAtLimit })
expectTypeOf<Effect.Error<typeof fitsEmoji>>().toEqualTypeOf<Always>()
const over = text.send({ content: overLimit })
expectTypeOf<Effect.Error<typeof over>>().toEqualTypeOf<Always | ContentTooLong>()
const overOrShort = text.send({ content: Math.random() > 0.5 ? "pong" : overLimit })
expectTypeOf<Effect.Error<typeof overOrShort>>().toEqualTypeOf<Always | ContentTooLong>()

// 3. a widened payload over-approximates every error-mode feature: CreateMessage and the union MessagePayload (T1)
type Widened = Always | ContentTooLong | MessageEmpty | MissingEmbedLinks | EmbedTooLarge | MissingAttachFiles | MissingReadMessageHistoryForReply | MissingSendPolls | PollTooLarge | MissingUseExternalStickers
declare const built: CreateMessage
const widened = text.send(built)
expectTypeOf<Effect.Error<typeof widened>>().toEqualTypeOf<Widened>()
declare const render: () => MessagePayload
const rendered = text.send(render())
expectTypeOf<Effect.Error<typeof rendered>>().toEqualTypeOf<Widened>()
expectTypeOf<Effect.Success<typeof rendered>["degraded"]>().toEqualTypeOf<ReadonlyArray<"MentionEveryone" | "SendTTSMessages" | "UseExternalEmojis">>()

// 4. threads: SendMessagesInThreads replaces SendMessages, ThreadLocked appears; a reply's RMH is the payload variant
const reply = thread.send({ content: "hi", reply: { messageId: MessageId.make("123456789012345678") } })
expectTypeOf<Effect.Error<typeof reply>>().toEqualTypeOf<
  MissingViewChannel | MissingSendMessagesInThreads | MissingReadMessageHistoryForReply | ThreadLocked | PermissionDeniedUnattributed | CommunicationDisabled | RateLimited | UnknownChannel | Transient
>()

// 5. stickers: a guild sticker adds nothing (H-138), an external one adds UseExternalStickers
const guildSticker = text.send({ stickers: [{ origin: "guild", id: StickerId.make("123456789012345678") }] })
expectTypeOf<Effect.Error<typeof guildSticker>>().toEqualTypeOf<Always>()
const externalSticker = text.send({ stickers: [{ origin: "external", id: StickerId.make("123456789012345678") }] })
expectTypeOf<Effect.Error<typeof externalSticker>>().toEqualTypeOf<Always | MissingUseExternalStickers>()

// 6. degradation is a typed result field, not an error: @everyone, a role mention, TTS (M4: mode degrade, H-102)
const everyone = text.send({ content: "@everyone hi", mentions: { everyone: true } })
expectTypeOf<Effect.Success<typeof everyone>["degraded"]>().toEqualTypeOf<ReadonlyArray<"MentionEveryone">>()
expectTypeOf<Effect.Error<typeof everyone>>().toEqualTypeOf<Always>()
const role = text.send({ content: "hi", mentions: { roles: [RoleId.make("123456789012345678")] } })
expectTypeOf<Effect.Success<typeof role>["degraded"]>().toEqualTypeOf<ReadonlyArray<"MentionEveryone">>()
const tts = text.send({ content: "hi", tts: true })
expectTypeOf<Effect.Success<typeof tts>["degraded"]>().toEqualTypeOf<ReadonlyArray<"SendTTSMessages">>()
expectTypeOf<Effect.Error<typeof tts>>().toEqualTypeOf<Always>()

// 7. a poll adds SendPolls and PollTooLarge; files add AttachFiles
const poll = text.send({ poll: { question: "q", answers: ["a", "b"], durationHours: 1 } })
expectTypeOf<Effect.Error<typeof poll>>().toEqualTypeOf<Always | MissingSendPolls | PollTooLarge>()
const file = text.send({ content: "f", files: [{ name: "a.txt", data: new Uint8Array() }] })
expectTypeOf<Effect.Error<typeof file>>().toEqualTypeOf<Always | MissingAttachFiles>()

// 8. presence is independent of mode: the table's flags and degradable flags per feature
expectTypeOf<PayloadFlags<{ readonly embeds: readonly [{ readonly title: "t" }] }>>().toEqualTypeOf<"EmbedLinks">()
expectTypeOf<DegradableFlags<{ readonly content: "hi"; readonly tts: true }>>().toEqualTypeOf<"SendTTSMessages">()
expectTypeOf<MayInclude<{ readonly embeds: readonly [] }, "embeds">>().toEqualTypeOf<false>()
expectTypeOf<MayInclude<CreateMessage, "poll">>().toEqualTypeOf<true>()
