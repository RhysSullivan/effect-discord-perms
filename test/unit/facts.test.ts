import { describe, expect, it } from "vitest"
import * as Predict from "../../harness/Predict.ts"
import { order, roleEditsOf } from "../../harness/Runner.ts"
import { flipSetup, flipsOf } from "../../harness/scenario/catalog/flips.ts"
import { coverageRows, familyRows, flipRows, scenarios } from "../../harness/scenario/catalog/index.ts"
import { Setup } from "../../harness/scenario/Dsl.ts"
import type { Operation } from "../../harness/scenario/Dsl.ts"
import * as Facts from "../../harness/scenario/Facts.ts"
import * as Materialize from "../../harness/Materialize.ts"
import * as Safety from "../../harness/scenario/Safety.ts"
import { Operations } from "../../src/permissions/Operations.ts"

/**
 * The scenario facts, the predictions from the setup alone, and the flip controls (DESIGN §4.7, §5.9, §5.13):
 * the operation-table row each operation uses per channel kind, the rebuilt subject state the replay resolves
 * over, and one flip sibling per (row, first missing flag).
 */
const now = Date.parse("2026-11-01T12:00:00Z")
const setup = (fields: Partial<ConstructorParameters<typeof Setup>[0]> = {}) => new Setup({ channel: "text", grants: [], removals: [], memberState: "normal", fixtures: [], ...fields })

describe("Facts.opOf", () => {
  const op = (operation: Operation, channel: Setup["channel"]) => Facts.opOf(operation, channel)
  it("picks the voice and thread variants by channel kind", () => {
    expect([op({ _tag: "send", payload: "plain" }, "voice"), op({ _tag: "send", payload: "plain" }, "forum-post"), op({ _tag: "send", payload: "plain" }, "forum")]).toEqual([
      "voice.send",
      "thread.send",
      "forum.createPost"
    ])
    const messages = (action: "edit-own" | "delete-own" | "delete-foreign" | "bulk-delete") =>
      (["text", "public-thread", "stage"] as const).map((channel) => op({ _tag: "message", action }, channel))
    expect(messages("edit-own")).toEqual(["message.edit.channel", "message.edit.thread", "message.edit.voice"])
    expect(messages("delete-own")).toEqual(["message.deleteOwn", "message.deleteOwn.thread", "message.deleteOwn.voice"])
    expect(messages("delete-foreign")).toEqual(["message.deleteForeign", "message.deleteForeign.thread", "message.deleteForeign.voice"])
    expect(messages("bulk-delete")).toEqual(["channel.bulkDelete", "thread.bulkDelete", "voice.bulkDelete"])
    expect(() => op({ _tag: "pins", action: "pin" }, "voice")).toThrow("no pins")
    expect(op({ _tag: "pins", action: "list" }, "voice")).toBe("voice.pins")
    expect(op({ _tag: "react", emoji: "guild" }, "private-thread")).toBe("message.react.thread")
    expect(op({ _tag: "channelEdit", field: "slowmode" }, "public-thread")).toBe("thread.edit")
    expect(op({ _tag: "thread", action: "unarchive" }, "public-thread")).toBe("thread.unarchive")
    expect(op({ _tag: "member", action: "kick" }, "text")).toBe("member.kick")
  })

  it("resolves member operations at guild level, with the target and (role operations) the role", () => {
    expect(Facts.staticFactsOf({ setup: setup(), operation: { _tag: "member", action: "add-role" } })).toMatchObject({ scope: "guild", onTarget: true, assignsRole: true })
    expect(Facts.staticFactsOf({ setup: setup(), operation: { _tag: "member", action: "nickname" } })).toMatchObject({ scope: "guild", onTarget: true, assignsRole: false })
    expect(Facts.staticFactsOf({ setup: setup(), operation: { _tag: "react", emoji: "unicode-existing" } })).toMatchObject({ scope: "channel", args: { payload: [], reaction: "existing" } })
  })

  it("uses an operation-table row for every catalog scenario", () => {
    const rows: ReadonlySet<string> = new Set(Object.keys(Operations))
    expect(scenarios.filter((scenario) => !rows.has(Facts.staticFactsOf(scenario).op)).map((scenario) => scenario.id)).toEqual([])
  })
})

describe("Predict", () => {
  const ids = Predict.symbolicIds

  it("rebuilds the scenario thread when the subject can see it, and marks it unseen when it cannot", () => {
    const visible = Materialize.desired(setup({ channel: "public-thread", threadState: "locked", grants: [{ flags: ["ViewChannel"], via: "role" }] }), ids)
    const guild = Predict.snapshotOf(visible, ids, now).guilds.get(ids.guildId)
    const threadId = ids.channels.get("lab-public-thread")
    if (guild === undefined || threadId === undefined) throw new Error("fixture")
    expect(guild.channels.get(threadId)?.thread).toMatchObject({ locked: true, archived: false })
    expect(guild.unseen.has(threadId)).toBe(false)
    const hidden = Materialize.desired(setup({ channel: "public-thread", grants: [{ flags: ["SendMessagesInThreads"], via: "role" }] }), ids)
    const blind = Predict.snapshotOf(hidden, ids, now).guilds.get(ids.guildId)
    expect(blind?.unseen.has(threadId)).toBe(true)
    expect(blind?.channels.has(threadId)).toBe(false)
  })

  it("predicts steps (a) and (b): a timed-out subject's send, a creator's archive, a member operation's hierarchy", () => {
    const timedOut = Predict.predict({ setup: setup({ grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }], memberState: "timed-out" }), operation: { _tag: "send", payload: "plain" } }, ids, now)
    expect(timedOut.records.preflightSet).toEqual(["CommunicationDisabled"])
    expect(timedOut.records.resolver.masks).toEqual(["timeout"])
    const archive = Predict.predict(
      { setup: setup({ channel: "public-thread", subjectThreadMember: true, grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }], fixtures: ["subject-thread"] }), operation: { _tag: "thread", action: "archive" } },
      ids,
      now
    )
    expect(archive.facts.args.creator).toBe(true)
    expect(archive.records.preflight).toBe("pass")
    const kick = Predict.predict({ setup: setup({ grants: [{ flags: ["KickMembers"], via: "role" }], targetRank: "equal", targetAdmin: false }), operation: { _tag: "member", action: "kick" } }, ids, now)
    expect(kick.facts.args.target).toEqual({ below: false, administrator: false })
    expect(kick.records.preflightSet).toEqual(["TargetAboveInHierarchy"])
  })
})

describe("the whole catalog", () => {
  it("has unique IDs and passes Safety, symbolically and over every scenario's materialized state", () => {
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length)
    expect(Safety.checkCatalog(scenarios)).toEqual([])
    const ids = Predict.symbolicIds
    expect(scenarios.flatMap((scenario) => Safety.checkMaterialized(scenario, Materialize.desired(scenario.setup, ids), ids, now))).toEqual([])
  })

  it("predicts every scenario from its setup alone", () => {
    const failing = scenarios.filter((scenario) => {
      if (Predict.symbolicIds.unavailable.has(Materialize.labNameOf(scenario.setup))) return false
      try {
        Predict.predict(scenario, Predict.symbolicIds, now)
        return false
      } catch {
        return true
      }
    })
    expect(failing.map((scenario) => scenario.id)).toEqual([])
  })

  it("refuses a kick or ban row the docs model would let succeed, and two name or topic edits of one channel", () => {
    const kick = { id: "member/test", hypotheses: [], setup: setup({ grants: [{ flags: ["KickMembers"], via: "role" }], targetRank: "below" }), operation: { _tag: "member", action: "kick" } } as const
    expect(Safety.checkScenario(kick).map((violation) => violation.rule)).toEqual(["kick-ban-must-fail"])
    expect(Safety.checkScenario({ ...kick, setup: setup({ grants: [{ flags: [], via: "administrator" }], targetRank: "below" }) }).map((violation) => violation.rule)).toEqual(["kick-ban-must-fail"])
    expect(Safety.checkScenario({ ...kick, setup: setup({ grants: [{ flags: ["KickMembers"], via: "role" }], targetRank: "equal" }) })).toEqual([])
    expect(Safety.checkScenario({ ...kick, setup: setup({ targetRank: "below" }) })).toEqual([])
    const granted = setup({ grants: [{ flags: ["ViewChannel", "ManageChannels"], via: "role" }] })
    const edit = (id: string, field: "name" | "topic", on = granted) => ({ id, hypotheses: [], setup: on, operation: { _tag: "channelEdit", field } as const })
    expect(Safety.checkCatalog([edit("a", "name")])).toEqual([])
    expect(Safety.checkCatalog([edit("a", "name"), edit("b", "topic")]).map((violation) => violation.rule)).toEqual(["one-rename-per-channel"])
    // an edit preflight predicts Discord refuses changes nothing, so it does not count (M6)
    expect(Safety.checkCatalog([edit("a", "name"), edit("b", "topic", setup())])).toEqual([])
  })
})

describe("the run order", () => {
  it("groups the catalog by role state, so a run changes role permissions once per state (Discord allows 1,000 role edits a day)", () => {
    const ordered = order(scenarios)
    expect([...ordered].map((scenario) => scenario.id).sort()).toEqual(scenarios.map((scenario) => scenario.id).sort())
    expect(order(scenarios)).toEqual(ordered)
    // M4: 68; M6 adds the rule rows, the coverage rows and their flips (77); M7's codec moves the ViewChannel flips
    // of timed-out rows, which the obfuscation now blinds, to coverage rows (80); the intent sessions add no role state
    expect(roleEditsOf(ordered)).toBe(80)
    // the M3 order (by setup alone) changed them far more often
    const bySetup = [...scenarios].sort((a, b) => (JSON.stringify(a.setup) < JSON.stringify(b.setup) ? -1 : 1))
    expect(roleEditsOf(bySetup)).toBeGreaterThan(150)
    const one = (flags: ReadonlyArray<"ViewChannel" | "SendMessages">) => ({ id: flags.join(), hypotheses: [], setup: setup({ grants: [{ flags, via: "role" as const }] }), operation: { _tag: "send" as const, payload: "plain" as const } })
    expect(roleEditsOf([one(["ViewChannel"]), one(["ViewChannel"]), one(["ViewChannel", "SendMessages"])])).toBe(1)
  })
})

describe("flip controls", () => {
  it("grant the flag where the original lacked it: out of every removal, into the first non-administrator grant", () => {
    const original = setup({
      grants: [{ flags: [], via: "administrator" }, { flags: ["ViewChannel"], via: "member-overwrite-allow" }],
      removals: [{ flags: ["SendMessages", "EmbedLinks"], via: "role-overwrite-deny" }]
    })
    const flipped = flipSetup(original, "SendMessages")
    expect(flipped.grants).toEqual([{ flags: [], via: "administrator" }, { flags: ["ViewChannel", "SendMessages"], via: "member-overwrite-allow" }])
    expect(flipped.removals).toEqual([{ flags: ["EmbedLinks"], via: "role-overwrite-deny" }])
    expect(flipSetup(setup(), "ViewChannel").grants).toEqual([{ flags: ["ViewChannel"], via: "role" }])
  })

  it("make one sibling per (row, first missing flag), never for kick or ban, and each sibling's prediction moves on (a blind row's flip passes outright)", () => {
    const originals = [...familyRows, ...coverageRows]
    const keys = flipRows.map((flip) => {
      const original = originals.find((row) => row.id === flip.flipOf)
      if (original === undefined) throw new Error(`${flip.id} has no original`)
      const before = Predict.predict(original, Predict.symbolicIds, now)
      const after = Predict.predict(flip, Predict.symbolicIds, now)
      const [first] = before.records.decision.failures
      if (first?._tag !== "MissingFlag") throw new Error(`${flip.id}: the original's first failure is not a flag`)
      // the sibling's failures are the original's without the flag
      expect({ id: flip.id, set: after.records.preflightSet }).toEqual({ id: flip.id, set: before.records.preflightSet.slice(1) })
      return `${before.facts.op}|${first.flag}`
    })
    expect(new Set(keys).size).toBe(keys.length)
    expect(flipRows.some((flip) => flip.operation._tag === "member" && (flip.operation.action === "kick" || flip.operation.action === "ban"))).toBe(false)
    expect(flipsOf(originals)).toEqual(flipRows)
  })
})
