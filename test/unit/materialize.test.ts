import { describe, expect, it } from "vitest"
import * as Converge from "../../harness/Converge.ts"
import * as LabIds from "../../harness/LabIds.ts"
import * as Materialize from "../../harness/Materialize.ts"
import { Setup } from "../../harness/scenario/Dsl.ts"
import type * as Wire from "../../harness/Wire.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import { reduce } from "../../src/state/Reducer.ts"
import { emptySnapshot, type Snapshot } from "../../src/state/Snapshot.ts"
import { RoleId, UserId } from "../../src/Snowflake.ts"
import { channelIdOf, fakeIds, labGuildId, roleIdOf } from "../support/lab.ts"

/**
 * Materialize (DESIGN §5.8): the desired lab state of a setup, its subject-observable projection, the
 * comparison of the subject's state with it, and the harness read-back's comparison with the desired state.
 */
const now = Date.parse("2026-11-01T12:00:00Z")
const bits = (...flags: Parameters<typeof Flags.fromFlags>[0] extends Iterable<infer F> ? ReadonlyArray<F> : never) => BigInt(Flags.fromFlags(flags))

describe("the desired state", () => {
  it("puts a thread's grants and removals on its parent, lab-grant's permissions on the role, and the subject's roles in spec order", () => {
    const setup = new Setup({
      channel: "public-thread",
      threadState: "locked",
      grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }],
      removals: [{ flags: ["SendMessagesInThreads"], via: "role-overwrite-deny" }],
      memberState: "timed-out",
      fixtures: []
    })
    const state = Materialize.desired(setup, fakeIds)
    expect(state.channel).toBe("lab-public-thread")
    expect(state.overwriteChannel).toBe("lab-text")
    expect(state.rolePermissions.get("lab-grant")).toBe(bits("ViewChannel", "SendMessagesInThreads"))
    expect(state.subjectRoles).toEqual(["lab-grant", "lab-deny"])
    expect(state.subjectTimedOut).toBe(true)
    expect(state.thread).toEqual({ name: "lab-public-thread", creator: "harness", archived: false, locked: true, subjectMember: false })
    expect(state.overwrites.get("lab-text")).toEqual([
      { id: roleIdOf("lab-target"), type: 0, allow: LabIds.targetOverwriteAllow, deny: 0n },
      { id: roleIdOf("lab-deny"), type: 0, allow: 0n, deny: bits("SendMessagesInThreads") }
    ])
    // every other available channel is at baseline; lab-media is unavailable
    expect(state.overwrites.get("lab-voice")).toEqual([{ id: roleIdOf("lab-target"), type: 0, allow: LabIds.targetOverwriteAllow, deny: 0n }])
    expect(state.overwrites.has("lab-media")).toBe(false)
  })

  it("lets a removal win within one overwrite, and keeps two roles' overwrites apart (H-006)", () => {
    const member = Materialize.desired(
      new Setup({ channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages"], via: "member-overwrite-allow" }], removals: [{ flags: ["ViewChannel"], via: "member-overwrite-deny" }], memberState: "normal", fixtures: [] }),
      fakeIds
    )
    expect(member.overwrites.get("lab-text")?.[1]).toEqual({ id: fakeIds.subjectUserId, type: 1, allow: bits("SendMessages"), deny: bits("ViewChannel") })
    const roles = Materialize.desired(
      new Setup({ channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role-overwrite-allow" }], removals: [{ flags: ["SendMessages"], via: "role-overwrite-deny" }], memberState: "normal", fixtures: [] }),
      fakeIds
    )
    expect(roles.overwrites.get("lab-text")?.slice(1)).toEqual([
      { id: roleIdOf("lab-allow"), type: 0, allow: bits("ViewChannel", "SendMessages"), deny: 0n },
      { id: roleIdOf("lab-deny"), type: 0, allow: 0n, deny: bits("SendMessages") }
    ])
  })

  it("gives @everyone the grant itself for `everyone`, and lab-admin for an administrator", () => {
    const everyone = Materialize.desired(new Setup({ channel: "voice", grants: [{ flags: ["ViewChannel", "Connect"], via: "everyone" }], removals: [], memberState: "normal", fixtures: [] }), fakeIds)
    expect(everyone.everyone).toBe(bits("ViewChannel", "Connect"))
    const admin = Materialize.desired(new Setup({ channel: "text", grants: [{ flags: [], via: "administrator" }], removals: [], memberState: "normal", fixtures: [] }), fakeIds)
    expect(admin.subjectRoles).toEqual(["lab-admin"])
  })
})

describe("the projection", () => {
  const hiddenText = Materialize.desired(new Setup({ channel: "private-thread", subjectThreadMember: true, grants: [{ flags: ["SendMessagesInThreads"], via: "role" }], removals: [], memberState: "normal", fixtures: [] }), fakeIds)

  it("marks a channel the subject cannot view as hidden, and a thread under it as not observable", () => {
    const projection = Materialize.project(hiddenText, fakeIds, now)
    expect(projection.channels.get("lab-text")?._tag).toBe("Hidden")
    expect(projection.thread).toBeUndefined()
    const visible = Materialize.desired(new Setup({ channel: "private-thread", subjectThreadMember: true, grants: [{ flags: ["ViewChannel"], via: "everyone" }], removals: [], memberState: "normal", fixtures: [] }), fakeIds)
    const shown = Materialize.project(visible, fakeIds, now)
    expect(shown.channels.get("lab-text")?._tag).toBe("Visible")
    expect(shown.thread).toEqual({ id: channelIdOf("lab-private-thread"), archived: false, locked: false, subjectMember: true })
  })

  it("does not observe a private thread the subject is not in (H-033)", () => {
    const nonMember = Materialize.desired(new Setup({ channel: "private-thread", subjectThreadMember: false, grants: [{ flags: ["ViewChannel"], via: "everyone" }], removals: [], memberState: "normal", fixtures: [] }), fakeIds)
    expect(Materialize.project(nonMember, fakeIds, now).thread).toBeUndefined()
  })

  // the subject's state, built by the reducer from dispatches that match the desired state
  const stateFor = (state: Materialize.Desired, options: { readonly obfuscate?: ReadonlySet<string>; readonly skewRole?: boolean } = {}): Snapshot => {
    const roles = [
      { id: labGuildId, permissions: String(state.everyone), position: 0, managed: false },
      ...LabIds.roleSpecs.map((spec) => ({ id: roleIdOf(spec.name), permissions: String(options.skewRole === true && spec.name === "lab-grant" ? 1n : (state.rolePermissions.get(spec.name) ?? 0n)), position: 1, managed: false }))
    ]
    const channels = [...state.overwrites].map(([name, overwrites]) => ({
      id: channelIdOf(name),
      type: LabIds.channelSpecs.find((spec) => spec.name === name)?.type ?? 0,
      flags: options.obfuscate?.has(name) === true ? 1 << 17 : 0,
      permission_overwrites: overwrites.map((overwrite) => ({ id: overwrite.id, type: overwrite.type, allow: String(overwrite.allow), deny: String(overwrite.deny) }))
    }))
    const member = { user: { id: fakeIds.subjectUserId }, roles: state.subjectRoles.map(roleIdOf), communication_disabled_until: state.subjectTimedOut ? new Date(now + 600_000).toISOString() : null }
    const ready = reduce(emptySnapshot, "READY", { user: { id: fakeIds.subjectUserId } }).snapshot
    return reduce(ready, "GUILD_CREATE", { id: labGuildId, owner_id: fakeIds.ownerId, roles, channels, threads: [], members: [member] }).snapshot
  }

  it("matches a subject state that shows the desired lab, accepting a hidden channel either obfuscated or with its real overwrites", () => {
    const projection = Materialize.project(hiddenText, fakeIds, now)
    expect(Materialize.projectionProblems(projection, stateFor(hiddenText), labGuildId, now)).toEqual([])
    expect(Materialize.projectionProblems(projection, stateFor(hiddenText, { obfuscate: new Set(["lab-text"]) }), labGuildId, now)).toEqual([])
    // a visible channel must not be obfuscated
    const seen = Materialize.desired(new Setup({ channel: "text", grants: [{ flags: ["ViewChannel"], via: "everyone" }], removals: [], memberState: "normal", fixtures: [] }), fakeIds)
    expect(Materialize.projectionProblems(Materialize.project(seen, fakeIds, now), stateFor(seen, { obfuscate: new Set(["lab-voice"]) }), labGuildId, now)).toEqual([
      "lab-voice obfuscated, but the subject can view it"
    ])
    expect(Materialize.projectionProblems(projection, stateFor(hiddenText, { skewRole: true }), labGuildId, now)).toEqual([
      `role ${roleIdOf("lab-grant")} permissions 1, not ${bits("SendMessagesInThreads")}`
    ])
    expect(Materialize.projectionProblems(projection, stateFor(hiddenText), labGuildId, now + 700_000)).toEqual([])
    const timedOut = { ...hiddenText, subjectTimedOut: true }
    expect(Materialize.projectionProblems(Materialize.project(timedOut, fakeIds, now), stateFor(hiddenText), labGuildId, now)).toEqual(["subject timed out: false, not true"])
  })

  it("with the codec, requires a hidden channel obfuscated, and only the category may show its real overwrites (M7)", () => {
    const projection = Materialize.project(hiddenText, fakeIds, now, "codec")
    expect(Materialize.projectionProblems(projection, stateFor(hiddenText), labGuildId, now)).toContain("lab-text shows its real overwrites, not obfuscated, though the subject cannot view it")
    const hiddenNames = [...projection.channels].filter(([, view]) => view._tag === "Hidden").map(([name]) => name)
    const obfuscated = stateFor(hiddenText, { obfuscate: new Set(hiddenNames.filter((name) => name !== "lab")) })
    expect(Materialize.projectionProblems(projection, obfuscated, labGuildId, now)).toEqual([])
    // what the wait resends: the hidden channels still shown with real overwrites, never the category
    expect(Materialize.staleUnobfuscated(projection, stateFor(hiddenText), labGuildId)).toEqual(hiddenNames.filter((name) => name !== "lab"))
    expect(Materialize.staleUnobfuscated(projection, obfuscated, labGuildId)).toEqual([])
    expect(Materialize.staleUnobfuscated(Materialize.project(hiddenText, fakeIds, now), stateFor(hiddenText), labGuildId)).toEqual([])
  })

  it("compares a hidden channel's real overwrites when the gateway delivers them unobfuscated", () => {
    const projection = Materialize.project(hiddenText, fakeIds, now)
    const stale: Materialize.Desired = { ...hiddenText, overwrites: new Map([...hiddenText.overwrites].map(([name, overwrites]) => [name, name === "lab-text" ? overwrites.slice(1) : overwrites])) }
    expect(Materialize.projectionProblems(projection, stateFor(stale), labGuildId, now)).toEqual(["lab-text overwrites differ"])
    // obfuscated, its (fake) overwrites are not compared
    expect(Materialize.projectionProblems(projection, stateFor(stale, { obfuscate: new Set(["lab-text"]) }), labGuildId, now)).toEqual([])
  })

  it("compares an observable thread's state and the subject's membership when the thread is present", () => {
    const visible = Materialize.desired(
      new Setup({ channel: "private-thread", threadState: "locked", subjectThreadMember: true, grants: [{ flags: ["ViewChannel"], via: "everyone" }], removals: [], memberState: "normal", fixtures: [] }),
      fakeIds
    )
    const projection = Materialize.project(visible, fakeIds, now)
    const thread = (options: { readonly locked: boolean; readonly member: boolean }) => ({
      id: channelIdOf("lab-private-thread"),
      type: 12,
      parent_id: channelIdOf("lab-text"),
      thread_metadata: { archived: false, locked: options.locked },
      ...(options.member ? { member: {} } : {})
    })
    const withThread = (options: { readonly locked: boolean; readonly member: boolean }) => reduce(stateFor(visible), "THREAD_CREATE", { ...thread(options), guild_id: labGuildId }).snapshot
    expect(Materialize.projectionProblems(projection, withThread({ locked: true, member: true }), labGuildId, now)).toEqual([])
    expect(Materialize.projectionProblems(projection, withThread({ locked: false, member: true }), labGuildId, now)).toEqual([`thread ${channelIdOf("lab-private-thread")} archived false locked false, not false true`])
    expect(Materialize.projectionProblems(projection, withThread({ locked: true, member: false }), labGuildId, now)).toEqual([`thread ${channelIdOf("lab-private-thread")} subject member false, not true`])
    // absent is accepted: Discord does not always sync a channel's threads when it becomes visible
    expect(Materialize.projectionProblems(projection, stateFor(visible), labGuildId, now)).toEqual([])
  })
})

describe("the harness read-back", () => {
  const state = Materialize.desired(new Setup({ channel: "text", grants: [{ flags: ["ViewChannel"], via: "role" }], removals: [], memberState: "normal", fixtures: [] }), fakeIds)
  const view: Converge.LabView = {
    roles: [
      { id: RoleId.make(labGuildId), name: "@everyone", permissions: "0", position: 0, managed: false, mentionable: false },
      ...LabIds.roleSpecs.map((spec) => ({ id: roleIdOf(spec.name), name: spec.name, permissions: String(state.rolePermissions.get(spec.name) ?? 0n), position: 1, managed: false, mentionable: spec.mentionable }))
    ],
    subject: { user: { id: fakeIds.subjectUserId }, roles: [roleIdOf("lab-grant")], communication_disabled_until: null },
    target: { user: { id: fakeIds.targetUserId }, roles: [roleIdOf("lab-target"), roleIdOf("lab-unmentionable")], communication_disabled_until: null },
    channels: [...state.overwrites].map(([name, overwrites]): Wire.Channel => ({
      id: channelIdOf(name),
      type: 0,
      name,
      permission_overwrites: overwrites.map((overwrite) => ({ id: overwrite.id, type: overwrite.type, allow: String(overwrite.allow), deny: String(overwrite.deny) }))
    })),
    thread: undefined,
    threadMembers: undefined
  }

  it("is empty at the desired state and names each difference", () => {
    expect(Converge.readbackProblems(state, fakeIds, view, now)).toEqual([])
    expect(Converge.readbackProblems(state, fakeIds, { ...view, subject: { ...view.subject, roles: [] } }, now)).toEqual([`subject roles none, not ${roleIdOf("lab-grant")}`])
    expect(Converge.readbackProblems(state, fakeIds, { ...view, subject: { ...view.subject, communication_disabled_until: new Date(now + 60_000).toISOString() } }, now)).toHaveLength(1)
    expect(Converge.readbackProblems(state, fakeIds, { ...view, channels: view.channels.map((channel) => (channel.name === "lab-text" ? { ...channel, permission_overwrites: [] } : channel)) }, now)).toEqual(["lab-text overwrites differ"])
    const skewed = view.roles.map((role) => (role.id === roleIdOf("lab-grant") ? { ...role, permissions: "0" } : role))
    expect(Converge.readbackProblems(state, fakeIds, { ...view, roles: skewed }, now)).toEqual([`lab-grant permissions 0, not ${bits("ViewChannel")}`])
    const everyone = view.roles.map((role) => (role.id === RoleId.make(labGuildId) ? { ...role, permissions: "1024" } : role))
    expect(Converge.readbackProblems(state, fakeIds, { ...view, roles: everyone }, now)).toEqual(["@everyone permissions 1024, not 0"])
  })

  it("checks the target's lab roles, nickname and timeout", () => {
    const ranked = Materialize.desired(new Setup({ channel: "text", grants: [], removals: [], memberState: "normal", targetRank: "above", targetAdmin: true, fixtures: [] }), fakeIds)
    expect(ranked.subjectRoles).toEqual(["lab-mid"])
    expect(ranked.targetRoles).toEqual(["lab-high", "lab-admin", "lab-target", "lab-unmentionable"])
    const rankedView: Converge.LabView = {
      ...view,
      roles: view.roles.map((role) => ({ ...role, permissions: String(role.id === RoleId.make(labGuildId) ? 0n : (ranked.rolePermissions.get(LabIds.roleSpecs.find((spec) => roleIdOf(spec.name) === role.id)?.name ?? "lab-high") ?? 0n)) })),
      subject: { ...view.subject, roles: [roleIdOf("lab-mid")] },
      channels: view.channels.map((channel) => (channel.name === "lab-text" ? { ...channel, permission_overwrites: [{ id: roleIdOf("lab-target"), type: 0, allow: String(LabIds.targetOverwriteAllow), deny: "0" }] } : channel))
    }
    const held = (...names: ReadonlyArray<LabIds.RoleName>) => ({ ...rankedView, target: { ...rankedView.target, roles: names.map(roleIdOf) } })
    expect(Converge.readbackProblems(ranked, fakeIds, held("lab-high", "lab-admin", "lab-target", "lab-unmentionable"), now)).toEqual([])
    const sorted = (...names: ReadonlyArray<LabIds.RoleName>) => names.map(roleIdOf).sort().join(",")
    expect(Converge.readbackProblems(ranked, fakeIds, held("lab-target", "lab-unmentionable"), now)).toEqual([
      `target roles ${sorted("lab-target", "lab-unmentionable")}, not ${sorted("lab-high", "lab-admin", "lab-target", "lab-unmentionable")}`
    ])
    expect(Converge.readbackProblems(state, fakeIds, { ...view, target: { ...view.target, nick: "lab-nick" } }, now)).toEqual(["target nickname lab-nick"])
    expect(Converge.readbackProblems(state, fakeIds, { ...view, target: { ...view.target, communication_disabled_until: new Date(now + 60_000).toISOString() } }, now)).toHaveLength(1)
    // a role removal's subject holds the role first; its rank follows from it
    const removal = new Setup({ channel: "text", grants: [], removals: [], memberState: "normal", targetRank: "below", roleRank: "below", fixtures: ["target-role"] })
    expect(Materialize.desired(removal, fakeIds).targetRoles).toEqual(["lab-low", "lab-target", "lab-unmentionable"])
    expect(Materialize.assignedRoleOf(removal)).toBe("lab-low")
  })

  it("puts the scenario channel's slowmode and required tag in place, and everything else back to baseline", () => {
    const tagged = Materialize.desired(new Setup({ channel: "forum", channelSettings: { nameVariant: "a", slowmode: 0, requireTag: true }, grants: [], removals: [], memberState: "normal", fixtures: [] }), fakeIds)
    const forum: Wire.Channel = { id: channelIdOf("lab-forum"), type: 15, name: "lab-forum", flags: 0, rate_limit_per_user: 0 }
    expect(Converge.settingsPatch(tagged, fakeIds, forum)).toEqual({ flags: LabIds.requireTagFlag })
    expect(Converge.settingsPatch(tagged, fakeIds, { ...forum, flags: LabIds.requireTagFlag })).toBeUndefined()
    // another channel goes back to baseline: no slowmode, no required tag
    const text: Wire.Channel = { id: channelIdOf("lab-text"), type: 0, name: "lab-text", rate_limit_per_user: 5 }
    expect(Converge.settingsPatch(tagged, fakeIds, text)).toEqual({ rate_limit_per_user: 0 })
    expect(Converge.settingsPatch(state, fakeIds, { ...forum, flags: LabIds.requireTagFlag | 2 })).toEqual({ flags: 2 })
  })

  it("checks the scenario thread's state and the subject's membership of it", () => {
    const threaded = Materialize.desired(new Setup({ channel: "private-thread", threadState: "archived", subjectThreadMember: true, grants: [{ flags: ["ViewChannel"], via: "role" }], removals: [], memberState: "normal", fixtures: [] }), fakeIds)
    const thread = (archived: boolean): Wire.Channel => ({
      id: channelIdOf("lab-private-thread"),
      type: 12,
      name: "lab-private-thread",
      thread_metadata: { archived, locked: false, auto_archive_duration: 10080 }
    })
    const withThread = (archived: boolean, members: ReadonlyArray<string>): Converge.LabView => ({ ...view, thread: thread(archived), threadMembers: members.map((id) => UserId.make(id)) })
    expect(Converge.readbackProblems(threaded, fakeIds, withThread(true, [fakeIds.subjectUserId, fakeIds.targetUserId]), now)).toEqual([])
    expect(Converge.readbackProblems(threaded, fakeIds, withThread(true, [fakeIds.targetUserId]), now)).toEqual(["lab-private-thread subject member false"])
    expect(Converge.readbackProblems(threaded, fakeIds, withThread(false, [fakeIds.subjectUserId]), now)).toEqual(["lab-private-thread archived false locked false"])
    // before the fixtures are posted the archived state is not checked yet
    expect(Converge.readbackProblems(threaded, fakeIds, withThread(false, [fakeIds.subjectUserId]), now, { threadState: false })).toEqual([])
    expect(Converge.readbackProblems(threaded, fakeIds, { ...view, thread: undefined, threadMembers: undefined }, now)).toEqual(["lab-private-thread missing", "lab-private-thread subject member false"])
  })
})
