// R-catch-category-exact (pass side): catchCategory removes exactly the members of the categories it names,
// its handler receives exactly those members, and an error in several categories is caught by each of them.
import { Effect } from "effect"
import { expectTypeOf } from "vitest"
import {
  catchCategory,
  type DiscordUnavailable,
  type MissingEmbedLinks,
  type MissingManageMessages,
  type MissingReadMessageHistory,
  type MissingReadMessageHistoryForReaction,
  type MissingReadMessageHistoryForReply,
  type MissingSendMessages,
  type MissingViewChannel,
  type RateLimited,
  type ThreadLocked
} from "../../../src/errors/index.ts"

declare const eff: Effect.Effect<
  string,
  MissingViewChannel | MissingSendMessages | MissingEmbedLinks | MissingManageMessages | ThreadLocked | DiscordUnavailable | RateLimited
>

// One category, data-last: the payload members leave, MissingEmbedLinks (permission and payload) included.
const withoutPayload = eff.pipe(
  catchCategory("payload", (error) => {
    expectTypeOf(error).toEqualTypeOf<MissingEmbedLinks>()
    return Effect.succeed(0)
  })
)
expectTypeOf<Effect.Error<typeof withoutPayload>>().toEqualTypeOf<
  MissingViewChannel | MissingSendMessages | MissingManageMessages | ThreadLocked | DiscordUnavailable | RateLimited
>()
expectTypeOf<Effect.Success<typeof withoutPayload>>().toEqualTypeOf<string | number>()

// Several categories (any-of): the members of either leave.
const withoutAccessOrState = eff.pipe(catchCategory(["access", "state"], () => Effect.succeed("")))
expectTypeOf<Effect.Error<typeof withoutAccessOrState>>().toEqualTypeOf<MissingEmbedLinks | MissingManageMessages | DiscordUnavailable | RateLimited>()

// The same error is caught by each of its categories: MissingEmbedLinks leaves through `permission` as well.
const withoutPermission = eff.pipe(catchCategory("permission", () => Effect.void))
expectTypeOf<Effect.Error<typeof withoutPermission>>().toEqualTypeOf<ThreadLocked | DiscordUnavailable | RateLimited>()

// Data-first spelling, and the handler's own errors are added.
const transientRethrown = catchCategory(eff, "transient", (error) => Effect.fail(error._tag))
expectTypeOf<Effect.Error<typeof transientRethrown>>().toEqualTypeOf<
  MissingViewChannel | MissingSendMessages | MissingEmbedLinks | MissingManageMessages | ThreadLocked | "DiscordUnavailable" | "RateLimited"
>()

// Catching every category present leaves nothing.
const handled = eff.pipe(catchCategory(["permission", "state", "transient"], () => Effect.void))
expectTypeOf<Effect.Error<typeof handled>>().toEqualTypeOf<never>()

// The D5 variants share the tag but not the categories: `payload` catches the reply variant only.
declare const variants: Effect.Effect<void, MissingReadMessageHistoryForReply | MissingReadMessageHistoryForReaction>
const replyCaught = variants.pipe(catchCategory("payload", () => Effect.void))
expectTypeOf<Effect.Error<typeof replyCaught>>().toEqualTypeOf<MissingReadMessageHistoryForReaction>()
const reactionCaught = variants.pipe(catchCategory("access", () => Effect.void))
expectTypeOf<Effect.Error<typeof reactionCaught>>().toEqualTypeOf<MissingReadMessageHistoryForReply>()

// The base class is in `permission` only.
declare const base: Effect.Effect<void, MissingReadMessageHistory | ThreadLocked>
const baseCaught = base.pipe(catchCategory("permission", () => Effect.void))
expectTypeOf<Effect.Error<typeof baseCaught>>().toEqualTypeOf<ThreadLocked>()
