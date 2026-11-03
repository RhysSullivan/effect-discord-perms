// One assertion per row of the operation table (DESIGN §4.7): each public method's error union, for a sample
// whose payload and arguments add nothing (literals within their limits), is exactly its row, `OpErrors<never>[Op]`.
// A row a method does not use, or a method whose union drifts from its row, fails here.
import type { Effect } from "effect"
import { expectTypeOf } from "vitest"
import type {
  AnnouncementChannel,
  DMChannel,
  ForumChannel,
  PublicThread,
  TextChannel,
  VoiceChannel
} from "../../../src/channels/Channel.ts"
import type { ForeignMessage, OwnMessage } from "../../../src/channels/Message.ts"
import type { GuildMember } from "../../../src/members/Member.ts"
import type { OpErrors } from "../../../src/permissions/Operations.ts"
import { Permissions } from "../../../src/permissions/Require.ts"
import { MessageId, RoleId, UserId } from "../../../src/Snowflake.ts"

declare const text: TextChannel
declare const announcement: AnnouncementChannel
declare const voice: VoiceChannel
declare const thread: PublicThread
declare const forum: ForumChannel
declare const dm: DMChannel
declare const ownText: OwnMessage<"text">
declare const ownThread: OwnMessage<"public-thread">
declare const ownVoice: OwnMessage<"voice">
declare const ownAnnouncement: OwnMessage<"announcement">
declare const foreignText: ForeignMessage<"text">
declare const foreignThread: ForeignMessage<"public-thread">
declare const foreignVoice: ForeignMessage<"voice">
declare const foreignAnnouncement: ForeignMessage<"announcement">
declare const member: GuildMember
const ids = [MessageId.make("123456789012345678"), MessageId.make("123456789012345679")] as const
const role = RoleId.make("123456789012345678")


// sends and posts
const op1 = text.send({ content: "pong" })
expectTypeOf<Effect.Error<typeof op1>>().toEqualTypeOf<OpErrors<never>["channel.send"]>()
const op2 = announcement.send({ content: "pong" })
expectTypeOf<Effect.Error<typeof op2>>().toEqualTypeOf<OpErrors<never>["channel.send"]>()
const op3 = thread.send({ content: "pong" })
expectTypeOf<Effect.Error<typeof op3>>().toEqualTypeOf<OpErrors<never>["thread.send"]>()
const op4 = voice.send({ content: "pong" })
expectTypeOf<Effect.Error<typeof op4>>().toEqualTypeOf<OpErrors<never>["voice.send"]>()
const op5 = dm.send({ content: "pong" })
expectTypeOf<Effect.Error<typeof op5>>().toEqualTypeOf<OpErrors<never>["dm.send"]>()
const op6 = forum.createPost({ name: "lab-post", message: { content: "pong" } })
expectTypeOf<Effect.Error<typeof op6>>().toEqualTypeOf<OpErrors<never>["forum.createPost"]>()

// channel and thread edits
const op7 = text.edit({ name: "lab-text-b" })
expectTypeOf<Effect.Error<typeof op7>>().toEqualTypeOf<OpErrors<never>["channel.edit"]>()
const op8 = voice.edit({ slowmodeSeconds: 5 })
expectTypeOf<Effect.Error<typeof op8>>().toEqualTypeOf<OpErrors<never>["voice.edit"]>()
const op9 = thread.edit({ name: "lab-thread-b" })
expectTypeOf<Effect.Error<typeof op9>>().toEqualTypeOf<OpErrors<never>["thread.edit"]>()

// thread creation, pins, bulk delete
const op10 = text.createThread({ name: "lab-thread" })
expectTypeOf<Effect.Error<typeof op10>>().toEqualTypeOf<OpErrors<never>["channel.createThread.public"]>()
const op11 = text.createThread({ name: "lab-thread", private: true })
expectTypeOf<Effect.Error<typeof op11>>().toEqualTypeOf<OpErrors<never>["channel.createThread.private"]>()
const op12 = ownText.createThread({ name: "lab-thread" })
expectTypeOf<Effect.Error<typeof op12>>().toEqualTypeOf<OpErrors<never>["channel.createThread.public"]>()
const op13 = text.pins()
expectTypeOf<Effect.Error<typeof op13>>().toEqualTypeOf<OpErrors<never>["channel.pins"]>()
const op14 = voice.pins()
expectTypeOf<Effect.Error<typeof op14>>().toEqualTypeOf<OpErrors<never>["voice.pins"]>()
const op15 = text.bulkDelete(ids)
expectTypeOf<Effect.Error<typeof op15>>().toEqualTypeOf<OpErrors<never>["channel.bulkDelete"]>()
const op16 = thread.bulkDelete(ids)
expectTypeOf<Effect.Error<typeof op16>>().toEqualTypeOf<OpErrors<never>["thread.bulkDelete"]>()
const op17 = voice.bulkDelete(ids)
expectTypeOf<Effect.Error<typeof op17>>().toEqualTypeOf<OpErrors<never>["voice.bulkDelete"]>()

// thread operations
const op18 = thread.join()
expectTypeOf<Effect.Error<typeof op18>>().toEqualTypeOf<OpErrors<never>["thread.join"]>()
const op19 = thread.leave()
expectTypeOf<Effect.Error<typeof op19>>().toEqualTypeOf<OpErrors<never>["thread.leave"]>()
const op20 = thread.addMember(UserId.make("123456789012345678"))
expectTypeOf<Effect.Error<typeof op20>>().toEqualTypeOf<OpErrors<never>["thread.addMember"]>()
const op21 = thread.setArchived(true)
expectTypeOf<Effect.Error<typeof op21>>().toEqualTypeOf<OpErrors<never>["thread.setArchived"]>()
const op22 = thread.setArchived(false)
expectTypeOf<Effect.Error<typeof op22>>().toEqualTypeOf<OpErrors<never>["thread.unarchive"]>()
const op23 = thread.setLocked(true)
expectTypeOf<Effect.Error<typeof op23>>().toEqualTypeOf<OpErrors<never>["thread.setLocked"]>()
const op24 = thread.delete()
expectTypeOf<Effect.Error<typeof op24>>().toEqualTypeOf<OpErrors<never>["thread.delete"]>()

// messages
const op25 = ownText.edit({ content: "pong" })
expectTypeOf<Effect.Error<typeof op25>>().toEqualTypeOf<OpErrors<never>["message.edit.channel"]>()
const op26 = ownThread.edit({ content: "pong" })
expectTypeOf<Effect.Error<typeof op26>>().toEqualTypeOf<OpErrors<never>["message.edit.thread"]>()
const op27 = ownVoice.edit({ content: "pong" })
expectTypeOf<Effect.Error<typeof op27>>().toEqualTypeOf<OpErrors<never>["message.edit.voice"]>()
const op28 = ownText.delete()
expectTypeOf<Effect.Error<typeof op28>>().toEqualTypeOf<OpErrors<never>["message.deleteOwn"]>()
const op29 = ownThread.delete()
expectTypeOf<Effect.Error<typeof op29>>().toEqualTypeOf<OpErrors<never>["message.deleteOwn.thread"]>()
const op30 = ownVoice.delete()
expectTypeOf<Effect.Error<typeof op30>>().toEqualTypeOf<OpErrors<never>["message.deleteOwn.voice"]>()
const op31 = foreignText.delete()
expectTypeOf<Effect.Error<typeof op31>>().toEqualTypeOf<OpErrors<never>["message.deleteForeign"]>()
const op32 = foreignThread.delete()
expectTypeOf<Effect.Error<typeof op32>>().toEqualTypeOf<OpErrors<never>["message.deleteForeign.thread"]>()
const op33 = foreignVoice.delete()
expectTypeOf<Effect.Error<typeof op33>>().toEqualTypeOf<OpErrors<never>["message.deleteForeign.voice"]>()
const op34 = foreignText.react({ origin: "unicode", name: "👍" })
expectTypeOf<Effect.Error<typeof op34>>().toEqualTypeOf<OpErrors<never>["message.react.channel"]>()
const op35 = foreignThread.react({ origin: "unicode", name: "👍" })
expectTypeOf<Effect.Error<typeof op35>>().toEqualTypeOf<OpErrors<never>["message.react.thread"]>()
const op36 = foreignVoice.react({ origin: "unicode", name: "👍" })
expectTypeOf<Effect.Error<typeof op36>>().toEqualTypeOf<OpErrors<never>["message.react.voice"]>()
const op37 = foreignText.pin()
expectTypeOf<Effect.Error<typeof op37>>().toEqualTypeOf<OpErrors<never>["message.pin.channel"]>()
const op38 = foreignThread.pin()
expectTypeOf<Effect.Error<typeof op38>>().toEqualTypeOf<OpErrors<never>["message.pin.thread"]>()
const op39 = foreignText.unpin()
expectTypeOf<Effect.Error<typeof op39>>().toEqualTypeOf<OpErrors<never>["message.unpin.channel"]>()
const op40 = foreignThread.unpin()
expectTypeOf<Effect.Error<typeof op40>>().toEqualTypeOf<OpErrors<never>["message.unpin.thread"]>()
const op41 = ownAnnouncement.crosspost()
expectTypeOf<Effect.Error<typeof op41>>().toEqualTypeOf<OpErrors<never>["message.crosspostOwn"]>()
const op42 = foreignAnnouncement.crosspost()
expectTypeOf<Effect.Error<typeof op42>>().toEqualTypeOf<OpErrors<never>["message.crosspostForeign"]>()

// members
const op43 = member.addRole(role)
expectTypeOf<Effect.Error<typeof op43>>().toEqualTypeOf<OpErrors<never>["member.addRole"]>()
const op44 = member.removeRole(role)
expectTypeOf<Effect.Error<typeof op44>>().toEqualTypeOf<OpErrors<never>["member.removeRole"]>()
const op45 = member.setNickname(null)
expectTypeOf<Effect.Error<typeof op45>>().toEqualTypeOf<OpErrors<never>["member.setNickname"]>()
const op46 = member.timeout(null)
expectTypeOf<Effect.Error<typeof op46>>().toEqualTypeOf<OpErrors<never>["member.timeout"]>()
const op47 = member.kick()
expectTypeOf<Effect.Error<typeof op47>>().toEqualTypeOf<OpErrors<never>["member.kick"]>()
const op48 = member.ban()
expectTypeOf<Effect.Error<typeof op48>>().toEqualTypeOf<OpErrors<never>["member.ban"]>()

// require
const op49 = Permissions.require(text, ["ViewChannel"])
expectTypeOf<Effect.Error<typeof op49>>().toEqualTypeOf<OpErrors<never>["permissions.require"]>()
