import { describe, expect, it } from "vitest"
import { agreement } from "../../harness/Agreement.ts"
import * as Outcome from "../../harness/Outcome.ts"
import { Setup } from "../../harness/scenario/Dsl.ts"
import * as TruthTable from "../../harness/TruthTable.ts"
import { DiscordResponse, FieldError } from "../../src/errors/Cause.ts"
import type { PermissionFlag } from "../../src/errors/Missing.generated.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import { resolve } from "../../src/permissions/Resolver.ts"
import { MessageId } from "../../src/Snowflake.ts"
import { channel, everyone, guild, guildId, known, later, member, now, role, roleOverwrite, set, thread } from "../support/guild.ts"

/**
 * The matrix's judgment (DESIGN §5.10, §5.12): agreement per mismatch kind, the raw outcome and degradation
 * readback, and the truth table's canonical, order-independent bytes.
 */
const setup = new Setup({ channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }], removals: [], memberState: "normal", fixtures: [] })
const facts = { needed: ["ViewChannel", "SendMessages", "EmbedLinks"] as const, degradable: ["MentionEveryone"] as const }
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

  it("agrees on a setup Discord would not build", () => {
    expect(agreement(row({ preflight: "n/a", raw: Outcome.unsupported("kind-not-available"), oracle: "not-applicable" }), facts)).toBe("agree")
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

  it("records the required flags sorted, what is missing after the masks and before them, and the masks", () => {
    // no Send masks EmbedLinks (H-013): missing after the masks, present before them
    const record = TruthTable.resolverRecord("channel.send", resolution(known(channel("text", deny("SendMessages")))), ["ViewChannel", "SendMessages", "EmbedLinks"], ["ViewChannel", "SendMessages", "EmbedLinks"])
    expect(record).toEqual({
      required: ["EmbedLinks", "SendMessages", "ViewChannel"],
      missing: ["EmbedLinks", "SendMessages"],
      missingBeforeMasks: ["SendMessages"],
      masks: ["implicit-send"],
      level: "action"
    })
    // flags outside `required` are never listed, whatever the resolution lacks
    expect(TruthTable.resolverRecord("channel.send", resolution(known(channel("text")), set("ViewChannel")), ["ViewChannel"], ["ViewChannel"]).missing).toEqual([])
  })

  it("levels a blind channel, a missing View and a voice row without Connect as view", () => {
    const needed = ["ViewChannel", "SendMessages"] as const
    expect(TruthTable.levelOf("channel.send", resolution({ _tag: "Unseen" }), needed)).toBe("view")
    expect(TruthTable.levelOf("channel.send", resolution(known(channel("text", deny("ViewChannel")))), needed)).toBe("view")
    expect(TruthTable.levelOf("thread.send", resolution(known(thread("private-thread"), channel("text"))), ["ViewChannel", "SendMessagesInThreads"])).toBe("view")
    expect(TruthTable.levelOf("voice.send", resolution(known(channel("voice", deny("Connect")))), ["ViewChannel", "Connect", "SendMessages"])).toBe("view")
    // Connect only counts on a row that requires it
    expect(TruthTable.levelOf("channel.send", resolution(known(channel("text")), set("ViewChannel", "SendMessages")), needed)).toBe("none")
  })

  it("levels a missing error-mode flag, or a timeout that removes one, as action, and a missing degrade-mode flag as none", () => {
    expect(TruthTable.levelOf("channel.send", resolution(known(channel("text", deny("SendMessages")))), ["ViewChannel", "SendMessages"])).toBe("action")
    expect(TruthTable.levelOf("channel.send", resolution(known(channel("text")), all, later), ["ViewChannel", "SendMessages"])).toBe("action")
    expect(TruthTable.levelOf("channel.send", resolution(known(channel("text")), set("ViewChannel", "SendMessages")), ["ViewChannel", "SendMessages"])).toBe("none")
  })
})
