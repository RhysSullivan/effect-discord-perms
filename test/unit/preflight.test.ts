import { describe, expect, it } from "vitest"
import { PreflightDecision } from "../../src/errors/Cause.ts"
import type { PermissionFlag } from "../../src/errors/Missing.generated.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import type { OpName } from "../../src/permissions/Operations.ts"
import { type Failure, sortFailures } from "../../src/permissions/Order.ts"
import { decide, requiredFlags, stateArgs, tagOf, toError } from "../../src/permissions/Preflight.ts"
import { type ChannelInput, resolve } from "../../src/permissions/Resolver.ts"
import type { PayloadRuleName } from "../../src/payload/PayloadRules.ts"
import { categoriesOf } from "../support/categories.ts"
import { UserId } from "../../src/Snowflake.ts"
import { channel, everyone, guild, guildId, known, later, member, memberOverwrite, now, otherId, ownerId, role, roleA, roleB, roleC, roleOverwrite, set, thread } from "../support/guild.ts"

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
      "ReadMessageHistory",
      "SendPolls",
      "ThreadLocked"
    ])
  })

  it("ranks a locked thread after the payload's flags, as Discord checks them (M4 live: `send/targeted/order-locked-embed` answered EmbedLinks' 50013, not the lock's 50001)", () => {
    const failures: ReadonlyArray<Failure> = [{ _tag: "ThreadLocked" }, { _tag: "MissingFlag", flag: "EmbedLinks" }, { _tag: "ThreadArchived" }]
    expect(sortFailures("thread.send", failures).map((failure) => (failure._tag === "MissingFlag" ? failure.flag : failure._tag))).toEqual(["ThreadArchived", "EmbedLinks", "ThreadLocked"])
  })

  it("ranks a row's viewLevel flag with View, above the timeout, and the row's own flags in row order (M4 live)", () => {
    const failures: ReadonlyArray<Failure> = [
      { _tag: "MissingFlag", flag: "PinMessages" },
      { _tag: "CommunicationDisabled", until: later },
      { _tag: "MissingFlag", flag: "ReadMessageHistory" },
      { _tag: "MissingFlag", flag: "ViewChannel" }
    ]
    expect(sortFailures("message.pin.thread", failures).map((failure) => (failure._tag === "MissingFlag" ? failure.flag : failure._tag))).toEqual([
      "ViewChannel",
      "ReadMessageHistory",
      "CommunicationDisabled",
      "PinMessages"
    ])
    // outside a row's viewLevel, ReadMessageHistory is a payload flag (a reply), ranked last
    expect(sortFailures("channel.send", [{ _tag: "MissingFlag", flag: "ReadMessageHistory" }, { _tag: "CommunicationDisabled", until: later }]).map((failure) => (failure._tag === "MissingFlag" ? failure.flag : failure._tag))).toEqual([
      "CommunicationDisabled",
      "ReadMessageHistory"
    ])
    // a reaction's own flag after Connect; ReadMessageHistory is not a reaction's flag (M4 live, H-144)
    expect(sortFailures("message.react.voice", [{ _tag: "MissingFlag", flag: "AddReactions" }, { _tag: "MissingFlag", flag: "Connect" }]).map((failure) => (failure._tag === "MissingFlag" ? failure.flag : failure._tag))).toEqual(["Connect", "AddReactions"])
  })
})

describe("Preflight.decide for the M4 operations", () => {
  const granted = (...flags: ReadonlyArray<PermissionFlag>) => guild([role(everyone, set(...flags))])
  const at = (op: OpName, target: ChannelInput, flags: ReadonlyArray<PermissionFlag>, args: Omit<Parameters<typeof decide>[2], "payload"> = {}, timedOutUntil: string | null = null) =>
    decide(op, resolve({ guild: granted(...flags), channel: target, member: member([], timedOutUntil), now }), { payload: [], ...args }).failures.map((failure) => tagOf(op, failure))

  it("needs AddReactions only for an emoji nobody reacted with (H-144)", () => {
    expect(at("message.react.channel", known(channel("text")), ["ViewChannel"], { reaction: "new" })).toEqual(["MissingAddReactions"])
    expect(at("message.react.channel", known(channel("text")), ["ViewChannel"], { reaction: "existing" })).toEqual([])
    expect(at("message.react.channel", known(channel("text")), ["ViewChannel"], { reaction: "unknown" })).toEqual([])
    expect(requiredFlags("message.react.channel", { payload: [], reaction: "existing" })).toEqual(["ViewChannel"])
  })

  it("exempts a thread's creator from ManageThreads to archive, lock or delete it (H-045 refuted for lock and delete, M4 live)", () => {
    const own = known(thread("public-thread", { ownerId: UserId.make("200000000000000001") }), channel("text"), true)
    const flags: ReadonlyArray<PermissionFlag> = ["ViewChannel", "SendMessagesInThreads"]
    expect(at("thread.setArchived", own, flags, { creator: true })).toEqual([])
    expect(at("thread.setArchived", own, flags, { creator: false })).toEqual(["MissingManageThreads"])
    expect(at("thread.delete", own, flags, { creator: true })).toEqual([])
    expect(at("thread.setLocked", own, flags, { creator: true })).toEqual([])
    expect(at("thread.setLocked", own, flags, { creator: false })).toEqual(["MissingManageThreads"])
    // unarchiving needs no ManageThreads at all, only SendMessagesInThreads, and fails on a locked thread
    expect(at("thread.unarchive", own, ["ViewChannel"])).toEqual(["MissingSendMessagesInThreads"])
    expect(at("thread.unarchive", known(thread("public-thread", { locked: true }), channel("text")), flags)).toEqual(["ThreadLocked"])
  })

  it("lets a row that needs no View run on a channel the bot cannot see: leaving a thread (M4 live)", () => {
    expect(at("thread.leave", { _tag: "Unseen" }, [])).toEqual([])
    expect(at("thread.join", { _tag: "Unseen" }, ["ViewChannel"])).toEqual(["MissingViewChannel"])
  })

  it("checks the hierarchy for member operations: the target's rank, an Administrator target of a timeout, the role's rank and management", () => {
    const scope: ChannelInput = { _tag: "Guild" }
    expect(at("member.kick", scope, ["KickMembers"], { target: { below: false, administrator: false } })).toEqual(["TargetAboveInHierarchy"])
    expect(at("member.kick", scope, ["KickMembers"], { target: { below: true, administrator: true } })).toEqual([])
    expect(at("member.timeout", scope, ["ModerateMembers"], { target: { below: false, administrator: true } })).toEqual(["TargetAboveInHierarchy", "TargetIsAdministrator"])
    expect(at("member.addRole", scope, ["ManageRoles"], { role: { below: false, managed: true } })).toEqual(["RoleAboveInHierarchy", "RoleIsManaged"])
    expect(at("member.addRole", scope, [], { role: { below: true, managed: false } })).toEqual(["MissingManageRoles"])
    // at guild level the timeout removes ManageRoles too
    expect(at("member.addRole", scope, ["ManageRoles"], { role: { below: true, managed: false } }, later)).toEqual(["CommunicationDisabled"])
  })

  it("requires a tag on a post in a forum with REQUIRE_TAG (H-044), and blocks an own edit under a timeout although View survives it", () => {
    const forum = known(channel("forum", [], { requireTag: true }))
    expect(at("forum.createPost", forum, ["ViewChannel", "SendMessages"], { tagged: false })).toEqual(["TagRequired"])
    expect(at("forum.createPost", forum, ["ViewChannel", "SendMessages"], { tagged: true })).toEqual([])
    expect(at("forum.createPost", known(channel("forum")), ["ViewChannel", "SendMessages"], { tagged: false })).toEqual([])
    expect(at("message.edit.channel", known(channel("text")), ["ViewChannel"], {}, later)).toEqual(["CommunicationDisabled"])
    expect(at("message.deleteOwn", known(channel("text")), ["ViewChannel"], {}, later)).toEqual([])
    // the timeout blocks a reaction even with an emoji already there, which needs only View (M4 live, H-024)
    expect(at("message.react.channel", known(channel("text")), ["ViewChannel"], { reaction: "existing" }, later)).toEqual(["CommunicationDisabled"])
  })

  it("reports a read's degradation: the pins list without ReadMessageHistory (H-107)", () => {
    const resolution = resolve({ guild: granted("ViewChannel"), channel: known(channel("text")), member: member([]), now })
    expect(decide("channel.pins", resolution, { payload: [] })).toMatchObject({ failures: [], degraded: ["ReadMessageHistory"], required: ["ViewChannel", "ReadMessageHistory"] })
  })
})

describe("Preflight.stateArgs (the arguments completed from the state, shared by step (a) and the recompute)", () => {
  const roles = [role(everyone, set("ViewChannel")), role(roleA, set("ModerateMembers"), 5), role(roleB, set("ManageNicknames"), 1)]
  const resolution = resolve({ guild: guild(roles), channel: { _tag: "Guild" }, member: member([roleA]), now })
  const hierarchyFor = (target: ReturnType<typeof member>) => ({ guild: guild(roles), bot: member([roleA]), target, role: undefined })

  it("marks the guild's owner as an Administrator target, whatever its roles (H-067)", () => {
    const owner = member([], null, ownerId)
    expect(stateArgs("member.timeout", { payload: [] }, resolution, hierarchyFor(owner)).target).toEqual({ below: false, administrator: true })
  })

  it("marks a target with an Administrator role as one, and a plain member below the bot as neither", () => {
    const admin = guild([...roles, role(roleC, set("Administrator"), 0)])
    const adminTarget = member([roleC], null, otherId)
    expect(stateArgs("member.timeout", { payload: [] }, resolution, { guild: admin, bot: member([roleA]), target: adminTarget, role: undefined }).target).toEqual({ below: true, administrator: true })
    expect(stateArgs("member.timeout", { payload: [] }, resolution, hierarchyFor(member([roleB], null, otherId))).target).toEqual({ below: true, administrator: false })
  })
})
