import { describe, expect, it } from "vitest"
import * as LabIds from "../../harness/LabIds.ts"
import { byRank, desiredRoleOrder, orderHolds, solidPng } from "../../harness/Provision.ts"
import {
  baselineOverwrites,
  bulkDeleteMaxAgeMs,
  channelPatch,
  memberRoleDiff,
  planDeletes,
  snowflakeTime,
  threadPatch,
  type View,
  withoutLeftovers,
  writesBetween
} from "../../harness/Reset.ts"
import type * as Wire from "../../harness/Wire.ts"
import { ChannelId, GuildId, MessageId, RoleId, UserId } from "../../src/Snowflake.ts"

/**
 * Reset's and provisioning's decisions (DESIGN §5.7). Each is a pure function of what the harness read, and a
 * channel, thread or member already at baseline produces no write, which is what makes a second reset make
 * zero writes.
 */
const labTarget = RoleId.make("400000000000000008")
const category = ChannelId.make("300000000000000000")
const allow = LabIds.targetOverwriteAllow.toString()

const text = (overrides: Partial<Wire.Channel> = {}): Wire.Channel => ({
  id: ChannelId.make("300000000000000001"),
  type: 0,
  name: "lab-text",
  parent_id: category,
  flags: 0,
  rate_limit_per_user: 0,
  permission_overwrites: [{ id: labTarget, type: 0, allow, deny: "0" }],
  ...overrides
})

describe("channel restoration", () => {
  const overwrites = baselineOverwrites(labTarget)

  it("writes nothing for a channel at baseline", () => {
    expect(channelPatch(text(), "lab-text", category, overwrites)).toBeUndefined()
  })

  it("restores the name, parent, slowmode and the exact overwrites", () => {
    const dirty = text({
      name: "lab-text-b",
      parent_id: null,
      rate_limit_per_user: 5,
      permission_overwrites: [
        { id: labTarget, type: 0, allow, deny: "0" },
        { id: "200000000000000001", type: 1, allow: "1024", deny: "0" }
      ]
    })
    expect(channelPatch(dirty, "lab-text", category, overwrites)).toEqual({
      name: "lab-text",
      parent_id: category,
      rate_limit_per_user: 0,
      permission_overwrites: [{ id: labTarget, type: 0, allow: Number(LabIds.targetOverwriteAllow), deny: 0 }]
    })
  })

  it("restores a forum's REQUIRE_TAG flag and tags, keeping its other flags", () => {
    const forum = text({ type: 15, name: "lab-forum", flags: 16 | 2, available_tags: [] })
    expect(channelPatch(forum, "lab-forum", category, overwrites)).toEqual({ flags: 2, available_tags: LabIds.baselineTags })
    const atBaseline = text({ type: 15, name: "lab-forum", flags: 0, available_tags: [{ id: "1", name: "lab-tag", moderated: false, emoji_id: null, emoji_name: null }] })
    expect(channelPatch(atBaseline, "lab-forum", category, overwrites)).toBeUndefined()
  })
})

describe("thread restoration", () => {
  const thread = (metadata: NonNullable<Wire.Channel["thread_metadata"]>): Wire.Channel => ({ id: ChannelId.make("300000000000000010"), type: 11, name: "lab-public-thread", thread_metadata: metadata })

  it("unarchives, unlocks and restores auto-archive, and writes nothing at baseline", () => {
    expect(threadPatch(thread({ archived: false, locked: false, auto_archive_duration: 10080 }), "lab-public-thread")).toBeUndefined()
    expect(threadPatch(thread({ archived: true, locked: true, auto_archive_duration: 60 }), "lab-public-thread")).toEqual({
      archived: false,
      locked: false,
      auto_archive_duration: 10080
    })
  })
})

describe("member roles", () => {
  const [one, two, three, managed, foreign] = ["01", "02", "03", "08", "09"].map((n) => RoleId.make(`4000000000000000${n}`))
  it("removes non-baseline lab roles, adds missing baseline roles, leaves managed roles and reports foreign roles", () => {
    if (one === undefined || two === undefined || three === undefined || managed === undefined || foreign === undefined) throw new Error("fixture")
    const lab = new Set<string>([one, two, three])
    expect(memberRoleDiff([one], [], lab, new Set())).toEqual({ add: [], remove: [one], foreign: [] })
    expect(memberRoleDiff([one, foreign, managed], [two], lab, new Set([managed]))).toEqual({ add: [two], remove: [one], foreign: [foreign] })
    expect(memberRoleDiff([two, managed], [two], lab, new Set([managed]))).toEqual({ add: [], remove: [], foreign: [] })
  })
})

describe("message deletion", () => {
  const now = Date.parse("2026-11-01T12:00:00Z")
  const idAt = (ms: number, n: number) => MessageId.make(((BigInt(ms) - 1420070400000n) << 22n | BigInt(n)).toString())
  const message = (id: MessageId, author: string, type = 0): Wire.Message => ({ id, type, author: { id: UserId.make(author) }, pinned: false })
  const bot = "200000000000000001"
  const human = "200000000000000099"

  it("reads a snowflake's creation time", () => {
    expect(snowflakeTime(idAt(now, 7))).toBe(now)
  })

  it("bulk-deletes recent bot messages, deletes old and lone ones singly, and keeps the rest", () => {
    const recent = [1, 2, 3].map((n) => idAt(now - 1000 * n, n))
    const old = idAt(now - bulkDeleteMaxAgeMs - 1, 9)
    const starter = idAt(now - 5000, 5)
    const messages = [
      ...recent.map((id) => message(id, bot)),
      message(old, bot),
      message(idAt(now - 2000, 20), human),
      message(starter, bot),
      message(idAt(now - 3000, 30), bot, 1), // "added to the thread": never deletable
      message(idAt(now - 4000, 40), bot, 21)
    ]
    expect(planDeletes(messages, new Set([bot]), new Set([starter]), now)).toEqual({ bulk: [recent], single: [old] })
    expect(planDeletes([message(recent[0] ?? old, bot)], new Set([bot]), new Set(), now)).toEqual({ bulk: [], single: [recent[0]] })
  })

  it("splits more than 100 recent messages into chunks of at most 100, never a chunk of one", () => {
    const ids = Array.from({ length: 201 }, (_, n) => idAt(now - 1000 - n, n))
    const plan = planDeletes(ids.map((id) => message(id, bot)), new Set([bot]), new Set(), now)
    expect(plan.bulk.map((chunk) => chunk.length)).toEqual([100, 100])
    expect(plan.single).toEqual([ids[200]])
  })
})

describe("role positions", () => {
  const role = (id: string, name: string, position: number, botId?: string): Wire.Role => ({
    id: RoleId.make(id),
    name,
    permissions: "0",
    position,
    managed: botId !== undefined,
    mentionable: false,
    ...(botId === undefined ? {} : { tags: { bot_id: UserId.make(botId) } })
  })
  const guild = "100000000000000000"
  const ids = Object.fromEntries(LabIds.roleSpecs.map((spec, index) => [spec.name, `4000000000000000${String(index).padStart(2, "0")}`]))

  it("puts managed roles directly below lab-low, the subject's above the target's", () => {
    const order = desiredRoleOrder(ids, { subject: "S", target: "T" })
    expect(order.slice(2, 6)).toEqual([ids["lab-low"], "S", "T", ids["lab-grant"]])
    expect(desiredRoleOrder(ids, { subject: undefined, target: undefined })).toEqual(LabIds.roleSpecs.map((spec) => ids[spec.name]))
  })

  it("holds only with distinct decreasing positions at the bottom, never by ID tie-break", () => {
    const desired = desiredRoleOrder(ids, { subject: undefined, target: undefined })
    const n = desired.length
    const everyone = role(guild, "@everyone", 0)
    const harness = role("400000000000000099", "Perms Harness", n + 1, "200000000000000000")
    const placed = desired.map((id, index) => role(id, LabIds.roleSpecs[index]?.name ?? "", n - index))
    expect(orderHolds([everyone, harness, ...placed], guild, desired)).toBe(true)
    const tied = desired.map((id, index) => role(id, LabIds.roleSpecs[index]?.name ?? "", 1))
    expect(byRank([everyone, ...tied]).slice(0, n).map((entry) => entry.id)).toEqual(desired)
    expect(orderHolds([everyone, role("400000000000000099", "Perms Harness", 1, "200000000000000000"), ...tied], guild, desired)).toBe(false)
    const harnessBelow = role("400000000000000099", "Perms Harness", 3, "200000000000000000")
    expect(orderHolds([everyone, harnessBelow, ...placed], guild, desired)).toBe(false)
  })
})

describe("the sticker image", () => {
  it("is a 320 x 320 PNG with a valid header", () => {
    const png = solidPng(320, [1, 2, 3])
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const view = new DataView(png.buffer, png.byteOffset)
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR")
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([320, 320])
    expect(png.length).toBeLessThan(512 * 1024)
  })
})

describe("write counting", () => {
  it("reports only the writes between two snapshots", () => {
    expect(writesBetween({ writesByRoute: [["PATCH /channels/{id}", 2]] }, { writesByRoute: [["DELETE /channels/{id}", 1], ["PATCH /channels/{id}", 2]] })).toEqual({
      writes: 1,
      writesByRoute: [["DELETE /channels/{id}", 1]]
    })
  })
})

describe("leftovers", () => {
  it("are dropped from the view, including from the members' roles, so no step acts on a deleted role", () => {
    const stored = RoleId.make("400000000000000001")
    const leftover = RoleId.make("400000000000000002")
    const role = (id: RoleId, name: string): Wire.Role => ({ id, name, permissions: "0", position: 1, managed: false, mentionable: false })
    const member = (user: string, roles: ReadonlyArray<RoleId>): Wire.Member => ({ user: { id: UserId.make(user) }, roles })
    const view: View = {
      state: { guildId: GuildId.make("100000000000000000"), channels: { "lab-text": ChannelId.make("300000000000000001") }, roles: { "lab-target": stored } },
      channels: [text(), text({ id: ChannelId.make("300000000000000002"), name: "lab-text" }), text({ id: ChannelId.make("300000000000000003"), name: "general" })],
      roles: [role(stored, "lab-target"), role(leftover, "lab-target"), role(RoleId.make("400000000000000003"), "Moderators")],
      threads: [],
      subject: member("200000000000000001", [leftover]),
      target: member("200000000000000002", [stored, leftover])
    }
    const after = withoutLeftovers(view)
    expect(after.channels.map((channel) => channel.id)).toEqual(["300000000000000001", "300000000000000003"])
    expect(after.roles.map((entry) => entry.id)).toEqual([stored, "400000000000000003"])
    expect(after.subject.roles).toEqual([])
    expect(after.target.roles).toEqual([stored])
  })
})
