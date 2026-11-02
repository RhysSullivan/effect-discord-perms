import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as LabIds from "../../harness/LabIds.ts"
import type * as Reset from "../../harness/Reset.ts"
import { baselineProblems, type DirtStep, type Snapshot, unseen } from "../../harness/SelfTest.ts"
import type * as Wire from "../../harness/Wire.ts"
import { ApplicationId, ChannelId, GuildId, MessageId, RoleId, UserId } from "../../src/Snowflake.ts"

/**
 * The reset self-test's read-back judgment (DESIGN §5.7): written from the spec, so it reports each field a
 * reset could forget, and nothing for a lab at baseline.
 */
const guildId = GuildId.make("100000000000000000")
const context: Reset.Context = {
  guildId,
  harnessUserId: UserId.make("200000000000000000"),
  subjectUserId: UserId.make("200000000000000001"),
  targetUserId: UserId.make("200000000000000002"),
  subjectApplicationId: ApplicationId.make("100000000000000002")
}
const now = Date.parse("2026-11-01T12:00:00Z")
const human = UserId.make("200000000000000099")

const roleIds = Object.fromEntries(LabIds.roleSpecs.map((spec, index) => [spec.name, RoleId.make(`4000000000000000${String(index).padStart(2, "0")}`)]))
const channelIds = Object.fromEntries(
  [...LabIds.channelSpecs.map((spec) => spec.name), ...LabIds.threadSpecs.map((spec) => spec.name)].map((name, index) => [name, ChannelId.make(`3000000000000000${String(index).padStart(2, "0")}`)])
)
const id = (name: string): ChannelId => {
  const found = channelIds[name]
  if (found === undefined) throw new Error(`fixture: ${name}`)
  return found
}
const roleId = (name: string): RoleId => {
  const found = roleIds[name]
  if (found === undefined) throw new Error(`fixture: ${name}`)
  return found
}
const { "lab-media": _media, ...storedChannels } = channelIds
const allow = LabIds.targetOverwriteAllow.toString()

const channels: ReadonlyArray<Wire.Channel> = LabIds.channelSpecs
  .filter((spec) => spec.name !== "lab-media")
  .map((spec) => ({
    id: id(spec.name),
    type: spec.type,
    name: spec.name,
    parent_id: spec.type === 4 ? null : id("lab"),
    flags: 0,
    rate_limit_per_user: 0,
    permission_overwrites: [{ id: roleId("lab-target"), type: 0, allow, deny: "0" }],
    ...(spec.type === 15 ? { available_tags: [{ id: "700000000000000001", name: "lab-tag", moderated: false, emoji_id: null, emoji_name: null }] } : {})
  }))

const threads: ReadonlyArray<Wire.Channel> = LabIds.threadSpecs.map((spec) => ({
  id: id(spec.name),
  type: spec.type,
  name: spec.name,
  parent_id: id(spec.parent),
  rate_limit_per_user: 0,
  thread_metadata: { archived: false, locked: false, auto_archive_duration: 10080 }
}))

const roles: ReadonlyArray<Wire.Role> = [
  { id: RoleId.make(guildId), name: "@everyone", permissions: "0", position: 0, managed: false, mentionable: false },
  { id: RoleId.make("400000000000000099"), name: "Perms Harness", permissions: "8", position: 11, managed: true, mentionable: false, tags: { bot_id: context.harnessUserId } },
  ...LabIds.roleSpecs.map((spec, index) => ({ id: roleId(spec.name), name: spec.name, permissions: spec.permissions.toString(), position: 10 - index, managed: false, mentionable: spec.mentionable }))
]

const message = (n: number, author: UserId, type = 0): Wire.Message => ({ id: MessageId.make(`6000000000000000${String(n).padStart(2, "0")}`), type, author: { id: author }, pinned: false })

const baseline: Snapshot = {
  view: {
    state: { guildId, channels: storedChannels, roles: roleIds, unavailable: { "lab-media": { status: 400, code: 50024 } } },
    channels,
    roles,
    threads,
    subject: { user: { id: context.subjectUserId }, roles: [] },
    target: { user: { id: context.targetUserId }, roles: [roleId("lab-unmentionable"), roleId("lab-target")], nick: null, communication_disabled_until: null }
  },
  threadMembers: Object.fromEntries(LabIds.threadSpecs.map((spec) => [spec.name, [context.targetUserId]])),
  messages: {
    // kept: the forum post's starter, a human's message, and an "added to the thread" notice
    "lab-forum-post": [{ id: MessageId.make(id("lab-forum-post")), type: 0, author: { id: context.harnessUserId }, pinned: false }],
    "lab-text": [message(1, human)],
    "lab-public-thread": [message(2, context.harnessUserId, 1)]
  },
  pins: {},
  commands: [],
  autoModRules: ["Block Mention Spam"]
}

type Edit = (snapshot: Snapshot) => Snapshot
const view = (edit: (current: Reset.View) => Partial<Reset.View>): Edit => (snapshot) => ({ ...snapshot, view: { ...snapshot.view, ...edit(snapshot.view) } })
const channel = (name: string, edit: (current: Wire.Channel) => Wire.Channel): Edit =>
  view((current) => ({ channels: current.channels.map((entry) => (entry.id === id(name) ? edit(entry) : entry)) }))
const thread = (name: string, edit: (current: Wire.Channel) => Wire.Channel): Edit =>
  view((current) => ({ threads: current.threads.map((entry) => (entry.id === id(name) ? edit(entry) : entry)) }))
const role = (name: string, edit: (current: Wire.Role) => Wire.Role): Edit => view((current) => ({ roles: current.roles.map((entry) => (entry.name === name ? edit(entry) : entry)) }))
const metadata = (edit: Partial<NonNullable<Wire.Channel["thread_metadata"]>>) => (current: Wire.Channel): Wire.Channel => ({
  ...current,
  thread_metadata: { archived: false, locked: false, auto_archive_duration: 10080, ...edit }
})
const later = new Date(now + 60_000).toISOString()

const cases: ReadonlyArray<readonly [what: string, edit: Edit, expected: ReadonlyArray<readonly [object: string, field: string]>]> = [
  ["thread slowmode", thread("lab-public-thread", (current) => ({ ...current, rate_limit_per_user: 5 })), [["lab-public-thread", "slowmode"]]],
  ["thread name", thread("lab-private-thread", (current) => ({ ...current, name: "lab-private-thread-b" })), [["lab-private-thread", "name"]]],
  ["archived and locked thread", thread("lab-public-thread", metadata({ archived: true, locked: true })), [["lab-public-thread", "archived"], ["lab-public-thread", "locked"]]],
  ["thread auto-archive", thread("lab-announcement-thread", metadata({ auto_archive_duration: 60 })), [["lab-announcement-thread", "auto-archive"]]],
  ["@everyone permissions", role("@everyone", (current) => ({ ...current, permissions: "1024" })), [["@everyone", "permissions"]]],
  ["lab role permissions", role("lab-grant", (current) => ({ ...current, permissions: "2048" })), [["lab-grant", "permissions"]]],
  ["lab-admin without Administrator", role("lab-admin", (current) => ({ ...current, permissions: "0" })), [["lab-admin", "permissions"]]],
  ["mentionability", role("lab-mentionable", (current) => ({ ...current, mentionable: false })), [["lab-mentionable", "mentionable"]]],
  [
    "a leftover role the target holds",
    view((current) => ({
      roles: [...current.roles, { id: RoleId.make("400000000000000050"), name: "lab-selftest-role", permissions: "0", position: 1, managed: false, mentionable: false }],
      target: { ...current.target, roles: [...current.target.roles, RoleId.make("400000000000000050")] }
    })),
    [["lab-selftest-role", "leftover role"], ["target", "roles"]]
  ],
  ["the subject with a lab role", view((current) => ({ subject: { ...current.subject, roles: [roleId("lab-high")] } })), [["subject", "roles"]]],
  ["the target without lab-unmentionable", view((current) => ({ target: { ...current.target, roles: [roleId("lab-target")] } })), [["target", "roles"]]],
  ["nickname and timeout", view((current) => ({ subject: { ...current.subject, nick: "lab-nick", communication_disabled_until: later } })), [["subject", "nick"], ["subject", "timeout"]]],
  ["an expired timeout", view((current) => ({ target: { ...current.target, communication_disabled_until: new Date(now - 1000).toISOString() } })), []],
  ["channel slowmode", channel("lab-text", (current) => ({ ...current, rate_limit_per_user: 5 })), [["lab-text", "slowmode"]]],
  ["channel name", channel("lab-voice", (current) => ({ ...current, name: "lab-voice-b" })), [["lab-voice", "name"]]],
  ["channel parent", channel("lab-bots-only", (current) => ({ ...current, parent_id: null })), [["lab-bots-only", "parent"]]],
  [
    "an extra overwrite",
    channel("lab-text", (current) => ({ ...current, permission_overwrites: [...(current.permission_overwrites ?? []), { id: context.subjectUserId, type: 1, allow: "1024", deny: "0" }] })),
    [["lab-text", "overwrites"]]
  ],
  ["a deny on lab-target's overwrite", channel("lab-stage", (current) => ({ ...current, permission_overwrites: [{ id: roleId("lab-target"), type: 0, allow, deny: "64" }] })), [["lab-stage", "overwrites"]]],
  [
    "forum REQUIRE_TAG and tags",
    channel("lab-forum", (current) => ({ ...current, flags: 16, available_tags: [...(current.available_tags ?? []), { id: "2", name: "lab-selftest-tag", moderated: false, emoji_id: null, emoji_name: null }] })),
    [["lab-forum", "require-tag"], ["lab-forum", "tags"]]
  ],
  ["a leftover channel", view((current) => ({ channels: [...current.channels, { id: ChannelId.make("300000000000000080"), type: 0, name: "lab-selftest-channel" }] })), [["lab-selftest-channel", "leftover channel"]]],
  ["a missing channel", view((current) => ({ channels: current.channels.filter((entry) => entry.name !== "lab-announcement") })), [["lab-announcement", "missing"]]],
  [
    "scenario and foreign threads",
    view((current) => ({
      threads: [
        ...current.threads,
        { id: ChannelId.make("300000000000000081"), type: 12, name: "lab-selftest-private", parent_id: id("lab-text"), thread_metadata: { archived: true, locked: false, auto_archive_duration: 10080 } },
        { id: ChannelId.make("300000000000000082"), type: 11, name: "Thread", parent_id: id("lab-text") }
      ]
    })),
    [["lab-selftest-private", "scenario thread"], ["Thread", "foreign thread"]]
  ],
  [
    "thread membership",
    (snapshot) => ({ ...snapshot, threadMembers: { ...snapshot.threadMembers, "lab-private-thread": [context.subjectUserId, context.targetUserId], "lab-forum-post": [] } }),
    [["lab-private-thread", "subject member"], ["lab-forum-post", "target member"]]
  ],
  [
    "bot messages, but not system messages",
    (snapshot) => ({
      ...snapshot,
      messages: { ...snapshot.messages, "lab-text": [message(3, context.targetUserId), message(4, context.harnessUserId, 6)], "lab-voice": [message(5, context.harnessUserId, 2)] }
    }),
    [["lab-text", "bot message"]]
  ],
  [
    "a bot's pin notice (type 6) as the only leftover message",
    (snapshot) => ({ ...snapshot, messages: { ...snapshot.messages, "lab-voice": [message(6, context.harnessUserId, 6)] } }),
    [["lab-voice", "bot message"]]
  ],
  ["a missing stored role", view((current) => ({ roles: current.roles.filter((entry) => entry.name !== "lab-mid") })), [["lab-mid", "missing"]]],
  ["a missing stored thread", view((current) => ({ threads: current.threads.filter((entry) => entry.name !== "lab-announcement-thread") })), [["lab-announcement-thread", "missing"]]],
  ["@everyone absent from the role list", view((current) => ({ roles: current.roles.filter((entry) => entry.name !== "@everyone") })), [["@everyone", "missing"]]],
  [
    "permissions on the subject's and the target's managed roles",
    view((current) => ({
      roles: [
        ...current.roles,
        { id: RoleId.make("400000000000000060"), name: "Perms Subject", permissions: "2048", position: 2, managed: true, mentionable: false, tags: { bot_id: context.subjectUserId } },
        { id: RoleId.make("400000000000000061"), name: "Perms Target", permissions: "1", position: 1, managed: true, mentionable: false, tags: { bot_id: context.targetUserId } },
        { id: RoleId.make("400000000000000062"), name: "Perms Other", permissions: "8", position: 1, managed: true, mentionable: false, tags: { bot_id: human } }
      ]
    })),
    [["Perms Subject", "managed role permissions"], ["Perms Target", "managed role permissions"]]
  ],
  ["pins", (snapshot) => ({ ...snapshot, pins: { "lab-forum-post": [id("lab-forum-post")], "lab-stage": [] } }), [["lab-forum-post", "pins"]]],
  ["subject commands", (snapshot) => ({ ...snapshot, commands: ["labselftest"] }), [["subject", "commands"]]],
  ["a lab AutoMod rule", (snapshot) => ({ ...snapshot, autoModRules: [...snapshot.autoModRules, "lab-keyword"] }), [["lab-keyword", "automod"]]]
]

describe("the self-test's read-back", () => {
  it("finds nothing in a lab at baseline", () => {
    expect(baselineProblems(baseline, context, now)).toEqual([])
  })

  it.each(cases)("reports %s", (_what, edit, expected) => {
    expect(baselineProblems(edit(baseline), context, now).map((problem) => [problem.object, problem.field])).toEqual(expected)
  })

  it("names the dirt the read-back did not see", () => {
    const step = (label: string, shows: ReadonlyArray<readonly [string, string]>): DirtStep => ({ label, shows: shows.map(([object, field]) => ({ object, field })), apply: Effect.void })
    const steps = [step("threads", [["lab-public-thread", "slowmode"], ["lab-public-thread", "archived"]]), step("roles", [["@everyone", "permissions"]])]
    const seen = [{ object: "lab-public-thread", field: "slowmode", detail: "5" }, { object: "@everyone", field: "permissions", detail: "1024, not 0" }]
    expect(unseen(steps, seen)).toEqual(["lab-public-thread archived (threads)"])
    expect(unseen(steps, [...seen, { object: "lab-public-thread", field: "archived", detail: "yes" }])).toEqual([])
  })
})
