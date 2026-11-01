/**
 * Type-test runner (DESIGN §5.2, D30).
 *
 *   bun run test:types               check pass fixtures, the fail-fixture gate and the diagnostic snapshots
 *   bun run test:types -- --update   also rewrite the snapshots (review the diff; verify:offline never passes it)
 *
 * One `tsc -p test/types/tsconfig.json --pretty false` covers every fixture. Snapshots are exactly what tsc
 * printed: default truncation, no `--noErrorTruncation`, no `--locale`.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { assertPinnedCompiler, listFilesEndingWith, listTypeScriptFiles, repoRoot, runTsc } from "./lib/tsc.ts"
import { checkRun, type FailFixture, type Fixture, parseTscOutput, snapshotPathOf } from "./lib/typeTests.ts"

const args = process.argv.slice(2)
const update = args.includes("--update")
const unknownArgs = args.filter((arg) => arg !== "--update")
if (unknownArgs.length > 0) {
  console.error(`unknown arguments: ${unknownArgs.join(" ")} (the only option is --update)`)
  process.exit(2)
}

const typesDir = path.join(repoRoot, "test", "types")
const readFixture = (file: string): Fixture => ({ file, source: fs.readFileSync(file, "utf8") })
const passFixtures = listTypeScriptFiles(path.join(typesDir, "pass")).map(readFixture)
const failFixtures: ReadonlyArray<FailFixture> = listTypeScriptFiles(path.join(typesDir, "fail")).map((file) => {
  const snapshotPath = snapshotPathOf(file)
  return { ...readFixture(file), snapshot: fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, "utf8") : undefined }
})
const rel = (file: string): string => path.relative(repoRoot, file)

assertPinnedCompiler()
const run = runTsc(["-p", path.join(typesDir, "tsconfig.json"), "--pretty", "false"])
const failures: Array<string> = []
if (run.status === null) failures.push("tsc was killed by a signal")
const tsc = parseTscOutput(run.stdout + run.stderr, repoRoot)
const result = checkRun(tsc, passFixtures, failFixtures, repoRoot)
failures.push(...result.problems)

let written = 0
for (const mismatch of result.mismatches) {
  if (update) {
    fs.writeFileSync(mismatch.snapshotPath, mismatch.actual)
    written++
  } else {
    failures.push(
      `${rel(mismatch.snapshotPath)}: diagnostic snapshot ${mismatch.expected === undefined ? "missing" : "differs"} (run with -- --update and review)\n` +
        `--- expected\n${mismatch.expected ?? "<none>"}\n+++ actual\n${mismatch.actual}`
    )
  }
}

// A snapshot without its fixture is stale evidence.
const liveSnapshots = new Set(failFixtures.map((f) => snapshotPathOf(f.file)))
for (const snapshot of listFilesEndingWith(path.join(typesDir, "fail"), ".diagnostics.txt")) {
  if (liveSnapshots.has(snapshot)) continue
  if (update) {
    fs.rmSync(snapshot)
    written++
  } else {
    failures.push(`${rel(snapshot)}: snapshot has no fixture (run with -- --update to delete it)`)
  }
}

const summary =
  `${passFixtures.length} pass + ${failFixtures.length} fail fixtures, ${tsc.diagnostics.length} diagnostics, ` +
  `largest gated ${result.largestGatedChars}c, tsc ${run.elapsedMs.toFixed(0)} ms` +
  (update ? `, ${written} snapshot file(s) written or deleted` : "")
if (failures.length > 0) {
  console.error(failures.join("\n\n"))
  console.error(`\ntest:types FAIL ${failures.length} problem(s); ${summary}`)
  process.exit(1)
}
console.log(`test:types ok ${summary}`)
