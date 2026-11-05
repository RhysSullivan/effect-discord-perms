/**
 * Converge (DESIGN §5.8, §5.10 steps 1-2): reads the lab as the harness sees it, then makes the minimal writes
 * that bring it to the desired state, in a fixed order:
 *
 * 1. take `lab-admin` from the subject and lift its timeout, when the desired state does not have them;
 * 2. `@everyone`'s and the lab roles' permissions, the subject's other lab roles, the target's lab roles (its
 *    baseline plus a members row's rank and role fixture), no nickname or timeout on the target, every read lab
 *    channel's overwrites and settings (the scenario channel's slowmode and required tag, baseline elsewhere),
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
import * as LabIds from "./LabIds.ts"
import { channelName, type Desired, type Ids } from "./Materialize.ts"
import * as Reset from "./Reset.ts"
import * as Wire from "./Wire.ts"

/** How long Converge times the subject out for (L19); cleanup and reset lift it explicitly. */
export const timeoutLength = Duration.minutes(10)

/** What the harness reads to converge and to check the result. */
export interface LabView {
  readonly roles: ReadonlyArray<Wire.Role>
  readonly subject: Wire.Member
  readonly target: Wire.Member
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
 * Parts of the harness's view the runner already holds current: a previous scenario's settled read-back, which
 * nothing has written since (§5.11, after the M6 verifier). Role permissions change only through Converge and reset,
 * the subject's roles and timeout only through Converge and the subject's fixtures, and the target's member state
 * through Converge and the member operations and probes, so the runner forgets each part when one of those may have
 * written it. A stale part would make Converge skip a write; the wait's comparison of the subject's own gateway state
 * with the projection (role permissions, the subject's roles and timeout) would then time out rather than let the row
 * run on the wrong setup.
 */
export interface KnownView {
  readonly roles: ReadonlyArray<Wire.Role> | undefined
  readonly subject: Wire.Member | undefined
  readonly target: Wire.Member | undefined
}

/** Nothing known: Converge reads everything. */
export const unknownView: KnownView = { roles: undefined, subject: undefined, target: undefined }

/**
 * Independent reads run together (§5.11, before M9): each still takes its slot of the shared bucket, so they start
 * at most 10 a second, but no read waits for another's answer. A Converge or read-back makes at most a dozen (the
 * roles, two members, the read lab channels, the thread and its members), so the fan-out is bounded by the input.
 */
const together = { concurrency: "unbounded" } as const

/** The roles, as the harness reads them. */
const readRoles = (ids: Ids, step: string) =>
  Effect.flatMap(Effect.service(HarnessRest), (rest) => rest.listGuildRoles(ids.guildId).pipe(labStep(step), Effect.flatMap(decodeArray(Wire.Role, "listGuildRoles"))))

/** A member (the subject or the target), as the harness reads it. */
const readMember = (ids: Ids, user: UserId, step: string) =>
  Effect.flatMap(Effect.service(HarnessRest), (rest) => rest.getGuildMember(ids.guildId, user).pipe(labStep(step), Effect.flatMap(Wire.decode(Wire.Member, "getGuildMember"))))

/** A channel, as the harness reads it. */
const readChannel = (id: string, step: string) =>
  Effect.flatMap(Effect.service(HarnessRest), (rest) => rest.getChannel(id).pipe(labStep(step), Effect.flatMap(Wire.decode(Wire.Channel, "getChannel"))))

/** The scenario thread and its member user IDs, read together. */
const readThread = (threadId: string, prefix: string, name: string) =>
  Effect.all(
    {
      thread: readChannel(threadId, `${prefix}: get ${name}`),
      threadMembers: Effect.flatMap(Effect.service(HarnessRest), (rest) =>
        rest.listThreadMembers(threadId).pipe(
          labStep(`${prefix}: members of ${name}`),
          Effect.flatMap(decodeArray(Wire.ThreadMember, "listThreadMembers")),
          Effect.map((members): ReadonlyArray<string> => members.map((member) => member.user_id))
        )
      )
    },
    together
  )

/**
 * Reads the lab objects the desired state covers: the roles, the subject, the scenario thread and its members,
 * and the lab channels in `channels`, each with `getChannel`. The runner passes the channels whose overwrites
 * may differ from baseline (the scenario's, and those an earlier scenario or cleanup wrote); every other lab
 * channel is at baseline since the run's opening reset, because only Converge and cleanup write overwrites.
 * Reading single channels instead of the guild's channel list keeps clear of that route's rate limit (M3 live:
 * `GET /guilds/{id}/channels` answered 429 several times a run). The roles, the subject and the target are read
 * unless `known` holds them current. Reads only, all of them together (independent of each other).
 */
export const readView = (state: Desired, ids: Ids, channelNames: ReadonlySet<LabIds.ChannelName>, known: KnownView = unknownView): Effect.Effect<LabView, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const channelIds = yield* Effect.forEach([...channelNames].sort(), (name) => Effect.map(lookup(ids.channels, name, name), (id) => [name, id] as const))
    const threadId = state.thread === undefined ? undefined : yield* lookup(ids.channels, state.thread.name, state.thread.name)
    const threadName = state.thread?.name ?? ""
    const read = yield* Effect.all(
      {
        roles: known.roles === undefined ? readRoles(ids, "converge: list roles") : Effect.succeed(known.roles),
        subject: known.subject === undefined ? readMember(ids, ids.subjectUserId, "converge: get the subject") : Effect.succeed(known.subject),
        target: known.target === undefined ? readMember(ids, ids.targetUserId, "converge: get the target") : Effect.succeed(known.target),
        channels: Effect.forEach(channelIds, ([name, id]) => readChannel(id, `converge: get ${name}`), together),
        thread: threadId === undefined ? Effect.succeed(undefined) : readThread(threadId, "converge", threadName)
      },
      together
    )
    return { roles: read.roles, subject: read.subject, target: read.target, channels: read.channels, thread: read.thread?.thread, threadMembers: read.thread?.threadMembers }
  })

/**
 * What Converge (or the fixtures and the thread's state after it) wrote since its read, so the wait's read-back
 * re-reads only that (§5.10 step 3, after the M6 verifier): every other part of the harness's view is what Converge
 * read, which nothing has changed since, because only the harness writes during a scenario's setup.
 */
export interface Written {
  /** A role's permissions (`@everyone` included): the role list is read again. */
  readonly roles: boolean
  readonly subject: boolean
  readonly target: boolean
  /** The lab channels (by ID) whose overwrites or settings were written. */
  readonly channels: ReadonlySet<string>
  /** The scenario thread's state, its subject membership, or a message posted in it. */
  readonly thread: boolean
}

/** Nothing written. */
export const nothingWritten: Written = { roles: false, subject: false, target: false, channels: new Set(), thread: false }

/** `written` with the scenario thread marked as written too. */
export const withThreadWritten = (written: Written): Written => ({ ...written, thread: true })

/**
 * The harness's view after `written`: `view` with exactly the written parts read again (none when nothing was
 * written, so the read-back of a setup Converge found already in place makes no request). Reads only, all of them
 * together.
 */
export const rereadWritten = (state: Desired, ids: Ids, view: LabView, written: Written): Effect.Effect<LabView, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const threadId = state.thread === undefined || !written.thread ? undefined : yield* lookup(ids.channels, state.thread.name, state.thread.name)
    const threadName = state.thread?.name ?? ""
    const read = yield* Effect.all(
      {
        roles: written.roles ? readRoles(ids, "read-back: list roles") : Effect.succeed(view.roles),
        subject: written.subject ? readMember(ids, ids.subjectUserId, "read-back: get the subject") : Effect.succeed(view.subject),
        target: written.target ? readMember(ids, ids.targetUserId, "read-back: get the target") : Effect.succeed(view.target),
        channels: Effect.forEach(view.channels, (channel) => (written.channels.has(channel.id) ? readChannel(channel.id, "read-back: get a lab channel") : Effect.succeed(channel)), together),
        thread: threadId === undefined ? Effect.succeed({ thread: view.thread, threadMembers: view.threadMembers }) : readThread(threadId, "read-back", threadName)
      },
      together
    )
    return { roles: read.roles, subject: read.subject, target: read.target, channels: read.channels, thread: read.thread.thread, threadMembers: read.thread.threadMembers }
  })

const isTimedOut = (until: string | null | undefined, now: number): boolean => until !== undefined && until !== null && Date.parse(until) > now

const roleIdOf = (ids: Ids, name: LabIds.RoleName): RoleId | undefined => ids.roles.get(name)

const isForumType = (type: number): boolean => type === 15 || type === 16

/** The settings a read lab channel should have: the scenario channel's from the desired state, baseline for the rest. */
export const settingsOf = (state: Desired, ids: Ids, channel: Wire.Channel): { readonly slowmode: number; readonly requireTag: boolean } => {
  const scenario = ids.channels.get(state.channel) === channel.id
  return { slowmode: scenario ? state.settings.slowmode : 0, requireTag: scenario && isForumType(channel.type) && state.settings.requireTag }
}

/** How a read channel's settings differ from {@link settingsOf}, as a PATCH; `undefined` when they match. */
export const settingsPatch = (state: Desired, ids: Ids, channel: Wire.Channel): { readonly rate_limit_per_user?: number; readonly flags?: number } | undefined => {
  const want = settingsOf(state, ids, channel)
  const flags = channel.flags ?? 0
  const tagged = (flags & LabIds.requireTagFlag) !== 0
  const patch = {
    ...((channel.rate_limit_per_user ?? 0) !== want.slowmode ? { rate_limit_per_user: want.slowmode } : {}),
    ...(isForumType(channel.type) && tagged !== want.requireTag ? { flags: want.requireTag ? flags | LabIds.requireTagFlag : flags & ~LabIds.requireTagFlag } : {})
  }
  return Object.keys(patch).length === 0 ? undefined : patch
}

/** The target's lab roles, sorted, as the desired state has them. */
const wantedTargetRoles = (state: Desired, ids: Ids): ReadonlyArray<RoleId> =>
  state.targetRoles.flatMap((name) => {
    const id = roleIdOf(ids, name)
    return id === undefined ? [] : [id]
  }).sort()

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
  const targetHeld = view.target.roles.filter((role) => labRoles.has(role)).toSorted()
  const targetWanted = wantedTargetRoles(state, ids)
  if (targetHeld.join() !== targetWanted.join()) problems.push(`target roles ${targetHeld.join(",") || "none"}, not ${targetWanted.join(",") || "none"}`)
  if (isTimedOut(view.target.communication_disabled_until, now)) problems.push(`target timeout ${view.target.communication_disabled_until ?? "none"}`)
  if (view.target.nick !== undefined && view.target.nick !== null) problems.push(`target nickname ${view.target.nick}`)
  for (const channel of view.channels) {
    const name = [...ids.channels].find(([, id]) => id === channel.id)?.[0]
    const overwrites = name === undefined ? undefined : state.overwrites.get(channelName(name))
    if (overwrites === undefined) problems.push(`channel ${channel.id} is not a lab channel the desired state covers`)
    else if (!Reset.overwritesMatch(channel.permission_overwrites ?? [], overwrites)) problems.push(`${name} overwrites differ`)
    if (settingsPatch(state, ids, channel) !== undefined) problems.push(`${name ?? channel.id} settings differ`)
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
  /** The lab is at the desired state, as far as the writes go: `view` is what Converge read, `written` what it wrote since. */
  | { readonly _tag: "Converged"; readonly view: LabView; readonly written: Written }
  /** Discord refused the subject's timeout. */
  | { readonly _tag: "TimeoutRefused"; readonly status: number; readonly code: number }
  /** The subject was to be a timed-out administrator, and the timeout did not survive the role (H-021). */
  | { readonly _tag: "AdminExempt" }

/** Brings the lab to `state` (see the module comment), except the scenario thread's archived and locked state. */
export const converge = (state: Desired, ids: Ids, channels: ReadonlySet<LabIds.ChannelName>, known: KnownView = unknownView): Effect.Effect<Converged, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const now = yield* Clock.currentTimeMillis
    const view = yield* readView(state, ids, channels, known)
    const subject: UserId = ids.subjectUserId
    const admin = yield* lookup(ids.roles, "lab-admin", "lab-admin")
    const wantsAdmin = state.subjectRoles.includes("lab-admin")
    const timedOut = isTimedOut(view.subject.communication_disabled_until, now)
    let roles = false
    let subjectWritten = false
    let targetWritten = false
    const channelsWritten = new Set<string>()
    let threadWritten = false

    // 1. no administrator and no timeout unless wanted; an administrator cannot be timed out (403, H-021), so
    // lab-admin also goes while a timeout is still to be applied, and step 4 gives it back
    const applyingTimeout = state.subjectTimedOut && !timedOut
    if (view.subject.roles.includes(admin) && (!wantsAdmin || applyingTimeout)) {
      yield* rest.deleteGuildMemberRole(ids.guildId, subject, admin).pipe(labStep("converge: take lab-admin"))
      subjectWritten = true
    }
    if (timedOut && !state.subjectTimedOut) {
      yield* rest.updateGuildMember(ids.guildId, subject, { communication_disabled_until: null }).pipe(labStep("converge: lift the timeout"))
      subjectWritten = true
    }

    // 2. permissions, roles, overwrites, thread membership
    const everyone = view.roles.find((role) => role.id === everyoneRoleId(ids.guildId))
    if (everyone === undefined || BigInt(everyone.permissions) !== state.everyone) {
      yield* rest.updateGuildRole(ids.guildId, ids.guildId, { permissions: yield* wireNumber(state.everyone) }).pipe(labStep("converge: @everyone permissions"))
      roles = true
    }
    for (const [name, permissions] of state.rolePermissions) {
      const id = yield* lookup(ids.roles, name, name)
      const role = view.roles.find((candidate) => candidate.id === id)
      if (role !== undefined && BigInt(role.permissions) !== permissions) {
        yield* rest.updateGuildRole(ids.guildId, id, { permissions: yield* wireNumber(permissions) }).pipe(labStep(`converge: ${name} permissions`))
        roles = true
      }
    }
    const wanted = new Set<RoleId>()
    for (const name of state.subjectRoles) wanted.add(yield* lookup(ids.roles, name, name))
    for (const role of view.subject.roles) {
      const name = view.roles.find((candidate) => candidate.id === role)?.name
      if (role !== admin && name !== undefined && isLabRoleName(name) && !wanted.has(role)) {
        yield* rest.deleteGuildMemberRole(ids.guildId, subject, role).pipe(labStep(`converge: take ${name}`))
        subjectWritten = true
      }
    }
    for (const role of wanted) {
      if (role !== admin && !view.subject.roles.includes(role)) {
        yield* rest.addGuildMemberRole(ids.guildId, subject, role).pipe(labStep("converge: give a lab role"))
        subjectWritten = true
      }
    }
    // the target: its baseline and a members row's ranks, and no nickname or timeout left by an earlier row
    const targetWanted = new Set<RoleId>(wantedTargetRoles(state, ids))
    const labRoleIds = new Set<string>(ids.roles.values())
    for (const role of view.target.roles) {
      if (labRoleIds.has(role) && !targetWanted.has(role)) {
        yield* rest.deleteGuildMemberRole(ids.guildId, ids.targetUserId, role).pipe(labStep("converge: take a lab role from the target"))
        targetWritten = true
      }
    }
    for (const role of targetWanted) {
      if (!view.target.roles.includes(role)) {
        yield* rest.addGuildMemberRole(ids.guildId, ids.targetUserId, role).pipe(labStep("converge: give the target a lab role"))
        targetWritten = true
      }
    }
    const targetNicked = view.target.nick !== undefined && view.target.nick !== null
    const targetTimedOut = isTimedOut(view.target.communication_disabled_until, now)
    if (targetNicked || targetTimedOut) {
      yield* rest
        .updateGuildMember(ids.guildId, ids.targetUserId, { ...(targetNicked ? { nick: null } : {}), ...(targetTimedOut ? { communication_disabled_until: null } : {}) })
        .pipe(labStep("converge: clear the target's nickname and timeout"))
      targetWritten = true
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
        channelsWritten.add(parent.id)
        threadWritten = true
      }
    }
    for (const [name, overwrites] of state.overwrites) {
      const id = yield* lookup(ids.channels, name, name)
      const channel = view.channels.find((candidate) => candidate.id === id)
      // a channel not read is at baseline, which is what the desired state has for every channel but the scenario's
      if (channel === undefined) continue
      const settings = settingsPatch(state, ids, channel)
      const sameOverwrites = id !== parentTouched && Reset.overwritesMatch(channel.permission_overwrites ?? [], overwrites)
      if (sameOverwrites && settings === undefined) continue
      yield* rest
        .updateChannel(id, { ...(sameOverwrites ? {} : { permission_overwrites: yield* wireOverwrites(overwrites) }), ...settings })
        .pipe(labStep(`converge: overwrites and settings of ${name}`))
      channelsWritten.add(id)
    }

    // 3. the timeout, never on an administrator (H-021)
    if (applyingTimeout) {
      const until = new Date(now + Duration.toMillis(timeoutLength)).toISOString()
      subjectWritten = true
      const applied = yield* rest.updateGuildMember(ids.guildId, subject, { communication_disabled_until: until }).pipe(labStep("converge: time the subject out"), Effect.result)
      if (applied._tag === "Failure") {
        if (applied.failure.status === 0) return yield* Effect.fail(applied.failure)
        return { _tag: "TimeoutRefused", status: applied.failure.status, code: applied.failure.code }
      }
    }

    // 4. the administrator role last
    if (wantsAdmin && (applyingTimeout || !view.subject.roles.includes(admin))) {
      yield* rest.addGuildMemberRole(ids.guildId, subject, admin).pipe(labStep("converge: give lab-admin"))
      subjectWritten = true
    }
    if (wantsAdmin && applyingTimeout) {
      // M3 live: giving a timed-out member Administrator ends its timeout, so the setup cannot exist (H-021)
      const after = yield* rest.getGuildMember(ids.guildId, subject).pipe(labStep("converge: read the timed-out administrator"), Effect.flatMap(Wire.decode(Wire.Member, "getGuildMember")))
      if (!isTimedOut(after.communication_disabled_until, yield* Clock.currentTimeMillis)) return { _tag: "AdminExempt" }
    }
    return { _tag: "Converged", view, written: { roles, subject: subjectWritten, target: targetWritten, channels: channelsWritten, thread: threadWritten } }
  })

/**
 * Writes each of `names`' overwrites again, unchanged (they are the desired state's, which the read-back confirmed),
 * so Discord sends the channel to the subject again: obfuscated, when the subject cannot view it (the wait, M7).
 */
export const resendOverwrites = (state: Desired, ids: Ids, names: ReadonlyArray<LabIds.ChannelName>): Effect.Effect<void, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    for (const name of names) {
      const id = yield* lookup(ids.channels, name, name)
      const overwrites = yield* lookup(state.overwrites, name, `${name}'s overwrites`)
      yield* rest.updateChannel(id, { permission_overwrites: yield* wireOverwrites(overwrites) }).pipe(labStep(`wait: resend ${name} for the subject's obfuscation`))
    }
  })

/** Sets the scenario thread's archived and locked state (after the fixtures are posted); whether it wrote anything. */
export const applyThreadState = (state: Desired, ids: Ids): Effect.Effect<boolean, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const thread = state.thread
    if (thread === undefined || (!thread.archived && !thread.locked)) return false
    const rest = yield* HarnessRest
    const id = yield* lookup(ids.channels, thread.name, thread.name)
    // lock first, then archive: an archived thread accepts only an unarchiving edit
    if (thread.locked) yield* rest.updateChannel(id, { locked: true }).pipe(labStep(`converge: lock ${thread.name}`))
    if (thread.archived) yield* rest.updateChannel(id, { archived: true }).pipe(labStep(`converge: archive ${thread.name}`))
    return true
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

/**
 * Deletes every deletable bot message in `channel` (a forum post's starter is kept), catching untracked ones too.
 * A message the listing still shows but that is already gone (the subject's own delete a moment before) is
 * skipped (`Reset.deletePlanned`).
 */
export const cleanMessages = (channel: { readonly id: string; readonly name: string }, authors: ReadonlySet<string>): Effect.Effect<void, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const messages = yield* rest.listMessages(channel.id, { limit: 100 }).pipe(labStep(`cleanup: list messages in ${channel.name}`), Effect.flatMap(decodeArray(Wire.Message, "listMessages")))
    const plan = Reset.planDeletes(messages, authors, new Set([channel.id]), yield* Clock.currentTimeMillis)
    yield* Reset.deletePlanned(channel, plan, "cleanup")
  })

/** Posts the harness's plain fixture message (no mentions) in `channel`; its ID. */
export const postHarnessMessage = (channelId: string): Effect.Effect<Wire.Message, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    return yield* rest
      .createMessage(channelId, { content: "lab fixture", allowed_mentions: { parse: [] } })
      .pipe(labStep("fixtures: harness message"), Effect.flatMap(Wire.decode(Wire.Message, "createMessage")))
  })

