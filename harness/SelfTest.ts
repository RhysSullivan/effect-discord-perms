/**
 * The reset self-test (DESIGN §5.7), `bun run harness:selftest`. Re-run it whenever `Reset.ts` changes: the
 * other live checks run on a lab that is already clean, where a reset that wrote nothing would pass as well.
 *
 * 1. Reset, then read the lab back: it must be at baseline.
 * 2. Dirty the lab the way scenarios will, through the guarded identities ({@link dirtSteps}: every kind of
 *    state reset restores), and read it back: each step's dirt must show as a problem, so a blind read-back
 *    cannot pass.
 * 3. Reset, and read back: no problem may remain.
 * 4. Reset again: zero writes.
 *
 * The read-back's judgment ({@link baselineProblems}) is written from the spec in `LabIds.ts`, not from reset's
 * patch functions, so a field reset forgets (thread slowmode, which the M2 verifier found) shows up here.
 *
 * Left out, with reasons: channel and thread renames (Discord allows two name changes per channel per ten
 * minutes, H-162, and a rename plus its restore uses both, so a second self-test within ten minutes would
 * wait on a 429); AutoMod rules (the guard refuses to create them); messages older than 14 days (they cannot
 * be made); managed-role permissions (neither bot has a managed role in Perms Lab); pins in `lab-stage`
 * (Discord refuses them, 400 50019, M2).
 *
 * If a dirt step fails, the self-test resets before failing, so the lab is not left dirty.
 */
import { PermissionFlagsBits } from "discord-api-types/v10"
import { Clock, Effect, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { SubjectRaw } from "../src/bot/Internals.ts"
import { HarnessRest, TargetRest } from "./Identities.ts"
import { isLabChannelName, isLabRoleName, isLabRuleName, LabCheckFailed, LabGuard, type LabRequestFailed, labStep } from "./Lab.ts"
import * as LabIds from "./LabIds.ts"
import { Pacing } from "./Pacing.ts"
import * as Reset from "./Reset.ts"
import * as Wire from "./Wire.ts"

/** One way the lab differs from its baseline. */
export interface Problem {
  /** The lab object: a channel, thread or role name, `@everyone`, `subject` or `target`. */
  readonly object: string
  /** What differs, for example `slowmode` or `bot message`. */
  readonly field: string
  readonly detail: string
}

/** What the read-back reads: reset's view of the lab, plus memberships, messages, pins, commands and AutoMod. */
export interface Snapshot {
  readonly view: Reset.View
  /** The members of each provisioned thread, by thread name. */
  readonly threadMembers: Readonly<Record<string, ReadonlyArray<string>>>
  /** The latest page of messages in each lab channel and thread that holds messages, by name. */
  readonly messages: Readonly<Record<string, ReadonlyArray<Wire.Message>>>
  /** The pinned message IDs of those channels, by name. */
  readonly pins: Readonly<Record<string, ReadonlyArray<string>>>
  /** The subject's guild command names. */
  readonly commands: ReadonlyArray<string>
  /** The guild's AutoMod rule names. */
  readonly autoModRules: ReadonlyArray<string>
}

/** The lab channels and threads that hold messages: every channel but the category and forum-like ones. */
export const messageChannelNames: ReadonlyArray<string> = [
  ...LabIds.channelSpecs.filter((spec) => spec.type !== 4 && spec.type !== 15 && spec.type !== 16).map((spec) => spec.name),
  ...LabIds.threadSpecs.map((spec) => spec.name)
]

/**
 * Message types nobody can delete (message.mdx "Message Types", the Deletable column): recipient add and
 * remove, call, channel name and icon change, thread starter. Restated here rather than imported from
 * `Reset.ts`, so a change to reset's list does not silently change what the read-back accepts.
 */
const systemTypes: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 21])

const isTimedOut = (until: string | null | undefined, now: number): boolean => until !== undefined && until !== null && Date.parse(until) > now

/**
 * Every way `snapshot` differs from the baseline of §5.7, judged from the spec in `LabIds.ts` at `now`. Empty
 * when the lab is at baseline.
 */
export const baselineProblems = (snapshot: Snapshot, context: Reset.Context, now: number): ReadonlyArray<Problem> => {
  const { view } = snapshot
  const state = view.state
  const unavailable = state.unavailable ?? {}
  const problems: Array<Problem> = []
  const add = (object: string, field: string, detail: string) => {
    problems.push({ object, field, detail })
  }

  // `@everyone`'s role ID is the guild ID
  const everyoneId: string = context.guildId
  const everyone = view.roles.find((role) => role.id === everyoneId)
  if (everyone === undefined) add("@everyone", "missing", "not in the role list")
  else if (everyone.permissions !== "0") add("@everyone", "permissions", `${everyone.permissions}, not 0`)

  const storedRoles = new Set<string>(Object.values(state.roles))
  for (const spec of LabIds.roleSpecs) {
    const role = view.roles.find((candidate) => candidate.id === state.roles[spec.name])
    if (role === undefined) {
      add(spec.name, "missing", "no stored role in the guild")
      continue
    }
    if (BigInt(role.permissions) !== spec.permissions) add(spec.name, "permissions", `${role.permissions}, not ${spec.permissions}`)
    if (role.mentionable !== spec.mentionable) add(spec.name, "mentionable", `${role.mentionable}, not ${spec.mentionable}`)
  }
  for (const role of view.roles) {
    if (isLabRoleName(role.name) && !storedRoles.has(role.id)) add(role.name, "leftover role", role.id)
    const bot = role.tags?.bot_id
    if (role.managed && (bot === context.subjectUserId || bot === context.targetUserId) && role.permissions !== "0") {
      add(role.name, "managed role permissions", `${role.permissions}, not 0`)
    }
  }

  const managed = new Set<string>(view.roles.filter((role) => role.managed).map((role) => role.id))
  const targetBaseline = LabIds.targetBaselineRoles.flatMap((name) => {
    const id = state.roles[name]
    return id === undefined ? [] : [id]
  })
  for (const [label, member, baseline] of [
    ["subject", view.subject, []],
    ["target", view.target, targetBaseline]
  ] as const) {
    const held = member.roles.filter((role) => !managed.has(role)).toSorted()
    const wanted = [...baseline].sort()
    if (held.join() !== wanted.join()) add(label, "roles", `holds ${held.join(", ") || "none"}, not ${wanted.join(", ") || "none"}`)
    if (member.nick !== undefined && member.nick !== null) add(label, "nick", `"${member.nick}"`)
    if (isTimedOut(member.communication_disabled_until, now)) add(label, "timeout", `until ${member.communication_disabled_until}`)
  }

  const storedChannels = new Set<string>(Object.values(state.channels))
  const category = state.channels["lab"] ?? null
  const labTarget = state.roles["lab-target"]
  for (const spec of LabIds.channelSpecs) {
    if (unavailable[spec.name] !== undefined) continue
    const channel = view.channels.find((candidate) => candidate.id === state.channels[spec.name])
    if (channel === undefined) {
      add(spec.name, "missing", "no stored channel in the guild")
      continue
    }
    if (channel.name !== spec.name) add(spec.name, "name", `"${channel.name}"`)
    const parent = channel.parent_id ?? null
    const wantedParent = spec.type === 4 ? null : category
    if (parent !== wantedParent) add(spec.name, "parent", `${parent ?? "none"}, not ${wantedParent ?? "none"}`)
    if ((channel.rate_limit_per_user ?? 0) !== 0) add(spec.name, "slowmode", `${channel.rate_limit_per_user}`)
    const overwrites = channel.permission_overwrites ?? []
    const only = overwrites[0]
    const exact =
      overwrites.length === 1 && only !== undefined && only.id === labTarget && only.type === 0 && BigInt(only.allow) === LabIds.targetOverwriteAllow && BigInt(only.deny) === 0n
    if (!exact) add(spec.name, "overwrites", overwrites.map((overwrite) => `${overwrite.id}/${overwrite.type} +${overwrite.allow} -${overwrite.deny}`).join(" "))
    if (spec.type === 15 || spec.type === 16) {
      if (((channel.flags ?? 0) & LabIds.requireTagFlag) !== 0) add(spec.name, "require-tag", "on")
      const tags = channel.available_tags ?? []
      const atBaseline =
        tags.length === LabIds.baselineTags.length &&
        LabIds.baselineTags.every((want) => tags.some((tag) => tag.name === want.name && tag.moderated === want.moderated && tag.emoji_id === null && tag.emoji_name === null))
      if (!atBaseline) add(spec.name, "tags", tags.map((tag) => tag.name).join(", ") || "none")
    }
  }
  for (const channel of view.channels) if (isLabChannelName(channel.name) && !storedChannels.has(channel.id)) add(channel.name, "leftover channel", channel.id)

  for (const spec of LabIds.threadSpecs) {
    const thread = view.threads.find((candidate) => candidate.id === state.channels[spec.name])
    if (thread === undefined) {
      add(spec.name, "missing", "no stored thread under the lab channels")
      continue
    }
    if (thread.name !== spec.name) add(spec.name, "name", `"${thread.name}"`)
    if ((thread.rate_limit_per_user ?? 0) !== 0) add(spec.name, "slowmode", `${thread.rate_limit_per_user}`)
    const metadata = thread.thread_metadata
    if (metadata === undefined) add(spec.name, "metadata", "none")
    else {
      if (metadata.archived) add(spec.name, "archived", "yes")
      if (metadata.locked) add(spec.name, "locked", "yes")
      if (metadata.auto_archive_duration !== LabIds.threadAutoArchiveMinutes) add(spec.name, "auto-archive", `${metadata.auto_archive_duration}`)
    }
    const members = snapshot.threadMembers[spec.name] ?? []
    if (members.includes(context.subjectUserId)) add(spec.name, "subject member", "the subject is a member")
    if (!members.includes(context.targetUserId)) add(spec.name, "target member", "the target is not a member")
  }
  for (const thread of view.threads) {
    if (!storedChannels.has(thread.id)) add(thread.name, isLabChannelName(thread.name) ? "scenario thread" : "foreign thread", thread.id)
  }

  const bots = new Set<string>([context.harnessUserId, context.subjectUserId, context.targetUserId])
  for (const name of messageChannelNames) {
    const messages = snapshot.messages[name] ?? []
    // a forum post's starter message has the thread's ID, and is kept
    const starter: string | undefined = state.channels[name]
    const left = messages.filter((message) => bots.has(message.author.id) && message.id !== starter && !systemTypes.has(message.type))
    if (left.length > 0) add(name, "bot message", `${left.length} left`)
    const pinned = snapshot.pins[name] ?? []
    if (pinned.length > 0) add(name, "pins", `${pinned.length} pinned`)
  }
  if (snapshot.commands.length > 0) add("subject", "commands", snapshot.commands.join(", "))
  for (const rule of snapshot.autoModRules) if (isLabRuleName(rule)) add(rule, "automod", "a lab rule")
  return problems
}

/** One line per problem. */
export const describeProblems = (problems: ReadonlyArray<Problem>): string => problems.map((problem) => `${problem.object} ${problem.field} (${problem.detail})`).join("; ")

const decodeArray = <S extends Schema.Codec<unknown, unknown>>(schema: S, what: string) => Wire.decode(Schema.Array(schema), what)

/** Reads the lab for {@link baselineProblems}. Reads only (and admits the lab objects it finds to the guard). */
export const readBack = (context: Reset.Context): Effect.Effect<Snapshot, LabRequestFailed | LabCheckFailed | PlatformError, HarnessRest | SubjectRaw | LabGuard> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const view = yield* Reset.read(context)
    const present = (id: string | undefined) => id !== undefined && (view.channels.some((channel) => channel.id === id) || view.threads.some((thread) => thread.id === id))
    const threadMembers: Record<string, ReadonlyArray<string>> = {}
    for (const spec of LabIds.threadSpecs) {
      const id = view.state.channels[spec.name]
      if (id === undefined || !present(id)) continue
      const members = yield* rest.listThreadMembers(id).pipe(labStep(`selftest: list members of ${spec.name}`), Effect.flatMap(decodeArray(Wire.ThreadMember, "listThreadMembers")))
      threadMembers[spec.name] = members.map((member) => member.user_id)
    }
    const messages: Record<string, ReadonlyArray<Wire.Message>> = {}
    const pins: Record<string, ReadonlyArray<string>> = {}
    for (const name of messageChannelNames) {
      const id = view.state.channels[name]
      if (id === undefined || !present(id)) continue
      messages[name] = yield* rest.listMessages(id, { limit: 100 }).pipe(labStep(`selftest: list messages in ${name}`), Effect.flatMap(decodeArray(Wire.Message, "listMessages")))
      const page = yield* rest.listPins(id, { limit: 50 }).pipe(labStep(`selftest: list pins in ${name}`), Effect.flatMap(Wire.decode(Wire.PinPage, "listPins")))
      pins[name] = page.items.map((item) => item.message.id)
    }
    const commands = yield* (yield* SubjectRaw)
      .listGuildApplicationCommands(context.subjectApplicationId, context.guildId)
      .pipe(labStep("selftest: list the subject's guild commands"), Effect.flatMap(decodeArray(Wire.Command, "listGuildApplicationCommands")))
    const rules = yield* rest.listAutoModerationRules(context.guildId).pipe(labStep("selftest: list AutoMod rules"), Effect.flatMap(decodeArray(Wire.AutoModRule, "listAutoModerationRules")))
    return { view, threadMembers, messages, pins, commands: commands.map((command) => command.name), autoModRules: rules.map((rule) => rule.name) }
  })

/** A problem a dirt step must produce. */
export interface Shown {
  readonly object: string
  readonly field: string
}

/** One kind of dirt, and the problems the read-back must then report. */
export interface DirtStep {
  readonly label: string
  readonly shows: ReadonlyArray<Shown>
  readonly apply: Effect.Effect<void, LabRequestFailed | LabCheckFailed, HarnessRest | TargetRest | SubjectRaw | LabGuard>
}

/** The names the self-test gives the objects it creates; reset must delete every one. */
export const selftestNames = {
  role: "lab-selftest-role",
  channel: "lab-selftest-channel",
  publicThread: "lab-selftest-thread",
  privateThread: "lab-selftest-private",
  tag: "lab-selftest-tag",
  command: "labselftest"
} as const

const need = <Id extends string>(record: Readonly<Record<string, Id>>, name: string): Effect.Effect<Id, LabCheckFailed> => {
  const id = record[name]
  return id === undefined ? Effect.fail(new LabCheckFailed({ check: "selftest", detail: `${name} is not provisioned; run bun run harness:smoke first` })) : Effect.succeed(id)
}

const quiet = { allowed_mentions: { parse: [] } } as const

/**
 * The dirt, in the order it is applied. Messages come before the slowmode, archive and timeout steps that
 * would stop them; the target's timeout comes last, since a timed-out member cannot send.
 */
export const dirtSteps = (context: Reset.Context, state: LabIds.LabState): ReadonlyArray<DirtStep> => {
  const guild = context.guildId
  const channel = (name: string) => need(state.channels, name)
  const role = (name: string) => need(state.roles, name)
  const step = (label: string, shows: ReadonlyArray<readonly [object: string, field: string]>, apply: DirtStep["apply"]): DirtStep => ({
    label,
    shows: shows.map(([object, field]) => ({ object, field })),
    apply
  })
  return [
    step(
      "role permissions and mentionability",
      [["@everyone", "permissions"], ["lab-grant", "permissions"], ["lab-high", "permissions"], ["lab-mentionable", "mentionable"]],
      Effect.gen(function* () {
        const rest = yield* HarnessRest
        yield* rest.updateGuildRole(guild, guild, { permissions: Number(PermissionFlagsBits.ViewChannel) }).pipe(labStep("selftest: @everyone gets View"))
        yield* rest.updateGuildRole(guild, yield* role("lab-grant"), { permissions: Number(PermissionFlagsBits.SendMessages) }).pipe(labStep("selftest: lab-grant gets Send"))
        yield* rest.updateGuildRole(guild, yield* role("lab-high"), { permissions: Number(PermissionFlagsBits.ViewChannel) }).pipe(labStep("selftest: lab-high gets View"))
        yield* rest.updateGuildRole(guild, yield* role("lab-mentionable"), { mentionable: false }).pipe(labStep("selftest: lab-mentionable not mentionable"))
      })
    ),
    step(
      "a leftover role the target holds, and the target without lab-unmentionable",
      [[selftestNames.role, "leftover role"], ["target", "roles"]],
      Effect.gen(function* () {
        const rest = yield* HarnessRest
        const leftover = yield* rest
          .createGuildRole(guild, { name: selftestNames.role, permissions: 0 })
          .pipe(labStep("selftest: create a leftover role"), Effect.flatMap(Wire.decode(Wire.Role, "createGuildRole")))
        yield* (yield* LabGuard).admitRole({ id: leftover.id, name: leftover.name, botId: undefined })
        yield* rest.addGuildMemberRole(guild, context.targetUserId, leftover.id).pipe(labStep("selftest: the target holds the leftover role"))
        yield* rest.deleteGuildMemberRole(guild, context.targetUserId, yield* role("lab-unmentionable")).pipe(labStep("selftest: the target loses lab-unmentionable"))
      })
    ),
    step(
      "the subject holds lab roles, with a nickname and a timeout",
      [["subject", "roles"], ["subject", "nick"], ["subject", "timeout"]],
      Effect.gen(function* () {
        const rest = yield* HarnessRest
        yield* rest.addGuildMemberRole(guild, context.subjectUserId, yield* role("lab-grant")).pipe(labStep("selftest: the subject gets lab-grant"))
        yield* rest.addGuildMemberRole(guild, context.subjectUserId, yield* role("lab-high")).pipe(labStep("selftest: the subject gets lab-high"))
        const until = new Date((yield* Clock.currentTimeMillis) + 10 * 60 * 1000).toISOString()
        yield* rest
          .updateGuildMember(guild, context.subjectUserId, { nick: "lab-selftest", communication_disabled_until: until })
          .pipe(labStep("selftest: the subject's nickname and timeout"))
      })
    ),
    step(
      "a leftover lab channel",
      [[selftestNames.channel, "leftover channel"]],
      Effect.gen(function* () {
        const created = yield* (yield* HarnessRest)
          .createGuildChannel(guild, { name: selftestNames.channel, type: 0, parent_id: yield* channel("lab") })
          .pipe(labStep("selftest: create a leftover channel"), Effect.flatMap(Wire.decode(Wire.Channel, "createGuildChannel")))
        yield* (yield* LabGuard).admitChannel(created)
      })
    ),
    step(
      "bot messages and pins",
      [
        ["lab-text", "bot message"],
        ["lab-text", "pins"],
        ["lab-public-thread", "bot message"],
        ["lab-voice", "bot message"],
        ["lab-stage", "bot message"],
        ["lab-announcement", "bot message"],
        ["lab-forum-post", "pins"]
      ],
      Effect.gen(function* () {
        const harness = yield* HarnessRest
        const target = yield* TargetRest
        const text = yield* channel("lab-text")
        const sent: Array<Wire.Message> = []
        for (const n of [1, 2, 3]) {
          sent.push(yield* target.createMessage(text, { content: `lab selftest ${n}`, ...quiet }).pipe(labStep("selftest: a target message"), Effect.flatMap(Wire.decode(Wire.Message, "createMessage"))))
        }
        const first = sent[0]
        if (first !== undefined) yield* harness.createPin(text, first.id).pipe(labStep("selftest: pin a target message"))
        yield* target.createMessage(yield* channel("lab-public-thread"), { content: "lab selftest", ...quiet }).pipe(labStep("selftest: a target message in a thread"))
        for (const name of ["lab-voice", "lab-stage", "lab-announcement"]) {
          yield* harness.createMessage(yield* channel(name), { content: "lab selftest", ...quiet }).pipe(labStep(`selftest: a harness message in ${name}`))
        }
        const post = yield* channel("lab-forum-post")
        yield* harness.createPin(post, post).pipe(labStep("selftest: pin the forum post's starter message"))
      })
    ),
    step(
      "lab-text slowmode and overwrites",
      [["lab-text", "slowmode"], ["lab-text", "overwrites"]],
      Effect.gen(function* () {
        const rest = yield* HarnessRest
        const text = yield* channel("lab-text")
        yield* rest.updateChannel(text, { rate_limit_per_user: 5 }).pipe(labStep("selftest: lab-text slowmode"))
        yield* rest
          .setChannelPermissionOverwrite(text, context.subjectUserId, { type: 1, allow: Number(PermissionFlagsBits.ViewChannel), deny: 0 })
          .pipe(labStep("selftest: a member overwrite"))
        yield* rest.setChannelPermissionOverwrite(text, guild, { type: 0, allow: 0, deny: Number(PermissionFlagsBits.SendMessages) }).pipe(labStep("selftest: an @everyone deny"))
        yield* rest
          .setChannelPermissionOverwrite(text, yield* role("lab-deny"), { type: 0, allow: 0, deny: Number(PermissionFlagsBits.AddReactions) })
          .pipe(labStep("selftest: a lab-deny overwrite"))
      })
    ),
    step(
      "lab-bots-only out of the lab category",
      [["lab-bots-only", "parent"]],
      Effect.gen(function* () {
        yield* (yield* HarnessRest).updateChannel(yield* channel("lab-bots-only"), { parent_id: null }).pipe(labStep("selftest: move lab-bots-only out"))
      })
    ),
    step(
      "lab-forum requires a tag and has another one",
      [["lab-forum", "require-tag"], ["lab-forum", "tags"]],
      Effect.gen(function* () {
        yield* (yield* HarnessRest)
          .updateChannel(yield* channel("lab-forum"), { flags: LabIds.requireTagFlag, available_tags: [...LabIds.baselineTags, { name: selftestNames.tag, moderated: false }] })
          .pipe(labStep("selftest: lab-forum tags"))
      })
    ),
    step(
      "provisioned thread settings",
      [["lab-public-thread", "slowmode"], ["lab-public-thread", "archived"], ["lab-public-thread", "locked"], ["lab-announcement-thread", "auto-archive"]],
      Effect.gen(function* () {
        const rest = yield* HarnessRest
        const thread = yield* channel("lab-public-thread")
        yield* rest.updateChannel(thread, { rate_limit_per_user: 5 }).pipe(labStep("selftest: thread slowmode"))
        yield* rest.updateChannel(thread, { archived: true, locked: true }).pipe(labStep("selftest: archive and lock a thread"))
        yield* rest.updateChannel(yield* channel("lab-announcement-thread"), { auto_archive_duration: 60 }).pipe(labStep("selftest: thread auto-archive"))
      })
    ),
    step(
      "thread membership",
      [["lab-private-thread", "subject member"], ["lab-forum-post", "target member"]],
      Effect.gen(function* () {
        const rest = yield* HarnessRest
        yield* rest.addThreadMember(yield* channel("lab-private-thread"), context.subjectUserId).pipe(labStep("selftest: the subject joins the private thread"))
        yield* rest.deleteThreadMember(yield* channel("lab-forum-post"), context.targetUserId).pipe(labStep("selftest: the target leaves the forum post"))
      })
    ),
    step(
      "archived scenario threads, public and private",
      [[selftestNames.publicThread, "scenario thread"], [selftestNames.privateThread, "scenario thread"]],
      Effect.gen(function* () {
        const rest = yield* HarnessRest
        const guard = yield* LabGuard
        const text = yield* channel("lab-text")
        for (const [name, type] of [[selftestNames.publicThread, 11], [selftestNames.privateThread, 12]] as const) {
          const thread = yield* rest
            .createThread(text, { name, type, auto_archive_duration: LabIds.threadAutoArchiveMinutes })
            .pipe(labStep(`selftest: create ${name}`), Effect.flatMap(Wire.decode(Wire.Channel, "createThread")))
          yield* guard.admitChannel(thread)
          yield* rest.updateChannel(thread.id, { archived: true }).pipe(labStep(`selftest: archive ${name}`))
        }
      })
    ),
    step(
      "a subject guild command",
      [["subject", "commands"]],
      Effect.gen(function* () {
        yield* (yield* SubjectRaw)
          .bulkSetGuildApplicationCommands(context.subjectApplicationId, guild, [{ name: selftestNames.command, description: "Perms Lab reset self-test", type: 1 }])
          .pipe(labStep("selftest: a subject guild command"))
      })
    ),
    step(
      "the target's nickname and timeout (last: a timed-out member cannot send)",
      [["target", "nick"], ["target", "timeout"]],
      Effect.gen(function* () {
        const until = new Date((yield* Clock.currentTimeMillis) + 10 * 60 * 1000).toISOString()
        yield* (yield* HarnessRest)
          .updateGuildMember(guild, context.targetUserId, { nick: "lab-selftest", communication_disabled_until: until })
          .pipe(labStep("selftest: the target's nickname and timeout"))
      })
    )
  ]
}

/** The shown problems no read-back problem matches. */
export const unseen = (steps: ReadonlyArray<DirtStep>, problems: ReadonlyArray<Problem>): ReadonlyArray<string> =>
  steps.flatMap((step) =>
    step.shows.filter((shown) => !problems.some((problem) => problem.object === shown.object && problem.field === shown.field)).map((shown) => `${shown.object} ${shown.field} (${step.label})`)
  )

/** What the self-test did. */
export interface Report {
  readonly initialReset: Reset.Result
  readonly dirtSteps: number
  readonly dirtWrites: number
  /** The problems the read-back found after the dirt. */
  readonly problemsSeen: number
  readonly reset: Reset.Result
  readonly secondReset: Reset.Result
}

const fail = (detail: string) => Effect.fail(new LabCheckFailed({ check: "selftest", detail }))

/** Runs the self-test. Fails with `LabCheckFailed` (check `selftest`) when reset does not restore the baseline. */
export const run = (context: Reset.Context): Effect.Effect<Report, LabRequestFailed | LabCheckFailed | PlatformError, HarnessRest | TargetRest | SubjectRaw | LabGuard | Pacing> =>
  Effect.gen(function* () {
    const pacing = yield* Pacing
    const problemsNow = readBack(context).pipe(Effect.flatMap((snapshot) => Effect.map(Clock.currentTimeMillis, (now) => ({ snapshot, problems: baselineProblems(snapshot, context, now) }))))

    const initialReset = yield* Reset.run(context)
    const clean = yield* problemsNow
    if (clean.problems.length > 0) return yield* fail(`the lab is not at baseline after a reset: ${describeProblems(clean.problems)}`)

    const steps = dirtSteps(context, clean.snapshot.view.state)
    const before = yield* pacing.stats
    yield* Effect.forEach(steps, (step) => step.apply, { discard: true }).pipe(Effect.catch((error) => Reset.run(context).pipe(Effect.andThen(Effect.fail(error)))))
    const dirtWrites = Reset.writesBetween(before, yield* pacing.stats).writes

    const dirty = yield* problemsNow
    const blind = unseen(steps, dirty.problems)
    if (blind.length > 0) {
      yield* Reset.run(context)
      return yield* fail(`the read-back did not see this dirt: ${blind.join("; ")}`)
    }

    const reset = yield* Reset.run(context)
    const after = yield* problemsNow
    if (after.problems.length > 0) return yield* fail(`reset (${reset.writes} writes) left the lab off baseline: ${describeProblems(after.problems)}`)
    const secondReset = yield* Reset.run(context)
    if (secondReset.writes !== 0) return yield* fail(`the second reset made ${Reset.summary(secondReset)}`)
    return { initialReset, dirtSteps: steps.length, dirtWrites, problemsSeen: dirty.problems.length, reset, secondReset }
  })
