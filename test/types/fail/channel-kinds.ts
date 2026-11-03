// Operations exist only on the kinds Discord allows them on (DESIGN §2.4, §2.5): each absent operation is a
// one-line TS2339 naming the kind, and each field or option a kind lacks is an error at that property.
import type { AnnouncementChannel, CategoryChannel, ForumChannel, StageChannel, TextChannel, VoiceChannel } from "../../../src/channels/Channel.ts"
import type { ForeignMessage, OwnMessage } from "../../../src/channels/Message.ts"
import { MessageId } from "../../../src/Snowflake.ts"

declare const category: CategoryChannel
declare const forum: ForumChannel
declare const text: TextChannel
declare const voice: VoiceChannel
declare const stage: StageChannel
declare const announcement: AnnouncementChannel
declare const ownInText: OwnMessage<"text">
declare const ownInAnnouncement: OwnMessage<"announcement">
declare const foreign: ForeignMessage<"text">
declare const inVoice: ForeignMessage<"voice">
const one = MessageId.make("123456789012345678")
const two = MessageId.make("123456789012345679")

// @valid
export const ok = [
  text.send({ content: "hi" }),
  forum.createPost({ name: "lab-post", message: { content: "hi" } }),
  ownInAnnouncement.crosspost(),
  voice.edit({ name: "lab-voice" }),
  text.edit({ topic: "a topic", slowmodeSeconds: 5 }),
  stage.edit({ topic: "a stage topic", slowmodeSeconds: 5 }),
  announcement.edit({ slowmodeSeconds: 5 }),
  text.createThread({ name: "lab-thread", private: true }),
  announcement.createThread({ name: "lab-thread" }),
  foreign.pin(),
  inVoice.react({ origin: "unicode", name: "x" }),
  text.bulkDelete([one, two]),
  ownInText.edit({ content: "x" })
]

// @expect-error TS2339 CategoryChannel
category.send({ content: "hi" })

// @expect-error TS2339 'send' does not exist on type 'ForumChannel
forum.send({ content: "hi" })

// @expect-error TS2339 crosspost
ownInText.crosspost()

// @expect-error TS2339 'join' does not exist on type 'TextChannel
text.join()

// @expect-error TS2339 'edit' does not exist on type 'ForeignMessage
foreign.edit({ content: "x" })

// @expect-error TS2339 'createThread' does not exist on type 'VoiceChannel
voice.createThread({ name: "lab-thread" })

// @expect-error TS2339 'createThread' does not exist on type 'ForumChannel
forum.createThread({ name: "lab-thread" })

// @expect-error TS2339 'pin' does not exist
inVoice.pin()

// @expect-error TS2322 topic cannot be edited on this channel kind
voice.edit({ topic: "voice channels have no topic" })

// @expect-error TS2322 announcement channels only have public threads
announcement.createThread({ name: "lab-thread", private: true })

// @expect-error TS2345 target requires 2
text.bulkDelete([one])
