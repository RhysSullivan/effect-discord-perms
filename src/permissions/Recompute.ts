/**
 * The recompute (DESIGN §4.9, D16): what a permission-like refusal means, decided by our resolver over fresh
 * state, never guessed.
 *
 * Discord's 50013 and 50001 never name the missing permission (H-081), and the dedicated codes 160002 (a reply
 * without ReadMessageHistory), 160005 (a locked thread) and 50083 (an archived thread) may be answered where our
 * order (§3.2) puts another failure first. So for these codes the operation's error is decided here:
 *
 * 1. refresh the state the operation was decided on: the channel (and a thread's parent), the bot's member, the
 *    owner and the roles (`GuildState.refresh`), or without a channel for a guild-level operation
 *    (`GuildState.refreshGuild`);
 * 2. complete the request's arguments from it (`Preflight.stateArgs`): the thread's creator, and for a member
 *    operation the target member, read again, and the role; for a reaction whose emoji state was unknown, the
 *    message is read for its reactions (conditional AddReactions, §4.7);
 * 3. resolve and run `Preflight.decide`; the first failure in §3.2 order is the error, with Discord's answer as
 *    its cause, `attributedBy: "recompute"`. A missing flag the handle's `require` checked is
 *    `PermissionRevokedSinceCheck` (D8);
 * 4. nothing found (the state was stale, or Discord knows something the state does not): the code's own error,
 *    which `ErrorMap.mapResponse` built with `attributedBy: "code"`: `PermissionDeniedUnattributed` for 50013 and
 *    50001, the dedicated code's tag otherwise.
 *
 * `decide` only checks the flags the operation and its payload require, so a missing flag outside them is never
 * attributed. State the refreshed snapshot still lacks (the guild was deleted meanwhile) also attributes
 * nothing, and is logged.
 */
import type { DiscordRestService } from "dfx/DiscordREST"
import { Clock, type Duration, Effect, Schema } from "effect"
import { DiscordResponse } from "../errors/Cause.ts"
import type { PermissionFlag } from "../errors/Missing.generated.ts"
import type { PermissionRevokedSinceCheck } from "../errors/Permission.ts"
import type { Transient } from "../errors/Transient.ts"
import type { FallbackError } from "../rest/ErrorMap.ts"
import { send } from "../rest/Request.ts"
import * as Schemas from "../rest/Schemas.ts"
import type { ChannelId, EmojiId, GuildId, MessageId, RoleId, UserId } from "../Snowflake.ts"
import type * as GuildState from "../state/GuildState.ts"
import type { OpName } from "./Operations.ts"
import { type DecideArgs, decide, type Hierarchy, type PreflightError, stateArgs, toHandleError } from "./Preflight.ts"
import { type FromSnapshot, guildInputFromSnapshot, inputFromSnapshot, type Resolution, resolve } from "./Resolver.ts"

/** Where an operation's permissions are resolved: in a channel, or at guild level (the member operations). */
export type Scope = { readonly _tag: "Channel"; readonly channelId: ChannelId } | { readonly _tag: "Guild" }

/** A reaction's emoji, as the message's reactions name it. */
export type EmojiKey = { readonly _tag: "Unicode"; readonly name: string } | { readonly _tag: "Custom"; readonly id: EmojiId }

/** What the recompute reads, beyond the refresh, to complete the request's arguments. */
export type Completion =
  /** Nothing: the arguments as given, with the thread's creator from the refreshed state. */
  | { readonly _tag: "Static" }
  /** A member operation: the target member is read again, and `role` (a role operation's) found in the refreshed roles. */
  | { readonly _tag: "Member"; readonly targetUserId: UserId; readonly role: RoleId | undefined }
  /** A reaction whose emoji state was unknown (`args.reaction` "unknown"): the message is read for its reactions. */
  | { readonly _tag: "Reaction"; readonly channelId: ChannelId; readonly messageId: MessageId; readonly emoji: EmojiKey }

/** The request as the recompute needs it: the "handle" of §4.9. */
export interface Target {
  readonly op: OpName
  readonly guildId: GuildId
  readonly scope: Scope
  /** The flags `Permissions.require` checked on the handle (D8); empty without it. */
  readonly granted: ReadonlyArray<PermissionFlag>
  /** The request's static arguments (the payload's features, a post's tag, a known reaction state). */
  readonly args: DecideArgs
  readonly completion: Completion
}

/** What the recompute can attribute a refusal to. */
export type Attributed = PreflightError | PermissionRevokedSinceCheck | FallbackError

/** What the recompute reads with. */
export interface Context {
  /** The bot's own dfx client (the target member and message reads). */
  readonly rest: DiscordRestService
  readonly guildState: GuildState.Interface
  /** Bounds each read, as for every call (§4.10). */
  readonly deadline: Duration.Duration
}

const memberRoute = "/guilds/{guild.id}/members/{user.id}"
const messageRoute = "/channels/{channel.id}/messages/{message.id}"

/** Codes that mean the object is gone or hidden: the completion learns nothing from them. */
const memberGone: ReadonlySet<number> = new Set([10007])
const messageUnreadable: ReadonlySet<number> = new Set([10003, 10008, 50001, 50013])

const decodeOrDie =
  <A>(schema: Schema.Decoder<A>, route: string) =>
  (body: unknown): Effect.Effect<A> =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError((error) => new Error(`${route}: a 2xx body did not decode: ${error.message}`)),
      Effect.orDie
    )

/** The target member, read again, as a resolver member; `undefined` when it has left (10007). */
const readTarget = (context: Context, guildId: GuildId, userId: UserId): Effect.Effect<Hierarchy["target"] | undefined, Transient> =>
  send(memberRoute, "GET", context.rest.getGuildMember(guildId, userId), context.deadline).pipe(
    Effect.flatMap((answer) => {
      if (answer._tag === "Rejected") {
        return memberGone.has(answer.response.code)
          ? Effect.succeed(undefined)
          : Effect.die(new Error(`recompute: unmapped answer to ${memberRoute}: ${answer.response.status} ${answer.response.code}`))
      }
      return decodeOrDie(Schemas.Member, memberRoute)(answer.body).pipe(
        Effect.map((member) => ({ userId: member.user.id, roleIds: member.roles, timedOutUntil: member.communication_disabled_until ?? null }))
      )
    })
  )

const sameEmoji = (key: EmojiKey, emoji: Schemas.Reaction["emoji"]): boolean => (key._tag === "Custom" ? emoji.id === key.id : emoji.id === null && emoji.name === key.name)

/** Whether the emoji is on the message already (§4.7); `unknown` when the message cannot be read. */
const readReaction = (context: Context, completion: Extract<Completion, { readonly _tag: "Reaction" }>): Effect.Effect<"new" | "existing" | "unknown", Transient> =>
  send(messageRoute, "GET", context.rest.getMessage(completion.channelId, completion.messageId), context.deadline).pipe(
    Effect.flatMap((answer) => {
      if (answer._tag === "Rejected") {
        return messageUnreadable.has(answer.response.code)
          ? Effect.succeed("unknown" as const)
          : Effect.die(new Error(`recompute: unmapped answer to ${messageRoute}: ${answer.response.status} ${answer.response.code}`))
      }
      return decodeOrDie(Schemas.Message, messageRoute)(answer.body).pipe(
        Effect.map((message) => ((message.reactions ?? []).some((reaction) => reaction.count > 0 && sameEmoji(completion.emoji, reaction.emoji)) ? "existing" : "new"))
      )
    })
  )

/** The request's arguments, completed from the refreshed state and resolution. */
const complete = (context: Context, target: Target, fromState: Extract<FromSnapshot, { readonly _tag: "Ready" }>, resolution: Resolution): Effect.Effect<DecideArgs, Transient> =>
  Effect.gen(function* () {
    const completion = target.completion
    switch (completion._tag) {
      case "Static":
        return stateArgs(target.op, target.args, resolution, undefined)
      case "Reaction": {
        const reaction = target.args.reaction === "unknown" || target.args.reaction === undefined ? yield* readReaction(context, completion) : target.args.reaction
        return stateArgs(target.op, { ...target.args, reaction }, resolution, undefined)
      }
      case "Member": {
        const member = yield* readTarget(context, target.guildId, completion.targetUserId)
        if (member === undefined) return stateArgs(target.op, target.args, resolution, undefined)
        const hierarchy: Hierarchy = { guild: fromState.input.guild, bot: fromState.input.member, target: member, role: completion.role }
        return stateArgs(target.op, target.args, resolution, hierarchy)
      }
    }
  })

/**
 * Attributes Discord's refusal `response` to `target` (see the module comment). `fallback` is the code's own error
 * (`ErrorMap.mapResponse`), returned when the fresh state shows nothing wrong. Fails only when a read gets no answer
 * (`Transient`); an unexpected answer to a read is a defect.
 */
export const attribute = (context: Context, target: Target, response: DiscordResponse, fallback: FallbackError): Effect.Effect<Attributed, Transient> =>
  Effect.gen(function* () {
    const scope = target.scope
    if (scope._tag === "Channel") yield* context.guildState.refresh(target.guildId, scope.channelId)
    else yield* context.guildState.refreshGuild(target.guildId)
    const snapshot = yield* context.guildState.snapshot
    const now = yield* Clock.currentTimeMillis
    const fromState = scope._tag === "Channel" ? inputFromSnapshot(snapshot, target.guildId, scope.channelId, now) : guildInputFromSnapshot(snapshot, target.guildId, now)
    if (fromState._tag === "NeedsRefresh") {
      yield* Effect.logWarning(`recompute: ${target.op}: the refreshed state still lacks what the resolver needs (${fromState.reason}); not attributed`)
      return fallback
    }
    const resolution = resolve(fromState.input)
    const args = yield* complete(context, target, fromState, resolution)
    const [first] = decide(target.op, resolution, args).failures
    if (first === undefined) return fallback
    const cause = new DiscordResponse({ ...response, attributedBy: "recompute" })
    return toHandleError(target.op, first, target.granted, cause)
  })
