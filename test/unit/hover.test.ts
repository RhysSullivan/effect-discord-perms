import { describe, expect, it } from "vitest"
import { containsName, effectTypeArguments, expectationProblems, parseExpectation, parseMarkers, renderHoverSnapshot } from "../../scripts/lib/hover.ts"

describe("parseExpectation", () => {
  it("reads names and no-object", () => {
    expect(parseExpectation(" names: Effect.Effect, Beta; no-object")).toEqual({ expectation: { names: ["Effect.Effect", "Beta"], noObject: true } })
    expect(parseExpectation("names: Sent")).toEqual({ expectation: { names: ["Sent"], noObject: false } })
  })

  it("requires names and rejects unknown clauses", () => {
    expect(parseExpectation("")).toEqual({ problem: 'a marker needs "names: A, B" naming what the hover must show' })
    expect(parseExpectation("no-object")).toEqual({ problem: 'a marker needs "names: A, B" naming what the hover must show' })
    expect(parseExpectation("names: A; readable")).toEqual({ problem: 'unknown expectation clause "readable" (use "names: A, B" and optionally "no-object")' })
  })
})

describe("parseMarkers", () => {
  it("hovers the line above at the caret's column", () => {
    const source = ["import { x } from 'y'", "export const sent = x", "//           ^? names: Sent"].join("\n")
    expect(parseMarkers(source)).toEqual({
      markers: [
        {
          markerLine: 3,
          position: { line: 1, character: 13 },
          source: "export const sent = x",
          expectation: { names: ["Sent"], noObject: false }
        }
      ],
      problems: []
    })
  })

  it("rejects a caret over whitespace, a first-line marker and a stacked marker", () => {
    const source = ["//  ^? names: A", "const a = 1", "//                     ^? names: A", "const b = 2", "//    ^? names: B", "//    ^? names: B"].join("\n")
    expect(parseMarkers(source)).toEqual({
      markers: [{ markerLine: 5, position: { line: 3, character: 6 }, source: "const b = 2", expectation: { names: ["B"], noObject: false } }],
      problems: [
        "L1: a marker must sit directly below the code it hovers",
        "L3: the caret points past the end of the line above or at whitespace",
        "L6: a marker must sit directly below the code it hovers"
      ]
    })
  })
})

describe("containsName", () => {
  it("matches whole identifiers only", () => {
    expect(containsName("const a: Effect.Effect<Beta, never, never>", "Beta")).toBe(true)
    expect(containsName("const a: Effect.Effect<BetaError, never, never>", "Beta")).toBe(false)
    expect(containsName("const a: Effect.Effect<void, Beta, never>", "Effect.Effect")).toBe(true)
    expect(containsName("const a: MyEffect.Effect<void>", "Effect.Effect")).toBe(false)
  })
})

describe("effectTypeArguments", () => {
  it("splits the first Effect's top-level arguments, skipping nested lists, arrows and strings", () => {
    const hover = 'const a: Effect.Effect<Map<string, (x: A) => B>, Missing<"a, b"> | Other, Scope.Scope>'
    expect(effectTypeArguments(hover)).toEqual(["Map<string, (x: A) => B>", 'Missing<"a, b"> | Other', "Scope.Scope"])
  })

  it("returns undefined without an Effect type or for a cut-off one", () => {
    expect(effectTypeArguments("const a: number")).toBeUndefined()
    expect(effectTypeArguments("const a: Effect.Effect<void, Beta")).toBeUndefined()
  })
})

describe("expectationProblems", () => {
  it("holds for named error types", () => {
    expect(expectationProblems("const a: Effect.Effect<string, Beta, never>", { names: ["Effect.Effect", "Beta"], noObject: true })).toEqual([])
  })

  it("rejects an object type in the error argument but not in the success argument", () => {
    const objectError = "const a: Effect.Effect<string, { readonly _tag: \"Beta\"; }, never>"
    expect(expectationProblems(objectError, { names: ["Effect.Effect"], noObject: true })).toEqual([
      'no-object: the error type argument contains an object type: { readonly _tag: "Beta"; }'
    ])
    expect(expectationProblems("const a: Effect.Effect<{ readonly id: string; }, Beta, never>", { names: ["Beta"], noObject: true })).toEqual([])
  })

  it("reports missing names and a missing Effect type", () => {
    expect(expectationProblems("const a: number", { names: ["Beta"], noObject: true })).toEqual([
      'hover does not show "Beta"',
      "no-object: the hover shows no Effect type with an error argument"
    ])
  })
})

describe("renderHoverSnapshot", () => {
  it("writes the source line and the verbatim value per marker", () => {
    expect(renderHoverSnapshot([{ source: "export const a = x", value: "const a: {\n    readonly b: 1;\n}" }, { source: "const c = d", value: "const c: C" }])).toBe(
      "export const a = x\nconst a: {\n    readonly b: 1;\n}\n\nconst c = d\nconst c: C\n"
    )
  })
})
