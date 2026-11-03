/**
 * Members (DESIGN §2.6, `[sd:src/members.ts]`): a guild member and the operations the bot can run on it. Every
 * union is the operation table's row (`OpErrors<never>[Op]`) plus the argument-derived limit tags.
 *
 * - `addRole` and `removeRole` fail with `RoleAboveInHierarchy` when the role is not below the bot's highest role
 *   (H-060); the target's rank does not matter (H-061, M4 live), so they do not list `TargetAboveInHierarchy`.
 * - `setNickname`, `timeout`, `kick` and `ban` list `TargetAboveInHierarchy` (H-064, H-066); `timeout` also
 *   `TargetIsAdministrator` (H-021, H-067, M4 live).
 * - A non-literal nickname may be too long (`setNickname(null)` clears it); a timeout date may be more than 28 days
 *   ahead (`timeout(null)` lifts it, H-025).
 *
 * Member operations resolve at guild level (no channel's overwrites apply), and preflight reads the target's rank
 * from the handle, which `Members.get` read from Discord; the recompute reads the target again (§4.9).
 */
import { Clock, Effect, Schema } from "effect"
import { BotRuntime } from "../bot/Bot.ts"
import { perform, type Runtime, type WideError } from "../channels/Ops.ts"
import { PreflightDecision } from "../errors/Cause.ts"
import type { NicknameTooLong, TimeoutTooLong } from "../errors/Payload.ts"
import { UnknownMember } from "../errors/State.ts"
import type { Transient } from "../errors/Transient.ts"
import type { OpErrors, OpName } from "../permissions/Operations.ts"
import type * as Recompute from "../permissions/Recompute.ts"
import type { MemberInput } from "../permissions/Resolver.ts"
import * as Limits from "../payload/Limits.ts"
import type { MayExceed } from "../payload/PayloadRules.ts"
import type * as DiscordApi from "../rest/DiscordApi.ts"
import type { LimitFacts } from "../rest/ErrorMap.ts"
import * as Schemas from "../rest/Schemas.ts"
import type { GuildId, RoleId, UserId } from "../Snowflake.ts"

/** A guild member. */
export interface GuildMember {
  readonly guildId: GuildId
  readonly userId: UserId
  /** The member's roles when the handle was read (preflight's view of its rank). */
  readonly roleIds: ReadonlyArray<RoleId>
  /** `PUT /guilds/{guild.id}/members/{user.id}/roles/{role.id}`. */
  readonly addRole: (role: RoleId) => Effect.Effect<void, OpErrors<never>["member.addRole"]>
  /** `DELETE /guilds/{guild.id}/members/{user.id}/roles/{role.id}`. */
  readonly removeRole: (role: RoleId) => Effect.Effect<void, OpErrors<never>["member.removeRole"]>
  /** `PATCH /guilds/{guild.id}/members/{user.id}` with `nick`; `null` clears it. */
  readonly setNickname: <const N extends string | null>(nick: N) => Effect.Effect<void, OpErrors<never>["member.setNickname"] | (MayExceed<N> extends true ? NicknameTooLong : never)>
  /** `PATCH /guilds/{guild.id}/members/{user.id}` with `communication_disabled_until`; `null` lifts the timeout. */
  readonly timeout: <const U extends Date | null>(until: U) => Effect.Effect<void, OpErrors<never>["member.timeout"] | (MayExceed<U> extends true ? TimeoutTooLong : never)>
  /** `DELETE /guilds/{guild.id}/members/{user.id}`. */
  readonly kick: () => Effect.Effect<void, OpErrors<never>["member.kick"]>
  /** `PUT /guilds/{guild.id}/bans/{user.id}`; `deleteMessageSeconds` defaults to 0. */
  readonly ban: (options?: { readonly deleteMessageSeconds?: number }) => Effect.Effect<void, OpErrors<never>["member.ban"]>
}

const memberRoute = "/guilds/{guild.id}/members/{user.id}"
const roleRoute = "/guilds/{guild.id}/members/{user.id}/roles/{role.id}"

const localCause = (route: string): PreflightDecision => new PreflightDecision({ route, basis: "payload-check" })

/** The handle of a member object read over REST (internal: `Members.get` and the harness build it). */
export const memberHandle = (runtime: Runtime, guildId: GuildId, member: Schemas.Member): GuildMember => {
  const userId = member.user.id
  const input: MemberInput = { userId, roleIds: member.roles, timedOutUntil: member.communication_disabled_until ?? null }
  const target = (op: OpName, role: RoleId | undefined): Recompute.Target => ({
    op,
    guildId,
    scope: { _tag: "Guild" },
    granted: [],
    args: { payload: [] },
    completion: { _tag: "Member", targetUserId: userId, role }
  })
  const run = <A>(
    span: string,
    op: OpName,
    role: RoleId | undefined,
    route: DiscordApi.Route,
    call: DiscordApi.Request<A>["call"],
    response: Schema.Decoder<A>,
    local: ReadonlyArray<Limits.LocalFailure>,
    limits: LimitFacts
  ): Effect.Effect<void, WideError> =>
    perform(runtime, { span, kind: "guild", target: target(op, role), targetMember: input, local, request: { target: target(op, role), route, call, response, limits } }).pipe(Effect.asVoid)

  function addRole(role: RoleId): ReturnType<GuildMember["addRole"]>
  function addRole(role: RoleId): Effect.Effect<void, WideError> {
    return run("discord.member.addRole", "member.addRole", role, { method: "PUT", template: roleRoute }, (rest) => rest.addGuildMemberRole(guildId, userId, role), Schema.Void, [], {})
  }
  function removeRole(role: RoleId): ReturnType<GuildMember["removeRole"]>
  function removeRole(role: RoleId): Effect.Effect<void, WideError> {
    return run("discord.member.removeRole", "member.removeRole", role, { method: "DELETE", template: roleRoute }, (rest) => rest.deleteGuildMemberRole(guildId, userId, role), Schema.Void, [], {})
  }
  function setNickname<const N extends string | null>(nick: N): Effect.Effect<void, OpErrors<never>["member.setNickname"] | (MayExceed<N> extends true ? NicknameTooLong : never)>
  function setNickname(nick: string | null): Effect.Effect<void, WideError> {
    const limits: LimitFacts = nick === null ? {} : { nick: { length: Limits.lengthOf(nick), limit: Limits.Limits.nickname } }
    return run(
      "discord.member.setNickname",
      "member.setNickname",
      undefined,
      { method: "PATCH", template: memberRoute },
      (rest) => rest.updateGuildMember(guildId, userId, { nick }),
      Schemas.Member,
      Limits.checkNickname(nick, localCause(memberRoute)),
      limits
    )
  }
  function timeout<const U extends Date | null>(until: U): Effect.Effect<void, OpErrors<never>["member.timeout"] | (MayExceed<U> extends true ? TimeoutTooLong : never)>
  function timeout(until: Date | null): Effect.Effect<void, WideError> {
    return Effect.flatMap(Clock.currentTimeMillis, (now) =>
      run(
        "discord.member.timeout",
        "member.timeout",
        undefined,
        { method: "PATCH", template: memberRoute },
        (rest) => rest.updateGuildMember(guildId, userId, { communication_disabled_until: until === null ? null : until.toISOString() }),
        Schemas.Member,
        Limits.checkTimeout(until, now, localCause(memberRoute)),
        until === null ? {} : { timeout: true }
      )
    )
  }
  function kick(): ReturnType<GuildMember["kick"]>
  function kick(): Effect.Effect<void, WideError> {
    return run("discord.member.kick", "member.kick", undefined, { method: "DELETE", template: memberRoute }, (rest) => rest.deleteGuildMember(guildId, userId), Schema.Void, [], {})
  }
  function ban(options?: { readonly deleteMessageSeconds?: number }): ReturnType<GuildMember["ban"]>
  function ban(options?: { readonly deleteMessageSeconds?: number }): Effect.Effect<void, WideError> {
    return run(
      "discord.member.ban",
      "member.ban",
      undefined,
      { method: "PUT", template: "/guilds/{guild.id}/bans/{user.id}" },
      (rest) => rest.banUserFromGuild(guildId, userId, { delete_message_seconds: options?.deleteMessageSeconds ?? 0 }),
      Schema.Void,
      [],
      {}
    )
  }
  return { guildId, userId, roleIds: member.roles, addRole, removeRole, setNickname, timeout, kick, ban }
}

/** Looking members up. */
export const Members = {
  /** `GET /guilds/{guild.id}/members/{user.id}`: the member's handle, or `UnknownMember` when it is not in the guild (10007). */
  get: (guildId: GuildId, userId: UserId): Effect.Effect<GuildMember, UnknownMember | Transient, BotRuntime> =>
    Effect.gen(function* () {
      const runtime = yield* BotRuntime
      const member = yield* runtime.api.read({
        route: { method: "GET", template: memberRoute },
        call: (rest) => rest.getGuildMember(guildId, userId),
        response: Schemas.Member,
        refusal: (response) => (response.code === 10007 ? new UnknownMember({ cause: response }) : undefined)
      })
      return memberHandle(runtime, guildId, member)
    })
}
