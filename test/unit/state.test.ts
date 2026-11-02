import { describe, expect, it } from "@effect/vitest"
import type { DiscordRestService } from "dfx/DiscordREST"
import { DiscordREST } from "dfx/DiscordREST"
import { Deferred, Duration, Effect, Fiber, Layer, Option } from "effect"
import * as Flags from "../../src/permissions/Flags.ts"
import * as GuildState from "../../src/state/GuildState.ts"
import { reduce } from "../../src/state/Reducer.ts"
import { botIsThreadMember, emptySnapshot, entityKey, generationOf, type GuildSnap, type Snapshot } from "../../src/state/Snapshot.ts"
import { ChannelId, GuildId, RoleId, UserId } from "../../src/Snowflake.ts"
import { channelUpdate, guildCreate, ids, memberObject, overwrite, ready, role, threadObject } from "../support/dispatches.ts"
import { json, type Scripted, scriptedRestEffect } from "../support/fakeDiscord.ts"

/**
 * The guild state (DESIGN §4.5): the reducer over dispatches in Discord's recorded shapes, idempotent under
 * replay, and the refresh that never overwrites a newer gateway update (E11).
 */
const guildId = GuildId.make(ids.guild)
const text = ChannelId.make(ids.text)
const privateThread = ChannelId.make(ids.privateThread)

const run = (events: ReadonlyArray<readonly [string, unknown]>, from: Snapshot = emptySnapshot) =>
  events.reduce<{ snapshot: Snapshot; problems: Array<string> }>(
    (acc, [event, data]) => {
      const reduced = reduce(acc.snapshot, event, data)
      return { snapshot: reduced.snapshot, problems: reduced.problem === undefined ? acc.problems : [...acc.problems, reduced.problem] }
    },
    { snapshot: from, problems: [] }
  )
const guildOf = (snapshot: Snapshot): GuildSnap => {
  const guild = snapshot.guilds.get(guildId)
  if (guild === undefined) throw new Error("no guild")
  return guild
}
const booted = run([["READY", ready], ["GUILD_CREATE", guildCreate]])
/** The snapshot's values without generations, for comparing what a replay leaves. */
const values = (guild: GuildSnap) => ({ ...guild, generations: undefined })

describe("the reducer", () => {
  it("stores GUILD_CREATE with the guild ID stamped, owner, roles, channels, threads, thread membership and the bot member", () => {
    expect(booted.problems).toEqual([])
    expect(booted.snapshot.botUserId).toBe(ids.bot)
    const guild = guildOf(booted.snapshot)
    expect(guild.ownerId).toBe(ids.owner)
    expect(Flags.toSortedNames(guild.roles.get(RoleId.make(ids.guild))?.permissions ?? Flags.empty)).toEqual(["SendMessages", "ViewChannel"])
    expect(guild.roles.get(RoleId.make(ids.managed))?.managed).toBe(true)
    expect([...guild.channels.keys()].sort()).toEqual([ids.category, ids.text, ids.voice, ids.publicThread, ids.privateThread].sort())
    const textChannel = guild.channels.get(text)
    expect(textChannel?.kind).toBe("text")
    expect(textChannel?.overwrites.map((entry) => [entry.id, entry.type, Flags.toSortedNames(entry.allow), Flags.toSortedNames(entry.deny)])).toEqual([
      [ids.guild, "role", [], ["SendMessages"]],
      [ids.bot, "member", ["SendMessages"], []]
    ])
    expect(guild.channels.get(privateThread)).toMatchObject({ kind: "private-thread", parentId: ids.text, thread: { archived: false, locked: false, ownerId: ids.target } })
    expect(botIsThreadMember(guild, privateThread)).toBe(true)
    expect(botIsThreadMember(guild, ChannelId.make(ids.publicThread))).toBe(false)
    expect(guild.botMember).toEqual({ roleIds: [ids.roleA, ids.managed], timedOutUntil: null })
  })

  it("applies channel, role and bot-member updates, and drops an obfuscated channel's fake overwrite (H-160)", () => {
    const later = "2026-11-01T12:10:00.000000+00:00"
    const after = run(
      [
        ["CHANNEL_UPDATE", channelUpdate(ids.text, 0, [overwrite(ids.roleB, 0, "0", "1024")])],
        ["CHANNEL_UPDATE", channelUpdate(ids.voice, 2, [overwrite(ids.guild, 0, "0", "1024")], 1 << 17)],
        ["GUILD_ROLE_UPDATE", { guild_id: ids.guild, role: role(ids.roleB, "8", 1) }],
        ["GUILD_MEMBER_UPDATE", { ...memberObject(ids.bot, [ids.roleB], later), guild_id: ids.guild }],
        ["GUILD_MEMBER_UPDATE", { ...memberObject(ids.target, [ids.roleA]), guild_id: ids.guild }]
      ],
      booted.snapshot
    )
    expect(after.problems).toEqual([])
    const guild = guildOf(after.snapshot)
    expect(guild.channels.get(text)?.overwrites.map((entry) => entry.id)).toEqual([ids.roleB])
    expect(guild.channels.get(ChannelId.make(ids.voice))).toMatchObject({ obfuscated: true, overwrites: [] })
    expect(guild.roles.get(RoleId.make(ids.roleB))?.permissions).toBe(Flags.fromFlags(["Administrator"]))
    expect(guild.botMember).toEqual({ roleIds: [ids.roleB], timedOutUntil: later })
  })

  it("tracks the bot's thread membership, drops a private thread it is removed from, and keeps a public one", () => {
    const removed = run(
      [
        ["THREAD_MEMBERS_UPDATE", { id: ids.publicThread, guild_id: ids.guild, member_count: 2, added_members: [{ id: ids.publicThread, user_id: ids.bot, join_timestamp: "x", flags: 0, member: memberObject(ids.bot, []) }] }],
        ["THREAD_MEMBERS_UPDATE", { id: ids.privateThread, guild_id: ids.guild, member_count: 1, removed_member_ids: [ids.bot] }],
        ["THREAD_MEMBERS_UPDATE", { id: ids.publicThread, guild_id: ids.guild, member_count: 1, removed_member_ids: [ids.target] }]
      ],
      booted.snapshot
    )
    const guild = guildOf(removed.snapshot)
    expect(botIsThreadMember(guild, ChannelId.make(ids.publicThread))).toBe(true)
    expect(guild.channels.has(privateThread)).toBe(false)
    expect(guild.threadMembership.has(privateThread)).toBe(false)
    // the membership event may come before the thread: it is kept apart, and THREAD_CREATE fills the thread in
    const added = run(
      [
        ["THREAD_MEMBERS_UPDATE", { id: ids.privateThread, guild_id: ids.guild, member_count: 2, added_members: [{ id: ids.privateThread, user_id: ids.bot, join_timestamp: "x", flags: 0 }] }],
        ["THREAD_CREATE", threadObject(ids.privateThread, 12)]
      ],
      removed.snapshot
    )
    expect(botIsThreadMember(guildOf(added.snapshot), privateThread)).toBe(true)
    expect(guildOf(added.snapshot).channels.get(privateThread)?.kind).toBe("private-thread")
  })

  it("updates thread state, deletes threads, and syncs a channel's active threads (THREAD_LIST_SYNC)", () => {
    const after = run(
      [
        ["THREAD_UPDATE", threadObject(ids.publicThread, 11, { archived: true, locked: true })],
        ["THREAD_DELETE", { id: ids.privateThread, guild_id: ids.guild, parent_id: ids.text, type: 12 }]
      ],
      booted.snapshot
    )
    expect(guildOf(after.snapshot).channels.get(ChannelId.make(ids.publicThread))?.thread).toMatchObject({ archived: true, locked: true })
    expect(guildOf(after.snapshot).channels.has(privateThread)).toBe(false)
    const synced = run([["THREAD_LIST_SYNC", { guild_id: ids.guild, channel_ids: [ids.text], threads: [threadObject(ids.privateThread, 12)], members: [{ id: ids.privateThread, user_id: ids.bot }] }]], booted.snapshot)
    const guild = guildOf(synced.snapshot)
    expect(guild.channels.has(ChannelId.make(ids.publicThread))).toBe(false)
    expect(botIsThreadMember(guild, privateThread)).toBe(true)
  })

  it("ignores a DM channel and an unavailable guild; marks the guild stale on a payload that does not decode", () => {
    const after = run(
      [
        ["CHANNEL_CREATE", { id: "300000000000000077", type: 1, recipients: [] }],
        ["GUILD_CREATE", { id: "100000000000000001", unavailable: true }],
        ["CHANNEL_UPDATE", { id: ids.text, guild_id: ids.guild, type: "text" }]
      ],
      booted.snapshot
    )
    expect(after.problems).toEqual(["CHANNEL_UPDATE: the payload did not decode"])
    expect(guildOf(after.snapshot).stale).toBe(true)
    expect(after.snapshot.guilds.size).toBe(1)
    // a thread without thread_metadata is malformed, not silently unarchived
    const { thread_metadata: _metadata, ...bare } = threadObject(ids.publicThread, 11)
    expect(run([["THREAD_UPDATE", bare]], booted.snapshot).problems).toEqual([`THREAD_UPDATE: thread ${ids.publicThread} has no thread_metadata`])
    // the next good event clears stale
    expect(guildOf(run([["GUILD_ROLE_UPDATE", { guild_id: ids.guild, role: role(ids.roleB, "0", 1) }]], after.snapshot).snapshot).stale).toBe(false)
  })

  it("reads a forum's REQUIRE_TAG flag (H-044), and only on forum and media channels", () => {
    const forum = run([["CHANNEL_CREATE", channelUpdate("300000000000000015", 15, [], 1 << 4)]], booted.snapshot)
    expect(guildOf(forum.snapshot).channels.get(ChannelId.make("300000000000000015"))?.requireTag).toBe(true)
    const untagged = run([["CHANNEL_CREATE", channelUpdate("300000000000000015", 15, [], 0)]], booted.snapshot)
    expect(guildOf(untagged.snapshot).channels.get(ChannelId.make("300000000000000015"))?.requireTag).toBe(false)
    const text = run([["CHANNEL_UPDATE", channelUpdate(ids.text, 0, [], 1 << 4)]], booted.snapshot)
    expect(guildOf(text.snapshot).channels.get(ChannelId.make(ids.text))?.requireTag).toBe(false)
  })

  it("clears a channel's unseen mark when a channel or thread event brings it", () => {
    const unseen = (id: string): Snapshot => {
      const guild = guildOf(booted.snapshot)
      return { ...booted.snapshot, guilds: new Map([[guildId, { ...guild, unseen: new Set([ChannelId.make(id)]) }]]) }
    }
    expect(guildOf(run([["CHANNEL_UPDATE", channelUpdate(ids.text, 0, [])]], unseen(ids.text)).snapshot).unseen.size).toBe(0)
    expect(guildOf(run([["CHANNEL_CREATE", channelUpdate(ids.text, 0, [])]], unseen(ids.text)).snapshot).unseen.size).toBe(0)
    expect(guildOf(run([["THREAD_UPDATE", threadObject(ids.privateThread, 12)]], unseen(ids.privateThread)).snapshot).unseen.size).toBe(0)
    expect(guildOf(run([["THREAD_CREATE", threadObject(ids.privateThread, 12)]], unseen(ids.privateThread)).snapshot).unseen.size).toBe(0)
    // an event about another channel leaves it
    expect([...guildOf(run([["CHANNEL_UPDATE", channelUpdate(ids.voice, 2, [])]], unseen(ids.text)).snapshot).unseen]).toEqual([ids.text])
  })

  it("is idempotent: replaying dispatches leaves every value unchanged and only bumps generations", () => {
    const events: ReadonlyArray<readonly [string, unknown]> = [
      ["CHANNEL_UPDATE", channelUpdate(ids.text, 0, [overwrite(ids.roleB, 0, "0", "1024")])],
      ["GUILD_MEMBER_UPDATE", { ...memberObject(ids.bot, [ids.roleB]), guild_id: ids.guild }],
      ["THREAD_MEMBERS_UPDATE", { id: ids.privateThread, guild_id: ids.guild, member_count: 1, removed_member_ids: [ids.bot] }]
    ]
    const once = run(events, booted.snapshot)
    const twice = run(events, once.snapshot)
    expect(values(guildOf(twice.snapshot))).toEqual(values(guildOf(once.snapshot)))
    const generation = (snapshot: Snapshot) => generationOf(guildOf(snapshot), entityKey.channel(ids.text))
    expect(generation(twice.snapshot)).toBe(generation(once.snapshot) + 1)
    // a replayed GUILD_CREATE rebuilds the same guild
    expect(values(guildOf(run([["GUILD_CREATE", guildCreate]], booted.snapshot).snapshot))).toEqual(values(guildOf(booted.snapshot)))
  })
})

describe("GuildState", () => {
  const botUserId = UserId.make(ids.bot)
  const restAnswers = (channels: (path: string) => Scripted) => (method: string, path: string): Scripted => {
    if (path === `/guilds/${ids.guild}/members/${ids.bot}`) return json(200, memberObject(ids.bot, [ids.roleA]))
    if (path === `/guilds/${ids.guild}`) return json(200, { ...guildCreate, roles: [role(ids.guild, "0", 0), role(ids.roleA, "1024", 2)] })
    return method === "GET" ? channels(path) : json(405, { code: 0, message: "405" })
  }
  const make = (rest: Layer.Layer<DiscordREST>) =>
    Effect.gen(function* () {
      const client: DiscordRestService = yield* DiscordREST
      return yield* GuildState.make(client, botUserId, Duration.seconds(30))
    }).pipe(Effect.provide(rest))

  it.live("awaits GUILD_CREATE, and gives up after the deadline", () =>
    Effect.gen(function* () {
      const state = yield* make(scriptedRestEffect(() => Effect.never))
      const waiting = yield* state.awaitGuild(guildId, Duration.seconds(30)).pipe(Effect.forkChild)
      yield* state.apply("READY", ready)
      yield* state.apply("GUILD_CREATE", guildCreate)
      expect(Option.map(yield* Fiber.join(waiting), (guild) => guild.ownerId)).toEqual(Option.some(ids.owner))
      expect(yield* state.awaitGuild(GuildId.make("100000000000000001"), Duration.millis(10))).toEqual(Option.none())
    })
  )

  it.effect("refreshes a channel, the bot member, the owner and the roles, and clears stale", () =>
    Effect.gen(function* () {
      const state = yield* make(scriptedRestEffect((method, path) => Effect.succeed(restAnswers(() => json(200, channelUpdate(ids.text, 0, [overwrite(ids.roleA, 0, "1024", "0")])))(method, path))))
      yield* state.apply("READY", ready)
      yield* state.apply("GUILD_CREATE", guildCreate)
      yield* state.apply("CHANNEL_UPDATE", { id: ids.text, guild_id: ids.guild, type: "text" })
      expect(guildOf(yield* state.snapshot).stale).toBe(true)
      expect(yield* state.refresh(guildId, text)).toEqual({ committed: true })
      const guild = guildOf(yield* state.snapshot)
      expect(guild.stale).toBe(false)
      expect(guild.channels.get(text)?.overwrites.map((entry) => entry.id)).toEqual([ids.roleA])
      expect(guild.botMember?.roleIds).toEqual([ids.roleA])
      expect([...guild.roles.keys()].sort()).toEqual([ids.guild, ids.roleA])
    })
  )

  it.effect("records a channel getChannel answers 50001 or 10003 for as unseen, without failing", () =>
    Effect.gen(function* () {
      const state = yield* make(
        scriptedRestEffect((method, path) => Effect.succeed(restAnswers(() => json(403, { code: 50001, message: "Missing Access" }))(method, path)))
      )
      yield* state.apply("READY", ready)
      yield* state.apply("GUILD_CREATE", guildCreate)
      yield* state.refresh(guildId, privateThread)
      const guild = guildOf(yield* state.snapshot)
      expect(guild.unseen.has(privateThread)).toBe(true)
      expect(guild.channels.has(privateThread)).toBe(false)
    })
  )

  it.effect("sets the bot's thread membership from the REST thread's member field, and commits the thread's parent", () =>
    Effect.gen(function* () {
      const parentOverwrites = [overwrite(ids.roleA, 0, "2048", "0")]
      const answers = (member: boolean) =>
        scriptedRestEffect((method, path) =>
          Effect.succeed(
            restAnswers((channelPath) =>
              channelPath === `/channels/${ids.privateThread}`
                ? json(200, threadObject(ids.privateThread, 12, { member, locked: true }))
                : channelPath === `/channels/${ids.text}`
                  ? json(200, channelUpdate(ids.text, 0, parentOverwrites))
                  : json(404, { code: 10003, message: "Unknown Channel" })
            )(method, path)
          )
        )
      // GUILD_CREATE says the bot is in the private thread; a REST read without `member` says it is not
      const outside = yield* make(answers(false))
      yield* outside.apply("READY", ready)
      yield* outside.apply("GUILD_CREATE", guildCreate)
      expect(botIsThreadMember(guildOf(yield* outside.snapshot), privateThread)).toBe(true)
      yield* outside.refresh(guildId, privateThread)
      const after = guildOf(yield* outside.snapshot)
      expect(botIsThreadMember(after, privateThread)).toBe(false)
      expect(after.channels.get(privateThread)?.thread).toMatchObject({ locked: true })
      // the parent was read and committed too
      expect(after.channels.get(text)?.overwrites.map((entry) => [entry.id, Flags.toSortedNames(entry.allow)])).toEqual([[ids.roleA, ["SendMessages"]]])

      const inside = yield* make(answers(true))
      yield* inside.apply("READY", ready)
      yield* inside.apply("GUILD_CREATE", { ...guildCreate, threads: [threadObject(ids.privateThread, 12)] })
      expect(botIsThreadMember(guildOf(yield* inside.snapshot), privateThread)).toBe(false)
      yield* inside.refresh(guildId, privateThread)
      expect(botIsThreadMember(guildOf(yield* inside.snapshot), privateThread)).toBe(true)
    })
  )

  it.effect("clears unseen when a later refresh can fetch the channel", () =>
    Effect.gen(function* () {
      let visible = false
      const state = yield* make(
        scriptedRestEffect((method, path) =>
          Effect.succeed(
            restAnswers(() => (visible ? json(200, threadObject(ids.privateThread, 12, { member: true })) : json(404, { code: 10003, message: "Unknown Channel" })))(
              method,
              path
            )
          )
        )
      )
      yield* state.apply("READY", ready)
      yield* state.apply("GUILD_CREATE", guildCreate)
      yield* state.refresh(guildId, privateThread)
      expect(guildOf(yield* state.snapshot).unseen.has(privateThread)).toBe(true)
      visible = true
      yield* state.refresh(guildId, privateThread)
      const guild = guildOf(yield* state.snapshot)
      expect(guild.unseen.has(privateThread)).toBe(false)
      expect(guild.channels.get(privateThread)?.kind).toBe("private-thread")
      expect(botIsThreadMember(guild, privateThread)).toBe(true)
    })
  )

  it.effect("never overwrites a gateway update that arrived while its REST read was in flight (E11)", () =>
    Effect.gen(function* () {
      const restAnswered = yield* Deferred.make<void>()
      const hookApplied = yield* Deferred.make<void>()
      // Discord answers getChannel with the state from before the update, then the update is reduced, then the
      // refresh tries to commit
      const state = yield* make(
        scriptedRestEffect((method, path) =>
          path === `/channels/${ids.text}`
            ? Deferred.succeed(restAnswered, undefined).pipe(Effect.andThen(Deferred.await(hookApplied)), Effect.as(json(200, channelUpdate(ids.text, 0, []))))
            : Effect.succeed(restAnswers(() => json(404, { code: 10003, message: "Unknown Channel" }))(method, path))
        )
      )
      yield* state.apply("READY", ready)
      yield* state.apply("GUILD_CREATE", guildCreate)
      const refreshing = yield* state.refresh(guildId, text).pipe(Effect.forkChild)
      yield* Deferred.await(restAnswered)
      yield* state.apply("CHANNEL_UPDATE", channelUpdate(ids.text, 0, [overwrite(ids.guild, 0, "0", "1024")]))
      yield* Deferred.succeed(hookApplied, undefined)
      expect(yield* Fiber.join(refreshing)).toEqual({ committed: false })
      const guild = guildOf(yield* state.snapshot)
      expect(guild.channels.get(text)?.overwrites.map((entry) => [entry.id, Flags.toSortedNames(entry.deny)])).toEqual([[ids.guild, ["ViewChannel"]]])
      // the entities the gateway did not touch were committed
      expect(guild.botMember?.roleIds).toEqual([ids.roleA])
    })
  )
})

