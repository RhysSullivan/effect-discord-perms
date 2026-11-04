import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Option, Ref, SubscriptionRef } from "effect"
import * as Materialize from "../../harness/Materialize.ts"
import * as Predict from "../../harness/Predict.ts"
import { Setup } from "../../harness/scenario/Dsl.ts"
import { awaitSubjectState, CapabilitiesIgnored, SetupTimeout } from "../../harness/Wait.ts"
import type * as GuildState from "../../src/state/GuildState.ts"
import { entityKey, type Snapshot } from "../../src/state/Snapshot.ts"

/**
 * The obfuscation check (DESIGN §4.15, H-160) and the replay's model of it: with the capabilities codec, a lab channel
 * the subject cannot view is obfuscated in its state, with no overwrites, and one it can view keeps its real
 * overwrites. The check is the wait's (`Wait.awaitSubjectState`, the M7 verifier): a hidden channel still shown with
 * its real overwrites is resent, and one Discord then sends again unobfuscated fails the run with
 * `CapabilitiesIgnored`; one Discord sends nothing for is a late or lost event, a `SetupTimeout`.
 */
const ids = Predict.symbolicIds
const now = Date.parse("2026-11-03T12:00:00Z")
const hidden = new Setup({ channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }], removals: [{ flags: ["ViewChannel"], via: "member-overwrite-deny" }], memberState: "normal", fixtures: [] })
const visible = new Setup({ channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }], removals: [], memberState: "normal", fixtures: [] })

const textId = () => {
  const id = ids.channels.get("lab-text")
  if (id === undefined) throw new Error("no lab-text")
  return id
}
const textIn = (snapshot: Snapshot) => snapshot.guilds.get(ids.guildId)?.channels.get(textId())

/**
 * `snapshot` with lab-text as the gateway would show it without the capability: its real overwrites. `bump` moves its
 * generation, as a CHANNEL_UPDATE the reducer applied does.
 */
const unobfuscated = (state: Materialize.Desired, snapshot: Snapshot, bump: number): Snapshot => {
  const guild = snapshot.guilds.get(ids.guildId)
  const real = Materialize.channelOf(state, ids, "lab-text")
  if (guild === undefined) throw new Error("no guild")
  const key = entityKey.channel(real.id)
  return {
    ...snapshot,
    guilds: new Map([[ids.guildId, { ...guild, channels: new Map(guild.channels).set(real.id, real), generations: new Map(guild.generations).set(key, (guild.generations.get(key) ?? 0) + bump) }]])
  }
}

/** `snapshot` with lab-text's generation moved past `from`'s (the obfuscated update Discord sends after a resend). */
const bumped = (snapshot: Snapshot, from: Snapshot): Snapshot => {
  const guild = snapshot.guilds.get(ids.guildId)
  const key = entityKey.channel(textId())
  const previous = from.guilds.get(ids.guildId)?.generations.get(key) ?? 0
  if (guild === undefined) throw new Error("no guild")
  return { ...snapshot, guilds: new Map([[ids.guildId, { ...guild, generations: new Map(guild.generations).set(key, previous + 1) }]]) }
}

/** A guild state over a subscription ref, as the reducer and the gateway's stream make it. */
const stateOver = (ref: SubscriptionRef.SubscriptionRef<Snapshot>): GuildState.Interface => ({
  snapshot: SubscriptionRef.get(ref),
  changes: SubscriptionRef.changes(ref),
  apply: () => Effect.void,
  awaitGuild: (guild) => Effect.map(SubscriptionRef.get(ref), (snapshot) => Option.fromNullishOr(snapshot.guilds.get(guild))),
  refresh: () => Effect.succeed({ committed: true }),
  refreshGuild: () => Effect.succeed({ committed: true })
})

/**
 * Runs the wait's subject-state step over `start`, with `onResend` as what Discord does after the harness resends a
 * channel (it may update the state); returns the outcome and the channels resent.
 */
const waitOver = (state: Materialize.Desired, start: Snapshot, onResend: (current: Snapshot) => Snapshot | undefined) =>
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(start)
    const resends = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
    const exit = yield* Effect.exit(
      awaitSubjectState({
        scenario: "test",
        projection: Materialize.project(state, ids, now, Predict.obfuscation),
        guildState: stateOver(ref),
        guildId: ids.guildId,
        remainingMs: Effect.succeed(150),
        resendAfterMs: 20,
        resend: (names) =>
          Effect.gen(function* () {
            yield* Ref.update(resends, (all) => [...all, names])
            const next = onResend(yield* SubscriptionRef.get(ref))
            if (next !== undefined) yield* SubscriptionRef.set(ref, next)
          })
      })
    )
    return { exit, resends: yield* Ref.get(resends) }
  })

describe("obfuscation with the codec (H-160)", () => {
  it("rebuilds a channel the subject cannot view as obfuscated with no overwrites, and a visible one with its real overwrites", () => {
    const state = Materialize.desired(hidden, ids)
    expect(textIn(Predict.snapshotOf(state, ids, now))).toMatchObject({ obfuscated: true, overwrites: [] })
    const shown = Materialize.desired(visible, ids)
    expect(textIn(Predict.snapshotOf(shown, ids, now))).toMatchObject({ obfuscated: false })
    expect(textIn(Predict.snapshotOf(shown, ids, now))?.overwrites.length).toBeGreaterThan(0)
    expect(Predict.obfuscation).toBe("codec")
  })

  it.live("settles at once on a state that already shows the projection, resending nothing", () =>
    Effect.gen(function* () {
      const state = Materialize.desired(hidden, ids)
      const { exit, resends } = yield* waitOver(state, Predict.snapshotOf(state, ids, now), () => undefined)
      expect(exit).toStrictEqual(Exit.succeed([]))
      expect(resends).toStrictEqual([])
    }))

  it.live("resends a hidden lab-text still shown with its real overwrites, and settles when Discord sends it obfuscated", () =>
    Effect.gen(function* () {
      const state = Materialize.desired(hidden, ids)
      const obfuscated = Predict.snapshotOf(state, ids, now)
      const { exit, resends } = yield* waitOver(state, unobfuscated(state, obfuscated, 0), (current) => bumped(obfuscated, current))
      expect(exit).toStrictEqual(Exit.succeed(["lab-text"]))
      expect(resends).toStrictEqual([["lab-text"]])
    }))

  it.live("fails with CapabilitiesIgnored when Discord sends the resent channel again with its real overwrites", () =>
    Effect.gen(function* () {
      const state = Materialize.desired(hidden, ids)
      const { exit } = yield* waitOver(state, unobfuscated(state, Predict.snapshotOf(state, ids, now), 0), (current) => unobfuscated(state, current, 1))
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail") : undefined
      expect(error?._tag === "Fail" ? error.error : undefined).toBeInstanceOf(CapabilitiesIgnored)
      expect(error?._tag === "Fail" ? error.error.message : "").toContain("the gateway ignored capabilities")
    }))

  it.live("times out, without blaming the capability, when Discord sends nothing after the resend", () =>
    Effect.gen(function* () {
      const state = Materialize.desired(hidden, ids)
      const { exit, resends } = yield* waitOver(state, unobfuscated(state, Predict.snapshotOf(state, ids, now), 0), () => undefined)
      expect(resends).toStrictEqual([["lab-text"]])
      const error = Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail") : undefined
      expect(error?._tag === "Fail" ? error.error : undefined).toBeInstanceOf(SetupTimeout)
    }))
})
