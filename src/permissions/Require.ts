/**
 * `Permissions.require` (DESIGN §2.6, D8): an optional check against the guild state that narrows the error types
 * of the calls that follow. It is never required.
 *
 * - It reads the gateway state, refreshing it over REST first when the state lacks the channel or is stale, so it
 *   can fail with `Transient`. When even the refresh leaves the state unable to resolve the channel (the guild or
 *   the channel left the state meanwhile: the bot was removed, or the channel deleted), nothing can be checked, and
 *   it fails with `UnknownChannel`: it never returns a handle whose flags were not checked.
 * - It fails with the most fundamental problem (§3.2): ViewChannel (a channel the bot cannot see included), then
 *   Connect in voice and stage channels, then the timeout (`CommunicationDisabled`, when it masks a checked flag,
 *   H-020), then SendMessages or SendMessagesInThreads, then the other checked flags in the order given, then the
 *   payload flags in `PayloadRules` order.
 * - On success it returns the same channel re-typed: on the returned handle, the `Missing<F>` of each checked flag
 *   becomes one `PermissionRevokedSinceCheck`, because the flag was there when checked. The type never promises
 *   success: Discord owns the permissions, and they can change before the request lands.
 */
import { Effect } from "effect"
import { type ChannelCore, channelHandle, coreOf, decisionOf } from "../channels/Ops.ts"
import type { ChannelKinds, GuildChannel, GuildChannelKind, WithGranted } from "../channels/Channel.ts"
import { PreflightDecision } from "../errors/Cause.ts"
import type { PermissionErrors, PermissionFlag } from "../errors/Missing.generated.ts"
import { UnknownChannel } from "../errors/State.ts"
import type { Transient } from "../errors/Transient.ts"
import { payloadRuleNames, PayloadRules } from "../payload/PayloadRules.ts"
import { isVoiceKind } from "../state/Snapshot.ts"
import type { OpTags } from "./Operations.ts"
import { type Failure, toError } from "./Preflight.ts"

const payloadIndex = (flag: PermissionFlag): number => payloadRuleNames.findIndex((name) => PayloadRules[name].flag === flag)

/** `require`'s order of its failures (see the module comment). */
const rankOf = (core: ChannelCore, flags: ReadonlyArray<PermissionFlag>, failure: Failure): readonly [number, number] => {
  if (failure._tag !== "MissingFlag") return [2, 0]
  const flag = failure.flag
  if (flag === "ViewChannel") return [0, 0]
  if (flag === "Connect" && isVoiceKind(core.kind)) return [1, 0]
  if (flag === "SendMessages" || flag === "SendMessagesInThreads") return [3, 0]
  const payload = payloadIndex(flag)
  return payload >= 0 ? [5, payload] : [4, flags.indexOf(flag)]
}

const route = "/channels/{channel.id}"

function requireFlags<C extends GuildChannel, const F extends ReadonlyArray<PermissionFlag>>(
  channel: C,
  flags: F
): Effect.Effect<WithGranted<C, F[number]>, PermissionErrors["ViewChannel" | F[number]] | OpTags["permissions.require"] | Transient>
function requireFlags(channel: GuildChannel, flags: ReadonlyArray<PermissionFlag>): Effect.Effect<ChannelKinds<PermissionFlag>[GuildChannelKind], ReturnType<typeof toError> | UnknownChannel | Transient> {
  return Effect.gen(function* () {
    const core = coreOf(channel)
    if (core === undefined) return yield* Effect.die(new Error("Permissions.require: a channel handle the library did not build"))
    const target = {
      op: "permissions.require" as const,
      guildId: core.guildId,
      scope: { _tag: "Channel" as const, channelId: core.id },
      granted: [],
      args: { payload: [], extraFlags: flags },
      completion: { _tag: "Static" as const }
    }
    const decided = yield* decisionOf(core.runtime, { target })
    const cause = new PreflightDecision({ route, basis: core.basis })
    if (decided._tag === "Undecidable") {
      yield* Effect.logWarning(`Permissions.require: the state cannot resolve the channel even after a refresh (${decided.reason}); nothing was checked`)
      return yield* Effect.fail(new UnknownChannel({ cause }))
    }
    const failures = [...decided.decision.failures].sort((a, b) => {
      const [ta, pa] = rankOf(core, flags, a)
      const [tb, pb] = rankOf(core, flags, b)
      return ta - tb || pa - pb
    })
    const [first] = failures
    if (first !== undefined) return yield* Effect.fail(toError("permissions.require", first, cause))
    return channelHandle(core.runtime, { guildId: core.guildId, id: core.id, kind: core.kind }, [...new Set([...core.granted, ...flags])], core.basis)
  }).pipe(Effect.withSpan("discord.permissions.require", { attributes: { "discord.channel_kind": channel.kind, "discord.guild_id": channel.guildId, "discord.required_flags": [...flags].sort().join(",") } }))
}

/** Checking permissions ahead of the calls that need them (see the module comment). */
export const Permissions = {
  /** Checks `flags` (and ViewChannel) on `channel` against the guild state; the returned handle has them `granted`. */
  require: requireFlags
}
