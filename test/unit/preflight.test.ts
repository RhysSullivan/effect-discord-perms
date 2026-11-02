import { describe, expect, it } from "vitest"
import { PreflightDecision } from "../../src/errors/Cause.ts"
import type { PermissionFlag } from "../../src/errors/Missing.generated.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import type { OpName } from "../../src/permissions/Operations.ts"
import { type Failure, sortFailures } from "../../src/permissions/Order.ts"
import { decide, requiredFlags, tagOf, toError } from "../../src/permissions/Preflight.ts"
import { type ChannelInput, resolve } from "../../src/permissions/Resolver.ts"
import type { PayloadRuleName } from "../../src/payload/PayloadRules.ts"
import { categoriesOf } from "../support/categories.ts"
import { channel, everyone, guild, guildId, known, later, member, memberOverwrite, now, role, roleOverwrite, set, thread } from "../support/guild.ts"

/**
 * Preflight (DESIGN §4.7, §3.2): every problem, most fundamental first; degrade-mode flags reported, never
 * failed; thread state only where the row lists it.
 */
const sendAll = set("ViewChannel", "SendMessages", "SendMessagesInThreads", "Connect", "EmbedLinks", "AttachFiles", "ReadMessageHistory", "SendTTSMessages", "SendPolls")
const tags = (op: OpName, target: ChannelInput, payload: ReadonlyArray<PayloadRuleName> = [], options: { readonly granted?: Flags.PermissionSet; readonly timedOutUntil?: string } = {}) => {
  const resolution = resolve({ guild: guild([role(everyone, options.granted ?? sendAll)]), channel: target, member: member([], options.timedOutUntil ?? null), now })
  const decision = decide(op, resolution, { payload })
  return { tags: decision.failures.map((failure) => tagOf(op, failure)), degraded: decision.degraded, required: decision.required }
}
const deny = (...flags: ReadonlyArray<PermissionFlag>) => [roleOverwrite(guildId, Flags.empty, set(...flags))]

describe("Preflight.decide", () => {
  it("passes a send that has every flag", () => {
    expect(tags("channel.send", known(channel("text")), ["embeds"])).toEqual({ tags: [], degraded: [], required: ["ViewChannel", "SendMessages", "EmbedLinks"] })
  })

  it("lists independent problems, not flags an implicit mask removed as a consequence", () => {
    // no Send masks EmbedLinks implicitly (H-013), but EmbedLinks is granted: granting Send fixes both
    expect(tags("channel.send", known(channel("text", deny("SendMessages"))), ["embeds"]).tags).toEqual(["MissingSendMessages"])
    // no View drops everything (H-012); only the flags actually denied are problems
    expect(tags("channel.send", known(channel("text", deny("ViewChannel"))), ["embeds"]).tags).toEqual(["MissingViewChannel"])
    expect(tags("channel.send", known(channel("text", deny("ViewChannel", "EmbedLinks", "SendMessages"))), ["embeds"]).tags).toEqual([
      "MissingViewChannel",
      "MissingSendMessages",
      "MissingEmbedLinks"
    ])
  })

  it("orders View, then Connect, then the access flag, then payload flags in rule order (§3.2)", () => {
    expect(tags("voice.send", known(channel("voice", deny("SendMessages", "Connect", "ViewChannel", "AttachFiles", "ReadMessageHistory"))), ["files", "reply"]).tags).toEqual([
      "MissingViewChannel",
      "MissingConnect",
      "MissingSendMessages",
      "MissingReadMessageHistory",
      "MissingAttachFiles"
    ])
  })

  it("builds the reply variant for ReadMessageHistory on send, so it is a payload error (D5)", () => {
    const resolution = resolve({ guild: guild([role(everyone, sendAll)]), channel: known(channel("text", deny("ReadMessageHistory"))), member: member([]), now })
    const [failure] = decide("channel.send", resolution, { payload: ["reply"] }).failures
    if (failure === undefined) throw new Error("expected a failure")
    const error = toError("channel.send", failure, new PreflightDecision({ route: "POST /channels/{channel.id}/messages", basis: "gateway-state" }))
    expect(error._tag).toBe("MissingReadMessageHistory")
    expect(categoriesOf(error)).toEqual(["payload", "permission"])
  })

  it("treats a blind channel as ViewChannel and nothing else", () => {
    expect(tags("thread.send", { _tag: "Unseen" }, ["embeds"]).tags).toEqual(["MissingViewChannel"])
    expect(tags("thread.send", known(thread("private-thread"), channel("text"))).tags).toEqual(["MissingViewChannel"])
    expect(tags("channel.send", known(channel("text", [], { obfuscated: true }))).tags).toEqual(["MissingViewChannel"])
  })

  it("adds CommunicationDisabled under a timeout, ranked above Send, but not for a View/ReadMessageHistory-only row (H-020)", () => {
    expect(tags("channel.send", known(channel("text")), [], { timedOutUntil: later }).tags).toEqual(["CommunicationDisabled"])
    expect(tags("channel.send", known(channel("text", deny("SendMessages"))), [], { timedOutUntil: later }).tags).toEqual(["CommunicationDisabled", "MissingSendMessages"])
    expect(tags("channel.send", known(channel("text", deny("ViewChannel"))), [], { timedOutUntil: later }).tags).toEqual(["MissingViewChannel", "CommunicationDisabled"])
    expect(tags("channel.pins", known(channel("text")), [], { timedOutUntil: later }).tags).toEqual([])
  })

  it("fails a send in a locked thread without ManageThreads (H-036), but not with it, and never for archived (H-035)", () => {
    const parent = channel("text")
    expect(tags("thread.send", known(thread("public-thread", { locked: true }), parent)).tags).toEqual(["ThreadLocked"])
    expect(tags("thread.send", known(thread("public-thread", { locked: true }), parent), [], { granted: Flags.union(sendAll, set("ManageThreads")) }).tags).toEqual([])
    expect(tags("thread.send", known(thread("public-thread", { archived: true }), parent)).tags).toEqual([])
    expect(tags("message.pin.thread", known(thread("public-thread", { archived: true }), parent), [], { granted: Flags.union(sendAll, set("PinMessages")) }).tags).toEqual(["ThreadArchived"])
  })

  it("reports a missing degrade-mode flag as degraded, never as a failure", () => {
    expect(tags("channel.send", known(channel("text")), ["mentionsEveryone"])).toEqual({ tags: [], degraded: ["MentionEveryone"], required: ["ViewChannel", "SendMessages", "MentionEveryone"] })
    const granted = Flags.union(sendAll, set("MentionEveryone"))
    expect(tags("channel.send", known(channel("text", [memberOverwrite("200000000000000001", Flags.empty)])), ["mentionsEveryone"], { granted }).degraded).toEqual([])
  })

  it("reads degraded from the effective set: a granted degrade-mode flag an implicit mask or the timeout removes is degraded", () => {
    const granted = Flags.union(sendAll, set("MentionEveryone"))
    // no Send in a text channel masks MentionEveryone (H-013): the send fails on Send, and MentionEveryone is degraded
    const noSend = tags("channel.send", known(channel("text", deny("SendMessages"))), ["mentionsEveryone"], { granted })
    expect(noSend).toMatchObject({ tags: ["MissingSendMessages"], degraded: ["MentionEveryone"] })
    // the timeout keeps only View and ReadMessageHistory (H-020)
    expect(tags("channel.send", known(channel("text")), ["mentionsEveryone"], { granted, timedOutUntil: later })).toMatchObject({ tags: ["CommunicationDisabled"], degraded: ["MentionEveryone"] })
  })

  it("lists the row's flags, then the payload's error-mode and degrade-mode flags", () => {
    expect(requiredFlags("thread.send", { payload: ["mentionsEveryone", "tts", "reply"] })).toEqual(["ViewChannel", "SendMessagesInThreads", "ReadMessageHistory", "SendTTSMessages", "MentionEveryone"])
  })
})

describe("Order", () => {
  it("sorts every tier of §3.2", () => {
    const failures: ReadonlyArray<Failure> = [
      { _tag: "MissingFlag", flag: "SendPolls" },
      { _tag: "ThreadLocked" },
      { _tag: "MissingFlag", flag: "SendMessagesInThreads" },
      { _tag: "CommunicationDisabled", until: later },
      { _tag: "MissingFlag", flag: "ReadMessageHistory" },
      { _tag: "MissingFlag", flag: "ViewChannel" }
    ]
    expect(sortFailures("thread.send", failures).map((failure) => (failure._tag === "MissingFlag" ? failure.flag : failure._tag))).toEqual([
      "ViewChannel",
      "CommunicationDisabled",
      "SendMessagesInThreads",
      "ThreadLocked",
      "ReadMessageHistory",
      "SendPolls"
    ])
  })

  it("puts ReadMessageHistory with the access flags for a reaction, and the row's own flags in row order", () => {
    const failures: ReadonlyArray<Failure> = [{ _tag: "MissingFlag", flag: "AddReactions" }, { _tag: "MissingFlag", flag: "ReadMessageHistory" }, { _tag: "MissingFlag", flag: "Connect" }]
    expect(sortFailures("message.react.voice", failures).map((failure) => (failure._tag === "MissingFlag" ? failure.flag : failure._tag))).toEqual(["Connect", "ReadMessageHistory", "AddReactions"])
  })
})
