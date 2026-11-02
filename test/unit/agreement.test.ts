import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { agreement, expectedOracleMissing, flipAgreement } from "../../harness/Agreement.ts"
import * as Drivers from "../../harness/Drivers.ts"
import { expectedCode } from "../../src/permissions/Observed.ts"
import * as Outcome from "../../harness/Outcome.ts"
import { Setup } from "../../harness/scenario/Dsl.ts"
import * as TruthTable from "../../harness/TruthTable.ts"
import { DiscordResponse, FieldError } from "../../src/errors/Cause.ts"
import type { PermissionFlag } from "../../src/errors/Missing.generated.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import type { OpName } from "../../src/permissions/Operations.ts"
import { type DecideArgs, decide } from "../../src/permissions/Preflight.ts"
import { resolve } from "../../src/permissions/Resolver.ts"
import { MessageId } from "../../src/Snowflake.ts"
import { channel, everyone, guild, guildId, known, later, member, now, role, roleOverwrite, set, thread } from "../support/guild.ts"

/**
 * The matrix's judgment (DESIGN §5.10, §5.12): agreement per mismatch kind, the raw outcome and degradation
 * readback, and the truth table's canonical, order-independent bytes.
 */
const setup = new Setup({ channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }], removals: [], memberState: "normal", fixtures: [] })
const facts = { op: "channel.send" as const, needed: ["ViewChannel", "SendMessages", "EmbedLinks"] as const, degradable: ["MentionEveryone"] as const }
const success: TruthTable.RawOutcome = { class: "success", status: 200, code: 0, inner: [], degraded: [], mappedTag: "n/a" }
const denied = (code: number): TruthTable.RawOutcome => ({ class: code === 50001 ? "50001" : code === 50013 ? "50013" : "other-error", status: 403, code, inner: [], degraded: [], mappedTag: "n/a" })
const row = (overrides: Partial<Omit<TruthTable.Row, "agreement">>): Omit<TruthTable.Row, "agreement"> => ({
  setup,
  operation: "send:embed",
  resolver: { required: ["EmbedLinks", "SendMessages", "ViewChannel"], missing: [], missingBeforeMasks: [], masks: [], level: "none" },
  preflight: "pass",
  preflightSet: [],
  raw: success,
  recompute: "n/a",
  oracle: { missing: [] },
  ...overrides
})
const embedMissing = {
  resolver: { required: ["EmbedLinks", "SendMessages", "ViewChannel"], missing: ["EmbedLinks"], missingBeforeMasks: ["EmbedLinks"], masks: [], level: "action" },
  preflight: { tag: "MissingEmbedLinks", categories: ["payload", "permission"] },
  preflightSet: ["MissingEmbedLinks"],
  oracle: { missing: ["EmbedLinks"] }
} satisfies Partial<Omit<TruthTable.Row, "agreement">>

describe("agreement", () => {
  it("agrees when everything lines up, both for a pass and for a 50013", () => {
    expect(agreement(row({}), facts)).toBe("agree")
    expect(agreement(row({ ...embedMissing, raw: denied(50013) }), facts)).toBe("agree")
  })

  it("flags preflight-wiring when step (b) is not the first of the set", () => {
    expect(agreement(row({ ...embedMissing, preflight: "pass" }), facts)).toBe("preflight-wiring")
    expect(agreement(row({ preflightSet: ["MissingEmbedLinks"] }), facts)).toBe("preflight-wiring")
  })

  it("flags preflight-vs-raw for a pass that Discord refused, a failure Discord allowed, and a mapped tag outside the set", () => {
    expect(agreement(row({ raw: denied(50013) }), facts)).toBe("preflight-vs-raw")
    expect(agreement(row({ ...embedMissing, raw: success }), facts)).toBe("preflight-vs-raw")
    const locked: TruthTable.RawOutcome = { ...denied(160005), status: 400, mappedTag: "ThreadLocked" }
    expect(agreement(row({ ...embedMissing, raw: locked }), facts)).toBe("preflight-vs-raw")
    expect(agreement(row({ ...embedMissing, preflightSet: ["MissingEmbedLinks", "ThreadLocked"], raw: locked }), facts)).toBe("agree")
  })

  it("flags level-vs-raw when 50001 and 50013 do not match the level (H-080)", () => {
    expect(agreement(row({ ...embedMissing, raw: denied(50001) }), facts)).toBe("level-vs-raw")
    const view = { ...embedMissing, resolver: { ...embedMissing.resolver, missing: ["ViewChannel"], level: "view" }, preflight: { tag: "MissingViewChannel", categories: ["access", "permission"] }, preflightSet: ["MissingViewChannel"] } satisfies Partial<Omit<TruthTable.Row, "agreement">>
    expect(agreement(row({ ...view, raw: denied(50013) }), facts)).toBe("level-vs-raw")
  })

  it("flags resolver-vs-raw for a refusal the resolver cannot explain, and a degraded list that differs", () => {
    const unexplained = { ...embedMissing, resolver: { ...embedMissing.resolver, missing: [] as const } } satisfies Partial<Omit<TruthTable.Row, "agreement">>
    expect(agreement(row({ ...unexplained, raw: denied(50013) }), facts)).toBe("resolver-vs-raw")
    expect(agreement(row({ raw: { ...success, class: "degraded", degraded: ["MentionEveryone"] } }), facts)).toBe("resolver-vs-raw")
    const missingEveryone = row({ resolver: { required: ["MentionEveryone", "SendMessages", "ViewChannel"], missing: ["MentionEveryone"], missingBeforeMasks: ["MentionEveryone"], masks: [], level: "none" }, oracle: { missing: ["MentionEveryone"] } })
    expect(agreement({ ...missingEveryone, raw: { ...success, class: "degraded", degraded: ["MentionEveryone"] } }, facts)).toBe("agree")
    expect(agreement(missingEveryone, facts)).toBe("resolver-vs-raw")
  })

  it("flags resolver-vs-oracle, comparing only View for an obfuscated or unseen channel, and nothing for an unseen private thread the subject is not in", () => {
    expect(agreement(row({ oracle: { missing: ["EmbedLinks"] } }), facts)).toBe("resolver-vs-oracle")
    const blind = (mask: "obfuscated" | "unseen") =>
      row({
        resolver: { required: ["SendMessages", "ViewChannel"], missing: ["SendMessages", "ViewChannel"], missingBeforeMasks: [], masks: [mask], level: "view" },
        preflight: { tag: "MissingViewChannel", categories: ["access", "permission"] },
        preflightSet: ["MissingViewChannel"],
        raw: denied(50001),
        oracle: { missing: ["ViewChannel"] }
      })
    expect(agreement(blind("obfuscated"), facts)).toBe("agree")
    expect(agreement({ ...blind("obfuscated"), oracle: { missing: [] } }, facts)).toBe("resolver-vs-oracle")
    expect(agreement(blind("unseen"), facts)).toBe("agree")
    expect(agreement({ ...blind("unseen"), oracle: { missing: [] } }, facts)).toBe("resolver-vs-oracle")
    // the oracle ignores thread membership: a private thread the subject is not in reads View there (H-033)
    const privateThread = (member: boolean | undefined) =>
      new Setup({ channel: "private-thread", ...(member === undefined ? {} : { subjectThreadMember: member }), grants: [], removals: [], memberState: "normal", fixtures: [] })
    expect(agreement({ ...blind("unseen"), setup: privateThread(false), oracle: { missing: [] } }, facts)).toBe("agree")
    expect(agreement({ ...blind("unseen"), setup: privateThread(undefined), oracle: { missing: [] } }, facts)).toBe("agree")
    expect(agreement({ ...blind("unseen"), setup: privateThread(true), oracle: { missing: [] } }, facts)).toBe("resolver-vs-oracle")
  })

  it("flags recompute-vs-preflight when step (d) differs in tag or categories", () => {
    const base = { ...embedMissing, raw: denied(50013) }
    expect(agreement(row({ ...base, recompute: { tag: "MissingEmbedLinks", categories: ["payload", "permission"] } }), facts)).toBe("agree")
    expect(agreement(row({ ...base, recompute: { tag: "MissingEmbedLinks", categories: ["permission"] } }), facts)).toBe("recompute-vs-preflight")
  })

  it("reads the code from Observed: 50001 for the view level and an operation's listed failures, 50013 otherwise", () => {
    expect(expectedCode("thread.send", "action", "MissingSendMessagesInThreads")).toBe(50001)
    expect(expectedCode("thread.send", "action", "CommunicationDisabled")).toBe(50001)
    expect(expectedCode("channel.send", "action", "CommunicationDisabled")).toBe(50013)
    expect(expectedCode("channel.send", "action", "MissingSendMessagesInThreads")).toBe(50013)
    expect(expectedCode("channel.send", "view", "CommunicationDisabled")).toBe(50001)
    expect(expectedCode("channel.send", "none", undefined)).toBeUndefined()
    const threadFacts = { op: "thread.send" as const, needed: ["ViewChannel", "SendMessagesInThreads"] as const, degradable: [] }
    const smit = row({
      resolver: { required: ["SendMessagesInThreads", "ViewChannel"], missing: ["SendMessagesInThreads"], missingBeforeMasks: ["SendMessagesInThreads"], masks: [], level: "action" },
      preflight: { tag: "MissingSendMessagesInThreads", categories: ["access", "permission"] },
      preflightSet: ["MissingSendMessagesInThreads"],
      oracle: { missing: ["SendMessagesInThreads"] }
    })
    expect(agreement({ ...smit, raw: denied(50001) }, threadFacts)).toBe("agree")
    expect(agreement({ ...smit, raw: denied(50013) }, threadFacts)).toBe("level-vs-raw")
  })

  it("explains a refusal by a state failure without a missing flag (a locked thread, the hierarchy), not as resolver-vs-raw", () => {
    const locked = row({
      resolver: { required: ["SendMessagesInThreads", "ViewChannel"], missing: [], missingBeforeMasks: [], masks: [], level: "action" },
      preflight: { tag: "ThreadLocked", categories: ["state"] },
      preflightSet: ["ThreadLocked"],
      raw: denied(50001)
    })
    expect(agreement(locked, { op: "thread.send", needed: ["ViewChannel", "SendMessagesInThreads"], degradable: [] })).toBe("agree")
    expect(agreement({ ...locked, preflight: { tag: "MissingViewChannel", categories: ["access", "permission"] }, preflightSet: ["MissingViewChannel"], resolver: { ...locked.resolver, level: "view" } }, { op: "thread.send", needed: ["ViewChannel", "SendMessagesInThreads"], degradable: [] })).toBe("resolver-vs-raw")
  })

  it("compares the oracle with the timeout mask applied (H-241)", () => {
    const timedOut = { required: ["AttachFiles", "SendMessages", "ViewChannel"] as const, missing: ["AttachFiles", "SendMessages"] as const, missingBeforeMasks: [] as const, masks: ["timeout"] as const, level: "action" as const }
    expect(expectedOracleMissing(timedOut)).toEqual(["AttachFiles", "SendMessages"])
    const timedRow = row({ resolver: timedOut, preflight: { tag: "CommunicationDisabled", categories: ["state"] }, preflightSet: ["CommunicationDisabled"], raw: denied(50013), oracle: { missing: ["AttachFiles", "SendMessages"] } })
    expect(agreement(timedRow, facts)).toBe("agree")
    expect(agreement({ ...timedRow, oracle: { missing: [] } }, facts)).toBe("resolver-vs-oracle")
  })

  it("agrees on a setup Discord would not build", () => {
    expect(agreement(row({ preflight: "n/a", raw: Outcome.unsupported("kind-not-available"), oracle: "not-applicable" }), facts)).toBe("agree")
  })
})

describe("flip controls", () => {
  const failed = (set: ReadonlyArray<string>): TruthTable.Row => ({
    ...row({ preflight: set[0] === undefined ? "pass" : { tag: set[0], categories: ["permission"] }, preflightSet: [...set], raw: set.length > 0 ? denied(50013) : success }),
    agreement: "agree"
  })
  it("needs the flip to succeed when the original had one failure, and to fail with the next one otherwise", () => {
    expect(flipAgreement(failed(["MissingEmbedLinks"]), failed([]))).toBe("agree")
    expect(flipAgreement(failed(["MissingEmbedLinks"]), failed(["MissingAttachFiles"]))).toBe("flip-control")
    expect(flipAgreement(failed(["MissingSendMessages", "MissingEmbedLinks"]), failed(["MissingEmbedLinks"]))).toBe("agree")
    expect(flipAgreement(failed(["MissingSendMessages", "MissingEmbedLinks"]), failed([]))).toBe("flip-control")
    // an original that did not fail, or an unbuilt setup, leaves nothing to check; a flip's own mismatch stays
    expect(flipAgreement(failed([]), failed(["MissingAttachFiles"]))).toBe("agree")
    expect(flipAgreement({ ...failed(["MissingEmbedLinks"]), raw: Outcome.unsupported("admin-exempt") }, failed(["MissingAttachFiles"]))).toBe("agree")
    expect(flipAgreement(failed(["MissingEmbedLinks"]), { ...failed([]), agreement: "preflight-vs-raw" })).toBe("preflight-vs-raw")
  })
})

describe("the raw outcome", () => {
  const message = (overrides: Partial<Outcome.CreatedMessage>): Outcome.CreatedMessage => ({
    id: MessageId.make("600000000000000001"),
    tts: false,
    mention_everyone: false,
    embeds: [],
    attachments: [],
    ...overrides
  })

  it("reads back what Discord dropped, whatever PayloadRules' mode says (open question 4)", () => {
    expect(Outcome.succeeded("embed", message({ embeds: [{}] }))).toEqual(success)
    expect(Outcome.succeeded("embed", message({})).degraded).toEqual(["EmbedLinks"])
    expect(Outcome.succeeded("file", message({})).degraded).toEqual(["AttachFiles"])
    expect(Outcome.succeeded("tts", message({ tts: true })).class).toBe("success")
    expect(Outcome.succeeded("tts", message({})).degraded).toEqual(["SendTTSMessages"])
    expect(Outcome.succeeded("poll", message({ poll: null })).degraded).toEqual(["SendPolls"])
    expect(Outcome.succeeded("reply", message({ message_reference: { message_id: "1" } })).class).toBe("success")
    expect(Outcome.succeeded("reply", message({})).degraded).toEqual(["ReadMessageHistory"])
    expect(Outcome.succeeded("reply", message({ message_reference: null })).degraded).toEqual(["ReadMessageHistory"])
    expect(Outcome.succeeded("poll", message({ poll: { question: {} } })).class).toBe("success")
    expect(Outcome.succeeded("mention-everyone", message({}))).toMatchObject({ class: "degraded", degraded: ["MentionEveryone"] })
    expect(Outcome.succeeded("plain", message({})).class).toBe("success")
  })

  it("reads a pins list back: empty although the harness pinned a message means ReadMessageHistory was missing (H-107)", () =>
    Effect.gen(function* () {
      const pinned = new Setup({ channel: "text", grants: [], removals: [], memberState: "normal", fixtures: ["harness-message", "pinned-harness-message"] })
      const list = (items: ReadonlyArray<unknown>, at: Setup = pinned) =>
        Drivers.outcomeOf({ setup: at, operation: { _tag: "pins", action: "list" } }, { answer: { _tag: "Ok", body: { items, has_more: false } }, created: undefined })
      expect(yield* list([])).toMatchObject({ class: "degraded", degraded: ["ReadMessageHistory"] })
      expect((yield* list([{ pinned_at: "x", message: {} }])).class).toBe("success")
      // without a pin to list, an empty list is just empty
      expect((yield* list([], setup)).class).toBe("success")
      expect((yield* Drivers.outcomeOf({ setup, operation: { _tag: "thread", action: "join" } }, { answer: { _tag: "Ok", body: undefined }, created: undefined })).class).toBe("success")
    }).pipe(Effect.runSync))

  it("classifies Discord's answers with sorted inner codes and the dedicated code's tag", () => {
    const response = (status: number, code: number, fieldErrors: ReadonlyArray<FieldError> = []) =>
      new DiscordResponse({ status, code, message: "x", method: "POST", route: "/channels/{channel.id}/messages", fieldErrors, attributedBy: "code" })
    expect(Outcome.rejected(response(403, 50013))).toEqual(denied(50013))
    expect(Outcome.rejected(response(403, 50001)).class).toBe("50001")
    expect(Outcome.rejected(response(400, 160005)).mappedTag).toBe("ThreadLocked")
    expect(
      Outcome.rejected(response(400, 50035, [new FieldError({ path: ["poll", "question"], code: "B", message: "m" }), new FieldError({ path: ["content"], code: "A", message: "m" })])).inner
    ).toEqual([
      { path: "content", code: "A" },
      { path: "poll.question", code: "B" }
    ])
  })
})

describe("the truth table", () => {
  const env = { mfaLevel: 0, obfuscation: "default", oracle: "available", typescript: "7.0.2", dfx: "1.1.1", discordApiTypes: "0.38.57", everyoneBaseline: [] } as const
  const rowA: TruthTable.Row = { ...row({}), agreement: "agree" }
  const rowB: TruthTable.Row = { ...row({ ...embedMissing, raw: denied(50013) }), agreement: "agree" }

  it("renders the same bytes whatever the insertion order, and round-trips", () => {
    const a = TruthTable.render({ schema: 2, env, scenarios: { "send/b": rowB, "send/a": rowA } })
    const b = TruthTable.render({ schema: 2, env, scenarios: { "send/a": rowA, "send/b": rowB } })
    expect(a).toBe(b)
    expect(a.endsWith("}\n")).toBe(true)
    expect(Object.keys(JSON.parse(a))).toEqual(["env", "scenarios", "schema"])
  })

  it("names the rows and the header that differ", () => {
    const table: TruthTable.TruthTable = { schema: 2, env, scenarios: { "send/a": rowA, "send/b": rowB } }
    expect(TruthTable.differences(table, table)).toEqual([])
    expect(TruthTable.differences(table, { ...table, env: { ...env, oracle: "unavailable" }, scenarios: { "send/a": { ...rowA, agreement: "preflight-vs-raw" }, "send/c": rowB } })).toEqual([
      "env",
      "send/a",
      "send/b",
      "send/c"
    ])
  })
})

describe("the resolver record (step a)", () => {
  const all = set("ViewChannel", "SendMessages", "SendMessagesInThreads", "Connect", "EmbedLinks", "MentionEveryone")
  const resolution = (target: Parameters<typeof resolve>[0]["channel"], granted = all, timedOutUntil: string | null = null) =>
    resolve({ guild: guild([role(everyone, granted)]), channel: target, member: member([], timedOutUntil), now })
  const deny = (...flags: ReadonlyArray<PermissionFlag>) => [roleOverwrite(guildId, Flags.empty, set(...flags))]
  const levelOf = (op: OpName, resolved: ReturnType<typeof resolution>, args: DecideArgs = { payload: [] }) => TruthTable.levelOf(op, resolved, decide(op, resolved, args))

  it("records the required flags sorted, what is missing after the masks and before them, and the masks", () => {
    // no Send masks EmbedLinks (H-013): missing after the masks, present before them
    const resolved = resolution(known(channel("text", deny("SendMessages"))))
    const record = TruthTable.resolverRecord("channel.send", resolved, ["ViewChannel", "SendMessages", "EmbedLinks"], decide("channel.send", resolved, { payload: ["embeds"] }))
    expect(record).toEqual({
      required: ["EmbedLinks", "SendMessages", "ViewChannel"],
      missing: ["EmbedLinks", "SendMessages"],
      missingBeforeMasks: ["SendMessages"],
      masks: ["implicit-send"],
      level: "action"
    })
    // flags outside `required` are never listed, whatever the resolution lacks
    const bare = resolution(known(channel("text")), set("ViewChannel"))
    expect(TruthTable.resolverRecord("channel.send", bare, ["ViewChannel"], decide("channel.send", bare, { payload: [] })).missing).toEqual([])
  })

  it("levels a blind channel, a missing View and a voice row without Connect (the timeout's included) as view", () => {
    expect(levelOf("channel.send", resolution({ _tag: "Unseen" }))).toBe("view")
    expect(levelOf("channel.send", resolution(known(channel("text", deny("ViewChannel")))))).toBe("view")
    expect(levelOf("thread.send", resolution(known(thread("private-thread"), channel("text"))))).toBe("view")
    expect(levelOf("voice.send", resolution(known(channel("voice", deny("Connect")))))).toBe("view")
    // M3 live: a timed-out subject in voice answers 50001, because the timeout removes Connect
    expect(levelOf("voice.send", resolution(known(channel("voice")), all, later))).toBe("view")
    // Connect only counts on a row that requires it
    expect(levelOf("channel.send", resolution(known(channel("text")), set("ViewChannel", "SendMessages")))).toBe("none")
  })

  it("levels any preflight failure with the channel visible as action: a missing flag, the timeout, a locked thread, the hierarchy", () => {
    expect(levelOf("channel.send", resolution(known(channel("text", deny("SendMessages")))))).toBe("action")
    expect(levelOf("channel.send", resolution(known(channel("text")), all, later))).toBe("action")
    expect(levelOf("thread.send", resolution(known(thread("public-thread", { locked: true }), channel("text"))))).toBe("action")
    const guildScope = resolution({ _tag: "Guild" }, set("KickMembers"))
    expect(levelOf("member.kick", guildScope, { payload: [], target: { below: false, administrator: false } })).toBe("action")
    expect(levelOf("member.kick", guildScope, { payload: [], target: { below: true, administrator: false } })).toBe("none")
    // a row's viewLevel flag is View-level (M4 live: pinning without ReadMessageHistory answers 50001)
    const pin = resolution(known(channel("text")), set("ViewChannel", "PinMessages"))
    expect(levelOf("message.pin.channel", pin)).toBe("view")
    expect(levelOf("message.pin.channel", resolution(known(channel("text")), set("ViewChannel", "PinMessages", "ReadMessageHistory")))).toBe("none")
    // a missing degrade-mode flag fails nothing
    expect(levelOf("channel.send", resolution(known(channel("text")), set("ViewChannel", "SendMessages")), { payload: ["mentionsEveryone"] })).toBe("none")
  })
})
