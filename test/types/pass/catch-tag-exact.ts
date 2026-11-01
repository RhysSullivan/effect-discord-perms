// R-catch-tag-exact (pass side): Effect.catchTag removes exactly the tag it names and leaves every other
// member of the error union in place. The handler boundary relies on this to narrow by tag.
import { Effect, Schema } from "effect"
import { expectTypeOf } from "vitest"
import type {
  DiscordUnavailable,
  MissingEmbedLinks,
  MissingReadMessageHistory,
  MissingReadMessageHistoryForReaction,
  MissingReadMessageHistoryForReply,
  MissingViewChannel,
  ThreadLocked
} from "../../../src/errors/index.ts"

class Alpha extends Schema.TaggedError<Alpha>()("Alpha", {}) {}
class Beta extends Schema.TaggedError<Beta>()("Beta", {}) {}
class Gamma extends Schema.TaggedError<Gamma>()("Gamma", {}) {}

declare const failsThreeWays: Effect.Effect<string, Alpha | Beta | Gamma>

const withoutAlpha = failsThreeWays.pipe(Effect.catchTag("Alpha", () => Effect.succeed(0)))
expectTypeOf<Effect.Error<typeof withoutAlpha>>().toEqualTypeOf<Beta | Gamma>()
expectTypeOf<Effect.Success<typeof withoutAlpha>>().toEqualTypeOf<string | number>()

const withoutAlphaAndGamma = withoutAlpha.pipe(Effect.catchTag("Gamma", () => Effect.void))
expectTypeOf<Effect.Error<typeof withoutAlphaAndGamma>>().toEqualTypeOf<Beta>()

// Library errors: catchTag removes exactly one generated or hand-written class, and the D5 variants, which
// share the tag `MissingReadMessageHistory`, leave together with the base class.
declare const library: Effect.Effect<void, MissingViewChannel | MissingEmbedLinks | ThreadLocked | DiscordUnavailable>
const withoutEmbedLinks = library.pipe(
  Effect.catchTag("MissingEmbedLinks", (error) => {
    expectTypeOf(error).toEqualTypeOf<MissingEmbedLinks>()
    return Effect.void
  })
)
expectTypeOf<Effect.Error<typeof withoutEmbedLinks>>().toEqualTypeOf<MissingViewChannel | ThreadLocked | DiscordUnavailable>()
const withoutThreadLocked = library.pipe(Effect.catchTag("ThreadLocked", () => Effect.void))
expectTypeOf<Effect.Error<typeof withoutThreadLocked>>().toEqualTypeOf<MissingViewChannel | MissingEmbedLinks | DiscordUnavailable>()

declare const readHistory: Effect.Effect<void, MissingReadMessageHistoryForReply | MissingReadMessageHistoryForReaction | ThreadLocked>
const withoutReadHistory = readHistory.pipe(Effect.catchTag("MissingReadMessageHistory", () => Effect.void))
expectTypeOf<Effect.Error<typeof withoutReadHistory>>().toEqualTypeOf<ThreadLocked>()
expectTypeOf<(MissingReadMessageHistory | MissingReadMessageHistoryForReply | MissingReadMessageHistoryForReaction)["_tag"]>().toEqualTypeOf<"MissingReadMessageHistory">()
