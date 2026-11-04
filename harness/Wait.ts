/**
 * Consistency waits (DESIGN §5.10 step 3, G9). Before a scenario's steps run, all of these must hold, within a
 * 15 s cap; otherwise the run aborts with `setup-timeout`, an infrastructure failure that is never recorded as
 * a mismatch:
 *
 * - the harness's read-back equals the desired state (`Converge.readbackProblems`). The first read-back re-reads
 *   only what Converge, the fixtures and the thread's state wrote since Converge's own read (`Converge.rereadWritten`;
 *   nothing, when Converge found the setup in place): the rest of the view is Converge's read, which nothing changed
 *   since. A read-back that still differs is retried with every read Converge makes (`Converge.readView`);
 * - the subject's guild state equals the desired state's subject-observable projection
 *   (`Materialize.projectionProblems`), watched through `GuildState.changes`, so no request is made. With the codec a
 *   channel the subject cannot view must be obfuscated there; when one still shows its real overwrites after
 *   {@link resendAfter}, the harness resends that channel's own overwrites (`Converge.resendOverwrites`), which makes
 *   Discord send it again, obfuscated for the subject (M7 live: no update arrives on its own when the subject loses
 *   Administrator);
 * - two oracle reads {@link oracleGap} apart are identical (when the oracle is available and the operation has a
 *   channel);
 * - a further {@link settleGap} has passed.
 *
 * (After the M6 verifier, for the run time of §5.11: the read-back re-read everything Converge reads, and the gaps
 * were 300 and 250 ms.)
 */
import { Clock, Duration, Effect, Option, Schema, Stream } from "effect"
import type * as GuildState from "../src/state/GuildState.ts"
import type { ChannelId, GuildId } from "../src/Snowflake.ts"
import * as Converge from "./Converge.ts"
import type { HarnessRest } from "./Identities.ts"
import type { LabRequestFailed } from "./Lab.ts"
import type * as LabIds from "./LabIds.ts"
import * as Materialize from "./Materialize.ts"
import * as Predict from "./Predict.ts"

/** The cap on one scenario's wait. */
export const cap = Duration.seconds(15)

/** The pause between the two oracle reads that must agree (on top of the pacing's 200 ms between request starts). */
export const oracleGap = Duration.millis(100)

/** The settle after everything agrees. */
export const settleGap = Duration.millis(100)

/**
 * How long the wait gives Discord to obfuscate, on its own, the channels the subject stopped seeing before it resends
 * those still shown with their real overwrites (see `settle`).
 */
export const resendAfter = Duration.seconds(2)

/** The setup did not settle within the cap: an infrastructure abort, never a row. */
export class SetupTimeout extends Schema.TaggedError<SetupTimeout>()("SetupTimeout", { scenario: Schema.String, detail: Schema.String }) {}

/**
 * An oracle read as the wait compares it: the permissions, the route's absence, or no channel to read (member
 * operations resolve at guild level).
 */
export type OracleValue = { readonly _tag: "Permissions"; readonly permissions: bigint } | { readonly _tag: "Unavailable" } | { readonly _tag: "NotApplicable" }

const sameOracle = (a: OracleValue, b: OracleValue): boolean =>
  a._tag === "Permissions" ? b._tag === "Permissions" && a.permissions === b.permissions : a._tag === b._tag

/** What the wait settled on: the oracle's stable value for the scenario channel, and the harness's read-back. */
export interface Settled {
  readonly oracle: OracleValue
  /** The harness's view of the lab at the desired state (the runner keeps its roles and members for the next Converge). */
  readonly view: Converge.LabView
  /** The lab channels the wait resent so the subject's gateway would obfuscate them (for the run log). */
  readonly resent: ReadonlyArray<LabIds.ChannelName>
}

/** Waits until the lab, the subject's state and the oracle agree with `state` (see the module comment). */
export const settle = (input: {
  readonly scenario: string
  readonly state: Materialize.Desired
  readonly ids: Materialize.Ids
  readonly guildState: GuildState.Interface
  readonly guildId: GuildId
  readonly channel: ChannelId
  readonly readOracle: Effect.Effect<OracleValue, LabRequestFailed>
  /** The lab channels whose overwrites the read-back checks (see `Converge.readView`). */
  readonly channels: ReadonlySet<LabIds.ChannelName>
  /** Converge's read of the lab, and what was written since. */
  readonly converged: { readonly view: Converge.LabView; readonly written: Converge.Written }
}): Effect.Effect<Settled, SetupTimeout | LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const remaining = Effect.map(Clock.currentTimeMillis, (now) => Math.max(0, Duration.toMillis(cap) - (now - started)))
    const timeout = (detail: string) => new SetupTimeout({ scenario: input.scenario, detail })

    // the harness's read-back
    let problems: ReadonlyArray<string> = []
    let view: Converge.LabView
    for (let attempt = 0; ; attempt++) {
      view =
        attempt === 0
          ? yield* Converge.rereadWritten(input.state, input.ids, input.converged.view, input.converged.written)
          : yield* Converge.readView(input.state, input.ids, input.channels)
      problems = Converge.readbackProblems(input.state, input.ids, view, yield* Clock.currentTimeMillis)
      if (problems.length === 0) break
      if ((yield* remaining) <= 500) return yield* timeout(`harness read-back: ${problems.join("; ")}`)
      yield* Effect.sleep(Duration.millis(500))
    }

    // the subject's state, against the projection
    const now = yield* Clock.currentTimeMillis
    const projection = Materialize.project(input.state, input.ids, now, Predict.obfuscation)
    let last: ReadonlyArray<string> = []
    const matchedWithin = (ms: number) =>
      input.guildState.changes.pipe(
        Stream.mapEffect((snapshot) =>
          Effect.map(Clock.currentTimeMillis, (at) => {
            last = Materialize.projectionProblems(projection, snapshot, input.guildId, at)
            return last.length === 0
          })
        ),
        Stream.filter((ok) => ok),
        Stream.runHead,
        Effect.timeoutOrElse({ duration: Duration.millis(ms), orElse: () => Effect.succeedNone })
      )
    let resent: ReadonlyArray<LabIds.ChannelName> = []
    let matched = yield* matchedWithin(Math.min(Duration.toMillis(resendAfter), yield* remaining))
    if (Option.isNone(matched)) {
      // M7 live: Discord sends no obfuscated update for the channels a bot stops seeing when it loses Administrator,
      // so its state keeps their real overwrites; resending a channel's own overwrites makes Discord send it again,
      // obfuscated for the subject
      const stale = Materialize.staleUnobfuscated(projection, yield* input.guildState.snapshot, input.guildId)
      if (stale.length > 0) {
        yield* Converge.resendOverwrites(input.state, input.ids, stale)
        resent = stale
      }
      matched = yield* matchedWithin(yield* remaining)
    }
    if (Option.isNone(matched)) return yield* timeout(`subject state: ${last.join("; ")}`)

    // the oracle, stable across two reads
    let previous = yield* input.readOracle
    for (;;) {
      yield* Effect.sleep(oracleGap)
      const next = yield* input.readOracle
      if (sameOracle(previous, next)) break
      if ((yield* remaining) <= 300) return yield* timeout("the oracle did not settle")
      previous = next
    }
    yield* Effect.sleep(settleGap)
    return { oracle: previous, view, resent }
  })
