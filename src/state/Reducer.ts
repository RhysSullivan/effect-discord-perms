/**
 * The gateway reducer (DESIGN §4.5, D15, C5): `(Snapshot, dispatch) -> Snapshot`, pure. `Hook.ts` runs it for
 * every dispatch, before dfx publishes the dispatch to subscribers, so the state cannot miss GUILD_CREATE.
 *
 * - Payloads are decoded with minimal schemas: only the fields the resolver reads. A payload that does not
 *   decode leaves the state as it was, marks its guild `stale`, and is returned as a problem for the hook to
 *   log; the reducer never throws, because a failing hook makes dfx reconnect.
 * - GUILD_CREATE's channels and threads carry no `guild_id`; the guild's ID is stamped from the dispatch.
 * - A channel with flag `1 << 17` is obfuscated (H-160): stored with `obfuscated: true` and its fake overwrite
 *   dropped.
 * - The bot's own member comes from GUILD_CREATE's `members` (filtered to the bot, H-177) and from
 *   GUILD_MEMBER_UPDATE about the bot (sent even without GuildMembers, H-175).
 * - The bot's thread membership comes from THREAD_MEMBERS_UPDATE (always sent when the bot is added or
 *   removed), THREAD_MEMBER_UPDATE, and the `member` field of thread objects. A private thread the bot is
 *   removed from is dropped: Discord sends no further events for it (threads.mdx), so the entry would only go
 *   stale, and a refresh brings it back if the bot can still see it.
 * - A role created, updated or deleted, a guild update and the bot's member update retire every `unseen` mark
 *   (a refresh's 50001 or 10003); a channel or thread event, THREAD_LIST_SYNC included, retires its channel's.
 * - Every dispatch that touches an entity bumps its generation. Each entity's value is a function of the
 *   dispatch alone, so a replay after RESUME (dfx delivers at least once) leaves every value unchanged.
 */
import { Option, Schema } from "effect"
import * as Flags from "../permissions/Flags.ts"
import * as Schemas from "../rest/Schemas.ts"
import { ChannelId, GuildId, RoleId, UserId } from "../Snowflake.ts"
import {
  type BotMember,
  type ChannelSnap,
  type EntityKey,
  entityKey,
  type GuildSnap,
  isThreadKind,
  kindOfType,
  type Overwrite,
  type RoleSnap,
  type Snapshot
} from "./Snapshot.ts"

// ---- dispatch schemas, over the shared object schemas (`rest/Schemas.ts`, §4.11) -------------------------

const Ready = Schema.Struct({ user: Schema.Struct({ id: UserId }) })
const GuildCreate = Schema.Struct({
  id: GuildId,
  owner_id: UserId,
  roles: Schema.Array(Schemas.Role),
  channels: Schema.Array(Schemas.Channel),
  threads: Schema.Array(Schemas.Channel),
  members: Schema.Array(Schemas.Member)
})
const Unavailable = Schema.Struct({ id: GuildId, unavailable: Schema.Literal(true) })
const GuildUpdate = Schemas.Guild
const GuildDelete = Schema.Struct({ id: GuildId })
const RoleEvent = Schema.Struct({ guild_id: GuildId, role: Schemas.Role })
const RoleDelete = Schema.Struct({ guild_id: GuildId, role_id: RoleId })
const GuildChannel = Schema.Struct({ ...Schemas.Channel.fields, guild_id: GuildId })
const ThreadDelete = Schema.Struct({ id: ChannelId, guild_id: GuildId })
const ThreadListSync = Schema.Struct({
  guild_id: GuildId,
  channel_ids: Schema.optionalKey(Schema.Array(ChannelId)),
  threads: Schema.Array(Schemas.Channel),
  members: Schema.Array(Schema.Struct({ id: ChannelId }))
})
const ThreadMembersUpdate = Schema.Struct({
  id: ChannelId,
  guild_id: GuildId,
  added_members: Schema.optionalKey(Schema.Array(Schema.Struct({ user_id: UserId }))),
  removed_member_ids: Schema.optionalKey(Schema.Array(UserId))
})
const ThreadMemberUpdate = Schema.Struct({ id: ChannelId, guild_id: GuildId, user_id: UserId })
const MemberUpdate = Schema.Struct({ ...Schemas.Member.fields, guild_id: GuildId })
const GuildIdOnly = Schema.Struct({ guild_id: GuildId })
const IdOnly = Schema.Struct({ id: GuildId })

// ---- conversions --------------------------------------------------------------------------------------

/** The channel flag Discord sets on a channel the bot cannot view (H-160). */
export const obfuscatedFlag = 1 << 17

/** The channel flag that makes a forum or media channel's posts require a tag (H-044). */
export const requireTagFlag = 1 << 4

const bits = (decimal: string): Flags.PermissionSet => Flags.fromBits(BigInt(decimal))

/** A wire role as a snapshot role. */
export const toRole = (role: Schemas.Role): RoleSnap => ({ id: role.id, permissions: bits(role.permissions), position: role.position, managed: role.managed })

/** What a wire channel becomes: a snapshot channel, nothing (a kind the library does not model), or a problem. */
export type Converted =
  | { readonly _tag: "Channel"; readonly channel: ChannelSnap }
  | { readonly _tag: "Unmodelled" }
  | { readonly _tag: "Malformed"; readonly reason: string }

/** A wire channel as a snapshot channel. A thread without `thread_metadata` is malformed. */
export const toChannel = (channel: Schemas.Channel): Converted => {
  const kind = kindOfType(channel.type)
  if (kind === undefined) return { _tag: "Unmodelled" }
  const obfuscated = ((channel.flags ?? 0) & obfuscatedFlag) !== 0
  const overwrites: ReadonlyArray<Overwrite> = obfuscated
    ? []
    : (channel.permission_overwrites ?? []).map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type === 0 ? "role" : "member",
      allow: bits(overwrite.allow),
      deny: bits(overwrite.deny)
    }))
  const metadata = channel.thread_metadata
  if (isThreadKind(kind) && metadata === undefined) return { _tag: "Malformed", reason: `thread ${channel.id} has no thread_metadata` }
  return {
    _tag: "Channel",
    channel: {
      id: channel.id,
      kind,
      parentId: channel.parent_id ?? undefined,
      obfuscated,
      overwrites,
      thread: isThreadKind(kind) && metadata !== undefined ? { archived: metadata.archived, locked: metadata.locked, ownerId: channel.owner_id } : undefined,
      requireTag: (kind === "forum" || kind === "media") && ((channel.flags ?? 0) & requireTagFlag) !== 0
    }
  }
}

/** A wire member as the bot's member (`communication_disabled_until` is absent when never set). */
export const toBotMember = (member: Schemas.Member): BotMember => ({ roleIds: member.roles, timedOutUntil: member.communication_disabled_until ?? null })

// ---- the reducer --------------------------------------------------------------------------------------

/** What one dispatch did: the new snapshot, and a problem to log when the payload did not decode. */
export interface Reduced {
  readonly snapshot: Snapshot
  readonly problem: string | undefined
}

const bump = (generations: ReadonlyMap<EntityKey, number>, keys: Iterable<EntityKey>): ReadonlyMap<EntityKey, number> => {
  const next = new Map(generations)
  for (const key of keys) next.set(key, (next.get(key) ?? 0) + 1)
  return next
}

const withGuild = (snapshot: Snapshot, guild: GuildSnap): Snapshot => ({ ...snapshot, guilds: new Map(snapshot.guilds).set(guild.id, guild) })

const touch = (snapshot: Snapshot, guildId: GuildId, keys: ReadonlyArray<EntityKey>, edit: (guild: GuildSnap) => Omit<GuildSnap, "generations">): Snapshot => {
  const guild = snapshot.guilds.get(guildId)
  if (guild === undefined) return snapshot
  return withGuild(snapshot, { ...edit(guild), generations: bump(guild.generations, keys), stale: false })
}

const setChannel = (guild: GuildSnap, channel: ChannelSnap): ReadonlyMap<ChannelId, ChannelSnap> => new Map(guild.channels).set(channel.id, channel)

const withoutChannel = (guild: GuildSnap, id: ChannelId): Pick<GuildSnap, "channels" | "threadMembership"> => {
  const channels = new Map(guild.channels)
  channels.delete(id)
  const threadMembership = new Map(guild.threadMembership)
  threadMembership.delete(id)
  return { channels, threadMembership }
}

/**
 * An unseen mark (a refresh's 50001 or 10003) is evidence about the bot's permissions when it was read. A role
 * created, updated or deleted, a guild update, or the bot's member update can change what the bot sees in every
 * channel, and Discord sends no channel event for that (M6 live: a role change granting View brought no CHANNEL_UPDATE),
 * so they retire every mark. A guild channel then resolves from the gateway's copy, a thread is refreshed again.
 */
const noUnseen: ReadonlySet<ChannelId> = new Set()

const withoutUnseen = (guild: GuildSnap, id: ChannelId): ReadonlySet<ChannelId> => {
  if (!guild.unseen.has(id)) return guild.unseen
  const unseen = new Set(guild.unseen)
  unseen.delete(id)
  return unseen
}

const decode = <S extends Schema.Codec<unknown, unknown>>(schema: S, data: unknown): Option.Option<S["Type"]> => Schema.decodeUnknownOption(schema)(data)

const markStale = (snapshot: Snapshot, data: unknown): Snapshot => {
  const id = Option.orElse(
    Option.map(decode(GuildIdOnly, data), (value) => value.guild_id),
    () => Option.map(decode(IdOnly, data), (value) => value.id)
  )
  if (Option.isNone(id)) return snapshot
  const guild = snapshot.guilds.get(id.value)
  return guild === undefined ? snapshot : withGuild(snapshot, { ...guild, stale: true })
}

/** Converts every wire channel, or names the first malformed one. */
const convertAll = (wires: ReadonlyArray<Schemas.Channel>): { readonly _tag: "Ok"; readonly channels: ReadonlyArray<readonly [ChannelSnap, Schemas.Channel]> } | { readonly _tag: "Malformed"; readonly reason: string } => {
  const channels: Array<readonly [ChannelSnap, Schemas.Channel]> = []
  for (const wire of wires) {
    const converted = toChannel(wire)
    if (converted._tag === "Malformed") return converted
    if (converted._tag === "Channel") channels.push([converted.channel, wire])
  }
  return { _tag: "Ok", channels }
}

const guildCreate = (snapshot: Snapshot, value: typeof GuildCreate.Type, converted: ReadonlyArray<readonly [ChannelSnap, Schemas.Channel]>): Snapshot => {
  const previous = snapshot.guilds.get(value.id)
  const roles = new Map(value.roles.map((role) => [role.id, toRole(role)] as const))
  const channels = new Map<ChannelId, ChannelSnap>()
  const threadMembership = new Map<ChannelId, boolean>()
  for (const [channel, wire] of converted) {
    channels.set(channel.id, channel)
    if (channel.thread !== undefined) threadMembership.set(channel.id, wire.member !== undefined)
  }
  const bot = snapshot.botUserId === undefined ? undefined : value.members.find((member) => member.user.id === snapshot.botUserId)
  const keys: Array<EntityKey> = [entityKey.guild, entityKey.member, ...[...roles.keys()].map(entityKey.role), ...[...channels.keys()].map(entityKey.channel)]
  return withGuild(snapshot, {
    id: value.id,
    ownerId: value.owner_id,
    stale: false,
    roles,
    channels,
    unseen: new Set(),
    threadMembership,
    botMember: bot === undefined ? previous?.botMember : toBotMember(bot),
    generations: bump(previous?.generations ?? new Map(), keys)
  })
}

/**
 * Stores a channel from a CHANNEL_ or THREAD_ event. A thread event carries the bot's thread member object only
 * sometimes (THREAD_CREATE when the bot recently gained access, threads.mdx), so its presence sets membership
 * and its absence changes nothing; THREAD_MEMBERS_UPDATE is the authority.
 */
const upsertChannel = (snapshot: Snapshot, wire: Schemas.Channel & { readonly guild_id: GuildId }, channel: ChannelSnap): Snapshot =>
  touch(snapshot, wire.guild_id, [entityKey.channel(channel.id)], (guild) => {
    const threadMembership = new Map(guild.threadMembership)
    if (channel.thread !== undefined && wire.member !== undefined) threadMembership.set(channel.id, true)
    return { ...guild, channels: setChannel(guild, channel), unseen: withoutUnseen(guild, channel.id), threadMembership }
  })

/** Applies one dispatch (event name and payload) to the snapshot. Never throws. */
export const reduce = (snapshot: Snapshot, event: string, data: unknown): Reduced => {
  const ok = (next: Snapshot): Reduced => ({ snapshot: next, problem: undefined })
  const malformed = (reason: string): Reduced => ({ snapshot: markStale(snapshot, data), problem: `${event}: ${reason}` })
  const decodeOr = <S extends Schema.Codec<unknown, unknown>>(schema: S, apply: (value: S["Type"]) => Snapshot | Reduced): Reduced =>
    Option.match(decode(schema, data), {
      onNone: () => malformed("the payload did not decode"),
      onSome: (value) => {
        const next = apply(value)
        return "problem" in next ? next : ok(next)
      }
    })
  const withChannel = (wire: Schemas.Channel & { readonly guild_id: GuildId }): Snapshot | Reduced => {
    const converted = toChannel(wire)
    switch (converted._tag) {
      case "Malformed":
        return malformed(converted.reason)
      case "Unmodelled":
        return snapshot
      case "Channel":
        return upsertChannel(snapshot, wire, converted.channel)
    }
  }
  switch (event) {
    case "READY":
      return decodeOr(Ready, (value) => ({ ...snapshot, botUserId: value.user.id }))
    case "GUILD_CREATE":
      if (Option.isSome(decode(Unavailable, data))) return ok(snapshot)
      return decodeOr(GuildCreate, (value) => {
        const converted = convertAll([...value.channels, ...value.threads])
        return converted._tag === "Malformed" ? malformed(converted.reason) : guildCreate(snapshot, value, converted.channels)
      })
    case "GUILD_UPDATE":
      return decodeOr(GuildUpdate, (value) =>
        touch(snapshot, value.id, [entityKey.guild, ...value.roles.map((role) => entityKey.role(role.id))], (guild) => ({
          ...guild,
          ownerId: value.owner_id,
          roles: new Map(value.roles.map((role) => [role.id, toRole(role)] as const)),
          unseen: noUnseen
        })))
    case "GUILD_DELETE":
      return decodeOr(GuildDelete, (value) => {
        const guilds = new Map(snapshot.guilds)
        guilds.delete(value.id)
        return { ...snapshot, guilds }
      })
    case "GUILD_ROLE_CREATE":
    case "GUILD_ROLE_UPDATE":
      return decodeOr(RoleEvent, (value) =>
        touch(snapshot, value.guild_id, [entityKey.role(value.role.id)], (guild) => ({ ...guild, roles: new Map(guild.roles).set(value.role.id, toRole(value.role)), unseen: noUnseen })))
    case "GUILD_ROLE_DELETE":
      return decodeOr(RoleDelete, (value) =>
        touch(snapshot, value.guild_id, [entityKey.role(value.role_id)], (guild) => {
          const roles = new Map(guild.roles)
          roles.delete(value.role_id)
          return { ...guild, roles, unseen: noUnseen }
        }))
    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE":
      // a DM channel has no guild_id and is not guild state
      if (Option.isNone(decode(GuildIdOnly, data))) return ok(snapshot)
      return decodeOr(GuildChannel, (value) => withChannel(value))
    case "THREAD_CREATE":
    case "THREAD_UPDATE":
      return decodeOr(GuildChannel, (value) => withChannel(value))
    case "CHANNEL_DELETE":
      if (Option.isNone(decode(GuildIdOnly, data))) return ok(snapshot)
      return decodeOr(GuildChannel, (value) =>
        touch(snapshot, value.guild_id, [entityKey.channel(value.id)], (guild) => ({ ...guild, ...withoutChannel(guild, value.id) })))
    case "THREAD_DELETE":
      return decodeOr(ThreadDelete, (value) =>
        touch(snapshot, value.guild_id, [entityKey.channel(value.id)], (guild) => ({ ...guild, ...withoutChannel(guild, value.id) })))
    case "THREAD_LIST_SYNC":
      return decodeOr(ThreadListSync, (value) => {
        const guild = snapshot.guilds.get(value.guild_id)
        if (guild === undefined) return snapshot
        const synced = value.channel_ids === undefined ? undefined : new Set<string>(value.channel_ids)
        const cleared = [...guild.channels.values()].filter(
          (channel) => channel.thread !== undefined && !channel.thread.archived && (synced === undefined || (channel.parentId !== undefined && synced.has(channel.parentId)))
        )
        const converted = convertAll(value.threads)
        if (converted._tag === "Malformed") return malformed(converted.reason)
        const incoming = converted.channels.map(([channel]) => channel)
        const members = new Set<string>(value.members.map((member) => member.id))
        const keys = [...cleared.map((channel) => entityKey.channel(channel.id)), ...incoming.map((channel) => entityKey.channel(channel.id))]
        return touch(snapshot, value.guild_id, keys, (current) => {
          const channels = new Map(current.channels)
          const threadMembership = new Map(current.threadMembership)
          const unseen = new Set(current.unseen)
          for (const channel of cleared) {
            channels.delete(channel.id)
            threadMembership.delete(channel.id)
          }
          for (const channel of incoming) {
            channels.set(channel.id, channel)
            threadMembership.set(channel.id, members.has(channel.id))
            unseen.delete(channel.id)
          }
          return { ...current, channels, threadMembership, unseen }
        })
      })
    case "THREAD_MEMBERS_UPDATE":
      return decodeOr(ThreadMembersUpdate, (value) => {
        const bot = snapshot.botUserId
        if (bot === undefined) return snapshot
        const added = (value.added_members ?? []).some((member) => member.user_id === bot)
        const removed = (value.removed_member_ids ?? []).includes(bot)
        if (!added && !removed) return snapshot
        return touch(snapshot, value.guild_id, [entityKey.channel(value.id)], (guild) => {
          const thread = guild.channels.get(value.id)
          // removed from a private thread (or one the state does not hold): nothing more will arrive for it
          if (removed && (thread === undefined || thread.kind === "private-thread")) return { ...guild, ...withoutChannel(guild, value.id) }
          return { ...guild, threadMembership: new Map(guild.threadMembership).set(value.id, added) }
        })
      })
    case "THREAD_MEMBER_UPDATE":
      return decodeOr(ThreadMemberUpdate, (value) =>
        value.user_id !== snapshot.botUserId
          ? snapshot
          : touch(snapshot, value.guild_id, [entityKey.channel(value.id)], (guild) => ({ ...guild, threadMembership: new Map(guild.threadMembership).set(value.id, true) })))
    case "GUILD_MEMBER_UPDATE":
      return decodeOr(MemberUpdate, (value) =>
        value.user.id !== snapshot.botUserId
          ? snapshot
          : touch(snapshot, value.guild_id, [entityKey.member], (guild) => ({ ...guild, botMember: toBotMember(value), unseen: noUnseen })))
    default:
      return ok(snapshot)
  }
}
