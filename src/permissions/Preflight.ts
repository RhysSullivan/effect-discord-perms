/**
 * Preflight (DESIGN §4.7, §3.2): from an operation, a resolution and the payload's features, the ordered list
 * of every problem that would make Discord refuse the request, and the payload features Discord would drop.
 * `decide` is pure; the library's operations (M6) and the matrix's steps (b) and (d) use it, and the offline
 * replay re-runs it over the truth table.
 *
 * What counts as a problem:
 *
 * - **A blind channel** (obfuscated, unseen, or a private thread the bot neither belongs to nor moderates):
 *   ViewChannel, and nothing else, because nothing else about the channel is known; nothing at all for a row
 *   that needs no View (leaving a thread).
 * - **A required flag missing after overwrites**: the row's flags and the payload's error-mode flags.
 *   Flags removed only by an implicit mask follow from another problem (no View, no Send, no Connect) and are
 *   not listed separately; granting the first problem's flag brings them back.
 * - **The timeout**: `CommunicationDisabled` when the timeout mask applies and the request needs a flag it
 *   does not keep (anything but View and ReadMessageHistory, H-020), or the row is `blockedByTimeout` (an own
 *   message's edit).
 * - **Thread state**, where the row lists the tag: a locked thread without ManageThreads (H-036), an archived
 *   thread (H-037). Send rows do not list `ThreadArchived`: sending unarchives (H-035).
 * - **Hierarchy**, for member operations: a target not below the bot (H-064, H-066), an Administrator target of a
 *   timeout (H-067), a role not below the bot's highest role (H-060) or a managed one (H-068).
 * - **A required tag** on a forum or media post (H-044).
 *
 * The row's flags are adjusted to the request: AddReactions only for a new emoji (H-144), and no ManageThreads
 * for the creator archiving, locking or deleting its thread (H-045, M4 live). Degrade-mode flags (the payload's, and the row's `degrades`,
 * such as ReadMessageHistory for the pins list, H-107) never fail a request; when they are missing from the
 * effective set they are reported in `degraded`.
 */
import { Context } from "effect"
import { type ErrorCause, PreflightDecision } from "../errors/Cause.ts"
import type { PermissionFlag } from "../errors/Missing.generated.ts"
import { PermissionRevokedSinceCheck } from "../errors/Permission.ts"
import {
  CommunicationDisabled,
  RoleAboveInHierarchy,
  RoleIsManaged,
  TagRequired,
  TargetAboveInHierarchy,
  TargetIsAdministrator,
  ThreadArchived,
  ThreadLocked
} from "../errors/State.ts"
import { degradeFlags, errorFlags, type PayloadRuleName } from "../payload/PayloadRules.ts"
import * as Flags from "./Flags.ts"
import { errorFor, type OpName, Operations, type OpPermissionErrors, type OpSpec } from "./Operations.ts"
import { type Failure, sortFailures } from "./Order.ts"
import type { RoleId } from "../Snowflake.ts"
import { basePermissions, blindMasks, type GuildInput, type MemberInput, type Resolution, roleBelow, targetBelow } from "./Resolver.ts"
import { ResolverRules } from "./ResolverRules.ts"

export type { Failure } from "./Order.ts"

/** What the request carries that changes its requirements. */
export interface DecideArgs {
  /** The payload features present (§2.3), for operations that send a payload; empty otherwise. */
  readonly payload: ReadonlyArray<PayloadRuleName>
  /**
   * For a reaction: whether the emoji is on the message already. AddReactions is needed only for an emoji
   * nobody has reacted with yet (H-144); when that is not known (`unknown`) it is not checked, and a 50013 goes
   * to the recompute, which fetches the message (§4.7).
   */
  readonly reaction?: "new" | "existing" | "unknown"
  /**
   * For a member operation on a target: whether the target ranks below the bot (`Resolver.targetBelow`, H-064,
   * H-066) and whether it holds Administrator (a timeout cannot apply to it, H-067).
   */
  readonly target?: { readonly below: boolean; readonly administrator: boolean }
  /** For role assignment: whether the role is below the bot's highest role (`Resolver.roleBelow`, H-060) and managed (H-068). */
  readonly role?: { readonly below: boolean; readonly managed: boolean }
  /** For `thread.setArchived`, `thread.setLocked` and `thread.delete`: whether the bot created the thread, which they do not need ManageThreads for (H-045, M4 live). */
  readonly creator?: boolean
  /** For a forum or media post: whether it carries a tag, which a channel with `REQUIRE_TAG` demands (H-044). */
  readonly tagged?: boolean
}

/** Preflight's verdict. */
export interface Decision {
  /** Every flag the request needs: the row's, then the payload's error-mode and degrade-mode flags. */
  readonly required: ReadonlyArray<PermissionFlag>
  /** Every problem, most fundamental first (§3.2). Empty means the request may be sent. */
  readonly failures: ReadonlyArray<Failure>
  /**
   * Degrade-mode flags missing from the effective permissions: payload features Discord will drop, or a read
   * that returns less (the row's `degrades`, H-107).
   */
  readonly degraded: ReadonlyArray<PermissionFlag>
}

/**
 * The row's flags this request needs: AddReactions only for a new emoji (H-144), and ManageThreads not for the
 * creator archiving its thread (H-045).
 */
const rowFlags = (op: OpName, args: DecideArgs): ReadonlyArray<PermissionFlag> => {
  const row: OpSpec = Operations[op]
  const creatorExempt =
    args.creator === true &&
    ((op === "thread.setArchived" && ResolverRules.threadCreatorMayArchive.value) ||
      (op === "thread.setLocked" && ResolverRules.threadCreatorMayLock.value) ||
      (op === "thread.delete" && ResolverRules.threadCreatorMayDelete.value))
  return row.flags.filter((flag) => !(flag === "AddReactions" && row.variant === "reaction" && args.reaction !== "new") && !(flag === "ManageThreads" && creatorExempt))
}

/** The flags whose absence degrades the request instead of failing it: the payload's degrade-mode flags and the row's `degrades`. */
export const degradableFlags = (op: OpName, args: DecideArgs): ReadonlyArray<PermissionFlag> => {
  const row: OpSpec = Operations[op]
  return [...new Set([...degradeFlags(args.payload), ...(row.degrades ?? [])])]
}

/** The flags an operation with this request needs, in order: the row's, the payload's error-mode, then the degradable ones. */
export const requiredFlags = (op: OpName, args: DecideArgs): ReadonlyArray<PermissionFlag> => {
  const out: Array<PermissionFlag> = []
  for (const flag of [...rowFlags(op, args), ...errorFlags(args.payload), ...degradableFlags(op, args)]) if (!out.includes(flag)) out.push(flag)
  return out
}

/** The flags whose absence fails the request (the row's, as this request needs them, and the payload's error-mode flags). */
export const errorModeFlags = (op: OpName, args: DecideArgs): ReadonlyArray<PermissionFlag> => [...new Set([...rowFlags(op, args), ...errorFlags(args.payload)])]

/** Decides `op` over `resolution` (see the module comment). Pure. */
export const decide = (op: OpName, resolution: Resolution, args: DecideArgs): Decision => {
  const required = requiredFlags(op, args)
  const needed = errorModeFlags(op, args)
  const degraded = degradableFlags(op, args).filter((flag) => !Flags.has(resolution.effective, flag))
  const row: OpSpec = Operations[op]
  if (resolution.masks.some((mask) => blindMasks.has(mask))) {
    // a row that needs no View (leaving a thread, M4 live) still runs on a channel the bot cannot see
    return { required, failures: row.flags.includes("ViewChannel") ? [{ _tag: "MissingFlag", flag: "ViewChannel" }] : [], degraded }
  }
  const held = resolution.afterOverwrites
  const failures: Array<Failure> = needed.filter((flag) => !Flags.has(held, flag)).map((flag) => ({ _tag: "MissingFlag", flag }))
  // The timeout blocks every needed flag it does not keep, whether or not the bot holds that flag otherwise,
  // so it is its own problem (ranked above SendMessages, §3.2).
  const timeout = resolution.timeout
  const kept = ResolverRules.timeoutKeeps.value
  if (timeout !== undefined && (row.blockedByTimeout === true || needed.some((flag) => !kept.includes(flag)))) failures.push({ _tag: "CommunicationDisabled", until: timeout.until })
  const lists = (tag: OpSpec["tags"][number]): boolean => row.tags.includes(tag)
  const thread = resolution.thread
  if (thread !== undefined) {
    const moderates = Flags.has(held, "ManageThreads")
    if (lists("ThreadLocked") && thread.locked && !(ResolverRules.lockedThreadNeedsManageThreads.value && moderates)) failures.push({ _tag: "ThreadLocked" })
    if (lists("ThreadArchived") && thread.archived) failures.push({ _tag: "ThreadArchived" })
  }
  const target = args.target
  if (target !== undefined) {
    if (lists("TargetAboveInHierarchy") && !target.below) failures.push({ _tag: "TargetAboveInHierarchy" })
    if (lists("TargetIsAdministrator") && target.administrator) failures.push({ _tag: "TargetIsAdministrator" })
  }
  const role = args.role
  if (role !== undefined) {
    if (lists("RoleAboveInHierarchy") && !role.below) failures.push({ _tag: "RoleAboveInHierarchy" })
    if (lists("RoleIsManaged") && role.managed) failures.push({ _tag: "RoleIsManaged" })
  }
  if (lists("TagRequired") && resolution.requireTag && args.tagged !== true) failures.push({ _tag: "TagRequired" })
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
  | TagRequired

/** The error a failure becomes for `op`, with `cause`. Permission errors go through `errorFor` (D5 variants). */
export const toError = (op: OpName, failure: Failure, cause: ErrorCause): PreflightError => {
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
    case "TagRequired":
      return new TagRequired({ cause })
  }
}

/**
 * The error a failure becomes on a handle whose `granted` flags `Permissions.require` checked (D8): a missing flag
 * it checked is `PermissionRevokedSinceCheck` (the type collapses those `Missing*` into it), anything else is
 * {@link toError}'s. With nothing granted it is `toError`.
 */
export const toHandleError = (op: OpName, failure: Failure, granted: ReadonlyArray<PermissionFlag>, cause: ErrorCause): PreflightError | PermissionRevokedSinceCheck =>
  failure._tag === "MissingFlag" && granted.includes(failure.flag) ? new PermissionRevokedSinceCheck({ flag: failure.flag, cause }) : toError(op, failure, cause)

/** What the bot knows of the target member and the role assigned or removed, for member operations (H-060..H-067). */
export interface Hierarchy {
  readonly guild: GuildInput
  readonly bot: MemberInput
  readonly target: MemberInput
  /** The role a role operation assigns or removes. */
  readonly role: RoleId | undefined
}

/**
 * The request's arguments completed from the state: whether the bot created the thread (archiving, locking and
 * deleting it need no ManageThreads then, H-045), and for member operations the target's rank and Administrator
 * (H-064, H-066, H-067) and the role's rank and management (H-060, H-068). A role the guild does not hold adds
 * no role facts: Discord answers such a request with 10011, not a refusal.
 */
export const stateArgs = (op: OpName, args: DecideArgs, resolution: Resolution, hierarchy: Hierarchy | undefined): DecideArgs => {
  const creates = op === "thread.setArchived" || op === "thread.setLocked" || op === "thread.delete"
  let out: DecideArgs = creates ? { ...args, creator: resolution.thread?.creatorIsMember === true } : args
  if (hierarchy === undefined) return out
  const administrator = Flags.has(basePermissions(hierarchy.guild, hierarchy.target), "Administrator") || hierarchy.target.userId === hierarchy.guild.ownerId
  out = { ...out, target: { below: targetBelow(hierarchy.guild, hierarchy.bot, hierarchy.target), administrator } }
  const role = hierarchy.role === undefined ? undefined : hierarchy.guild.roles.get(hierarchy.role)
  return role === undefined ? out : { ...out, role: { below: roleBelow(hierarchy.guild, hierarchy.bot, role), managed: role.managed } }
}

/** The tag `toError` gives a failure for `op` (the same-tag D5 variants share their base class's tag). */
export const tagOf = (op: OpName, failure: Failure): string => toError(op, failure, new PreflightDecision({ route: "", basis: "gateway-state" }))._tag

/**
 * Whether operations check permissions before sending (`"enforce"`, the default) or skip preflight
 * (`"bypass"`). Internal: only the harness sets `"bypass"`, for the matrix's step (d) (§4.1, §5.10).
 */
export const Mode = Context.Reference<"enforce" | "bypass">("internal/Preflight.Mode", { defaultValue: () => "enforce" })
