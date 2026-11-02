/**
 * The members catalog (DESIGN §5.9): the subject assigns or removes a role, sets a nickname, times out, kicks or
 * bans the target, pairwise over the target's rank, the role's rank, the missing flag, whether the target holds
 * Administrator and the member state.
 *
 * Ranks (`LabIds.rankRoles`): the subject holds `lab-mid`; the target holds nothing more (below), `lab-mid`
 * (equal) or `lab-high` (above); the role assigned or removed is `lab-low`, `lab-mid` or `lab-high`. The
 * operation's flag comes from `lab-grant` (position 7, below `lab-mid`), or is missing. Kick and ban rows exist
 * only where the docs model predicts failure (`kickBanMustFail`: the flag missing, or the target not below);
 * Safety checks it offline and at run start, and the Lab guard again from harness-side reads just before the
 * call (§5.6). A successful kick or ban would need Rhys to re-invite the bot, so their flip controls are
 * `forbidden-action` and never run.
 */
import type { PermissionFlag } from "../../../src/errors/Missing.generated.ts"
import { type Fixture, type Scenario, Setup } from "../Dsl.ts"
import { opOf } from "../Facts.ts"
import { type Combination, families, pairwise } from "../Pairwise.ts"
import { byId, memberStateOf, rowFlags } from "./common.ts"

type Action = "add-role" | "remove-role" | "nickname" | "timeout" | "kick" | "ban"

const actionOf = (value: string): Action => {
  switch (value) {
    case "add-role":
    case "remove-role":
    case "nickname":
    case "timeout":
      return value
    case "kick-expect-fail":
      return "kick"
    case "ban-expect-fail":
      return "ban"
    default:
      throw new Error(`members catalog: unknown op ${value}`)
  }
}

const rankOf = (value: string): "below" | "equal" | "above" => {
  if (value !== "below" && value !== "equal" && value !== "above") throw new Error(`members catalog: unknown rank ${value}`)
  return value
}

const hypothesesOf = (action: Action): ReadonlyArray<`H-${number}`> => {
  switch (action) {
    case "add-role":
    case "remove-role":
      return ["H-060", "H-061", "H-068"]
    case "nickname":
      return ["H-064", "H-067"]
    case "timeout":
      return ["H-021", "H-028", "H-066", "H-067"]
    case "kick":
    case "ban":
      return ["H-064", "H-067"]
  }
}

/** One pairwise row as a scenario. */
export const fromCombination = (row: Combination): Scenario => {
  const { op: value = "", targetRank = "", roleRank = "", missing = "", targetAdmin = "", memberState = "" } = row
  const action = actionOf(value)
  const op = opOf({ _tag: "member", action }, "text")
  const flags: ReadonlyArray<PermissionFlag> = missing === "none" ? rowFlags(op) : []
  const fixtures: ReadonlyArray<Fixture> = action === "remove-role" ? ["target-role"] : []
  return {
    id: `member/${value}/${targetRank}/${roleRank === "n/a" ? "no-role" : roleRank}/${missing}/${targetAdmin === "yes" ? "target-admin" : "target-plain"}/${memberState}`,
    hypotheses: hypothesesOf(action),
    setup: new Setup({
      channel: "text",
      grants: flags.length === 0 ? [] : [{ flags, via: "role" }],
      removals: [],
      memberState: memberStateOf(memberState),
      targetRank: rankOf(targetRank),
      ...(roleRank === "n/a" ? {} : { roleRank: rankOf(roleRank) }),
      targetAdmin: targetAdmin === "yes",
      fixtures
    }),
    operation: { _tag: "member", action }
  }
}

/** The members catalog, sorted by ID. */
export const scenarios: ReadonlyArray<Scenario> = byId(pairwise(families.members).map(fromCombination))
