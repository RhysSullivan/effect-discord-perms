// R-catch-tag-exact (fail side): catching a tag the effect cannot fail with is a compile error that names it.
import { Effect, Schema } from "effect"

class Alpha extends Schema.TaggedError<Alpha>()("Alpha", {}) {}

declare const failsWithAlpha: Effect.Effect<string, Alpha>

// @valid
export const caughtPresent = failsWithAlpha.pipe(Effect.catchTag("Alpha", () => Effect.succeed(0)))

// @expect-error TS2345 Beta
export const caughtAbsent = failsWithAlpha.pipe(Effect.catchTag("Beta", () => Effect.succeed(0)))
