/**
 * The runtime mirror of an operation's declared error union (DESIGN §2.3-§2.6, §4.7), read from the same tables
 * the types read: the row's flags and the payload's error-mode flags as `Missing<F>` (in the row's D5 variant),
 * the row's tags (Observed-gated tags only while their constant says Discord produces them), the payload- and
 * argument-derived tags the operation's requests may declare (`ErrorMap.limitFields`), `PermissionRevokedSinceCheck`
 * on a handle with granted flags (D8), and `Transient`. `test/types/pass/operations-table.ts` pins the type side
 * of each row.
 */
import { ErrorCategories, type PermissionFlag } from "../../src/errors/Missing.generated.ts"
import { Observed } from "../../src/permissions/Observed.ts"
import { type OpName, Operations, type OpSpec } from "../../src/permissions/Operations.ts"
import type { DecideArgs } from "../../src/permissions/Preflight.ts"
import { errorFlags } from "../../src/payload/PayloadRules.ts"
import { type LimitField, limitFields } from "../../src/rest/ErrorMap.ts"

/** The tag each limit field declares. */
export const limitTags: { readonly [F in LimitField]: string } = {
  empty: "MessageEmpty",
  content: "ContentTooLong",
  embeds: "EmbedTooLarge",
  poll: "PollTooLarge",
  name: "NameTooLong",
  topic: "TopicTooLong",
  slowmode: "SlowmodeOutOfRange",
  nick: "NicknameTooLong",
  timeout: "TimeoutTooLong",
  messageCount: "TooManyMessagesToDelete"
}

/** Every tag `op` declares for a request with `args` on a handle that granted `granted`. */
export const declaredTags = (op: OpName, args: DecideArgs, granted: ReadonlyArray<PermissionFlag> = []): ReadonlySet<string> => {
  const row: OpSpec = Operations[op]
  const flags = [...row.flags, ...errorFlags(args.payload)]
  const tags = row.tags.filter((tag) => (tag === "SlowmodeActive" ? Observed.slowmodeAppliesToBots : tag === "CommunicationDisabled" ? Observed.botsCanBeTimedOut : true))
  return new Set([
    ...flags.map((flag) => `Missing${flag}`),
    ...tags,
    ...(limitFields[op] ?? []).map((field) => limitTags[field]),
    ...(granted.some((flag) => flags.includes(flag)) ? ["PermissionRevokedSinceCheck"] : []),
    "DiscordUnavailable",
    "RequestTimedOut",
    "NetworkError"
  ])
}

/**
 * The class name `errorFor(op, flag)` must build (the D5 variant's for ReadMessageHistory), whose categories
 * `ErrorCategories` holds.
 */
export const promisedClass = (op: OpName, flag: PermissionFlag): keyof typeof ErrorCategories => {
  const variant = Operations[op].variant
  if (flag === "ReadMessageHistory" && variant === "reply") return "MissingReadMessageHistoryForReply"
  if (flag === "ReadMessageHistory" && variant === "reaction") return "MissingReadMessageHistoryForReaction"
  return `Missing${flag}`
}
