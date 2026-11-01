/**
 * Reset (DESIGN §5.7): brings Perms Lab back to its baseline and removes leftover test state. It is idempotent:
 * every step reads first and writes only what differs, so a second reset makes **zero** writes (M2's exit
 * check). Writes are counted at the shared base client (`Pacing`), not by this module.
 *
 * Steps, in order:
 *
 * 1. `@everyone` permissions to the baseline, which is empty (Rhys is the owner and unaffected).
 * 2. Delete `lab`/`lab-*` channels and `lab-*` roles that are not the stored lab objects.
 * 3. Members: the subject holds no lab role and the target exactly `lab-target` and `lab-unmentionable`; no
 *    nickname and no timeout on either; both bots' managed roles have no permissions. A subject or target
 *    holding a role outside the lab fails the reset (the guard may not touch it, and it would grant
 *    permissions the matrix does not control).
 * 4. Lab roles back to their spec (permissions, mentionable).
 * 5. Channels: name variant `a` (the spec name), slowmode 0, overwrites exactly `lab-target`'s allow (so
 *    every scenario's role and member overwrites are gone), forum and media `REQUIRE_TAG` off and tags back
 *    to `lab-tag`.
 * 6. Threads: enumerate active and archived threads (public archived, private archived, joined private
 *    archived) under lab channels; delete scenario threads; unarchive and unlock the provisioned threads,
 *    restore their names, slowmode 0 and auto-archive (10080 minutes); the subject is a member of none of them
 *    and the target of all of them (so it can post fixtures in the private thread).
 * 7. Pins and messages: delete every message the harness, the subject or the target wrote in a lab channel
 *    (bulk delete below 14 days, single deletes above), so untracked messages from a timed-out request go too.
 *    A forum post's starter message is kept, and system messages Discord does not allow deleting (a thread's
 *    "added to the thread" notices) are left. Every pinned message that is not deleted is unpinned first.
 * 8. The subject's guild commands to an empty list.
 * 9. AutoMod rules named `lab-*` deleted.
 *
 * Reset never touches `#rules`, `#mod-updates`, or anything outside the lab: the Lab guard refuses it.
 */
import { BunFileSystem } from "@effect/platform-bun"
import { Clock, Effect, Option, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { SubjectRaw } from "../src/bot/Internals.ts"
import type { ApplicationId, ChannelId, GuildId, MessageId, RoleId, UserId } from "../src/Snowflake.ts"
import { HarnessRest } from "./Identities.ts"
import type { IdentityReport } from "./IdentityCheck.ts"
import { isLabChannelName, isLabRoleName, isLabRuleName, LabCheckFailed, LabGuard, type LabRequestFailed, labStep } from "./Lab.ts"
import * as LabIds from "./LabIds.ts"
import { Pacing } from "./Pacing.ts"
import * as Wire from "./Wire.ts"

/** Who is who, from the identity checks. */
export interface Context {
  readonly guildId: GuildId
  readonly harnessUserId: UserId
  readonly subjectUserId: UserId
  readonly targetUserId: UserId
  readonly subjectApplicationId: ApplicationId
}

/** The reset context from the identity checks' report. */
export const contextFrom = (report: IdentityReport): Context => ({
  guildId: report.guild.id,
  harnessUserId: report.harness.userId,
  subjectUserId: report.subject.userId,
  targetUserId: report.target.userId,
  subjectApplicationId: report.subject.applicationId
})

// ---- pure decisions (unit-tested) ---------------------------------------------------------------------

/** A desired channel overwrite. */
export interface DesiredOverwrite {
  readonly id: string
  readonly type: 0 | 1
  readonly allow: bigint
  readonly deny: bigint
}

/** The baseline overwrites of every lab channel: `lab-target`'s allow, nothing else. */
export const baselineOverwrites = (labTargetRole: RoleId): ReadonlyArray<DesiredOverwrite> => [
  { id: labTargetRole, type: 0, allow: LabIds.targetOverwriteAllow, deny: 0n }
]

/** Whether a channel's overwrites are exactly `desired` (order ignored). */
export const overwritesMatch = (current: ReadonlyArray<Wire.Overwrite>, desired: ReadonlyArray<DesiredOverwrite>): boolean =>
  current.length === desired.length &&
  desired.every((want) => current.some((have) => have.id === want.id && have.type === want.type && BigInt(have.allow) === want.allow && BigInt(have.deny) === want.deny))

/** Whether a forum's tags are exactly the baseline tags (by name and moderation, no emoji; IDs ignored). */
export const tagsMatch = (current: ReadonlyArray<Wire.ForumTag>, baseline: ReadonlyArray<{ readonly name: string; readonly moderated: boolean }>): boolean =>
  current.length === baseline.length &&
  baseline.every((want) => current.some((have) => have.name === want.name && have.moderated === want.moderated && have.emoji_id === null && have.emoji_name === null))

/** The fields of a channel PATCH. Only differing fields are present. */
export interface ChannelPatch {
  readonly name?: string
  readonly parent_id?: ChannelId | null
  readonly rate_limit_per_user?: number
  readonly permission_overwrites?: ReadonlyArray<{ readonly id: string; readonly type: 0 | 1; readonly allow: number; readonly deny: number }>
  readonly flags?: number
  readonly available_tags?: ReadonlyArray<{ readonly name: string; readonly moderated: boolean }>
}

const isForumLike = (type: number): boolean => type === 15 || type === 16

/**
 * The PATCH that restores a stored channel to its spec, or `undefined` when it is already at baseline.
 * `parent` is the lab category for every channel but the category itself (`null`).
 */
export const channelPatch = (current: Wire.Channel, name: string, parent: ChannelId | null, overwrites: ReadonlyArray<DesiredOverwrite>): ChannelPatch | undefined => {
  const forum = isForumLike(current.type)
  const flags = current.flags ?? 0
  const patch: ChannelPatch = {
    ...(current.name !== name ? { name } : {}),
    ...((current.parent_id ?? null) !== parent ? { parent_id: parent } : {}),
    ...(current.rate_limit_per_user !== undefined && current.rate_limit_per_user !== 0 ? { rate_limit_per_user: 0 } : {}),
    ...(!overwritesMatch(current.permission_overwrites ?? [], overwrites)
      ? { permission_overwrites: overwrites.map((overwrite) => ({ id: overwrite.id, type: overwrite.type, allow: Number(overwrite.allow), deny: Number(overwrite.deny) })) }
      : {}),
    ...(forum && (flags & LabIds.requireTagFlag) !== 0 ? { flags: flags & ~LabIds.requireTagFlag } : {}),
    ...(forum && !tagsMatch(current.available_tags ?? [], LabIds.baselineTags) ? { available_tags: LabIds.baselineTags } : {})
  }
  return Object.keys(patch).length === 0 ? undefined : patch
}

/**
 * The fields of a thread PATCH. Of the scenario channel settings (§5.8 `channelSettings`), a thread has a name
 * and a slowmode; `requireTag` belongs to the parent forum. Threads have no overwrites and no parent to move.
 */
export interface ThreadPatch {
  readonly name?: string
  readonly rate_limit_per_user?: 0
  readonly archived?: false
  readonly locked?: false
  readonly auto_archive_duration?: 10080
}

/** The PATCH that restores a provisioned thread, or `undefined` when it is already at baseline. */
export const threadPatch = (current: Wire.Channel, name: string): ThreadPatch | undefined => {
  const metadata = current.thread_metadata
  const patch: ThreadPatch = {
    ...(current.name !== name ? { name } : {}),
    ...(current.rate_limit_per_user !== undefined && current.rate_limit_per_user !== 0 ? { rate_limit_per_user: 0 } : {}),
    ...(metadata?.archived === true ? { archived: false } : {}),
    ...(metadata?.locked === true ? { locked: false } : {}),
    ...(metadata !== undefined && metadata.auto_archive_duration !== LabIds.threadAutoArchiveMinutes ? { auto_archive_duration: 10080 } : {})
  }
  return Object.keys(patch).length === 0 ? undefined : patch
}

/** The role changes that bring a member to `baseline`. */
export interface RoleDiff {
  readonly add: ReadonlyArray<RoleId>
  readonly remove: ReadonlyArray<RoleId>
  /** Roles that are neither lab roles nor managed: reset refuses to continue. */
  readonly foreign: ReadonlyArray<RoleId>
}

/** Compares a member's roles with its baseline lab roles; managed roles are left alone. */
export const memberRoleDiff = (current: ReadonlyArray<RoleId>, baseline: ReadonlyArray<RoleId>, labRoles: ReadonlySet<string>, managedRoles: ReadonlySet<string>): RoleDiff => ({
  add: baseline.filter((role) => !current.includes(role)),
  remove: current.filter((role) => labRoles.has(role) && !baseline.includes(role)),
  foreign: current.filter((role) => !labRoles.has(role) && !managedRoles.has(role))
})

/** Discord's snowflake epoch (2015-01-01T00:00:00Z). */
const discordEpoch = 1420070400000n

/** The creation time of a snowflake, in Unix milliseconds. */
export const snowflakeTime = (id: string): number => Number((BigInt(id) >> 22n) + discordEpoch)

/** Bulk delete accepts messages younger than 14 days; an hour of margin keeps clock skew out of it (50034). */
export const bulkDeleteMaxAgeMs = 14 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000

/** How to delete a channel's messages: bulk chunks (2 to 100 recent messages) and single deletes. */
export interface DeletePlan {
  readonly bulk: ReadonlyArray<ReadonlyArray<MessageId>>
  readonly single: ReadonlyArray<MessageId>
}

/**
 * Message types Discord never lets anyone delete (message.mdx "Message Types", the Deletable column): recipient
 * add and remove (posted when the harness adds the target to a thread or removes the subject), call, channel
 * name and icon changes, and thread starter messages. Deleting one answers 403 50021 (seen live in M2).
 */
export const undeletableTypes: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 21])

/** Plans the deletion of every deletable message by `authors` except `keep`, at `now`. */
export const planDeletes = (messages: ReadonlyArray<Wire.Message>, authors: ReadonlySet<string>, keep: ReadonlySet<string>, now: number): DeletePlan => {
  const doomed = messages.filter((message) => authors.has(message.author.id) && !keep.has(message.id) && !undeletableTypes.has(message.type))
  const recent = doomed.filter((message) => now - snowflakeTime(message.id) < bulkDeleteMaxAgeMs).map((message) => message.id)
  const old = doomed.filter((message) => now - snowflakeTime(message.id) >= bulkDeleteMaxAgeMs).map((message) => message.id)
  const chunks: Array<ReadonlyArray<MessageId>> = []
  for (let start = 0; start < recent.length; start += 100) chunks.push(recent.slice(start, start + 100))
  const bulk = chunks.filter((chunk) => chunk.length >= 2)
  const leftover = chunks.filter((chunk) => chunk.length < 2).flat()
  return { bulk, single: [...leftover, ...old] }
}

/**
 * The pins to remove before deleting: every pinned message the plan does not delete (a human's message, a
 * forum post's starter, an undeletable system message). Deleting a message removes its pin with it.
 */
export const planUnpins = (pinned: ReadonlyArray<MessageId>, plan: DeletePlan): ReadonlyArray<MessageId> => {
  const deleted = new Set<string>([...plan.bulk.flat(), ...plan.single])
  return pinned.filter((id) => !deleted.has(id))
}

// ---- reading the lab ----------------------------------------------------------------------------------

/** What the harness read of the lab, with every lab object admitted to the guard. */
export interface View {
  readonly state: LabIds.LabState
  /** The guild's channels (threads are not listed by this route). */
  readonly channels: ReadonlyArray<Wire.Channel>
  readonly roles: ReadonlyArray<Wire.Role>
  /** Threads under stored lab channels: active and archived, by ID. */
  readonly threads: ReadonlyArray<Wire.Channel>
  readonly subject: Wire.Member
  readonly target: Wire.Member
}

const decodeArray = <S extends Schema.Codec<unknown, unknown>>(schema: S, what: string) => Wire.decode(Schema.Array(schema), what)

/** The ID stored for a lab name, if any. */
export const stored = (record: Readonly<Record<string, string>>, name: string): string | undefined => record[name]

const pages = <A>(first: Effect.Effect<{ readonly items: ReadonlyArray<A>; readonly next: Option.Option<string> }, LabRequestFailed, HarnessRest>, next: (cursor: string) => typeof first) =>
  Effect.gen(function* () {
    const all: Array<A> = []
    let page = yield* first
    all.push(...page.items)
    while (Option.isSome(page.next)) {
      page = yield* next(page.next.value)
      all.push(...page.items)
    }
    const result: ReadonlyArray<A> = all
    return result
  })

const threadsUnder = (parent: Wire.Channel) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const archiveCursor = (threads: ReadonlyArray<Wire.Channel>, hasMore: boolean | undefined) => {
      const last = threads.at(-1)?.thread_metadata?.archive_timestamp
      return hasMore === true && last !== undefined && last !== null ? Option.some(last) : Option.none()
    }
    const publicPage = (before: string | undefined) =>
      rest.listPublicArchivedThreads(parent.id, { limit: 100, ...(before === undefined ? {} : { before }) }).pipe(
        labStep(`reset: list public archived threads of ${parent.name}`),
        Effect.flatMap(Wire.decode(Wire.ThreadPage, "listPublicArchivedThreads")),
        Effect.map((page) => ({ items: page.threads, next: archiveCursor(page.threads, page.has_more) }))
      )
    const archived = [...(yield* pages(publicPage(undefined), publicPage))]
    if (parent.type === 0) {
      const privatePage = (before: string | undefined) =>
        rest.listPrivateArchivedThreads(parent.id, { limit: 100, ...(before === undefined ? {} : { before }) }).pipe(
          labStep(`reset: list private archived threads of ${parent.name}`),
          Effect.flatMap(Wire.decode(Wire.ThreadPage, "listPrivateArchivedThreads")),
          Effect.map((page) => ({ items: page.threads, next: archiveCursor(page.threads, page.has_more) }))
        )
      archived.push(...(yield* pages(privatePage(undefined), privatePage)))
      const joinedPage = (before: string | undefined) =>
        rest.listMyPrivateArchivedThreads(parent.id, { limit: 100, ...(before === undefined ? {} : { before }) }).pipe(
          labStep(`reset: list joined private archived threads of ${parent.name}`),
          Effect.flatMap(Wire.decode(Wire.ThreadPage, "listMyPrivateArchivedThreads")),
          Effect.map((page) => {
            const last = page.threads.at(-1)?.id
            return { items: page.threads, next: page.has_more === true && last !== undefined ? Option.some<string>(last) : Option.none<string>() }
          })
        )
      archived.push(...(yield* pages(joinedPage(undefined), joinedPage)))
    }
    return archived
  })

/** Reads the lab and admits every lab object it finds to the guard. Reads only. */
export const read = (context: Context): Effect.Effect<View, LabRequestFailed | LabCheckFailed | PlatformError, HarnessRest | LabGuard> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const guard = yield* LabGuard
    const state = yield* LabIds.load(context.guildId).pipe(Effect.provide(BunFileSystem.layer))
    const channels = yield* rest.listGuildChannels(context.guildId).pipe(labStep("reset: list channels"), Effect.flatMap(decodeArray(Wire.Channel, "listGuildChannels")))
    const roles = yield* rest.listGuildRoles(context.guildId).pipe(labStep("reset: list roles"), Effect.flatMap(decodeArray(Wire.Role, "listGuildRoles")))
    const subject = yield* rest.getGuildMember(context.guildId, context.subjectUserId).pipe(labStep("reset: get subject member"), Effect.flatMap(Wire.decode(Wire.Member, "getGuildMember")))
    const target = yield* rest.getGuildMember(context.guildId, context.targetUserId).pipe(labStep("reset: get target member"), Effect.flatMap(Wire.decode(Wire.Member, "getGuildMember")))

    for (const channel of channels) if (isLabChannelName(channel.name)) yield* guard.admitChannel(channel)
    for (const role of roles) {
      const botId = role.tags?.bot_id
      if (isLabRoleName(role.name) || botId === context.subjectUserId || botId === context.targetUserId) yield* guard.admitRole({ id: role.id, name: role.name, botId })
    }

    const storedIds = new Set(Object.values(state.channels))
    const parents = channels.filter((channel) => storedIds.has(channel.id) && (channel.type === 0 || channel.type === 5 || isForumLike(channel.type)))
    const parentIds = new Set<string>(parents.map((parent) => parent.id))
    const active = yield* rest.getActiveGuildThreads(context.guildId).pipe(labStep("reset: list active threads"), Effect.flatMap(Wire.decode(Wire.ThreadPage, "getActiveGuildThreads")))
    const found = new Map<string, Wire.Channel>()
    for (const thread of active.threads) if (thread.parent_id !== undefined && thread.parent_id !== null && parentIds.has(thread.parent_id)) found.set(thread.id, thread)
    for (const parent of parents) for (const thread of yield* threadsUnder(parent)) found.set(thread.id, thread)
    const threads = [...found.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
    for (const thread of threads) if (isLabChannelName(thread.name)) yield* guard.admitChannel(thread)

    return { state, channels, roles, threads, subject, target }
  })

// ---- the steps ----------------------------------------------------------------------------------------

/** What a reset did, counted at the base client. */
export interface Result {
  readonly writes: number
  readonly writesByRoute: ReadonlyArray<readonly [route: string, count: number]>
  /** Things reset noticed but left alone (for example a thread in a lab channel without a lab name). */
  readonly notes: ReadonlyArray<string>
}

/** A one-line summary of a reset or provisioning result. */
export const summary = (result: Result): string =>
  [`writes ${result.writes}`, ...result.writesByRoute.map(([route, count]) => `${route} x${count}`), ...result.notes.map((note) => `note: ${note}`)].join("; ")

/** `@everyone`'s role ID is the guild ID. */
const isEveryone = (role: Wire.Role, guildId: string): boolean => role.id === guildId

const labRoleIds = (view: View): ReadonlySet<string> => new Set(view.roles.filter((role) => isLabRoleName(role.name)).map((role) => role.id))

const managedRoleOf = (view: View, user: UserId): Wire.Role | undefined => view.roles.find((role) => role.tags?.bot_id === user)

const restoreMembers = (context: Context, view: View) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const lab = labRoleIds(view)
    const managed = new Set<string>(view.roles.filter((role) => role.managed).map((role) => role.id))
    const targetBaseline = LabIds.targetBaselineRoles.flatMap((name) => {
      const role = view.roles.find((candidate) => candidate.id === stored(view.state.roles, name))
      return role === undefined ? [] : [role.id]
    })
    const now = yield* Clock.currentTimeMillis
    for (const [label, member, baseline] of [
      ["subject", view.subject, []],
      ["target", view.target, targetBaseline]
    ] as const) {
      const diff = memberRoleDiff(member.roles, baseline, lab, managed)
      if (diff.foreign.length > 0) {
        return yield* new LabCheckFailed({ check: "member roles", detail: `the ${label} holds roles outside the lab (${diff.foreign.join(", ")}); remove them by hand` })
      }
      for (const role of diff.remove) yield* rest.deleteGuildMemberRole(context.guildId, member.user.id, role).pipe(labStep(`reset: remove ${role} from the ${label}`))
      for (const role of diff.add) yield* rest.addGuildMemberRole(context.guildId, member.user.id, role).pipe(labStep(`reset: give the ${label} ${role}`))
      const timedOut = member.communication_disabled_until !== undefined && member.communication_disabled_until !== null && Date.parse(member.communication_disabled_until) > now
      const nicked = member.nick !== undefined && member.nick !== null
      if (timedOut || nicked) {
        yield* rest
          .updateGuildMember(context.guildId, member.user.id, { ...(nicked ? { nick: null } : {}), ...(timedOut ? { communication_disabled_until: null } : {}) })
          .pipe(labStep(`reset: clear the ${label}'s nickname and timeout`))
      }
    }
    for (const [label, user] of [["subject", context.subjectUserId], ["target", context.targetUserId]] as const) {
      const role = managedRoleOf(view, user)
      if (role !== undefined && role.permissions !== "0") {
        yield* rest.updateGuildRole(context.guildId, role.id, { permissions: 0 }).pipe(labStep(`reset: clear the ${label}'s managed role permissions`))
      }
    }
  })

const restoreRoles = (context: Context, view: View) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const everyone = view.roles.find((role) => isEveryone(role, context.guildId))
    if (everyone !== undefined && everyone.permissions !== "0") {
      yield* rest.updateGuildRole(context.guildId, everyone.id, { permissions: 0 }).pipe(labStep("reset: @everyone permissions to the baseline"))
    }
    for (const spec of LabIds.roleSpecs) {
      const role = view.roles.find((candidate) => candidate.id === stored(view.state.roles, spec.name))
      if (role === undefined) continue
      if (BigInt(role.permissions) !== spec.permissions || role.mentionable !== spec.mentionable) {
        yield* rest
          .updateGuildRole(context.guildId, role.id, { permissions: Number(spec.permissions), mentionable: spec.mentionable })
          .pipe(labStep(`reset: restore ${spec.name}`))
      }
    }
  })

/** The lab objects that are not the stored ones: `lab`/`lab-*` channels and `lab-*` roles. */
export const leftovers = (view: View): { readonly channels: ReadonlyArray<Wire.Channel>; readonly roles: ReadonlyArray<Wire.Role> } => {
  const storedChannels = new Set<string>(Object.values(view.state.channels))
  const storedRoles = new Set<string>(Object.values(view.state.roles))
  return {
    channels: view.channels.filter((channel) => isLabChannelName(channel.name) && !storedChannels.has(channel.id)),
    roles: view.roles.filter((role) => isLabRoleName(role.name) && !storedRoles.has(role.id))
  }
}

/**
 * The view after the leftovers are deleted: without those channels and roles, and without the deleted roles in
 * the two members' role lists (deleting a role removes it from every member).
 */
export const withoutLeftovers = (view: View): View => {
  const gone = leftovers(view)
  const channels = new Set<string>(gone.channels.map((channel) => channel.id))
  const roles = new Set<string>(gone.roles.map((role) => role.id))
  const member = (current: Wire.Member): Wire.Member => ({ ...current, roles: current.roles.filter((role) => !roles.has(role)) })
  return {
    ...view,
    channels: view.channels.filter((channel) => !channels.has(channel.id)),
    roles: view.roles.filter((role) => !roles.has(role.id)),
    subject: member(view.subject),
    target: member(view.target)
  }
}

const deleteLeftovers = (context: Context, view: View) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const gone = leftovers(view)
    for (const channel of [...gone.channels.filter((c) => c.type !== 4), ...gone.channels.filter((c) => c.type === 4)]) {
      yield* rest.deleteChannel(channel.id).pipe(labStep(`reset: delete leftover channel ${channel.name}`))
    }
    for (const role of gone.roles) {
      yield* rest.deleteGuildRole(context.guildId, role.id).pipe(labStep(`reset: delete leftover role ${role.name}`))
    }
    return withoutLeftovers(view)
  })

const restoreChannels = (view: View) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const labTarget = view.roles.find((role) => role.id === stored(view.state.roles, "lab-target"))
    if (labTarget === undefined) return
    const overwrites = baselineOverwrites(labTarget.id)
    const category = view.channels.find((candidate) => candidate.id === stored(view.state.channels, "lab"))
    for (const spec of LabIds.channelSpecs) {
      const channel = view.channels.find((candidate) => candidate.id === stored(view.state.channels, spec.name))
      if (channel === undefined) continue
      const parent = spec.type === 4 ? null : (category?.id ?? null)
      const patch = channelPatch(channel, spec.name, parent, overwrites)
      if (patch !== undefined) yield* rest.updateChannel(channel.id, patch).pipe(labStep(`reset: restore channel ${spec.name}`))
    }
  })

const restoreThreads = (context: Context, view: View) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const storedThreads = new Map<string, LabIds.ThreadName>()
    for (const spec of LabIds.threadSpecs) {
      const id = stored(view.state.channels, spec.name)
      if (id !== undefined) storedThreads.set(id, spec.name)
    }
    const notes: Array<string> = []
    for (const thread of view.threads) {
      if (storedThreads.has(thread.id)) continue
      if (!isLabChannelName(thread.name)) {
        notes.push(`thread ${thread.id} ("${thread.name}") in a lab channel has no lab name; left alone`)
        continue
      }
      yield* rest.deleteChannel(thread.id).pipe(labStep(`reset: delete scenario thread ${thread.name}`))
    }
    for (const thread of view.threads) {
      const name = storedThreads.get(thread.id)
      if (name === undefined) continue
      const patch = threadPatch(thread, name)
      if (patch !== undefined) yield* rest.updateChannel(thread.id, patch).pipe(labStep(`reset: restore thread ${name}`))
      const members = yield* rest.listThreadMembers(thread.id).pipe(labStep(`reset: list members of ${name}`), Effect.flatMap(decodeArray(Wire.ThreadMember, "listThreadMembers")))
      const ids = new Set<string>(members.map((member) => member.user_id))
      if (ids.has(context.subjectUserId)) yield* rest.deleteThreadMember(thread.id, context.subjectUserId).pipe(labStep(`reset: remove the subject from ${name}`))
      if (!ids.has(context.targetUserId)) yield* rest.addThreadMember(thread.id, context.targetUserId).pipe(labStep(`reset: add the target to ${name}`))
    }
    return notes
  })

const messageChannels = (view: View): ReadonlyArray<{ readonly id: ChannelId; readonly name: string }> => {
  const out: Array<{ readonly id: ChannelId; readonly name: string }> = []
  for (const spec of LabIds.channelSpecs) {
    if (spec.type === 4 || isForumLike(spec.type)) continue
    const channel = view.channels.find((candidate) => candidate.id === stored(view.state.channels, spec.name))
    if (channel !== undefined) out.push({ id: channel.id, name: spec.name })
  }
  for (const spec of LabIds.threadSpecs) {
    const thread = view.threads.find((candidate) => candidate.id === stored(view.state.channels, spec.name))
    if (thread !== undefined) out.push({ id: thread.id, name: spec.name })
  }
  return out
}

const cleanMessages = (context: Context, view: View) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const bots = new Set<string>([context.harnessUserId, context.subjectUserId, context.targetUserId])
    for (const channel of messageChannels(view)) {
      const pinPage = (before: string | undefined) =>
        rest.listPins(channel.id, { limit: 50, ...(before === undefined ? {} : { before }) }).pipe(
          labStep(`reset: list pins in ${channel.name}`),
          Effect.flatMap(Wire.decode(Wire.PinPage, "listPins")),
          Effect.map((page) => {
            const last = page.items.at(-1)?.pinned_at
            return { items: page.items, next: page.has_more && last !== undefined ? Option.some(last) : Option.none<string>() }
          })
        )
      const messagePage = (before: string | undefined) =>
        rest.listMessages(channel.id, { limit: 100, ...(before === undefined ? {} : { before }) }).pipe(
          labStep(`reset: list messages in ${channel.name}`),
          Effect.flatMap(decodeArray(Wire.Message, "listMessages")),
          Effect.map((messages) => {
            const last = messages.at(-1)?.id
            return { items: messages, next: messages.length === 100 && last !== undefined ? Option.some<string>(last) : Option.none<string>() }
          })
        )
      const messages = yield* pages(messagePage(undefined), messagePage)
      const plan = planDeletes(messages, bots, new Set([channel.id]), yield* Clock.currentTimeMillis)
      const pins = yield* pages(pinPage(undefined), pinPage)
      for (const id of planUnpins(pins.map((pin) => pin.message.id), plan)) yield* rest.deletePin(channel.id, id).pipe(labStep(`reset: unpin a message in ${channel.name}`))
      for (const chunk of plan.bulk) yield* rest.bulkDeleteMessages(channel.id, { messages: chunk }).pipe(labStep(`reset: bulk delete ${chunk.length} messages in ${channel.name}`))
      for (const id of plan.single) yield* rest.deleteMessage(channel.id, id).pipe(labStep(`reset: delete a message in ${channel.name}`))
    }
  })

const cleanCommandsAndAutoMod = (context: Context) =>
  Effect.gen(function* () {
    const subject = yield* SubjectRaw
    const commands = yield* subject
      .listGuildApplicationCommands(context.subjectApplicationId, context.guildId)
      .pipe(labStep("reset: list the subject's guild commands"), Effect.flatMap(decodeArray(Wire.Command, "listGuildApplicationCommands")))
    if (commands.length > 0) {
      yield* subject.bulkSetGuildApplicationCommands(context.subjectApplicationId, context.guildId, []).pipe(labStep("reset: clear the subject's guild commands"))
    }
    const rest = yield* HarnessRest
    const rules = yield* rest.listAutoModerationRules(context.guildId).pipe(labStep("reset: list AutoMod rules"), Effect.flatMap(decodeArray(Wire.AutoModRule, "listAutoModerationRules")))
    const guard = yield* LabGuard
    for (const rule of rules.filter((candidate) => isLabRuleName(candidate.name))) {
      yield* guard.admitAutoModRule(rule)
      yield* rest.deleteAutoModerationRule(context.guildId, rule.id).pipe(labStep(`reset: delete AutoMod rule ${rule.name}`))
    }
  })

/** Runs the whole reset. Returns the writes it made, counted at the base client. */
export const run = (context: Context): Effect.Effect<Result, LabRequestFailed | LabCheckFailed | PlatformError, HarnessRest | SubjectRaw | LabGuard | Pacing> =>
  Effect.gen(function* () {
    const pacing = yield* Pacing
    const before = yield* pacing.stats
    const initial = yield* read(context)
    yield* restoreRoles(context, initial)
    const view = yield* deleteLeftovers(context, initial)
    yield* restoreMembers(context, view)
    yield* restoreChannels(view)
    const notes = yield* restoreThreads(context, view)
    yield* cleanMessages(context, view)
    yield* cleanCommandsAndAutoMod(context)
    const after = yield* pacing.stats
    return { ...writesBetween(before, after), notes }
  })

/** The writes between two counter snapshots. */
export const writesBetween = (
  before: { readonly writesByRoute: ReadonlyArray<readonly [string, number]> },
  after: { readonly writesByRoute: ReadonlyArray<readonly [string, number]> }
): Omit<Result, "notes"> => {
  const earlier = new Map(before.writesByRoute)
  const writesByRoute = after.writesByRoute
    .map(([route, count]): readonly [string, number] => [route, count - (earlier.get(route) ?? 0)])
    .filter(([, count]) => count > 0)
  return { writes: writesByRoute.reduce((sum, [, count]) => sum + count, 0), writesByRoute }
}
