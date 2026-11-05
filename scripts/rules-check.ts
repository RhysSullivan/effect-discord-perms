/**
 * Rule-registry completeness (DESIGN §5.5).
 *
 *   bun run rules
 *
 * Reads `test/rules.ts`, the fail fixtures and their snapshots, DESIGN.md §8, LOG.md, the rule rows of
 * `harness/scenario/catalog/rules.ts` and the committed truth table (`fixtures/truth-table.json`). It checks every
 * rule's fixtures, claims, live pair (both sides in the catalog and in the table, each observation equal to its
 * full expectation, one setup) or allowlisted reason, and the flag coverage of the table's matrix rows.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Schema } from "effect"
import * as RuleCatalog from "../harness/scenario/catalog/rules.ts"
import { scenarios } from "../harness/scenario/catalog/index.ts"
import { Observation, Setup } from "../harness/scenario/Dsl.ts"
import { staticFactsOf } from "../harness/scenario/Facts.ts"
import * as TruthTable from "../harness/TruthTable.ts"
import { rules } from "../test/rules.ts"
import { EventIntents } from "../src/gateway/Intents.ts"
import { isSessionName, sessions } from "../harness/scenario/catalog/intents.ts"
import { type CoverageRow, coverageProblems, escalatedRules, eventProblems, openQuestionsOf, type PairRowView, pendingChecks, registryProblems } from "./lib/rules.ts"
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

const encodeSetup = Schema.encodeSync(Schema.toCodecJson(Setup))
const encodeObservation = Schema.encodeSync(Schema.toCodecJson(Observation))
const canonical = (observation: Observation): string => TruthTable.canonicalJson(encodeObservation(observation))

const tablePath = path.join(repoRoot, "fixtures", "truth-table.json")
const table = fs.existsSync(tablePath) ? Schema.decodeUnknownSync(Schema.fromJsonString(TruthTable.TruthTable))(fs.readFileSync(tablePath, "utf8")) : undefined
const tableRows = table === undefined ? undefined : new Map(Object.entries(table.scenarios).map(([id, row]): readonly [string, PairRowView] => [
  id,
  { setup: TruthTable.canonicalJson(encodeSetup(row.setup)), observation: row.observation === undefined ? undefined : canonical(row.observation) }
]))

const ruleCatalog = new Map(
  RuleCatalog.scenarios.flatMap((scenario): ReadonlyArray<readonly [string, string]> => {
    const parsed = RuleCatalog.parseRuleScenario(scenario.id)
    return typeof parsed === "string" ? [] : [[scenario.id, parsed.setup]]
  })
)

const problems = [
  ...registryProblems(rules, {
    fileExists: (relative) => fs.existsSync(path.join(repoRoot, relative)),
    failFixtures,
    openQuestions: openQuestionsOf(read("docs/DESIGN.md")),
    log: read("LOG.md"),
    ruleCatalog,
    table: tableRows,
    canonical
  })
]

// every supported event has a live intent pair (M7)
const sessionOf = (scenario: string) => {
  const parsed = RuleCatalog.parseRuleScenario(scenario)
  if (typeof parsed === "string" || !isSessionName(parsed.probe)) return undefined
  const spec = sessions[parsed.probe]
  return { event: spec.event, intents: spec.intents }
}
const eventsChecked = Object.values(EventIntents).filter((intents) => intents.length > 0).length
problems.push(...eventProblems(rules, EventIntents, sessionOf))

// flag coverage over the committed table's matrix rows (the rule rows test rules, not flags)
const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
const coverageRows: Array<CoverageRow> = []
if (table === undefined) problems.push("flag coverage: there is no truth table (fixtures/truth-table.json)")
else {
  for (const [id, row] of Object.entries(table.scenarios)) {
    const scenario = byId.get(id)
    if (scenario === undefined || scenario.operation._tag === "rule") continue
    const facts = staticFactsOf(scenario)
    coverageRows.push({
      id,
      op: facts.op,
      flipOf: scenario.flipOf,
      ran: row.raw.class !== "setup-unsupported",
      granted: row.resolver.required.filter((flag) => !row.resolver.missing.includes(flag)),
      first: row.preflightSet[0],
      refused: row.raw.class === "50013" || row.raw.class === "50001" || row.raw.class === "other-error",
      degraded: row.raw.degraded,
      features: facts.args.payload
    })
  }
  problems.push(...coverageProblems(coverageRows).map((problem) => `flag coverage: ${problem}`))
}

const byKind = (kind: string): number =>
  rules.filter((rule) => (rule.live.kind === "not-live" ? `not-live:${rule.live.reason}` : rule.live.kind) === kind).length
const pairs = rules.filter((rule) => rule.live.kind === "pair")
// escalated remainders sit next to a live half; each is an unmet Done criterion `verify:live` prints (the final audit)
const remainders = escalatedRules(rules).filter((escalation) => escalation.part === "remainder")
const remainderQuestions = [...new Set(remainders.map((escalation) => escalation.question))].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))).join(", ")
const summary =
  `${rules.length} rule(s) (${byKind("pair")} live pair, ${byKind("escalated")} escalated, ${byKind("not-live:pure-typing")} pure-typing, ` +
  `${rules.length - byKind("pair") - byKind("escalated") - byKind("not-live:pure-typing")} other not-live; ` +
  `${remainders.length} escalated remainder(s)${remainders.length === 0 ? "" : `, waiting for Rhys (${remainderQuestions})`}), ${failFixtures.length} fail fixture(s), ` +
  `${pairs.reduce((sum, rule) => sum + (rule.live.kind === "pair" ? 2 + (rule.live.also?.length ?? 0) : 0), 0)} live sides and ` +
  `${rules.reduce((sum, rule) => sum + (rule.evidence?.length ?? 0), 0)} evidence row(s) checked against the table, ` +
  `${eventsChecked} event(s) with a live intent pair, flag coverage over ${coverageRows.length} matrix row(s)`
if (pendingChecks.length > 0) console.log(`rules: not checked yet, because their inputs do not exist:\n- ${pendingChecks.join("\n- ")}`)
if (problems.length > 0) {
  console.error(`rules FAIL ${problems.length} problem(s); ${summary}\n- ${problems.join("\n- ")}`)
  process.exit(1)
}
console.log(`rules ok ${summary}`)
