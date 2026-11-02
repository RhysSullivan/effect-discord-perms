/**
 * Agreement (DESIGN §5.10): pure, from one row to `agree` or the first mismatch kind, in this order. Shared by
 * the live runner and the offline replay.
 *
 * - `preflight-wiring`: step (b) is not the first of `preflightSet` (in M3 and M4 step (b) is `Preflight.decide`
 *   itself; M6 runs the real operation over the dry-run stub).
 * - `preflight-vs-raw`: preflight passed while the raw call neither succeeded nor degraded, or failed while it
 *   succeeded, or the raw code's mapped tag is not in `preflightSet` (§3.2).
 * - `level-vs-raw` (H-080): a raw 50001 or 50013 that is not the code `Observed.expectedCode` gives the
 *   resolver's level and preflight's first failure (50001 for `view`, 50013 for `action`, except the
 *   operation's observed `viewCodeFailures`).
 * - `resolver-vs-raw`: the raw call failed with 50013 or 50001 while the resolver finds no missing error-mode
 *   flag and preflight no state failure (the timeout, the hierarchy, a thread's state) that would explain it;
 *   or the raw call's degraded list differs from the resolver's missing degradable flags.
 * - `recompute-vs-preflight`: step (d) (M5) differs from step (b) in tag or categories.
 * - `resolver-vs-oracle`: the oracle's missing flags differ from `missingBeforeMasks`, with the timeout mask
 *   applied when the oracle applies it (`Observed.oracleAppliesTimeout`, H-241). For an obfuscated channel,
 *   and for an unseen one, only ViewChannel is compared: the subject knows none of their overwrites. An unseen
 *   private thread the subject does not belong to is not compared at all, because the oracle
 *   (`implicit=false`) does not model thread membership and reads View there.
 *
 * `flip-control` (§5.9) needs two rows: {@link flipAgreement} judges a flip control against its original once
 * both have run. Rule observations (M6) are judged where their rows are built.
 */
import type { PermissionFlag } from "../src/errors/Missing.generated.ts"
import { expectedCode, Observed } from "../src/permissions/Observed.ts"
import type { OpName } from "../src/permissions/Operations.ts"
import { ResolverRules } from "../src/permissions/ResolverRules.ts"
import type { AgreementKind, Row } from "./TruthTable.ts"

/** What agreement needs to know about the operation beyond the row. */
export interface Facts {
  /** The operation-table row (for the observed codes). */
  readonly op: OpName
  /** The flags whose absence fails the request (the row's, as the request needs them, and the payload's error-mode flags). */
  readonly needed: ReadonlyArray<PermissionFlag>
  /** The flags whose absence only degrades the request. */
  readonly degradable: ReadonlyArray<PermissionFlag>
}

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => a.length === b.length && a.every((entry, index) => entry === b[index])

/** A preflight tag that is not a missing flag: the timeout, the hierarchy, a thread's state. */
const isStateTag = (tag: string): boolean => !tag.startsWith("Missing")

const rawSucceeded = (raw: Row["raw"]): boolean => raw.class === "success" || raw.class === "degraded"

/** What the oracle should report missing for a row whose blind masks do not stop the comparison. */
export const expectedOracleMissing = (resolver: Row["resolver"]): ReadonlyArray<PermissionFlag> => {
  const kept = ResolverRules.timeoutKeeps.value
  const timedOut = Observed.oracleAppliesTimeout && resolver.masks.includes("timeout")
  const removed = timedOut ? resolver.required.filter((flag) => !kept.includes(flag)) : []
  return [...new Set([...resolver.missingBeforeMasks, ...removed])].sort()
}

/** The agreement of a row (see the module comment). A row whose setup was unsupported agrees: nothing ran. */
export const agreement = (row: Omit<Row, "agreement">, facts: Facts): AgreementKind => {
  const { preflight, preflightSet, raw, resolver } = row
  if (raw.class === "setup-unsupported") return "agree"

  if (preflight === "n/a") return "preflight-wiring"
  if (preflight === "pass" ? preflightSet.length > 0 : preflightSet[0] !== preflight.tag) return "preflight-wiring"

  const rawOk = rawSucceeded(raw)
  if ((preflight === "pass" && !rawOk) || (preflight !== "pass" && rawOk)) return "preflight-vs-raw"
  if (raw.mappedTag !== "n/a" && !preflightSet.includes(raw.mappedTag)) return "preflight-vs-raw"

  const permissionCode = raw.class === "50001" || raw.class === "50013"
  if (permissionCode && expectedCode(facts.op, resolver.level, preflightSet[0]) !== raw.code) return "level-vs-raw"

  const missingNeeded = resolver.missing.filter((flag) => facts.needed.includes(flag))
  if (permissionCode && missingNeeded.length === 0 && !preflightSet.some(isStateTag)) return "resolver-vs-raw"
  if (rawOk && !sameList([...raw.degraded].sort(), resolver.missing.filter((flag) => facts.degradable.includes(flag)).sort())) return "resolver-vs-raw"

  const recompute = row.recompute
  if (recompute !== "n/a" && (preflight === "pass" || preflight.tag !== recompute.tag || !sameList(preflight.categories, recompute.categories))) return "recompute-vs-preflight"

  const oracle = row.oracle
  if (typeof oracle === "object") {
    if (resolver.masks.includes("obfuscated") || (resolver.masks.includes("unseen") && !privateThreadNonMember(row.setup))) {
      if (oracle.missing.includes("ViewChannel") !== resolver.missing.includes("ViewChannel")) return "resolver-vs-oracle"
    } else if (!resolver.masks.includes("unseen") && !sameList([...oracle.missing].sort(), expectedOracleMissing(resolver))) {
      return "resolver-vs-oracle"
    }
  }
  return "agree"
}

/**
 * A flip control against its original (§5.9), both already judged on their own. When the original's raw call
 * failed, the flip, which grants only the original's first failure's flag, must succeed if that was the only
 * failure, or else fail with the original's next failure first. An original that did not fail (a mismatch of
 * its own) or a setup Discord would not build leaves nothing to check.
 */
export const flipAgreement = (original: Omit<Row, "agreement">, flip: Row): AgreementKind => {
  if (flip.agreement !== "agree") return flip.agreement
  if (original.raw.class === "setup-unsupported" || flip.raw.class === "setup-unsupported" || rawSucceeded(original.raw)) return "agree"
  const next = original.preflightSet[1]
  if (next === undefined) return rawSucceeded(flip.raw) ? "agree" : "flip-control"
  return !rawSucceeded(flip.raw) && flip.preflightSet[0] === next ? "agree" : "flip-control"
}

/**
 * A private thread the subject does not belong to: the oracle (`implicit=false`) computes it from the parent's
 * overwrites alone, so it reads View there even though the thread is invisible to the subject (H-033).
 */
const privateThreadNonMember = (setup: Row["setup"]): boolean => setup.channel === "private-thread" && setup.subjectThreadMember !== true
