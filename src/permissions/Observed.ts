/**
 * Constants decided by the live matrix (DESIGN §8, D11 generalised). They are hand-edited from a live run, and
 * the offline replay of `fixtures/truth-table.json` fails when one disagrees with the table (§5.13), so the
 * types cannot drift from what Discord does.
 *
 * Tags gated here appear in the operation unions only while their constant says Discord produces them.
 */
import type { CommunicationDisabled, SlowmodeActive } from "../errors/State.ts"

/**
 * - `slowmodeAppliesToBots`: whether a bot without BypassSlowmode gets 20016 (§8, question 3; H-053). Default
 *   `false`: the docs say slowmode does not apply to bots.
 * - `botsCanBeTimedOut`: whether a bot member can be timed out at all (§8, question 1; H-022). Default `true`.
 */
export const Observed = { slowmodeAppliesToBots: false, botsCanBeTimedOut: true } as const

type Constants = typeof Observed

/** `SlowmodeActive` when the matrix shows slowmode applies to bots, otherwise `never`. */
export type MaybeSlowmode = Constants["slowmodeAppliesToBots"] extends true ? SlowmodeActive : never

/** `CommunicationDisabled` when bots can be timed out, otherwise `never`. */
export type MaybeTimedOut = Constants["botsCanBeTimedOut"] extends true ? CommunicationDisabled : never
