/**
 * The pins catalog (DESIGN §5.9): the subject pins the harness's message, unpins it after the harness pinned
 * it, or lists the pins, pairwise over the channel, the operation, the missing flag, how it is taken away and
 * the member state, plus targeted rows (H-050).
 *
 * Every row grants View, PinMessages and ReadMessageHistory through `lab-grant`, then
 * takes the missing one away, so each operation also runs without the flag it should not need: listing without
 * PinMessages, pinning without ReadMessageHistory. Listing without ReadMessageHistory answers an empty list
 * (H-107), which the row records as degraded.
 *
 * Voice and stage channels are not in the channel dimension: their text chat has no pins. The harness, an
 * Administrator, could not pin its own message in `lab-stage`'s chat (400 50019, M2) nor in `lab-voice`'s, and
 * the subject with every flag got the same answer (M4 live), so no voice row could pin, or set up a pin to
 * unpin or list. Listing in voice is a targeted row.
 */
import type { PermissionFlag } from "../../../src/errors/Missing.generated.ts"
import { type Fixture, type Scenario, Setup } from "../Dsl.ts"
import { type Combination, families, pairwise } from "../Pairwise.ts"
import { byId, channelFields, grantsWithout, memberStateOf, removalOf } from "./common.ts"

type Action = "pin" | "unpin" | "list"

const isAction = (value: string): value is Action => value === "pin" || value === "unpin" || value === "list"

/** The fixtures a pins operation needs: the harness's message, pinned by the harness for unpin and list. */
export const fixturesOf = (action: Action): ReadonlyArray<Fixture> => (action === "pin" ? ["harness-message"] : ["harness-message", "pinned-harness-message"])

const missingFlag = (missing: string): PermissionFlag | undefined => {
  switch (missing) {
    case "none":
      return undefined
    case "view":
      return "ViewChannel"
    case "pin-messages":
      return "PinMessages"
    case "read-history":
      return "ReadMessageHistory"
    default:
      throw new Error(`pins catalog: unknown missing ${missing}`)
  }
}

/** The flags every pins row grants before the missing one is taken away. */
const baseFlags: ReadonlyArray<PermissionFlag> = ["ViewChannel", "PinMessages", "ReadMessageHistory"]

/** One pairwise row as a scenario. */
export const fromCombination = (row: Combination): Scenario => {
  const { channel = "", op = "", missing = "", removal = "", memberState = "" } = row
  if (!isAction(op)) throw new Error(`pins catalog: unknown op ${op}`)
  const fields = channelFields(channel)
  const hypotheses = new Set<`H-${number}`>(["H-050", "H-080"])
  if (op === "list") hypotheses.add("H-107")
  if (channel === "archived-thread") hypotheses.add("H-037")
  return {
    id: `pins/${channel}/${op}/${missing}/${removal}/${memberState}`,
    hypotheses: [...hypotheses].sort(),
    setup: new Setup({ ...fields, ...grantsWithout(baseFlags, missingFlag(missing), removalOf(removal)), memberState: memberStateOf(memberState), fixtures: fixturesOf(op) }),
    operation: { _tag: "pins", action: op }
  }
}

/** Hypotheses the pairwise dimensions cannot express. */
export const targetedRows: ReadonlyArray<Scenario> = [
  // H-050: ManageMessages alone no longer lets a member pin (PinMessages split from it, 2026-02-10)
  {
    id: "pins/targeted/manage-messages-without-pin",
    hypotheses: ["H-050"],
    setup: new Setup({ channel: "text", grants: [{ flags: ["ViewChannel", "ManageMessages", "ReadMessageHistory"], via: "role" }], removals: [], memberState: "normal", fixtures: fixturesOf("pin") }),
    operation: { _tag: "pins", action: "pin" }
  }
]

/** Hypotheses the pairwise dimensions cannot express, unpinning. */
const unpinRows: ReadonlyArray<Scenario> = [
  // pinning needs ReadMessageHistory (M4 live, 50001); does unpinning?
  {
    id: "pins/targeted/unpin-without-history",
    hypotheses: ["H-050"],
    setup: new Setup({ channel: "text", grants: [{ flags: ["ViewChannel", "PinMessages"], via: "role" }], removals: [], memberState: "normal", fixtures: fixturesOf("unpin") }),
    operation: { _tag: "pins", action: "unpin" }
  }
]

/**
 * Voice text chat has no pins (400 50019 for the harness too, M2 and M4 live), so listing is its only pins
 * operation, and with nothing pinned it has no degradation to show.
 */
const voiceRows: ReadonlyArray<Scenario> = [
  {
    id: "pins/targeted/voice-list",
    hypotheses: ["H-159"],
    setup: new Setup({ channel: "voice", grants: [{ flags: ["ViewChannel", "Connect", "ReadMessageHistory"], via: "role" }], removals: [], memberState: "normal", fixtures: [] }),
    operation: { _tag: "pins", action: "list" }
  },
  {
    id: "pins/targeted/voice-list-without-connect",
    hypotheses: ["H-152", "H-159"],
    setup: new Setup({ channel: "voice", grants: [{ flags: ["ViewChannel", "ReadMessageHistory"], via: "role" }], removals: [], memberState: "normal", fixtures: [] }),
    operation: { _tag: "pins", action: "list" }
  }
]

/** The pins catalog, sorted by ID. */
export const scenarios: ReadonlyArray<Scenario> = byId([...pairwise(families.pins).map(fromCombination), ...targetedRows, ...unpinRows, ...voiceRows])
