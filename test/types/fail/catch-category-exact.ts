// R-catch-category-exact (fail side): catching a category the effect cannot fail with is a compile error that
// names the category, like catchTag with an absent tag (a dead handler).
import { Effect } from "effect"
import { catchCategory, type MissingViewChannel, type ThreadLocked } from "../../../src/errors/index.ts"

declare const accessOrState: Effect.Effect<string, MissingViewChannel | ThreadLocked>

// @valid
export const presentCaught = accessOrState.pipe(catchCategory(["access", "state"], () => Effect.succeed("")))

// @expect-error TS2345 payload
export const absentCaught = accessOrState.pipe(catchCategory("payload", () => Effect.succeed("")))

// @expect-error TS2345 transient
export const oneAbsentInList = accessOrState.pipe(catchCategory(["state", "transient"], () => Effect.succeed("")))

// @expect-error TS2345 payload
export const absentDataFirst = catchCategory(accessOrState, "payload", () => Effect.succeed(""))
