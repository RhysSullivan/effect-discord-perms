// Hover smoke marker: after catchTag, the hover names the remaining error class, not a structural object.
import { Effect, Schema } from "effect"

class Alpha extends Schema.TaggedError<Alpha>()("Alpha", {}) {}
class Beta extends Schema.TaggedError<Beta>()("Beta", {}) {}

declare const failsTwoWays: Effect.Effect<string, Alpha | Beta>

export const withoutAlpha = failsTwoWays.pipe(Effect.catchTag("Alpha", () => Effect.succeed(0)))
//           ^? names: Effect.Effect, Beta; no-object
