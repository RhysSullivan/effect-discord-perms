/**
 * The offline gate (DESIGN §5.1).
 *
 *   bun run verify:offline
 *
 * Runs, in order, stopping at the first failure: gen:errors --check, typecheck, test, test:types, hover,
 * rules, budget. It never passes --update and takes no arguments, so nothing can be re-snapshotted through it.
 * A step whose script has not been written yet (gen:errors before M1) is reported as not built, by name, in
 * the summary; every other step must run and pass.
 */
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { repoRoot } from "./lib/tsc.ts"

if (process.argv.length > 2) {
  console.error(`unknown arguments: ${process.argv.slice(2).join(" ")} (verify:offline takes none and never passes --update)`)
  process.exit(2)
}

interface Step {
  /** The package.json script. */
  readonly script: string
  readonly args: ReadonlyArray<string>
  /** The file the script runs, for steps whose script is written by a later milestone. */
  readonly source?: string
}

const steps: ReadonlyArray<Step> = [
  { script: "gen:errors", args: ["--check"], source: "scripts/gen-errors.ts" },
  { script: "typecheck", args: [] },
  { script: "test", args: [] },
  { script: "test:types", args: [] },
  { script: "hover", args: [] },
  { script: "rules", args: [] },
  { script: "budget", args: [] }
]

const started = performance.now()
const report: Array<string> = []
const notBuilt: Array<string> = []
for (const step of steps) {
  if (step.source !== undefined && !fs.existsSync(path.join(repoRoot, step.source))) {
    notBuilt.push(`${step.script} (${step.source})`)
    report.push(`  ${step.script}: not built yet (${step.source} does not exist)`)
    continue
  }
  const label = [step.script, ...step.args].join(" ")
  console.log(`\n== verify:offline: ${label}`)
  const stepStarted = performance.now()
  const result = spawnSync(process.execPath, ["run", step.script, ...(step.args.length > 0 ? ["--", ...step.args] : [])], {
    cwd: repoRoot,
    stdio: "inherit"
  })
  const seconds = ((performance.now() - stepStarted) / 1000).toFixed(1)
  if (result.error !== undefined || result.status !== 0) {
    const why = result.error !== undefined ? result.error.message : result.status === null ? `killed by ${result.signal}` : `exit ${result.status}`
    report.push(`  ${label}: FAIL (${why}, ${seconds} s)`)
    console.error(`\nverify:offline FAIL at ${label}\n${report.join("\n")}`)
    process.exit(1)
  }
  report.push(`  ${label}: ok (${seconds} s)`)
}
const total = ((performance.now() - started) / 1000).toFixed(1)
console.log(`\nverify:offline ok in ${total} s\n${report.join("\n")}`)
if (notBuilt.length > 0) console.log(`not built yet: ${notBuilt.join(", ")}`)
