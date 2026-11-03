import * as fs from "node:fs"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { agreement, flipAgreement, ruleAgreement } from "../../harness/Agreement.ts"
import * as Predict from "../../harness/Predict.ts"
import { scenarios } from "../../harness/scenario/catalog/index.ts"
import { operationKey, Setup } from "../../harness/scenario/Dsl.ts"
import * as TruthTable from "../../harness/TruthTable.ts"
import { ErrorClasses } from "../../src/errors/index.ts"
import { ErrorCategories } from "../../src/errors/Missing.generated.ts"
import { expectedCode, Observed } from "../../src/permissions/Observed.ts"
import { requiredFlags } from "../../src/permissions/Preflight.ts"
import { ResolverRules } from "../../src/permissions/ResolverRules.ts"
import { payloadRuleNames, PayloadRules } from "../../src/payload/PayloadRules.ts"
import { DiscordResponse, FieldError } from "../../src/errors/Cause.ts"
import { dedicatedCodeTags, type LimitFacts, mapResponse } from "../../src/rest/ErrorMap.ts"
import type { OpName } from "../../src/permissions/Operations.ts"
import { Limits } from "../../src/payload/Limits.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import { staticFactsOf } from "../../harness/scenario/Facts.ts"
import { categoriesOf } from "../support/categories.ts"

/**
 * The offline replay of `fixtures/truth-table.json` (DESIGN §5.13). For every row, the subject's state is
 * rebuilt from the symbolic setup (`Predict`, through Materialize and its projection, with fixed IDs), and the
 * resolver and preflight must reproduce the live records of steps (a) and (b) exactly; agreement must give
 * `agree` (and a flip control must agree with its original). This is a regression check of the resolver
 * against itself and of the catalog against the table; the evidence that the resolver is right is agreement
 * with Discord, the flip controls and the oracle, all recorded live.
 *
 * It also holds the constants the live matrix decides to the table: `Observed`, `PayloadRules.mode`, the
 * dedicated codes (`ErrorMap.dedicatedCodeTags`), and the categories of every recorded error.
 */
const path = new URL("../../fixtures/truth-table.json", import.meta.url).pathname
const table = Schema.decodeUnknownSync(Schema.fromJsonString(TruthTable.TruthTable))(fs.readFileSync(path, "utf8"))
const encodeSetup = Schema.encodeSync(Schema.toCodecJson(Setup))
const now = Date.parse("2026-11-01T12:00:00Z")
const rows = Object.entries(table.scenarios)
const ran = (row: TruthTable.Row): boolean => row.raw.class !== "setup-unsupported"
const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]))

describe("the truth table against the catalog", () => {
  it("has exactly the catalog's scenarios, each with the catalog's setup and operation", () => {
    expect(rows.map(([id]) => id).sort()).toEqual(scenarios.map((scenario) => scenario.id).sort())
    for (const [id, row] of rows) {
      const scenario = byId.get(id)
      if (scenario === undefined) continue
      expect({ id, setup: TruthTable.canonicalJson(encodeSetup(row.setup)), operation: row.operation }).toEqual({
        id,
        setup: TruthTable.canonicalJson(encodeSetup(scenario.setup)),
        operation: operationKey(scenario.operation)
      })
    }
  })

  it("was written in the environment the replay assumes: the oracle available, real overwrites for hidden channels", () => {
    expect(table.env.oracle).toBe("available")
    expect(table.env.obfuscation).toBe("default")
    expect(table.env.everyoneBaseline).toEqual([])
  })
})

const isRuleRow = (id: string): boolean => byId.get(id)?.operation._tag === "rule"
const matrixRows = rows.filter(([id]) => !isRuleRow(id))
const ruleRowsOfTable = rows.filter(([id]) => isRuleRow(id))

describe("the rule rows (§5.5)", () => {
  it.each(ruleRowsOfTable)("%s: observed exactly the registry's expectation", (id, row) => {
    const scenario = byId.get(id)
    if (scenario === undefined) throw new Error(`${id} is not in the catalog`)
    expect(row.observation).toBeDefined()
    if (row.observation === undefined) return
    expect(ruleAgreement(row.observation, scenario.expect)).toBe("agree")
    expect(row.agreement).toBe("agree")
  })
})

describe("the replay", () => {
  it.each(matrixRows)("%s: steps (a) and (b) reproduce, and agreement agrees", (id, row) => {
    const scenario = byId.get(id)
    if (scenario === undefined) throw new Error(`${id} is not in the catalog`)
    if (!ran(row)) {
      const facts = staticFactsOf(scenario)
      expect(row.resolver.required).toEqual(Flags.sortFlags(requiredFlags(facts.op, facts.args)))
      expect(row.agreement).toBe("agree")
      return
    }
    const prediction = Predict.predict(scenario, Predict.symbolicIds, now)
    expect(prediction.records.resolver).toEqual(row.resolver)
    expect(prediction.records.preflightSet).toEqual(row.preflightSet)
    expect(prediction.records.preflight).toEqual(row.preflight)
    const own = agreement(row, prediction.facts)
    expect(own).toBe("agree")
    const original = scenario.flipOf === undefined ? undefined : table.scenarios[scenario.flipOf]
    if (original !== undefined) expect(flipAgreement(original, { ...row, agreement: own })).toBe("agree")
    expect(row.agreement).toBe("agree")
  })
})

describe("the constants the table decides (§5.13)", () => {
  // the rule rows record a probe, not the resolver and preflight (§5.5); the rule-row and limit blocks judge them
  const ranRows = matrixRows.filter(([, row]) => ran(row))

  it("Observed.botsCanBeTimedOut: no row records bot-not-timeoutable, and timed-out rows ran", () => {
    expect(Observed.botsCanBeTimedOut).toBe(true)
    expect(rows.filter(([, row]) => row.raw.unsupported === "bot-not-timeoutable").map(([id]) => id)).toEqual([])
    expect(ranRows.some(([, row]) => row.setup.memberState === "timed-out" && row.resolver.masks.includes("timeout"))).toBe(true)
  })

  it("Observed.slowmodeAppliesToBots: rows witness a second send in a row under slowmode without a bypass, and agree with it", () => {
    // a witness: a send right after the subject's own prior send, in a channel with slowmode, by a subject
    // without BypassSlowmode or Administrator and not timed out (H-053)
    const bypasses = (setup: Setup) => setup.grants.some((grant) => grant.via === "administrator" || grant.flags.includes("BypassSlowmode") || grant.flags.includes("Administrator"))
    const witnesses = rows.filter(
      ([, row]) =>
        row.operation.startsWith("send:") &&
        (row.setup.channelSettings?.slowmode ?? 0) > 0 &&
        row.setup.fixtures.includes("subject-prior-send") &&
        row.setup.memberState === "normal" &&
        !bypasses(row.setup)
    )
    expect(witnesses.length).toBeGreaterThan(0)
    const expected = Observed.slowmodeAppliesToBots ? "20016" : "success"
    for (const [id, row] of witnesses) expect({ id, outcome: row.raw.code === 20016 ? "20016" : row.raw.class }).toEqual({ id, outcome: expected })
    const slowed = rows.filter(([, row]) => row.raw.code === 20016).map(([id]) => id)
    expect(slowed.length > 0).toBe(Observed.slowmodeAppliesToBots)
  })

  it("H-081: no 50013 or 50001 answer names a permission (no inner errors)", () => {
    const refused = rows.filter(([, row]) => row.raw.class === "50013" || row.raw.class === "50001")
    expect(refused.length).toBeGreaterThan(0)
    expect(refused.filter(([, row]) => row.raw.inner.length > 0).map(([id]) => id)).toEqual([])
  })

  it("Observed.codeForLevel and viewCodeFailures: every 50001 and 50013 matches, and every listed failure was seen answering 50001", () => {
    for (const [id, row] of ranRows) {
      if (row.raw.class !== "50001" && row.raw.class !== "50013") continue
      const scenario = byId.get(id)
      if (scenario === undefined) continue
      expect({ id, code: expectedCode(staticFactsOf(scenario).op, row.resolver.level, row.preflightSet[0]) }).toEqual({ id, code: row.raw.code })
    }
    const listed: Readonly<Record<string, ReadonlyArray<string>>> = Observed.viewCodeFailures
    for (const [op, tags] of Object.entries(listed)) {
      for (const tag of tags) {
        const witnesses = ranRows.filter(([id, row]) => {
          const scenario = byId.get(id)
          return scenario !== undefined && staticFactsOf(scenario).op === op && row.resolver.level === "action" && row.preflightSet[0] === tag && row.raw.code === 50001
        })
        expect({ op, tag, witnessed: witnesses.length > 0 }).toEqual({ op, tag, witnessed: true })
      }
    }
  })

  it("Observed.oracleAppliesTimeout: a timed-out row's oracle reports a granted flag the timeout removes as missing", () => {
    expect(Observed.oracleAppliesTimeout).toBe(true)
    const kept = ResolverRules.timeoutKeeps.value
    const witnesses = ranRows.filter(([, row]) => {
      const oracle = row.oracle
      return typeof oracle === "object" && row.resolver.masks.includes("timeout") && oracle.missing.some((flag) => !kept.includes(flag) && !row.resolver.missingBeforeMasks.includes(flag))
    })
    expect(witnesses.length).toBeGreaterThan(0)
  })

  it("PayloadRules.mode: an error-mode flag is never degraded, and every degrade-mode flag the matrix sends was seen degraded", () => {
    // a send's degradation is its payload's; a read's (the pins list without ReadMessageHistory) is the row's `degrades`
    const degradedFlags = new Set(ranRows.filter(([, row]) => row.operation.startsWith("send:")).flatMap(([, row]) => row.raw.degraded))
    for (const name of payloadRuleNames) {
      const rule = PayloadRules[name]
      if (rule.mode === "error") expect({ name, degraded: degradedFlags.has(rule.flag) }).toEqual({ name, degraded: false })
    }
    for (const name of ["mentionsEveryone", "tts"] as const) {
      const rule = PayloadRules[name]
      if (rule.mode === "degrade") expect({ name, witnessed: degradedFlags.has(rule.flag) }).toEqual({ name, witnessed: true })
    }
  })

  it("ErrorMap: every other code the matrix recorded has its dedicated tag", () => {
    const unmapped = matrixRows.filter(([, row]) => row.raw.class === "other-error" && (row.raw.mappedTag === "n/a" || dedicatedCodeTags.get(row.raw.code) !== row.raw.mappedTag))
    expect(unmapped.map(([id, row]) => `${id}: ${row.raw.status} ${row.raw.code}`)).toEqual([])
  })

  it("ErrorMap covers every (operation, status, code, inner path) the matrix recorded (M5; rule rows send what the types forbid)", () => {
    const refused = matrixRows.filter(([, row]) => row.raw.class === "50013" || row.raw.class === "50001" || row.raw.class === "other-error")
    expect(refused.length).toBeGreaterThan(0)
    const unmapped = refused.flatMap(([id, row]) => {
      const scenario = byId.get(id)
      if (scenario === undefined) return [`${id}: not in the catalog`]
      const { op, args } = staticFactsOf(scenario)
      const fieldErrors = row.raw.inner.map((error) => new FieldError({ path: error.path.split("."), code: error.code, message: "" }))
      const answer = new DiscordResponse({ status: row.raw.status, code: row.raw.code, message: "", method: "POST", route: "(replay)", fieldErrors, attributedBy: "code" })
      const result = mapResponse({ op, args, limits: {} }, answer, undefined)
      return result._tag === "Unmapped" ? [`${id}: ${result.reason}`] : []
    })
    expect(unmapped).toEqual([])
  })

  it("every recorded error has its class's categories (ErrorCategories, or the class's marker): step (b)'s and step (d)'s", () => {
    const recorded = rows.flatMap(([id, row]) => [
      ...(typeof row.preflight === "object" ? [[id, row.preflight] as const] : []),
      ...(typeof row.recompute === "object" ? [[`${id} (d)`, row.recompute] as const] : [])
    ])
    expect(recorded.length).toBeGreaterThan(0)
    const classes: Readonly<Record<string, object>> = ErrorClasses
    const categoryTable: Readonly<Record<string, ReadonlyArray<string>>> = ErrorCategories
    for (const [id, error] of recorded) {
      // a permission tag's classes are its own and its D5 variants (`MissingReadMessageHistoryForReply`, ...)
      const candidates = Object.entries(categoryTable).filter(([name]) => name === error.tag || name.startsWith(`${error.tag}For`)).map(([, categories]) => [...categories])
      const Class = classes[error.tag]
      if (candidates.length === 0 && Class !== undefined && "prototype" in Class && typeof Class.prototype === "object" && Class.prototype !== null) candidates.push([...categoriesOf(Class.prototype)])
      expect({ id, matches: candidates.some((categories) => categories.join() === error.categories.join()) }).toEqual({ id, matches: true })
    }
  })
})

describe("Limits and the 50035 paths against the limit rows (§5.13, M6)", () => {
  /** Each limit rule's invalid side, the operation it stands for, the limits it declares, and the tag its 50035 maps to. */
  const limitRows: ReadonlyArray<readonly [scenario: string, op: OpName, limits: LimitFacts, tag: string]> = [
    ["rule/text-send/raw-content-over", "channel.send", { content: { length: Limits.content + 1, limit: Limits.content } }, "ContentTooLong"],
    ["rule/text-rich/raw-embed-over", "channel.send", { embeds: true }, "EmbedTooLarge"],
    ["rule/text-rich/raw-poll-over", "channel.send", { poll: true }, "PollTooLarge"],
    ["rule/text-threads/raw-thread-name-over", "channel.createThread.public", { name: { length: Limits.name.max + 1, limit: Limits.name.max } }, "NameTooLong"],
    ["rule/text-manage-channels/raw-topic-over", "channel.edit", { topic: { length: Limits.topic.channel + 1, limit: Limits.topic.channel } }, "TopicTooLong"],
    ["rule/text-manage-channels/raw-slowmode-over", "channel.edit", { slowmode: { seconds: Limits.slowmode.max + 1 } }, "SlowmodeOutOfRange"],
    ["rule/members/raw-nickname-over", "member.setNickname", { nick: { length: Limits.nickname + 1, limit: Limits.nickname } }, "NicknameTooLong"],
    ["rule/members/raw-timeout-over", "member.timeout", { timeout: true }, "TimeoutTooLong"]
  ]

  it.each(limitRows)("%s: Discord refused one over the limit with a 50035 the error map turns into its tag", (id, op, limits, tag) => {
    const row = table.scenarios[id]
    expect(row?.raw.code).toBe(50035)
    if (row === undefined) return
    const fieldErrors = row.raw.inner.map((error) => new FieldError({ path: error.path.split("."), code: error.code, message: "" }))
    const answer = new DiscordResponse({ status: row.raw.status, code: row.raw.code, message: "", method: "POST", route: "(replay)", fieldErrors, attributedBy: "code" })
    const mapped = mapResponse({ op, args: { payload: [] }, limits }, answer, undefined)
    expect(mapped._tag === "Fail" ? mapped.error._tag : mapped).toBe(tag)
  })

  it("the valid sides, each exactly at its limit (Limits.content in Limits.unit, the embed title, the poll question, the name, topic, slowmode, nickname and 28-day timeout), succeeded", () => {
    for (const id of [
      "rule/text-send/typed-content-max",
      "rule/text-rich/typed-embed-max",
      "rule/text-rich/typed-poll-max",
      "rule/text-threads/typed-thread-name-max",
      "rule/text-manage-channels/typed-topic-max",
      "rule/text-manage-channels/typed-slowmode-max",
      "rule/members/typed-nickname-max",
      "rule/members/typed-timeout-max"
    ]) {
      expect({ id, observation: table.scenarios[id]?.observation }).toEqual({ id, observation: { _tag: "Succeeded" } })
    }
  })
})
