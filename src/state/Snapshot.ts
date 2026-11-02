/**
 * What the library knows of the guilds it is in (DESIGN §4.5): the value `GuildState` holds, which the
 * `DispatchHook` reducer (`Reducer.ts`) and the REST refresh (`GuildState.refresh`) write and the resolver reads.
 *
 * Everything is immutable. Every entity a dispatch touches gets a new generation in `generations`, keyed by
 * {@link entityKey}; a refresh commits only the entities whose generation did not move while its REST reads
 * were in flight, so a newer gateway update always wins (E11). Generations are never removed, so a deleted
 * entity keeps a generation too.
 */
import type { PermissionSet } from "../permissions/Flags.ts"
import { type ChannelId, type GuildId, RoleId, type UserId } from "../Snowflake.ts"

/** A thread kind. */
export type ThreadKind = "public-thread" | "private-thread" | "announcement-thread"

/** The guild channel kinds the library models (channel types 0, 2, 4, 5, 10-13, 15, 16). */
export type ChannelKind = "text" | "announcement" | "voice" | "stage" | "category" | "forum" | "media" | ThreadKind

/** Discord's channel `type` for each kind (channel.mdx "Channel Types"). */
export const channelTypes: { readonly [K in ChannelKind]: number } = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  "announcement-thread": 10,
  "public-thread": 11,
  "private-thread": 12,
  stage: 13,
  forum: 15,
  media: 16
}

/** The kind of a guild channel `type`, or `undefined` for one the library does not model (directories, DMs). */
export const kindOfType = (type: number): ChannelKind | undefined => {
  switch (type) {
    case 0:
      return "text"
    case 2:
      return "voice"
    case 4:
      return "category"
    case 5:
      return "announcement"
    case 10:
      return "announcement-thread"
    case 11:
      return "public-thread"
    case 12:
      return "private-thread"
    case 13:
      return "stage"
    case 15:
      return "forum"
    case 16:
      return "media"
    default:
      return undefined
  }
}

/** Whether a kind is a thread. */
export const isThreadKind = (kind: ChannelKind): kind is ThreadKind => kind === "public-thread" || kind === "private-thread" || kind === "announcement-thread"

/** Whether a kind is a voice or stage channel (its text chat needs Connect, H-152, H-153). */
export const isVoiceKind = (kind: ChannelKind): boolean => kind === "voice" || kind === "stage"

/** A channel permission overwrite. */
export interface Overwrite {
  /** A role ID (the guild ID for `@everyone`) or a user ID. */
  readonly id: string
  readonly type: "role" | "member"
  readonly allow: PermissionSet
  readonly deny: PermissionSet
}

/** A thread's state. */
export interface ThreadMeta {
  readonly archived: boolean
  readonly locked: boolean
  /** The thread's creator. */
  readonly ownerId: UserId | undefined
}

/** A channel or thread. */
export interface ChannelSnap {
  readonly id: ChannelId
  readonly kind: ChannelKind
  readonly parentId: ChannelId | undefined
  /**
   * Discord delivered the channel obfuscated (flag `1 << 17`): the bot cannot view it, and its overwrites were
   * replaced by a fake one, which is dropped (§4.5, H-160).
   */
  readonly obfuscated: boolean
  readonly overwrites: ReadonlyArray<Overwrite>
  readonly thread: ThreadMeta | undefined
  /** A forum or media channel whose posts must carry a tag (channel flag `REQUIRE_TAG`, `1 << 4`; H-044). */
  readonly requireTag: boolean
}

/** A role. */
export interface RoleSnap {
  readonly id: RoleId
  readonly permissions: PermissionSet
  readonly position: number
  readonly managed: boolean
}

/** The bot's own member in the guild. */
export interface BotMember {
  readonly roleIds: ReadonlyArray<RoleId>
  /** Discord's `communication_disabled_until` (ISO 8601), or `null` when never timed out. */
  readonly timedOutUntil: string | null
}

/** One guild. */
export interface GuildSnap {
  readonly id: GuildId
  readonly ownerId: UserId
  /** A dispatch about this guild failed to decode, so some entity may be out of date until a refresh. */
  readonly stale: boolean
  readonly roles: ReadonlyMap<RoleId, RoleSnap>
  readonly channels: ReadonlyMap<ChannelId, ChannelSnap>
  /**
   * Channels a refresh could not fetch (50001 or 10003): the bot cannot see them, which is evidence of no
   * View, not a defect (§3.1, §4.5).
   */
  readonly unseen: ReadonlySet<ChannelId>
  /**
   * The bot's membership of threads, from THREAD_MEMBERS_UPDATE (always sent when the bot is added or removed,
   * threads.mdx) and the `member` field of thread objects. Kept apart from the thread entries, because the
   * membership event may arrive before the thread itself.
   */
  readonly threadMembership: ReadonlyMap<ChannelId, boolean>
  readonly botMember: BotMember | undefined
  /** Each entity's generation, by {@link entityKey}. */
  readonly generations: ReadonlyMap<EntityKey, number>
}

/** Everything the library knows. */
export interface Snapshot {
  /** The bot's user ID, from READY. */
  readonly botUserId: UserId | undefined
  readonly guilds: ReadonlyMap<GuildId, GuildSnap>
}

/** The key of one versioned entity of a guild. */
export type EntityKey = "guild" | "member" | `role:${string}` | `channel:${string}`

/** The key of the guild itself (owner), its bot member, a role or a channel. */
export const entityKey = {
  guild: "guild" as const,
  member: "member" as const,
  role: (id: string): EntityKey => `role:${id}`,
  channel: (id: string): EntityKey => `channel:${id}`
}

/** The empty snapshot. */
export const emptySnapshot: Snapshot = { botUserId: undefined, guilds: new Map() }

/** An entity's generation (0 if no dispatch has touched it). */
export const generationOf = (guild: GuildSnap, key: EntityKey): number => guild.generations.get(key) ?? 0

/** Whether the bot is a member of `thread`, as far as the guild snapshot knows. */
export const botIsThreadMember = (guild: GuildSnap, thread: ChannelId): boolean => guild.threadMembership.get(thread) === true

/** `@everyone`'s role ID, which is the guild's ID (H-001). */
export const everyoneRoleId = (guild: GuildId): RoleId => RoleId.make(guild)
