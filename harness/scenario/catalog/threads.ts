/**
 * The thread catalogs (DESIGN §5.9): creating threads (the createThread family), acting on one (the threads
 * family), forum posts, and targeted rows for H-032..H-046.
 *
 * - **createThread**: a public or private thread in a text or announcement channel (private only in text,
 *   H-041), pairwise over the missing flag and the member state. Rows grant View and the creation flag through
 *   `lab-grant`; the missing one is not granted.
 * - **threads**: join, leave, add the target, archive, lock or delete, in a public, private or announcement
 *   thread or a forum post, created by the harness (the provisioned thread) or by the subject (the
 *   `subject-thread` fixture), with the subject a member or not. Rows grant the operation's flags (View, and
 *   SendMessagesInThreads and ManageThreads as the row has them); `op-flag` leaves the last out. Only a thread
 *   the subject created is deleted (§5.9).
 * - **posts**: forum posts with and without the channel's `REQUIRE_TAG` (H-031, H-044); the lab has no media
 *   channel (M2), so its row records `kind-not-available`.
 */
import type { PermissionFlag } from "../../../src/errors/Missing.generated.ts"
import type { OpName } from "../../../src/permissions/Operations.ts"
import { type Fixture, type Scenario, Setup } from "../Dsl.ts"
import { opOf } from "../Facts.ts"
import { type Combination, families, pairwise } from "../Pairwise.ts"
import { byId, grantsWithout, memberStateOf, rowFlags } from "./common.ts"

// ---- createThread ----------------------------------------------------------------------------------------

/** One createThread row as a scenario. */
export const createThreadRow = (row: Combination): Scenario => {
  const { parent = "", visibility = "", missing = "", memberState = "" } = row
  if (parent !== "text" && parent !== "announcement") throw new Error(`threads catalog: unknown parent ${parent}`)
  if (visibility !== "public" && visibility !== "private") throw new Error(`threads catalog: unknown visibility ${visibility}`)
  const operation = { _tag: "createThread", visibility, fromMessage: false } as const
  const op = opOf(operation, parent)
  const [, creation] = rowFlags(op)
  const taken = missing === "none" ? undefined : missing === "view" ? "ViewChannel" : creation
  return {
    id: `createThread/${parent}/${visibility}/${missing}/${memberState}`,
    hypotheses: visibility === "private" ? ["H-041", "H-080"] : ["H-040", "H-080"],
    setup: new Setup({ channel: parent, ...grantsWithout(rowFlags(op), taken, "absent"), memberState: memberStateOf(memberState), fixtures: [] }),
    operation
  }
}

// ---- threads -------------------------------------------------------------------------------------------

type Action = "join" | "leave" | "add-member" | "archive" | "lock" | "delete"

const channelOfThread = (value: string): Setup["channel"] => {
  switch (value) {
    case "public":
      return "public-thread"
    case "private":
      return "private-thread"
    case "announcement-thread":
    case "forum-post":
      return value
    default:
      throw new Error(`threads catalog: unknown thread ${value}`)
  }
}

const isAction = (value: string): value is Action =>
  value === "join" || value === "leave" || value === "add-member" || value === "archive" || value === "lock" || value === "delete"

/** The flag `op-flag` takes away: the row's last flag (SendMessagesInThreads to add a member, else ManageThreads). */
const opFlagOf = (op: OpName): PermissionFlag | undefined => rowFlags(op).at(-1)

const hypothesesOf = (action: Action, creator: string, thread: string): ReadonlyArray<`H-${number}`> => {
  const out = new Set<`H-${number}`>(["H-030", "H-080"])
  if (action === "add-member") out.add("H-046")
  if (action === "archive" || action === "lock" || action === "delete") out.add("H-045")
  if (creator === "subject") out.add("H-045")
  if (thread === "private") out.add("H-033")
  return [...out].sort()
}

/** One threads row as a scenario. */
export const threadRow = (row: Combination): Scenario => {
  const { thread = "", op: action = "", creator = "", missing = "", memberState = "", membership = "" } = row
  if (!isAction(action)) throw new Error(`threads catalog: unknown op ${action}`)
  const channel = channelOfThread(thread)
  const op = opOf({ _tag: "thread", action }, channel)
  const taken = missing === "none" ? undefined : missing === "view" ? "ViewChannel" : opFlagOf(op)
  const fixtures: ReadonlyArray<Fixture> = creator === "subject" ? ["subject-thread"] : []
  return {
    id: `thread/${thread}/${action}/${creator}/${missing}/${memberState}/${membership}`,
    hypotheses: hypothesesOf(action, creator, thread),
    setup: new Setup({
      channel,
      subjectThreadMember: membership === "member",
      ...grantsWithout(rowFlags(op), taken, "absent"),
      memberState: memberStateOf(memberState),
      fixtures
    }),
    operation: { _tag: "thread", action }
  }
}

// ---- targeted ------------------------------------------------------------------------------------------

type Setups = Omit<ConstructorParameters<typeof Setup>[0], "fixtures">

const threadTargeted = (name: string, hypotheses: ReadonlyArray<`H-${number}`>, action: Scenario["operation"], setup: Setups, fixtures: ReadonlyArray<Fixture> = []): Scenario => ({
  id: `${action._tag}/targeted/${name}`,
  hypotheses: [...hypotheses].sort(),
  setup: new Setup({ ...setup, fixtures }),
  operation: action
})

/** Hypotheses the pairwise dimensions cannot express. */
export const targetedRows: ReadonlyArray<Scenario> = [
  // H-032: a member of a thread still needs View on its parent
  threadTargeted("member-without-parent-view", ["H-032", "H-048"], { _tag: "thread", action: "leave" }, {
    channel: "public-thread",
    subjectThreadMember: true,
    grants: [{ flags: ["SendMessagesInThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-038: unarchiving needs SendMessages (channel docs) or membership (thread docs): a member without either
  // flag, and a non-member with SendMessages
  threadTargeted("unarchive-member-without-manage", ["H-038"], { _tag: "thread", action: "unarchive" }, {
    channel: "public-thread",
    threadState: "archived",
    subjectThreadMember: true,
    grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  threadTargeted("unarchive-non-member-with-send", ["H-038"], { _tag: "thread", action: "unarchive" }, {
    channel: "public-thread",
    threadState: "archived",
    subjectThreadMember: false,
    grants: [{ flags: ["ViewChannel", "SendMessages", "SendMessagesInThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  threadTargeted("unarchive-moderator", ["H-038", "H-045"], { _tag: "thread", action: "unarchive" }, {
    channel: "public-thread",
    threadState: "archived",
    grants: [{ flags: ["ViewChannel", "ManageThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-039: a locked, archived thread its creator tries to unarchive without ManageThreads
  threadTargeted(
    "unarchive-locked-creator",
    ["H-039"],
    { _tag: "thread", action: "unarchive" },
    {
      channel: "public-thread",
      threadState: "archived-locked",
      subjectThreadMember: true,
      grants: [{ flags: ["ViewChannel", "SendMessagesInThreads", "CreatePublicThreads"], via: "role" }],
      removals: [],
      memberState: "normal"
    },
    ["subject-thread"]
  ),
  // H-046: adding a member to an archived thread fails (50083)
  threadTargeted(
    "add-member-archived",
    ["H-037", "H-046"],
    { _tag: "thread", action: "add-member" },
    {
      channel: "public-thread",
      threadState: "archived",
      subjectThreadMember: true,
      grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }],
      removals: [],
      memberState: "normal"
    },
    ["subject-thread"]
  ),
  // H-046: archiving needs ManageThreads unless the subject created the thread; locking needs it always
  threadTargeted("archive-without-manage", ["H-045"], { _tag: "thread", action: "archive" }, {
    channel: "public-thread",
    subjectThreadMember: true,
    grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  threadTargeted(
    "archive-creator-without-manage",
    ["H-045"],
    { _tag: "thread", action: "archive" },
    { channel: "public-thread", subjectThreadMember: true, grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }], removals: [], memberState: "normal" },
    ["subject-thread"]
  ),
  threadTargeted("lock-without-manage", ["H-045"], { _tag: "thread", action: "lock" }, {
    channel: "public-thread",
    subjectThreadMember: true,
    grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-046: leaving an archived thread (joining one succeeds, M4 live)
  threadTargeted("leave-archived", ["H-037", "H-046"], { _tag: "thread", action: "leave" }, {
    channel: "public-thread",
    threadState: "archived",
    subjectThreadMember: true,
    grants: [{ flags: ["ViewChannel"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-037: joining an archived thread fails (50083)
  threadTargeted("join-archived", ["H-037", "H-046"], { _tag: "thread", action: "join" }, {
    channel: "public-thread",
    threadState: "archived",
    subjectThreadMember: false,
    grants: [{ flags: ["ViewChannel"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-040: a thread from a message needs CreatePublicThreads, with it and without it
  threadTargeted(
    "from-message",
    ["H-040", "H-043"],
    { _tag: "createThread", visibility: "public", fromMessage: true },
    { channel: "text", grants: [{ flags: ["ViewChannel", "CreatePublicThreads", "ReadMessageHistory"], via: "role" }], removals: [], memberState: "normal" },
    ["harness-message"]
  ),
  threadTargeted(
    "from-message-without-flag",
    ["H-040"],
    { _tag: "createThread", visibility: "public", fromMessage: true },
    { channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages", "ReadMessageHistory"], via: "role" }], removals: [], memberState: "normal" },
    ["harness-message"]
  ),
  // H-031: a forum post needs SendMessages (CREATE_PUBLIC_THREADS is ignored), not SendMessagesInThreads
  threadTargeted("forum", ["H-031"], { _tag: "createPost", tagged: false }, {
    channel: "forum",
    grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  threadTargeted("forum-with-threads-flags-only", ["H-031"], { _tag: "createPost", tagged: false }, {
    channel: "forum",
    grants: [{ flags: ["ViewChannel", "SendMessagesInThreads", "CreatePublicThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-044: a forum with REQUIRE_TAG refuses a post without a tag (40067) and takes one with a tag
  threadTargeted("forum-require-tag-untagged", ["H-044"], { _tag: "createPost", tagged: false }, {
    channel: "forum",
    channelSettings: { nameVariant: "a", slowmode: 0, requireTag: true },
    grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  threadTargeted("forum-require-tag-tagged", ["H-044"], { _tag: "createPost", tagged: true }, {
    channel: "forum",
    channelSettings: { nameVariant: "a", slowmode: 0, requireTag: true },
    grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // the lab has no media channel (400 50024 on create, M2): recorded as kind-not-available
  threadTargeted("media", ["H-031"], { _tag: "createPost", tagged: false }, {
    channel: "media",
    grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  })
]

/** The thread catalogs, sorted by ID. */
export const scenarios: ReadonlyArray<Scenario> = byId([...pairwise(families.createThread).map(createThreadRow), ...pairwise(families.threads).map(threadRow), ...targetedRows])
