/**
 * The send catalog (DESIGN §5.9): the pairwise send family, and targeted rows for hypotheses the pairwise
 * dimensions cannot express. Also each payload variant's wire request for the raw call of step (c), which is
 * what the library's `ToDfx` will send (M6): `allowed_mentions` always `{ parse: [] }` plus explicit opt-ins
 * (§2.3).
 */
import type { MessageCreateRequest } from "dfx/DiscordREST/Generated"
import type { PermissionFlag } from "../../../src/errors/Missing.generated.ts"
import type { OpName } from "../../../src/permissions/Operations.ts"
import { errorModeFlags } from "../../../src/permissions/Preflight.ts"
import { type PayloadRuleName, payloadRuleNames, PayloadRules } from "../../../src/payload/PayloadRules.ts"
import type { MessageId, StickerId } from "../../../src/Snowflake.ts"
import { type Fixture, type GrantSource, type Removal, type Scenario, type SendPayload, Setup } from "../Dsl.ts"
import { staticFactsOf } from "../Facts.ts"
import { type Combination, families, pairwise } from "../Pairwise.ts"
import { channelFields } from "./common.ts"

/** The fixtures a payload needs: a message to reply to, or the provisioned guild sticker. */
export const fixturesFor = (payload: SendPayload): ReadonlyArray<Fixture> => (payload === "reply" ? ["harness-message"] : payload === "guild-sticker" ? ["guild-sticker"] : [])

// ---- the pairwise family ------------------------------------------------------------------------------

const hypothesesOf = (row: Combination): ReadonlyArray<`H-${number}`> => {
  const out = new Set<`H-${number}`>(["H-001", "H-080"])
  const add = (...ids: ReadonlyArray<`H-${number}`>) => ids.forEach((id) => out.add(id))
  switch (row.grantSource) {
    case "everyone":
      add("H-005")
      break
    case "role-overwrite-allow":
      add("H-006", "H-007")
      break
    case "member-overwrite-allow":
      add("H-008")
      break
    case "administrator":
      add("H-003")
      break
  }
  switch (row.removal) {
    case "role-overwrite-deny":
      add("H-006")
      break
    case "member-overwrite-deny":
      add("H-008")
      break
    case "everyone-overwrite-deny":
      add("H-005", "H-007")
      break
  }
  if (row.missing === "view") add("H-012")
  if (row.missing === "connect") add("H-015", row.channel === "stage" ? "H-153" : "H-152")
  if (row.channel === "voice") add("H-152")
  if (row.channel === "stage") add("H-153")
  if (row.channel !== undefined && row.channel.includes("thread")) add("H-030", "H-031")
  if (row.channel === "forum-post") add("H-030", "H-031")
  if (row.channel === "private-thread") add("H-033")
  if (row.channel === "archived-thread") add("H-035")
  if (row.channel === "locked-thread") add("H-036")
  if (row.memberState === "timed-out") add("H-020", "H-022", "H-023", "H-029")
  const payloadHypotheses: Readonly<Record<string, ReadonlyArray<`H-${number}`>>> = {
    embed: ["H-013", "H-103"],
    file: ["H-013"],
    reply: ["H-135"],
    tts: ["H-013", "H-102"],
    poll: ["H-055"],
    "guild-sticker": ["H-138"],
    "mention-everyone": ["H-013", "H-100"]
  }
  add(...(payloadHypotheses[row.payload ?? ""] ?? []))
  return [...out].sort()
}

/** The flag a pairwise `missing` value takes away. */
/**
 * The payload's flags a row may grant, whatever their `PayloadRules` mode, so the family's rows stay the same
 * when a mode changes from a live finding: every rule's flag but MentionEveryone, which is never granted in an
 * `@everyone` row (Safety, L3).
 */
export const grantablePayloadFlags = (features: ReadonlyArray<PayloadRuleName>): ReadonlyArray<PermissionFlag> =>
  [...new Set(payloadRuleNames.filter((name) => features.includes(name)).map((name) => PayloadRules[name].flag))].filter((flag) => flag !== "MentionEveryone")

const missingFlag = (missing: string, op: OpName, features: ReadonlyArray<PayloadRuleName>): PermissionFlag | undefined => {
  switch (missing) {
    case "none":
      return undefined
    case "view":
      return "ViewChannel"
    case "base":
      return op === "thread.send" ? "SendMessagesInThreads" : "SendMessages"
    case "connect":
      return "Connect"
    case "payload": {
      const [flag] = grantablePayloadFlags(features)
      if (flag === undefined) throw new Error("send catalog: missing=payload on a payload without a flag")
      return flag
    }
    default:
      throw new Error(`send catalog: unknown missing ${missing}`)
  }
}

const isGrantSource = (value: string): value is GrantSource =>
  value === "everyone" || value === "role" || value === "role-overwrite-allow" || value === "member-overwrite-allow" || value === "everyone-overwrite-allow" || value === "administrator"
const isRemoval = (value: string): value is Removal => value === "absent" || value === "role-overwrite-deny" || value === "member-overwrite-deny" || value === "everyone-overwrite-deny"
const isPayload = (value: string): value is SendPayload =>
  value === "plain" || value === "embed" || value === "file" || value === "reply" || value === "tts" || value === "poll" || value === "guild-sticker" || value === "mention-everyone"

/**
 * One pairwise row as a scenario. Every error-mode flag the row needs is granted through `grantSource`; the
 * `missing` flag is then either not granted (`removal: absent`) or granted and taken away by `removal`.
 * Degrade-mode flags (MentionEveryone) are never granted. An administrator grant lists no flags: the role
 * holds Administrator.
 */
export const fromCombination = (row: Combination): Scenario => {
  const { channel: channelValue = "", payload = "", grantSource = "", missing = "", removal = "", memberState = "" } = row
  if (!isPayload(payload) || !isGrantSource(grantSource) || !isRemoval(removal) || (memberState !== "normal" && memberState !== "timed-out")) {
    throw new Error(`send catalog: malformed row ${JSON.stringify(row)}`)
  }
  const channel = channelFields(channelValue)
  const facts = staticFactsOf({ setup: new Setup({ ...channel, grants: [], removals: [], memberState: "normal", fixtures: [] }), operation: { _tag: "send", payload } })
  const taken = missingFlag(missing, facts.op, facts.args.payload)
  const needed = [...new Set([...errorModeFlags(facts.op, { payload: [] }), ...grantablePayloadFlags(facts.args.payload)])]
  const granted = grantSource === "administrator" ? [] : removal === "absent" ? needed.filter((flag) => flag !== taken) : needed
  const setup = new Setup({
    ...channel,
    grants: [{ flags: granted, via: grantSource }],
    removals: taken === undefined || removal === "absent" ? [] : [{ flags: [taken], via: removal }],
    memberState,
    fixtures: fixturesFor(payload)
  })
  return {
    id: `send/${channelValue}/${payload}/${grantSource}/${missing}/${removal}/${memberState}`,
    hypotheses: hypothesesOf(row),
    setup,
    operation: { _tag: "send", payload }
  }
}

// ---- targeted rows ------------------------------------------------------------------------------------

const targeted = (
  name: string,
  hypotheses: ReadonlyArray<`H-${number}`>,
  payload: SendPayload,
  setup: Omit<ConstructorParameters<typeof Setup>[0], "fixtures">,
  extraFixtures: ReadonlyArray<Fixture> = []
): Scenario => ({
  id: `send/targeted/${name}`,
  hypotheses: [...hypotheses].sort(),
  setup: new Setup({ ...setup, fixtures: [...fixturesFor(payload), ...extraFixtures] }),
  operation: { _tag: "send", payload }
})

/**
 * The slowmode of the H-053 rows, in seconds. It is longer than a raw call's deadline (`Drivers.deadline`, 30 s)
 * on purpose: dfx retries every 429 after its `retry_after`, so a slowmode 429 (20016) on the second send cannot
 * come back as a late success; it runs past the deadline, which aborts the run (§5.10). A unit test holds the two
 * constants apart.
 */
export const slowmodeSeconds = 60

/** The channel settings of a slowmode row: the lab name, `slowmodeSeconds`, no required tag. */
const slowmode = { nameVariant: "a", slowmode: slowmodeSeconds, requireTag: false } as const

/** Hypotheses the pairwise dimensions cannot express (§5.9 targeted families, the send part). */
export const targetedRows: ReadonlyArray<Scenario> = [
  // H-031: in a thread, SendMessages does nothing; SendMessagesInThreads is required
  targeted("thread-send-without-smit", ["H-031"], "plain", {
    channel: "public-thread",
    grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-014: does a missing SendMessages mask EmbedLinks inside threads? The docs say the mask is for channels
  targeted("thread-embed-without-send", ["H-013", "H-014"], "embed", {
    channel: "public-thread",
    grants: [{ flags: ["ViewChannel", "SendMessagesInThreads", "EmbedLinks"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-013: no SendMessages masks EmbedLinks in a text channel; the failure is SendMessages
  targeted("text-embed-without-send", ["H-013"], "embed", {
    channel: "text",
    grants: [{ flags: ["ViewChannel", "EmbedLinks"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-033: a private thread the subject is not in, without ManageThreads, is invisible
  targeted("private-thread-non-member", ["H-033"], "plain", {
    channel: "private-thread",
    subjectThreadMember: false,
    grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-047: ManageThreads sees every private thread
  targeted("private-thread-moderator", ["H-033", "H-047"], "plain", {
    channel: "private-thread",
    subjectThreadMember: false,
    grants: [{ flags: ["ViewChannel", "SendMessagesInThreads", "ManageThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-036: a locked thread refuses members without ManageThreads, and admits those with it
  targeted("locked-thread-moderator", ["H-036"], "plain", {
    channel: "public-thread",
    threadState: "locked",
    grants: [{ flags: ["ViewChannel", "SendMessagesInThreads", "ManageThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  targeted("archived-locked-thread", ["H-035", "H-036"], "plain", {
    channel: "public-thread",
    threadState: "archived-locked",
    grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-003: an Administrator ignores an @everyone deny of View
  targeted("administrator-past-deny", ["H-003"], "plain", {
    channel: "text",
    grants: [{ flags: [], via: "administrator" }],
    removals: [{ flags: ["ViewChannel"], via: "everyone-overwrite-deny" }],
    memberState: "normal"
  }),
  // H-021: an Administrator is exempt from a timeout (the timeout is applied before the role, §5.8)
  targeted("administrator-timed-out", ["H-021"], "plain", {
    channel: "text",
    grants: [{ flags: [], via: "administrator" }],
    removals: [],
    memberState: "timed-out"
  }),
  // H-152: voice text chat without View, with Connect and Send
  targeted("voice-connect-without-view", ["H-012", "H-152"], "plain", {
    channel: "voice",
    grants: [{ flags: ["Connect", "SendMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // ordering (§3.2): View and Send both missing. H-011: the channel's only allow is `lab-target`'s overwrite (View
  // and Send among it), for a role the subject does not hold, and it gives the subject nothing
  targeted("order-view-send", ["H-011", "H-012", "H-080"], "plain", {
    channel: "text",
    grants: [],
    removals: [],
    memberState: "normal"
  }),
  // ordering with a dedicated code: Send and the reply's ReadMessageHistory (160002, H-135)
  targeted("order-send-reply-history", ["H-080", "H-135"], "reply", {
    channel: "text",
    grants: [{ flags: ["ViewChannel"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // ordering with a dedicated code: SendMessagesInThreads and a locked thread (160005, H-036)
  targeted("order-smit-locked", ["H-031", "H-036"], "plain", {
    channel: "public-thread",
    threadState: "locked",
    grants: [{ flags: ["ViewChannel"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-036 (M3 verifier): every locked row so far had the subject outside the thread, so its 50001 could be the
  // refused auto-join (H-034) rather than the lock; here the subject is a member without ManageThreads
  targeted("locked-thread-member", ["H-034", "H-036"], "plain", {
    channel: "public-thread",
    threadState: "locked",
    subjectThreadMember: true,
    grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // payload flags missing alone, outside threads (M3 verifier: no pairwise row had SendPolls, a reply's
  // ReadMessageHistory or SendTTSMessages as its only missing flag in a channel)
  targeted("poll-without-send-polls", ["H-055"], "poll", {
    channel: "text",
    grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  targeted("reply-without-history", ["H-091", "H-135"], "reply", {
    channel: "text",
    grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  targeted("tts-without-tts-text", ["H-102"], "tts", {
    channel: "text",
    grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  targeted("tts-without-tts-voice", ["H-102", "H-152"], "tts", {
    channel: "voice",
    grants: [{ flags: ["ViewChannel", "Connect", "SendMessages"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // ordering: the timeout and a missing SendMessagesInThreads, whose code (50001) differs from the timeout's
  targeted("order-timeout-smit", ["H-020", "H-031"], "plain", {
    channel: "public-thread",
    grants: [{ flags: ["ViewChannel"], via: "role" }],
    removals: [],
    memberState: "timed-out"
  }),
  // ordering: the timeout ranks above a missing SendMessages (H-020)
  targeted("order-timeout-send", ["H-020", "H-023"], "plain", {
    channel: "text",
    grants: [{ flags: ["ViewChannel"], via: "role" }],
    removals: [],
    memberState: "timed-out"
  }),
  // ordering (§3.2 tiers 5 and 6, M4 verifier): a locked thread and a payload flag; the lock answers 50001
  // (H-036), a missing EmbedLinks alone 50013 (H-103), so the code shows which Discord checked first
  targeted("order-locked-embed", ["H-036", "H-103"], "embed", {
    channel: "public-thread",
    threadState: "locked",
    subjectThreadMember: true,
    grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }],
    removals: [],
    memberState: "normal"
  }),
  // H-053: bots ignore slowmode, so the subject's second send in a row succeeds without BypassSlowmode (the
  // fixture is its first, sent after Converge set the slowmode); with BypassSlowmode it succeeds by any account
  targeted(
    "slowmode-second-send",
    ["H-053"],
    "plain",
    { channel: "text", channelSettings: slowmode, grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }], removals: [], memberState: "normal" },
    ["subject-prior-send"]
  ),
  targeted(
    "slowmode-second-send-bypass",
    ["H-053"],
    "plain",
    { channel: "text", channelSettings: slowmode, grants: [{ flags: ["ViewChannel", "SendMessages", "BypassSlowmode"], via: "role" }], removals: [], memberState: "normal" },
    ["subject-prior-send"]
  ),
  // H-005: an @everyone overwrite allow grants what the base lacks; H-007: a role overwrite deny beats it
  targeted("overwrite-everyone-allow", ["H-005"], "plain", {
    channel: "text",
    grants: [{ flags: ["ViewChannel", "SendMessages"], via: "everyone-overwrite-allow" }],
    removals: [],
    memberState: "normal"
  }),
  targeted("overwrite-everyone-allow-role-deny", ["H-005", "H-007"], "plain", {
    channel: "text",
    grants: [{ flags: ["ViewChannel", "SendMessages"], via: "everyone-overwrite-allow" }],
    removals: [{ flags: ["SendMessages"], via: "role-overwrite-deny" }],
    memberState: "normal"
  })
]

/** The send catalog: the pairwise family and the targeted rows, sorted by ID. */
export const scenarios: ReadonlyArray<Scenario> = [...pairwise(families.send).map(fromCombination), ...targetedRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

// ---- the wire payload ---------------------------------------------------------------------------------

/** What the raw call needs besides the payload variant. */
export interface WireContext {
  /** The message a reply references (the `harness-message` fixture). */
  readonly replyTo: MessageId | undefined
  /** The lab's guild sticker. */
  readonly stickerId: StickerId | undefined
}

/** A request for the raw create-message call, and the files to attach. */
export interface WirePayload {
  readonly request: MessageCreateRequest
  readonly files: ReadonlyArray<File>
}

/** The raw request for a payload variant: what the library's `ToDfx` sends for it (M6). */
export const wirePayload = (payload: SendPayload, context: WireContext): WirePayload => {
  const quiet = { allowed_mentions: { parse: [] } }
  switch (payload) {
    case "plain":
      return { request: { ...quiet, content: "lab send" }, files: [] }
    case "embed":
      return { request: { ...quiet, embeds: [{ title: "lab embed", description: "a lab embed" }] }, files: [] }
    case "file":
      return { request: { ...quiet, content: "lab file" }, files: [new File(["lab file\n"], "lab.txt", { type: "text/plain" })] }
    case "reply": {
      if (context.replyTo === undefined) throw new Error("send catalog: a reply needs its harness-message fixture")
      return { request: { allowed_mentions: { parse: [], replied_user: false }, content: "lab reply", message_reference: { message_id: context.replyTo, fail_if_not_exists: true } }, files: [] }
    }
    case "tts":
      return { request: { ...quiet, content: "lab tts", tts: true }, files: [] }
    case "poll":
      return {
        request: { ...quiet, poll: { question: { text: "lab poll" }, answers: [{ poll_media: { text: "yes" } }, { poll_media: { text: "no" } }], duration: 1, allow_multiselect: false } },
        files: []
      }
    case "guild-sticker": {
      if (context.stickerId === undefined) throw new Error("send catalog: the lab has no guild sticker")
      return { request: { ...quiet, sticker_ids: [context.stickerId] }, files: [] }
    }
    case "mention-everyone":
      // the only payload that opts into a mention; Safety guarantees MentionEveryone is never granted (§5.6)
      return { request: { allowed_mentions: { parse: ["everyone"] }, content: "@everyone lab mention" }, files: [] }
  }
}
