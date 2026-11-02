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

/** The flip controls for `scenarios` (see the module comment). */
export const flipsOf = (scenarios: ReadonlyArray<Scenario>): ReadonlyArray<Scenario> => {
  const seen = new Set<string>()
  const out: Array<Scenario> = []
  for (const scenario of byId(scenarios)) {
    if (scenario.operation._tag === "member" && (scenario.operation.action === "kick" || scenario.operation.action === "ban")) continue
    if (scenario.setup.channel === "media") continue
    const prediction = Predict.predict(scenario, Predict.symbolicIds, predictedAt)
    const [first] = prediction.records.decision.failures
    if (first === undefined || first._tag !== "MissingFlag") continue
    if (prediction.resolution.masks.some((mask) => blindMasks.has(mask))) continue
    const key = `${prediction.facts.op}|${first.flag}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: `flip/${scenario.id}`, hypotheses: scenario.hypotheses, setup: flipSetup(scenario.setup, first.flag), operation: scenario.operation, flipOf: scenario.id })
  }
  return out
}
