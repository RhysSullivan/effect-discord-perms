/**
 * The scenario DSL (DESIGN §5.8, `[sd:src/verify.ts]`). Everything is symbolic: lab names, flag names and
 * dimension values, never snowflakes, timestamps or messages, so a setup can be compared byte for byte and two
 * runs can write identical truth tables (G9).
 */
import { Schema } from "effect"
import { PermissionFlags } from "../../src/errors/Missing.generated.ts"

/** The lab channel a scenario acts in (the three thread kinds are the provisioned threads; §5.7). */
export const LabChannel = Schema.Literals([
  "text",
  "announcement",
  "voice",
  "stage",
  "forum",
  "media",
  "forum-post",
  "public-thread",
  "private-thread",
  "announcement-thread"
])
/** A lab channel. */
export type LabChannel = typeof LabChannel.Type

/** A thread's state for the scenario. */
export const ThreadState = Schema.Literals(["active", "archived", "locked", "archived-locked"])
/** A thread state. */
export type ThreadState = typeof ThreadState.Type

/** Where a granted flag comes from. */
export const GrantSource = Schema.Literals(["everyone", "role", "role-overwrite-allow", "member-overwrite-allow", "everyone-overwrite-allow", "administrator"])
/** A grant source. */
export type GrantSource = typeof GrantSource.Type

/** How a granted flag is taken away. `absent` means it is simply not granted. */
export const Removal = Schema.Literals(["absent", "role-overwrite-deny", "member-overwrite-deny", "everyone-overwrite-deny"])
/** A removal. */
export type Removal = typeof Removal.Type

/** A permission flag name. */
export const Flag = Schema.Literals(PermissionFlags)

/** A symbolic role's rank against the subject's highest role (H-060..H-073). */
export const Rank = Schema.Literals(["below", "equal", "above"])

/**
 * Objects created before the operation, by symbolic name:
 *
 * - `subject-message`: the subject's own plain message, posted by the subject before Converge applies the
 *   setup (with temporary access, `Fixtures.ts`), so even a setup that hides the channel has one;
 * - `harness-message` and `second-harness-message`: plain messages the harness posts (a reply's target, a
 *   foreign message, a bulk delete's pair); the harness can post in every lab channel, including voice text
 *   chat, where the target cannot without Connect;
 * - `existing-reaction`: the harness has reacted to `harness-message` with the scenario's emoji;
 * - `pinned-harness-message`: the harness has pinned `harness-message`;
 * - `guild-sticker`: the lab's sticker (send);
 * - `subject-thread`: the scenario thread is one the subject created (before Converge, with temporary access),
 *   instead of the provisioned one of that kind;
 * - `target-role`: the target holds the role of `roleRank` (a role removal's subject);
 * - `subject-prior-send`: the subject has just sent a plain message in the scenario channel, after Converge and
 *   with the setup's own permissions and slowmode, so a send that follows is its second in a row (H-053). Discord
 *   refusing it makes the setup `rejected-by-discord`.
 */
export const Fixture = Schema.Literals([
  "subject-message",
  "harness-message",
  "second-harness-message",
  "existing-reaction",
  "pinned-harness-message",
  "guild-sticker",
  "subject-thread",
  "target-role",
  "subject-prior-send"
])
/** A fixture. */
export type Fixture = typeof Fixture.Type

/** One grant: these flags, from this source. */
export const Grant = Schema.Struct({ flags: Schema.Array(Flag), via: GrantSource })
/** One removal: these flags, this way. */
export const RemovalSpec = Schema.Struct({ flags: Schema.Array(Flag), via: Removal })

/**
 * A scenario's symbolic setup. Both sides of a rule pair run on a byte-identical setup (§5.5); scenarios with
 * equal setups are grouped, so the lab converges once per group (§5.10).
 */
export class Setup extends Schema.Class<Setup>("Setup")({
  channel: LabChannel,
  threadState: Schema.optionalKey(ThreadState),
  /** Private-thread visibility depends on membership (H-033, H-047), so it is set, never inherited. */
  subjectThreadMember: Schema.optionalKey(Schema.Boolean),
  grants: Schema.Array(Grant),
  removals: Schema.Array(RemovalSpec),
  memberState: Schema.Literals(["normal", "timed-out"]),
  /** The target's rank against the subject (kick, ban, nickname, timeout). */
  targetRank: Schema.optionalKey(Rank),
  /** The rank of the role granted or removed against the subject (addRole, removeRole; H-060, H-061). */
  roleRank: Schema.optionalKey(Rank),
  targetAdmin: Schema.optionalKey(Schema.Boolean),
  /** Channel settings Converge sets (two lab names toggle instead of restoring, H-162). */
  channelSettings: Schema.optionalKey(Schema.Struct({ nameVariant: Schema.Literals(["a", "b"]), slowmode: Schema.Int, requireTag: Schema.Boolean })),
  fixtures: Schema.Array(Fixture)
}) {}

/** A send payload variant (the send family's payload dimension, §5.9). */
export const SendPayload = Schema.Literals(["plain", "embed", "file", "reply", "tts", "poll", "guild-sticker", "mention-everyone"])
/** A send payload variant. */
export type SendPayload = typeof SendPayload.Type

/** A message operation (the messages family, §5.9). */
export const MessageAction = Schema.Literals(["edit-own", "delete-own", "delete-foreign", "crosspost-own", "crosspost-foreign", "bulk-delete"])
/** A reaction's emoji: a unicode emoji nobody has used on the message, the same one already there, the lab's guild emoji. */
export const ReactEmoji = Schema.Literals(["unicode-new", "unicode-existing", "guild"])
/** A pins operation. */
export const PinAction = Schema.Literals(["pin", "unpin", "list"])
/** A thread operation (the threads family, plus `unarchive` for H-038/H-039). */
export const ThreadAction = Schema.Literals(["join", "leave", "add-member", "archive", "unarchive", "lock", "delete"])
/** A channel edit: slowmode (pairwise), or one name or topic edit per lab channel per run (H-162). */
export const EditField = Schema.Literals(["slowmode", "name", "topic"])
/** A member operation on the target (kick and ban only where the docs model predicts failure, §5.6). */
export const MemberAction = Schema.Literals(["add-role", "remove-role", "nickname", "timeout", "kick", "ban"])

/** What a scenario does. */
export const Operation = Schema.Union([
  Schema.TaggedStruct("send", { payload: SendPayload }),
  Schema.TaggedStruct("message", { action: MessageAction }),
  Schema.TaggedStruct("react", { emoji: ReactEmoji }),
  Schema.TaggedStruct("pins", { action: PinAction }),
  /** A new thread in the scenario channel, standalone or from `harness-message`. */
  Schema.TaggedStruct("createThread", { visibility: Schema.Literals(["public", "private"]), fromMessage: Schema.Boolean }),
  Schema.TaggedStruct("thread", { action: ThreadAction }),
  Schema.TaggedStruct("channelEdit", { field: EditField }),
  Schema.TaggedStruct("member", { action: MemberAction }),
  /** A forum or media post, with or without a tag (H-031, H-044). */
  Schema.TaggedStruct("createPost", { tagged: Schema.Boolean })
])
/** An operation. */
export type Operation = typeof Operation.Type

/** The operation as the truth table records it, for example `send:embed` or `thread:archive`. */
export const operationKey = (operation: Operation): string => {
  switch (operation._tag) {
    case "send":
      return `send:${operation.payload}`
    case "message":
      return `message:${operation.action}`
    case "react":
      return `react:${operation.emoji}`
    case "pins":
      return `pins:${operation.action}`
    case "createThread":
      return `createThread:${operation.visibility}${operation.fromMessage ? ":from-message" : ""}`
    case "thread":
      return `thread:${operation.action}`
    case "channelEdit":
      return `channelEdit:${operation.field}`
    case "member":
      return `member:${operation.action}`
    case "createPost":
      return `createPost:${operation.tagged ? "tagged" : "untagged"}`
  }
}

/**
 * What a rule side must produce, in full, so a rejection for the wrong reason does not count: status, code,
 * the sorted inner 50035 codes with their paths, field names, counts.
 */
export const Observation = Schema.Union([
  Schema.TaggedStruct("Rejected", {
    status: Schema.Int,
    code: Schema.Int,
    inner: Schema.Array(Schema.Struct({ path: Schema.String, code: Schema.String }))
  }),
  Schema.TaggedStruct("Ignored", { field: Schema.String }),
  Schema.TaggedStruct("Applied", { field: Schema.String }),
  Schema.TaggedStruct("Writes", { count: Schema.Int }),
  /** Only counts when the same session saw READY (with the expected user id) and a canary event after the trigger. */
  Schema.TaggedStruct("EventAbsent", { event: Schema.String, canary: Schema.String }),
  Schema.TaggedStruct("EventDelivered", { event: Schema.String }),
  Schema.TaggedStruct("Succeeded", {})
])

/** A full observation of one rule side (see {@link Observation}). */
export type Observation = typeof Observation.Type

/** One scenario. */
export interface Scenario {
  /** `<family>/<channel>/<dims...>`: stable and unique. */
  readonly id: string
  /** The hypotheses (discord-semantics H-ids) the row tests. */
  readonly hypotheses: ReadonlyArray<`H-${number}`>
  readonly setup: Setup
  readonly operation: Operation
  /** Rule rows only (M6); matrix rows have no expectation, agreement decides. */
  readonly expect?: Observation
  /** A flip control's original row (§5.9): this row is its setup with only the original's first missing flag granted. */
  readonly flipOf?: string
}
