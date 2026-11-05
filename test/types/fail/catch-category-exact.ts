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

// The categories are literals (after the final audit): the type would remove every category an argument's type names,
// while the run time catches only those its value holds.
type Cat = "access" | "state"
declare const oneOf: Cat
declare const listed: readonly [Cat, ...Array<Cat>]
declare const pong: Effect.Effect<string>
declare const strict: boolean

// @valid
export const literalList = accessOrState.pipe(catchCategory(["access"], () => Effect.succeed("")), catchCategory("state", () => Effect.succeed("")))

// @expect-error TS2345 catchCategory needs each category as a literal, not a union
export const unionTyped = accessOrState.pipe(catchCategory(oneOf, () => Effect.succeed("")))

// @expect-error TS2345 catchCategory needs the categories as a literal list
export const widenedList = accessOrState.pipe(catchCategory(listed, () => Effect.succeed("")))

// @expect-error TS2345 catchCategory needs each category as a literal, not a union
export const unionElement = accessOrState.pipe(catchCategory(["permission", oneOf], () => Effect.succeed("")))

// @expect-error TS2345 catchCategory needs each category as a literal, not a union
export const unionDataFirst = catchCategory(accessOrState, oneOf, () => Effect.succeed(""))

// a union of literal lists (round 2): the type would remove "state", which the run time catches only when strict is false
// @expect-error TS2345 catchCategory needs each category as a literal, not a union
export const unionOfLists = accessOrState.pipe(catchCategory(strict ? (["access"] as const) : (["access", "state"] as const), () => Effect.succeed("")))

// @expect-error TS2345 catchCategory needs each category as a literal, not a union
export const unionOfListsDataFirst = catchCategory(accessOrState, strict ? (["access"] as const) : (["access", "state"] as const), () => Effect.succeed(""))

// @expect-error TS2345 this effect cannot fail with any category
export const deadCatch = pong.pipe(catchCategory("payload", () => Effect.succeed("")))
