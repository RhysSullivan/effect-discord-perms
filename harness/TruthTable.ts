/**
 * The truth table (DESIGN §5.12, G9; `[sd:src/verify.ts]`, `[sd:truth-runtime.txt]`): one row per scenario,
 * symbolic only (no snowflakes, timestamps, messages, durations or retry counts), written canonically so two
 * runs that observed the same thing write the same bytes.
 *
 * Also the row builders shared by the runner and the offline replay: the resolver record of step (a), with its
 * `level`, preflight's record of step (b), and a library error as `{tag, categories}`.
 */
import { Effect, FileSystem, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { PreflightDecision } from "../src/errors/Cause.ts"
import { categoriesOf } from "../src/errors/Category.ts"
import { type PermissionFlag, PermissionFlags } from "../src/errors/Missing.generated.ts"
import * as Flags from "../src/permissions/Flags.ts"
import { type OpName, Operations, type OpSpec } from "../src/permissions/Operations.ts"
import { type Decision, decide, tagOf, toError } from "../src/permissions/Preflight.ts"
import { blindMasks, type Resolution } from "../src/permissions/Resolver.ts"
import { Observation, Setup } from "./scenario/Dsl.ts"
import type { Facts } from "./scenario/Facts.ts"

/** A permission flag name. */
export const Flag = Schema.Literals(PermissionFlags)

/** Why a scenario's setup could not be built; Observed constants derive only from the matching reason (§5.13). */
export const SetupUnsupported = Schema.Literals(["bot-not-timeoutable", "admin-exempt", "kind-not-available", "rejected-by-discord"])

/** Step (c): the raw call's outcome. */
export const RawOutcome = Schema.Struct({
  class: Schema.Literals(["success", "degraded", "50013", "50001", "other-error", "ignored", "event-delivered", "event-absent", "setup-unsupported"]),
  status: Schema.Int,
  code: Schema.Int,
  /** Inner 50035 codes with their paths, sorted (H-084). */
  inner: Schema.Array(Schema.Struct({ path: Schema.String, code: Schema.String })),
  /** Flags whose effect was silently dropped, read back from the subject's own create response (D35). */
  degraded: Schema.Array(Flag),
  /** The tag the error map gives this code before any recompute, or "n/a". */
  mappedTag: Schema.String,
  unsupported: Schema.optionalKey(SetupUnsupported)
})
/** A raw outcome. */
export type RawOutcome = typeof RawOutcome.Type

/** A library error as recorded: the tag and its runtime categories, so same-tag variants are told apart (D5). */
export const RecordedError = Schema.Struct({ tag: Schema.String, categories: Schema.Array(Schema.String) })
/** A recorded error. */
export type RecordedError = typeof RecordedError.Type

/** A resolver mask (`src/permissions/Resolver.ts`). */
export const Mask = Schema.Literals(["obfuscated", "unseen", "private-thread", "implicit-view", "implicit-send", "implicit-connect", "timeout"])

/** Step (a): what the resolver said, restricted to the operation's required flags, sorted. */
export const ResolverRecord = Schema.Struct({
  required: Schema.Array(Flag),
  missing: Schema.Array(Flag),
  missingBeforeMasks: Schema.Array(Flag),
  masks: Schema.Array(Mask),
  /** The first failing level (§5.10): `view`, `action` (View present, an error-mode flag missing) or `none`. */
  level: Schema.Literals(["none", "view", "action"])
})
/** A resolver record. */
export type ResolverRecord = typeof ResolverRecord.Type

/** Every agreement result (§5.10). */
export const AgreementKind = Schema.Literals([
  "agree",
  "preflight-wiring",
  "request-wiring",
  "preflight-vs-raw",
  "resolver-vs-raw",
  "level-vs-raw",
  "resolver-vs-oracle",
  "recompute-vs-preflight",
  "flip-control",
  "rule-observation"
])
/** An agreement result. */
export type AgreementKind = typeof AgreementKind.Type

/** One scenario's row. */
export const Row = Schema.Struct({
  setup: Setup,
  /** The symbolic operation, for example `send:embed`. */
  operation: Schema.String,
  resolver: ResolverRecord,
  /** Step (b): `pass`, the error, or `n/a` when the setup was unsupported. */
  preflight: Schema.Union([Schema.Literal("pass"), Schema.Literal("n/a"), RecordedError]),
  /** Every failure preflight found, in §3.2 order. */
  preflightSet: Schema.Array(Schema.String),
  raw: RawOutcome,
  /** Step (d): the library's error with preflight bypassed (live from M6), or `n/a`. */
  recompute: Schema.Union([Schema.Literal("n/a"), RecordedError]),
  /** Discord's own computation (implicit=false), restricted to the required flags. */
  oracle: Schema.Union([Schema.Struct({ missing: Schema.Array(Flag) }), Schema.Literal("unavailable"), Schema.Literal("not-applicable")]),
  observation: Schema.optionalKey(Observation),
  agreement: AgreementKind
})
/** A row. */
export type Row = typeof Row.Type

/** The table: an environment header and the rows by scenario ID. */
export const TruthTable = Schema.Struct({
  schema: Schema.Literal(2),
  env: Schema.Struct({
    mfaLevel: Schema.Int,
    obfuscation: Schema.Literals(["codec", "portal", "default"]),
    oracle: Schema.Literals(["available", "unavailable"]),
    typescript: Schema.String,
    dfx: Schema.String,
    discordApiTypes: Schema.String,
    everyoneBaseline: Schema.Array(Flag)
  }),
  scenarios: Schema.Record(Schema.String, Row)
})
/** The table. */
export type TruthTable = typeof TruthTable.Type

const isJsonArray = (value: Schema.Json): value is ReadonlyArray<Schema.Json> => Array.isArray(value)

/** Canonical JSON: keys sorted at every level, a 2-space indent and a trailing newline. Arrays keep their (pre-sorted) order. */
export const canonicalJson = (value: Schema.Json): string => {
  const sort = (current: Schema.Json): Schema.Json => {
    if (isJsonArray(current)) return current.map(sort)
    if (current === null || typeof current !== "object") return current
    return Object.fromEntries(
      Object.entries(current)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sort(entry)])
    )
  }
  return `${JSON.stringify(sort(value), null, 2)}\n`
}

const encodeTable = Schema.encodeSync(Schema.toCodecJson(TruthTable))
const decodeTable = Schema.decodeUnknownEffect(Schema.fromJsonString(TruthTable))

/** The table's canonical text. */
export const render = (table: TruthTable): string => canonicalJson(encodeTable(table))

/** Reads a table from `path`; `undefined` when there is none. A file that does not decode is a defect. */
export const read = (path: string): Effect.Effect<TruthTable | undefined, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(path))) return undefined
    const text = yield* fs.readFileString(path)
    return yield* decodeTable(text).pipe(
      Effect.mapError((error) => new Error(`${path} is not a truth table: ${error.message}`)),
      Effect.orDie
    )
  })

/** Writes `table` canonically to `path` (a temporary file renamed over it). */
export const write = (path: string, table: TruthTable): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const temporary = `${path}.tmp`
    yield* fs.writeFileString(temporary, render(table))
    yield* fs.rename(temporary, path)
  })

const encodeRow = Schema.encodeSync(Schema.toCodecJson(Row))
const encodeEnv = Schema.encodeSync(Schema.toCodecJson(TruthTable.fields.env))

/** The scenario IDs whose rows differ between two tables, plus `env` when the headers differ. Empty means identical bytes. */
export const differences = (before: TruthTable, after: TruthTable): ReadonlyArray<string> => {
  const out: Array<string> = []
  if (canonicalJson(encodeEnv(before.env)) !== canonicalJson(encodeEnv(after.env))) out.push("env")
  const ids = [...new Set([...Object.keys(before.scenarios), ...Object.keys(after.scenarios)])].sort()
  for (const id of ids) {
    const a = before.scenarios[id]
    const b = after.scenarios[id]
    if (a === undefined || b === undefined || canonicalJson(encodeRow(a)) !== canonicalJson(encodeRow(b))) out.push(id)
  }
  return out
}

// ---- row builders (shared with the offline replay) ----------------------------------------------------

/** A library error as the table records it. */
export const recordError = (error: { readonly _tag: string }): RecordedError => ({ tag: error._tag, categories: [...categoriesOf(error)] })

/**
 * The level of a resolution for an operation (§5.10): `view` when the bot cannot see the channel or the target
 * (a blind mask, or no ViewChannel, no Connect, or no `viewLevel` flag on a row that requires it; M4 live:
 * ReadMessageHistory for a pin or a crosspost), `action` when it can and preflight still found a
 * failure (a missing flag, the timeout, the hierarchy, the thread's state), `none` otherwise. Member operations
 * require neither View nor Connect, so they are never `view`.
 */
export const levelOf = (op: OpName, resolution: Resolution, decision: Pick<Decision, "failures">): ResolverRecord["level"] => {
  const row: OpSpec = Operations[op]
  if (resolution.masks.some((mask) => blindMasks.has(mask))) return "view"
  if (row.flags.includes("ViewChannel") && !Flags.has(resolution.effective, "ViewChannel")) return "view"
  if (row.flags.includes("Connect") && !Flags.has(resolution.effective, "Connect")) return "view"
  if ((row.viewLevel ?? []).some((flag) => !Flags.has(resolution.effective, flag))) return "view"
  return decision.failures.length > 0 ? "action" : "none"
}

/** Step (a)'s record: the required flags, what is missing after and before the masks, the masks and the level. */
export const resolverRecord = (op: OpName, resolution: Resolution, required: ReadonlyArray<PermissionFlag>, decision: Pick<Decision, "failures">): ResolverRecord => {
  const missingFrom = (set: Flags.PermissionSet) => Flags.sortFlags(required.filter((flag) => !Flags.has(set, flag)))
  return {
    required: Flags.sortFlags(required),
    missing: missingFrom(resolution.effective),
    missingBeforeMasks: missingFrom(resolution.afterOverwrites),
    masks: [...resolution.masks],
    level: levelOf(op, resolution, decision)
  }
}

/** Steps (a) and (b) as the table records them, from one resolution (shared by the runner and the replay). */
export interface StepRecords {
  readonly decision: Decision
  readonly resolver: ResolverRecord
  /** Step (b): preflight's first failure, or `pass` (until M6 step (b) is `Preflight.decide` itself). */
  readonly preflight: "pass" | RecordedError
  readonly preflightSet: ReadonlyArray<string>
}

/** Runs preflight over `resolution` for an operation with complete facts, and records steps (a) and (b). */
export const stepRecords = (facts: Facts, resolution: Resolution, route: string): StepRecords => {
  const decision = decide(facts.op, resolution, facts.args)
  const [first] = decision.failures
  const cause = new PreflightDecision({ route, basis: "gateway-state" })
  return {
    decision,
    resolver: resolverRecord(facts.op, resolution, facts.required, decision),
    preflight: first === undefined ? "pass" : recordError(toError(facts.op, first, cause)),
    preflightSet: decision.failures.map((failure) => tagOf(facts.op, failure))
  }
}
