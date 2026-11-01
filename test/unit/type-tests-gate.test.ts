import { describe, expect, it } from "vitest"
import {
  checkRun,
  collapseUnions,
  type Diagnostic,
  type Expectation,
  gateProblems,
  maxGatedChars,
  parseDirectives,
  parseTscOutput,
  renderSnapshot,
  type TscOutput
} from "../../scripts/lib/typeTests.ts"

const root = "/repo"
const failFile = "/repo/test/types/fail/f.ts"
const passFile = "/repo/test/types/pass/p.ts"

const diagnostic = (overrides: Partial<Diagnostic>): Diagnostic => ({
  file: failFile,
  line: 5,
  column: 3,
  code: "TS2345",
  text: "Argument of type '\"Beta\"' is not assignable to parameter of type '\"Alpha\"'.",
  ...overrides
})
const want: Expectation = { line: 4, code: "TS2345", mention: "Beta" }

describe("parseTscOutput", () => {
  it("reads located diagnostics with their chains, resolves paths and keeps other lines as unlocated", () => {
    const output = [
      "test/types/fail/b.ts(9,1): error TS2322: Type 'A' is not assignable to type 'B'.",
      "  Property 'x' is missing.",
      "    Deeper.",
      "test/types/fail/a.ts(3,7): error TS2345: Argument.",
      "error TS5112: tsconfig.json is present but will not be loaded.",
      ""
    ].join("\n")
    const parsed = parseTscOutput(output, root)
    expect(parsed.diagnostics).toEqual([
      { file: "/repo/test/types/fail/a.ts", line: 3, column: 7, code: "TS2345", text: "Argument." },
      {
        file: "/repo/test/types/fail/b.ts",
        line: 9,
        column: 1,
        code: "TS2322",
        text: "Type 'A' is not assignable to type 'B'.\n  Property 'x' is missing.\n    Deeper."
      }
    ])
    expect(parsed.unlocated).toEqual(["error TS5112: tsconfig.json is present but will not be loaded."])
  })
})

describe("parseDirectives", () => {
  it("groups consecutive directives into one block and records @valid blocks", () => {
    const source = ["import x from 'y'", "// @valid", "ok()", "// @expect-error TS2322 First", "// @expect-error TS2353 Second", "bad()", "// @expect-error TS2345 Third", "bad()"].join("\n")
    expect(parseDirectives(source)).toEqual({
      blocks: [
        { kind: "valid", line: 2 },
        {
          kind: "expect",
          line: 4,
          expectations: [
            { line: 4, code: "TS2322", mention: "First" },
            { line: 5, code: "TS2353", mention: "Second" }
          ]
        },
        { kind: "expect", line: 7, expectations: [{ line: 7, code: "TS2345", mention: "Third" }] }
      ],
      problems: []
    })
  })

  it("rejects a directive without a TS code, one that trails code, and a malformed @valid", () => {
    const source = ["// @expect-error Beta", "bad() // @expect-error TS2345 Beta", "//@valid", "// @validate"].join("\n")
    expect(parseDirectives(source)).toEqual({
      blocks: [],
      problems: [
        'L1: malformed directive; write "// @expect-error TS<code> <mention>" on its own line',
        'L2: malformed directive; write "// @expect-error TS<code> <mention>" on its own line',
        'L3: malformed @valid marker; write "// @valid" on its own line',
        'L4: malformed @valid marker; write "// @valid" on its own line'
      ]
    })
  })

  it("leaves prose that mentions the markers alone", () => {
    const source = ["// The @valid block proves the setup; each @expect-error owns one call.", "// @ts-expect-error is banned elsewhere"].join("\n")
    expect(parseDirectives(source)).toEqual({ blocks: [], problems: [] })
  })
})

describe("gateProblems", () => {
  it("accepts a short diagnostic with the directive's code and mention", () => {
    expect(gateProblems(diagnostic({}), want)).toEqual([])
  })

  it("rejects a different code than the directive's", () => {
    expect(gateProblems(diagnostic({ code: "TS2322" }), want)).toEqual(["code TS2322, but the directive says TS2345"])
  })

  it("rejects wrong-reason codes whatever the directive says", () => {
    const problems = gateProblems(diagnostic({ code: "TS2304", text: "Cannot find name 'Beta'." }), { ...want, code: "TS2304" })
    expect(problems).toEqual(["wrong-reason code TS2304 (an unresolved name or import)"])
  })

  it("rejects a diagnostic that does not contain the mention", () => {
    expect(gateProblems(diagnostic({}), { ...want, mention: "Gamma" })).toEqual(['does not mention "Gamma"'])
  })

  it("rejects more than four lines", () => {
    const text = ["Beta head", "  a", "    b", "      c", "        d"].join("\n")
    expect(gateProblems(diagnostic({ text }), want)).toEqual(["unreadable: 5 lines and 37 gated characters (limit 4 lines, 800 characters)"])
  })

  it("measures size after collapsing unions of plain names, so a long tag list passes", () => {
    const union = Array.from({ length: 80 }, (_, i) => `Missing${i}`).join(" | ")
    const text = `Type 'Beta' is not assignable to '${union}'.`
    expect(text.length).toBeGreaterThan(maxGatedChars)
    expect(collapseUnions(text)).toBe("Type 'Beta' is not assignable to 'U'.")
    expect(gateProblems(diagnostic({ text }), want)).toEqual([])
  })

  it("rejects more than 800 characters that are not a union", () => {
    const text = `Beta ${"x".repeat(maxGatedChars)}`
    expect(gateProblems(diagnostic({ text }), want)).toEqual([`unreadable: 1 lines and ${text.length} gated characters (limit 4 lines, 800 characters)`])
  })

  it.each([
    ["Type 'Beta' is not assignable with 'exactOptionalPropertyTypes: true'.", "exactOptionalPropertyTypes"],
    ["Argument of type 'Beta' is not assignable to parameter of type 'never'.", "parameter of type 'never'"],
    ["Type 'Beta' is not assignable to type 'never'.", "type 'never'."],
    ["Expected 2 arguments, but got 1. Beta", "Expected N arguments"],
    ["Expected 1-2 arguments, but got 0. Beta", "Expected N arguments"]
  ])("rejects banned text: %s", (text, label) => {
    expect(gateProblems(diagnostic({ text }), want)).toContain(`contains banned text "${label}"`)
  })

  it("rejects a truncation inside a message-carrying type, but not one outside it", () => {
    const inside = "Argument of type 'Effect<void, Beta | ... 3 more ... | X>' is not assignable to 'UnhandledErrors<\"permission\", Beta | ... 2 more ... | Y>'."
    const outside = "Argument of type 'Effect<void, Beta | ... 3 more ... | X>' is not assignable to 'UnhandledErrors<\"permission\", Beta>'."
    const truncation = 'truncates ("... N more ...") inside a message-carrying type (UnhandledErrors, Invalid)'
    expect(gateProblems(diagnostic({ text: inside }), want)).toEqual([truncation])
    expect(gateProblems(diagnostic({ text: outside }), want)).toEqual([])
  })

  it("treats an unclosed message-carrying type as running to the end", () => {
    const text = "Type 'Beta' is not assignable to 'Invalid<\"too long\" | ... 2 more ..."
    expect(gateProblems(diagnostic({ text }), want)).toContain('truncates ("... N more ...") inside a message-carrying type (UnhandledErrors, Invalid)')
  })
})

describe("checkRun", () => {
  const failSource = [
    "import { x } from 'y'", //   1
    "", //                        2
    "// @valid", //               3
    "x.ok()", //                  4
    "", //                        5
    "// @expect-error TS2345 Beta", // 6
    "x.bad()" //                  7
  ].join("\n")
  const passSource = "import { expectTypeOf } from 'vitest'\nexpectTypeOf<1>().toEqualTypeOf<1>()"
  const own = diagnostic({ line: 7, column: 3 })
  const snapshot = renderSnapshot([own])
  const tsc = (diagnostics: ReadonlyArray<Diagnostic>, unlocated: ReadonlyArray<string> = []): TscOutput => ({ diagnostics, unlocated })
  const run = (output: TscOutput, overrides: { failSource?: string; passSource?: string; snapshot?: string | undefined } = {}) =>
    checkRun(
      output,
      [{ file: passFile, source: overrides.passSource ?? passSource }],
      [{ file: failFile, source: overrides.failSource ?? failSource, snapshot: "snapshot" in overrides ? overrides.snapshot : snapshot }],
      root
    )

  it("passes a sound pass fixture and a fail fixture whose diagnostic matches its directive and snapshot", () => {
    expect(run(tsc([own]))).toEqual({ problems: [], mismatches: [], largestGatedChars: own.text.length })
  })

  it("renders the snapshot as L<line>:<col> TS<code>, the text, and a blank line between blocks", () => {
    const second = diagnostic({ line: 9, column: 1, code: "TS2322", text: "Head\n  chain" })
    expect(renderSnapshot([own, second])).toBe(`L7:3 TS2345\n${own.text}\n\nL9:1 TS2322\nHead\n  chain\n`)
  })

  it("reports a missing or different snapshot as a mismatch", () => {
    expect(run(tsc([own]), { snapshot: undefined }).mismatches).toEqual([
      { snapshotPath: "/repo/test/types/fail/f.diagnostics.txt", expected: undefined, actual: snapshot }
    ])
    expect(run(tsc([own]), { snapshot: "stale" }).mismatches).toHaveLength(1)
  })

  it("fails a fail fixture that compiles cleanly", () => {
    expect(run(tsc([]), { snapshot: "" }).problems).toEqual([
      "test/types/fail/f.ts: expected to fail but compiled cleanly",
      "test/types/fail/f.ts:6: // @expect-error block (TS2345 Beta) expects 1 diagnostic(s), got 0"
    ])
  })

  it("fails a diagnostic inside the @valid block", () => {
    const inValid = diagnostic({ line: 4, column: 1 })
    expect(run(tsc([inValid, own])).problems).toEqual([`test/types/fail/f.ts:4:1 diagnostic inside the @valid block at L3 (TS2345)\n${inValid.text}`])
  })

  it("fails a diagnostic before any directive", () => {
    const early = diagnostic({ line: 1, column: 1 })
    expect(run(tsc([early, own])).problems).toEqual([`test/types/fail/f.ts:1:1 diagnostic before any directive (TS2345)\n${early.text}`])
  })

  it("fails a block that gets more diagnostics than it has directives", () => {
    const extra = diagnostic({ line: 7, column: 9 })
    expect(run(tsc([own, extra])).problems).toContain("test/types/fail/f.ts:6: // @expect-error block (TS2345 Beta) expects 1 diagnostic(s), got 2")
  })

  it("fails a fail fixture without a @valid twin", () => {
    const source = failSource.replace("// @valid", "// pass twin removed")
    expect(run(tsc([own]), { failSource: source }).problems).toEqual(["test/types/fail/f.ts: fail fixture has no // @valid block (its pass twin)"])
  })

  it("fails a pass fixture with a diagnostic, and one without an assertion", () => {
    const inPass = diagnostic({ file: passFile, line: 2, column: 1 })
    expect(run(tsc([inPass, own])).problems).toEqual([`test/types/pass/p.ts:2:1 pass fixture has a type error (TS2345)\n${inPass.text}`])
    expect(run(tsc([own]), { passSource: "export const one = 1" }).problems).toEqual(["test/types/pass/p.ts: pass fixture has no expectTypeOf or Equals assertion"])
  })

  it("fails diagnostics outside the fixtures and unlocated compiler output", () => {
    const elsewhere = diagnostic({ file: "/repo/src/x.ts", line: 1, column: 1 })
    expect(run(tsc([own, elsewhere], ["error TS18003: No inputs were found."])).problems).toEqual([
      "tsc printed output that is not a located diagnostic:\nerror TS18003: No inputs were found.",
      `src/x.ts:1:1 diagnostic outside the fixtures (TS2345)\n${elsewhere.text}`
    ])
  })

  it("fails fixtures that suppress compiler errors or augment the shared program", () => {
    const source = `${failSource}\n// @ts-expect-error\nx.hidden()\ndeclare global { interface X {} }`
    expect(run(tsc([own]), { failSource: source }).problems).toEqual([
      "test/types/fail/f.ts: a fixture must not use `declare global` or module augmentation, because all fixtures share one program",
      "test/types/fail/f.ts: L8: compiler suppression comments (@ts-expect-error, @ts-ignore, @ts-nocheck) are not allowed in fixtures"
    ])
  })
})
