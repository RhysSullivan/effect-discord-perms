/**
 * Agreement (DESIGN §5.10): pure, from one row to `agree` or the first mismatch kind, in this order. Shared by
 * the live runner and the offline replay.
 *
 * - `preflight-wiring`: step (b) is not the first of `preflightSet` (in M3 step (b) is `Preflight.decide`
 *   itself; M6 runs the real operation over the dry-run stub).
 * - `preflight-vs-raw`: preflight passed while the raw call neither succeeded nor degraded, or failed while it
 *   succeeded, or the raw code's mapped tag is not in `preflightSet` (§3.2).
 * - `level-vs-raw` (H-080): a raw 50001 where the resolver's level is not the one `Observed.codeForLevel` maps
 *   to 50001 (`view`), or a raw 50013 where it is not `action`.
 * - `resolver-vs-raw`: the resolver finds no missing error-mode flag while the raw call failed with 50013 or
 *   50001, or the raw call's degraded list differs from the resolver's missing degrade-mode flags.
 * - `recompute-vs-preflight`: step (d) (M5) differs from step (b) in tag or categories.
 * - `resolver-vs-oracle`: the oracle's missing flags differ from `missingBeforeMasks`. For an obfuscated
 *   channel only ViewChannel is compared. For an unseen one nothing is: the subject knows none of its
 *   overwrites, and the oracle (`implicit=false`) does not model thread membership.
 *
 * Flip controls (M4) and rule observations (M6) are judged where their rows are built.
 */
import type { PermissionFlag } from "../src/errors/Missing.generated.ts"
import { Observed } from "../src/permissions/Observed.ts"
import type { AgreementKind, Row } from "./TruthTable.ts"

/** What agreement needs to know about the operation beyond the row. */
export interface Facts {
  /** The flags whose absence fails the request (the row's and the payload's error-mode flags). */
  readonly needed: ReadonlyArray<PermissionFlag>
  /** The payload's degrade-mode flags. */
  readonly degradable: ReadonlyArray<PermissionFlag>
}

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => a.length === b.length && a.every((entry, index) => entry === b[index])

/** The agreement of a row (see the module comment). A row whose setup was unsupported agrees: nothing ran. */
export const agreement = (row: Omit<Row, "agreement">, facts: Facts): AgreementKind => {
  const { preflight, preflightSet, raw, resolver } = row
  if (raw.class === "setup-unsupported") return "agree"

  if (preflight === "n/a") return "preflight-wiring"
  if (preflight === "pass" ? preflightSet.length > 0 : preflightSet[0] !== preflight.tag) return "preflight-wiring"

  const rawOk = raw.class === "success" || raw.class === "degraded"
  const rawFailed = !rawOk
  if ((preflight === "pass" && rawFailed) || (preflight !== "pass" && rawOk)) return "preflight-vs-raw"
  if (raw.mappedTag !== "n/a" && !preflightSet.includes(raw.mappedTag)) return "preflight-vs-raw"

  const codeOf = (level: Row["resolver"]["level"]): number | undefined =>
    level === "view" ? Observed.codeForLevel.view : level === "action" ? Observed.codeForLevel.action : undefined
  if ((raw.class === "50001" || raw.class === "50013") && codeOf(resolver.level) !== raw.code) return "level-vs-raw"

  const missingNeeded = resolver.missing.filter((flag) => facts.needed.includes(flag))
  if ((raw.class === "50001" || raw.class === "50013") && missingNeeded.length === 0) return "resolver-vs-raw"
  if (rawOk && !sameList([...raw.degraded].sort(), resolver.missing.filter((flag) => facts.degradable.includes(flag)).sort())) return "resolver-vs-raw"

  const recompute = row.recompute
  if (recompute !== "n/a" && (preflight === "pass" || preflight.tag !== recompute.tag || !sameList(preflight.categories, recompute.categories))) return "recompute-vs-preflight"

  const oracle = row.oracle
  if (typeof oracle === "object" && !resolver.masks.includes("unseen")) {
    if (resolver.masks.includes("obfuscated")) {
      if (oracle.missing.includes("ViewChannel") !== resolver.missing.includes("ViewChannel")) return "resolver-vs-oracle"
    } else if (!sameList([...oracle.missing].sort(), [...resolver.missingBeforeMasks].sort())) {
      return "resolver-vs-oracle"
    }
  }
  return "agree"
}
