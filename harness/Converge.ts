/**
 * Converge (DESIGN §5.8, §5.10 steps 1-2): reads the lab as the harness sees it, then makes the minimal writes
 * that bring it to the desired state, in a fixed order:
 *
 * 1. take `lab-admin` from the subject and lift its timeout, when the desired state does not have them;
 * 2. `@everyone`'s and the lab roles' permissions, the subject's other lab roles, every lab channel's overwrites,
 *    and the scenario thread's subject membership (the thread is unarchived first if it has to be: membership
 *    cannot change in an archived thread);
 * 3. the timeout (10 minutes from now), so a timeout is never applied to an administrator (H-021);
 * 4. `lab-admin`.
 *
 * The scenario thread's archived and locked state is set after the fixtures are posted (`applyThreadState`),
 * because posting in an archived thread would unarchive it. A timeout Discord refuses makes the setup
 * unsupported (`bot-not-timeoutable`), which the row records instead of a result (§5.10).
 *
 * Every write goes through the harness's guarded, paced client and is counted there.
 */
import type { DiscordRESTError } from "dfx/DiscordREST"
import { Clock, Duration, Effect, Schema } from "effect"
import type { RoleId, UserId } from "../src/Snowflake.ts"
import { everyoneRoleId } from "../src/state/Snapshot.ts"
import { HarnessRest } from "./Identities.ts"
import { isLabRoleName, type LabRequestFailed, labStep } from "./Lab.ts"
import type * as LabIds from "./LabIds.ts"
import { channelName, type Desired, type Ids } from "./Materialize.ts"
import * as Reset from "./Reset.ts"
import * as Wire from "./Wire.ts"

/** How long Converge times the subject out for (L19); cleanup and reset lift it explicitly. */
export const timeoutLength = Duration.minutes(10)

/** What the harness reads to converge and to check the result. */
export interface LabView {
  readonly roles: ReadonlyArray<Wire.Role>
  readonly subject: Wire.Member
  /** The lab channels read (see {@link readView}). */
  readonly channels: ReadonlyArray<Wire.Channel>
  /** The scenario thread, when the scenario acts in one. */
  readonly thread: Wire.Channel | undefined
  /** The scenario thread's member user IDs. */
  readonly threadMembers: ReadonlyArray<string> | undefined
}

const decodeArray = <S extends Schema.Codec<unknown, unknown>>(schema: S, what: string) => Wire.decode(Schema.Array(schema), what)

const lookup = <K, V>(map: ReadonlyMap<K, V>, key: K, what: string): Effect.Effect<V> => {
  const value = map.get(key)
  return value === undefined ? Effect.die(new Error(`converge: no ID for ${what}`)) : Effect.succeed(value)
}

/**
 * Reads the lab objects the desired state covers: the roles, the subject, the scenario thread and its members,
 * and the lab channels in `channels`, each with `getChannel`. The runner passes the channels whose overwrites
 * may differ from baseline (the scenario's, and those an earlier scenario or cleanup wrote); every other lab
 * channel is at baseline since the run's opening reset, because only Converge and cleanup write overwrites.
 * Reading single channels instead of the guild's channel list keeps clear of that route's rate limit (M3 live:
 * `GET /guilds/{id}/channels` answered 429 several times a run). Reads only.
 */
export const readView = (state: Desired, ids: Ids, channelNames: ReadonlySet<LabIds.ChannelName>): Effect.Effect<LabView, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const roles = yield* rest.listGuildRoles(ids.guildId).pipe(labStep("converge: list roles"), Effect.flatMap(decodeArray(Wire.Role, "listGuildRoles")))
    const subject = yield* rest.getGuildMember(ids.guildId, ids.subjectUserId).pipe(labStep("converge: get the subject"), Effect.flatMap(Wire.decode(Wire.Member, "getGuildMember")))
    const channels: Array<Wire.Channel> = []
    for (const name of [...channelNames].sort()) {
      const id = yield* lookup(ids.channels, name, name)
      channels.push(yield* rest.getChannel(id).pipe(labStep(`converge: get ${name}`), Effect.flatMap(Wire.decode(Wire.Channel, "getChannel"))))
    }
    if (state.thread === undefined) return { roles, subject, channels, thread: undefined, threadMembers: undefined }
    const threadId = yield* lookup(ids.channels, state.thread.name, state.thread.name)
    const thread = yield* rest.getChannel(threadId).pipe(labStep(`converge: get ${state.thread.name}`), Effect.flatMap(Wire.decode(Wire.Channel, "getChannel")))
    const members = yield* rest.listThreadMembers(threadId).pipe(labStep(`converge: members of ${state.thread.name}`), Effect.flatMap(decodeArray(Wire.ThreadMember, "listThreadMembers")))
    return { roles, subject, channels, thread, threadMembers: members.map((member) => member.user_id) }
  })

const isTimedOut = (until: string | null | undefined, now: number): boolean => until !== undefined && until !== null && Date.parse(until) > now

const roleIdOf = (ids: Ids, name: LabIds.RoleName): RoleId | undefined => ids.roles.get(name)

/** Every way the harness's view differs from the desired state, at `now` (for the channels it read). Empty when converged. */
export const readbackProblems = (state: Desired, ids: Ids, view: LabView, now: number, options: { readonly threadState: boolean } = { threadState: true }): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const everyone = view.roles.find((role) => role.id === everyoneRoleId(ids.guildId))
  if (everyone === undefined || BigInt(everyone.permissions) !== state.everyone) problems.push(`@everyone permissions ${everyone?.permissions ?? "missing"}, not ${state.everyone}`)
  for (const [name, permissions] of state.rolePermissions) {
    const role = view.roles.find((candidate) => candidate.id === roleIdOf(ids, name))
    if (role === undefined || BigInt(role.permissions) !== permissions) problems.push(`${name} permissions ${role?.permissions ?? "missing"}, not ${permissions}`)
  }
  const labRoles = new Set<string>([...ids.roles.values()])
  const held = view.subject.roles.filter((role) => labRoles.has(role)).toSorted()
  const wanted = state.subjectRoles.flatMap((name) => {
    const id = roleIdOf(ids, name)
    return id === undefined ? [] : [id]
  }).sort()
  if (held.join() !== wanted.join()) problems.push(`subject roles ${held.join(",") || "none"}, not ${wanted.join(",") || "none"}`)
  if (isTimedOut(view.subject.communication_disabled_until, now) !== state.subjectTimedOut) problems.push(`subject timeout ${view.subject.communication_disabled_until ?? "none"}`)
  for (const channel of view.channels) {
    const name = [...ids.channels].find(([, id]) => id === channel.id)?.[0]
    const overwrites = name === undefined ? undefined : state.overwrites.get(channelName(name))
    if (overwrites === undefined) problems.push(`channel ${channel.id} is not a lab channel the desired state covers`)
    else if (!Reset.overwritesMatch(channel.permission_overwrites ?? [], overwrites)) problems.push(`${name} overwrites differ`)
  }
  if (state.thread !== undefined) {
    const metadata = view.thread?.thread_metadata
    if (metadata === undefined) problems.push(`${state.thread.name} missing`)
    else if (options.threadState && (metadata.archived !== state.thread.archived || metadata.locked !== state.thread.locked)) {
      problems.push(`${state.thread.name} archived ${metadata.archived} locked ${metadata.locked}`)
    }
    const member = view.threadMembers?.includes(ids.subjectUserId) === true
    if (member !== state.thread.subjectMember) problems.push(`${state.thread.name} subject member ${member}`)
  }
  return problems
}

/** A permission bitfield as dfx's request types take it: a number, exact below 2^53 (every flag in use is). */
const wireNumber = (bits: bigint): Effect.Effect<number> =>
  bits <= BigInt(Number.MAX_SAFE_INTEGER) ? Effect.succeed(Number(bits)) : Effect.die(new Error(`converge: bitfield ${bits} is not exact as a number`))

const wireOverwrites = (overwrites: ReadonlyArray<{ readonly id: string; readonly type: 0 | 1; readonly allow: bigint; readonly deny: bigint }>) =>
  Effect.forEach(overwrites, (overwrite) =>
    Effect.all({ allow: wireNumber(overwrite.allow), deny: wireNumber(overwrite.deny) }).pipe(Effect.map(({ allow, deny }) => ({ id: overwrite.id, type: overwrite.type, allow, deny })))
  )

const viewBit = 1n << 10n

/**
 * Runs a thread-membership change for the subject with ViewChannel granted to it on `parent` through its member
 * overwrite (a member overwrite beats role and `@everyone` denies, H-008). The parent's overwrites are left
 * with that grant: the caller restores them.
 */
const withSubjectView = <A, R>(parent: Wire.Channel, subject: UserId, change: Effect.Effect<A, DiscordRESTError, R>, step: string): Effect.Effect<A, LabRequestFailed, R | HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const current = parent.permission_overwrites ?? []
    const own = current.find((overwrite) => overwrite.type === 1 && overwrite.id === subject)
    const granted = [
      ...current.filter((overwrite) => overwrite !== own).map((overwrite) => ({ id: overwrite.id, type: overwrite.type, allow: BigInt(overwrite.allow), deny: BigInt(overwrite.deny) })),
      { id: subject, type: 1 as const, allow: BigInt(own?.allow ?? "0") | viewBit, deny: BigInt(own?.deny ?? "0") & ~viewBit }
    ]
    yield* rest.updateChannel(parent.id, { permission_overwrites: yield* wireOverwrites(granted) }).pipe(labStep(`${step}: grant the subject View on the parent`))
    return yield* change.pipe(labStep(step))
  })

/** What Converge did. */
export type Converged =
  | { readonly _tag: "Converged" }
  /** Discord refused the subject's timeout. */
  | { readonly _tag: "TimeoutRefused"; readonly status: number; readonly code: number }
  /** The subject was to be a timed-out administrator, and the timeout did not survive the role (H-021). */
  | { readonly _tag: "AdminExempt" }

/** Brings the lab to `state` (see the module comment), except the scenario thread's archived and locked state. */
export const converge = (state: Desired, ids: Ids, channels: ReadonlySet<LabIds.ChannelName>): Effect.Effect<Converged, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const now = yield* Clock.currentTimeMillis
    const view = yield* readView(state, ids, channels)
    const subject: UserId = ids.subjectUserId
    const admin = yield* lookup(ids.roles, "lab-admin", "lab-admin")
    const wantsAdmin = state.subjectRoles.includes("lab-admin")
    const timedOut = isTimedOut(view.subject.communication_disabled_until, now)

    // 1. no administrator and no timeout unless wanted; an administrator cannot be timed out (403, H-021), so
    // lab-admin also goes while a timeout is still to be applied, and step 4 gives it back
    const applyingTimeout = state.subjectTimedOut && !timedOut
    if (view.subject.roles.includes(admin) && (!wantsAdmin || applyingTimeout)) yield* rest.deleteGuildMemberRole(ids.guildId, subject, admin).pipe(labStep("converge: take lab-admin"))
    if (timedOut && !state.subjectTimedOut) yield* rest.updateGuildMember(ids.guildId, subject, { communication_disabled_until: null }).pipe(labStep("converge: lift the timeout"))

    // 2. permissions, roles, overwrites, thread membership
    const everyone = view.roles.find((role) => role.id === everyoneRoleId(ids.guildId))
    if (everyone === undefined || BigInt(everyone.permissions) !== state.everyone) {
      yield* rest.updateGuildRole(ids.guildId, ids.guildId, { permissions: yield* wireNumber(state.everyone) }).pipe(labStep("converge: @everyone permissions"))
    }
    for (const [name, permissions] of state.rolePermissions) {
      const id = yield* lookup(ids.roles, name, name)
      const role = view.roles.find((candidate) => candidate.id === id)
      if (role !== undefined && BigInt(role.permissions) !== permissions) {
        yield* rest.updateGuildRole(ids.guildId, id, { permissions: yield* wireNumber(permissions) }).pipe(labStep(`converge: ${name} permissions`))
      }
    }
    const wanted = new Set<RoleId>()
    for (const name of state.subjectRoles) wanted.add(yield* lookup(ids.roles, name, name))
    for (const role of view.subject.roles) {
      const name = view.roles.find((candidate) => candidate.id === role)?.name
      if (role !== admin && name !== undefined && isLabRoleName(name) && !wanted.has(role)) {
        yield* rest.deleteGuildMemberRole(ids.guildId, subject, role).pipe(labStep(`converge: take ${name}`))
      }
    }
    for (const role of wanted) {
      if (role !== admin && !view.subject.roles.includes(role)) yield* rest.addGuildMemberRole(ids.guildId, subject, role).pipe(labStep("converge: give a lab role"))
    }
    // the thread membership first: Discord refuses to add a member who cannot view the parent (403 50001, M3
    // live), so the change is made with View granted through a temporary member overwrite on the parent, which
    // the overwrite step below then replaces with the desired overwrites
    let parentTouched: string | undefined
    if (state.thread !== undefined && view.thread !== undefined) {
      const member = view.threadMembers?.includes(subject) === true
      if (member !== state.thread.subjectMember) {
        if (view.thread.thread_metadata?.archived === true) yield* rest.updateChannel(view.thread.id, { archived: false }).pipe(labStep(`converge: unarchive ${state.thread.name}`))
        const parent = view.channels.find((candidate) => candidate.id === ids.channels.get(state.overwriteChannel))
        if (parent === undefined) return yield* Effect.die(new Error(`converge: ${state.overwriteChannel} missing`))
        yield* withSubjectView(parent, subject, state.thread.subjectMember ? rest.addThreadMember(view.thread.id, subject) : rest.deleteThreadMember(view.thread.id, subject), `converge: subject membership of ${state.thread.name}`)
        parentTouched = parent.id
      }
    }
    for (const [name, overwrites] of state.overwrites) {
      const id = yield* lookup(ids.channels, name, name)
      const channel = view.channels.find((candidate) => candidate.id === id)
      // a channel not read is at baseline, which is what the desired state has for every channel but the scenario's
      if (channel === undefined || (id !== parentTouched && Reset.overwritesMatch(channel.permission_overwrites ?? [], overwrites))) continue
      yield* rest.updateChannel(id, { permission_overwrites: yield* wireOverwrites(overwrites) }).pipe(labStep(`converge: overwrites of ${name}`))
    }

    // 3. the timeout, never on an administrator (H-021)
    if (applyingTimeout) {
      const until = new Date(now + Duration.toMillis(timeoutLength)).toISOString()
      const applied = yield* rest.updateGuildMember(ids.guildId, subject, { communication_disabled_until: until }).pipe(labStep("converge: time the subject out"), Effect.result)
      if (applied._tag === "Failure") {
        if (applied.failure.status === 0) return yield* Effect.fail(applied.failure)
        return { _tag: "TimeoutRefused", status: applied.failure.status, code: applied.failure.code }
      }
    }

    // 4. the administrator role last
    if (wantsAdmin && (applyingTimeout || !view.subject.roles.includes(admin))) yield* rest.addGuildMemberRole(ids.guildId, subject, admin).pipe(labStep("converge: give lab-admin"))
    if (wantsAdmin && applyingTimeout) {
      // M3 live: giving a timed-out member Administrator ends its timeout, so the setup cannot exist (H-021)
      const after = yield* rest.getGuildMember(ids.guildId, subject).pipe(labStep("converge: read the timed-out administrator"), Effect.flatMap(Wire.decode(Wire.Member, "getGuildMember")))
      if (!isTimedOut(after.communication_disabled_until, yield* Clock.currentTimeMillis)) return { _tag: "AdminExempt" }
    }
    return { _tag: "Converged" }
  })

/** Sets the scenario thread's archived and locked state (after the fixtures are posted). */
export const applyThreadState = (state: Desired, ids: Ids): Effect.Effect<void, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const thread = state.thread
    if (thread === undefined || (!thread.archived && !thread.locked)) return
    const rest = yield* HarnessRest
    const id = yield* lookup(ids.channels, thread.name, thread.name)
    // lock first, then archive: an archived thread accepts only an unarchiving edit
    if (thread.locked) yield* rest.updateChannel(id, { locked: true }).pipe(labStep(`converge: lock ${thread.name}`))
    if (thread.archived) yield* rest.updateChannel(id, { archived: true }).pipe(labStep(`converge: archive ${thread.name}`))
  })

/** The subject's thread membership is removed and the thread restored to baseline (cleanup, §5.10 step 9). */
export const restoreThread = (state: Desired, ids: Ids): Effect.Effect<void, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const thread = state.thread
    if (thread === undefined) return
    const rest = yield* HarnessRest
    const id = yield* lookup(ids.channels, thread.name, thread.name)
    const current = yield* rest.getChannel(id).pipe(labStep(`cleanup: get ${thread.name}`), Effect.flatMap(Wire.decode(Wire.Channel, "getChannel")))
    const patch = Reset.threadPatch(current, thread.name)
    if (patch !== undefined) yield* rest.updateChannel(id, patch).pipe(labStep(`cleanup: restore ${thread.name}`))
    const members = yield* rest.listThreadMembers(id).pipe(labStep(`cleanup: members of ${thread.name}`), Effect.flatMap(decodeArray(Wire.ThreadMember, "listThreadMembers")))
    if (members.some((member) => member.user_id === ids.subjectUserId)) {
      // as when adding: the change is made with View on the parent; the next converge (or reset) restores it
      const parentId = yield* lookup(ids.channels, state.overwriteChannel, state.overwriteChannel)
      const parent = yield* rest.getChannel(parentId).pipe(labStep(`cleanup: get ${state.overwriteChannel}`), Effect.flatMap(Wire.decode(Wire.Channel, "getChannel")))
      yield* withSubjectView(parent, ids.subjectUserId, rest.deleteThreadMember(id, ids.subjectUserId), `cleanup: remove the subject from ${thread.name}`)
    }
  })

/** Deletes every deletable bot message in `channel` (a forum post's starter is kept), catching untracked ones too. */
export const cleanMessages = (channel: { readonly id: string; readonly name: string }, authors: ReadonlySet<string>): Effect.Effect<void, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const messages = yield* rest.listMessages(channel.id, { limit: 100 }).pipe(labStep(`cleanup: list messages in ${channel.name}`), Effect.flatMap(decodeArray(Wire.Message, "listMessages")))
    const plan = Reset.planDeletes(messages, authors, new Set([channel.id]), yield* Clock.currentTimeMillis)
    for (const chunk of plan.bulk) yield* rest.bulkDeleteMessages(channel.id, { messages: chunk }).pipe(labStep(`cleanup: bulk delete in ${channel.name}`))
    for (const id of plan.single) yield* rest.deleteMessage(channel.id, id).pipe(labStep(`cleanup: delete in ${channel.name}`))
  })

/** Posts the harness's plain fixture message (no mentions) in `channel`; its ID. */
export const postHarnessMessage = (channelId: string): Effect.Effect<Wire.Message, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    return yield* rest
      .createMessage(channelId, { content: "lab fixture", allowed_mentions: { parse: [] } })
      .pipe(labStep("fixtures: harness message"), Effect.flatMap(Wire.decode(Wire.Message, "createMessage")))
  })

