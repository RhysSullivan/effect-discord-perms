import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Option, Schema } from "effect"
import { ComponentRoute, routeNameOf } from "../../src/components/CustomId.ts"
import { CustomIdTooLong } from "../../src/errors/Payload.ts"
import { Limits, lengthOf } from "../../src/payload/Limits.ts"

/**
 * `custom_id` routes (DESIGN §2.9): every route round-trips its data through the canonical JSON codec (dates, bigints
 * and sets included, which `JSON.stringify` of the encoded value broke in revision 1), an ID is at most 100 characters
 * when built (`CustomIdTooLong` past it, a payload error), another route's or a malformed ID decodes to nothing (an old
 * control, not a defect), and a received ID is routed by its prefix.
 */
const vote = ComponentRoute.make("vote", Schema.Struct({ choice: Schema.Literals(["yes", "no"]), poll: Schema.Int }))
const dated = ComponentRoute.make("dated", Schema.Struct({ at: Schema.Date, n: Schema.BigInt, ids: Schema.ReadonlySet(Schema.String) }))
const padded = ComponentRoute.make("lab-route", Schema.Struct({ pad: Schema.String }))

describe("component routes", () => {
  it.effect("round-trips a struct of literals and integers, and a date, a bigint and a set", () =>
    Effect.gen(function* () {
      const id = yield* vote.customId({ choice: "yes", poll: 7 })
      expect(id).toBe(`vote:{"choice":"yes","poll":7}`)
      expect(vote.decode(id)).toStrictEqual(Option.some({ choice: "yes", poll: 7 }))
      const at = new Date("2026-11-04T10:00:00.000Z")
      const decoded = dated.decode(yield* dated.customId({ at, n: 12n, ids: new Set(["a", "b"]) }))
      expect(Option.map(decoded, (data) => [data.at.toISOString(), data.n, [...data.ids]])).toStrictEqual(Option.some([at.toISOString(), 12n, ["a", "b"]]))
    }))

  it.effect("builds an ID of exactly 100 characters, and refuses 101 with CustomIdTooLong naming the route and length", () =>
    Effect.gen(function* () {
      const overhead = lengthOf(`lab-route:{"pad":""}`)
      const max = yield* padded.customId({ pad: "x".repeat(Limits.customId - overhead) })
      expect(lengthOf(max)).toBe(Limits.customId)
      expect(padded.decode(max)).toStrictEqual(Option.some({ pad: "x".repeat(Limits.customId - overhead) }))
      const over = yield* Effect.exit(padded.customId({ pad: "x".repeat(Limits.customId - overhead + 1) }))
      expect(over).toStrictEqual(Exit.fail(new CustomIdTooLong({ route: "lab-route", length: Limits.customId + 1 })))
    }))

  it.effect("decodes another route's ID, a malformed one and one of the wrong shape to nothing", () =>
    Effect.gen(function* () {
      const id = yield* vote.customId({ choice: "no", poll: 1 })
      expect(padded.decode(id)).toStrictEqual(Option.none())
      expect(vote.decode("vote:{not json")).toStrictEqual(Option.none())
      expect(vote.decode(`vote:{"choice":"maybe","poll":1}`)).toStrictEqual(Option.none())
      expect(vote.decode(`votes:{"choice":"no","poll":1}`)).toStrictEqual(Option.none())
    }))

  it("routes a received ID by its prefix before the first ':'", () => {
    expect(routeNameOf(`vote:{"choice":"yes"}`)).toBe("vote")
    expect(routeNameOf("lab-route:{}")).toBe("lab-route")
    expect(routeNameOf("no-separator")).toBeUndefined()
  })

  it("dies when the data does not encode, which a schema without a JSON form makes a defect", () => {
    const opaque = ComponentRoute.make("opaque", Schema.Struct({ f: Schema.declare((value: unknown): value is () => void => typeof value === "function") }))
    const exit = Effect.runSyncExit(opaque.customId({ f: () => undefined }))
    expect(Exit.isFailure(exit) && !exit.cause.reasons.some((reason) => reason._tag === "Fail")).toBe(true)
  })
})
