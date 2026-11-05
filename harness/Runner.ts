/**
 * The matrix runner (DESIGN §5.1 `verify:live`, §5.10): resets and provisions the lab, runs the catalog
 * serially, judges the flip controls, and writes the truth table.
 *
 * One scenario (§5.10):
 *
 * 1. **Converge**: the subject's own fixtures first (`Fixtures.subjectObjects`, with temporary access), then
 *    the materialized desired state (`Converge.ts`, the fixed order of §5.8).
 * 2. **Fixtures**: the harness's messages, reaction and pin (`Fixtures.harnessObjects`), the subject's prior send
 *    under the setup (`Fixtures.subjectPriorSend`, H-053; the raw call cannot run without its answer, and the run
 *    log records the prior message's ID), then the thread's archived and locked state.
 * 3. **Wait** until the harness's read-back, the subject's gateway state and the oracle agree (`Wait.ts`).
 * 4. **(a) Resolver** over the subject's guild state: for a channel operation, a scenario thread is refreshed
 *    first through the library's `GuildState.refresh`, so the subject's view of it is a function of the setup;
 *    a member operation resolves at guild level, and the subject reads the target member (as the library's
 *    `Members.get` will, M6) for the hierarchy.
 * 5. **(b) Preflight**: the real public operation in enforce mode over the dry-run stub (`Library.ts`, M6), whose
 *    record must be `Preflight.decide`'s (`preflight-wiring` otherwise).
 * 6. **(c) Raw call** through `SubjectRaw`, with no check (`Drivers.ts`), classified by `Outcome.ts`. A payload
 *    that mentions `@everyone` is sent only if the oracle shows the subject without MentionEveryone and
 *    Administrator; a kick or ban only with the Lab guard's permit, which it issues from harness-side reads.
 * 7. **(d) Recompute**: for a row Discord refused with 50013, 50001 or a dedicated code, the library's operation with
 *    preflight bypassed, live (`Library.recomputeStep`, M6); its error must be step (b)'s (`recompute-vs-preflight`).
 *    Then the **request check** (the M6 verifier): steps (c) and (d) run under `DryRun.Capture`, and the library's
 *    request, step (d)'s as sent and step (b)'s when (b) reached the stub, must each be step (c)'s
 *    (`request-wiring` otherwise); a row with neither is checked with the operation run dry in bypass mode.
 * 8. **Oracle**: the value the wait settled on, restricted to the required flags (`not-applicable` for member
 *    operations, which have no channel).
 * 9. **Cleanup**: the threads the scenario created, the scenario channel's bot messages, and the thread back to
 *    baseline. The next Converge undoes the rest (overwrites, settings, roles, the target's state).
 * 10. **Record** the row with its agreement; flip controls are judged against their originals after the run.
 *
 * Scenarios are grouped by setup (equal setups run back to back, so the lab converges once per group) and run
 * in a fixed order, so runs are reproducible. A timeout of the raw call, a wait past its cap, or a refused
 * guard check aborts the run as an infrastructure failure; nothing is retried to get a pass. Per-run detail
 * (message IDs, timings) goes to the run log, never to the table.
 */
import { BunFileSystem } from "@effect/platform-bun"
import { Clock, Duration, Effect, FileSystem, Option, Schema } from "effect"
import * as Headers from "effect/http/Headers"
import type { PlatformError } from "effect/PlatformError"
import { BotRuntime } from "../src/bot/Bot.ts"
import { SubjectRaw } from "../src/bot/Internals.ts"
import type { Transient } from "../src/errors/Transient.ts"
import * as Flags from "../src/permissions/Flags.ts"
import { requiredFlags } from "../src/permissions/Preflight.ts"
import { type FromSnapshot, guildInputFromSnapshot, inputFromSnapshot, resolve } from "../src/permissions/Resolver.ts"
import * as Oracle from "../src/rest/Oracle.ts"
import { send } from "../src/rest/Request.ts"
import * as Schemas from "../src/rest/Schemas.ts"
import { type ChannelId, type EmojiId, ForumTagId, type MessageId, type RoleId, type StickerId } from "../src/Snowflake.ts"
import { isThreadKind } from "../src/state/Snapshot.ts"
import { escalatedRules, unmetDoneCriteria } from "../scripts/lib/rules.ts"
import { rules } from "../test/rules.ts"
import { agreement, flipAgreement, matrixRowAgreement, ruleAgreement } from "./Agreement.ts"
import * as Converge from "./Converge.ts"
import * as Drivers from "./Drivers.ts"
import * as DryRun from "./DryRun.ts"
import * as Library from "./Library.ts"
import * as Probes from "./Probes.ts"
import * as Fixtures from "./Fixtures.ts"
import { HarnessRest } from "./Identities.ts"
import type { IdentityReport } from "./IdentityCheck.ts"
import { LabCheckFailed, LabGuard, LabRequestFailed, labStep, labStepUnless } from "./Lab.ts"
import * as LabIds from "./LabIds.ts"
import * as Materialize from "./Materialize.ts"
import * as Outcome from "./Outcome.ts"
import * as Predict from "./Predict.ts"
import { Pacing } from "./Pacing.ts"
import * as Provision from "./Provision.ts"
import * as Reset from "./Reset.ts"
import * as Catalog from "./scenario/catalog/index.ts"
import { operationKey, type Scenario, Setup } from "./scenario/Dsl.ts"
import * as Facts from "./scenario/Facts.ts"
import { probes } from "./scenario/Probes.ts"
import { families, selectionProblems } from "./scenario/Pairwise.ts"
import * as Safety from "./scenario/Safety.ts"
import * as TruthTable from "./TruthTable.ts"
import * as Wait from "./Wait.ts"
import * as Wire from "./Wire.ts"

/** The command-line options of `run` (§5.1). */
export interface Options {
  /** A glob over scenario IDs (`*` within a segment, `**` across); the run writes a subset table, never the committed one. */
  readonly only: string | undefined
  readonly write: boolean
  readonly compare: boolean
  /** Runs the matrix this many times in one process, with a reset between (a quick in-process check only). */
  readonly repeat: number
}

/** The committed table, written only by a full run. */
export const committedPath = new URL("../fixtures/truth-table.json", import.meta.url).pathname

/** Where a subset run (`--only`) writes and compares its table: next to the run logs, never the committed file. */
export const subsetPath = (glob: string): string => `/tmp/effect-discord-perms-truth-table.only-${glob.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}.json`

/** Whether `id` matches `glob`: `**` matches anything, `*` anything but `/`. */
export const globMatches = (glob: string, id: string): boolean => {
  const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  const pattern = glob
    .split("**")
    .map((part) => part.split("*").map(escape).join("[^/]*"))
    .join(".*")
  return new RegExp(`^${pattern}$`).test(id)
}

/** The catalog: every family's pairwise and targeted rows and their flip controls (§5.9). */
export const catalog: ReadonlyArray<Scenario> = Catalog.scenarios

const encodeSetup = Schema.encodeSync(Schema.toCodecJson(Setup))

/**
 * The role permissions a setup materializes (`@everyone`'s and every lab role's), as a sortable key. Role edits
 * are the scarcest write: Discord allows 1,000 per guild per day on `PATCH /guilds/{id}/roles/{id}`, refilled
 * at about one per 86 s (M4 live), and the setups use 67 distinct role states.
 */
const roleStateOf = (scenario: Scenario): string => {
  const state = Materialize.desired(scenario.setup, Predict.symbolicIds)
  return [state.everyone, ...LabIds.roleSpecs.map((spec) => state.rolePermissions.get(spec.name) ?? 0n)].map((bits) => bits.toString().padStart(16, "0")).join("|")
}

/** The role edits Converge makes over `ordered` (one per role whose permissions change between consecutive setups). */
export const roleEditsOf = (ordered: ReadonlyArray<Scenario>): number => {
  let previous: ReadonlyArray<string> | undefined
  let edits = 0
  for (const scenario of ordered) {
    const state = roleStateOf(scenario).split("|")
    if (previous !== undefined) edits += state.filter((bits, index) => bits !== previous?.[index]).length
    previous = state
  }
  return edits
}

/** Role edits a run needs beyond its scenarios': the resets' and the budget check's own. */
const roleEditMargin = 8

/** Discord's refill of the role bucket, about one edit per this many milliseconds (1,000 per day; M4 live). */
const roleEditRefillMs = 86_400

const Remaining = Schema.Struct({ permissions: Schema.String })

/**
 * Checks that the guild's role-edit bucket holds what the run needs, before any scenario write, by writing
 * `lab-grant`'s permissions back unchanged and reading `x-ratelimit-remaining` (§5.11; M4 live: a run that starts
 * short stalls inside dfx's limiter without a 429). Costs one role edit.
 */
export const checkRoleBudget = (ids: Materialize.Ids, needed: number): Effect.Effect<void, LabCheckFailed | LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const grant = ids.roles.get("lab-grant")
    if (grant === undefined) return yield* Effect.die(new Error("no ID for lab-grant"))
    const roles = yield* rest.listGuildRoles(ids.guildId).pipe(labStep("role budget: list roles"), Effect.flatMap(Wire.decode(Schema.Array(Schema.Struct({ id: Schema.String, ...Remaining.fields })), "listGuildRoles")))
    const current = roles.find((role) => role.id === grant)
    if (current === undefined) return yield* Effect.die(new Error("lab-grant is not listed"))
    const answer = yield* Wire.raw(rest, "role budget: write lab-grant back", "PATCH", `/guilds/${ids.guildId}/roles/${grant}`, { body: { permissions: current.permissions } })
    yield* Wire.ensureOk("role budget: write lab-grant back", answer)
    const remaining = Number(Option.getOrElse(Headers.get(answer.headers, "x-ratelimit-remaining"), () => "NaN"))
    if (!Number.isFinite(remaining)) return yield* new LabCheckFailed({ check: "role budget", detail: "the role PATCH carried no x-ratelimit-remaining header" })
    yield* Effect.sync(() => console.log(`role budget: ${remaining} role edits left; the run needs about ${needed}`))
    if (remaining < needed) {
      const minutes = Math.ceil(((needed - remaining) * roleEditRefillMs) / 60_000)
      return yield* new LabCheckFailed({
        check: "role budget",
        detail: `${remaining} role edits left in the guild's bucket, the run needs about ${needed}; Discord refills about one per ${roleEditRefillMs / 1000} s, so start again in about ${minutes} minutes`
      })
    }
  })

/**
 * Groups equal setups together, keeping each group in ID order and the groups in a fixed order (§5.10): by the
 * role state they need, then by the canonical setup, so the run changes role permissions once per role state
 * rather than once per setup.
 */
export const order = (scenarios: ReadonlyArray<Scenario>): ReadonlyArray<Scenario> => {
  const signature = (scenario: Scenario) => `${roleStateOf(scenario)}#${TruthTable.canonicalJson(encodeSetup(scenario.setup))}`
  return scenarios
    .map((scenario) => ({ scenario, key: signature(scenario) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.scenario.id < b.scenario.id ? -1 : a.scenario.id > b.scenario.id ? 1 : 0))
    .map((entry) => entry.scenario)
}

/** The lab's IDs from the persisted state and the identity checks. A lab object without a stored ID fails the run. */
export const idsOf = (state: LabIds.LabState, report: IdentityReport): Effect.Effect<Materialize.Ids, LabCheckFailed> =>
  Effect.gen(function* () {
    const unavailable = new Set(Object.keys(state.unavailable ?? {}))
    const roles = new Map<LabIds.RoleName, RoleId>()
    for (const spec of LabIds.roleSpecs) {
      const id = state.roles[spec.name]
      if (id === undefined) return yield* new LabCheckFailed({ check: "lab state", detail: `no stored ID for ${spec.name}` })
      roles.set(spec.name, id)
    }
    const channels = new Map<Materialize.LabName, ChannelId>()
    for (const name of [...LabIds.channelSpecs.map((spec) => spec.name), ...LabIds.threadSpecs.map((spec) => spec.name)]) {
      const id = state.channels[name]
      if (id !== undefined) channels.set(name, id)
      else if (!unavailable.has(name)) return yield* new LabCheckFailed({ check: "lab state", detail: `no stored ID for ${name}` })
    }
    return {
      guildId: report.guild.id,
      ownerId: report.guild.owner_id,
      subjectUserId: report.subject.userId,
      targetUserId: report.target.userId,
      roles,
      channels,
      unavailable
    }
  })

const PackageVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const versionOf = (name: string): Effect.Effect<string, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(new URL(`../node_modules/${name}/package.json`, import.meta.url).pathname)
    return (yield* Schema.decodeUnknownEffect(PackageVersion)(text).pipe(Effect.orDie)).version
  })

/** What one run did. */
export interface RunResult {
  readonly table: TruthTable.TruthTable
  readonly scenarios: number
  readonly mismatches: ReadonlyArray<readonly [id: string, kind: TruthTable.AgreementKind]>
  readonly durationMs: number
}

/** Everything a scenario's execution reads. */
interface Context {
  readonly ids: Materialize.Ids
  readonly stickerId: StickerId | undefined
  readonly emojiId: EmojiId | undefined
  readonly log: (line: string) => Effect.Effect<void, PlatformError>
  readonly oracleSeen: { unavailable: boolean }
  /**
   * The lab channels whose overwrites or settings may differ from baseline: the previous scenario's (its
   * desired state, the temporary access the fixtures gave, or what its operation edited). Every other lab
   * channel is at baseline since the opening reset.
   */
  readonly dirty: Set<LabIds.ChannelName>
  /** The dry-run stub's canned bodies (step (b)). */
  readonly canned: ReadonlyMap<string, unknown>
  /**
   * The roles and members the previous scenario's settled read-back saw, where nothing has written them since
   * (`Converge.KnownView`): Converge reads only what is not here.
   */
  known: Converge.KnownView
}

/** Whether step (b)'s record is the one `Preflight.decide` gives (tag and categories). */
const sameStep = (a: Library.Step, b: TruthTable.StepRecords["preflight"]): boolean =>
  a === "pass" || b === "pass" ? a === b : a.tag === b.tag && a.categories.join() === b.categories.join()

/** Whether Discord refused the raw call with 50013, 50001 or a dedicated code, which step (d) re-sends (§5.10). */
const refusedForRecompute = (raw: TruthTable.RawOutcome): boolean => raw.class === "50013" || raw.class === "50001" || (raw.class === "other-error" && raw.mappedTag !== "n/a")

const infrastructure = (what: string) => (error: Transient) => Effect.die(new Error(`infrastructure abort: ${what}: ${error._tag}`))

const toLabFailure = (error: Oracle.OracleFailed): LabRequestFailed =>
  error.cause._tag === "DiscordResponse"
    ? new LabRequestFailed({ step: "oracle", status: error.cause.status, code: error.cause.code, message: error.cause.message })
    : new LabRequestFailed({ step: "oracle", status: 0, code: 0, message: `no response (${error.cause.reason})` })

const botAuthors = (ids: Materialize.Ids, harness: string): ReadonlySet<string> => new Set([harness, ids.subjectUserId, ids.targetUserId])

const isForumName = (name: Materialize.LabName): boolean => name === "lab-forum" || name === "lab-media"

const TagsOf = Schema.Struct({ available_tags: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))) })

/** Runs one scenario and returns its row (see the module comment for the steps). */
const execute = (scenario: Scenario, context: Context, harnessUserId: string) =>
  Effect.gen(function* () {
    const { setup, operation } = scenario
    const staticFacts = Facts.staticFactsOf(scenario)
    const base = { setup, operation: operationKey(operation) }
    const unsupportedRow = (raw: TruthTable.RawOutcome): TruthTable.Row => ({
      ...base,
      recompute: "n/a",
      resolver: { required: Flags.sortFlags(requiredFlags(staticFacts.op, staticFacts.args)), missing: [], missingBeforeMasks: [], masks: [], level: "none" },
      preflight: "n/a",
      preflightSet: [],
      raw,
      oracle: "not-applicable",
      agreement: "agree"
    })
    const name = Materialize.labNameOf(setup)
    const overwriteChannel = Materialize.overwriteChannelOf(name)
    if (context.ids.unavailable.has(name) || context.ids.unavailable.has(overwriteChannel)) return unsupportedRow(Outcome.unsupported("kind-not-available"))
    const rest = yield* HarnessRest
    const runtime = yield* BotRuntime
    const subjectRaw = yield* SubjectRaw
    const guard = yield* LabGuard

    // each step's milliseconds and requests (every identity's), for the run log's profile of a scenario's time (§5.11)
    const pacing = yield* Pacing
    const times: Array<readonly [string, number, number]> = []
    let mark = yield* Clock.currentTimeMillis
    let requestMark = (yield* pacing.stats).requests
    const lap = (step: string) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const requests = (yield* pacing.stats).requests
        times.push([step, at - mark, requests - requestMark])
        mark = at
        requestMark = requests
      })
    const profile = () => `ms ${times.map(([step, ms]) => `${step} ${ms}`).join(", ")}; requests ${times.map(([step, , requests]) => `${step} ${requests}`).join(", ")}`
    const channels: ReadonlySet<LabIds.ChannelName> = new Set([...context.dirty, overwriteChannel])
    // whatever happens next, the scenario's channel may be off baseline afterwards
    context.dirty.clear()
    context.dirty.add(overwriteChannel)
    // what the previous scenario's read-back saw, minus what this scenario's own fixtures may change (they lift a
    // leftover timeout); nothing is kept if the scenario stops before its wait
    const known: Converge.KnownView = Fixtures.needsSubject(setup) ? { ...context.known, subject: undefined } : context.known
    context.known = Converge.unknownView

    // 1. the subject's own fixtures (with temporary access), then Converge
    const spec = Materialize.scenarioThreadSpec(name)
    const own = yield* Fixtures.subjectObjects({ setup, ids: context.ids, overwriteChannel, channel: name, scenarioThread: spec })
    const ids: Materialize.Ids = own.thread === undefined ? context.ids : { ...context.ids, channels: new Map(context.ids.channels).set(own.thread.name, own.thread.id) }
    const state = Materialize.desired(setup, ids)
    const channelId = ids.channels.get(state.channel)
    if (channelId === undefined) return yield* Effect.die(new Error(`no ID for ${state.channel}`))
    let created: ChannelId | undefined
    const cleanup = Effect.gen(function* () {
      if (created !== undefined) yield* rest.deleteChannel(created).pipe(labStepUnless("cleanup: delete the created thread", [10003]))
      if (own.thread !== undefined) {
        yield* rest.deleteChannel(own.thread.id).pipe(labStepUnless(`cleanup: delete ${own.thread.name}`, [10003]))
        if (spec !== undefined && !isForumName(spec.parent)) yield* Converge.cleanMessages({ id: yield* lookupId(ids, spec.parent), name: spec.parent }, botAuthors(ids, harnessUserId))
      } else {
        // the thread first: an archived thread refuses message deletes (400 50083)
        yield* Converge.restoreThread(state, ids)
        if (!isForumName(state.channel)) yield* Converge.cleanMessages({ id: channelId, name: state.channel }, botAuthors(ids, harnessUserId))
      }
    })
    const converged = yield* Converge.converge(state, ids, channels, known)
    yield* lap("converge")
    if (converged._tag === "TimeoutRefused") {
      yield* cleanup
      return unsupportedRow(Outcome.unsupported("bot-not-timeoutable", converged.status, converged.code))
    }
    if (converged._tag === "AdminExempt") {
      yield* cleanup
      return unsupportedRow(Outcome.unsupported("admin-exempt"))
    }

    // 2. the harness's fixtures, the subject's prior send, then the thread's state
    const posted = yield* Fixtures.harnessObjects(setup, channelId)
    if (posted._tag === "Refused") {
      yield* cleanup
      return unsupportedRow(Outcome.unsupported("rejected-by-discord", posted.status, posted.code))
    }
    const prior = yield* Fixtures.subjectPriorSend(setup, channelId)
    if (prior._tag === "Refused") {
      yield* cleanup
      return unsupportedRow(Outcome.unsupported("rejected-by-discord", prior.status, prior.code))
    }
    const threadStateWritten = yield* Converge.applyThreadState(state, ids)
    yield* lap("fixtures")
    // the wait re-reads what was written since Converge's read: the thread too when the fixtures posted in it
    // (a post can unarchive a thread or add its author as a member) or its state was set
    const postedInThread = state.thread !== undefined && state.channel === state.thread.name && (posted.harnessMessage !== undefined || posted.secondHarnessMessage !== undefined || prior._tag === "Sent")
    const written = threadStateWritten || postedInThread ? Converge.withThreadWritten(converged.written) : converged.written

    // 3. wait (the oracle reads the scenario channel; member operations have no channel)
    const readOracle: Effect.Effect<Wait.OracleValue, LabRequestFailed> =
      staticFacts.scope === "guild"
        ? Effect.succeed({ _tag: "NotApplicable" })
        : Oracle.memberPermissions(rest, channelId, ids.subjectUserId, Duration.seconds(30)).pipe(
          Effect.mapError(toLabFailure),
          Effect.map((read): Wait.OracleValue => (read._tag === "Permissions" ? { _tag: "Permissions", permissions: read.permissions } : { _tag: "Unavailable" }))
        )
    const settled = yield* Wait.settle({ scenario: scenario.id, state, ids, guildState: runtime.guildState, guildId: ids.guildId, channel: channelId, readOracle, channels, converged: { view: converged.view, written } })
    yield* lap("wait")
    // the next Converge may start from this read-back: role permissions and the subject change only through Converge
    // and the subject's fixtures; the target also through a member operation or a probe, so not after one
    const touchesTarget = operation._tag === "member" || operation._tag === "rule"
    context.known = {
      roles: operation._tag === "rule" ? undefined : settled.view.roles,
      subject: operation._tag === "rule" ? undefined : settled.view.subject,
      target: touchesTarget ? undefined : settled.view.target
    }

    // the fixtures' messages as the harness reads them (author, reactions), for the library's handles, and the
    // target member as the subject reads it (as the library's `Members.get` does)
    const readWire = (id: MessageId | undefined): Effect.Effect<Schemas.Message | undefined, LabRequestFailed> =>
      id === undefined ? Effect.succeed(undefined) : rest.getMessage(channelId, id).pipe(labStep("library: read a fixture message"), Effect.flatMap(Wire.decode(Schemas.Message, "getMessage")))
    const readTarget = send("/guilds/{guild.id}/members/{user.id}", "GET", subjectRaw.getGuildMember(ids.guildId, ids.targetUserId), Drivers.deadline).pipe(
      Effect.catch(infrastructure("the subject's read of the target")),
      Effect.flatMap((answer) => (answer._tag === "Ok" ? Wire.decode(Schemas.Member, "getGuildMember")(answer.body) : Effect.die(new Error(`the subject's read of the target: ${answer.response.code}`))))
    )
    const now = yield* Clock.currentTimeMillis

    // a rule row runs its probe instead of steps (a) to (d) (§5.5)
    if (operation._tag === "rule") {
      const meta = probes[operation.probe]
      const probed = yield* Probes.run(operation.probe, {
        runtime,
        ids,
        channelId,
        channel: state.channel,
        subjectMessage: yield* readWire(own.subjectMessage),
        harnessMessage: yield* readWire(posted.harnessMessage),
        secondHarnessMessage: posted.secondHarnessMessage,
        stickerId: context.stickerId,
        target: staticFacts.onTarget ? yield* readTarget : undefined,
        now
      }).pipe(Effect.catch((error) => (error._tag === "LabRequestFailed" ? Effect.fail(error) : infrastructure(`${scenario.id}: the probe`)(error))))
      yield* lap("probe")
      for (const thread of probed.created) yield* rest.deleteChannel(thread).pipe(labStepUnless("cleanup: delete the probe's thread", [10003]))
      for (const touched of meta.touches) {
        context.dirty.add(touched)
        if (touched !== "lab-forum" && touched !== "lab-media") yield* Converge.cleanMessages({ id: yield* lookupId(ids, touched), name: touched }, botAuthors(ids, harnessUserId))
      }
      yield* cleanup
      yield* lap("cleanup")
      yield* context.log(`${scenario.id}: ${settled.resent.length > 0 ? `resent ${settled.resent.join(",")} for obfuscation; ` : ""}probe ${JSON.stringify(probed.observation)}; ${profile()}`)
      const row: Omit<TruthTable.Row, "agreement"> = {
        ...base,
        resolver: { required: [], missing: [], missingBeforeMasks: [], masks: [], level: "none" },
        preflight: "n/a",
        preflightSet: [],
        raw: probed.raw,
        recompute: "n/a",
        oracle: "not-applicable",
        observation: probed.observation
      }
      return { ...row, agreement: ruleAgreement(probed.observation, scenario.expect) }
    }

    // 4. (a) the resolver over the subject's state, refreshed first when a dispatch left it stale: the operation of
    // step (b) would refresh it itself, and the dry-run stub answers only the operation's own routes
    if ((yield* runtime.guildState.snapshot).guilds.get(ids.guildId)?.stale === true) {
      yield* (staticFacts.scope === "guild" ? runtime.guildState.refreshGuild(ids.guildId) : runtime.guildState.refresh(ids.guildId, channelId)).pipe(Effect.catch(infrastructure("refresh")))
    }
    let fromState: FromSnapshot
    let hierarchy: Facts.Hierarchy | undefined
    let targetWire: Schemas.Member | undefined
    if (staticFacts.scope === "guild") {
      fromState = guildInputFromSnapshot(yield* runtime.guildState.snapshot, ids.guildId, now)
      if (fromState._tag === "NeedsRefresh") return yield* Effect.die(new Error(`${scenario.id}: the subject's state lacks ${fromState.reason}`))
      targetWire = yield* readTarget
      const assigned = Materialize.assignedRoleOf(setup)
      hierarchy = {
        guild: fromState.input.guild,
        bot: fromState.input.member,
        target: { userId: ids.targetUserId, roleIds: targetWire.roles, timedOutUntil: targetWire.communication_disabled_until ?? null },
        role: assigned === undefined ? undefined : ids.roles.get(assigned)
      }
    } else {
      if (isThreadKind(Materialize.kindOf(state.channel))) yield* runtime.guildState.refresh(ids.guildId, channelId).pipe(Effect.catch(infrastructure("refresh")))
      fromState = inputFromSnapshot(yield* runtime.guildState.snapshot, ids.guildId, channelId, now)
      if (fromState._tag === "NeedsRefresh") {
        yield* runtime.guildState.refresh(ids.guildId, channelId).pipe(Effect.catch(infrastructure("refresh")))
        fromState = inputFromSnapshot(yield* runtime.guildState.snapshot, ids.guildId, channelId, now)
      }
      if (fromState._tag === "NeedsRefresh") return yield* Effect.die(new Error(`${scenario.id}: the subject's state still lacks what it needs after a refresh: ${fromState.reason}`))
    }
    const resolution = resolve(fromState.input)
    const facts = Facts.complete(staticFacts, resolution, hierarchy)
    const records = TruthTable.stepRecords(facts, resolution, "matrix")

    // 5. (b) the real public operation in enforce mode over the dry-run stub; it must decide what decide does
    const forumTag =
      operation._tag === "createPost" && operation.tagged
        ? (yield* rest.getChannel(channelId).pipe(labStep("the forum's tags"), Effect.flatMap(Wire.decode(TagsOf, "getChannel")))).available_tags?.find((tag) => tag.name === "lab-tag")?.id
        : undefined
    const assigned = Materialize.assignedRoleOf(setup)
    const roleId = assigned === undefined ? undefined : ids.roles.get(assigned)
    const library: Library.LibraryContext = {
      runtime,
      ids,
      state,
      channelId,
      subjectMessage: yield* readWire(own.subjectMessage),
      harnessMessage: yield* readWire(posted.harnessMessage),
      secondHarnessMessage: posted.secondHarnessMessage,
      stickerId: context.stickerId,
      emojiId: context.emojiId,
      forumTag: forumTag === undefined ? undefined : ForumTagId.make(forumTag),
      roleId,
      target: targetWire,
      now
    }
    const stepB = yield* Library.preflightStep(operation, library, yield* DryRun.makeRecorder(context.canned))
    const wired = sameStep(stepB.step, records.preflight)
    const callContext: Drivers.CallContext = {
      ids,
      state,
      channelId,
      subjectMessage: own.subjectMessage,
      harnessMessage: posted.harnessMessage,
      secondHarnessMessage: posted.secondHarnessMessage,
      stickerId: context.stickerId,
      emojiId: context.emojiId,
      forumTag,
      roleId,
      now,
      priorSend: prior
    }


    // 8. the oracle (read during the wait), restricted to the required flags
    const oracleValue = settled.oracle
    const oracle: TruthTable.Row["oracle"] =
      oracleValue._tag === "Unavailable"
        ? "unavailable"
        : oracleValue._tag === "NotApplicable"
          ? "not-applicable"
          : { missing: Flags.sortFlags(facts.required.filter((flag) => !Flags.has(Flags.fromBits(oracleValue.permissions), flag))) }
    if (oracleValue._tag === "Unavailable") context.oracleSeen.unavailable = true

    // 6. (c) the raw call, after Safety's live checks: @everyone only while the oracle shows the subject
    // cannot ping everyone, and a kick or ban only with the guard's permit from harness-side reads (§5.6)
    if (operation._tag === "send" && operation.payload === "mention-everyone") {
      const allowed = oracleValue._tag === "Permissions" ? Flags.fromBits(oracleValue.permissions) : undefined
      if (allowed !== undefined && (Flags.has(allowed, "MentionEveryone") || Flags.has(allowed, "Administrator"))) {
        return yield* Effect.die(new Error(`Safety: ${scenario.id} would mention @everyone while the oracle shows the subject may ping everyone`))
      }
    }
    const kickOrBan = operation._tag === "member" && (operation.action === "kick" || operation.action === "ban") ? operation.action : undefined
    const permitKickOrBan = Effect.gen(function* () {
      if (kickOrBan === undefined) return
      const roles = yield* rest.listGuildRoles(ids.guildId).pipe(labStep("kick/ban: list roles"), Effect.flatMap(Wire.decode(Schema.Array(Wire.Role), "listGuildRoles")))
      const member = (user: string) => rest.getGuildMember(ids.guildId, user).pipe(labStep("kick/ban: get a member"), Effect.flatMap(Wire.decode(Wire.Member, "getGuildMember")))
      yield* guard.permitKickOrBan(kickOrBan, { guildId: ids.guildId, roles, subject: yield* member(ids.subjectUserId), target: yield* member(ids.targetUserId) })
    })
    yield* permitKickOrBan
    const capturedC = yield* DryRun.makeCapture
    const called = yield* Drivers.rawCall(scenario, callContext).pipe(Effect.provideService(DryRun.Capture, Option.some(capturedC)), Effect.catch(infrastructure(`${scenario.id}: the raw call`)))
    created = called.created
    if (created !== undefined && called.answer._tag === "Ok") yield* guard.admitChannel({ id: created, name: LabIds.createdThreadName })
    const raw = yield* Drivers.outcomeOf(scenario, called)

    // 7. (d) the library's operation with preflight bypassed, live, where Discord refused the raw call with a
    // permission-like or dedicated code: the recompute must give what (b) gave
    let recompute: TruthTable.Row["recompute"] = "n/a"
    const capturedD = yield* DryRun.makeCapture
    if (refusedForRecompute(raw)) {
      yield* permitKickOrBan
      const stepD = yield* Library.recomputeStep(operation, library).pipe(Effect.provideService(DryRun.Capture, Option.some(capturedD)))
      recompute = stepD.record
      if (stepD.created !== undefined) {
        yield* guard.admitChannel({ id: stepD.created, name: LabIds.createdThreadName })
        if (created === undefined) created = stepD.created
        else yield* rest.deleteChannel(stepD.created).pipe(labStepUnless("cleanup: delete the thread step (d) created", [10003]))
      }
    }

    // the request check (the M6 verifier): the library's request must be the raw call's (step (c)'s, as sent), in
    // method, path with its IDs and query, and body: step (d)'s as sent, and step (b)'s when it reached the stub; a row
    // with neither has the operation recorded in bypass mode over the stub instead. Nothing extra is sent: a dry
    // request still counts in dfx's own limiter, which delayed live requests past the deadline (§5.10)
    const sides = DryRun.librarySides({ reachedStub: stepB.step === "pass", requests: stepB.requests }, recompute === "n/a" ? undefined : yield* capturedD.recorded)
    const checked: ReadonlyArray<DryRun.RequestSide> =
      sides.length > 0 ? sides : [["the library, preflight bypassed", yield* Library.bypassedRequests(operation, library, yield* DryRun.makeRecorder(context.canned))]]
    const requestProblems = DryRun.requestCheck(checked, yield* capturedC.recorded)
    if (requestProblems.length > 0) yield* context.log(`${scenario.id}: request-wiring: ${requestProblems.join("; ")}`)
    yield* lap("steps")

    // 9. cleanup
    yield* cleanup
    yield* lap("cleanup")
    const message = operation._tag === "send" || operation._tag === "createPost" || operation._tag === "createThread" ? Drivers.createdMessageOf(called) : undefined
    const stepText = (step: "n/a" | "pass" | TruthTable.RecordedError) => (typeof step === "string" ? step : `${step.tag}[${step.categories.join(",")}]`)
    yield* context.log(
      `${scenario.id}: ${settled.resent.length > 0 ? `resent ${settled.resent.join(",")} for obfuscation; ` : ""}raw ${raw.class} ${raw.status} ${raw.code}${prior._tag === "Sent" ? ` after prior send ${prior.messageId}` : ""}${message === undefined ? "" : ` created ${message}`}; preflight ${records.preflightSet.join(",") || "pass"}; (b) ${stepText(stepB.step)}; request ${requestProblems.length === 0 ? "same" : "DIFFERS"}; (d) ${stepText(recompute)}; masks ${records.resolver.masks.join(",") || "none"}; oracle ${typeof oracle === "string" ? oracle : oracle.missing.join(",") || "none missing"}; ${profile()}`
    )
    const row: Omit<TruthTable.Row, "agreement"> = { ...base, resolver: records.resolver, preflight: stepB.step, preflightSet: records.preflightSet, raw, recompute, oracle }
    return { ...row, agreement: matrixRowAgreement(wired, requestProblems, agreement(row, facts)) }
  })

const lookupId = (ids: Materialize.Ids, name: Materialize.LabName): Effect.Effect<ChannelId> => {
  const id = ids.channels.get(name)
  return id === undefined ? Effect.die(new Error(`no ID for ${name}`)) : Effect.succeed(id)
}

/** Runs the matrix once over `scenarios` (the lab reset and provisioned first, and reset after). */
export const runOnce = (report: IdentityReport, scenarios: ReadonlyArray<Scenario>, log: (line: string) => Effect.Effect<void, PlatformError>) =>
  Effect.gen(function* () {
    const context = Reset.contextFrom(report)
    const started = yield* Clock.currentTimeMillis
    const reset = yield* Reset.run(context)
    yield* Effect.sync(() => console.log(`reset: ${Reset.summary(reset)}`))
    const provision = yield* Provision.run(context)
    yield* Effect.sync(() => console.log(`provision: ${Provision.summary(provision)}`))
    const state = yield* LabIds.load(context.guildId).pipe(Effect.provide(BunFileSystem.layer))
    const ids = yield* idsOf(state, report)
    yield* checkRoleBudget(ids, roleEditsOf(order(scenarios)) + roleEditMargin)

    // the pairwise selections (every row valid, every valid pair and value covered, deterministic), then Safety
    // over the catalog and every scenario's materialized state, before any scenario write
    const selection = Object.entries(families).flatMap(([name, family]) => selectionProblems(name, family))
    if (selection.length > 0) return yield* Effect.die(new Error(`pairwise selection: ${selection.join("; ")}`))
    const now = yield* Clock.currentTimeMillis
    const violations = [...Safety.checkCatalog(scenarios), ...scenarios.flatMap((scenario) => Safety.checkMaterialized(scenario, Materialize.desired(scenario.setup, ids), ids, now))]
    if (violations.length > 0) return yield* Effect.die(new Error(`Safety: ${violations.map((violation) => `${violation.scenario} ${violation.rule}: ${violation.detail}`).join("; ")}`))
    // a probe that mentions a lab role pings its holders: Rhys (the owner) must hold none of them (§5.6)
    const mentionedRoles = new Set<LabIds.RoleName>(
      scenarios.flatMap((scenario): ReadonlyArray<LabIds.RoleName> =>
        scenario.operation._tag === "rule" ? probes[scenario.operation.probe].mentions.roles : scenario.operation._tag === "send" && scenario.operation.payload === "mention-role" ? ["lab-unmentionable"] : []
      )
    )
    if (mentionedRoles.size > 0) {
      const harnessRest = yield* HarnessRest
      const owner = yield* harnessRest.getGuildMember(ids.guildId, ids.ownerId).pipe(labStep("Safety: read the owner's roles"), Effect.flatMap(Wire.decode(Wire.Member, "getGuildMember")))
      const held = [...mentionedRoles].filter((name) => {
        const id = ids.roles.get(name)
        return id === undefined || owner.roles.includes(id)
      })
      if (held.length > 0) return yield* Effect.die(new Error(`Safety: the owner holds ${held.join(", ")}, which a rule probe mentions`))
    }

    const rest = yield* HarnessRest
    const roles = yield* rest.listGuildRoles(context.guildId).pipe(
      Effect.mapError((error) => new LabRequestFailed({ step: "run: list roles", status: 0, code: 0, message: error._tag })),
      Effect.flatMap((body) => Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String, permissions: Schema.String })))(body).pipe(Effect.orDie))
    )
    const everyone = roles.find((role) => role.id === context.guildId)
    const everyoneBaseline = everyone === undefined ? [] : Flags.toSortedNames(Flags.fromBits(BigInt(everyone.permissions)))

    const canned = yield* DryRun.loadCanned.pipe(Effect.provide(BunFileSystem.layer))
    const runContext: Context = { ids, stickerId: state.sticker, emojiId: state.emoji, log, oracleSeen: { unavailable: false }, dirty: new Set(), canned, known: Converge.unknownView }
    const ordered = order(scenarios)
    const rows: Record<string, TruthTable.Row> = {}
    const pacing = yield* Pacing
    for (const [index, scenario] of ordered.entries()) {
      const before = yield* Clock.currentTimeMillis
      const limitedBefore = new Map((yield* pacing.stats).rateLimitedByRoute)
      const row = yield* execute(scenario, runContext, report.harness.userId)
      rows[scenario.id] = row
      const after = yield* Clock.currentTimeMillis
      const limited = (yield* pacing.stats).rateLimitedByRoute
        .map(([route, count]) => [route, count - (limitedBefore.get(route) ?? 0)] as const)
        .filter(([, count]) => count > 0)
        .map(([route, count]) => `${route} x${count}`)
      if (limited.length > 0) yield* log(`  429s during ${scenario.id}: ${limited.join(", ")}`)
      const elapsed = after - started
      const eta = Math.round(((elapsed / (index + 1)) * (ordered.length - index - 1)) / 1000)
      yield* Effect.sync(() =>
        console.log(
          `[${index + 1}/${ordered.length}] ${scenario.id}: ${row.raw.class}${row.agreement === "agree" ? "" : ` MISMATCH ${row.agreement}`} (${after - before} ms, eta ${eta} s${limited.length > 0 ? `, 429: ${limited.join(", ")}` : ""})`
        )
      )
    }
    // flip controls are judged against their originals once both have run (§5.9)
    for (const scenario of ordered) {
      const original = scenario.flipOf === undefined ? undefined : rows[scenario.flipOf]
      const flip = rows[scenario.id]
      if (scenario.flipOf === undefined || flip === undefined) continue
      if (original === undefined) {
        yield* log(`  ${scenario.id}: its original ${scenario.flipOf} did not run, so the flip control was not judged`)
        continue
      }
      rows[scenario.id] = { ...flip, agreement: flipAgreement(original, flip) }
    }
    const closing = yield* Reset.run(context)
    yield* Effect.sync(() => console.log(`closing reset: ${Reset.summary(closing)}`))

    const versions = yield* Effect.all({ typescript: versionOf("typescript"), dfx: versionOf("dfx"), discordApiTypes: versionOf("discord-api-types") }).pipe(Effect.provide(BunFileSystem.layer))
    const table: TruthTable.TruthTable = {
      schema: 2,
      env: {
        mfaLevel: report.guild.mfa_level,
        obfuscation: Predict.obfuscation,
        oracle: runContext.oracleSeen.unavailable ? "unavailable" : "available",
        ...versions,
        everyoneBaseline: [...everyoneBaseline]
      },
      scenarios: rows
    }
    const mismatches = Object.entries(rows)
      .filter(([, row]) => row.agreement !== "agree")
      .map(([id, row]): readonly [string, TruthTable.AgreementKind] => [id, row.agreement])
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return { table, scenarios: ordered.length, mismatches, durationMs: (yield* Clock.currentTimeMillis) - started } satisfies RunResult
  })

/** The lab-step retries between two stats readings, as `step xN` items, or `none`. */
export const retriedSince = (before: ReadonlyArray<readonly [string, number]>, after: ReadonlyArray<readonly [string, number]>): string => {
  const earlier = new Map(before)
  const added = after.map(([step, count]) => [step, count - (earlier.get(step) ?? 0)] as const).filter(([, count]) => count > 0)
  return added.map(([step, count]) => `${step} x${count}`).join(", ") || "none"
}

/** The run log's path for a run started at `startedAt`. */
export const logPath = (startedAt: number): string => `/tmp/effect-discord-perms-live-${startedAt}.log`

/** What `run` decided: whether the run passes (zero mismatches, and identical tables where compared). */
export interface Verdict {
  readonly ok: boolean
}

/** `verify:live` / `run` (§5.1): the matrix, the table, the comparison and the summary. */
export const run = (report: IdentityReport, options: Options) =>
  Effect.gen(function* () {
    const only = options.only
    const scenarios = only === undefined ? catalog : catalog.filter((scenario) => globMatches(only, scenario.id))
    if (scenarios.length === 0) return yield* new LabCheckFailed({ check: "run", detail: `--only ${only ?? "(none)"} matches no scenario` })
    const startedAt = yield* Clock.currentTimeMillis
    const path = logPath(startedAt)
    const fs = yield* FileSystem.FileSystem
    const log = (line: string) => fs.writeFileString(path, `${line}\n`, { flag: "a" })
    yield* Effect.sync(() => console.log(`run: ${scenarios.length} scenarios${options.only === undefined ? "" : ` matching ${options.only}`}; run log ${path}`))

    const tablePath = options.only === undefined ? committedPath : subsetPath(options.only)
    const previous = options.compare ? yield* TruthTable.read(tablePath) : undefined
    const pacing = yield* Pacing
    const statsBefore = yield* pacing.stats
    const results: Array<RunResult> = []
    for (let pass = 0; pass < options.repeat; pass++) results.push(yield* runOnce(report, scenarios, log))
    const result = results.at(-1)
    if (result === undefined) return yield* Effect.die(new Error("run: --repeat must be at least 1"))
    const stats = yield* pacing.stats
    const escalated = escalatedRules(rules)

    const lines: Array<string> = [
      `scenarios: ${result.scenarios}${options.repeat > 1 ? ` (x${options.repeat})` : ""}`,
      `duration: ${Math.round(result.durationMs / 1000)} s`,
      `requests: ${stats.requests - statsBefore.requests}, writes: ${stats.writes - statsBefore.writes}, invalid (401/403/429): ${stats.invalid - statsBefore.invalid}`,
      `rate limited (429, retried by dfx): ${stats.rateLimitedByRoute.map(([route, count]) => `${route} x${count}`).join(", ") || "none"}`,
      `lab steps retried after a 5xx: ${retriedSince(statsBefore.labRetries, stats.labRetries)}`,
      `oracle: ${result.table.env.oracle}`,
      `mismatches: ${result.mismatches.length}`,
      ...result.mismatches.map(([id, kind]) => `  ${kind}: ${id}`),
      `unmet Done criteria (escalated rules, waiting for Rhys; LOG.md "Waiting for Rhys" has each question's checklist): ${escalated.length === 0 ? "none" : escalated.length}`,
      ...unmetDoneCriteria(escalated).map((line) => `  ${line}`)
    ]
    let identical = true
    for (const [index, earlier] of results.slice(0, -1).entries()) {
      const differences = TruthTable.differences(earlier.table, result.table)
      lines.push(`repeat ${index + 1} vs last: ${differences.length === 0 ? "identical" : `differs in ${differences.join(", ")}`}`)
      if (differences.length > 0) identical = false
    }
    if (options.compare) {
      if (previous === undefined) {
        lines.push(`compare: no previous table at ${tablePath}`)
        identical = false
      } else {
        const differences = TruthTable.differences(previous, result.table)
        lines.push(`compare: ${differences.length === 0 ? "identical to" : `differs from`} the previous table at ${tablePath}${differences.length === 0 ? "" : ` in ${differences.join(", ")}`}`)
        if (differences.length > 0) identical = false
      }
    }
    if (options.write) {
      yield* TruthTable.write(tablePath, result.table)
      lines.push(`written: ${tablePath}`)
    }
    yield* Effect.sync(() => console.log(lines.join("\n")))
    return { ok: result.mismatches.length === 0 && identical } satisfies Verdict
  })
