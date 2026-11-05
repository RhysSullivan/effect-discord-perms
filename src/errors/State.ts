/**
 * `state` errors (DESIGN §3.1): the bot may have the permission, but the current state of the guild, channel,
 * thread, member or object blocks the action. Codes and statuses are hypotheses until the live matrix records
 * them.
 */
import { Schema } from "effect"
import { CategorizedError } from "./Category.ts"
import { ErrorCause } from "./Cause.ts"

/**
 * The bot is timed out (H-020): the timeout mask leaves only ViewChannel and ReadMessageHistory. In the unions
 * only while `Observed.botsCanBeTimedOut` (§8, question 1).
 */
export class CommunicationDisabled extends CategorizedError<CommunicationDisabled>()("CommunicationDisabled", {
  /** When the timeout ends: Discord's `communication_disabled_until` ISO 8601 timestamp. */
  until: Schema.String,
  cause: ErrorCause
}, ["state"]) {}

/** The thread is locked (160005): only members with ManageThreads can act in it. */
export class ThreadLocked extends CategorizedError<ThreadLocked>()("ThreadLocked", { cause: ErrorCause }, ["state"]) {}

/** The thread is archived (50083). Not raised by send (C16, H-035). */
export class ThreadArchived extends CategorizedError<ThreadArchived>()("ThreadArchived", { cause: ErrorCause }, ["state"]) {}

/** Slowmode applies to the bot (20016). In the unions only while `Observed.slowmodeAppliesToBots` (D11, H-053). */
export class SlowmodeActive extends CategorizedError<SlowmodeActive>()("SlowmodeActive", {
  retryAfterMs: Schema.Int,
  cause: ErrorCause
}, ["state"]) {}

/** The target member's highest role is not below the bot's (setNickname, timeout, kick, ban; H-062..H-066). */
export class TargetAboveInHierarchy extends CategorizedError<TargetAboveInHierarchy>()("TargetAboveInHierarchy", {
  cause: ErrorCause
}, ["state"]) {}

/** The role being granted or removed is not below the bot's highest role (H-060); the target's rank does not matter (H-061). */
export class RoleAboveInHierarchy extends CategorizedError<RoleAboveInHierarchy>()("RoleAboveInHierarchy", {
  cause: ErrorCause
}, ["state"]) {}

/** Administrators and the owner cannot be timed out (H-021, H-067). */
export class TargetIsAdministrator extends CategorizedError<TargetIsAdministrator>()("TargetIsAdministrator", {
  cause: ErrorCause
}, ["state"]) {}

/** The interaction token has expired or the interaction is unknown (10062, 10015, 50027; phase 3). */
export class InteractionExpired extends CategorizedError<InteractionExpired>()("InteractionExpired", {
  cause: ErrorCause
}, ["state"]) {}

/** The message has already been crossposted (40033, H-141). */
export class AlreadyCrossposted extends CategorizedError<AlreadyCrossposted>()("AlreadyCrossposted", {
  cause: ErrorCause
}, ["state"]) {}

/** The channel does not exist, or the bot cannot know it exists (10003). */
export class UnknownChannel extends CategorizedError<UnknownChannel>()("UnknownChannel", { cause: ErrorCause }, ["state"]) {}

/** The message does not exist (10008). */
export class UnknownMessage extends CategorizedError<UnknownMessage>()("UnknownMessage", { cause: ErrorCause }, ["state"]) {}

/** The member is not in the guild (10007). */
export class UnknownMember extends CategorizedError<UnknownMember>()("UnknownMember", { cause: ErrorCause }, ["state"]) {}

/** The role does not exist (10011). */
export class UnknownRole extends CategorizedError<UnknownRole>()("UnknownRole", { cause: ErrorCause }, ["state"]) {}

/** The emoji does not exist or is not usable here (10014). */
export class UnknownEmoji extends CategorizedError<UnknownEmoji>()("UnknownEmoji", { cause: ErrorCause }, ["state"]) {}

/** The guild requires 2FA for moderation and the app owner has none (60003, H-072). Live only if `mfaLevel = 1` (§8, question 16). */
export class TwoFactorRequired extends CategorizedError<TwoFactorRequired>()("TwoFactorRequired", {
  cause: ErrorCause
}, ["state"]) {}

/** Managed roles (bot or booster roles) cannot be assigned or removed through the API (H-068). */
export class RoleIsManaged extends CategorizedError<RoleIsManaged>()("RoleIsManaged", { cause: ErrorCause }, ["state"]) {}

/** A thread already exists for this message (160004). */
export class ThreadAlreadyExists extends CategorizedError<ThreadAlreadyExists>()("ThreadAlreadyExists", {
  cause: ErrorCause
}, ["state"]) {}

/** The forum or media channel requires a tag on new posts (40067, H-044). */
export class TagRequired extends CategorizedError<TagRequired>()("TagRequired", { cause: ErrorCause }, ["state"]) {}

/** The channel has the maximum number of pins (30003). */
export class MaximumPinsReached extends CategorizedError<MaximumPinsReached>()("MaximumPinsReached", {
  cause: ErrorCause
}, ["state"]) {}

/** The message has the maximum number of reactions (30010). */
export class MaximumReactionsReached extends CategorizedError<MaximumReactionsReached>()("MaximumReactionsReached", {
  cause: ErrorCause
}, ["state"]) {}

/** The guild or channel has the maximum number of active threads (160006). */
export class MaximumActiveThreads extends CategorizedError<MaximumActiveThreads>()("MaximumActiveThreads", {
  cause: ErrorCause
}, ["state"]) {}

/** The user does not accept DMs from this bot (50007; DM channels only). */
export class CannotMessageUser extends CategorizedError<CannotMessageUser>()("CannotMessageUser", {
  cause: ErrorCause
}, ["state"]) {}

/** The application has used its daily command-create allowance (30034). Command registration surfaces it as `StartupFailed`. */
export class DailyCommandCreateLimit extends CategorizedError<DailyCommandCreateLimit>()("DailyCommandCreateLimit", {
  cause: ErrorCause
}, ["state"]) {}

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
