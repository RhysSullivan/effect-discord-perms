import { describe, expect, it } from "vitest"
import {
  ceilingProblems,
  consumerEntryProblem,
  parseExtendedDiagnostics,
  perCommandCost,
  perCommandRegressions,
  type ProjectStats,
  referenceBotRegressions,
  summarize
} from "../../scripts/lib/budget.ts"

/** `tsc --extendedDiagnostics` output as TS 7.0.2 prints it (docs/research/type-testing.md §1). */
const output = (overrides: { types?: number; instantiations?: number; check?: string } = {}): string =>
  [
    "Files:              395",
    "Lines:           201554",
    "Identifiers:     190000",
    "Symbols:         120000",
    `Types:            ${overrides.types ?? 27628}`,
    `Instantiations:  ${overrides.instantiations ?? 133758}`,
    "Memory used:    150636K",
    "Memory allocs:   1234567",
    "Config time:     0.000s",
    "Parse time:      0.033s",
    "Bind time:       0.014s",
    ...(overrides.check === undefined ? ["Check time:      0.171s"] : overrides.check === "" ? [] : [`Check time:      ${overrides.check}`]),
    "Emit time:       0.000s",
    "Total time:      0.225s"
  ].join("\n")

const stats = (overrides: Partial<ProjectStats> = {}): ProjectStats => ({
  files: 395,
  types: 27628,
  instantiations: 133758,
  memoryKb: 150636,
  checkMs: 171,
  ...overrides
})

describe("parseExtendedDiagnostics", () => {
  it("reads the counts and converts times to milliseconds", () => {
    expect(parseExtendedDiagnostics(output())).toEqual({ _tag: "Measured", stats: stats() })
  })

  it("cannot measure a project with diagnostics or without a check time", () => {
    expect(parseExtendedDiagnostics(`main.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.\n${output()}`)).toEqual({
      _tag: "Unmeasurable",
      reason: "the project does not compile:\nmain.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'."
    })
    expect(parseExtendedDiagnostics(output({ check: "" }))).toEqual({ _tag: "Unmeasurable", reason: '"Check time" is missing from the --extendedDiagnostics output' })
  })
})

describe("summarize", () => {
  it("requires identical counts and takes the median check time", () => {
    const runs = ["0.171s", "0.150s", "0.300s", "0.160s", "0.190s"].map((check) => parseExtendedDiagnostics(output({ check })))
    expect(summarize(runs)).toEqual({ _tag: "Summarized", stats: stats({ checkMs: 171 }), checkSamplesMs: [171, 150, 300, 160, 190] })
  })

  it("rejects runs whose counts differ", () => {
    const summary = summarize([parseExtendedDiagnostics(output()), parseExtendedDiagnostics(output({ instantiations: 133759 }))])
    expect(summary._tag).toBe("Unmeasurable")
  })
})

describe("ceilings", () => {
  it("allows exactly the ceiling and rejects one over", () => {
    expect(ceilingProblems(stats({ instantiations: 250_000, types: 60_000, checkMs: 1_000 }))).toEqual([])
    expect(ceilingProblems(stats({ instantiations: 250_001, types: 60_001, checkMs: 1_001 }))).toEqual([
      "instantiations 250001 exceed the ceiling 250000",
      "types 60001 exceed the ceiling 60000",
      "check time 1001 ms exceeds the ceiling 1000 ms"
    ])
  })
})

describe("referenceBotRegressions", () => {
  const baseline = stats({ types: 10_000, instantiations: 100_000, checkMs: 100 })

  it("allows +2% on counts and 1.5 x baseline + 25 ms on check time", () => {
    expect(referenceBotRegressions(stats({ types: 10_200, instantiations: 102_000, checkMs: 175 }), baseline)).toEqual([])
  })

  it("rejects anything beyond", () => {
    expect(referenceBotRegressions(stats({ types: 10_201, instantiations: 102_001, checkMs: 176 }), baseline)).toEqual([
      "reference bot instantiations 100000 -> 102001 (+2.0%, tolerance 2%)",
      "reference bot types 10000 -> 10201 (+2.0%, tolerance 2%)",
      "reference bot check time 100 -> 176 ms (limit 175 ms)"
    ])
  })
})

describe("consumerEntryProblem", () => {
  const entry = "/repo/src/index.ts"

  it("accepts a program that reaches the package's entry point, whatever else it lists", () => {
    expect(consumerEntryProblem(["/repo/node_modules/effect/dist/index.d.ts", ` ${entry}`, "/repo/src/config/Credentials.ts", ""], entry)).toBeUndefined()
  })

  it("rejects a program that reaches the library some other way (a paths mapping to declarations the package does not ship)", () => {
    expect(consumerEntryProblem(["/repo/examples/reference-bot/bot.ts", "/repo/.budget/declarations/src/index.d.ts"], entry)).toBe(
      "the reference bot's program does not include the package's entry point /repo/src/index.ts (package.json exports \".\"); it must import effect-discord-perms by name, with no paths mapping, as a consumer does"
    )
  })
})

describe("per-command row", () => {
  const none = stats({ types: 31_622, instantiations: 117_714 })
  const twenty = stats({ types: 39_350, instantiations: 160_749 })

  it("is the difference between the probes", () => {
    expect(perCommandCost(none, twenty)).toEqual({ commands: 20, options: 25, types: 7_728, instantiations: 43_035 })
  })

  it("rejects probes where the commands cost nothing", () => {
    expect(typeof perCommandCost(none, none)).toBe("string")
  })

  it("fails a growth of more than 2%", () => {
    const baseline = { commands: 20, options: 25, types: 7_728, instantiations: 43_035 }
    expect(perCommandRegressions({ ...baseline, instantiations: 43_895 }, baseline)).toEqual([])
    expect(perCommandRegressions({ ...baseline, instantiations: 43_896 }, baseline)).toEqual([
      "instantiations of 20 commands 43035 -> 43896 (+2.0%, tolerance 2%)"
    ])
    expect(perCommandRegressions({ ...baseline, options: 10 }, baseline)).toHaveLength(1)
  })
})
