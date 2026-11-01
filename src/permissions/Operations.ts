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
    flags: ["ViewChannel", "ManageThreads"],
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
  "channel.pins": { flags: ["ViewChannel"], variant: "default", tags: [...unattributed, "UnknownChannel"] },
  "voice.pins": { flags: ["ViewChannel", "Connect"], variant: "default", tags: [...unattributed, "CommunicationDisabled", "UnknownChannel"] },
  "channel.bulkDelete": {
    flags: ["ViewChannel", "ManageMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "MessagesTooOld", "TooManyMessagesToDelete", "UnknownChannel"]
  },
  "thread.join": { flags: ["ViewChannel"], variant: "default", tags: [...unattributed, "ThreadArchived", "UnknownChannel"] },
  "thread.leave": { flags: ["ViewChannel"], variant: "default", tags: [...unattributed, "ThreadArchived", "UnknownChannel"] },
  "thread.addMember": {
    flags: ["ViewChannel", "SendMessagesInThreads"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "ThreadArchived", "UnknownChannel", "UnknownMember"]
  },
  "thread.setArchived": {
    flags: ["ViewChannel", "ManageThreads"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "ThreadLocked", "UnknownChannel"]
  },
  "thread.setLocked": {
    flags: ["ViewChannel", "ManageThreads"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "UnknownChannel"]
  },
  "message.edit.channel": {
    flags: ["ViewChannel"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "RateLimited", "UnknownMessage"]
  },
  "message.edit.thread": {
    flags: ["ViewChannel"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "RateLimited", "ThreadArchived", "ThreadLocked", "UnknownMessage"]
  },
  "message.deleteOwn": { flags: ["ViewChannel"], variant: "default", tags: [...unattributed, "UnknownMessage"] },
  "message.deleteForeign": {
    flags: ["ViewChannel", "ManageMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "UnknownMessage"]
  },
  "message.react.channel": {
    flags: ["ViewChannel", "ReadMessageHistory", "AddReactions"],
    variant: "reaction",
    tags: [...unattributed, "CommunicationDisabled", "MaximumReactionsReached", "UnknownEmoji", "UnknownMessage"]
  },
  "message.react.thread": {
    flags: ["ViewChannel", "ReadMessageHistory", "AddReactions"],
    variant: "reaction",
    tags: [...unattributed, "CommunicationDisabled", "MaximumReactionsReached", "ThreadArchived", "UnknownEmoji", "UnknownMessage"]
  },
  "message.react.voice": {
    flags: ["ViewChannel", "Connect", "ReadMessageHistory", "AddReactions"],
    variant: "reaction",
    tags: [...unattributed, "CommunicationDisabled", "MaximumReactionsReached", "UnknownEmoji", "UnknownMessage"]
  },
  "message.pin.channel": {
    flags: ["ViewChannel", "PinMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "MaximumPinsReached", "UnknownMessage"]
  },
  "message.pin.thread": {
    flags: ["ViewChannel", "PinMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "MaximumPinsReached", "ThreadArchived", "UnknownMessage"]
  },
  "message.pin.voice": {
    flags: ["ViewChannel", "Connect", "PinMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "MaximumPinsReached", "UnknownMessage"]
  },
  "message.unpin.channel": {
    flags: ["ViewChannel", "PinMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "UnknownMessage"]
  },
  "message.unpin.thread": {
    flags: ["ViewChannel", "PinMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "ThreadArchived", "UnknownMessage"]
  },
  "message.unpin.voice": {
    flags: ["ViewChannel", "Connect", "PinMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "UnknownMessage"]
  },
  "message.crosspostOwn": {
    flags: ["ViewChannel", "SendMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "AlreadyCrossposted", "RateLimited", "UnknownMessage"]
  },
  "message.crosspostForeign": {
    flags: ["ViewChannel", "SendMessages", "ManageMessages"],
    variant: "default",
    tags: [...unattributed, "CommunicationDisabled", "TwoFactorRequired", "AlreadyCrossposted", "RateLimited", "UnknownMessage"]
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
