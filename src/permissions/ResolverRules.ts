/**
 * The resolver's hypotheses as data (DESIGN §4.6, D22). One entry per stage switch, with the H-ids it rests on
 * and its value, which starts as what Discord's documentation says ("docs"). A live finding flips one entry
 * and adds a `LOG.md` line citing the H-id; the resolver is never forked per scenario, and the offline replay
 * of the truth table fails when an entry disagrees with what Discord did (§5.13).
 */
import type { PermissionFlag } from "../errors/Missing.generated.ts"

/** Where an entry's value comes from: the documentation, or a live run that refuted it. */
export type RuleSource = "docs" | "live"

/** One switch. */
export interface ResolverRule<V> {
  readonly hypotheses: ReadonlyArray<`H-${number}`>
  readonly source: RuleSource
  readonly value: V
}

/** The resolver's switches. */
export interface Rules {
  /** The guild owner holds every permission (H-002). */
  readonly ownerHasAll: ResolverRule<boolean>
  /** Administrator in the base permissions grants every permission and bypasses every overwrite (H-003). */
  readonly administratorHasAll: ResolverRule<boolean>
  /** An Administrator bit inside a channel overwrite grants nothing beyond itself (H-004). */
  readonly overwriteAdministratorGrantsNothing: ResolverRule<boolean>
  /** A channel the gateway delivers obfuscated (flag `1 << 17`) is one the member cannot view (H-160). */
  readonly obfuscatedMeansNoView: ResolverRule<boolean>
  /** A private thread is visible only to its members and to holders of ManageThreads (H-033, H-047). */
  readonly privateThreadVisibleToMembersAndModerators: ResolverRule<boolean>
  /** Without ViewChannel every other channel permission is ignored (H-012). */
  readonly noViewMasksEverything: ResolverRule<boolean>
  /** Without SendMessages these are implicitly denied, on non-thread channels (H-013). */
  readonly noSendMasks: ResolverRule<ReadonlyArray<PermissionFlag>>
  /** Whether the SendMessages mask also applies inside threads (H-014: open; the docs say nothing). */
  readonly noSendMasksInThreads: ResolverRule<boolean>
  /** Without Connect in a voice or stage channel these are implicitly denied (H-015: the docs name only ManageChannels). */
  readonly noConnectMasks: ResolverRule<ReadonlyArray<PermissionFlag>>
  /** A timed-out member keeps only these flags (H-020), applied after overwrites (H-029). */
  readonly timeoutKeeps: ResolverRule<ReadonlyArray<PermissionFlag>>
  /** The owner and Administrator holders are exempt from the timeout mask (H-021). */
  readonly timeoutExemptsOwnerAndAdministrator: ResolverRule<boolean>
  /** In a locked thread, acting needs ManageThreads (H-036, 160005). Read by preflight. */
  readonly lockedThreadNeedsManageThreads: ResolverRule<boolean>
  /** Role assignment compares the role with the bot's highest role only; the target's rank does not matter (H-060, H-061). */
  readonly roleAssignmentIgnoresTargetRank: ResolverRule<boolean>
}

/** The current values. Edit only from a live finding, with a `LOG.md` line. */
export const ResolverRules: Rules = {
  ownerHasAll: { hypotheses: ["H-002"], source: "docs", value: true },
  administratorHasAll: { hypotheses: ["H-003"], source: "docs", value: true },
  overwriteAdministratorGrantsNothing: { hypotheses: ["H-004"], source: "docs", value: true },
  obfuscatedMeansNoView: { hypotheses: ["H-160"], source: "docs", value: true },
  privateThreadVisibleToMembersAndModerators: { hypotheses: ["H-033", "H-047"], source: "docs", value: true },
  noViewMasksEverything: { hypotheses: ["H-012"], source: "docs", value: true },
  noSendMasks: { hypotheses: ["H-013"], source: "docs", value: ["MentionEveryone", "SendTTSMessages", "AttachFiles", "EmbedLinks"] },
  noSendMasksInThreads: { hypotheses: ["H-014"], source: "docs", value: false },
  noConnectMasks: { hypotheses: ["H-015"], source: "docs", value: ["ManageChannels"] },
  timeoutKeeps: { hypotheses: ["H-020", "H-029"], source: "docs", value: ["ViewChannel", "ReadMessageHistory"] },
  timeoutExemptsOwnerAndAdministrator: { hypotheses: ["H-021"], source: "docs", value: true },
  lockedThreadNeedsManageThreads: { hypotheses: ["H-036"], source: "docs", value: true },
  roleAssignmentIgnoresTargetRank: { hypotheses: ["H-060", "H-061"], source: "docs", value: true }
}
