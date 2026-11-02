// The operation table's derived types (DESIGN §2.4, §4.7): one exact union per row of `OpErrors<never>`, the
// D8 collapse for granted flags, the D5 variants, the Observed gating, and errorFor's precise return type.
// Each expected union is written out by hand from §2.4-§2.6, §3.1 and §4.7, so a change to a row must change
// this file too.
import { expectTypeOf } from "vitest"
import type {
  AlreadyCrossposted,
  CannotMessageUser,
  Categories,
  CommunicationDisabled,
  DiscordUnavailable,
  ErrorCause,
  MaximumActiveThreads,
  MaximumPinsReached,
  MaximumReactionsReached,
  MessagesTooOld,
  MissingAddReactions,
  MissingBanMembers,
  MissingConnect,
  MissingCreatePrivateThreads,
  MissingCreatePublicThreads,
  MissingEmbedLinks,
  MissingKickMembers,
  MissingManageChannels,
  MissingManageMessages,
  MissingManageNicknames,
  MissingManageRoles,
  MissingManageThreads,
  MissingModerateMembers,
  MissingPinMessages,
  MissingReadMessageHistory,
  MissingReadMessageHistoryForReaction,
  MissingReadMessageHistoryForReply,
  MissingSendMessages,
  MissingSendMessagesInThreads,
  MissingViewChannel,
  NetworkError,
  PermissionDeniedUnattributed,
  PermissionErrors,
  PermissionFlag,
  PermissionRevokedSinceCheck,
  RateLimited,
  RequestTimedOut,
  RoleAboveInHierarchy,
  RoleIsManaged,
  SlowmodeActive,
  TagRequired,
  TargetAboveInHierarchy,
  TargetIsAdministrator,
  ThreadArchived,
  ThreadLocked,
  TooManyMessagesToDelete,
  TwoFactorRequired,
  UnknownChannel,
  UnknownEmoji,
  UnknownMember,
  UnknownMessage,
  UnknownRole
} from "../../../src/errors/index.ts"
import type { MaybeSlowmode, MaybeTimedOut } from "../../../src/permissions/Observed.ts"
import { errorFor, type OpErrors, type OpName, type OpPermissionErrors, type OpTags, type Transient } from "../../../src/permissions/Operations.ts"

// ---- Transient and the Observed gating ----
expectTypeOf<Transient>().toEqualTypeOf<DiscordUnavailable | RequestTimedOut | NetworkError>()
// Observed: bots can be timed out (kept), slowmode does not apply to bots (dropped) until the matrix says otherwise.
expectTypeOf<MaybeTimedOut>().toEqualTypeOf<CommunicationDisabled>()
expectTypeOf<MaybeSlowmode>().toEqualTypeOf<never>()
expectTypeOf<SlowmodeActive>().not.toExtend<OpTags["channel.send"]>()

// ---- every row of OpErrors<never> ----
// Sends
expectTypeOf<OpErrors<never>["channel.send"]>().toEqualTypeOf<
  MissingViewChannel | MissingSendMessages | PermissionDeniedUnattributed | CommunicationDisabled | RateLimited | UnknownChannel | Transient
>()
expectTypeOf<OpErrors<never>["thread.send"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingSendMessagesInThreads
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | RateLimited
  | ThreadLocked
  | UnknownChannel
  | Transient
>()
expectTypeOf<OpErrors<never>["voice.send"]>().toEqualTypeOf<
  MissingViewChannel | MissingConnect | MissingSendMessages | PermissionDeniedUnattributed | CommunicationDisabled | RateLimited | UnknownChannel | Transient
>()
expectTypeOf<OpErrors<never>["dm.send"]>().toEqualTypeOf<CannotMessageUser | RateLimited | UnknownChannel | Transient>()
expectTypeOf<OpErrors<never>["forum.createPost"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingSendMessages
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | TagRequired
  | MaximumActiveThreads
  | RateLimited
  | UnknownChannel
  | Transient
>()

// Channel and thread edits
expectTypeOf<OpErrors<never>["channel.edit"]>().toEqualTypeOf<
  MissingViewChannel | MissingManageChannels | PermissionDeniedUnattributed | CommunicationDisabled | TwoFactorRequired | UnknownChannel | Transient
>()
expectTypeOf<OpErrors<never>["thread.edit"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingSendMessagesInThreads
  | MissingManageThreads
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | TwoFactorRequired
  | ThreadLocked
  | UnknownChannel
  | Transient
>()
expectTypeOf<OpErrors<never>["voice.edit"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingConnect
  | MissingManageChannels
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | TwoFactorRequired
  | UnknownChannel
  | Transient
>()

// Thread creation, pins, bulk delete
expectTypeOf<OpErrors<never>["channel.createThread.public"]>().toEqualTypeOf<
  MissingViewChannel | MissingCreatePublicThreads | PermissionDeniedUnattributed | CommunicationDisabled | MaximumActiveThreads | UnknownChannel | Transient
>()
expectTypeOf<OpErrors<never>["channel.createThread.private"]>().toEqualTypeOf<
  MissingViewChannel | MissingCreatePrivateThreads | PermissionDeniedUnattributed | CommunicationDisabled | MaximumActiveThreads | UnknownChannel | Transient
>()
expectTypeOf<OpErrors<never>["channel.pins"]>().toEqualTypeOf<MissingViewChannel | PermissionDeniedUnattributed | UnknownChannel | Transient>()
expectTypeOf<OpErrors<never>["voice.pins"]>().toEqualTypeOf<
  MissingViewChannel | MissingConnect | PermissionDeniedUnattributed | CommunicationDisabled | UnknownChannel | Transient
>()
expectTypeOf<OpErrors<never>["channel.bulkDelete"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingManageMessages
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | TwoFactorRequired
  | MessagesTooOld
  | TooManyMessagesToDelete
  | UnknownChannel
  | Transient
>()
expectTypeOf<OpErrors<never>["thread.bulkDelete"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingManageMessages
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | TwoFactorRequired
  | MessagesTooOld
  | ThreadArchived
  | TooManyMessagesToDelete
  | UnknownChannel
  | Transient
>()
expectTypeOf<OpErrors<never>["voice.bulkDelete"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingConnect
  | MissingManageMessages
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | TwoFactorRequired
  | MessagesTooOld
  | TooManyMessagesToDelete
  | UnknownChannel
  | Transient
>()

// Thread operations
expectTypeOf<OpErrors<never>["thread.join"]>().toEqualTypeOf<
  | MissingViewChannel
  | PermissionDeniedUnattributed
  | UnknownChannel
  | Transient
>()
expectTypeOf<OpErrors<never>["thread.leave"]>().toEqualTypeOf<
  | PermissionDeniedUnattributed
  | UnknownChannel
  | Transient
>()
expectTypeOf<OpErrors<never>["thread.addMember"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingSendMessagesInThreads
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | UnknownChannel
  | UnknownMember
  | Transient
>()
expectTypeOf<OpErrors<never>["thread.setArchived"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingSendMessagesInThreads
  | MissingManageThreads
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | TwoFactorRequired
  | ThreadLocked
  | UnknownChannel
  | Transient
>()
expectTypeOf<OpErrors<never>["thread.unarchive"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingSendMessagesInThreads
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | ThreadLocked
  | UnknownChannel
  | Transient
>()
expectTypeOf<OpErrors<never>["thread.setLocked"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingSendMessagesInThreads
  | MissingManageThreads
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | TwoFactorRequired
  | UnknownChannel
  | Transient
>()
expectTypeOf<OpErrors<never>["thread.delete"]>().toEqualTypeOf<
  MissingViewChannel | MissingManageThreads | PermissionDeniedUnattributed | CommunicationDisabled | TwoFactorRequired | UnknownChannel | Transient
>()

// Message edits and deletes
expectTypeOf<OpErrors<never>["message.edit.channel"]>().toEqualTypeOf<
  MissingViewChannel | PermissionDeniedUnattributed | CommunicationDisabled | RateLimited | UnknownMessage | Transient
>()
expectTypeOf<OpErrors<never>["message.edit.thread"]>().toEqualTypeOf<
  | MissingViewChannel
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | RateLimited
  | ThreadArchived
  | UnknownMessage
  | Transient
>()
expectTypeOf<OpErrors<never>["message.edit.voice"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingConnect
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | RateLimited
  | UnknownMessage
  | Transient
>()
expectTypeOf<OpErrors<never>["message.deleteOwn"]>().toEqualTypeOf<MissingViewChannel | PermissionDeniedUnattributed | UnknownMessage | Transient>()
expectTypeOf<OpErrors<never>["message.deleteOwn.thread"]>().toEqualTypeOf<
  | MissingViewChannel
  | PermissionDeniedUnattributed
  | ThreadArchived
  | UnknownMessage
  | Transient
>()
expectTypeOf<OpErrors<never>["message.deleteOwn.voice"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingConnect
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | UnknownMessage
  | Transient
>()
expectTypeOf<OpErrors<never>["message.deleteForeign"]>().toEqualTypeOf<
  MissingViewChannel | MissingManageMessages | PermissionDeniedUnattributed | CommunicationDisabled | TwoFactorRequired | UnknownMessage | Transient
>()
expectTypeOf<OpErrors<never>["message.deleteForeign.thread"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingManageMessages
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | TwoFactorRequired
  | ThreadArchived
  | UnknownMessage
  | Transient
>()
expectTypeOf<OpErrors<never>["message.deleteForeign.voice"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingConnect
  | MissingManageMessages
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | TwoFactorRequired
  | UnknownMessage
  | Transient
>()

// Reactions need no ReadMessageHistory (M4 live, H-144); the `reaction` variant is kept for the rows
expectTypeOf<OpErrors<never>["message.react.channel"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingAddReactions
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | MaximumReactionsReached
  | UnknownEmoji
  | UnknownMessage
  | Transient
>()
expectTypeOf<OpErrors<never>["message.react.thread"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingAddReactions
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | MaximumReactionsReached
  | ThreadArchived
  | UnknownEmoji
  | UnknownMessage
  | Transient
>()
expectTypeOf<OpErrors<never>["message.react.voice"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingConnect
  | MissingAddReactions
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | MaximumReactionsReached
  | UnknownEmoji
  | UnknownMessage
  | Transient
>()

// Pins
expectTypeOf<OpErrors<never>["message.pin.channel"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingReadMessageHistory
  | MissingPinMessages
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | MaximumPinsReached
  | UnknownMessage
  | Transient
>()
expectTypeOf<OpErrors<never>["message.pin.thread"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingReadMessageHistory
  | MissingPinMessages
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | MaximumPinsReached
  | ThreadArchived
  | UnknownMessage
  | Transient
>()
expectTypeOf<OpErrors<never>["message.unpin.channel"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingReadMessageHistory
  | MissingPinMessages
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | UnknownMessage
  | Transient
>()
expectTypeOf<OpErrors<never>["message.unpin.thread"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingReadMessageHistory
  | MissingPinMessages
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | ThreadArchived
  | UnknownMessage
  | Transient
>()

// Crossposts
expectTypeOf<OpErrors<never>["message.crosspostOwn"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingReadMessageHistory
  | MissingSendMessages
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | AlreadyCrossposted
  | RateLimited
  | UnknownMessage
  | Transient
>()
expectTypeOf<OpErrors<never>["message.crosspostForeign"]>().toEqualTypeOf<
  | MissingViewChannel
  | MissingReadMessageHistory
  | MissingSendMessages
  | MissingManageMessages
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | TwoFactorRequired
  | AlreadyCrossposted
  | RateLimited
  | UnknownMessage
  | Transient
>()

// Members: role assignment checks the role's rank, the other operations the target's (H-060, H-061)
expectTypeOf<OpErrors<never>["member.addRole"]>().toEqualTypeOf<
  | MissingManageRoles
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | RoleAboveInHierarchy
  | RoleIsManaged
  | TwoFactorRequired
  | UnknownRole
  | UnknownMember
  | Transient
>()
expectTypeOf<OpErrors<never>["member.removeRole"]>().toEqualTypeOf<
  | MissingManageRoles
  | PermissionDeniedUnattributed
  | CommunicationDisabled
  | RoleAboveInHierarchy
  | RoleIsManaged
  | TwoFactorRequired
  | UnknownRole
  | UnknownMember
  | Transient
>()
expectTypeOf<OpErrors<never>["member.setNickname"]>().toEqualTypeOf<
  MissingManageNicknames | PermissionDeniedUnattributed | CommunicationDisabled | TargetAboveInHierarchy | UnknownMember | Transient
>()
expectTypeOf<OpErrors<never>["member.timeout"]>().toEqualTypeOf<
  MissingModerateMembers | PermissionDeniedUnattributed | CommunicationDisabled | TargetAboveInHierarchy | TargetIsAdministrator | UnknownMember | Transient
>()
expectTypeOf<OpErrors<never>["member.kick"]>().toEqualTypeOf<
  MissingKickMembers | PermissionDeniedUnattributed | CommunicationDisabled | TargetAboveInHierarchy | TwoFactorRequired | UnknownMember | Transient
>()
expectTypeOf<OpErrors<never>["member.ban"]>().toEqualTypeOf<
  MissingBanMembers | PermissionDeniedUnattributed | CommunicationDisabled | TargetAboveInHierarchy | TwoFactorRequired | UnknownMember | Transient
>()

// Permissions.require
expectTypeOf<OpErrors<never>["permissions.require"]>().toEqualTypeOf<MissingViewChannel | CommunicationDisabled | UnknownChannel | Transient>()

// ---- D8: flags granted by Permissions.require collapse into one PermissionRevokedSinceCheck ----
expectTypeOf<OpErrors<"SendMessages">["channel.send"]>().toEqualTypeOf<
  MissingViewChannel | PermissionRevokedSinceCheck | PermissionDeniedUnattributed | CommunicationDisabled | RateLimited | UnknownChannel | Transient
>()
expectTypeOf<OpErrors<"ViewChannel" | "SendMessages">["channel.send"]>().toEqualTypeOf<
  PermissionRevokedSinceCheck | PermissionDeniedUnattributed | CommunicationDisabled | RateLimited | UnknownChannel | Transient
>()
// A granted flag the row does not require changes nothing.
expectTypeOf<OpErrors<"EmbedLinks">["message.pin.channel"]>().toEqualTypeOf<OpErrors<never>["message.pin.channel"]>()

// ---- D5 variants per row ----
expectTypeOf<OpPermissionErrors["channel.send"]["ReadMessageHistory"]>().toEqualTypeOf<MissingReadMessageHistoryForReply>()
expectTypeOf<OpPermissionErrors["forum.createPost"]["ReadMessageHistory"]>().toEqualTypeOf<MissingReadMessageHistoryForReply>()
expectTypeOf<OpPermissionErrors["message.react.voice"]["ReadMessageHistory"]>().toEqualTypeOf<MissingReadMessageHistoryForReaction>()
expectTypeOf<OpPermissionErrors["message.pin.channel"]["ReadMessageHistory"]>().toEqualTypeOf<MissingReadMessageHistory>()
expectTypeOf<OpPermissionErrors["channel.send"]["EmbedLinks"]>().toEqualTypeOf<MissingEmbedLinks>()

// ---- errorFor returns exactly the class the row promises ----
declare const cause: ErrorCause
expectTypeOf(errorFor("channel.send", "ReadMessageHistory", cause)).toEqualTypeOf<MissingReadMessageHistoryForReply>()
expectTypeOf(errorFor("message.react.thread", "ReadMessageHistory", cause)).toEqualTypeOf<MissingReadMessageHistoryForReaction>()
expectTypeOf(errorFor("message.pin.thread", "ReadMessageHistory", cause)).toEqualTypeOf<MissingReadMessageHistory>()
expectTypeOf(errorFor("channel.send", "EmbedLinks", cause)).toEqualTypeOf<MissingEmbedLinks>()
// With a wide operation and flag, the result is every permission error class.
declare const someOp: OpName
declare const someFlag: PermissionFlag
expectTypeOf(errorFor(someOp, someFlag, cause)).toEqualTypeOf<
  PermissionErrors[PermissionFlag] | MissingReadMessageHistoryForReply | MissingReadMessageHistoryForReaction
>()

// ---- a row's categories ----
expectTypeOf<Categories<OpErrors<never>["channel.send"]>>().toEqualTypeOf<"access" | "permission" | "state" | "transient">()
expectTypeOf<Categories<OpErrors<never>["member.ban"]>>().toEqualTypeOf<"permission" | "state" | "transient">()
expectTypeOf<Categories<OpErrors<never>["channel.bulkDelete"]>>().toEqualTypeOf<"access" | "payload" | "permission" | "state" | "transient">()
