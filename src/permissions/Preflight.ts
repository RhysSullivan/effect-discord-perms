/**
 * Preflight (DESIGN §4.7, §3.2): from an operation, a resolution and the payload's features, the ordered list
 * of every problem that would make Discord refuse the request, and the payload features Discord would drop.
 * `decide` is pure; the library's operations (M6) and the matrix's steps (b) and (d) use it, and the offline
 * replay re-runs it over the truth table.
 *
 * What counts as a problem:
 *
 * - **A blind channel** (obfuscated, unseen, or a private thread the bot neither belongs to nor moderates):
 *   ViewChannel, and nothing else, because nothing else about the channel is known.
 * - **A required flag missing after overwrites**: the row's flags and the payload's error-mode flags.
 *   Flags removed only by an implicit mask follow from another problem (no View, no Send, no Connect) and are
 *   not listed separately; granting the first problem's flag brings them back.
 * - **The timeout**: `CommunicationDisabled` when the timeout mask applies and the request needs a flag it
 *   does not keep (anything but View and ReadMessageHistory, H-020).
 * - **Thread state**, where the row lists the tag: a locked thread without ManageThreads (H-036), an archived
 *   thread (H-037). Send rows do not list `ThreadArchived`: sending unarchives (H-035).
 *
 * Payload degrade-mode flags never fail a request; when they are missing from the effective set they are
 * reported in `degraded`.
 */
import { Context } from "effect"
import { PreflightDecision } from "../errors/Cause.ts"
import type { PermissionFlag } from "../errors/Missing.generated.ts"
import { CommunicationDisabled, RoleAboveInHierarchy, RoleIsManaged, TargetAboveInHierarchy, TargetIsAdministrator, ThreadArchived, ThreadLocked } from "../errors/State.ts"
import { degradeFlags, errorFlags, type PayloadRuleName } from "../payload/PayloadRules.ts"
import * as Flags from "./Flags.ts"
import { errorFor, type OpName, Operations, type OpPermissionErrors, type OpSpec } from "./Operations.ts"
import { type Failure, sortFailures } from "./Order.ts"
import { blindMasks, type Resolution } from "./Resolver.ts"
import { ResolverRules } from "./ResolverRules.ts"

export type { Failure } from "./Order.ts"

/** What the request carries that changes its requirements. */
export interface DecideArgs {
  /** The payload features present (§2.3), for operations that send a payload; empty otherwise. */
  readonly payload: ReadonlyArray<PayloadRuleName>
}

/** Preflight's verdict. */
export interface Decision {
  /** Every flag the request needs: the row's, then the payload's error-mode and degrade-mode flags. */
  readonly required: ReadonlyArray<PermissionFlag>
  /** Every problem, most fundamental first (§3.2). Empty means the request may be sent. */
  readonly failures: ReadonlyArray<Failure>
  /** Degrade-mode payload flags missing from the effective permissions: features Discord will drop. */
  readonly degraded: ReadonlyArray<PermissionFlag>
}

/** The flags an operation with this payload needs, in order: the row's, the payload's error-mode, then degrade-mode. */
export const requiredFlags = (op: OpName, args: DecideArgs): ReadonlyArray<PermissionFlag> => {
  const out: Array<PermissionFlag> = []
  const row: OpSpec = Operations[op]
  for (const flag of [...row.flags, ...errorFlags(args.payload), ...degradeFlags(args.payload)]) if (!out.includes(flag)) out.push(flag)
  return out
}

/** The flags whose absence fails the request (the row's and the payload's error-mode flags). */
export const errorModeFlags = (op: OpName, args: DecideArgs): ReadonlyArray<PermissionFlag> => {
  const row: OpSpec = Operations[op]
  return [...new Set([...row.flags, ...errorFlags(args.payload)])]
}

/** Decides `op` over `resolution` (see the module comment). Pure. */
export const decide = (op: OpName, resolution: Resolution, args: DecideArgs): Decision => {
  const required = requiredFlags(op, args)
  const needed = errorModeFlags(op, args)
  const degraded = degradeFlags(args.payload).filter((flag) => !Flags.has(resolution.effective, flag))
  if (resolution.masks.some((mask) => blindMasks.has(mask))) {
    return { required, failures: [{ _tag: "MissingFlag", flag: "ViewChannel" }], degraded }
  }
  const held = resolution.afterOverwrites
  const failures: Array<Failure> = needed.filter((flag) => !Flags.has(held, flag)).map((flag) => ({ _tag: "MissingFlag", flag }))
  // The timeout blocks every needed flag it does not keep, whether or not the bot holds that flag otherwise,
  // so it is its own problem (ranked above SendMessages, §3.2).
  const timeout = resolution.timeout
  const kept = ResolverRules.timeoutKeeps.value
  if (timeout !== undefined && needed.some((flag) => !kept.includes(flag))) failures.push({ _tag: "CommunicationDisabled", until: timeout.until })
  const row: OpSpec = Operations[op]
  const thread = resolution.thread
  if (thread !== undefined) {
    const moderates = Flags.has(held, "ManageThreads")
    if (row.tags.includes("ThreadLocked") && thread.locked && !(ResolverRules.lockedThreadNeedsManageThreads.value && moderates)) {
      failures.push({ _tag: "ThreadLocked" })
    }
    if (row.tags.includes("ThreadArchived") && thread.archived) failures.push({ _tag: "ThreadArchived" })
  }
  return { required, failures: sortFailures(op, failures), degraded }
}

/** Every class preflight can fail an operation with. */
export type PreflightError =
  | OpPermissionErrors[OpName][PermissionFlag]
  | CommunicationDisabled
  | TargetAboveInHierarchy
  | RoleAboveInHierarchy
  | TargetIsAdministrator
  | ThreadLocked
  | ThreadArchived
  | RoleIsManaged

/** The error a failure becomes for `op`, with `cause`. Permission errors go through `errorFor` (D5 variants). */
export const toError = (op: OpName, failure: Failure, cause: PreflightDecision): PreflightError => {
  switch (failure._tag) {
    case "MissingFlag":
      return errorFor(op, failure.flag, cause)
    case "CommunicationDisabled":
      return new CommunicationDisabled({ until: failure.until, cause })
    case "TargetAboveInHierarchy":
      return new TargetAboveInHierarchy({ cause })
    case "RoleAboveInHierarchy":
      return new RoleAboveInHierarchy({ cause })
    case "TargetIsAdministrator":
      return new TargetIsAdministrator({ cause })
    case "ThreadLocked":
      return new ThreadLocked({ cause })
    case "ThreadArchived":
      return new ThreadArchived({ cause })
    case "RoleIsManaged":
      return new RoleIsManaged({ cause })
  }
}

/** The tag `toError` gives a failure for `op` (the same-tag D5 variants share their base class's tag). */
export const tagOf = (op: OpName, failure: Failure): string => toError(op, failure, new PreflightDecision({ route: "", basis: "gateway-state" }))._tag

/**
 * Whether operations check permissions before sending (`"enforce"`, the default) or skip preflight
 * (`"bypass"`). Internal: only the harness sets `"bypass"`, for the matrix's step (d) (§4.1, §5.10).
 */
export const Mode = Context.Reference<"enforce" | "bypass">("internal/Preflight.Mode", { defaultValue: () => "enforce" })
