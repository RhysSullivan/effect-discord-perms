/**
 * Materialize (DESIGN §5.8): a symbolic `Setup` plus the lab's IDs becomes the desired lab state, and the
 * desired state becomes what the subject's gateway state can show of it (the subject-observable projection).
 * Pure: the offline tests (and M4's replay) use it with fake IDs.
 *
 * **The desired state.** Everything the matrix controls, for every lab object, so converging to it also
 * undoes the previous scenario: `@everyone`'s and every lab role's permissions, the subject's lab roles and
 * timeout, every available lab channel's overwrites (baseline: `lab-target`'s allow only), and the scenario
 * thread's state and the subject's membership of it. The other threads stay at baseline (cleanup restores the
 * one a scenario touched).
 *
 * Grants and removals, on the scenario channel (its parent for a thread, whose overwrites threads use, H-030):
 *
 * - `everyone`: `@everyone`'s permissions; `role`: `lab-grant`'s permissions, held by the subject;
 *   `role-overwrite-allow`: `lab-allow`'s overwrite allows, held by the subject; `member-overwrite-allow`: the
 *   subject's member overwrite allows; `everyone-overwrite-allow`: `@everyone`'s overwrite allows;
 *   `administrator`: the subject holds `lab-admin`.
 * - `role-overwrite-deny`: `lab-deny`'s overwrite denies, held by the subject; `member-overwrite-deny` and
 *   `everyone-overwrite-deny`: that overwrite denies. Within one overwrite a removal wins: the flag leaves its
 *   `allow`. Two different roles' overwrites aggregate instead (H-006), which some rows test on purpose.
 *
 * **The projection** (§5.8). The subject's gateway shows a channel it cannot view either obfuscated (H-160,
 * after Discord's switch or with the codec) or, before the switch, with its real overwrites, so both are
 * accepted for a channel the desired state hides from it. A thread under a hidden parent, or a private thread it
 * neither belongs to nor moderates, is not observable: Discord sends no events for it, and it is not compared.
 * An observable thread may also be absent, because Discord does not always sync threads of a channel that just
 * became visible; the library's refresh fetches it when it is needed.
 */
import type { PermissionFlag } from "../src/errors/Missing.generated.ts"
import * as Flags from "../src/permissions/Flags.ts"
import { blindMasks, type ChannelInput, type GuildInput, type MemberInput, resolve } from "../src/permissions/Resolver.ts"
import { type ChannelKind, type ChannelSnap, everyoneRoleId, kindOfType, type Overwrite, type RoleSnap, type Snapshot } from "../src/state/Snapshot.ts"
import type { ChannelId, GuildId, RoleId, UserId } from "../src/Snowflake.ts"
import * as LabIds from "./LabIds.ts"
import type { Setup } from "./scenario/Dsl.ts"

/** A lab channel or thread name. */
export type LabName = LabIds.ChannelName | LabIds.ThreadName

/** The lab's IDs (real ones live, fake ones offline). */
export interface Ids {
  readonly guildId: GuildId
  /** The guild owner (Rhys): never a subject of any check, but the resolver needs to know who it is. */
  readonly ownerId: UserId
  readonly subjectUserId: UserId
  readonly targetUserId: UserId
  readonly roles: ReadonlyMap<LabIds.RoleName, RoleId>
  readonly channels: ReadonlyMap<LabName, ChannelId>
  /** Lab channels Discord would not create here (`lab-media`, M2). */
  readonly unavailable: ReadonlySet<string>
}

/** A desired channel overwrite, with Discord's numeric type (0 role, 1 member). */
export interface DesiredOverwrite {
  readonly id: string
  readonly type: 0 | 1
  readonly allow: bigint
  readonly deny: bigint
}

/** The scenario thread's desired state. */
export interface DesiredThread {
  readonly name: LabIds.ThreadName
  readonly archived: boolean
  readonly locked: boolean
  /** The subject's membership, when the setup sets it (private threads); baseline otherwise (not a member). */
  readonly subjectMember: boolean
}

/** The desired lab state for one setup. */
export interface Desired {
  /** The lab channel or thread the scenario acts in. */
  readonly channel: LabName
  /** The lab channel whose overwrites apply: the channel itself, or a thread's parent. */
  readonly overwriteChannel: LabIds.ChannelName
  readonly everyone: bigint
  /** Every lab role's permissions. */
  readonly rolePermissions: ReadonlyMap<LabIds.RoleName, bigint>
  /** The lab roles the subject holds, in spec order. */
  readonly subjectRoles: ReadonlyArray<LabIds.RoleName>
  readonly subjectTimedOut: boolean
  /** Every available lab channel's overwrites (threads have none). */
  readonly overwrites: ReadonlyMap<LabIds.ChannelName, ReadonlyArray<DesiredOverwrite>>
  /** The scenario thread, when the scenario acts in one. */
  readonly thread: DesiredThread | undefined
}

/** The lab name of a scenario channel. */
export const labNameOf: { readonly [K in Setup["channel"]]: LabName } = {
  text: "lab-text",
  announcement: "lab-announcement",
  voice: "lab-voice",
  stage: "lab-stage",
  forum: "lab-forum",
  media: "lab-media",
  "forum-post": "lab-forum-post",
  "public-thread": "lab-public-thread",
  "private-thread": "lab-private-thread",
  "announcement-thread": "lab-announcement-thread"
}

const threadSpec = (name: LabName) => LabIds.threadSpecs.find((spec) => spec.name === name)
const channelSpec = (name: LabName) => LabIds.channelSpecs.find((spec) => spec.name === name)

/** The kind of a lab channel or thread, from its spec. */
export const kindOf = (name: LabName): ChannelKind => {
  const type = threadSpec(name)?.type ?? channelSpec(name)?.type
  const kind = type === undefined ? undefined : kindOfType(type)
  if (kind === undefined) throw new Error(`Materialize: ${name} has no modelled kind`)
  return kind
}

/** The channel whose overwrites a lab channel or thread uses (H-030). */
export const overwriteChannelOf = (name: LabName): LabIds.ChannelName => threadSpec(name)?.parent ?? channelName(name)

/** A lab channel's name, typed; a thread's name is a defect here. */
export const channelName = (name: LabName): LabIds.ChannelName => {
  const spec = channelSpec(name)
  if (spec === undefined) throw new Error(`Materialize: ${name} is not a lab channel`)
  return spec.name
}

const bitsOf = (flags: ReadonlyArray<PermissionFlag>): bigint => Flags.fromFlags(flags)

const lookup = <K, V>(map: ReadonlyMap<K, V>, key: K, what: string): V => {
  const value = map.get(key)
  if (value === undefined) throw new Error(`Materialize: no ID for ${what}`)
  return value
}

/** The desired lab state for `setup` (see the module comment). */
export const desired = (setup: Setup, ids: Ids): Desired => {
  const channel = labNameOf[setup.channel]
  const overwriteChannel = overwriteChannelOf(channel)
  let everyone = 0n
  const rolePermissions = new Map<LabIds.RoleName, bigint>(LabIds.roleSpecs.map((spec) => [spec.name, spec.permissions]))
  const held = new Set<LabIds.RoleName>()
  const scenario = new Map<string, DesiredOverwrite>()
  const edit = (id: string, type: 0 | 1, change: (current: DesiredOverwrite) => DesiredOverwrite) => {
    scenario.set(`${type}:${id}`, change(scenario.get(`${type}:${id}`) ?? { id, type, allow: 0n, deny: 0n }))
  }
  const role = (name: LabIds.RoleName) => lookup(ids.roles, name, name)
  for (const grant of setup.grants) {
    const bits = bitsOf(grant.flags)
    switch (grant.via) {
      case "everyone":
        everyone |= bits
        break
      case "role":
        rolePermissions.set("lab-grant", lookup(rolePermissions, "lab-grant", "lab-grant's permissions") | bits)
        held.add("lab-grant")
        break
      case "role-overwrite-allow":
        held.add("lab-allow")
        edit(role("lab-allow"), 0, (current) => ({ ...current, allow: current.allow | bits }))
        break
      case "member-overwrite-allow":
        edit(ids.subjectUserId, 1, (current) => ({ ...current, allow: current.allow | bits }))
        break
      case "everyone-overwrite-allow":
        edit(ids.guildId, 0, (current) => ({ ...current, allow: current.allow | bits }))
        break
      case "administrator":
        held.add("lab-admin")
        break
    }
  }
  for (const removal of setup.removals) {
    const bits = bitsOf(removal.flags)
    switch (removal.via) {
      case "absent":
        break
      case "role-overwrite-deny":
        held.add("lab-deny")
        edit(role("lab-deny"), 0, (current) => ({ ...current, deny: current.deny | bits }))
        break
      case "member-overwrite-deny":
        edit(ids.subjectUserId, 1, (current) => ({ ...current, allow: current.allow & ~bits, deny: current.deny | bits }))
        break
      case "everyone-overwrite-deny":
        edit(ids.guildId, 0, (current) => ({ ...current, allow: current.allow & ~bits, deny: current.deny | bits }))
        break
    }
  }
  const baseline: DesiredOverwrite = { id: role("lab-target"), type: 0, allow: LabIds.targetOverwriteAllow, deny: 0n }
  const overwrites = new Map<LabIds.ChannelName, ReadonlyArray<DesiredOverwrite>>()
  for (const spec of LabIds.channelSpecs) {
    if (ids.unavailable.has(spec.name)) continue
    overwrites.set(spec.name, spec.name === overwriteChannel ? [baseline, ...[...scenario.values()].filter((entry) => entry.allow !== 0n || entry.deny !== 0n)] : [baseline])
  }
  const spec = threadSpec(channel)
  const state = setup.threadState ?? "active"
  const thread: DesiredThread | undefined =
    spec === undefined
      ? undefined
      : {
        name: spec.name,
        archived: state === "archived" || state === "archived-locked",
        locked: state === "locked" || state === "archived-locked",
        subjectMember: setup.subjectThreadMember ?? false
      }
  return {
    channel,
    overwriteChannel,
    everyone,
    rolePermissions,
    subjectRoles: LabIds.roleSpecs.map((entry) => entry.name).filter((name) => held.has(name)),
    subjectTimedOut: setup.memberState === "timed-out",
    overwrites,
    thread
  }
}

/** A lab role's desired permissions (the desired state holds every lab role's). */
export const rolePermissionsOf = (state: Desired, name: LabIds.RoleName): bigint => lookup(state.rolePermissions, name, `${name}'s permissions`)

/** A lab role's ID. */
export const roleIdOf = (ids: Ids, name: LabIds.RoleName): RoleId => lookup(ids.roles, name, name)

// ---- resolver inputs over the desired state -----------------------------------------------------------

const toOverwrite = (overwrite: DesiredOverwrite): Overwrite => ({
  id: overwrite.id,
  type: overwrite.type === 0 ? "role" : "member",
  allow: Flags.fromBits(overwrite.allow),
  deny: Flags.fromBits(overwrite.deny)
})

/** The guild as the desired state has it: `@everyone` at position 0 and the lab roles at their provisioned positions. */
export const guildOf = (state: Desired, ids: Ids): GuildInput => {
  const roles = new Map<RoleId, RoleSnap>()
  const everyoneId = everyoneRoleId(ids.guildId)
  roles.set(everyoneId, { id: everyoneId, permissions: Flags.fromBits(state.everyone), position: 0, managed: false })
  LabIds.roleSpecs.forEach((spec, index) => {
    const id = lookup(ids.roles, spec.name, spec.name)
    roles.set(id, { id, permissions: Flags.fromBits(rolePermissionsOf(state, spec.name)), position: LabIds.roleSpecs.length - index, managed: false })
  })
  return { id: ids.guildId, ownerId: ids.ownerId, roles }
}

/** A lab channel or thread as the desired state has it. */
export const channelOf = (state: Desired, ids: Ids, name: LabName): ChannelSnap => {
  const kind = kindOf(name)
  const spec = threadSpec(name)
  const thread = state.thread?.name === name ? state.thread : undefined
  return {
    id: lookup(ids.channels, name, name),
    kind,
    parentId: spec === undefined ? (name === "lab" ? undefined : lookup(ids.channels, "lab", "lab")) : lookup(ids.channels, spec.parent, spec.parent),
    obfuscated: false,
    overwrites: spec === undefined ? lookup(state.overwrites, channelName(name), `${name}'s overwrites`).map(toOverwrite) : [],
    thread: spec === undefined ? undefined : { archived: thread?.archived ?? false, locked: thread?.locked ?? false, ownerId: undefined }
  }
}

/** The subject (`timedOutUntil` is the timeout's end when the desired state times it out) or the target. */
export const memberOf = (state: Desired, ids: Ids, who: "subject" | "target", timedOutUntil: string): MemberInput =>
  who === "subject"
    ? { userId: ids.subjectUserId, roleIds: state.subjectRoles.map((name) => lookup(ids.roles, name, name)), timedOutUntil: state.subjectTimedOut ? timedOutUntil : null }
    : { userId: ids.targetUserId, roleIds: LabIds.targetBaselineRoles.map((name) => lookup(ids.roles, name, name)), timedOutUntil: null }

/** The resolver's channel input for `name` over the desired state, for the subject or the target. */
export const channelInputOf = (state: Desired, ids: Ids, name: LabName, who: "subject" | "target"): ChannelInput => {
  const target = channelOf(state, ids, name)
  const spec = threadSpec(name)
  const member = who === "subject" ? state.thread?.name === name && state.thread.subjectMember : true
  return { _tag: "Known", channel: target, parent: spec === undefined ? undefined : channelOf(state, ids, spec.parent), threadMember: member }
}

// ---- the subject-observable projection ----------------------------------------------------------------

/** What the subject's gateway state must show for one lab channel. */
export type ChannelView =
  /** It can view the channel: the overwrites, exactly. */
  | { readonly _tag: "Visible"; readonly id: ChannelId; readonly overwrites: ReadonlyArray<DesiredOverwrite> }
  /** It cannot: obfuscated, or (before Discord's switch) these real overwrites. */
  | { readonly _tag: "Hidden"; readonly id: ChannelId; readonly overwrites: ReadonlyArray<DesiredOverwrite> }

/** The subject-observable projection of a desired state (see the module comment). */
export interface Projection {
  /** `@everyone`'s and every lab role's permissions, by role ID. */
  readonly roles: ReadonlyMap<RoleId, bigint>
  readonly subjectRoles: ReadonlySet<RoleId>
  readonly subjectTimedOut: boolean
  readonly channels: ReadonlyMap<LabIds.ChannelName, ChannelView>
  /** The scenario thread, if it is observable; `undefined` when there is none or it is not observable. */
  readonly thread: { readonly id: ChannelId; readonly archived: boolean; readonly locked: boolean; readonly subjectMember: boolean } | undefined
}

/** Whether the subject can view `name` in the desired state (no blind mask and ViewChannel effective). */
export const subjectSees = (state: Desired, ids: Ids, name: LabName, now: number): boolean => {
  const resolution = resolve({
    guild: guildOf(state, ids),
    channel: channelInputOf(state, ids, name, "subject"),
    member: memberOf(state, ids, "subject", new Date(now + 600_000).toISOString()),
    now
  })
  return !resolution.masks.some((mask) => blindMasks.has(mask)) && Flags.has(resolution.effective, "ViewChannel")
}

/** The projection of `state` (see the module comment). `now` places the desired timeout in the future. */
export const project = (state: Desired, ids: Ids, now: number): Projection => {
  const roles = new Map<RoleId, bigint>([[everyoneRoleId(ids.guildId), state.everyone]])
  for (const spec of LabIds.roleSpecs) roles.set(lookup(ids.roles, spec.name, spec.name), rolePermissionsOf(state, spec.name))
  const channels = new Map<LabIds.ChannelName, ChannelView>()
  for (const [name, overwrites] of state.overwrites) {
    const id = lookup(ids.channels, name, name)
    channels.set(name, subjectSees(state, ids, name, now) ? { _tag: "Visible", id, overwrites } : { _tag: "Hidden", id, overwrites })
  }
  const thread = state.thread
  return {
    roles,
    subjectRoles: new Set(state.subjectRoles.map((name) => lookup(ids.roles, name, name))),
    subjectTimedOut: state.subjectTimedOut,
    channels,
    thread:
      thread !== undefined && subjectSees(state, ids, thread.name, now)
        ? { id: lookup(ids.channels, thread.name, thread.name), archived: thread.archived, locked: thread.locked, subjectMember: thread.subjectMember }
        : undefined
  }
}

const sameOverwrites = (actual: ReadonlyArray<Overwrite>, expected: ReadonlyArray<DesiredOverwrite>): boolean =>
  actual.length === expected.length &&
  expected.every((want) =>
    actual.some((have) => have.id === want.id && have.type === (want.type === 0 ? "role" : "member") && have.allow === Flags.fromBits(want.allow) && have.deny === Flags.fromBits(want.deny))
  )

/**
 * How the subject's snapshot differs from the projection, at `now`. Empty when the subject's state shows the
 * desired lab.
 */
export const projectionProblems = (projection: Projection, snapshot: Snapshot, guildId: GuildId, now: number): ReadonlyArray<string> => {
  const guild = snapshot.guilds.get(guildId)
  if (guild === undefined) return ["no guild in the subject's state"]
  const problems: Array<string> = []
  for (const [id, permissions] of projection.roles) {
    const role = guild.roles.get(id)
    if (role === undefined) problems.push(`role ${id} missing`)
    else if (role.permissions !== Flags.fromBits(permissions)) problems.push(`role ${id} permissions ${role.permissions}, not ${permissions}`)
  }
  const member = guild.botMember
  if (member === undefined) problems.push("no bot member")
  else {
    const held = new Set<string>(member.roleIds.filter((id) => projection.roles.has(id)))
    const wanted = new Set<string>(projection.subjectRoles)
    if (held.size !== wanted.size || [...wanted].some((id) => !held.has(id))) problems.push(`subject roles ${[...held].join(",")}, not ${[...wanted].join(",")}`)
    const timedOut = member.timedOutUntil !== null && Date.parse(member.timedOutUntil) > now
    if (timedOut !== projection.subjectTimedOut) problems.push(`subject timed out: ${timedOut}, not ${projection.subjectTimedOut}`)
  }
  for (const [name, view] of projection.channels) {
    const channel = guild.channels.get(view.id)
    if (channel === undefined) {
      problems.push(`${name} missing`)
      continue
    }
    if (view._tag === "Hidden" && channel.obfuscated) continue
    if (channel.obfuscated) problems.push(`${name} obfuscated, but the subject can view it`)
    else if (!sameOverwrites(channel.overwrites, view.overwrites)) problems.push(`${name} overwrites differ`)
  }
  const thread = projection.thread
  if (thread !== undefined) {
    const channel = guild.channels.get(thread.id)
    if (channel !== undefined) {
      if (channel.thread?.archived !== thread.archived || channel.thread?.locked !== thread.locked) problems.push(`thread ${thread.id} state differs`)
      if ((guild.threadMembership.get(thread.id) === true) !== thread.subjectMember) problems.push(`thread ${thread.id} membership differs`)
    }
  }
  return problems
}
