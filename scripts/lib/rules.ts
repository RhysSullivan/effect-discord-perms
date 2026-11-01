/**
 * Rule-registry completeness (DESIGN §5.5). Pure; `scripts/rules-check.ts` gathers the repository view.
 */
import type { NotLive, NotLiveReason, Rule } from "../../test/rules.ts"
import { directiveMentions } from "./typeTests.ts"

/**
 * The fixed allowlist of rules that may lack a live pair, per reason (§5.5):
 *
 * - `phase-3-offline`: the interaction rules (the orchestrator's decision);
 * - `needs-second-guild`: the external emoji and external sticker rules (the orchestrator's decision);
 * - `forbidden-action`: the @everyone valid side of the MentionEveryone rule (it would ping Rhys). Successful
 *   kicks and bans are forbidden too, but they are flag-coverage rows, not registry rules;
 * - `pure-typing`: catch narrowing, the handler boundary, require narrowing and transient-only escape.
 */
export const notLiveAllowlist: { readonly [Reason in NotLiveReason]: ReadonlySet<string> } = {
  "phase-3-offline": new Set([
    "R-must-respond",
    "R-modal-before-answer",
    "R-followup-after-answer",
    "R-autocomplete-choices",
    "R-no-modal-from-modal",
    "R-deferred-must-complete",
    "R-ephemeral-matches-mode",
    "R-reply-nonempty"
  ]),
  "needs-second-guild": new Set(["R-payload-external-sticker", "R-payload-external-emoji"]),
  "forbidden-action": new Set(["R-mention-everyone-degrades"]),
  "pure-typing": new Set(["R-handler-boundary", "R-catch-tag-exact", "R-catch-category-exact", "R-require-narrows", "R-transient-only-escapes"])
}

/** A fail fixture as rules-check sees it. */
export interface FailFixtureView {
  /** Relative to the repository root, e.g. `test/types/fail/ids.ts`. */
  readonly path: string
  readonly source: string
  /** The committed `<fixture>.diagnostics.txt`, if any. */
  readonly snapshot: string | undefined
}

/** Everything the registry is checked against. */
export interface RepositoryView {
  /** Whether a path relative to the repository root exists. */
  readonly fileExists: (relative: string) => boolean
  readonly failFixtures: ReadonlyArray<FailFixtureView>
  /** The numbers of DESIGN §8's open questions (`Q-<n>`). */
  readonly openQuestions: ReadonlySet<number>
  /** The text of `LOG.md`. */
  readonly log: string
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Whether `text` mentions `token` as a whole word (hyphens count as word characters, as in rule ids). */
export const mentionsToken = (text: string, token: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(token)}(?![A-Za-z0-9_-])`).test(text)

/** The body of a level-2 Markdown section, from its heading to the next level-2 heading; empty if absent. */
export const markdownSection = (markdown: string, heading: RegExp): string => {
  const lines = markdown.split("\n")
  const start = lines.findIndex((line) => line.startsWith("## ") && heading.test(line.slice(3)))
  if (start < 0) return ""
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "))
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n")
}

/** The numbered items of DESIGN.md §8 ("Open questions"), which escalated rules cite as `Q-<n>`. */
export const openQuestionsOf = (design: string): ReadonlySet<number> =>
  new Set(
    markdownSection(design, /^8\. Open questions/)
      .split("\n")
      .flatMap((line) => {
        const item = /^(\d+)\. /.exec(line)
        return item === null ? [] : [Number(item[1])]
      })
  )

/** The `## Waiting for Rhys` section of LOG.md. */
export const waitingForRhys = (log: string): string => markdownSection(log, /^Waiting for Rhys\b/)

const notLiveProblems = (rule: Rule, entry: NotLive, where: string, view: RepositoryView): ReadonlyArray<string> => {
  if (entry.kind === "not-live") {
    return notLiveAllowlist[entry.reason].has(rule.id)
      ? []
      : [`${rule.id}: ${where} is not-live "${entry.reason}", which the fixed allowlist does not grant this rule`]
  }
  const number = Number(entry.question.slice(2))
  return [
    ...(view.openQuestions.has(number) ? [] : [`${rule.id}: ${where} escalates ${entry.question}, which is not an open question in DESIGN.md §8`]),
    ...(mentionsToken(waitingForRhys(view.log), entry.question)
      ? []
      : [`${rule.id}: ${where} escalates ${entry.question}, but LOG.md "Waiting for Rhys" has no line for it`])
  ]
}

/** Whether a rule needs no live evidence at all (and therefore no LOG.md line). */
const isPureTyping = (rule: Rule): boolean =>
  rule.live.kind === "not-live" && rule.live.reason === "pure-typing" && rule.remainder === undefined

/** Every completeness problem in the registry. An empty list means the registry passes. */
export const registryProblems = (rules: ReadonlyArray<Rule>, view: RepositoryView): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const fixtures = new Map(view.failFixtures.map((f) => [f.path, f]))

  const seen = new Set<string>()
  for (const rule of rules) {
    if (seen.has(rule.id)) problems.push(`${rule.id}: duplicate rule id`)
    seen.add(rule.id)
  }

  for (const rule of rules) {
    if (!view.fileExists(rule.pass)) problems.push(`${rule.id}: pass fixture ${rule.pass} is missing`)
    const fixture = fixtures.get(rule.fail)
    if (fixture === undefined) {
      problems.push(`${rule.id}: fail fixture ${rule.fail} is missing`)
    } else {
      const mentions = directiveMentions(fixture.source)
      for (const claim of rule.claims) {
        if (!mentions.includes(claim)) problems.push(`${rule.id}: claims "${claim}", but ${rule.fail} has no directive with that mention`)
        else if (fixture.snapshot === undefined) problems.push(`${rule.id}: ${rule.fail} has no diagnostics snapshot`)
        else if (!fixture.snapshot.includes(claim)) problems.push(`${rule.id}: claims "${claim}", but it does not appear in the snapshot of ${rule.fail}`)
      }
    }
    if (rule.live.kind === "pair") {
      problems.push(
        `${rule.id}: has a live pair, which this rules-check cannot verify yet: the scenario catalog ` +
          "(harness/scenario/catalog/rules.ts) and the truth table (fixtures/truth-table.json) are built in M3-M6"
      )
    } else {
      problems.push(...notLiveProblems(rule, rule.live, "live", view))
    }
    if (rule.remainder !== undefined) problems.push(...notLiveProblems(rule, rule.remainder, "remainder", view))
    if (!isPureTyping(rule) && !mentionsToken(view.log, rule.id)) problems.push(`${rule.id}: is not pure-typing, but LOG.md has no line for it`)
  }

  for (const fixture of view.failFixtures) {
    for (const mention of new Set(directiveMentions(fixture.source))) {
      const claimed = rules.some((rule) => rule.fail === fixture.path && rule.claims.includes(mention))
      if (!claimed) problems.push(`${fixture.path}: directive mention "${mention}" is not claimed by any rule in test/rules.ts`)
    }
  }
  return problems
}

/** Checks of §5.5 whose inputs do not exist yet; rules-check prints them so they are never mistaken for passes. */
export const pendingChecks: ReadonlyArray<string> = [
  "flag coverage per (operation row, flag) and per payload-rule flag, with flip controls (needs src/permissions/Operations.ts, PayloadRules and fixtures/truth-table.json)",
  "a live intent pair for every event in EventIntents (needs src/gateway/Intents.ts and the truth table)"
]
