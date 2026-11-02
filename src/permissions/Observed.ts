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
 * - `botsCanBeTimedOut`: whether a bot member can be timed out at all (§8, question 1; H-022). M3: `true`.
 * - `codeForLevel`: the Discord code for each failing level (§8, question 2; H-080): no View answers 50001, View
 *   with an action flag missing answers 50013. The matrix's `level-vs-raw` check reads it.
 * - `viewCodeFailures`: the tags of first failures that Discord answers with 50001 although the bot can view the
 *   channel, per operation. M3: in a thread, a missing SendMessagesInThreads answers 50001 (H-080 refined;
 *   member and non-member rows alike). M4: so does a locked thread (members too, H-036), a forum post without
 *   SendMessages, a crosspost without SendMessages or under a timeout, a thread without its creation flag or
 *   under a timeout, every thread edit (archive, lock, slowmode) without SendMessagesInThreads or
 *   ManageThreads, a member added without SendMessagesInThreads, and a role assignment without ManageRoles or
 *   under a timeout. A thread send under a timeout with SendMessagesInThreads also missing answered 50001;
 *   whether Discord checked the timeout or the flag first is not observable (both answer 50001), so the
 *   timeout keeps its §3.2 rank and is listed here.
 * - `oracleAppliesTimeout`: whether `GET /channels/{c}/permissions/member/{u}?implicit=false` applies the timeout
 *   mask (§8, question 9; H-241). M3: it does, so agreement compares the oracle with the overwrites' result
 *   after the timeout mask.
 */
export const Observed = {
  slowmodeAppliesToBots: false,
  botsCanBeTimedOut: true,
  codeForLevel: { view: 50001, action: 50013 },
  viewCodeFailures: {
    "thread.send": ["MissingSendMessagesInThreads", "ThreadLocked", "CommunicationDisabled"],
    "message.crosspostOwn": ["MissingSendMessages", "CommunicationDisabled"],
    "message.crosspostForeign": ["MissingSendMessages", "CommunicationDisabled"],
    "forum.createPost": ["MissingSendMessages"],
    "channel.createThread.public": ["MissingCreatePublicThreads", "CommunicationDisabled"],
    "channel.createThread.private": ["MissingCreatePrivateThreads", "CommunicationDisabled"],
    "thread.addMember": ["MissingSendMessagesInThreads", "CommunicationDisabled"],
    "thread.setArchived": ["MissingSendMessagesInThreads", "MissingManageThreads"],
    "thread.unarchive": ["MissingSendMessagesInThreads"],
    "thread.setLocked": ["MissingSendMessagesInThreads", "MissingManageThreads", "CommunicationDisabled"],
    "thread.edit": ["MissingSendMessagesInThreads", "MissingManageThreads"],
    "member.addRole": ["MissingManageRoles", "CommunicationDisabled"],
    "member.removeRole": ["MissingManageRoles", "CommunicationDisabled"]
  },
  oracleAppliesTimeout: true
} as const

type Constants = typeof Observed

/** `SlowmodeActive` when the matrix shows slowmode applies to bots, otherwise `never`. */
export type MaybeSlowmode = Constants["slowmodeAppliesToBots"] extends true ? SlowmodeActive : never

/** `CommunicationDisabled` when bots can be timed out, otherwise `never`. */
export type MaybeTimedOut = Constants["botsCanBeTimedOut"] extends true ? CommunicationDisabled : never

/**
 * The code Discord answers a refusal with, as observed, given the resolver's level and the tag of preflight's
 * first failure: 50001 for the `view` level and for the operation's `viewCodeFailures`, 50013 for any other
 * `action`-level failure, and nothing expected at level `none`.
 */
export const expectedCode = (op: string, level: "none" | "view" | "action", firstTag: string | undefined): number | undefined => {
  if (level === "none") return undefined
  if (level === "view") return Observed.codeForLevel.view
  const listed: Readonly<Record<string, ReadonlyArray<string>>> = Observed.viewCodeFailures
  return firstTag !== undefined && (listed[op] ?? []).includes(firstTag) ? Observed.codeForLevel.view : Observed.codeForLevel.action
}
