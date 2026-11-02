import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { escalatedRules, openQuestionsOf, registryProblems, type RepositoryView, waitingForRhys } from "../../scripts/lib/rules.ts"
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

  it("fails closed on a live pair until the catalog and truth table can be read", () => {
    const rule: Rule = {
      ...pureTyping,
      id: "R-ids-distinct",
      live: {
        kind: "pair",
        setup: "send-granted",
        valid: { scenario: "rule/ids/send-with-channel-id", expect: { _tag: "Succeeded" } },
        invalid: { scenario: "rule/ids/raw-send-with-user-id", expect: { _tag: "Rejected", status: 404, code: 10003, inner: [] } }
      }
    }
    const problems = registryProblems([rule], view({ log: "R-ids-distinct" }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^R-ids-distinct: has a live pair, which this rules-check cannot verify yet/)
  })
})

describe("documents", () => {
  it("reads DESIGN.md §8's open questions", () => {
    const design = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "docs", "DESIGN.md"), "utf8")
    expect([...openQuestionsOf(design)]).toEqual(Array.from({ length: 21 }, (_, i) => i + 1))
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
})
