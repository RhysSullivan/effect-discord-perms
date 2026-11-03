// A payload's permissions are computed from its type (DESIGN §2.3, §2.5): each flag is in the error union exactly
// when the payload may carry its feature, so catching it on a payload without the feature is a compile error (a
// dead handler, like catchTag with an absent tag). Each @valid twin shows the feature brings the flag.
import { Effect } from "effect"
import type { PublicThread, TextChannel } from "../../../src/channels/Channel.ts"
import type { ForeignMessage, OwnMessage } from "../../../src/channels/Message.ts"
import { MessageId, RoleId, StickerId } from "../../../src/Snowflake.ts"

declare const text: TextChannel
declare const thread: PublicThread
declare const own: OwnMessage<"text">
declare const foreign: ForeignMessage<"text">
const handled = () => Effect.void
/** A send that drops nothing has `degraded: ReadonlyArray<never>`, which this accepts; any dropped flag is named. */
const none = (degraded: ReadonlyArray<"nothing dropped">) => degraded

// @valid
export const ok = [
  text.send({ content: "hi", embeds: [{ title: "t" }] }).pipe(Effect.catchTag("MissingEmbedLinks", handled)),
  text.send({ content: "hi", files: [{ name: "a.txt", data: new Uint8Array() }] }).pipe(Effect.catchTag("MissingAttachFiles", handled)),
  text.send({ poll: { question: "q", answers: ["a"], durationHours: 1 } }).pipe(Effect.catchTag("MissingSendPolls", handled)),
  text.send({ content: "hi", reply: { messageId: MessageId.make("123456789012345678") } }).pipe(Effect.catchTag("MissingReadMessageHistory", handled)),
  text.send({ stickers: [{ origin: "external", id: StickerId.make("123456789012345678") }] }).pipe(Effect.catchTag("MissingUseExternalStickers", handled)),
  text.send({ content: "hi" }).pipe(Effect.catchTag("MissingSendMessages", handled)),
  thread.send({ content: "hi" }).pipe(Effect.catchTag("MissingSendMessagesInThreads", handled)),
  foreign.delete().pipe(Effect.catchTag("MissingManageMessages", handled)),
  text.send({ content: "hi" }).pipe(Effect.map((sent) => none(sent.degraded)))
]

// @expect-error TS2345 MissingEmbedLinks
text.send({ content: "hi" }).pipe(Effect.catchTag("MissingEmbedLinks", handled))

// @expect-error TS2345 MissingAttachFiles
text.send({ content: "hi" }).pipe(Effect.catchTag("MissingAttachFiles", handled))

// @expect-error TS2345 MissingSendPolls
text.send({ content: "hi" }).pipe(Effect.catchTag("MissingSendPolls", handled))

// @expect-error TS2345 MissingReadMessageHistory
text.send({ content: "hi" }).pipe(Effect.catchTag("MissingReadMessageHistory", handled))

// @expect-error TS2345 MissingUseExternalStickers
text.send({ stickers: [{ origin: "guild", id: StickerId.make("123456789012345678") }] }).pipe(Effect.catchTag("MissingUseExternalStickers", handled))

// @expect-error TS2345 MissingSendMessages
thread.send({ content: "hi" }).pipe(Effect.catchTag("MissingSendMessages", handled))

// @expect-error TS2345 MissingManageMessages
own.delete().pipe(Effect.catchTag("MissingManageMessages", handled))

// @expect-error TS2345 SendTTSMessages
text.send({ content: "hi", tts: true }).pipe(Effect.map((sent) => none(sent.degraded)))

// @expect-error TS2345 UseExternalEmojis
text.send({ content: "look <:party:123456789012345678>" }).pipe(Effect.map((sent) => none(sent.degraded)))

// @expect-error TS2345 MentionEveryone
text.send({ content: "hi", mentions: { roles: [RoleId.make("123456789012345678")] } }).pipe(Effect.map((sent) => none(sent.degraded)))
