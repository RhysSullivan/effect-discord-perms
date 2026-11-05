import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { type CoverageRow, coverageProblems, escalatedRules, unmetDoneCriteria, eventProblems, openQuestionsOf, type PairRowView, registryProblems, type RepositoryView, type SessionView, waitingForRhys } from "../../scripts/lib/rules.ts"
import type { Rule } from "../rules.ts"

const failSource = ["import { x } from 'y'", "// @valid", "x.ok()", "// @expect-error TS2345 Beta", "x.bad()"].join("\n")
const snapshot = "L5:3 TS2345\nArgument of type '\"Beta\"' is not assignable to parameter of type '\"Alpha\"'.\n"

const pureTyping: Rule = {
  id: "R-catch-tag-exact",
  statement: "catchTag is exact",
  pass: "test/types/pass/catch.ts",
  fail: "test/types/fail/catch.ts",
  claims: ["Beta"],
  live: { kind: "not-live", reason: "pure-typing" }
}

const view = (overrides: Partial<RepositoryView> = {}): RepositoryView => ({
  fileExists: (relative) => relative === "test/types/pass/catch.ts",
  failFixtures: [{ path: "test/types/fail/catch.ts", source: failSource, snapshot }],
  openQuestions: new Set([17, 18]),
  log: "# LOG\n\n## Waiting for Rhys\n\nNothing yet.\n\n## Live findings\n",
  ruleCatalog: new Map(),
  table: new Map(),
  canonical: (observation) => JSON.stringify(observation),
  ...overrides
})

describe("registryProblems", () => {
  it("passes a pure-typing rule that claims its fixture's directive", () => {
    expect(registryProblems([pureTyping], view())).toEqual([])
  })

  it("passes an empty registry only when no fail fixture has a directive", () => {
    expect(registryProblems([], view({ failFixtures: [] }))).toEqual([])
    expect(registryProblems([], view())).toEqual(['test/types/fail/catch.ts: directive mention "Beta" is not claimed by any rule in test/rules.ts'])
  })

  it("fails a claim with no matching directive, or missing from the snapshot", () => {
    expect(registryProblems([{ ...pureTyping, claims: ["Beta", "Gamma"] }], view())).toEqual([
      'R-catch-tag-exact: claims "Gamma", but test/types/fail/catch.ts has no directive with that mention'
    ])
    expect(registryProblems([pureTyping], view({ failFixtures: [{ path: "test/types/fail/catch.ts", source: failSource, snapshot: "L5:3 TS2345\nother\n" }] }))).toEqual([
      'R-catch-tag-exact: claims "Beta", but it does not appear in the snapshot of test/types/fail/catch.ts'
    ])
    expect(registryProblems([pureTyping], view({ failFixtures: [{ path: "test/types/fail/catch.ts", source: failSource, snapshot: undefined }] }))).toEqual([
      "R-catch-tag-exact: test/types/fail/catch.ts has no diagnostics snapshot"
    ])
  })

  it("fails missing fixtures and duplicate ids", () => {
    expect(registryProblems([pureTyping, pureTyping], view({ fileExists: () => false, failFixtures: [] }))).toEqual([
      "R-catch-tag-exact: duplicate rule id",
      "R-catch-tag-exact: pass fixture test/types/pass/catch.ts is missing",
      "R-catch-tag-exact: fail fixture test/types/fail/catch.ts is missing",
      "R-catch-tag-exact: pass fixture test/types/pass/catch.ts is missing",
      "R-catch-tag-exact: fail fixture test/types/fail/catch.ts is missing"
    ])
  })

  it("fails a not-live reason the allowlist does not grant", () => {
    const rule: Rule = { ...pureTyping, id: "R-ids-distinct", live: { kind: "not-live", reason: "pure-typing" } }
    expect(registryProblems([rule], view())).toEqual(['R-ids-distinct: live is not-live "pure-typing", which the fixed allowlist does not grant this rule'])
  })

  it("asks every rule that is not pure-typing for a LOG.md line", () => {
    const rule: Rule = { ...pureTyping, id: "R-no-modal-from-modal", live: { kind: "not-live", reason: "phase-3-offline" } }
    expect(registryProblems([rule], view())).toEqual(["R-no-modal-from-modal: is not pure-typing, but LOG.md has no line for it"])
    expect(registryProblems([rule], view({ log: "- R-no-modal-from-modal is phase-3-offline." }))).toEqual([])
    expect(registryProblems([rule], view({ log: "- R-no-modal-from-modal-extra" }))).toHaveLength(1)
  })

  it("requires an escalated question to be open in DESIGN.md §8 and listed under Waiting for Rhys", () => {
    const rule: Rule = { ...pureTyping, id: "R-message-content", live: { kind: "escalated", question: "Q-17" } }
    const logged = "## Waiting for Rhys\n\n- Q-17: a human DM is needed (R-message-content).\n\n## Live findings\n"
    expect(registryProblems([rule], view({ log: logged }))).toEqual([])
    expect(registryProblems([rule], view({ log: "## Waiting for Rhys\n\nNothing.\n\n## Live findings\n\nR-message-content Q-17\n" }))).toEqual([
      'R-message-content: live escalates Q-17, but LOG.md "Waiting for Rhys" has no line for it'
    ])
    expect(registryProblems([{ ...rule, live: { kind: "escalated", question: "Q-99" } }], view({ log: logged }))).toEqual([
      "R-message-content: live escalates Q-99, which is not an open question in DESIGN.md §8",
      'R-message-content: live escalates Q-99, but LOG.md "Waiting for Rhys" has no line for it'
    ])
  })

  describe("a live pair", () => {
    const pairRule: Rule = {
      ...pureTyping,
      id: "R-ids-distinct",
      live: {
        kind: "pair",
        setup: "text-send",
        valid: { scenario: "rule/text-send/typed-send", expect: { _tag: "Succeeded" } },
        invalid: { scenario: "rule/text-send/raw-send-user-id", expect: { _tag: "Rejected", status: 404, code: 10003, inner: [] } }
      }
    }
    const catalog = new Map([
      ["rule/text-send/typed-send", "text-send"],
      ["rule/text-send/raw-send-user-id", "text-send"]
    ])
    const row = (observation: unknown, setup = "S"): PairRowView => ({ setup, observation: JSON.stringify(observation) })
    const table = new Map<string, PairRowView>([
      ["rule/text-send/typed-send", row({ _tag: "Succeeded" })],
      ["rule/text-send/raw-send-user-id", row({ _tag: "Rejected", status: 404, code: 10003, inner: [] })]
    ])
    const base = { log: "R-ids-distinct", ruleCatalog: catalog, table }

    it("passes when both sides are catalog rule rows of the setup, with rows observing exactly the expectations on one setup", () => {
      expect(registryProblems([pairRule], view(base))).toEqual([])
    })

    it("fails a side missing from the catalog or running on another setup", () => {
      expect(registryProblems([pairRule], view({ ...base, ruleCatalog: new Map([["rule/text-send/typed-send", "text-send"]]) }))).toEqual([
        "R-ids-distinct: the invalid side rule/text-send/raw-send-user-id is not a scenario of harness/scenario/catalog/rules.ts"
      ])
      expect(registryProblems([pairRule], view({ ...base, ruleCatalog: new Map([...catalog, ["rule/text-send/typed-send", "forum"]]) }))).toEqual([
        "R-ids-distinct: the valid side rule/text-send/typed-send runs on setup forum, not the pair's text-send"
      ])
    })

    it("fails a missing table or row, an observation that differs in any field, and two setups", () => {
      expect(registryProblems([pairRule], view({ ...base, table: undefined }))).toEqual(["R-ids-distinct: there is no truth table (fixtures/truth-table.json) to read the pair's rows from"])
      expect(registryProblems([pairRule], view({ ...base, table: new Map([...table].slice(0, 1)) }))).toEqual([
        "R-ids-distinct: the invalid side rule/text-send/raw-send-user-id has no row in fixtures/truth-table.json"
      ])
      const wrongCode = new Map([...table, ["rule/text-send/raw-send-user-id", row({ _tag: "Rejected", status: 404, code: 10008, inner: [] })]])
      expect(registryProblems([pairRule], view({ ...base, table: wrongCode }))[0]).toMatch(/observed .*10008.*, but the registry expects .*10003/)
      const wrongInner = new Map([...table, ["rule/text-send/raw-send-user-id", row({ _tag: "Rejected", status: 404, code: 10003, inner: [{ path: "x", code: "y" }] })]])
      expect(registryProblems([pairRule], view({ ...base, table: wrongInner }))).toHaveLength(1)
      const unobserved = new Map<string, PairRowView>([...table, ["rule/text-send/typed-send", { setup: "S", observation: undefined }]])
      expect(registryProblems([pairRule], view({ ...base, table: unobserved }))).toEqual(["R-ids-distinct: the valid side rule/text-send/typed-send recorded no observation"])
      const twoSetups = new Map([...table, ["rule/text-send/typed-send", row({ _tag: "Succeeded" }, "T")]])
      expect(registryProblems([pairRule], view({ ...base, table: twoSetups }))).toEqual(["R-ids-distinct: the sides ran on different setups"])
    })
  })

  describe("evidence rows (after the final audit)", () => {
    const evidenceRule: Rule = {
      ...pureTyping,
      id: "R-payload-external-emoji",
      live: { kind: "not-live", reason: "needs-second-guild" },
      evidence: [
        { scenario: "rule/text-send/typed-emoji-made-up", expect: { _tag: "Ignored", field: "content" } },
        { scenario: "rule/text-external-emoji/typed-emoji-made-up", expect: { _tag: "Applied", field: "content" } }
      ]
    }
    const catalog = new Map([
      ["rule/text-send/typed-emoji-made-up", "text-send"],
      ["rule/text-external-emoji/typed-emoji-made-up", "text-external-emoji"]
    ])
    const row = (observation: unknown, setup: string): PairRowView => ({ setup, observation: JSON.stringify(observation) })
    const table = new Map<string, PairRowView>([
      ["rule/text-send/typed-emoji-made-up", row({ _tag: "Ignored", field: "content" }, "S")],
      ["rule/text-external-emoji/typed-emoji-made-up", row({ _tag: "Applied", field: "content" }, "T")]
    ])
    const base = { log: "R-payload-external-emoji", ruleCatalog: catalog, table }

    it("passes rows of the catalog that observe exactly their expectations, on as many setups as they name", () => {
      expect(registryProblems([evidenceRule], view(base))).toEqual([])
    })

    it("fails a row missing from the catalog or the table, an observation that differs, and a missing table", () => {
      expect(registryProblems([evidenceRule], view({ ...base, ruleCatalog: new Map([...catalog].slice(0, 1)) }))).toEqual([
        "R-payload-external-emoji: the evidence 2 row rule/text-external-emoji/typed-emoji-made-up is not a scenario of harness/scenario/catalog/rules.ts"
      ])
      expect(registryProblems([evidenceRule], view({ ...base, table: new Map([...table].slice(1)) }))).toEqual([
        "R-payload-external-emoji: the evidence 1 row rule/text-send/typed-emoji-made-up has no row in fixtures/truth-table.json"
      ])
      const flipped = new Map([...table, ["rule/text-send/typed-emoji-made-up", row({ _tag: "Applied", field: "content" }, "S")]])
      expect(registryProblems([evidenceRule], view({ ...base, table: flipped }))[0]).toMatch(/evidence 1 row .* observed .*Applied.*, but the registry expects .*Ignored/)
      expect(registryProblems([evidenceRule], view({ ...base, table: undefined }))).toHaveLength(2)
    })
  })
})

describe("coverageProblems", () => {
  const row = (overrides: Partial<CoverageRow>): CoverageRow => ({
    id: "r",
    op: "channel.pins",
    flipOf: undefined,
    ran: true,
    granted: [],
    first: undefined,
    refused: false,
    degraded: [],
    features: [],
    ...overrides
  })
  const ofPins = (problems: ReadonlyArray<string>) => problems.filter((problem) => problem.startsWith("channel.pins:"))

  it("wants, per operation row's flag, a row that holds it, a refused row with it first, and that row's flip control", () => {
    const held = row({ id: "held", granted: ["ViewChannel"] })
    const first = row({ id: "first", first: "MissingViewChannel", refused: true })
    const flip = row({ id: "flip/first", flipOf: "first" })
    expect(ofPins(coverageProblems([held, first, flip]))).toEqual([])
    expect(ofPins(coverageProblems([first, flip]))).toEqual(["channel.pins: no live row holds ViewChannel"])
    expect(ofPins(coverageProblems([held, flip]))).toEqual(["channel.pins: no live row has ViewChannel as its first missing flag"])
    expect(ofPins(coverageProblems([held, first]))).toEqual(["channel.pins: no flip control of a row with ViewChannel first (first)"])
    // a row that did not run, or that Discord did not refuse, is no evidence
    expect(ofPins(coverageProblems([held, { ...first, ran: false }, flip]))).toEqual(["channel.pins: no live row has ViewChannel as its first missing flag"])
    expect(ofPins(coverageProblems([held, { ...first, refused: false }, flip]))).toEqual(["channel.pins: no live row has ViewChannel as its first missing flag"])
  })

  it("exempts require and DMs entirely, and kick and ban from flips only", () => {
    const problems = coverageProblems([])
    expect(problems.some((problem) => problem.startsWith("permissions.require") || problem.startsWith("dm.send"))).toBe(false)
    const kick = coverageProblems([row({ op: "member.kick", granted: ["KickMembers"] }), row({ id: "k", op: "member.kick", first: "MissingKickMembers", refused: true })])
    expect(kick.filter((problem) => problem.startsWith("member.kick"))).toEqual([])
  })

  it("wants a degrade-mode payload flag held with the feature kept, and missing with it dropped; never the external rules", () => {
    const tts = (problems: ReadonlyArray<string>) => problems.filter((problem) => problem.includes("rule tts"))
    const kept = row({ op: "channel.send", features: ["tts"], granted: ["SendTTSMessages"] })
    const dropped = row({ op: "channel.send", features: ["tts"], degraded: ["SendTTSMessages"] })
    expect(tts(coverageProblems([kept, dropped]))).toEqual([])
    expect(tts(coverageProblems([kept]))).toEqual(["payload rule tts: no live row where Discord dropped the feature without SendTTSMessages"])
    expect(tts(coverageProblems([dropped]))).toEqual(["payload rule tts: no live row holds SendTTSMessages and keeps the feature"])
    // granting MentionEveryone with @everyone would ping Rhys: only the dropped side is wanted
    expect(coverageProblems([]).filter((problem) => problem.includes("mentionsEveryone"))).toEqual(["payload rule mentionsEveryone: no live row where Discord dropped the feature without MentionEveryone"])
    expect(coverageProblems([]).some((problem) => problem.includes("externalSticker") || problem.includes("externalEmojiInContent"))).toBe(false)
  })
})

describe("documents", () => {
  it("reads DESIGN.md §8's open questions", () => {
    const design = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "docs", "DESIGN.md"), "utf8")
    expect([...openQuestionsOf(design)]).toEqual(Array.from({ length: 22 }, (_, i) => i + 1))
  })

  it("reads only the Waiting for Rhys section of LOG.md", () => {
    expect(waitingForRhys("# LOG\n## Waiting for Rhys\n- Q-17\n## Live findings\n- Q-18\n")).toBe("- Q-17")
  })
})

describe("escalatedRules", () => {
  it("lists every escalated live side and remainder, in registry order, and nothing for a registry without one", () => {
    const base: Rule = { id: "R-a", statement: "a", pass: "test/types/pass/a.ts", fail: "test/types/fail/a.ts", claims: ["A"], live: { kind: "not-live", reason: "pure-typing" } }
    expect(escalatedRules([base])).toEqual([])
    expect(
      escalatedRules([
        { ...base, id: "R-message-content", remainder: { kind: "escalated", question: "Q-17" } },
        base,
        { ...base, id: "R-options-typed", live: { kind: "escalated", question: "Q-18" } }
      ])
    ).toEqual([
      { rule: "R-message-content", part: "remainder", question: "Q-17" },
      { rule: "R-options-typed", part: "live", question: "Q-18" }
    ])
  })

  it("groups them by question, in question order, as verify:live prints the unmet Done criteria", () => {
    expect(
      unmetDoneCriteria([
        { rule: "R-intent-typing", part: "remainder", question: "Q-22" },
        { rule: "R-message-content", part: "remainder", question: "Q-17" },
        { rule: "R-options-typed", part: "remainder", question: "Q-18" },
        { rule: "R-custom-id-routing", part: "remainder", question: "Q-18" }
      ])
    ).toEqual(["Q-17: R-message-content (remainder)", "Q-18: R-options-typed (remainder), R-custom-id-routing (remainder)", "Q-22: R-intent-typing (remainder)"])
    expect(unmetDoneCriteria([])).toEqual([])
  })
})

describe("eventProblems (§5.5, M7)", () => {
  const eventIntents = { READY: [], CHANNEL_UPDATE: ["Guilds"] } as const
  const intentRule = (valid: Rule["live"]): Rule => ({ ...pureTyping, id: "R-intent-guilds", live: valid })
  const pairOf = (canary: string): Rule["live"] => ({
    kind: "pair",
    setup: "text-messages",
    valid: { scenario: "rule/text-messages/session-guilds-with", expect: { _tag: "EventDelivered", event: "CHANNEL_UPDATE" } },
    invalid: { scenario: "rule/text-messages/session-guilds-without", expect: { _tag: "EventAbsent", event: "CHANNEL_UPDATE", canary } }
  })
  const sessions: Readonly<Record<string, SessionView>> = {
    "rule/text-messages/session-guilds-with": { event: "CHANNEL_UPDATE", intents: ["Guilds"] },
    "rule/text-messages/session-guilds-without": { event: "CHANNEL_UPDATE", intents: [] }
  }
  const sessionOf = (scenario: string): SessionView | undefined => sessions[scenario]

  it("passes an event whose rule pairs a session with its intent and one without it, after a canary; READY needs none", () => {
    expect(eventProblems([intentRule(pairOf("GUILD_MEMBER_UPDATE"))], eventIntents, sessionOf)).toEqual([])
  })

  it("fails an event no rule pairs, an absence without a canary, and sessions whose intents do not differ in the event's", () => {
    expect(eventProblems([], eventIntents, sessionOf)).toEqual(["event CHANNEL_UPDATE: no rule has a live intent pair for it"])
    expect(eventProblems([intentRule(pairOf("none"))], eventIntents, sessionOf)).toEqual(["event CHANNEL_UPDATE: R-intent-guilds's invalid side does not expect EventAbsent of CHANNEL_UPDATE with a canary"])
    const both = (scenario: string): SessionView | undefined => (sessions[scenario] === undefined ? undefined : { event: "CHANNEL_UPDATE", intents: ["Guilds"] })
    expect(eventProblems([intentRule(pairOf("GUILD_MEMBER_UPDATE"))], eventIntents, both)).toEqual([
      "event CHANNEL_UPDATE: R-intent-guilds's invalid side rule/text-messages/session-guilds-without is not a session observing it without Guilds"
    ])
    const neither = (scenario: string): SessionView | undefined => (sessions[scenario] === undefined ? undefined : { event: "CHANNEL_UPDATE", intents: [] })
    expect(eventProblems([intentRule(pairOf("GUILD_MEMBER_UPDATE"))], eventIntents, neither)).toEqual([
      "event CHANNEL_UPDATE: R-intent-guilds's valid side rule/text-messages/session-guilds-with is not a session observing it with one of Guilds"
    ])
  })
})
