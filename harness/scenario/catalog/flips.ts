/**
 * Flip controls (DESIGN §5.9). A 50013 never names a flag, so the check that preflight blames the right one is a
 * sibling row: the same setup with only the blamed flag granted. It must then succeed, or fail with the next
 * failure of the original's `preflightSet` (Agreement's `flip-control`, judged once both rows have run).
 *
 * One sibling per (operation row, first missing flag): the first row in ID order whose predicted first failure
 * is that flag (`Predict.predict`, which the replay holds to the live records), and which is not blind (a
 * private thread the subject cannot see is fixed by membership, not by a flag). Kick and ban are never flipped
 * (they could succeed; `forbidden-action`).
 *
 * The sibling grants the flag where the original lacked it: the flag leaves every removal, and joins the
 * original's first grant that is not an administrator source (or a new `lab-grant` grant).
 */
import type { PermissionFlag } from "../../../src/errors/Missing.generated.ts"
import { blindMasks } from "../../../src/permissions/Resolver.ts"
import * as Predict from "../../Predict.ts"
import { type Scenario, Setup } from "../Dsl.ts"
import { byId } from "./common.ts"

/** The setup with `flag` granted and no longer removed. */
export const flipSetup = (setup: Setup, flag: PermissionFlag): Setup => {
  const removals = setup.removals.map((removal) => ({ ...removal, flags: removal.flags.filter((candidate) => candidate !== flag) })).filter((removal) => removal.flags.length > 0)
  const index = setup.grants.findIndex((grant) => grant.via !== "administrator")
  const grants =
    index < 0
      ? [...setup.grants, { flags: [flag], via: "role" as const }]
      : setup.grants.map((grant, at) => (at === index && !grant.flags.includes(flag) ? { ...grant, flags: [...grant.flags, flag] } : grant))
  return new Setup({ ...setup, grants, removals })
}

/** A fixed instant for the predictions: only the timeout's being in the future matters. */
const predictedAt = Date.parse("2026-11-01T12:00:00Z")

/**
 * The flip controls for `scenarios` (see the module comment). A key whose rows are all blind (a thread hidden by
 * its parent's View deny resolves `unseen`, which hides every other problem) takes, in a second pass, the first
 * blind row whose flip the prediction shows clean: its failures are the original's minus the first (M6: so
 * ViewChannel in threads has a flip control, which the flag-coverage check requires). Keys with a row that is not
 * blind keep M4's choice.
 */
export const flipsOf = (scenarios: ReadonlyArray<Scenario>): ReadonlyArray<Scenario> => {
  const seen = new Set<string>()
  const out: Array<Scenario> = []
  const blind: Array<{ readonly scenario: Scenario; readonly key: string; readonly flag: PermissionFlag; readonly rest: ReadonlyArray<string> }> = []
  for (const scenario of byId(scenarios)) {
    if (scenario.operation._tag === "member" && (scenario.operation.action === "kick" || scenario.operation.action === "ban")) continue
    if (scenario.operation._tag === "rule") continue
    if (scenario.setup.channel === "media") continue
    const prediction = Predict.predict(scenario, Predict.symbolicIds, predictedAt)
    const [first, ...rest] = prediction.records.decision.failures
    if (first === undefined || first._tag !== "MissingFlag") continue
    const key = `${prediction.facts.op}|${first.flag}`
    if (prediction.resolution.masks.some((mask) => blindMasks.has(mask))) {
      blind.push({ scenario, key, flag: first.flag, rest: rest.map((failure) => JSON.stringify(failure)) })
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: `flip/${scenario.id}`, hypotheses: scenario.hypotheses, setup: flipSetup(scenario.setup, first.flag), operation: scenario.operation, flipOf: scenario.id })
  }
  for (const candidate of blind) {
    if (seen.has(candidate.key)) continue
    const setup = flipSetup(candidate.scenario.setup, candidate.flag)
    const flipped = Predict.predict({ setup, operation: candidate.scenario.operation }, Predict.symbolicIds, predictedAt).records.decision.failures.map((failure) => JSON.stringify(failure))
    if (flipped.join("|") !== candidate.rest.join("|")) continue
    seen.add(candidate.key)
    out.push({ id: `flip/${candidate.scenario.id}`, hypotheses: candidate.scenario.hypotheses, setup, operation: candidate.scenario.operation, flipOf: candidate.scenario.id })
  }
  return byId(out)
}
