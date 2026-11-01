/**
 * Rule-registry completeness (DESIGN §5.5).
 *
 *   bun run rules
 *
 * Reads `test/rules.ts`, the fail fixtures and their snapshots, DESIGN.md §8 and LOG.md. An empty registry
 * passes only when no fail fixture has a directive, because every directive must be claimed by a rule.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { rules } from "../test/rules.ts"
import { openQuestionsOf, pendingChecks, registryProblems } from "./lib/rules.ts"
import { listTypeScriptFiles, repoRoot } from "./lib/tsc.ts"
import { snapshotPathOf } from "./lib/typeTests.ts"

if (process.argv.length > 2) {
  console.error(`unknown arguments: ${process.argv.slice(2).join(" ")} (rules-check takes none)`)
  process.exit(2)
}

/** Both documents are required inputs; a missing one is a broken checkout, so the read throws. */
const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), "utf8")

const failFixtures = listTypeScriptFiles(path.join(repoRoot, "test", "types", "fail")).map((file) => {
  const snapshotPath = snapshotPathOf(file)
  return {
    path: path.relative(repoRoot, file),
    source: fs.readFileSync(file, "utf8"),
    snapshot: fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, "utf8") : undefined
  }
})

const problems = registryProblems(rules, {
  fileExists: (relative) => fs.existsSync(path.join(repoRoot, relative)),
  failFixtures,
  openQuestions: openQuestionsOf(read("docs/DESIGN.md")),
  log: read("LOG.md")
})

const byKind = (kind: string): number =>
  rules.filter((rule) => (rule.live.kind === "not-live" ? `not-live:${rule.live.reason}` : rule.live.kind) === kind).length
const summary =
  `${rules.length} rule(s) (${byKind("pair")} live pair, ${byKind("escalated")} escalated, ${byKind("not-live:pure-typing")} pure-typing, ` +
  `${rules.length - byKind("pair") - byKind("escalated") - byKind("not-live:pure-typing")} other not-live), ${failFixtures.length} fail fixture(s)`
console.log(`rules: not checked yet, because their inputs do not exist:\n- ${pendingChecks.join("\n- ")}`)
if (problems.length > 0) {
  console.error(`rules FAIL ${problems.length} problem(s); ${summary}\n- ${problems.join("\n- ")}`)
  process.exit(1)
}
console.log(`rules ok ${summary}`)
