// Length and range limits are typed errors only where the value may exceed them (DESIGN §2.3, §2.4, §2.6): a
// finite literal within its limit adds no limit tag, so catching one on it is a compile error; each @valid twin with a
// dynamic value, or a literal over its limit, carries the tag. Users never brand strings.
import { Effect } from "effect"
import type { TextChannel } from "../../../src/channels/Channel.ts"
import type { GuildMember } from "../../../src/members/Member.ts"

declare const text: TextChannel
declare const member: GuildMember
declare const dynamic: string
declare const seconds: number
type X10 = "xxxxxxxxxx"
type X100 = `${X10}${X10}${X10}${X10}${X10}${X10}${X10}${X10}${X10}${X10}`
type X1000 = `${X100}${X100}${X100}${X100}${X100}${X100}${X100}${X100}${X100}${X100}`
declare const overLimit: `${X1000}${X1000}x`
const handled = () => Effect.void

// @valid
export const ok = [
  text.send({ content: dynamic }).pipe(Effect.catchTag("ContentTooLong", handled)),
  text.send({ content: overLimit }).pipe(Effect.catchTag("ContentTooLong", handled)),
  text.createThread({ name: "" }).pipe(Effect.catchTag("NameTooLong", handled)),
  text.edit({ slowmodeSeconds: 99999 }).pipe(Effect.catchTag("SlowmodeOutOfRange", handled)),
  text.send({ content: "hi", embeds: [{ title: "t" }] }).pipe(Effect.catchTag("EmbedTooLarge", handled)),
  text.send({ poll: { question: "q", answers: ["a"], durationHours: 1 } }).pipe(Effect.catchTag("PollTooLarge", handled)),
  text.createThread({ name: dynamic }).pipe(Effect.catchTag("NameTooLong", handled)),
  text.edit({ topic: dynamic }).pipe(Effect.catchTag("TopicTooLong", handled)),
  text.edit({ slowmodeSeconds: seconds }).pipe(Effect.catchTag("SlowmodeOutOfRange", handled)),
  member.setNickname(dynamic).pipe(Effect.catchTag("NicknameTooLong", handled)),
  member.timeout(new Date()).pipe(Effect.catchTag("TimeoutTooLong", handled))
]

// @expect-error TS2345 ContentTooLong
text.send({ content: "pong" }).pipe(Effect.catchTag("ContentTooLong", handled))

// @expect-error TS2345 EmbedTooLarge
text.send({ content: "pong" }).pipe(Effect.catchTag("EmbedTooLarge", handled))

// @expect-error TS2345 PollTooLarge
text.send({ content: "pong" }).pipe(Effect.catchTag("PollTooLarge", handled))

// @expect-error TS2345 NameTooLong
text.createThread({ name: "lab-thread" }).pipe(Effect.catchTag("NameTooLong", handled))

// @expect-error TS2345 TopicTooLong
text.edit({ topic: "a topic" }).pipe(Effect.catchTag("TopicTooLong", handled))

// @expect-error TS2345 SlowmodeOutOfRange
text.edit({ slowmodeSeconds: 10 }).pipe(Effect.catchTag("SlowmodeOutOfRange", handled))

// @expect-error TS2345 NicknameTooLong
member.setNickname(null).pipe(Effect.catchTag("NicknameTooLong", handled))

// @expect-error TS2345 TimeoutTooLong
member.timeout(null).pipe(Effect.catchTag("TimeoutTooLong", handled))
