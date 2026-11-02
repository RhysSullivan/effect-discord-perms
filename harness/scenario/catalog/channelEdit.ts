/**
 * The channel-edit catalog (DESIGN §5.9): slowmode edits, pairwise over the channel, the missing flag, how it
 * is taken away and the member state, and targeted rename and topic rows, at most one per lab channel per run
 * (H-162: about two name or topic edits per channel per ten minutes; the closing reset renames back).
 *
 * Every row grants the edit row's flags (View, Connect in voice and stage, ManageChannels, or ManageThreads for
 * a thread) through `lab-grant`, then takes the missing one away. Cleanup puts the slowmode back.
 */
import type { PermissionFlag } from "../../../src/errors/Missing.generated.ts"
import type { OpName } from "../../../src/permissions/Operations.ts"
import { type Scenario, Setup } from "../Dsl.ts"
import { opOf } from "../Facts.ts"
import { type Combination, families, pairwise } from "../Pairwise.ts"
import { byId, channelFields, grantsWithout, memberStateOf, removalOf, rowFlags } from "./common.ts"

/** The flag `missing=manage` takes away: ManageChannels, or ManageThreads on a thread. */
const manageFlagOf = (op: OpName): PermissionFlag => (op === "thread.edit" ? "ManageThreads" : "ManageChannels")

const missingFlag = (missing: string, op: OpName): PermissionFlag | undefined => {
  switch (missing) {
    case "none":
      return undefined
    case "view":
      return "ViewChannel"
    case "manage":
      return manageFlagOf(op)
    case "connect":
      return "Connect"
    default:
      throw new Error(`channelEdit catalog: unknown missing ${missing}`)
  }
}

/** One pairwise row as a scenario (a slowmode edit). */
export const fromCombination = (row: Combination): Scenario => {
  const { channel = "", missing = "", removal = "", memberState = "" } = row
  const fields = channelFields(channel)
  const operation = { _tag: "channelEdit", field: "slowmode" } as const
  const op = opOf(operation, fields.channel)
  const hypotheses = new Set<`H-${number}`>(["H-054", "H-080"])
  if (missing === "connect") hypotheses.add("H-015")
  if (op === "thread.edit") hypotheses.add("H-045")
  return {
    id: `channelEdit/${channel}/${missing}/${removal}/${memberState}`,
    hypotheses: [...hypotheses].sort(),
    setup: new Setup({ ...fields, ...grantsWithout(rowFlags(op), missingFlag(missing, op), removalOf(removal)), memberState: memberStateOf(memberState), fixtures: [] }),
    operation
  }
}

const targeted = (name: string, hypotheses: ReadonlyArray<`H-${number}`>, field: "name" | "topic", setup: Omit<ConstructorParameters<typeof Setup>[0], "fixtures">): Scenario => ({
  id: `channelEdit/targeted/${name}`,
  hypotheses: [...hypotheses].sort(),
  setup: new Setup({ ...setup, fixtures: [] }),
  operation: { _tag: "channelEdit", field }
})

/** One name or topic edit per lab channel per run (Safety checks it). */
export const targetedRows: ReadonlyArray<Scenario> = [
  targeted("rename-text", ["H-162"], "name", { channel: "text", grants: [{ flags: ["ViewChannel", "ManageChannels"], via: "role" }], removals: [], memberState: "normal" }),
  targeted("topic-announcement", ["H-054", "H-162"], "topic", {
    channel: "announcement",
    grants: [{ flags: ["ViewChannel", "ManageChannels"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  targeted("topic-forum", ["H-162"], "topic", { channel: "forum", grants: [{ flags: ["ViewChannel", "ManageChannels"], via: "role" }], removals: [], memberState: "normal" }),
  // H-015: without Connect the implicit rule masks ManageChannels in voice: the rename must fail (and so does not count)
  targeted("rename-voice-without-connect", ["H-015", "H-162"], "name", {
    channel: "voice",
    grants: [{ flags: ["ViewChannel", "ManageChannels"], via: "role" }],
    removals: [],
    memberState: "normal"
  })
]

/** The channel-edit catalog, sorted by ID. */
export const scenarios: ReadonlyArray<Scenario> = byId([...pairwise(families.channelEdit).map(fromCombination), ...targetedRows])
