import { describe, expect, it } from "vitest"
import * as Materialize from "../../harness/Materialize.ts"
import * as Predict from "../../harness/Predict.ts"
import { obfuscationProblem } from "../../harness/Runner.ts"
import { Setup } from "../../harness/scenario/Dsl.ts"
import type { Snapshot } from "../../src/state/Snapshot.ts"

/**
 * The obfuscation check (DESIGN §4.15, H-160; M7) and the replay's model of it: with the capabilities codec, a lab
 * channel the subject cannot view is obfuscated in its state, with no overwrites, and one it can view keeps its real
 * overwrites. The runner fails a run whose subject state shows a hidden `lab-text` unobfuscated.
 */
const ids = Predict.symbolicIds
const now = Date.parse("2026-11-03T12:00:00Z")
const hidden = new Setup({ channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }], removals: [{ flags: ["ViewChannel"], via: "member-overwrite-deny" }], memberState: "normal", fixtures: [] })
const visible = new Setup({ channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }], removals: [], memberState: "normal", fixtures: [] })

const textIn = (snapshot: Snapshot) => {
  const id = ids.channels.get("lab-text")
  return id === undefined ? undefined : snapshot.guilds.get(ids.guildId)?.channels.get(id)
}

/** `snapshot` with lab-text as the gateway would show it without the capability: its real overwrites. */
const unobfuscated = (state: Materialize.Desired, snapshot: Snapshot): Snapshot => {
  const guild = snapshot.guilds.get(ids.guildId)
  const real = Materialize.channelOf(state, ids, "lab-text")
  if (guild === undefined) throw new Error("no guild")
  return { ...snapshot, guilds: new Map([[ids.guildId, { ...guild, channels: new Map(guild.channels).set(real.id, real) }]]) }
}

describe("obfuscation with the codec (H-160)", () => {
  it("rebuilds a channel the subject cannot view as obfuscated with no overwrites, and a visible one with its real overwrites", () => {
    const state = Materialize.desired(hidden, ids)
    expect(textIn(Predict.snapshotOf(state, ids, now))).toMatchObject({ obfuscated: true, overwrites: [] })
    const shown = Materialize.desired(visible, ids)
    expect(textIn(Predict.snapshotOf(shown, ids, now))).toMatchObject({ obfuscated: false })
    expect(textIn(Predict.snapshotOf(shown, ids, now))?.overwrites.length).toBeGreaterThan(0)
    expect(Predict.obfuscation).toBe("codec")
  })

  it("passes a hidden lab-text the subject's state shows obfuscated, fails one shown with its real overwrites, and ignores visible channels", () => {
    const state = Materialize.desired(hidden, ids)
    const snapshot = Predict.snapshotOf(state, ids, now)
    expect(obfuscationProblem(state, ids, snapshot, now)).toBeUndefined()
    expect(obfuscationProblem(state, ids, unobfuscated(state, snapshot), now)).toContain("the gateway ignored capabilities")
    const shown = Materialize.desired(visible, ids)
    expect(obfuscationProblem(shown, ids, Predict.snapshotOf(shown, ids, now), now)).toBeUndefined()
  })
})
