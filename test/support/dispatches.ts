/**
 * Gateway dispatch payloads in the shapes Discord sends them (gateway-events.mdx, with the extra fields the
 * reducer ignores), for the state tests and the fake gateway. Fake snowflakes; test-only.
 */
export const ids = {
  guild: "100000000000000000",
  owner: "200000000000000099",
  bot: "200000000000000001",
  target: "200000000000000002",
  roleA: "400000000000000001",
  roleB: "400000000000000002",
  managed: "400000000000000009",
  category: "300000000000000000",
  text: "300000000000000001",
  voice: "300000000000000003",
  publicThread: "300000000000000011",
  privateThread: "300000000000000012"
} as const

const overwrite = (id: string, type: 0 | 1, allow: string, deny: string) => ({ id, type, allow, deny })

/** A role object. */
export const role = (id: string, permissions: string, position: number, managed = false) => ({
  id,
  name: `role-${id.slice(-2)}`,
  color: 0,
  colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
  hoist: false,
  icon: null,
  unicode_emoji: null,
  position,
  permissions,
  managed,
  mentionable: false,
  flags: 0,
  ...(managed ? { tags: { bot_id: ids.bot } } : {})
})

/** A guild channel object as GUILD_CREATE lists it: no `guild_id`. */
export const channel = (id: string, type: number, parent: string | null, overwrites: ReadonlyArray<ReturnType<typeof overwrite>>, flags = 0) => ({
  id,
  type,
  name: `lab-${id.slice(-2)}`,
  position: 0,
  parent_id: parent,
  permission_overwrites: overwrites,
  flags,
  rate_limit_per_user: 0,
  nsfw: false,
  topic: null,
  last_message_id: null
})

/** A thread object; `member` is the bot's thread member object, present when the bot is a member. */
export const threadObject = (id: string, type: 11 | 12, options: { readonly archived?: boolean; readonly locked?: boolean; readonly member?: boolean } = {}) => ({
  id,
  type,
  guild_id: ids.guild,
  parent_id: ids.text,
  owner_id: ids.target,
  name: `lab-thread-${id.slice(-2)}`,
  last_message_id: null,
  rate_limit_per_user: 0,
  flags: 0,
  member_count: 1,
  message_count: 0,
  total_message_sent: 0,
  thread_metadata: {
    archived: options.archived ?? false,
    auto_archive_duration: 10080,
    archive_timestamp: "2026-11-01T10:00:00.000000+00:00",
    locked: options.locked ?? false,
    create_timestamp: "2026-11-01T10:00:00.000000+00:00"
  },
  ...(options.member === true ? { member: { id, user_id: ids.bot, join_timestamp: "2026-11-01T10:00:00.000000+00:00", flags: 1 } } : {})
})

/** A member object. */
export const memberObject = (user: string, roles: ReadonlyArray<string>, timedOutUntil: string | null = null) => ({
  user: { id: user, username: `user-${user.slice(-2)}`, discriminator: "0", global_name: null, avatar: null, bot: true },
  roles,
  nick: null,
  avatar: null,
  joined_at: "2026-10-30T10:00:00.000000+00:00",
  premium_since: null,
  deaf: false,
  mute: false,
  flags: 0,
  pending: false,
  communication_disabled_until: timedOutUntil
})

/** READY for the bot. */
export const ready = {
  v: 10,
  user: { id: ids.bot, username: "Perms Subject", discriminator: "0", global_name: null, avatar: null, bot: true },
  guilds: [{ id: ids.guild, unavailable: true }],
  session_id: "fake-session",
  resume_gateway_url: "wss://gateway.invalid",
  application: { id: "100000000000000002", flags: 0 }
}

/** GUILD_CREATE for the test guild: @everyone and two roles, a category, a text and a voice channel, two threads. */
export const guildCreate = {
  id: ids.guild,
  name: "Perms Lab",
  owner_id: ids.owner,
  mfa_level: 0,
  unavailable: false,
  member_count: 4,
  large: false,
  joined_at: "2026-10-30T10:00:00.000000+00:00",
  roles: [role(ids.guild, "3072", 0), role(ids.roleA, "16384", 2), role(ids.roleB, "0", 1), role(ids.managed, "0", 3, true)],
  channels: [
    channel(ids.category, 4, null, []),
    channel(ids.text, 0, ids.category, [overwrite(ids.guild, 0, "0", "2048"), overwrite(ids.bot, 1, "2048", "0")]),
    channel(ids.voice, 2, ids.category, [])
  ],
  threads: [threadObject(ids.publicThread, 11), threadObject(ids.privateThread, 12, { member: true })],
  members: [memberObject(ids.bot, [ids.roleA, ids.managed])],
  voice_states: [],
  presences: [],
  stage_instances: [],
  guild_scheduled_events: [],
  soundboard_sounds: [],
  emojis: [],
  stickers: [],
  features: ["COMMUNITY"]
}

/** CHANNEL_UPDATE for `id` with these overwrites (and `guild_id`, which channel events carry). */
export const channelUpdate = (id: string, type: number, overwrites: ReadonlyArray<ReturnType<typeof overwrite>>, flags = 0) => ({
  ...channel(id, type, ids.category, overwrites, flags),
  guild_id: ids.guild
})

export { overwrite }
