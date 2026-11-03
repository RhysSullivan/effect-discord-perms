/**
 * Flag-coverage rows (DESIGN §5.5, M6). The flag-coverage check needs, for every operation row's flag, a live row
 * where the flag is preflight's first failure and Discord refused, and that row's flip control. The families give
 * most; for each (operation row, flag) they leave without one a flip control can be made of, this module derives a
 * row from the first family row of that operation in ID order (not timed out, without an administrator grant):
 * its setup with every flag the request needs granted, then that one flag taken away, kept only when the
 * prediction's failures are exactly that flag and its flip passes. Its flip control (`flips.ts`) is then the setup with everything
 * granted, which must succeed. The derivation is deterministic, so runs and the replay see the same rows.
 *
 * A family row covers a key when it is not blind, or when it is blind and its flip's prediction is clean (its
 * failures the original's minus the first), the rule `flips.ts` picks flips by.
 *
 * `permissions.require` (no request) and `dm.send` (no flag, no DM row) have none, as rules-check exempts them.
 */
import type { PermissionFlag } from "../../../src/errors/Missing.generated.ts"
import { type OpName, Operations, type OpSpec } from "../../../src/permissions/Operations.ts"
import { blindMasks } from "../../../src/permissions/Resolver.ts"
import * as Predict from "../../Predict.ts"
import { type Scenario, Setup } from "../Dsl.ts"
import { byId } from "./common.ts"
import { flipSetup } from "./flips.ts"

/** A fixed instant for the predictions: only the timeout's being in the future matters. */
const predictedAt = Date.parse("2026-11-01T12:00:00Z")

/** The operations no row can cover (see the module comment). */
const exempt: ReadonlySet<OpName> = new Set<OpName>(["permissions.require", "dm.send"])

/** The setup with `flag` granted nowhere and removed nowhere. */
export const withoutFlag = (setup: Setup, flag: PermissionFlag): Setup =>
  new Setup({
    ...setup,
    grants: setup.grants.map((grant) => ({ ...grant, flags: grant.flags.filter((candidate) => candidate !== flag) })).filter((grant) => grant.flags.length > 0 || grant.via === "administrator"),
    removals: setup.removals.map((removal) => ({ ...removal, flags: removal.flags.filter((candidate) => candidate !== flag) })).filter((removal) => removal.flags.length > 0)
  })

const failuresOf = (scenario: Pick<Scenario, "setup" | "operation">): ReadonlyArray<string> =>
  Predict.predict(scenario, Predict.symbolicIds, predictedAt).records.decision.failures.map((failure) => JSON.stringify(failure))

/** The coverage rows for `family` (see the module comment). */
export const coverageRowsOf = (family: ReadonlyArray<Scenario>): ReadonlyArray<Scenario> => {
  const usable = byId(family).filter((scenario) => scenario.setup.channel !== "media" && scenario.flipOf === undefined && scenario.operation._tag !== "rule")
  const predicted = usable.map((scenario) => ({ scenario, prediction: Predict.predict(scenario, Predict.symbolicIds, predictedAt) }))
  const covered = new Set<string>()
  for (const { scenario, prediction } of predicted) {
    const [first, ...rest] = prediction.records.decision.failures
    if (first?._tag !== "MissingFlag") continue
    const blind = prediction.resolution.masks.some((mask) => blindMasks.has(mask))
    const clean = !blind || failuresOf({ setup: flipSetup(scenario.setup, first.flag), operation: scenario.operation }).join("|") === rest.map((failure) => JSON.stringify(failure)).join("|")
    if (clean) covered.add(`${prediction.facts.op}|${first.flag}`)
  }
  const out: Array<Scenario> = []
  for (const op of Object.keys(Operations) as ReadonlyArray<OpName>) {
    if (exempt.has(op)) continue
    const spec: OpSpec = Operations[op]
    const bases = predicted.filter(({ scenario, prediction }) => prediction.facts.op === op && scenario.setup.memberState === "normal" && !scenario.setup.grants.some((grant) => grant.via === "administrator"))
    for (const flag of spec.flags) {
      if (covered.has(`${op}|${flag}`)) continue
      for (const { scenario, prediction } of bases) {
        const granted = prediction.facts.needed.reduce((setup, needed) => flipSetup(setup, needed), scenario.setup)
        const setup = withoutFlag(granted, flag)
        if (failuresOf({ setup, operation: scenario.operation }).join("|") !== JSON.stringify({ _tag: "MissingFlag", flag })) continue
        // a blind row hides the thread's state: its flip control must pass outright
        if (failuresOf({ setup: flipSetup(setup, flag), operation: scenario.operation }).length > 0) continue
        out.push({ id: `coverage/${scenario.id}/without-${flag}`, hypotheses: scenario.hypotheses, setup, operation: scenario.operation })
        covered.add(`${op}|${flag}`)
        break
      }
    }
  }
  return byId(out)
}
