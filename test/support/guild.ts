/**
 * Builders for resolver inputs and snapshot entities, with fake snowflakes. Test-only.
 */
import type { PermissionFlag } from "../../src/errors/Missing.generated.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import type { ChannelInput, GuildInput, MemberInput } from "../../src/permissions/Resolver.ts"
import type { ChannelKind, ChannelSnap, Overwrite, RoleSnap } from "../../src/state/Snapshot.ts"
import { ChannelId, GuildId, RoleId, UserId } from "../../src/Snowflake.ts"

export const guildId = GuildId.make("100000000000000000")
export const ownerId = UserId.make("200000000000000099")
export const botId = UserId.make("200000000000000001")
export const otherId = UserId.make("200000000000000002")
export const everyone = RoleId.make(guildId)
export const roleA = RoleId.make("400000000000000001")
export const roleB = RoleId.make("400000000000000002")
export const roleC = RoleId.make("400000000000000003")
export const textId = ChannelId.make("300000000000000001")
export const threadId = ChannelId.make("300000000000000002")
export const voiceId = ChannelId.make("300000000000000003")

export const set = (...flags: ReadonlyArray<PermissionFlag>): Flags.PermissionSet => Flags.fromFlags(flags)

export const role = (id: RoleId, permissions: Flags.PermissionSet, position = 1, managed = false): RoleSnap => ({ id, permissions, position, managed })

export const guild = (roles: ReadonlyArray<RoleSnap>): GuildInput => ({ id: guildId, ownerId, roles: new Map(roles.map((entry) => [entry.id, entry])) })

export const member = (roleIds: ReadonlyArray<RoleId>, timedOutUntil: string | null = null, userId: UserId = botId): MemberInput => ({ userId, roleIds, timedOutUntil })

export const roleOverwrite = (id: string, allow: Flags.PermissionSet, deny: Flags.PermissionSet = Flags.empty): Overwrite => ({ id, type: "role", allow, deny })
export const memberOverwrite = (id: string, allow: Flags.PermissionSet, deny: Flags.PermissionSet = Flags.empty): Overwrite => ({ id, type: "member", allow, deny })

export const channel = (kind: ChannelKind, overwrites: ReadonlyArray<Overwrite> = [], options: Partial<ChannelSnap> = {}): ChannelSnap => ({
  id: kind === "voice" || kind === "stage" ? voiceId : textId,
  kind,
  parentId: undefined,
  obfuscated: false,
  overwrites,
  thread: undefined,
  requireTag: false,
  ...options
})

export const thread = (kind: "public-thread" | "private-thread" | "announcement-thread", meta: Partial<NonNullable<ChannelSnap["thread"]>> = {}): ChannelSnap => ({
  id: threadId,
  kind,
  parentId: textId,
  obfuscated: false,
  overwrites: [],
  thread: { archived: false, locked: false, ownerId: otherId, ...meta },
  requireTag: false
})

export const known = (target: ChannelSnap, parent?: ChannelSnap, threadMember = false): ChannelInput => ({ _tag: "Known", channel: target, parent, threadMember })

export const now = Date.parse("2026-11-01T12:00:00Z")
export const later = new Date(now + 10 * 60_000).toISOString()
export const earlier = new Date(now - 60_000).toISOString()
