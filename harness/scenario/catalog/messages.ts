/**
 * The messages catalog (DESIGN §5.9): edit and delete of the subject's own message, delete of another's,
 * crosspost of either in an announcement channel, and bulk delete, pairwise over the channel, the missing
 * flag and the member state, plus targeted rows (H-037, H-147, voice text chat).
 *
 * Every row grants the operation's flags through `lab-grant`, and in voice text chat Connect too, so the row
 * tests the operation's own flags; whether an operation in voice needs Connect is a targeted row. The missing
 * flag is not granted (`removal: absent`): `view` takes ViewChannel, `op-flag` the operation's own flag
 * (ManageMessages, or SendMessages for crossposting one's own message, H-141).
 */
import type { PermissionFlag } from "../../../src/errors/Missing.generated.ts"
import type { OpName } from "../../../src/permissions/Operations.ts"
import { type Fixture, type Scenario, Setup } from "../Dsl.ts"
import { opOf } from "../Facts.ts"
import { type Combination, families, pairwise } from "../Pairwise.ts"
import { byId, channelFields, grantsWithout, memberStateOf, rowFlags } from "./common.ts"

type Action = "edit-own" | "delete-own" | "delete-foreign" | "crosspost-own" | "crosspost-foreign" | "bulk-delete"

const isAction = (value: string): value is Action =>
  value === "edit-own" || value === "delete-own" || value === "delete-foreign" || value === "crosspost-own" || value === "crosspost-foreign" || value === "bulk-delete"

/** The fixtures an action needs: the subject's own message, another's (the harness's), or two for a bulk delete. */
export const fixturesOf = (action: Action): ReadonlyArray<Fixture> => {
  switch (action) {
    case "edit-own":
    case "delete-own":
    case "crosspost-own":
      return ["subject-message"]
    case "delete-foreign":
    case "crosspost-foreign":
      return ["harness-message"]
    case "bulk-delete":
      return ["harness-message", "second-harness-message"]
  }
}

/** The operation's own flag, which `missing=op-flag` takes away (none for the subject's own edit and delete). */
const opFlagOf = (action: Action): PermissionFlag | undefined => {
  switch (action) {
    case "delete-foreign":
    case "crosspost-foreign":
    case "bulk-delete":
      return "ManageMessages"
    case "crosspost-own":
      return "SendMessages"
    case "edit-own":
    case "delete-own":
      return undefined
  }
}

/** The flags a message row grants: the operation's, and Connect in voice text chat. */
const baseFlags = (op: OpName, channel: Setup["channel"]): ReadonlyArray<PermissionFlag> =>
  channel === "voice" || channel === "stage" ? [...rowFlags(op), "Connect"] : rowFlags(op)

const hypothesesOf = (action: Action, missing: string): ReadonlyArray<`H-${number}`> => {
  const out = new Set<`H-${number}`>(["H-080"])
  if (action === "edit-own") out.add("H-143")
  if (action === "delete-own") out.add("H-147")
  if (action === "delete-foreign") out.add("H-089")
  if (action === "crosspost-own" || action === "crosspost-foreign") out.add("H-141")
  if (action === "bulk-delete") out.add("H-142")
  if (missing === "view") out.add("H-012")
  return [...out].sort()
}

/** One pairwise row as a scenario. */
export const fromCombination = (row: Combination): Scenario => {
  const { op: action = "", channel = "", missing = "", memberState = "" } = row
  if (!isAction(action)) throw new Error(`messages catalog: unknown op ${action}`)
  const fields = channelFields(channel)
  const op = opOf({ _tag: "message", action }, fields.channel)
  const taken = missing === "none" ? undefined : missing === "view" ? "ViewChannel" : opFlagOf(action)
  if (missing === "op-flag" && taken === undefined) throw new Error(`messages catalog: ${action} has no op flag`)
  return {
    id: `message/${channel}/${action}/${missing}/${memberState}`,
    hypotheses: hypothesesOf(action, missing),
    setup: new Setup({ ...fields, ...grantsWithout(baseFlags(op, fields.channel), taken, "absent"), memberState: memberStateOf(memberState), fixtures: fixturesOf(action) }),
    operation: { _tag: "message", action }
  }
}

const targeted = (name: string, hypotheses: ReadonlyArray<`H-${number}`>, action: Action, setup: Omit<ConstructorParameters<typeof Setup>[0], "fixtures">): Scenario => ({
  id: `message/targeted/${name}`,
  hypotheses: [...hypotheses].sort(),
  setup: new Setup({ ...setup, fixtures: fixturesOf(action) }),
  operation: { _tag: "message", action }
})

/** Hypotheses the pairwise dimensions cannot express. */
export const targetedRows: ReadonlyArray<Scenario> = [
  // H-037: in an archived thread, editing fails (50083) and deleting succeeds
  targeted("edit-own-archived-thread", ["H-037"], "edit-own", {
    channel: "public-thread",
    threadState: "archived",
    grants: [{ flags: ["ViewChannel"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  targeted("delete-own-archived-thread", ["H-037"], "delete-own", {
    channel: "public-thread",
    threadState: "archived",
    grants: [{ flags: ["ViewChannel"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-036: in a locked thread, a member without ManageThreads cannot edit its own message
  targeted("edit-own-locked-thread", ["H-036"], "edit-own", {
    channel: "public-thread",
    threadState: "locked",
    subjectThreadMember: true,
    grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // voice text chat: does editing or deleting one's own message need Connect, as sending does (H-152)?
  targeted("voice-edit-own-without-connect", ["H-152"], "edit-own", {
    channel: "voice",
    grants: [{ flags: ["ViewChannel"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  targeted("voice-delete-foreign-without-connect", ["H-089", "H-152"], "delete-foreign", {
    channel: "voice",
    grants: [{ flags: ["ViewChannel", "ManageMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  targeted("voice-delete-own-without-connect", ["H-147", "H-152"], "delete-own", {
    channel: "voice",
    grants: [{ flags: ["ViewChannel"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  targeted("voice-bulk-delete-without-connect", ["H-142", "H-152"], "bulk-delete", {
    channel: "voice",
    grants: [{ flags: ["ViewChannel", "ManageMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-037: an archived thread refuses deleting one's own message (M4 live, 50083); others' messages, and a bulk delete?
  targeted("delete-foreign-archived-thread", ["H-037"], "delete-foreign", {
    channel: "public-thread",
    threadState: "archived",
    grants: [{ flags: ["ViewChannel", "ManageMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  targeted("bulk-delete-archived-thread", ["H-037", "H-142"], "bulk-delete", {
    channel: "public-thread",
    threadState: "archived",
    grants: [{ flags: ["ViewChannel", "ManageMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // ordering (§3.2): SendMessages (access) and ManageMessages (the action's own flag) both missing
  targeted("order-send-manage-crosspost", ["H-141"], "crosspost-foreign", {
    channel: "announcement",
    grants: [{ flags: ["ViewChannel"], via: "role" }],
    removals: [],
    memberState: "normal"
  })
]

/** The messages catalog, sorted by ID. */
export const scenarios: ReadonlyArray<Scenario> = byId([...pairwise(families.messages).map(fromCombination), ...targetedRows])
