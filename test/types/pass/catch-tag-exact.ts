// R-catch-tag-exact (pass side): Effect.catchTag removes exactly the tag it names and leaves every other
// member of the error union in place. The handler boundary relies on this to narrow by tag.
import { Effect, Schema } from "effect"
import { expectTypeOf } from "vitest"

class Alpha extends Schema.TaggedError<Alpha>()("Alpha", {}) {}
class Beta extends Schema.TaggedError<Beta>()("Beta", {}) {}
class Gamma extends Schema.TaggedError<Gamma>()("Gamma", {}) {}

declare const failsThreeWays: Effect.Effect<string, Alpha | Beta | Gamma>

const withoutAlpha = failsThreeWays.pipe(Effect.catchTag("Alpha", () => Effect.succeed(0)))
expectTypeOf<Effect.Error<typeof withoutAlpha>>().toEqualTypeOf<Beta | Gamma>()
expectTypeOf<Effect.Success<typeof withoutAlpha>>().toEqualTypeOf<string | number>()

const withoutAlphaAndGamma = withoutAlpha.pipe(Effect.catchTag("Gamma", () => Effect.void))
expectTypeOf<Effect.Error<typeof withoutAlphaAndGamma>>().toEqualTypeOf<Beta>()
