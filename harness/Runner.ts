/**
 * The matrix runner (DESIGN §5.1 `verify:live`, §5.10): resets and provisions the lab, runs the catalog
 * serially, and writes the truth table.
 *
 * One scenario (§5.10):
 *
 * 1. **Converge** to the materialized desired state (`Converge.ts`, the fixed order of §5.8).
 * 2. **Fixtures**: the harness posts what the payload needs, then sets the thread's archived and locked state.
 * 3. **Wait** until the harness's read-back, the subject's gateway state and the oracle agree (`Wait.ts`).
 * 4. **(a) Resolver** over the subject's guild state. A scenario thread is refreshed first through the
 *    library's `GuildState.refresh`, so the subject's view of it is a function of the setup (fetched when it
 *    can see it, unseen when it cannot), not of which events earlier scenarios happened to deliver.
 * 5. **(b) Preflight**: `Preflight.decide` (M6 switches this step to the real operation over `DryRun`).
 * 6. **(c) Raw call** through `SubjectRaw`, with no check, classified by `Outcome.ts`. A payload that mentions
 *    `@everyone` is sent only if the oracle shows the subject without MentionEveryone and Administrator.
 * 7. **(d) Recompute**: `n/a` until M5.
 * 8. **Oracle**: the value the wait settled on, restricted to the required flags.
 * 9. **Cleanup**: the scenario channel's bot messages, and the thread back to baseline.
 * 10. **Record** the row with its agreement.
 *
 * Scenarios are grouped by setup (equal setups run back to back, so the lab converges once per group) and run
 * in a fixed order, so runs are reproducible. A timeout of the raw call, a wait past its cap, or a refused
 * guard check aborts the run as an infrastructure failure; nothing is retried to get a pass. Per-run detail
 * (message IDs, timings) goes to the run log, never to the table.
 */
import { BunFileSystem } from "@effect/platform-bun"
import { Clock, Duration, Effect, FileSystem, Option, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { BotRuntime } from "../src/bot/Bot.ts"
import { SubjectRaw } from "../src/bot/Internals.ts"
import { PreflightDecision } from "../src/errors/Cause.ts"
import type { Transient } from "../src/errors/Transient.ts"
import * as Flags from "../src/permissions/Flags.ts"
import { decide, tagOf, toError } from "../src/permissions/Preflight.ts"
import { inputFromSnapshot, resolve } from "../src/permissions/Resolver.ts"
import * as Oracle from "../src/rest/Oracle.ts"
import { send } from "../src/rest/Request.ts"
import { type ChannelId, type GuildId, MessageId, type RoleId, type StickerId } from "../src/Snowflake.ts"
import { isThreadKind } from "../src/state/Snapshot.ts"
import { agreement } from "./Agreement.ts"
import * as Converge from "./Converge.ts"
import { HarnessRest } from "./Identities.ts"
import type { IdentityReport } from "./IdentityCheck.ts"
import { LabCheckFailed, type LabGuard, LabRequestFailed } from "./Lab.ts"
import * as LabIds from "./LabIds.ts"
import * as Materialize from "./Materialize.ts"
import * as Outcome from "./Outcome.ts"
import { Pacing } from "./Pacing.ts"
import * as Provision from "./Provision.ts"
import * as Reset from "./Reset.ts"
import * as SendCatalog from "./scenario/catalog/send.ts"
import { operationKey, type Scenario, Setup } from "./scenario/Dsl.ts"
import * as Safety from "./scenario/Safety.ts"
import * as TruthTable from "./TruthTable.ts"
import * as Wait from "./Wait.ts"

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

/** The catalog M3 runs: the send family and its targeted rows. */
export const catalog: ReadonlyArray<Scenario> = SendCatalog.scenarios

const encodeSetup = Schema.encodeSync(Schema.toCodecJson(Setup))

/** Groups equal setups together, keeping each group in ID order and the groups in a fixed order (§5.10). */
export const order = (scenarios: ReadonlyArray<Scenario>): ReadonlyArray<Scenario> => {
  const signature = (scenario: Scenario) => TruthTable.canonicalJson(encodeSetup(scenario.setup))
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
  readonly log: (line: string) => Effect.Effect<void, PlatformError>
  readonly oracleSeen: { unavailable: boolean }
  /**
   * The lab channels whose overwrites may differ from baseline: the previous scenario's (its desired overwrites,
   * or the temporary View grant cleanup made). Every other lab channel is at baseline since the opening reset.
   */
  readonly dirty: Set<LabIds.ChannelName>
}

const infrastructure = (what: string) => (error: Transient) => Effect.die(new Error(`infrastructure abort: ${what}: ${error._tag}`))

const toLabFailure = (error: Oracle.OracleFailed): LabRequestFailed =>
  error.cause._tag === "DiscordResponse"
    ? new LabRequestFailed({ step: "oracle", status: error.cause.status, code: error.cause.code, message: error.cause.message })
    : new LabRequestFailed({ step: "oracle", status: 0, code: 0, message: `no response (${error.cause.reason})` })

const botAuthors = (ids: Materialize.Ids, harness: string): ReadonlySet<string> => new Set([harness, ids.subjectUserId, ids.targetUserId])

/** Runs one scenario and returns its row. */
const execute = (scenario: Scenario, context: Context, harnessUserId: string) =>
  Effect.gen(function* () {
    const { ids } = context
    const operation = scenario.operation
    const payload = operation.payload
    const facts = SendCatalog.factsOf(scenario.setup.channel, payload)
    const state = Materialize.desired(scenario.setup, ids)
    const base = { setup: scenario.setup, operation: operationKey(operation), recompute: "n/a" as const }
    const unsupportedRow = (raw: TruthTable.RawOutcome): TruthTable.Row => ({
      ...base,
      resolver: { required: Flags.sortFlags(facts.required), missing: [], missingBeforeMasks: [], masks: [], level: "none" },
      preflight: "n/a",
      preflightSet: [],
      raw,
      oracle: "not-applicable",
      agreement: "agree"
    })
    if (ids.unavailable.has(state.channel)) return unsupportedRow(Outcome.unsupported("kind-not-available"))
    const channelId = ids.channels.get(state.channel)
    if (channelId === undefined) return yield* Effect.die(new Error(`no ID for ${state.channel}`))
    const rest = yield* HarnessRest
    const runtime = yield* BotRuntime
    const subjectRaw = yield* SubjectRaw
    const cleanup = Effect.andThen(Converge.cleanMessages({ id: channelId, name: state.channel }, botAuthors(ids, harnessUserId)), Converge.restoreThread(state, ids))

    // 1-2. converge, fixtures, thread state
    const times: Array<readonly [string, number]> = []
    let mark = yield* Clock.currentTimeMillis
    const lap = (step: string) =>
      Effect.map(Clock.currentTimeMillis, (at) => {
        times.push([step, at - mark])
        mark = at
      })
    const channels: ReadonlySet<LabIds.ChannelName> = new Set([...context.dirty, state.overwriteChannel])
    // whatever happens next, the scenario's channel may be off baseline afterwards
    context.dirty.clear()
    context.dirty.add(state.overwriteChannel)
    const converged = yield* Converge.converge(state, ids, channels)
    yield* lap("converge")
    if (converged._tag === "TimeoutRefused") {
      yield* cleanup
      return unsupportedRow(Outcome.unsupported("bot-not-timeoutable", converged.status, converged.code))
    }
    if (converged._tag === "AdminExempt") {
      yield* cleanup
      return unsupportedRow(Outcome.unsupported("admin-exempt"))
    }
    let replyTo: MessageId | undefined
    if (scenario.setup.fixtures.includes("harness-message")) replyTo = (yield* Converge.postHarnessMessage(channelId)).id
    yield* Converge.applyThreadState(state, ids)
    yield* lap("fixtures")

    // 3. wait
    const readOracle = Oracle.memberPermissions(rest, channelId, ids.subjectUserId, Duration.seconds(30)).pipe(
      Effect.mapError(toLabFailure),
      Effect.map((read): Wait.OracleValue => (read._tag === "Permissions" ? { _tag: "Permissions", permissions: read.permissions } : { _tag: "Unavailable" }))
    )
    const settled = yield* Wait.settle({ scenario: scenario.id, state, ids, guildState: runtime.guildState, guildId: ids.guildId, channel: channelId, readOracle, channels })
    yield* lap("wait")

    // 4. (a) the resolver over the subject's state
    if (isThreadKind(Materialize.kindOf(state.channel))) yield* runtime.guildState.refresh(ids.guildId, channelId).pipe(Effect.catch(infrastructure("refresh")))
    const now = yield* Clock.currentTimeMillis
    let fromState = inputFromSnapshot(yield* runtime.guildState.snapshot, ids.guildId, channelId, now)
    if (fromState._tag === "NeedsRefresh") {
      yield* runtime.guildState.refresh(ids.guildId, channelId).pipe(Effect.catch(infrastructure("refresh")))
      fromState = inputFromSnapshot(yield* runtime.guildState.snapshot, ids.guildId, channelId, now)
    }
    if (fromState._tag === "NeedsRefresh") return yield* Effect.die(new Error(`${scenario.id}: the subject's state still lacks what it needs after a refresh: ${fromState.reason}`))
    const resolution = resolve(fromState.input)
    const resolver = TruthTable.resolverRecord(facts.op, resolution, facts.required, facts.needed)

    // 5. (b) preflight
    const decision = decide(facts.op, resolution, { payload: facts.features })
    const preflightSet = decision.failures.map((failure) => tagOf(facts.op, failure))
    const [first] = decision.failures
    const cause = new PreflightDecision({ route: "/channels/{channel.id}/messages", basis: "gateway-state" })
    const preflight: TruthTable.Row["preflight"] = first === undefined ? "pass" : TruthTable.recordError(toError(facts.op, first, cause))

    // 8. the oracle (read during the wait)
    const oracleValue = settled.oracle
    const oracle: TruthTable.Row["oracle"] =
      oracleValue._tag === "Unavailable"
        ? "unavailable"
        : { missing: Flags.sortFlags(facts.required.filter((flag) => !Flags.has(Flags.fromBits(oracleValue.permissions), flag))) }
    if (settled.oracle._tag === "Unavailable") context.oracleSeen.unavailable = true

    // 6. (c) the raw call, with Safety's live check for @everyone
    if (payload === "mention-everyone") {
      const allowed = settled.oracle._tag === "Permissions" ? Flags.fromBits(settled.oracle.permissions) : undefined
      if (allowed !== undefined && (Flags.has(allowed, "MentionEveryone") || Flags.has(allowed, "Administrator"))) {
        return yield* Effect.die(new Error(`Safety: ${scenario.id} would mention @everyone while the oracle shows the subject may ping everyone`))
      }
    }
    const wire = SendCatalog.wirePayload(payload, { replyTo, stickerId: context.stickerId })
    const call = subjectRaw.createMessage(channelId, wire.request)
    const answer = yield* send("/channels/{channel.id}/messages", "POST", wire.files.length > 0 ? subjectRaw.withFiles(wire.files)(call) : call, Duration.seconds(30)).pipe(
      Effect.catch(infrastructure(`${scenario.id}: the raw call`))
    )
    const raw =
      answer._tag === "Ok"
        ? Outcome.succeeded(payload, yield* Schema.decodeUnknownEffect(Outcome.CreatedMessage)(answer.body).pipe(Effect.orDie))
        : Outcome.rejected(answer.response)
    const created = answer._tag === "Ok" ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Struct({ id: MessageId }))(answer.body)) : undefined

    yield* lap("steps")

    // 9. cleanup
    yield* cleanup
    yield* lap("cleanup")
    yield* context.log(
      `${scenario.id}: raw ${raw.class} ${raw.status} ${raw.code}${created === undefined ? "" : ` message ${created.id}`}${replyTo === undefined ? "" : ` fixture ${replyTo}`}; preflight ${preflightSet.join(",") || "pass"}; masks ${resolver.masks.join(",") || "none"}; oracle ${typeof oracle === "string" ? oracle : oracle.missing.join(",") || "none missing"}; ms ${times.map(([step, ms]) => `${step} ${ms}`).join(", ")}`
    )
    const row: Omit<TruthTable.Row, "agreement"> = { ...base, resolver, preflight, preflightSet, raw, oracle }
    return { ...row, agreement: agreement(row, facts) }
  })

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

    // Safety, over the catalog and every scenario's materialized state, before any scenario write
    const now = yield* Clock.currentTimeMillis
    const violations = [...Safety.checkCatalog(scenarios), ...scenarios.flatMap((scenario) => Safety.checkMaterialized(scenario, Materialize.desired(scenario.setup, ids), ids, now))]
    if (violations.length > 0) return yield* Effect.die(new Error(`Safety: ${violations.map((violation) => `${violation.scenario} ${violation.rule}: ${violation.detail}`).join("; ")}`))

    const rest = yield* HarnessRest
    const roles = yield* rest.listGuildRoles(context.guildId).pipe(
      Effect.mapError((error) => new LabRequestFailed({ step: "run: list roles", status: 0, code: 0, message: error._tag })),
      Effect.flatMap((body) => Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String, permissions: Schema.String })))(body).pipe(Effect.orDie))
    )
    const everyone = roles.find((role) => role.id === context.guildId)
    const everyoneBaseline = everyone === undefined ? [] : Flags.toSortedNames(Flags.fromBits(BigInt(everyone.permissions)))

    const runContext: Context = { ids, stickerId: state.sticker, log, oracleSeen: { unavailable: false }, dirty: new Set() }
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
    const closing = yield* Reset.run(context)
    yield* Effect.sync(() => console.log(`closing reset: ${Reset.summary(closing)}`))

    const versions = yield* Effect.all({ typescript: versionOf("typescript"), dfx: versionOf("dfx"), discordApiTypes: versionOf("discord-api-types") }).pipe(Effect.provide(BunFileSystem.layer))
    const table: TruthTable.TruthTable = {
      schema: 2,
      env: {
        mfaLevel: report.guild.mfa_level,
        obfuscation: "default",
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

    const lines: Array<string> = [
      `scenarios: ${result.scenarios}${options.repeat > 1 ? ` (x${options.repeat})` : ""}`,
      `duration: ${Math.round(result.durationMs / 1000)} s`,
      `requests: ${stats.requests - statsBefore.requests}, writes: ${stats.writes - statsBefore.writes}, invalid (401/403/429): ${stats.invalid - statsBefore.invalid}`,
      `rate limited (429, retried by dfx): ${stats.rateLimitedByRoute.map(([route, count]) => `${route} x${count}`).join(", ") || "none"}`,
      `oracle: ${result.table.env.oracle}`,
      `mismatches: ${result.mismatches.length}`,
      ...result.mismatches.map(([id, kind]) => `  ${kind}: ${id}`),
      "escalated rules (unmet Done criteria): none in this catalog"
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
