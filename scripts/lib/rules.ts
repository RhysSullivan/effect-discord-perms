/**
 * Rule-registry completeness (DESIGN §5.5). Pure; `scripts/rules-check.ts` gathers the repository view.
 */
import type { PermissionFlag } from "../../src/errors/Missing.generated.ts"
import { type OpName, Operations, type OpSpec } from "../../src/permissions/Operations.ts"
import { type PayloadRuleName, payloadRuleNames, PayloadRules } from "../../src/payload/PayloadRules.ts"
import type { LivePair, NotLive, NotLiveReason, Rule } from "../../test/rules.ts"
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

/** One truth-table row as the live-pair checks read it. */
export interface PairRowView {
  /** The row's setup, as canonical JSON. */
  readonly setup: string
  /** The row's observation, as canonical JSON (rule rows have one). */
  readonly observation: string | undefined
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
  /** The rule scenarios of `harness/scenario/catalog/rules.ts`, by ID, with the setup name each runs on. */
  readonly ruleCatalog: ReadonlyMap<string, string>
  /** The committed truth table's rows by scenario ID, or `undefined` when there is none. */
  readonly table: ReadonlyMap<string, PairRowView> | undefined
  /** Canonical JSON of an expectation, as the table's observations are written. */
  readonly canonical: (observation: LivePair["valid"]["expect"]) => string
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
      problems.push(...pairProblems(rule, rule.live, view))
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

/**
 * A live pair's problems (§5.5): both scenario IDs are rule rows of the pair's setup in the catalog, both have a
 * row in the committed truth table, each row's observation equals its side's full expectation, and the two rows
 * ran on byte-identical setups.
 */
const pairProblems = (rule: Rule, pair: LivePair, view: RepositoryView): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const sides = [
    ["valid", pair.valid],
    ["invalid", pair.invalid]
  ] as const
  for (const [name, side] of sides) {
    const setup = view.ruleCatalog.get(side.scenario)
    if (setup === undefined) problems.push(`${rule.id}: the ${name} side ${side.scenario} is not a scenario of harness/scenario/catalog/rules.ts`)
    else if (setup !== pair.setup) problems.push(`${rule.id}: the ${name} side ${side.scenario} runs on setup ${setup}, not the pair's ${pair.setup}`)
  }
  const table = view.table
  if (table === undefined) return [...problems, `${rule.id}: there is no truth table (fixtures/truth-table.json) to read the pair's rows from`]
  const rows = sides.map(([name, side]) => {
    const row = table.get(side.scenario)
    if (row === undefined) {
      problems.push(`${rule.id}: the ${name} side ${side.scenario} has no row in fixtures/truth-table.json`)
      return undefined
    }
    const expected = view.canonical(side.expect)
    if (row.observation === undefined) problems.push(`${rule.id}: the ${name} side ${side.scenario} recorded no observation`)
    else if (row.observation !== expected) problems.push(`${rule.id}: the ${name} side ${side.scenario} observed ${row.observation.replace(/\s+/g, " ")}, but the registry expects ${expected.replace(/\s+/g, " ")}`)
    return row
  })
  const [valid, invalid] = rows
  if (valid !== undefined && invalid !== undefined && valid.setup !== invalid.setup) problems.push(`${rule.id}: the two sides ran on different setups`)
  return problems
}

// ---- flag coverage (§5.5) -------------------------------------------------------------------------------

/** One matrix row as the flag-coverage check reads it. */
export interface CoverageRow {
  readonly id: string
  readonly op: OpName
  /** A flip control's original. */
  readonly flipOf: string | undefined
  /** The setup was built and the operation ran (not `setup-unsupported`). */
  readonly ran: boolean
  /** The required flags the subject held (the resolver's `required` minus its `missing`). */
  readonly granted: ReadonlyArray<PermissionFlag>
  /** Preflight's first failure's tag, or `undefined` when it passed. */
  readonly first: string | undefined
  /** Discord refused the raw call. */
  readonly refused: boolean
  /** The flags Discord dropped a feature for (the raw call's `degraded`). */
  readonly degraded: ReadonlyArray<PermissionFlag>
  /** The payload features the operation carried. */
  readonly features: ReadonlyArray<PayloadRuleName>
}

/**
 * The (operation, flag) and payload-rule pairs the flag-coverage check exempts, each for a reason the brief or
 * the orchestrator fixed (§5.5): no row can witness them, and none is exempted to get a pass.
 */
export const coverageExemptions = {
  /** `Permissions.require` sends no request: it is preflight over the state, held to the resolver offline. */
  "no-request": new Set<OpName>(["permissions.require"]),
  /** DMs: a bot cannot DM another bot (50007, H-158) and the harness never DMs Rhys; `dm.send` needs no flag. */
  "no-dm-row": new Set<OpName>(["dm.send"]),
  /** A successful kick or ban needs Rhys to re-invite a bot (PROMPT), so neither is ever flipped. */
  "forbidden-action-flip": new Set<OpName>(["member.kick", "member.ban"]),
  /** External emoji and stickers need a second guild (the orchestrator's decision). */
  "needs-second-guild": new Set<PayloadRuleName>(["externalSticker", "externalEmojiInContent"]),
  /** Granting MentionEveryone with an `@everyone` payload would ping Rhys (PROMPT, L3). */
  "forbidden-action-granted": new Set<PayloadRuleName>(["mentionsEveryone"])
} as const

const missingTag = (flag: PermissionFlag): string => `Missing${flag}`

/**
 * Every flag-coverage gap (§5.5): for each operation row's flag, a live row where the flag is held, one where it
 * is preflight's first failure and Discord refused, and that row's flip control; for each payload rule's flag, the
 * same over the rows whose payload carries the feature (a degrade-mode flag instead needs a row where it is held
 * and Discord kept the feature, and one where Discord dropped it: a feature dropped is no failure to flip).
 */
export const coverageProblems = (rows: ReadonlyArray<CoverageRow>): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const live = rows.filter((row) => row.ran)
  const flipped = new Set(live.flatMap((row) => (row.flipOf === undefined ? [] : [row.flipOf])))
  const check = (what: string, candidates: ReadonlyArray<CoverageRow>, flag: PermissionFlag, flips: boolean) => {
    if (!candidates.some((row) => row.granted.includes(flag))) problems.push(`${what}: no live row holds ${flag}`)
    const first = candidates.filter((row) => row.flipOf === undefined && row.refused && row.first === missingTag(flag))
    if (first.length === 0) problems.push(`${what}: no live row has ${flag} as its first missing flag`)
    else if (flips && !first.some((row) => flipped.has(row.id))) problems.push(`${what}: no flip control of a row with ${flag} first (${first.map((row) => row.id).join(", ")})`)
  }
  for (const op of Object.keys(Operations) as ReadonlyArray<OpName>) {
    if (coverageExemptions["no-request"].has(op) || coverageExemptions["no-dm-row"].has(op)) continue
    const spec: OpSpec = Operations[op]
    const mine = live.filter((row) => row.op === op)
    for (const flag of spec.flags) check(op, mine, flag, !coverageExemptions["forbidden-action-flip"].has(op))
  }
  for (const name of payloadRuleNames) {
    if (coverageExemptions["needs-second-guild"].has(name)) continue
    const rule = PayloadRules[name]
    const carrying = live.filter((row) => row.features.includes(name))
    const what = `payload rule ${name}`
    if (rule.mode === "error") {
      check(what, carrying, rule.flag, true)
      continue
    }
    if (!coverageExemptions["forbidden-action-granted"].has(name) && !carrying.some((row) => row.granted.includes(rule.flag) && !row.degraded.includes(rule.flag))) {
      problems.push(`${what}: no live row holds ${rule.flag} and keeps the feature`)
    }
    if (!carrying.some((row) => row.degraded.includes(rule.flag))) problems.push(`${what}: no live row where Discord dropped the feature without ${rule.flag}`)
  }
  return problems
}

/** Checks of §5.5 whose inputs do not exist yet; rules-check prints them so they are never mistaken for passes. */
export const pendingChecks: ReadonlyArray<string> = ["a live intent pair for every event in EventIntents (needs src/gateway/Intents.ts and the M7 intent sessions)"]

/** One escalated rule part: the rule, which part, and the DESIGN §8 question it waits on. */
export interface Escalation {
  readonly rule: Rule["id"]
  readonly part: "live" | "remainder"
  readonly question: `Q-${number}`
}

/**
 * Every escalated live side or remainder in the registry, in registry order. `verify:live` prints these as unmet
 * Done criteria, never as passes (§5.1, §5.5).
 */
export const escalatedRules = (rules: ReadonlyArray<Rule>): ReadonlyArray<Escalation> =>
  rules.flatMap((rule) => {
    const out: Array<Escalation> = []
    if (rule.live.kind === "escalated") out.push({ rule: rule.id, part: "live", question: rule.live.question })
    if (rule.remainder?.kind === "escalated") out.push({ rule: rule.id, part: "remainder", question: rule.remainder.question })
    return out
  })
