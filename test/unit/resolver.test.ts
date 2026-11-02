import { PermissionFlagsBits as P } from "discord-api-types/v10"
import { describe, expect, it } from "vitest"
import { PermissionFlags } from "../../src/errors/Missing.generated.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import { applyOverwrites, basePermissions, type ChannelInput, inputFromSnapshot, resolve, roleBelow, targetBelow } from "../../src/permissions/Resolver.ts"
import type { ChannelSnap, GuildSnap, Overwrite, Snapshot } from "../../src/state/Snapshot.ts"
import { ChannelId, RoleId, UserId } from "../../src/Snowflake.ts"
import {
  botId,
  channel,
  earlier,
  everyone,
  guild,
  guildId,
  known,
  later,
  member,
  memberOverwrite,
  now,
  otherId,
  ownerId,
  role,
  roleA,
  roleB,
  roleC,
  roleOverwrite,
  set,
  thread
} from "../support/guild.ts"

/**
 * The resolver against the documented algorithm (DESIGN §4.6; permissions.mdx "Permission Overwrites",
 * "Implicit Permissions", "Permissions For Timed Out Members"). The reference below is a literal transcription of
 * the documented pseudocode (discord-semantics Appendix A.2) over plain bigints, kept independent of the
 * library's modules. Thousands of seeded random guilds compare stage by stage; named cases pin each mask.
 */

// ---- the documented algorithm, transcribed ------------------------------------------------------------

interface RefChannel {
  readonly kind: "text" | "thread" | "voice"
  readonly overwrites: ReadonlyArray<{ readonly id: string; readonly type: 0 | 1; readonly allow: bigint; readonly deny: bigint }>
}
interface RefMember {
  readonly userId: string
  readonly roleIds: ReadonlyArray<string>
  readonly timedOutUntil: number | null
}
const ALL = PermissionFlags.reduce((bits, flag) => bits | P[flag], 0n)
const refBase = (roles: ReadonlyMap<string, bigint>, member: RefMember): bigint => {
  if (member.userId === ownerId) return ALL
  let permissions = roles.get(guildId) ?? 0n
  for (const roleId of member.roleIds) permissions |= roles.get(roleId) ?? 0n
  if ((permissions & P.Administrator) === P.Administrator) return ALL
  return permissions
}
const refOverwrites = (member: RefMember, channel: RefChannel, base: bigint): bigint => {
  if ((base & P.Administrator) === P.Administrator) return ALL
  let permissions = base
  const everyoneOverwrite = channel.overwrites.find((o) => o.type === 0 && o.id === guildId)
  if (everyoneOverwrite) {
    permissions &= ~everyoneOverwrite.deny
    permissions |= everyoneOverwrite.allow
  }
  let allow = 0n
  let deny = 0n
  for (const roleId of member.roleIds) {
    const o = channel.overwrites.find((x) => x.type === 0 && x.id === roleId)
    if (o) {
      allow |= o.allow
      deny |= o.deny
    }
  }
  permissions &= ~deny
  permissions |= allow
  const own = channel.overwrites.find((o) => o.type === 1 && o.id === member.userId)
  if (own) {
    permissions &= ~own.deny
    permissions |= own.allow
  }
  return permissions
}
const TEXT_CHILDREN_OF_SEND = P.MentionEveryone | P.SendTTSMessages | P.AttachFiles | P.EmbedLinks
const refImplicit = (channel: RefChannel, permissions: bigint): bigint => {
  if ((permissions & P.Administrator) === P.Administrator) return permissions
  if ((permissions & P.ViewChannel) === 0n) return 0n
  let out = permissions
  if (channel.kind !== "thread" && (out & P.SendMessages) === 0n) out &= ~TEXT_CHILDREN_OF_SEND
  if (channel.kind === "voice" && (out & P.Connect) === 0n) out &= ~P.ManageChannels
  return out
}
const refTimeout = (member: RefMember, permissions: bigint, at: number): bigint => {
  const timedOut = member.timedOutUntil !== null && member.timedOutUntil > at
  if (!timedOut) return permissions
  if (member.userId === ownerId) return permissions
  if ((permissions & P.Administrator) === P.Administrator) return permissions
  return permissions & (P.ViewChannel | P.ReadMessageHistory)
}

// ---- seeded random cases ------------------------------------------------------------------------------

/** A small deterministic PRNG (mulberry32), so failures reproduce. */
const prng = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** The flags the cases draw from: the ones the masks and the matrix care about, plus Administrator in roles. */
const pool = ["ViewChannel", "SendMessages", "SendMessagesInThreads", "EmbedLinks", "AttachFiles", "MentionEveryone", "SendTTSMessages", "ReadMessageHistory", "Connect", "ManageChannels", "ManageThreads", "AddReactions"] as const
const randomBits = (random: () => number, density: number): bigint => pool.reduce((bits, flag) => (random() < density ? bits | P[flag] : bits), 0n)

describe("the resolver against the documented algorithm", () => {
  it("agrees on base, overwrites and the effective set for 4000 seeded random cases", () => {
    const random = prng(20261101)
    const roleIds = [roleA, roleB, roleC]
    for (let n = 0; n < 4000; n++) {
      const roleBits = new Map<string, bigint>([[guildId, randomBits(random, 0.2)]])
      for (const id of roleIds) roleBits.set(id, randomBits(random, 0.2) | (random() < 0.05 ? P.Administrator : 0n))
      const held = roleIds.filter(() => random() < 0.5)
      const userId = random() < 0.03 ? ownerId : botId
      const timedOutUntil = random() < 0.3 ? (random() < 0.8 ? now + 60_000 : now - 60_000) : null
      const kind = (["text", "thread", "voice"] as const)[Math.floor(random() * 3)] ?? "text"
      const targets = [guildId, ...roleIds, botId, otherId]
      const overwrites = targets.flatMap((id) => {
        if (random() < 0.5) return []
        const type: 0 | 1 = id === botId || id === otherId ? 1 : 0
        // order shuffled by the draw: array order must not matter (H-009)
        return [{ id, type, allow: randomBits(random, 0.15), deny: randomBits(random, 0.15) }]
      })
      const shuffled = overwrites.toSorted(() => (random() < 0.5 ? -1 : 1))
      const ref: RefMember = { userId, roleIds: held, timedOutUntil }
      const refChannel: RefChannel = { kind, overwrites: shuffled }

      const roles = [...roleBits].map(([id, bits], index) => role(RoleId.make(id), Flags.fromBits(bits), index))
      const input = guild(roles)
      const lib = member(held, timedOutUntil === null ? null : new Date(timedOutUntil).toISOString(), UserId.make(userId))
      const libOverwrites: ReadonlyArray<Overwrite> = shuffled.map((o) => (o.type === 0 ? roleOverwrite(o.id, Flags.fromBits(o.allow), Flags.fromBits(o.deny)) : memberOverwrite(o.id, Flags.fromBits(o.allow), Flags.fromBits(o.deny))))
      const parent: ChannelSnap = channel(kind === "voice" ? "voice" : "text", libOverwrites)
      const target: ChannelInput = kind === "thread" ? known(thread("public-thread"), parent) : known(parent)

      const base = refBase(roleBits, ref)
      const afterOverwrites = refOverwrites(ref, refChannel, base)
      const effective = refTimeout(ref, refImplicit(refChannel, afterOverwrites), now)
      const resolution = resolve({ guild: input, channel: target, member: lib, now })
      const label = JSON.stringify({ n, kind, userId, held, timedOutUntil })
      expect(basePermissions(input, lib), label).toBe(base & ALL)
      expect(resolution.afterOverwrites, label).toBe(afterOverwrites & ALL)
      expect(resolution.effective, label).toBe(effective & ALL)
    }
  })
})

describe("the resolver's stages", () => {
  const send = set("ViewChannel", "SendMessages")

  it("finds @everyone by the guild ID and ORs the member's roles; unknown roles add nothing", () => {
    const g = guild([role(everyone, set("ViewChannel")), role(roleA, set("SendMessages"))])
    expect(Flags.toSortedNames(basePermissions(g, member([roleA, RoleId.make("400000000000000077")])))).toEqual(["SendMessages", "ViewChannel"])
  })

  it("gives the owner and an Administrator every flag, past every overwrite (H-002, H-003)", () => {
    const g = guild([role(everyone, Flags.empty), role(roleA, set("Administrator"))])
    const denyAll = channel("text", [roleOverwrite(guildId, Flags.empty, Flags.all)])
    expect(resolve({ guild: g, channel: known(denyAll), member: member([roleA]), now }).effective).toBe(Flags.all)
    expect(resolve({ guild: g, channel: known(denyAll), member: member([], null, ownerId), now }).effective).toBe(Flags.all)
  })

  it("lets a role allow beat a role deny whatever the positions, and the member overwrite beat both (H-006, H-008)", () => {
    const g = guild([role(everyone, send), role(roleA, Flags.empty, 5), role(roleB, Flags.empty, 1)])
    const both = channel("text", [roleOverwrite(roleA, Flags.empty, set("EmbedLinks")), roleOverwrite(roleB, set("EmbedLinks"))])
    expect(Flags.has(applyOverwrites(g, member([roleA, roleB]), both, send), "EmbedLinks")).toBe(true)
    const memberDeny = channel("text", [roleOverwrite(roleB, set("EmbedLinks")), memberOverwrite(botId, Flags.empty, set("EmbedLinks"))])
    expect(Flags.has(applyOverwrites(g, member([roleB]), memberDeny, send), "EmbedLinks")).toBe(false)
  })

  it("ignores an overwrite for a role the member lacks (H-011) and an Administrator bit in an overwrite (H-004)", () => {
    const g = guild([role(everyone, send)])
    const notHeld = channel("text", [roleOverwrite(roleA, Flags.empty, set("SendMessages"))])
    expect(Flags.has(resolve({ guild: g, channel: known(notHeld), member: member([]), now }).effective, "SendMessages")).toBe(true)
    const adminOverwrite = channel("text", [memberOverwrite(botId, set("Administrator"), set("EmbedLinks"))])
    const resolution = resolve({ guild: g, channel: known(adminOverwrite), member: member([]), now })
    expect(Flags.has(resolution.effective, "EmbedLinks")).toBe(false)
    expect(Flags.has(resolution.effective, "Administrator")).toBe(true)
  })

  it("uses the parent's overwrites for a thread (H-030)", () => {
    const g = guild([role(everyone, send)])
    const parent = channel("text", [roleOverwrite(guildId, Flags.empty, set("SendMessagesInThreads"))])
    const resolution = resolve({ guild: g, channel: known(thread("public-thread"), parent), member: member([]), now })
    expect(Flags.has(resolution.effective, "SendMessagesInThreads")).toBe(false)
    expect(resolution.thread).toEqual({ archived: false, locked: false, creatorIsMember: false, memberIsInThread: false })
  })
})

describe("the resolver's masks", () => {
  const all = set("ViewChannel", "SendMessages", "SendMessagesInThreads", "EmbedLinks", "AttachFiles", "ReadMessageHistory", "Connect", "ManageChannels", "AddReactions")
  const g = guild([role(everyone, all)])
  const masksOf = (target: ChannelInput, timedOutUntil: string | null = null) => resolve({ guild: g, channel: target, member: member([], timedOutUntil), now })

  it("treats an obfuscated channel, or a thread under one, as blind, ignoring its overwrites (H-160)", () => {
    const hidden = channel("text", [roleOverwrite(guildId, Flags.empty, set("ViewChannel"))], { obfuscated: true })
    expect(masksOf(known(hidden))).toMatchObject({ masks: ["obfuscated"], effective: Flags.empty, afterOverwrites: all })
    expect(masksOf(known(thread("public-thread"), hidden)).masks).toEqual(["obfuscated"])
  })

  it("treats an unseen channel, and a thread without its parent, as blind", () => {
    expect(masksOf({ _tag: "Unseen" })).toMatchObject({ masks: ["unseen"], effective: Flags.empty })
    expect(masksOf(known(thread("public-thread"))).masks).toEqual(["unseen"])
  })

  it("hides a private thread from a non-member without ManageThreads, and only then (H-033, H-047)", () => {
    const parent = channel("text")
    expect(masksOf(known(thread("private-thread"), parent)).masks).toEqual(["private-thread"])
    expect(masksOf(known(thread("private-thread"), parent, true)).masks).toEqual([])
    expect(masksOf(known(thread("public-thread"), parent)).masks).toEqual([])
    const moderator = guild([role(everyone, Flags.union(all, set("ManageThreads")))])
    expect(resolve({ guild: moderator, channel: known(thread("private-thread"), parent), member: member([]), now }).masks).toEqual([])
  })

  it("drops everything without View (H-012), the four Send children without Send outside threads (H-013), ManageChannels without Connect (H-015)", () => {
    expect(masksOf(known(channel("text", [roleOverwrite(guildId, Flags.empty, set("ViewChannel"))])))).toMatchObject({ masks: ["implicit-view"], effective: Flags.empty })
    const noSend = masksOf(known(channel("text", [roleOverwrite(guildId, Flags.empty, set("SendMessages"))])))
    expect(noSend.masks).toEqual(["implicit-send"])
    expect(Flags.toSortedNames(noSend.effective)).toEqual(["AddReactions", "Connect", "ManageChannels", "ReadMessageHistory", "SendMessagesInThreads", "ViewChannel"])
    const noSendThread = masksOf(known(thread("public-thread"), channel("text", [roleOverwrite(guildId, Flags.empty, set("SendMessages"))])))
    expect(noSendThread.masks).toEqual([])
    const noConnect = masksOf(known(channel("voice", [roleOverwrite(guildId, Flags.empty, set("Connect"))])))
    expect(noConnect.masks).toEqual(["implicit-connect"])
    expect(Flags.has(noConnect.effective, "ManageChannels")).toBe(false)
  })

  it("keeps only View and ReadMessageHistory under an active timeout, after overwrites (H-020, H-029)", () => {
    const allowed = channel("text", [memberOverwrite(botId, set("SendMessages"))])
    const timedOut = masksOf(known(allowed), later)
    expect(timedOut.masks).toEqual(["timeout"])
    expect(timedOut.timeout).toEqual({ until: later })
    expect(Flags.toSortedNames(timedOut.effective)).toEqual(["ReadMessageHistory", "ViewChannel"])
    expect(masksOf(known(allowed), earlier)).toMatchObject({ masks: [], timeout: undefined })
  })

  it("exempts the owner and an Administrator from the timeout (H-021)", () => {
    const admin = guild([role(everyone, Flags.empty), role(roleA, set("Administrator"))])
    expect(resolve({ guild: admin, channel: known(channel("text")), member: member([roleA], later), now })).toMatchObject({ masks: [], timeout: undefined, effective: Flags.all })
    expect(resolve({ guild: g, channel: known(channel("text")), member: member([], later, ownerId), now }).timeout).toBeUndefined()
  })
})

describe("hierarchy", () => {
  const g = guild([role(everyone, Flags.empty, 0), role(roleA, Flags.empty, 3), role(roleB, Flags.empty, 2), role(roleC, Flags.empty, 2)])
  it("needs the bot's highest role strictly above the target's; equal positions break on the lower ID (H-064)", () => {
    expect(targetBelow(g, member([roleA]), member([roleB], null, otherId))).toBe(true)
    expect(targetBelow(g, member([roleB]), member([roleA], null, otherId))).toBe(false)
    expect(targetBelow(g, member([roleB]), member([roleB], null, otherId))).toBe(false)
    expect(targetBelow(g, member([roleB]), member([roleC], null, otherId))).toBe(true)
    expect(targetBelow(g, member([]), member([], null, otherId))).toBe(false)
    expect(targetBelow(g, member([roleA]), member([], null, ownerId))).toBe(false)
  })
  it("compares a role only with the bot's highest role (H-060, H-061)", () => {
    const b = g.roles.get(roleB)
    if (b === undefined) throw new Error("fixture")
    expect(roleBelow(g, member([roleA]), b)).toBe(true)
    expect(roleBelow(g, member([roleB]), b)).toBe(false)
    expect(roleBelow(g, member([]), b)).toBe(false)
  })
})

describe("inputFromSnapshot", () => {
  const text = channel("text", [roleOverwrite(guildId, Flags.empty, set("SendMessages"))])
  const privateThread = { ...thread("private-thread"), parentId: text.id }
  const base: GuildSnap = {
    id: guildId,
    ownerId,
    stale: false,
    roles: new Map([[everyone, role(everyone, set("ViewChannel", "SendMessages"))]]),
    channels: new Map([
      [text.id, text],
      [privateThread.id, privateThread]
    ]),
    unseen: new Set(),
    threadMembership: new Map(),
    botMember: { roleIds: [], timedOutUntil: later },
    generations: new Map()
  }
  const snapshot = (guild: Partial<GuildSnap> = {}): Snapshot => ({ botUserId: botId, guilds: new Map([[guildId, { ...base, ...guild }]]) })
  const channelOf = (target: Snapshot, id: ChannelId) => {
    const result = inputFromSnapshot(target, guildId, id, now)
    return result._tag === "Ready" ? result.input.channel : result.reason
  }

  it("builds the input from the state: the guild's roles, the bot member with its timeout, the channel", () => {
    const result = inputFromSnapshot(snapshot(), guildId, text.id, now)
    if (result._tag !== "Ready") throw new Error(result.reason)
    expect(result.input.member).toEqual({ userId: botId, roleIds: [], timedOutUntil: later })
    expect(result.input.guild).toEqual({ id: guildId, ownerId, roles: base.roles })
    expect(result.input.channel).toEqual({ _tag: "Known", channel: text, parent: undefined, threadMember: false })
    expect(result.input.now).toBe(now)
  })

  it("gives a thread its parent and the bot's membership from the state's own map", () => {
    expect(channelOf(snapshot(), privateThread.id)).toEqual({ _tag: "Known", channel: privateThread, parent: text, threadMember: false })
    expect(channelOf(snapshot({ threadMembership: new Map([[privateThread.id, true]]) }), privateThread.id)).toEqual({ _tag: "Known", channel: privateThread, parent: text, threadMember: true })
    expect(channelOf(snapshot({ threadMembership: new Map([[privateThread.id, false]]) }), privateThread.id)).toMatchObject({ threadMember: false })
  })

  it("resolves a channel a refresh found unseen, and a thread whose parent is unseen or missing, as Unseen", () => {
    expect(channelOf(snapshot({ unseen: new Set([text.id]) }), text.id)).toEqual({ _tag: "Unseen" })
    // an unseen ID wins over a stale entry for the same channel
    expect(channelOf(snapshot({ unseen: new Set([privateThread.id]) }), privateThread.id)).toEqual({ _tag: "Unseen" })
    expect(channelOf(snapshot({ unseen: new Set([text.id]) }), privateThread.id)).toEqual({ _tag: "Unseen" })
    const orphan = { ...privateThread, parentId: undefined }
    expect(channelOf(snapshot({ channels: new Map([[orphan.id, orphan]]) }), orphan.id)).toEqual({ _tag: "Unseen" })
  })

  it("asks for a refresh when the state lacks the guild, the bot, the channel or a thread's parent", () => {
    expect(inputFromSnapshot({ botUserId: botId, guilds: new Map() }, guildId, text.id, now)._tag).toBe("NeedsRefresh")
    expect(inputFromSnapshot({ ...snapshot(), botUserId: undefined }, guildId, text.id, now)._tag).toBe("NeedsRefresh")
    expect(inputFromSnapshot(snapshot({ botMember: undefined }), guildId, text.id, now)._tag).toBe("NeedsRefresh")
    expect(channelOf(snapshot(), ChannelId.make("300000000000000077"))).toBe("channel 300000000000000077 is not in the state")
    expect(channelOf(snapshot({ channels: new Map([[privateThread.id, privateThread]]) }), privateThread.id)).toBe(`thread ${privateThread.id}'s parent ${text.id} is not in the state`)
  })
})
