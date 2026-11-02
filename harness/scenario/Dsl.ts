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
 * Objects created before the operation, by symbolic name. `harness-message` is a plain message the harness
 * posts (a reply's target): the harness can post in every lab channel, including voice text chat, where the
 * target cannot without Connect.
 */
export const Fixture = Schema.Literals([
  "subject-message",
  "target-message",
  "harness-message",
  "existing-reaction",
  "pinned-subject-message",
  "guild-sticker",
  "subject-thread",
  "crossposted-subject-message"
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

/** What a scenario does. M3 has the send family; later milestones add their operations here. */
export const Operation = Schema.Union([Schema.TaggedStruct("send", { payload: SendPayload })])
/** An operation. */
export type Operation = typeof Operation.Type

/** The operation as the truth table records it: `send:<payload>`. */
export const operationKey = (operation: Operation): string => {
  switch (operation._tag) {
    case "send":
      return `send:${operation.payload}`
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
}
