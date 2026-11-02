import { describe, expect, it } from "vitest"
import * as Converge from "../../harness/Converge.ts"
import * as LabIds from "../../harness/LabIds.ts"
import * as Materialize from "../../harness/Materialize.ts"
import { Setup } from "../../harness/scenario/Dsl.ts"
import type * as Wire from "../../harness/Wire.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import { reduce } from "../../src/state/Reducer.ts"
import { emptySnapshot, type Snapshot } from "../../src/state/Snapshot.ts"
import { RoleId } from "../../src/Snowflake.ts"
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
    expect(state.thread).toEqual({ name: "lab-public-thread", archived: false, locked: true, subjectMember: false })
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
})

describe("the harness read-back", () => {
  const state = Materialize.desired(new Setup({ channel: "text", grants: [{ flags: ["ViewChannel"], via: "role" }], removals: [], memberState: "normal", fixtures: [] }), fakeIds)
  const view: Converge.LabView = {
    roles: [
      { id: RoleId.make(labGuildId), name: "@everyone", permissions: "0", position: 0, managed: false, mentionable: false },
      ...LabIds.roleSpecs.map((spec) => ({ id: roleIdOf(spec.name), name: spec.name, permissions: String(state.rolePermissions.get(spec.name) ?? 0n), position: 1, managed: false, mentionable: spec.mentionable }))
    ],
    subject: { user: { id: fakeIds.subjectUserId }, roles: [roleIdOf("lab-grant")], communication_disabled_until: null },
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
  })
})
