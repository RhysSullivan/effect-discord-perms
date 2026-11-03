// Branded snowflake IDs (DESIGN §2.1): each brand is its own type, none is assignable to another or from a
// plain string, and every one is still a string. The fail side, with the mixing diagnostics, is
// test/types/fail/ids.ts (R-ids-distinct, whose live pair is in harness/scenario/catalog/rules.ts).
import { expectTypeOf } from "vitest"
import {
  ApplicationId,
  ChannelId,
  CommandId,
  EmojiId,
  ForumTagId,
  GuildId,
  InteractionId,
  MessageId,
  RoleId,
  StickerId,
  UserId
} from "../../../src/Snowflake.ts"

/** Every brand, as a tuple of the ID types. */
type Ids = [ChannelId, GuildId, UserId, RoleId, MessageId, ApplicationId, CommandId, InteractionId, EmojiId, StickerId, ForumTagId]

/** The pairs (I, J), I != J, where the I-th ID type is assignable to the J-th. */
type Assignable = {
  readonly [I in keyof Ids & `${number}`]: {
    readonly [J in keyof Ids & `${number}`]: J extends I ? never : [Ids[I]] extends [Ids[J]] ? `${I}->${J}` : never
  }[keyof Ids & `${number}`]
}[keyof Ids & `${number}`]
expectTypeOf<Assignable>().toEqualTypeOf<never>()

// A plain string is none of them; every one of them is a string.
expectTypeOf<string>().not.toExtend<Ids[number]>()
expectTypeOf<Ids[number]>().toExtend<string>()

// `make` is the trusted constructor and returns the brand.
expectTypeOf(ChannelId.make("123456789012345678")).toEqualTypeOf<ChannelId>()
expectTypeOf(UserId.make("123456789012345678")).toEqualTypeOf<UserId>()
expectTypeOf(GuildId.make).returns.toEqualTypeOf<GuildId>()
expectTypeOf(RoleId.make).returns.toEqualTypeOf<RoleId>()
expectTypeOf(MessageId.make).returns.toEqualTypeOf<MessageId>()
expectTypeOf(ApplicationId.make).returns.toEqualTypeOf<ApplicationId>()
expectTypeOf(CommandId.make).returns.toEqualTypeOf<CommandId>()
expectTypeOf(InteractionId.make).returns.toEqualTypeOf<InteractionId>()
expectTypeOf(EmojiId.make).returns.toEqualTypeOf<EmojiId>()
expectTypeOf(StickerId.make).returns.toEqualTypeOf<StickerId>()
expectTypeOf(ForumTagId.make).returns.toEqualTypeOf<ForumTagId>()
