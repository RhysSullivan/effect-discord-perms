/**
 * The permission resolver (DESIGN §4.6; D22; H-001..H-029, H-033, H-047, H-160). Pure: the same input always
 * gives the same resolution, and nothing here reads a clock or a service.
 *
 * Stages, in order:
 *
 * 1. **base**: the owner holds everything (H-002); otherwise `@everyone` (the role whose ID is the guild ID)
 *    OR the member's roles (H-001); Administrator gives everything (H-003).
 * 2. **overwrites**, on the parent for threads (H-030): `@everyone`'s overwrite, then every role overwrite of
 *    the member's roles aggregated (deny, then allow; H-006, H-007), then the member's own overwrite (H-008).
 *    Array order and role positions do not matter (H-009, H-010); an overwrite for a role the member lacks
 *    does nothing (H-011). Administrator in the base bypasses them all.
 * 3. **masks**, each recorded when its condition holds, in this order, stopping once nothing is left:
 *    `obfuscated` and `unseen` (the bot cannot see the channel: no View, H-160), `private-thread` (a private
 *    thread the bot neither belongs to nor moderates: no View, H-033, H-047), `implicit-view` (no View means
 *    nothing, H-012), `implicit-send` (no Send masks MentionEveryone, SendTTSMessages, AttachFiles and
 *    EmbedLinks on non-thread channels, H-013), `implicit-connect` (no Connect in voice and stage masks
 *    ManageChannels, H-015), and `timeout` (a timed-out member keeps only View and ReadMessageHistory, unless
 *    owner or Administrator, after overwrites; H-020, H-021, H-029).
 *
 * Every switch is an entry of `ResolverRules.ts`.
 */
import type { PermissionFlag } from "../errors/Missing.generated.ts"
import type { ChannelSnap, RoleSnap } from "../state/Snapshot.ts"
import { everyoneRoleId, isThreadKind, isVoiceKind } from "../state/Snapshot.ts"
import type { GuildId, RoleId, UserId } from "../Snowflake.ts"
import * as Flags from "./Flags.ts"
import { ResolverRules } from "./ResolverRules.ts"

/** A mask the resolver applied, in the order they are applied. */
export type Mask = "obfuscated" | "unseen" | "private-thread" | "implicit-view" | "implicit-send" | "implicit-connect" | "timeout"

/** Every mask, in application order. */
export const masks: ReadonlyArray<Mask> = ["obfuscated", "unseen", "private-thread", "implicit-view", "implicit-send", "implicit-connect", "timeout"]

/** The masks that mean the bot cannot see the channel at all (View-level, §3.2). */
export const blindMasks: ReadonlySet<Mask> = new Set(["obfuscated", "unseen", "private-thread"])

/** The guild facts the resolver needs. */
export interface GuildInput {
  readonly id: GuildId
  readonly ownerId: UserId
  readonly roles: ReadonlyMap<RoleId, RoleSnap>
}

/** The member being resolved. */
export interface MemberInput {
  readonly userId: UserId
  readonly roleIds: ReadonlyArray<RoleId>
  /** Discord's `communication_disabled_until` (ISO 8601), or `null`. */
  readonly timedOutUntil: string | null
}

/**
 * The channel, as the bot knows it:
 * - `Known`: the channel (and, for a thread, its parent, which must be known too);
 * - `Unseen`: the bot cannot see it (a refresh got 50001 or 10003, or a thread's parent cannot be fetched).
 */
export type ChannelInput =
  | {
    readonly _tag: "Known"
    readonly channel: ChannelSnap
    readonly parent: ChannelSnap | undefined
    /** Whether the member is in the thread (only read for private threads). */
    readonly threadMember: boolean
  }
  | { readonly _tag: "Unseen" }

/** Everything one resolution reads. */
export interface ResolveInput {
  readonly guild: GuildInput
  readonly channel: ChannelInput
  readonly member: MemberInput
  /** Unix milliseconds, for the timeout. */
  readonly now: number
}

/** The thread facts preflight's state checks read. */
export interface ThreadFacts {
  readonly archived: boolean
  readonly locked: boolean
  readonly creatorIsMember: boolean
  readonly memberIsInThread: boolean
}

/** One resolution. */
export interface Resolution {
  /** Stage 1. */
  readonly base: Flags.PermissionSet
  /** Stage 2 (equal to `base` for an obfuscated or unseen channel, whose overwrites are not known). */
  readonly afterOverwrites: Flags.PermissionSet
  /** After every mask but the timeout. */
  readonly beforeTimeout: Flags.PermissionSet
  /** After every mask: what the member can do. */
  readonly effective: Flags.PermissionSet
  /** The masks whose condition held, in application order. */
  readonly masks: ReadonlyArray<Mask>
  /**
   * The timeout, when its mask applied (a timeout is active and the member is neither owner nor Administrator):
   * Discord's `communication_disabled_until`.
   */
  readonly timeout: { readonly until: string } | undefined
  /** The thread's state, for threads the bot can see. */
  readonly thread: ThreadFacts | undefined
  /** Whether the channel is a voice or stage channel (Connect is View-level there, §3.2). */
  readonly voice: boolean
}

const administrator = (set: Flags.PermissionSet): boolean => Flags.has(set, "Administrator")

/** Stage 1: the member's guild-level permissions. */
export const basePermissions = (guild: GuildInput, member: MemberInput): Flags.PermissionSet => {
  if (ResolverRules.ownerHasAll.value && member.userId === guild.ownerId) return Flags.all
  let base = guild.roles.get(everyoneRoleId(guild.id))?.permissions ?? Flags.empty
  for (const roleId of member.roleIds) base = Flags.union(base, guild.roles.get(roleId)?.permissions ?? Flags.empty)
  return ResolverRules.administratorHasAll.value && administrator(base) ? Flags.all : base
}

/** Stage 2: `base` after `channel`'s overwrites for `member`. */
export const applyOverwrites = (guild: GuildInput, member: MemberInput, channel: ChannelSnap, base: Flags.PermissionSet): Flags.PermissionSet => {
  if (ResolverRules.administratorHasAll.value && administrator(base)) return Flags.all
  let permissions = base
  const everyone = channel.overwrites.find((overwrite) => overwrite.type === "role" && overwrite.id === guild.id)
  if (everyone !== undefined) permissions = Flags.applyOverwrite(permissions, everyone.allow, everyone.deny)
  let allow = Flags.empty
  let deny = Flags.empty
  const held = new Set<string>(member.roleIds)
  for (const overwrite of channel.overwrites) {
    if (overwrite.type !== "role" || overwrite.id === guild.id || !held.has(overwrite.id)) continue
    allow = Flags.union(allow, overwrite.allow)
    deny = Flags.union(deny, overwrite.deny)
  }
  permissions = Flags.applyOverwrite(permissions, allow, deny)
  const own = channel.overwrites.find((overwrite) => overwrite.type === "member" && overwrite.id === member.userId)
  if (own !== undefined) permissions = Flags.applyOverwrite(permissions, own.allow, own.deny)
  if (!ResolverRules.overwriteAdministratorGrantsNothing.value && administrator(permissions)) return Flags.all
  return permissions
}

const flagsOf = (flags: ReadonlyArray<PermissionFlag>): Flags.PermissionSet => Flags.fromFlags(flags)

/** Resolves the member's permissions in the channel. */
export const resolve = (input: ResolveInput): Resolution => {
  const { guild, member } = input
  const base = basePermissions(guild, member)
  const ownerOrAdmin = (ResolverRules.ownerHasAll.value && member.userId === guild.ownerId) || administrator(base)
  const until = member.timedOutUntil
  const timeout = until !== null && Date.parse(until) > input.now && !(ResolverRules.timeoutExemptsOwnerAndAdministrator.value && ownerOrAdmin) ? { until } : undefined

  if (input.channel._tag === "Unseen") {
    return { base, afterOverwrites: base, beforeTimeout: Flags.empty, effective: Flags.empty, masks: ["unseen"], timeout: undefined, thread: undefined, voice: false }
  }
  const { channel, parent, threadMember } = input.channel
  const thread = isThreadKind(channel.kind)
  const overwriteSource = thread ? parent : channel
  const voice = isVoiceKind(channel.kind)
  const facts: ThreadFacts | undefined =
    channel.thread === undefined
      ? undefined
      : { archived: channel.thread.archived, locked: channel.thread.locked, creatorIsMember: channel.thread.ownerId === member.userId, memberIsInThread: threadMember }

  if (ResolverRules.obfuscatedMeansNoView.value && (channel.obfuscated || (thread && parent?.obfuscated === true))) {
    return { base, afterOverwrites: base, beforeTimeout: Flags.empty, effective: Flags.empty, masks: ["obfuscated"], timeout: undefined, thread: undefined, voice }
  }
  if (overwriteSource === undefined) {
    // a thread whose parent is not known is treated as having no View (§3.1)
    return { base, afterOverwrites: base, beforeTimeout: Flags.empty, effective: Flags.empty, masks: ["unseen"], timeout: undefined, thread: undefined, voice }
  }
  const afterOverwrites = applyOverwrites(guild, member, overwriteSource, base)

  const applied: Array<Mask> = []
  let current = afterOverwrites
  const hidden =
    ResolverRules.privateThreadVisibleToMembersAndModerators.value &&
    channel.kind === "private-thread" &&
    !threadMember &&
    !Flags.has(afterOverwrites, "ManageThreads")
  if (hidden) {
    return { base, afterOverwrites, beforeTimeout: Flags.empty, effective: Flags.empty, masks: ["private-thread"], timeout: undefined, thread: facts, voice }
  }
  // An Administrator in the base already holds every flag, so no implicit mask's condition can hold for it;
  // an Administrator bit from an overwrite exempts nothing (H-004).
  if (ResolverRules.noViewMasksEverything.value && !Flags.has(current, "ViewChannel")) {
    applied.push("implicit-view")
    current = Flags.empty
  } else {
    if (!Flags.has(current, "SendMessages") && (!thread || ResolverRules.noSendMasksInThreads.value)) {
      applied.push("implicit-send")
      current = Flags.minus(current, flagsOf(ResolverRules.noSendMasks.value))
    }
    if (voice && !Flags.has(current, "Connect")) {
      applied.push("implicit-connect")
      current = Flags.minus(current, flagsOf(ResolverRules.noConnectMasks.value))
    }
  }
  const beforeTimeout = current
  if (timeout !== undefined) {
    applied.push("timeout")
    current = Flags.intersect(current, flagsOf(ResolverRules.timeoutKeeps.value))
  }
  return { base, afterOverwrites, beforeTimeout, effective: current, masks: applied, timeout, thread: facts, voice }
}

// ---- hierarchy (H-060..H-073) -------------------------------------------------------------------------

/** A role's rank: position, then ID as the tie-break (a lower ID ranks higher at equal positions). */
const outranks = (a: RoleSnap, b: RoleSnap): boolean => a.position > b.position || (a.position === b.position && BigInt(a.id) < BigInt(b.id))

/** A member's highest role, or `undefined` when it holds none (then `@everyone`, position 0, is its top). */
export const highestRole = (guild: GuildInput, roleIds: ReadonlyArray<RoleId>): RoleSnap | undefined => {
  let top: RoleSnap | undefined
  for (const id of roleIds) {
    const role = guild.roles.get(id)
    if (role !== undefined && (top === undefined || outranks(role, top))) top = role
  }
  return top
}

/**
 * Whether the bot's highest role is strictly above the target's (setNickname, timeout, kick, ban; H-064). Both
 * bots' managed roles count, because they are among the members' roles (H-073). The owner is never below.
 */
export const targetBelow = (guild: GuildInput, bot: MemberInput, target: MemberInput): boolean => {
  if (target.userId === guild.ownerId) return false
  if (bot.userId === guild.ownerId) return true
  const botTop = highestRole(guild, bot.roleIds)
  if (botTop === undefined) return false
  const targetTop = highestRole(guild, target.roleIds)
  return targetTop === undefined || outranks(botTop, targetTop)
}

/**
 * Whether `role` is strictly below the bot's highest role (addRole, removeRole; H-060). The target's rank is not
 * consulted (H-061, `ResolverRules.roleAssignmentIgnoresTargetRank`).
 */
export const roleBelow = (guild: GuildInput, bot: MemberInput, role: RoleSnap): boolean => {
  if (bot.userId === guild.ownerId) return true
  const botTop = highestRole(guild, bot.roleIds)
  return botTop !== undefined && outranks(botTop, role)
}
