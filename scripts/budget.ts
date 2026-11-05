/**
 * Compile budget (DESIGN §5.4, D33).
 *
 *   bun run budget               measure every budget project and compare with the committed baseline
 *   bun run budget -- --update   rewrite the baseline (review the diff; verify:offline never passes it)
 *
 * Two rows, each present once its projects exist:
 *
 * - the reference bot, `examples/reference-bot/tsconfig.json` (built in M10), compiled as a consumer of this package
 *   compiles it: it imports `effect-discord-perms` by name, which resolves through the package's own `exports` (today
 *   `"."` is `src/index.ts`, the source), so the library's implementation is checked with the bot. The script fails if
 *   the bot's program does not include that entry point, so a private `paths` mapping cannot change what is measured.
 *   Hard ceilings, +2% on Types and Instantiations, check time at most 1.5 x baseline + 25 ms;
 * - the per-command row: `examples/command-probe/tsconfig.none.json` (no commands) and
 *   `examples/command-probe/tsconfig.commands.json` (20 commands of 25 options with handlers, built with the
 *   command API in M8); their difference may grow by at most 2%.
 *
 * The baseline is `examples/reference-bot/budget.json` and must name the pinned TypeScript version. A row whose
 * projects exist without a baseline entry, or the reverse, fails. Before either row exists there is nothing to
 * measure, and the script says so.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Schema } from "effect"
import {
  Baseline,
  ceilingProblems,
  consumerEntryProblem,
  type PerCommandCost,
  parseExtendedDiagnostics,
  perCommandCost,
  perCommandRegressions,
  type ProjectStats,
  referenceBotRegressions,
  runsPerProject,
  summarize
} from "./lib/budget.ts"
import { assertPinnedCompiler, repoRoot, runTsc } from "./lib/tsc.ts"

const args = process.argv.slice(2)
const update = args.includes("--update")
const unknownArgs = args.filter((arg) => arg !== "--update")
if (unknownArgs.length > 0) {
  console.error(`unknown arguments: ${unknownArgs.join(" ")} (the only option is --update)`)
  process.exit(2)
}

const projects = {
  referenceBot: "examples/reference-bot/tsconfig.json",
  probeNone: "examples/command-probe/tsconfig.none.json",
  probeCommands: "examples/command-probe/tsconfig.commands.json"
} as const
/** The slice of `package.json` that says where a consumer importing the package by name lands. */
const PackageExports = Schema.Struct({ exports: Schema.Struct({ ".": Schema.String }) })
const baselinePath = path.join(repoRoot, "examples/reference-bot/budget.json")
const exists = (relative: string): boolean => fs.existsSync(path.join(repoRoot, relative))

const version = assertPinnedCompiler()
const problems: Array<string> = []

/** Compiles one project `runsPerProject` times and combines the runs; `undefined` after recording a problem. */
const measure = (project: string): ProjectStats | undefined => {
  const runs = Array.from({ length: runsPerProject }, () =>
    parseExtendedDiagnostics(runTsc(["-p", project, "--extendedDiagnostics", "--checkers", "1", "--pretty", "false"]).stdout)
  )
  const summary = summarize(runs)
  if (summary._tag === "Unmeasurable") {
    problems.push(`${project}: ${summary.reason}`)
    return undefined
  }
  console.log(
    `${project}: files ${summary.stats.files}, types ${summary.stats.types}, instantiations ${summary.stats.instantiations}, ` +
      `check ${summary.stats.checkMs} ms (samples ${summary.checkSamplesMs.join(", ")}), memory ${summary.stats.memoryKb}K`
  )
  return summary.stats
}

const baseline = fs.existsSync(baselinePath)
  ? Schema.decodeUnknownSync(Schema.fromJsonString(Baseline))(fs.readFileSync(baselinePath, "utf8"))
  : undefined
if (baseline !== undefined && baseline.typescript !== version && !update) {
  problems.push(`the baseline was recorded with TypeScript ${baseline.typescript}, the pinned compiler is ${version}; counts are not comparable, re-baseline deliberately`)
}

// The reference bot row.
let referenceBot: ProjectStats | undefined
if (exists(projects.referenceBot)) {
  const entry = path.join(repoRoot, Schema.decodeUnknownSync(Schema.fromJsonString(PackageExports))(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).exports["."])
  const reached = consumerEntryProblem(runTsc(["-p", projects.referenceBot, "--listFilesOnly", "--pretty", "false"]).stdout.split("\n"), entry)
  if (reached !== undefined) problems.push(reached)
  else referenceBot = measure(projects.referenceBot)
  if (referenceBot !== undefined) {
    problems.push(...ceilingProblems(referenceBot))
    if (!update) {
      if (baseline?.referenceBot === undefined) problems.push("the reference bot has no baseline row; run with -- --update and commit it")
      else problems.push(...referenceBotRegressions(referenceBot, baseline.referenceBot))
    }
  }
} else if (baseline?.referenceBot !== undefined) {
  problems.push(`the baseline has a reference bot row, but ${projects.referenceBot} does not exist`)
}

// The per-command row.
let perCommand: PerCommandCost | undefined
const probesPresent = [projects.probeNone, projects.probeCommands].filter(exists)
if (probesPresent.length === 1) {
  problems.push(`the command probes come in pairs; only ${probesPresent[0]} exists`)
} else if (probesPresent.length === 2) {
  const none = measure(projects.probeNone)
  const withCommands = measure(projects.probeCommands)
  if (none !== undefined && withCommands !== undefined) {
    const cost = perCommandCost(none, withCommands)
    if (typeof cost === "string") problems.push(cost)
    else {
      perCommand = cost
      console.log(
        `per command (${cost.options} options, with handler): ${(cost.types / cost.commands).toFixed(1)} types, ` +
          `${(cost.instantiations / cost.commands).toFixed(1)} instantiations`
      )
      if (!update) {
        if (baseline?.perCommand === undefined) problems.push("the command probes have no baseline row; run with -- --update and commit it")
        else problems.push(...perCommandRegressions(cost, baseline.perCommand))
      }
    }
  }
} else if (baseline?.perCommand !== undefined) {
  problems.push("the baseline has a per-command row, but the command probes do not exist")
}

if (problems.length > 0) {
  console.error(`budget FAIL:\n- ${problems.join("\n- ")}`)
  process.exit(1)
}
if (!exists(projects.referenceBot) && probesPresent.length === 0) {
  console.log(`budget ok: nothing to measure yet (no ${projects.referenceBot} and no command probes; they arrive in M8 and M10)`)
  process.exit(0)
}
if (update) {
  const next: Baseline = {
    typescript: version,
    ...(referenceBot === undefined ? {} : { referenceBot }),
    ...(perCommand === undefined ? {} : { perCommand })
  }
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true })
  fs.writeFileSync(baselinePath, `${JSON.stringify(Schema.encodeSync(Baseline)(next), null, 2)}\n`)
  console.log(`budget baseline written to ${path.relative(repoRoot, baselinePath)}`)
  process.exit(0)
}
console.log("budget ok")
