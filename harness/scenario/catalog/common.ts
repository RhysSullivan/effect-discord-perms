/**
 * Helpers the catalogs share (DESIGN §5.9): the pairwise channel values, the grants and removals of a row, and
 * the order scenarios are listed in.
 */
import type { PermissionFlag } from "../../../src/errors/Missing.generated.ts"
import { Operations, type OpName, type OpSpec } from "../../../src/permissions/Operations.ts"
import type { GrantSource, Removal, Scenario, Setup } from "../Dsl.ts"

/** The setup fields a pairwise `channel` (or `thread`) value fixes. */
export type ChannelFields = Pick<Setup, "channel" | "threadState" | "subjectThreadMember">

/**
 * A pairwise channel value as setup fields. `archived-thread` and `locked-thread` are the provisioned public
 * thread in that state; `private-thread` puts the subject in it, because a private thread is visible only to
 * its members (H-033) and the families test the operation, not the visibility (targeted rows do that).
 */
export const channelFields = (value: string): ChannelFields => {
  switch (value) {
    case "archived-thread":
      return { channel: "public-thread", threadState: "archived" }
    case "locked-thread":
      return { channel: "public-thread", threadState: "locked" }
    case "private-thread":
      return { channel: "private-thread", subjectThreadMember: true }
    case "text":
    case "announcement":
    case "voice":
    case "stage":
    case "forum":
    case "forum-post":
    case "public-thread":
    case "announcement-thread":
      return { channel: value }
    default:
      throw new Error(`catalog: unknown channel ${value}`)
  }
}

/** A row's flags, in table order. */
export const rowFlags = (op: OpName): ReadonlyArray<PermissionFlag> => {
  const row: OpSpec = Operations[op]
  return row.flags
}

/** A pairwise removal value, checked. */
export const removalOf = (value: string): Removal => {
  switch (value) {
    case "absent":
    case "role-overwrite-deny":
    case "member-overwrite-deny":
    case "everyone-overwrite-deny":
      return value
    default:
      throw new Error(`catalog: unknown removal ${value}`)
  }
}

/** A pairwise member state value, checked. */
export const memberStateOf = (value: string): Setup["memberState"] => {
  if (value !== "normal" && value !== "timed-out") throw new Error(`catalog: unknown member state ${value}`)
  return value
}

/**
 * The grants and removals that hold `flags` except `taken`: with `removal: absent` the flag is simply not
 * granted; otherwise it is granted with the rest and taken away by that overwrite deny (§5.8: within one
 * overwrite a removal wins, and two roles' overwrites aggregate, H-006).
 */
export const grantsWithout = (
  flags: ReadonlyArray<PermissionFlag>,
  taken: PermissionFlag | undefined,
  removal: Removal,
  via: GrantSource = "role"
): Pick<Setup, "grants" | "removals"> => {
  const unique = [...new Set(flags)]
  if (taken === undefined || removal === "absent") {
    const granted = unique.filter((flag) => flag !== taken)
    return { grants: granted.length === 0 ? [] : [{ flags: granted, via }], removals: [] }
  }
  return { grants: [{ flags: unique, via }], removals: [{ flags: [taken], via: removal }] }
}

/** Scenarios sorted by ID (the catalogs' listing order; the runner groups them by setup). */
export const byId = (scenarios: ReadonlyArray<Scenario>): ReadonlyArray<Scenario> => [...scenarios].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
