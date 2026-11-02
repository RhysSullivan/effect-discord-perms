/**
 * What a scenario's operation is, as the library sees it (DESIGN §4.7, §5.10): the operation-table row it uses
 * for its channel kind, where its permissions are resolved (a channel, or the guild for member operations), and
 * the arguments preflight decides it with. Pure; the runner, the flip controls and the offline replay share it,
 * so the live step (a)/(b) and the replay compute the same thing from the same inputs.
 *
 * The arguments come in two parts. The static part follows from the scenario alone (the payload's features,
 * whether the reaction's emoji is already on the message, whether a post is tagged). The rest follows from the
 * subject's view of the guild when the step runs: whether the subject created the scenario thread (archiving,
 * H-045), and for member operations the hierarchy against the target and the assigned role (H-060..H-067).
 */
import type { PermissionFlag } from "../../src/errors/Missing.generated.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import type { OpName } from "../../src/permissions/Operations.ts"
import { type DecideArgs, degradableFlags, errorModeFlags, requiredFlags } from "../../src/permissions/Preflight.ts"
import { basePermissions, type GuildInput, type MemberInput, type Resolution, roleBelow, targetBelow } from "../../src/permissions/Resolver.ts"
import type { PayloadRuleName } from "../../src/payload/PayloadRules.ts"
import type { RoleId } from "../../src/Snowflake.ts"
import type { LabChannel, Operation, Scenario, SendPayload } from "./Dsl.ts"

/** Where the operation's permissions are resolved. */
export type Scope = "channel" | "guild"

/** The scenario's operation, before the step runs. */
export interface StaticFacts {
  readonly op: OpName
  readonly scope: Scope
  /** The arguments that follow from the scenario alone. */
  readonly args: DecideArgs
  /** Member operations act on the target, whose rank preflight checks. */
  readonly onTarget: boolean
  /** Role operations: the role assigned or removed. */
  readonly assignsRole: boolean
}

/** The operation with its arguments complete, and the flags they imply (§4.7). */
export interface Facts extends StaticFacts {
  /** The row's flags (as this request needs them), then the payload's error-mode and degradable flags. */
  readonly required: ReadonlyArray<PermissionFlag>
  /** The flags whose absence fails the request. */
  readonly needed: ReadonlyArray<PermissionFlag>
  /** The flags whose absence only degrades it (payload degrade-mode flags, a read's `degrades`). */
  readonly degradable: ReadonlyArray<PermissionFlag>
}

const isThreadChannel = (channel: LabChannel): boolean => channel === "forum-post" || channel === "public-thread" || channel === "private-thread" || channel === "announcement-thread"
const isVoiceChannel = (channel: LabChannel): boolean => channel === "voice" || channel === "stage"

/** The send row for a channel kind (§2.4 `SendOpByKind`); forum and media channels take posts instead. */
export const sendOpOf = (channel: LabChannel): OpName =>
  isThreadChannel(channel) ? "thread.send" : isVoiceChannel(channel) ? "voice.send" : channel === "forum" || channel === "media" ? "forum.createPost" : "channel.send"

/** The payload features (`PayloadRules`) a send payload variant carries. A guild sticker has none (H-138). */
export const featuresOf = (payload: SendPayload): ReadonlyArray<PayloadRuleName> => {
  switch (payload) {
    case "plain":
    case "guild-sticker":
      return []
    case "embed":
      return ["embeds"]
    case "file":
      return ["files"]
    case "reply":
      return ["reply"]
    case "tts":
      return ["tts"]
    case "poll":
      return ["poll"]
    case "mention-everyone":
      return ["mentionsEveryone"]
  }
}

/** A row for the channel kind: the thread variant, the voice variant (Connect), or the channel one. */
const byKind = (channel: LabChannel, rows: { readonly channel: OpName; readonly thread: OpName; readonly voice: OpName }): OpName =>
  isThreadChannel(channel) ? rows.thread : isVoiceChannel(channel) ? rows.voice : rows.channel

/** The operation-table row an operation uses in a channel kind. */
export const opOf = (operation: Operation, channel: LabChannel): OpName => {
  switch (operation._tag) {
    case "send":
      return sendOpOf(channel)
    case "createPost":
      return "forum.createPost"
    case "message":
      switch (operation.action) {
        case "edit-own":
          return byKind(channel, { channel: "message.edit.channel", thread: "message.edit.thread", voice: "message.edit.voice" })
        case "delete-own":
          return byKind(channel, { channel: "message.deleteOwn", thread: "message.deleteOwn.thread", voice: "message.deleteOwn.voice" })
        case "delete-foreign":
          return byKind(channel, { channel: "message.deleteForeign", thread: "message.deleteForeign.thread", voice: "message.deleteForeign.voice" })
        case "crosspost-own":
          return "message.crosspostOwn"
        case "crosspost-foreign":
          return "message.crosspostForeign"
        case "bulk-delete":
          return byKind(channel, { channel: "channel.bulkDelete", thread: "thread.bulkDelete", voice: "voice.bulkDelete" })
      }
    case "react":
      return byKind(channel, { channel: "message.react.channel", thread: "message.react.thread", voice: "message.react.voice" })
    case "pins":
      switch (operation.action) {
        case "pin":
          if (isVoiceChannel(channel)) throw new Error("Facts: voice and stage text chat has no pins (400 50019, M4 live)")
          return isThreadChannel(channel) ? "message.pin.thread" : "message.pin.channel"
        case "unpin":
          if (isVoiceChannel(channel)) throw new Error("Facts: voice and stage text chat has no pins (400 50019, M4 live)")
          return isThreadChannel(channel) ? "message.unpin.thread" : "message.unpin.channel"
        case "list":
          return isVoiceChannel(channel) ? "voice.pins" : "channel.pins"
      }
    case "createThread":
      return operation.visibility === "public" ? "channel.createThread.public" : "channel.createThread.private"
    case "thread":
      switch (operation.action) {
        case "join":
          return "thread.join"
        case "leave":
          return "thread.leave"
        case "add-member":
          return "thread.addMember"
        case "archive":
          return "thread.setArchived"
        case "unarchive":
          return "thread.unarchive"
        case "lock":
          return "thread.setLocked"
        case "delete":
          return "thread.delete"
      }
    case "channelEdit":
      return byKind(channel, { channel: "channel.edit", thread: "thread.edit", voice: "voice.edit" })
    case "member":
      switch (operation.action) {
        case "add-role":
          return "member.addRole"
        case "remove-role":
          return "member.removeRole"
        case "nickname":
          return "member.setNickname"
        case "timeout":
          return "member.timeout"
        case "kick":
          return "member.kick"
        case "ban":
          return "member.ban"
      }
  }
}

/** The facts that follow from the scenario alone. */
export const staticFactsOf = (scenario: Pick<Scenario, "setup" | "operation">): StaticFacts => {
  const { operation, setup } = scenario
  const op = opOf(operation, setup.channel)
  const member = operation._tag === "member"
  const args: DecideArgs = {
    payload: operation._tag === "send" ? featuresOf(operation.payload) : [],
    ...(operation._tag === "react" ? { reaction: operation.emoji === "unicode-existing" ? ("existing" as const) : ("new" as const) } : {}),
    ...(operation._tag === "createPost" ? { tagged: operation.tagged } : {})
  }
  return {
    op,
    scope: member ? "guild" : "channel",
    args,
    onTarget: member,
    assignsRole: member && (operation.action === "add-role" || operation.action === "remove-role")
  }
}

/** What the subject knows of the target and the assigned role when the step runs (member operations). */
export interface Hierarchy {
  readonly guild: GuildInput
  readonly bot: MemberInput
  readonly target: MemberInput
  /** The role assigned or removed, for role operations. */
  readonly role: RoleId | undefined
}

/**
 * The facts with the arguments complete: the static ones, whether the subject created the scenario thread (from
 * the resolution's thread facts), and for member operations the hierarchy. A role operation whose role the
 * guild state lacks is a defect: the lab provisions every role.
 */
export const complete = (facts: StaticFacts, resolution: Resolution, hierarchy: Hierarchy | undefined): Facts => {
  const creator = resolution.thread?.creatorIsMember === true
  let args: DecideArgs = { ...facts.args, ...(facts.op === "thread.setArchived" || facts.op === "thread.setLocked" || facts.op === "thread.delete" ? { creator } : {}) }
  if (facts.onTarget) {
    if (hierarchy === undefined) throw new Error(`Facts: ${facts.op} needs the target's hierarchy`)
    const administrator = Flags.has(basePermissions(hierarchy.guild, hierarchy.target), "Administrator") || hierarchy.target.userId === hierarchy.guild.ownerId
    args = { ...args, target: { below: targetBelow(hierarchy.guild, hierarchy.bot, hierarchy.target), administrator } }
    if (facts.assignsRole) {
      const role = hierarchy.role === undefined ? undefined : hierarchy.guild.roles.get(hierarchy.role)
      if (role === undefined) throw new Error(`Facts: ${facts.op} needs its role in the guild state`)
      args = { ...args, role: { below: roleBelow(hierarchy.guild, hierarchy.bot, role), managed: role.managed } }
    }
  }
  return { ...facts, args, required: requiredFlags(facts.op, args), needed: errorModeFlags(facts.op, args), degradable: degradableFlags(facts.op, args) }
}
