/**
 * The reactions catalog (DESIGN §5.9): the subject reacts to the harness's message, pairwise over the channel,
 * the emoji (a unicode emoji nobody has used, the one the harness already reacted with, the lab's guild
 * emoji), the missing flag, how it is taken away and the member state, plus targeted rows.
 *
 * Every row grants the reaction row's flags (View, Connect in voice, AddReactions) and ReadMessageHistory through
 * `lab-grant`, then takes the missing one away; `read-history` rows show a reaction needs no ReadMessageHistory
 * (M4 live; H-144 said it did). The row `unicode-existing` with AddReactions missing tests the conditional rule:
 * an emoji someone already reacted with needs no AddReactions (H-144), so it should succeed.
 */
import type { PermissionFlag } from "../../../src/errors/Missing.generated.ts"
import { type Fixture, type Scenario, Setup } from "../Dsl.ts"
import { opOf } from "../Facts.ts"
import { type Combination, families, pairwise } from "../Pairwise.ts"
import { byId, channelFields, grantsWithout, memberStateOf, removalOf, rowFlags } from "./common.ts"

type Emoji = "unicode-new" | "unicode-existing" | "guild"

const isEmoji = (value: string): value is Emoji => value === "unicode-new" || value === "unicode-existing" || value === "guild"

/** The fixtures a reaction needs: the harness's message, and its own reaction for an existing emoji. */
export const fixturesOf = (emoji: Emoji): ReadonlyArray<Fixture> => (emoji === "unicode-existing" ? ["harness-message", "existing-reaction"] : ["harness-message"])

const missingFlag = (missing: string): PermissionFlag | undefined => {
  switch (missing) {
    case "none":
      return undefined
    case "view":
      return "ViewChannel"
    case "read-history":
      return "ReadMessageHistory"
    case "add-reactions":
      return "AddReactions"
    case "connect":
      return "Connect"
    default:
      throw new Error(`reactions catalog: unknown missing ${missing}`)
  }
}

/** One pairwise row as a scenario. */
export const fromCombination = (row: Combination): Scenario => {
  const { channel = "", emoji = "", missing = "", removal = "", memberState = "" } = row
  if (!isEmoji(emoji)) throw new Error(`reactions catalog: unknown emoji ${emoji}`)
  const fields = channelFields(channel)
  const op = opOf({ _tag: "react", emoji }, fields.channel)
  const hypotheses = new Set<`H-${number}`>(["H-144", "H-080"])
  if (memberState === "timed-out") hypotheses.add("H-024")
  if (channel === "archived-thread") hypotheses.add("H-037")
  if (missing === "connect" || channel === "voice") hypotheses.add("H-152")
  return {
    id: `react/${channel}/${emoji}/${missing}/${removal}/${memberState}`,
    hypotheses: [...hypotheses].sort(),
    setup: new Setup({ ...fields, ...grantsWithout([...rowFlags(op), "ReadMessageHistory"], missingFlag(missing), removalOf(removal)), memberState: memberStateOf(memberState), fixtures: fixturesOf(emoji) }),
    operation: { _tag: "react", emoji }
  }
}

const targeted = (name: string, hypotheses: ReadonlyArray<`H-${number}`>, emoji: Emoji, setup: Omit<ConstructorParameters<typeof Setup>[0], "fixtures">): Scenario => ({
  id: `react/targeted/${name}`,
  hypotheses: [...hypotheses].sort(),
  setup: new Setup({ ...setup, fixtures: fixturesOf(emoji) }),
  operation: { _tag: "react", emoji }
})

/** Hypotheses the pairwise dimensions cannot express. */
export const targetedRows: ReadonlyArray<Scenario> = [
  // H-030: a thread uses its parent's overwrites: a deny of AddReactions on the parent blocks a new reaction
  targeted("thread-parent-deny", ["H-030", "H-144"], "unicode-new", {
    channel: "public-thread",
    grants: [{ flags: ["ViewChannel", "ReadMessageHistory", "AddReactions"], via: "role" }],
    removals: [{ flags: ["AddReactions"], via: "everyone-overwrite-deny" }],
    memberState: "normal"
  }),
  // ordering with a dedicated code: View and an archived thread (§3.2, 50083)
  targeted("order-view-archived", ["H-037", "H-080"], "unicode-new", {
    channel: "public-thread",
    threadState: "archived",
    grants: [{ flags: ["ReadMessageHistory", "AddReactions"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // ordering (§3.2): ReadMessageHistory (access, for a reaction) and AddReactions (the action's own) both missing
  targeted("order-history-add", ["H-144"], "unicode-new", {
    channel: "text",
    grants: [{ flags: ["ViewChannel"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // ordering (§3.2): View and Connect both missing in voice text chat
  targeted("order-view-connect", ["H-012", "H-152"], "unicode-new", {
    channel: "voice",
    grants: [{ flags: ["ReadMessageHistory", "AddReactions"], via: "role" }],
    removals: [],
    memberState: "normal"
  })
]

/** The reactions catalog, sorted by ID. */
export const scenarios: ReadonlyArray<Scenario> = byId([...pairwise(families.react).map(fromCombination), ...targetedRows])
