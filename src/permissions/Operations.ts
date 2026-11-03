/**
 * THE operation table (DESIGN §2.4, §4.7). One `const` row per operation holds:
 *
 * - `flags`: the permissions the operation requires, in the §3.2 order within the operation (payload-derived
 *   flags are added by `PayloadRules`, §2.3). Preflight and the recompute read them at run time;
 * - `variant`: which class a missing flag becomes for this operation (D5);
 * - `tags`: the non-permission errors the operation can fail with, besides `Transient`.
 *
 * The public signatures index this same table through mapped-type lookups (`OpErrors<G>[Op]`), so the declared
 * unions cannot drift from the runtime data, and the lookups resolve to plain unions of classes, so hovers print
 * class names. Each row is a hypothesis that the live matrix confirms; a finding changes the row and adds a
 * `LOG.md` line citing its H-id.
 */
import type { ErrorCause } from "../errors/Cause.ts"
import { missing, type PermissionErrors, type PermissionFlag } from "../errors/Missing.generated.ts"
import type { MessagesTooOld, TooManyMessagesToDelete } from "../errors/Payload.ts"
import type { PermissionDeniedUnattributed, PermissionRevokedSinceCheck } from "../errors/Permission.ts"
import type {
  AlreadyCrossposted,
  CannotMessageUser,
  MaximumActiveThreads,
  MaximumPinsReached,
  MaximumReactionsReached,
  RoleAboveInHierarchy,
  RoleIsManaged,
  TagRequired,
  TargetAboveInHierarchy,
  TargetIsAdministrator,
  ThreadAlreadyExists,
  ThreadArchived,
  ThreadLocked,
  TwoFactorRequired,
  UnknownChannel,
  UnknownEmoji,
  UnknownMember,
  UnknownMessage,
  UnknownRole
} from "../errors/State.ts"
import type { RateLimited, Transient } from "../errors/Transient.ts"
import { MissingReadMessageHistoryForReaction, MissingReadMessageHistoryForReply } from "../errors/Variants.ts"
import type { MaybeSlowmode, MaybeTimedOut } from "./Observed.ts"

export type { Transient } from "../errors/Transient.ts"

/**
 * Tag name to class, for the tags a row may list. Observed-gated tags map to the gated type, so they leave every
 * union while the live matrix says Discord does not produce them (§8).
 */
export interface TagClasses {
  readonly PermissionDeniedUnattributed: PermissionDeniedUnattributed
  readonly CommunicationDisabled: MaybeTimedOut
  readonly SlowmodeActive: MaybeSlowmode
  readonly ThreadLocked: ThreadLocked
  readonly ThreadArchived: ThreadArchived
  readonly TargetAboveInHierarchy: TargetAboveInHierarchy
  readonly RoleAboveInHierarchy: RoleAboveInHierarchy
  readonly TargetIsAdministrator: TargetIsAdministrator
  readonly RoleIsManaged: RoleIsManaged
  readonly TwoFactorRequired: TwoFactorRequired
  readonly AlreadyCrossposted: AlreadyCrossposted
  readonly ThreadAlreadyExists: ThreadAlreadyExists
  readonly TagRequired: TagRequired
  readonly MaximumPinsReached: MaximumPinsReached
  readonly MaximumReactionsReached: MaximumReactionsReached
  readonly MaximumActiveThreads: MaximumActiveThreads
  readonly CannotMessageUser: CannotMessageUser
  readonly MessagesTooOld: MessagesTooOld
  readonly TooManyMessagesToDelete: TooManyMessagesToDelete
  readonly UnknownChannel: UnknownChannel
  readonly UnknownMessage: UnknownMessage
  readonly UnknownMember: UnknownMember
  readonly UnknownRole: UnknownRole
  readonly UnknownEmoji: UnknownEmoji
  readonly RateLimited: RateLimited
}
/** A tag a row may list. */
export type TagName = keyof TagClasses

/** Which class each missing flag becomes, per variant (D5). Only ReadMessageHistory differs today. */
export interface VariantErrors {
  readonly default: PermissionErrors
  readonly reply: Omit<PermissionErrors, "ReadMessageHistory"> & { readonly ReadMessageHistory: MissingReadMessageHistoryForReply }
  readonly reaction: Omit<PermissionErrors, "ReadMessageHistory"> & { readonly ReadMessageHistory: MissingReadMessageHistoryForReaction }
}
/** A D5 variant: `reply` for operations whose payload may reply, `reaction` for reactions, `default` otherwise. */
export type Variant = keyof VariantErrors

/** The shape every row satisfies. */
export interface OpSpec {
  readonly flags: ReadonlyArray<PermissionFlag>
  readonly variant: Variant
  readonly tags: ReadonlyArray<TagName>
  /**
   * Flags whose absence makes a read return less instead of failing: the pins list is empty without
   * ReadMessageHistory (H-107), which the operation reports as `degraded`, never as an error.
   */
  readonly degrades?: ReadonlyArray<PermissionFlag>
  /**
   * The timeout blocks the operation itself, although every flag it requires survives the timeout mask (an own
   * message's edit, §4.7 "State checks": timeout; a reaction with an emoji already on the message, which needs
   * no AddReactions, M4 live, H-024). Other rows fail under a timeout only through their flags.
   */
  readonly blockedByTimeout?: true
  /**
   * Flags of the row that Discord checks as access to the target, before anything else, like View (§3.2 tier 1;
   * M4 live): ReadMessageHistory for pinning, unpinning and crossposting a message, whose absence answers 50001
   * even under a timeout.
   */
  readonly viewLevel?: ReadonlyArray<PermissionFlag>
}

/** Every operation that can return 50013 or 50001 lists it: the recompute may find nothing (§4.9). */
const unattributed = ["PermissionDeniedUnattributed"] as const

/**
 * The rows (hypotheses; the matrix confirms each cell). Voice and stage channels use the `voice.*` rows, which
 * add Connect (H-015, H-152, H-153, H-159). `CommunicationDisabled` is in every row whose flags the timeout mask
 * removes (everything except ViewChannel and ReadMessageHistory, H-020), and in the rows with a timeout state
 * check (own edits, `require`). `TwoFactorRequired` is in every row with a 2FA-starred flag (H-072).
 */
export const Operations = {
  "channel.send": {
    flags: ["ViewChannel", "SendMessages"],
    variant: "reply",
    tags: [...unattributed, "CommunicationDisabled", "SlowmodeActive", "RateLimited", "UnknownChannel"]
  },
  "thread.send": {
    flags: ["ViewChannel", "SendMessagesInThreads"],
    variant: "reply",
    tags: [...unattributed, "CommunicationDisabled", "SlowmodeActive", "RateLimited", "ThreadLocked", "UnknownChannel"]
  },
  "voice.send": {
    flags: ["ViewChannel", "Connect", "SendMessages"],
    variant: "reply",
    tags: [...unattributed, "CommunicationDisabled", "SlowmodeActive", "RateLimited", "UnknownChannel"]
  },
  "dm.send": { flags: [], variant: "default", tags: ["CannotMessageUser", "RateLimited", "UnknownChannel"] },
  "forum.createPost": {
    flags: ["ViewChannel", "SendMessages"],
    variant: "reply",
    tags: [...unattributed, "CommunicationDisabled", "TagRequired", "MaximumActiveThreads", "RateLimited", "UnknownChannel"]
  },
  "channel.edit": {
    flags: ["ViewChannel", "ManageChannels"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "UnknownChannel"]
  },
  "thread.edit": {
    flags: ["ViewChannel", "SendMessagesInThreads", "ManageThreads"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "ThreadLocked", "UnknownChannel"]
  },
  "voice.edit": {
    flags: ["ViewChannel", "Connect", "ManageChannels"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "UnknownChannel"]
  },
  "channel.createThread.public": {
    flags: ["ViewChannel", "CreatePublicThreads"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "MaximumActiveThreads", "UnknownChannel"]
  },
  "channel.createThread.private": {
    flags: ["ViewChannel", "CreatePrivateThreads"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "MaximumActiveThreads", "UnknownChannel"]
  },
  "channel.pins": { flags: ["ViewChannel"], variant: "default", tags: [...unattributed, "UnknownChannel"], degrades: ["ReadMessageHistory"] },
  "voice.pins": {
    flags: ["ViewChannel", "Connect"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "UnknownChannel"],
    degrades: ["ReadMessageHistory"]
  },
  "channel.bulkDelete": {
    flags: ["ViewChannel", "ManageMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "MessagesTooOld", "TooManyMessagesToDelete", "UnknownChannel"]
  },
  "thread.bulkDelete": {
    flags: ["ViewChannel", "ManageMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "MessagesTooOld", "ThreadArchived", "TooManyMessagesToDelete", "UnknownChannel"]
  },
  "voice.bulkDelete": {
    flags: ["ViewChannel", "Connect", "ManageMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "MessagesTooOld", "TooManyMessagesToDelete", "UnknownChannel"]
  },
  "thread.join": { flags: ["ViewChannel"], variant: "default", tags: [...unattributed, "UnknownChannel"] },
  "thread.leave": { flags: [], variant: "default", tags: [...unattributed, "UnknownChannel"] },
  "thread.addMember": {
    flags: ["ViewChannel", "SendMessagesInThreads"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "UnknownChannel", "UnknownMember"]
  },
  "thread.setArchived": {
    flags: ["ViewChannel", "SendMessagesInThreads", "ManageThreads"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "ThreadLocked", "UnknownChannel"]
  },
  "thread.unarchive": {
    flags: ["ViewChannel", "SendMessagesInThreads"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "ThreadLocked", "UnknownChannel"]
  },
  "thread.setLocked": {
    flags: ["ViewChannel", "SendMessagesInThreads", "ManageThreads"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "UnknownChannel"]
  },
  "thread.delete": {
    flags: ["ViewChannel", "ManageThreads"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "UnknownChannel"]
  },
  "message.edit.channel": {
    flags: ["ViewChannel"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "RateLimited", "UnknownChannel", "UnknownMessage"],
    blockedByTimeout: true
  },
  "message.edit.thread": {
    flags: ["ViewChannel"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "RateLimited", "ThreadArchived", "UnknownChannel", "UnknownMessage"],
    blockedByTimeout: true
  },
  "message.edit.voice": {
    flags: ["ViewChannel", "Connect"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "RateLimited", "UnknownChannel", "UnknownMessage"],
    blockedByTimeout: true
  },
  "message.deleteOwn": { flags: ["ViewChannel"], variant: "default", tags: [...unattributed, "UnknownChannel", "UnknownMessage"] },
  "message.deleteOwn.thread": { flags: ["ViewChannel"], variant: "default", tags: [...unattributed, "ThreadArchived", "UnknownChannel", "UnknownMessage"] },
  "message.deleteOwn.voice": { flags: ["ViewChannel", "Connect"], variant: "default", tags: [...unattributed, "CommunicationDisabled", "UnknownChannel", "UnknownMessage"] },
  "message.deleteForeign": {
    flags: ["ViewChannel", "ManageMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "UnknownChannel", "UnknownMessage"]
  },
  "message.deleteForeign.thread": {
    flags: ["ViewChannel", "ManageMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "ThreadArchived", "UnknownChannel", "UnknownMessage"]
  },
  "message.deleteForeign.voice": {
    flags: ["ViewChannel", "Connect", "ManageMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "UnknownChannel", "UnknownMessage"]
  },
  "message.react.channel": {
    flags: ["ViewChannel", "AddReactions"],
    variant: "reaction",
    tags: [...unattributed, "CommunicationDisabled", "MaximumReactionsReached", "UnknownChannel", "UnknownEmoji", "UnknownMessage"],
    blockedByTimeout: true
  },
  "message.react.thread": {
    flags: ["ViewChannel", "AddReactions"],
    variant: "reaction",
    tags: [...unattributed, "CommunicationDisabled", "MaximumReactionsReached", "ThreadArchived", "UnknownChannel", "UnknownEmoji", "UnknownMessage"],
    blockedByTimeout: true
  },
  "message.react.voice": {
    flags: ["ViewChannel", "Connect", "AddReactions"],
    variant: "reaction",
    tags: [...unattributed, "CommunicationDisabled", "MaximumReactionsReached", "UnknownChannel", "UnknownEmoji", "UnknownMessage"],
    blockedByTimeout: true
  },
  "message.pin.channel": {
    flags: ["ViewChannel", "ReadMessageHistory", "PinMessages"],
    viewLevel: ["ReadMessageHistory"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "MaximumPinsReached", "UnknownChannel", "UnknownMessage"]
  },
  "message.pin.thread": {
    flags: ["ViewChannel", "ReadMessageHistory", "PinMessages"],
    viewLevel: ["ReadMessageHistory"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "MaximumPinsReached", "ThreadArchived", "UnknownChannel", "UnknownMessage"]
  },
  "message.unpin.channel": {
    flags: ["ViewChannel", "ReadMessageHistory", "PinMessages"],
    viewLevel: ["ReadMessageHistory"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "UnknownChannel", "UnknownMessage"]
  },
  "message.unpin.thread": {
    flags: ["ViewChannel", "ReadMessageHistory", "PinMessages"],
    viewLevel: ["ReadMessageHistory"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "ThreadArchived", "UnknownChannel", "UnknownMessage"]
  },
  "message.crosspostOwn": {
    flags: ["ViewChannel", "ReadMessageHistory", "SendMessages"],
    viewLevel: ["ReadMessageHistory"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "AlreadyCrossposted", "RateLimited", "UnknownChannel", "UnknownMessage"]
  },
  "message.crosspostForeign": {
    flags: ["ViewChannel", "ReadMessageHistory", "SendMessages", "ManageMessages"],
    viewLevel: ["ReadMessageHistory"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "AlreadyCrossposted", "RateLimited", "UnknownChannel", "UnknownMessage"]
  },
  "member.addRole": {
    flags: ["ManageRoles"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "RoleAboveInHierarchy", "RoleIsManaged", "TwoFactorRequired", "UnknownRole", "UnknownMember"]
  },
  "member.removeRole": {
    flags: ["ManageRoles"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "RoleAboveInHierarchy", "RoleIsManaged", "TwoFactorRequired", "UnknownRole", "UnknownMember"]
  },
  "member.setNickname": {
    flags: ["ManageNicknames"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TargetAboveInHierarchy", "UnknownMember"]
  },
  "member.timeout": {
    flags: ["ModerateMembers"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TargetAboveInHierarchy", "TargetIsAdministrator", "UnknownMember"]
  },
  "member.kick": {
    flags: ["KickMembers"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TargetAboveInHierarchy", "TwoFactorRequired", "UnknownMember"]
  },
  "member.ban": {
    flags: ["BanMembers"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TargetAboveInHierarchy", "TwoFactorRequired", "UnknownMember"]
  },
  "permissions.require": { flags: ["ViewChannel"], variant: "default", tags: ["CommunicationDisabled", "UnknownChannel"] }
} as const satisfies Record<string, OpSpec>

/** The table's type. */
export type Ops = typeof Operations
/** An operation name. */
export type OpName = keyof Ops

/** Each operation's required flags (excluding payload-derived flags). */
export type OpFlags = { readonly [Op in OpName]: Ops[Op]["flags"][number] }
/** Each operation's non-permission errors, as classes. */
export type OpTags = { readonly [Op in OpName]: TagClasses[Ops[Op]["tags"][number]] }
/** Each operation's flag-to-class lookup, after its D5 variant. */
export type OpPermissionErrors = { readonly [Op in OpName]: VariantErrors[Ops[Op]["variant"]] }

/**
 * D8: on a handle from `Permissions.require` that checked `G`, the missing-flag errors for the checked flags of
 * `F` collapse into one `PermissionRevokedSinceCheck`. A conditional, so hovers show the class.
 */
export type Revoked<F extends PermissionFlag, G extends PermissionFlag> = [Extract<F, G>] extends [never] ? never : PermissionRevokedSinceCheck

/**
 * Each operation's error union on a handle whose granted flags are `G` (`never` without `Permissions.require`):
 * the missing-flag classes for the required flags not granted, `PermissionRevokedSinceCheck` when a required
 * flag was granted, the row's tags and `Transient`. Payload- and argument-derived members are added by the
 * operation signatures (§2.3-§2.6).
 */
export type OpErrors<G extends PermissionFlag> = {
  readonly [Op in OpName]: OpPermissionErrors[Op][Exclude<OpFlags[Op], G>] | Revoked<OpFlags[Op], G> | OpTags[Op] | Transient
}

/**
 * The constructor table, typed against `VariantErrors`: building the base `MissingReadMessageHistory` where a
 * variant promises `...ForReply` or `...ForReaction` is a compile error, because the base class lacks the extra
 * category marker.
 */
export const variantConstructors: {
  readonly [V in Variant]: { readonly [F in PermissionFlag]: (cause: ErrorCause) => VariantErrors[V][F] }
} = {
  default: missing,
  reply: { ...missing, ReadMessageHistory: (cause) => new MissingReadMessageHistoryForReply({ cause }) },
  reaction: { ...missing, ReadMessageHistory: (cause) => new MissingReadMessageHistoryForReaction({ cause }) }
}

/**
 * The only way library code builds a permission error: the class operation `op` promises for a missing `flag`
 * (its D5 variant), with `cause`. `flag` may be any flag, because payload rules add flags outside the row.
 *
 * An overload attaches the precise `OpPermissionErrors[Op][F]` to the wide implementation (rule 7 of §2.12);
 * the trust boundary is only that `Operations[op].variant` is `op`'s variant, and `variantConstructors` is
 * checked per variant. `test/unit/error-for.test.ts` checks every (operation, flag) at run time.
 */
export function errorFor<Op extends OpName, F extends PermissionFlag>(op: Op, flag: F, cause: ErrorCause): OpPermissionErrors[Op][F]
export function errorFor(op: OpName, flag: PermissionFlag, cause: ErrorCause): OpPermissionErrors[OpName][PermissionFlag] {
  return variantConstructors[Operations[op].variant][flag](cause)
}
