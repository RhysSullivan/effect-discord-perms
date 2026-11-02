/**
 * "Most fundamental first" (DESIGN §3.2, D7 generalised). When preflight or the recompute finds several
 * problems, they are sorted into this order, and the operation fails with the first:
 *
 * 1. ViewChannel, then Connect in voice and stage rows (H-015, H-152), then the row's `viewLevel` flags
 *    (ReadMessageHistory for a pin or a crosspost, M4 live);
 * 2. CommunicationDisabled (the timeout mask, H-020);
 * 3. the action's access flags: SendMessages or SendMessagesInThreads, or ReadMessageHistory for a reaction;
 * 4. the action's own flags, in the row's order;
 * 5. hierarchy (TargetAboveInHierarchy, RoleAboveInHierarchy, TargetIsAdministrator), then other state
 *    (ThreadLocked, ThreadArchived, RoleIsManaged, TagRequired);
 * 6. payload flags, in `payloadRuleNames` order (ReadMessageHistory for a reply, EmbedLinks, AttachFiles,
 *    SendTTSMessages, SendPolls, UseExternalStickers, ...).
 *
 * Local limits rank last (7); they are checked by the payload modules, not here. The order is never loosened
 * row by row: a dedicated Discord code that disagrees goes through the recompute (§3.2, §4.9).
 */
import type { PermissionFlag } from "../errors/Missing.generated.ts"
import { payloadRuleNames, PayloadRules } from "../payload/PayloadRules.ts"
import { type OpName, Operations, type OpSpec } from "./Operations.ts"

/** One problem preflight or the recompute found. */
export type Failure =
  /** A required flag the bot lacks. */
  | { readonly _tag: "MissingFlag"; readonly flag: PermissionFlag }
  /** The timeout mask removed a required flag; `until` is Discord's `communication_disabled_until`. */
  | { readonly _tag: "CommunicationDisabled"; readonly until: string }
  | { readonly _tag: "TargetAboveInHierarchy" }
  | { readonly _tag: "RoleAboveInHierarchy" }
  | { readonly _tag: "TargetIsAdministrator" }
  | { readonly _tag: "ThreadLocked" }
  | { readonly _tag: "ThreadArchived" }
  | { readonly _tag: "RoleIsManaged" }
  /** A forum or media post without a tag where the channel requires one (H-044). */
  | { readonly _tag: "TagRequired" }

/** Tier 5's order. */
const stateOrder: ReadonlyArray<Failure["_tag"]> = ["TargetAboveInHierarchy", "RoleAboveInHierarchy", "TargetIsAdministrator", "ThreadLocked", "ThreadArchived", "RoleIsManaged", "TagRequired"]

const payloadIndex = (flag: PermissionFlag): number => payloadRuleNames.findIndex((name) => PayloadRules[name].flag === flag)

/** A failure's place: tier (1-6, as in the module comment), then the position within the tier. */
export const rank = (op: OpName, failure: Failure): readonly [tier: number, position: number] => {
  const row: OpSpec = Operations[op]
  switch (failure._tag) {
    case "MissingFlag": {
      const flag = failure.flag
      const inRow = row.flags.includes(flag)
      if (flag === "ViewChannel") return [1, 0]
      if (flag === "Connect" && inRow) return [1, 1]
      if (inRow && (row.viewLevel ?? []).includes(flag)) return [1, 2]
      if ((flag === "SendMessages" || flag === "SendMessagesInThreads") && inRow) return [3, 0]
      if (flag === "ReadMessageHistory" && inRow && row.variant === "reaction") return [3, 1]
      if (inRow) return [4, row.flags.indexOf(flag)]
      const index = payloadIndex(flag)
      return index >= 0 ? [6, index] : [6, payloadRuleNames.length]
    }
    case "CommunicationDisabled":
      return [2, 0]
    case "TargetAboveInHierarchy":
    case "RoleAboveInHierarchy":
    case "TargetIsAdministrator":
    case "ThreadLocked":
    case "ThreadArchived":
    case "RoleIsManaged":
    case "TagRequired":
      return [5, stateOrder.indexOf(failure._tag)]
  }
}

const nameOf = (failure: Failure): string => (failure._tag === "MissingFlag" ? failure.flag : failure._tag)

/** `failures` in §3.2 order (ties, which only unknown payload flags can produce, break on the name). */
export const sortFailures = (op: OpName, failures: ReadonlyArray<Failure>): ReadonlyArray<Failure> =>
  [...failures].sort((a, b) => {
    const [ta, pa] = rank(op, a)
    const [tb, pb] = rank(op, b)
    return ta - tb || pa - pb || (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0)
  })
