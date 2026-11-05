/**
 * The compile budget (DESIGN §5.4, D33): parsing `tsc --extendedDiagnostics --checkers 1` output, the baseline
 * format, the hard ceilings and the regression gates. Pure; `scripts/budget.ts` runs the compiler.
 *
 * With one checker, Types and Instantiations are deterministic (they do not depend on file splitting or core
 * count), so they are gated tightly. Check time is wall-clock, so it is the median of several runs, gated loosely.
 */
import { Schema } from "effect"

/** The measured cost of one project. */
export const ProjectStats = Schema.Struct({
  files: Schema.Int,
  types: Schema.Int,
  instantiations: Schema.Int,
  memoryKb: Schema.Int,
  checkMs: Schema.Int
})
export interface ProjectStats extends Schema.Schema.Type<typeof ProjectStats> {}

/**
 * The per-command row: the cost difference between two fixed probe projects that are identical except that one
 * registers `commands` commands of `options` options each, with handlers. Stored as totals so no rounding hides
 * a change; the per-command cost is `types / commands` and `instantiations / commands`.
 */
export const PerCommandCost = Schema.Struct({
  commands: Schema.Int,
  options: Schema.Int,
  types: Schema.Int,
  instantiations: Schema.Int
})
export interface PerCommandCost extends Schema.Schema.Type<typeof PerCommandCost> {}

/**
 * The committed baseline, `examples/reference-bot/budget.json`. A row is absent until its projects exist.
 *
 * - `referenceBot`: the reference bot as a consumer of this package compiles it, with the library it imports (DESIGN
 *   §5.4), held to the hard ceilings and the regression gates;
 * - `perCommand`: the per-command row.
 */
export const Baseline = Schema.Struct({
  typescript: Schema.String,
  referenceBot: Schema.optionalKey(ProjectStats),
  perCommand: Schema.optionalKey(PerCommandCost)
})
export interface Baseline extends Schema.Schema.Type<typeof Baseline> {}

/** Hard ceilings for the reference bot. Raising one is a design decision, never a re-baseline. */
export const ceilings = { instantiations: 250_000, types: 60_000, checkMs: 1_000 } as const

/** Regression tolerance against the baseline. */
export const tolerance = { counts: 0.02, checkFactor: 1.5, checkSlackMs: 25 } as const

/** The command probes register this many commands, each with this many options (§5.4). */
export const commandProbe = { commands: 20, options: 25 } as const

/** How many times each project is compiled. */
export const runsPerProject = 5

/** One compiler run: its counts, or why it cannot be measured. */
export type ParsedRun =
  | { readonly _tag: "Measured"; readonly stats: ProjectStats }
  | { readonly _tag: "Unmeasurable"; readonly reason: string }

const statLine = /^([A-Za-z ]+):\s+(\S+)$/

/**
 * Parses one `--extendedDiagnostics` run. A run with any diagnostic, or without `Check time` (which tsc omits
 * when the program has syntax errors), cannot be measured.
 */
export const parseExtendedDiagnostics = (output: string): ParsedRun => {
  const errors = output.split("\n").filter((line) => /error TS\d+/.test(line))
  if (errors.length > 0) return { _tag: "Unmeasurable", reason: `the project does not compile:\n${errors.join("\n")}` }
  const stats = new Map<string, string>()
  for (const line of output.split("\n")) {
    const match = statLine.exec(line.trim())
    if (match !== null) stats.set(match[1] ?? "", match[2] ?? "")
  }
  const read = (key: string, unit: RegExp, scale: number): number | string => {
    const raw = stats.get(key)
    if (raw === undefined) return `"${key}" is missing from the --extendedDiagnostics output`
    const value = Number(raw.replace(unit, ""))
    return Number.isFinite(value) ? Math.round(value * scale) : `"${key}" has the unreadable value "${raw}"`
  }
  const files = read("Files", /$^/, 1)
  const types = read("Types", /$^/, 1)
  const instantiations = read("Instantiations", /$^/, 1)
  const memoryKb = read("Memory used", /K$/, 1)
  const checkMs = read("Check time", /s$/, 1000)
  if (typeof files === "string") return { _tag: "Unmeasurable", reason: files }
  if (typeof types === "string") return { _tag: "Unmeasurable", reason: types }
  if (typeof instantiations === "string") return { _tag: "Unmeasurable", reason: instantiations }
  if (typeof memoryKb === "string") return { _tag: "Unmeasurable", reason: memoryKb }
  if (typeof checkMs === "string") return { _tag: "Unmeasurable", reason: checkMs }
  return { _tag: "Measured", stats: { files, types, instantiations, memoryKb, checkMs } }
}

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** The runs of one project combined: identical counts are required, times and memory are medians. */
export type Summary =
  | { readonly _tag: "Summarized"; readonly stats: ProjectStats; readonly checkSamplesMs: ReadonlyArray<number> }
  | { readonly _tag: "Unmeasurable"; readonly reason: string }

/** Combines repeated runs of one project. Counts that differ between identical runs make the budget meaningless. */
export const summarize = (runs: ReadonlyArray<ParsedRun>): Summary => {
  const measured: Array<ProjectStats> = []
  for (const run of runs) {
    if (run._tag === "Unmeasurable") return run
    measured.push(run.stats)
  }
  const first = measured[0]
  if (first === undefined) return { _tag: "Unmeasurable", reason: "no runs" }
  const differing = measured.find((s) => s.files !== first.files || s.types !== first.types || s.instantiations !== first.instantiations)
  if (differing !== undefined) {
    return {
      _tag: "Unmeasurable",
      reason: `Files/Types/Instantiations differ between identical runs (${first.files}/${first.types}/${first.instantiations} vs ` +
        `${differing.files}/${differing.types}/${differing.instantiations}); the budget cannot be deterministic`
    }
  }
  return {
    _tag: "Summarized",
    stats: { ...first, memoryKb: median(measured.map((s) => s.memoryKb)), checkMs: median(measured.map((s) => s.checkMs)) },
    checkSamplesMs: measured.map((s) => s.checkMs)
  }
}

/** The reference bot's hard-ceiling violations. */
export const ceilingProblems = (current: ProjectStats): ReadonlyArray<string> => [
  ...(current.instantiations > ceilings.instantiations ? [`instantiations ${current.instantiations} exceed the ceiling ${ceilings.instantiations}`] : []),
  ...(current.types > ceilings.types ? [`types ${current.types} exceed the ceiling ${ceilings.types}`] : []),
  ...(current.checkMs > ceilings.checkMs ? [`check time ${current.checkMs} ms exceeds the ceiling ${ceilings.checkMs} ms`] : [])
]

const growth = (name: string, now: number, then: number): ReadonlyArray<string> =>
  now > Math.floor(then * (1 + tolerance.counts))
    ? [`${name} ${then} -> ${now} (${then === 0 ? "from zero" : `+${(((now - then) / then) * 100).toFixed(1)}%`}, tolerance ${tolerance.counts * 100}%)`]
    : []

/** One project row's regressions against its baseline row: +2% on counts, check time at most 1.5 x baseline + 25 ms. */
const projectRegressions = (name: string, current: ProjectStats, baseline: ProjectStats): ReadonlyArray<string> => {
  const checkLimit = baseline.checkMs * tolerance.checkFactor + tolerance.checkSlackMs
  return [
    ...growth(`${name} instantiations`, current.instantiations, baseline.instantiations),
    ...growth(`${name} types`, current.types, baseline.types),
    ...(current.checkMs > checkLimit ? [`${name} check time ${baseline.checkMs} -> ${current.checkMs} ms (limit ${checkLimit} ms)`] : [])
  ]
}

/** The reference bot's regressions against its baseline row. */
export const referenceBotRegressions = (current: ProjectStats, baseline: ProjectStats): ReadonlyArray<string> => projectRegressions("reference bot", current, baseline)

/** The per-command cost from the two probes, or why it is not meaningful. */
export const perCommandCost = (none: ProjectStats, withCommands: ProjectStats): PerCommandCost | string => {
  const types = withCommands.types - none.types
  const instantiations = withCommands.instantiations - none.instantiations
  if (types <= 0 || instantiations <= 0) {
    return `the probe with ${commandProbe.commands} commands costs no more than the probe without (types ${types}, instantiations ${instantiations}); the probes are broken`
  }
  return { ...commandProbe, types, instantiations }
}

/** The package name a consumer imports. */
export const packageName = "effect-discord-perms"

const resolvedLine = /^=+ Module name '([^']+)' was successfully resolved to '([^']+)'/
const unresolvedLine = /^=+ Module name '([^']+)' was not resolved/

/**
 * Whether the reference bot reaches the library the way a consumer of this package does, read from the compiler's
 * `--traceResolution` lines: every import of `effect-discord-perms` resolves to the package's own entry point,
 * `entry` (`exports["."]` in `package.json`), and there is at least one. A `paths` mapping (or anything else) that
 * sends the import somewhere the package does not ship fails, even when another file of the program imports the
 * entry point directly. `undefined` when it does; otherwise the problem.
 */
export const consumerResolutionProblem = (trace: ReadonlyArray<string>, entry: string): string | undefined => {
  const targets: Array<string> = []
  for (const line of trace) {
    const text = line.trim()
    if (unresolvedLine.exec(text)?.[1] === packageName) return `the reference bot's import of ${packageName} does not resolve`
    const resolved = resolvedLine.exec(text)
    if (resolved !== null && resolved[1] === packageName) targets.push(resolved[2] ?? "")
  }
  if (targets.length === 0) return `the reference bot does not import ${packageName}; it must import the package by name, as a consumer does`
  const elsewhere = targets.find((target) => target !== entry)
  return elsewhere === undefined
    ? undefined
    : `the reference bot's import of ${packageName} resolves to ${elsewhere}, not to the package's entry point ${entry} (package.json exports "."); it must resolve through the package's exports, with no paths mapping, as a consumer's does`
}

/** The per-command row's regressions against its baseline row. */
export const perCommandRegressions = (current: PerCommandCost, baseline: PerCommandCost): ReadonlyArray<string> => {
  if (current.commands !== baseline.commands || current.options !== baseline.options) {
    return [`the command probes changed shape (${baseline.commands}x${baseline.options} -> ${current.commands}x${current.options}); re-baseline deliberately`]
  }
  return [
    ...growth(`instantiations of ${current.commands} commands`, current.instantiations, baseline.instantiations),
    ...growth(`types of ${current.commands} commands`, current.types, baseline.types)
  ]
}
