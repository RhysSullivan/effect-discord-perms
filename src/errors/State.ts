/**
 * `state` errors (DESIGN §3.1): the bot may have the permission, but the current state of the guild, channel,
 * thread, member or object blocks the action. Codes and statuses are hypotheses until the live matrix records
 * them.
 */
import { Schema } from "effect"
import { withCategory } from "./Category.ts"
import { ErrorCause } from "./Cause.ts"

/**
 * The bot is timed out (H-020): the timeout mask leaves only ViewChannel and ReadMessageHistory. In the unions
 * only while `Observed.botsCanBeTimedOut` (§8, question 1).
 */
export class CommunicationDisabled extends Schema.TaggedError<CommunicationDisabled>()("CommunicationDisabled", {
  /** When the timeout ends: Discord's `communication_disabled_until` ISO 8601 timestamp. */
  until: Schema.String,
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** The thread is locked (160005): only members with ManageThreads can act in it. */
export class ThreadLocked extends Schema.TaggedError<ThreadLocked>()("ThreadLocked", { cause: ErrorCause }).pipe(withCategory("state")) {}

/** The thread is archived (50083). Not raised by send (C16, H-035). */
export class ThreadArchived extends Schema.TaggedError<ThreadArchived>()("ThreadArchived", { cause: ErrorCause }).pipe(withCategory("state")) {}

/** Slowmode applies to the bot (20016). In the unions only while `Observed.slowmodeAppliesToBots` (D11, H-053). */
export class SlowmodeActive extends Schema.TaggedError<SlowmodeActive>()("SlowmodeActive", {
  retryAfterMs: Schema.Int,
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** The target member's highest role is not below the bot's (setNickname, timeout, kick, ban; H-062..H-066). */
export class TargetAboveInHierarchy extends Schema.TaggedError<TargetAboveInHierarchy>()("TargetAboveInHierarchy", {
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** The role being granted or removed is not below the bot's highest role (H-060); the target's rank does not matter (H-061). */
export class RoleAboveInHierarchy extends Schema.TaggedError<RoleAboveInHierarchy>()("RoleAboveInHierarchy", {
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** Administrators and the owner cannot be timed out (H-021, H-067). */
export class TargetIsAdministrator extends Schema.TaggedError<TargetIsAdministrator>()("TargetIsAdministrator", {
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** The interaction token has expired or the interaction is unknown (10062, 10015, 50027; phase 3). */
export class InteractionExpired extends Schema.TaggedError<InteractionExpired>()("InteractionExpired", {
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** The message has already been crossposted (40033, H-141). */
export class AlreadyCrossposted extends Schema.TaggedError<AlreadyCrossposted>()("AlreadyCrossposted", {
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** The channel does not exist, or the bot cannot know it exists (10003). */
export class UnknownChannel extends Schema.TaggedError<UnknownChannel>()("UnknownChannel", { cause: ErrorCause }).pipe(withCategory("state")) {}

/** The message does not exist (10008). */
export class UnknownMessage extends Schema.TaggedError<UnknownMessage>()("UnknownMessage", { cause: ErrorCause }).pipe(withCategory("state")) {}

/** The member is not in the guild (10007). */
export class UnknownMember extends Schema.TaggedError<UnknownMember>()("UnknownMember", { cause: ErrorCause }).pipe(withCategory("state")) {}

/** The role does not exist (10011). */
export class UnknownRole extends Schema.TaggedError<UnknownRole>()("UnknownRole", { cause: ErrorCause }).pipe(withCategory("state")) {}

/** The emoji does not exist or is not usable here (10014). */
export class UnknownEmoji extends Schema.TaggedError<UnknownEmoji>()("UnknownEmoji", { cause: ErrorCause }).pipe(withCategory("state")) {}

/** The guild requires 2FA for moderation and the app owner has none (60003, H-072). Live only if `mfaLevel = 1` (§8, question 16). */
export class TwoFactorRequired extends Schema.TaggedError<TwoFactorRequired>()("TwoFactorRequired", {
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** Managed roles (bot or booster roles) cannot be assigned or removed through the API (H-068). */
export class RoleIsManaged extends Schema.TaggedError<RoleIsManaged>()("RoleIsManaged", { cause: ErrorCause }).pipe(withCategory("state")) {}

/** A thread already exists for this message (160004). */
export class ThreadAlreadyExists extends Schema.TaggedError<ThreadAlreadyExists>()("ThreadAlreadyExists", {
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** The forum or media channel requires a tag on new posts (40067, H-044). */
export class TagRequired extends Schema.TaggedError<TagRequired>()("TagRequired", { cause: ErrorCause }).pipe(withCategory("state")) {}

/** The channel has the maximum number of pins (30003). */
export class MaximumPinsReached extends Schema.TaggedError<MaximumPinsReached>()("MaximumPinsReached", {
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** The message has the maximum number of reactions (30010). */
export class MaximumReactionsReached extends Schema.TaggedError<MaximumReactionsReached>()("MaximumReactionsReached", {
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** The guild or channel has the maximum number of active threads (160006). */
export class MaximumActiveThreads extends Schema.TaggedError<MaximumActiveThreads>()("MaximumActiveThreads", {
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** The user does not accept DMs from this bot (50007; DM channels only). */
export class CannotMessageUser extends Schema.TaggedError<CannotMessageUser>()("CannotMessageUser", {
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** The application has used its daily command-create allowance (30034). Command registration surfaces it as `StartupFailed`. */
export class DailyCommandCreateLimit extends Schema.TaggedError<DailyCommandCreateLimit>()("DailyCommandCreateLimit", {
  cause: ErrorCause
}).pipe(withCategory("state")) {}

/** Every class in this module, keyed by class name. */
export const StateClasses = {
  CommunicationDisabled,
  ThreadLocked,
  ThreadArchived,
  SlowmodeActive,
  TargetAboveInHierarchy,
  RoleAboveInHierarchy,
  TargetIsAdministrator,
  InteractionExpired,
  AlreadyCrossposted,
  UnknownChannel,
  UnknownMessage,
  UnknownMember,
  UnknownRole,
  UnknownEmoji,
  TwoFactorRequired,
  RoleIsManaged,
  ThreadAlreadyExists,
  TagRequired,
  MaximumPinsReached,
  MaximumReactionsReached,
  MaximumActiveThreads,
  CannotMessageUser,
  DailyCommandCreateLimit
} as const
