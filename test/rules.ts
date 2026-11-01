/**
 * The rule registry (DESIGN §5.5, G10). Every compile-time rule names its pass fixture, its fail fixture, the
 * directive mentions in that fail fixture it claims, and either a live valid/invalid pair or an allowlisted
 * reason why it has none. `bun run rules` (`scripts/rules-check.ts`) checks the registry for completeness.
 */
import type { Observation } from "../harness/scenario/Dsl.ts"

/** A live pair: both sides run on a byte-identical Setup, and each side has its own full expectation. */
export interface LivePair {
  readonly kind: "pair"
  /** The name of the Setup both sides share. */
  readonly setup: string
  readonly valid: { readonly scenario: string; readonly expect: Observation }
  readonly invalid: { readonly scenario: string; readonly expect: Observation }
}

/** Why a rule (or the remainder of one) has no live pair. Each reason is allowed only for listed rule ids. */
export type NotLiveReason = "phase-3-offline" | "needs-second-guild" | "forbidden-action" | "pure-typing"

/**
 * No live pair: an allowlisted reason, or an escalation to Rhys citing a DESIGN §8 open question. An escalated
 * rule is an unmet Done criterion, never a pass.
 */
export type NotLive =
  | { readonly kind: "not-live"; readonly reason: NotLiveReason }
  | { readonly kind: "escalated"; readonly question: `Q-${number}` }

/** One compile-time rule. */
export interface Rule {
  readonly id: `R-${string}`
  readonly statement: string
  readonly pass: `test/types/pass/${string}.ts`
  readonly fail: `test/types/fail/${string}.ts`
  /**
   * The `// @expect-error` mentions in `fail` this rule claims. Every directive of every fail fixture must be
   * claimed by some rule, so each type restriction has a registry entry.
   */
  readonly claims: readonly [string, ...Array<string>]
  readonly live: LivePair | NotLive
  /** A not-live or escalated remainder next to a live half (e.g. registration live, delivered values escalated). */
  readonly remainder?: NotLive
}

/** The registry. */
export const rules: ReadonlyArray<Rule> = [
  {
    id: "R-catch-tag-exact",
    statement: "Effect.catchTag removes exactly the tag it names; catching a tag the effect cannot fail with does not compile",
    pass: "test/types/pass/catch-tag-exact.ts",
    fail: "test/types/fail/catch-tag-exact.ts",
    claims: ["Beta"],
    live: { kind: "not-live", reason: "pure-typing" }
  }
]
