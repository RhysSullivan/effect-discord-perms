import { describe, expect, it } from "vitest"
import * as Materialize from "../../harness/Materialize.ts"
import { scenarios as sendScenarios, targetedRows, wirePayload } from "../../harness/scenario/catalog/send.ts"
import { Setup } from "../../harness/scenario/Dsl.ts"
import { families, kickBanMustFail, pairsOf, pairwise, selectionProblems, validPairs } from "../../harness/scenario/Pairwise.ts"
import * as Safety from "../../harness/scenario/Safety.ts"
import { MessageId, StickerId } from "../../src/Snowflake.ts"
import { fakeIds } from "../support/lab.ts"

/**
 * The scenario catalog offline (DESIGN §5.9, §5.6): pairwise selection is deterministic, valid and covers
 * every valid pair; the send catalog passes Safety, both symbolically and over every scenario's materialized
 * state; and Safety catches the violations it exists for.
 */
const now = Date.parse("2026-11-01T12:00:00Z")

describe("pairwise selection", () => {
  it.each(Object.entries(families))("%s: the run-start check finds nothing wrong with the selection", (name, family) => {
    expect(selectionProblems(name, family)).toEqual([])
  })

  it("the run-start check names an invalid row, an uncovered pair, a missing value and a selection that is not the fresh one", () => {
    const family = { dimensions: { a: ["x", "y"], b: ["p", "q"] }, valid: (row: Readonly<Record<string, string>>) => !(row.a === "y" && row.b === "q") }
    const rows = pairwise(family)
    expect(selectionProblems("toy", family, rows)).toEqual([])
    expect(selectionProblems("toy", family, [...rows, { a: "y", b: "q" }])).toContain('toy: selected an invalid row {"a":"y","b":"q"}')
    const withoutY = rows.filter((row) => row.a !== "y")
    expect(selectionProblems("toy", family, withoutY)).toEqual(["toy: no row covers a=y|b=p", "toy: no row has a=y", "toy: the selection is not deterministic"])
  })

  it.each(Object.entries(families))("%s: rows are valid, cover every valid pair and every value, and are deterministic", (_name, family) => {
    const rows = pairwise(family)
    expect(rows.filter((row) => !family.valid(row))).toEqual([])
    const covered = new Set(rows.flatMap((row) => pairsOf(row, family)))
    expect(validPairs(family).filter((pair) => !covered.has(pair))).toEqual([])
    for (const [dimension, values] of Object.entries(family.dimensions)) {
      for (const value of values) {
        if (validPairs(family).some((pair) => pair.includes(`${dimension}=${value}|`) || pair.endsWith(`${dimension}=${value}`))) {
          expect(rows.some((row) => row[dimension] === value), `${dimension}=${value}`).toBe(true)
        }
      }
    }
    expect(pairwise(family)).toEqual(rows)
  })

  it("selects the measured row counts (§5.9; send and members have one more than the design's 88 and 21, pins seven fewer than its 25, see LOG.md)", () => {
    expect(Object.fromEntries(Object.entries(families).map(([name, family]) => [name, pairwise(family).length]))).toEqual({
      send: 89,
      react: 25,
      pins: 18,
      createThread: 8,
      threads: 24,
      channelEdit: 21,
      messages: 22,
      members: 22
    })
  })

  it("never selects a payload-flag removal on a payload without a flag, an administrator with anything missing or a timeout, or Connect outside voice", () => {
    for (const row of pairwise(families.send)) {
      if (row.missing === "payload") expect(["embed", "file", "reply", "tts", "poll"]).toContain(row.payload)
      if (row.grantSource === "administrator") expect([row.missing, row.memberState, row.payload === "mention-everyone"]).toEqual(["none", "normal", false])
      if (row.missing === "connect") expect(["voice", "stage"]).toContain(row.channel)
    }
  })

  it("keeps every kick and ban row one the docs model predicts to fail (L1)", () => {
    for (const row of pairwise(families.members)) {
      if (row.op === "kick-expect-fail" || row.op === "ban-expect-fail") expect(kickBanMustFail(row), JSON.stringify(row)).toBe(true)
    }
  })
})

describe("the send catalog", () => {
  it("has unique, stable IDs: 89 pairwise rows and the targeted rows", () => {
    expect(new Set(sendScenarios.map((scenario) => scenario.id)).size).toBe(sendScenarios.length)
    expect(sendScenarios.length).toBe(89 + targetedRows.length)
    expect(sendScenarios.every((scenario) => scenario.id.startsWith("send/"))).toBe(true)
  })

  it("passes Safety symbolically and over every scenario's materialized state", () => {
    expect(Safety.checkCatalog(sendScenarios)).toEqual([])
    const violations = sendScenarios.flatMap((scenario) => Safety.checkMaterialized(scenario, Materialize.desired(scenario.setup, fakeIds), fakeIds, now))
    expect(violations).toEqual([])
  })

  it("never grants MentionEveryone, Administrator or an administrator source in a row that mentions @everyone (L3)", () => {
    const everyoneRows = sendScenarios.filter((scenario) => scenario.operation._tag === "send" && scenario.operation.payload === "mention-everyone")
    expect(everyoneRows.length).toBeGreaterThan(0)
    for (const scenario of everyoneRows) {
      const state = Materialize.desired(scenario.setup, fakeIds)
      expect(state.subjectRoles).not.toContain("lab-admin")
      expect(state.everyone & ((1n << 17n) | 8n)).toBe(0n)
    }
  })

  it("sends allowed_mentions with nothing parsed, except the one @everyone payload", () => {
    const context = { replyTo: MessageId.make("600000000000000001"), stickerId: StickerId.make("700000000000000001") }
    for (const payload of ["plain", "embed", "file", "reply", "tts", "poll", "guild-sticker"] as const) {
      expect(wirePayload(payload, context).request.allowed_mentions?.parse, payload).toEqual([])
    }
    expect(wirePayload("reply", context).request.allowed_mentions?.replied_user).toBe(false)
    expect(wirePayload("mention-everyone", context).request.allowed_mentions?.parse).toEqual(["everyone"])
  })
})

describe("Safety", () => {
  const scenario = (payload: "plain" | "mention-everyone", setup: ConstructorParameters<typeof Setup>[0]) => ({
    id: "send/test",
    hypotheses: [],
    setup: new Setup(setup),
    operation: { _tag: "send" as const, payload }
  })

  it("refuses an @everyone payload with an administrator source or a MentionEveryone grant", () => {
    const admin = scenario("mention-everyone", { channel: "text", grants: [{ flags: [], via: "administrator" }], removals: [], memberState: "normal", fixtures: [] })
    expect(Safety.checkScenario(admin).map((violation) => violation.rule)).toEqual(["no-everyone-ping"])
    const granted = scenario("mention-everyone", { channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages", "MentionEveryone"], via: "member-overwrite-allow" }], removals: [], memberState: "normal", fixtures: [] })
    expect(Safety.checkScenario(granted).map((violation) => violation.rule)).toEqual(["no-everyone-ping"])
    const materialized = Safety.checkMaterialized(granted, Materialize.desired(granted.setup, fakeIds), fakeIds, now)
    expect(materialized.map((violation) => violation.detail)).toEqual(["an overwrite on lab-text allows MentionEveryone to the subject"])
    const everyone = scenario("mention-everyone", { channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages", "MentionEveryone"], via: "everyone" }], removals: [], memberState: "normal", fixtures: [] })
    expect(Safety.checkMaterialized(everyone, Materialize.desired(everyone.setup, fakeIds), fakeIds, now).map((violation) => violation.detail)).toEqual([
      "@everyone holds MentionEveryone or Administrator"
    ])
  })

  it("refuses an @everyone payload while the subject holds a role that gives MentionEveryone or Administrator", () => {
    const plain = scenario("mention-everyone", { channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }], removals: [], memberState: "normal", fixtures: [] })
    const state = Materialize.desired(plain.setup, fakeIds)
    expect(Safety.checkMaterialized(plain, state, fakeIds, now)).toEqual([])
    const granting = (bits: bigint): Materialize.Desired => ({ ...state, rolePermissions: new Map(state.rolePermissions).set("lab-grant", (state.rolePermissions.get("lab-grant") ?? 0n) | bits) })
    for (const bits of [1n << 17n, 8n]) {
      expect(Safety.checkMaterialized(plain, granting(bits), fakeIds, now).map((violation) => violation.detail)).toEqual(["the subject holds lab-grant, which has MentionEveryone or Administrator"])
    }
    // a role the subject does not hold may have it
    const unheld: Materialize.Desired = { ...state, rolePermissions: new Map(state.rolePermissions).set("lab-high", 1n << 17n) }
    expect(Safety.checkMaterialized(plain, unheld, fakeIds, now)).toEqual([])
  })

  it("refuses a materialized state where the target loses its fixture flags", () => {
    const plain = scenario("plain", { channel: "text", grants: [], removals: [], memberState: "normal", fixtures: [] })
    const state = Materialize.desired(plain.setup, fakeIds)
    const withoutTargetAllow: Materialize.Desired = { ...state, overwrites: new Map([...state.overwrites].map(([name, overwrites]) => [name, overwrites.slice(1)])) }
    expect(Safety.checkMaterialized(plain, withoutTargetAllow, fakeIds, now).map((violation) => violation.rule)).toEqual(["target-unaffected"])
  })

  it("allows one renamed setup per channel per run, not two (H-162)", () => {
    const renamed = (slowmode: number) =>
      scenario("plain", { channel: "text", grants: [], removals: [], memberState: "normal", fixtures: [], channelSettings: { nameVariant: "b", slowmode, requireTag: false } })
    expect(Safety.checkCatalog([renamed(0)])).toEqual([])
    expect(Safety.checkCatalog([{ ...renamed(0), id: "a" }, { ...renamed(5), id: "b" }]).map((violation) => violation.rule)).toEqual(["one-rename-per-channel"])
  })
})
