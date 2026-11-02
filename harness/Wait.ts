/**
 * Consistency waits (DESIGN §5.10 step 3, G9). Before a scenario's steps run, all of these must hold, within a
 * 15 s cap; otherwise the run aborts with `setup-timeout`, an infrastructure failure that is never recorded as
 * a mismatch:
 *
 * - the harness's read-back equals the desired state (`Converge.readbackProblems`);
 * - the subject's guild state equals the desired state's subject-observable projection
 *   (`Materialize.projectionProblems`), watched through `GuildState.changes`, so no request is made;
 * - two oracle reads 300 ms apart are identical (when the oracle is available);
 * - a further 250 ms has passed.
 */
import { Clock, Duration, Effect, Option, Schema, Stream } from "effect"
import type * as GuildState from "../src/state/GuildState.ts"
import type { ChannelId, GuildId } from "../src/Snowflake.ts"
import * as Converge from "./Converge.ts"
import type { HarnessRest } from "./Identities.ts"
import type { LabRequestFailed } from "./Lab.ts"
import * as Materialize from "./Materialize.ts"

/** The cap on one scenario's wait. */
export const cap = Duration.seconds(15)

/** The setup did not settle within the cap: an infrastructure abort, never a row. */
export class SetupTimeout extends Schema.TaggedError<SetupTimeout>()("SetupTimeout", { scenario: Schema.String, detail: Schema.String }) {}

/** An oracle read as the wait compares it: the permissions, or the route's absence. */
export type OracleValue = { readonly _tag: "Permissions"; readonly permissions: bigint } | { readonly _tag: "Unavailable" }

const sameOracle = (a: OracleValue, b: OracleValue): boolean =>
  a._tag === "Unavailable" ? b._tag === "Unavailable" : b._tag === "Permissions" && a.permissions === b.permissions

/** What the wait settled on: the oracle's stable value for the scenario channel. */
export interface Settled {
  readonly oracle: OracleValue
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
}): Effect.Effect<Settled, SetupTimeout | LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const remaining = Effect.map(Clock.currentTimeMillis, (now) => Math.max(0, Duration.toMillis(cap) - (now - started)))
    const timeout = (detail: string) => new SetupTimeout({ scenario: input.scenario, detail })

    // the harness's read-back
    let problems: ReadonlyArray<string> = []
    for (;;) {
      const view = yield* Converge.readView(input.state, input.ids)
      problems = Converge.readbackProblems(input.state, input.ids, view, yield* Clock.currentTimeMillis)
      if (problems.length === 0) break
      if ((yield* remaining) <= 500) return yield* timeout(`harness read-back: ${problems.join("; ")}`)
      yield* Effect.sleep(Duration.millis(500))
    }

    // the subject's state, against the projection
    const now = yield* Clock.currentTimeMillis
    const projection = Materialize.project(input.state, input.ids, now)
    let last: ReadonlyArray<string> = []
    const matched = yield* input.guildState.changes.pipe(
      Stream.mapEffect((snapshot) =>
        Effect.map(Clock.currentTimeMillis, (at) => {
          last = Materialize.projectionProblems(projection, snapshot, input.guildId, at)
          return last.length === 0
        })
      ),
      Stream.filter((ok) => ok),
      Stream.runHead,
      Effect.timeoutOrElse({ duration: Duration.millis(yield* remaining), orElse: () => Effect.succeedNone })
    )
    if (Option.isNone(matched)) return yield* timeout(`subject state: ${last.join("; ")}`)

    // the oracle, stable across two reads
    let previous = yield* input.readOracle
    for (;;) {
      yield* Effect.sleep(Duration.millis(300))
      const next = yield* input.readOracle
      if (sameOracle(previous, next)) break
      if ((yield* remaining) <= 300) return yield* timeout("the oracle did not settle")
      previous = next
    }
    yield* Effect.sleep(Duration.millis(250))
    return { oracle: previous }
  })
