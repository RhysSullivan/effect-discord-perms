/**
 * The library's guild state (DESIGN §4.5, D15): a `SubscriptionRef<Snapshot>` written by the `DispatchHook`
 * (`Hook.ts`, through `apply`) and by REST refreshes, and read by preflight.
 *
 * **Refresh with generations (E11).** `refresh(guild, channel)` captures the generations of the guild before
 * its REST reads (`getChannel`, the parent for a thread, `getGuildMember` for the bot, and `getGuild` for the
 * owner and roles), and commits **only the entities whose generation did not move** while the reads were in
 * flight. An entity a gateway event touched meanwhile keeps the gateway's newer value; a refresh never
 * overwrites it. `stale` is cleared by a refresh that committed everything, or by a gateway event.
 *
 * `getChannel` answering 50001 or 10003 records the channel as unseen (no View): evidence, not a defect
 * (§3.1). A 50001 for a voice or stage channel the state holds is not: Discord answers it without Connect too,
 * and the resolver's Connect mask decides there. Nor is a 50001 for a guild channel the state holds obfuscated
 * (M7): the obfuscated copy already says no View. The mark holds until a gateway event that can change what the
 * bot sees retires it (`Reducer.ts`); a guild channel keeps the gateway's copy meanwhile, a thread's is dropped.
 * Any other Discord answer to a refresh read is an unmapped code, a defect. `refreshGuild` makes the same reads
 * without a channel, for guild-level operations.
 */
import type { DiscordRestService } from "dfx/DiscordREST"
import { Context, Duration, Effect, Option, Schema, Stream, SubscriptionRef } from "effect"
import type { Transient } from "../errors/Transient.ts"
import { type Answered, send } from "../rest/Request.ts"
import type { ChannelId, GuildId, UserId } from "../Snowflake.ts"
import * as Schemas from "../rest/Schemas.ts"
import { reduce, toBotMember, toChannel, toRole } from "./Reducer.ts"
import { type ChannelSnap, emptySnapshot, type EntityKey, entityKey, generationOf, type GuildSnap, isVoiceKind, type Snapshot } from "./Snapshot.ts"

/** What one refresh did. */
export interface Refreshed {
  /** Every entity it read was unchanged by the gateway meanwhile, so it committed all of them. */
  readonly committed: boolean
}

/** The guild state service. */
export interface Interface {
  /** The current snapshot. */
  readonly snapshot: Effect.Effect<Snapshot>
  /** The current snapshot, then every change. */
  readonly changes: Stream.Stream<Snapshot>
  /** Reduces one dispatch (the hook's body). Never fails; a payload that does not decode is logged at Error. */
  readonly apply: (event: string, data: unknown) => Effect.Effect<void>
  /** The guild once GUILD_CREATE has been reduced, or `None` if it has not within `within`. */
  readonly awaitGuild: (guild: GuildId, within: Duration.Input) => Effect.Effect<Option.Option<GuildSnap>>
  /** Re-reads `channel` (and its parent), the bot's member, the owner and the roles over REST (see the module comment). */
  readonly refresh: (guild: GuildId, channel: ChannelId) => Effect.Effect<Refreshed, Transient>
  /**
   * Re-reads the bot's member, the owner and the roles over REST, with no channel: what a guild-level operation
   * (role assignment, nicknames, timeouts, kick and ban) is resolved over (M5, for the recompute).
   */
  readonly refreshGuild: (guild: GuildId) => Effect.Effect<Refreshed, Transient>
}

/** The guild state of one bot build. */
export class GuildState extends Context.Service<GuildState, Interface>()("state/GuildState") {}


const decodeOrDie =
  <S extends Schema.Codec<unknown, unknown>>(schema: S, route: string) =>
  (body: unknown): Effect.Effect<S["Type"]> =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError((error) => new Error(`${route}: a 2xx body did not decode: ${error.message}`)),
      Effect.orDie
    )

/** A channel as a refresh found it: its wire object, or unseen with the code `getChannel` answered. */
type Fetched = { readonly _tag: "Seen"; readonly wire: Schemas.Channel; readonly channel: ChannelSnap | undefined } | { readonly _tag: "Unseen"; readonly code: UnseenCode }

/** The codes `getChannel` answers when the bot cannot see the channel (H-080, H-087). */
type UnseenCode = 50001 | 10003
const isUnseenCode = (code: number): code is UnseenCode => code === 50001 || code === 10003

/**
 * Builds the service over `rest` (the bot's own dfx client), for the bot `botUserId`. `deadline` bounds each
 * refresh read.
 */
export const make = (rest: DiscordRestService, botUserId: UserId, deadline: Duration.Duration): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make<Snapshot>(emptySnapshot)

    const apply = (event: string, data: unknown): Effect.Effect<void> =>
      SubscriptionRef.modify(ref, (snapshot): readonly [string | undefined, Snapshot] => {
        const reduced = reduce(snapshot, event, data)
        return [reduced.problem, reduced.snapshot]
      }).pipe(Effect.flatMap((problem) => (problem === undefined ? Effect.void : Effect.logError(`GuildState: ${problem}`).pipe(Effect.annotateLogs("event", event)))))

    const awaitGuild = (guild: GuildId, within: Duration.Input): Effect.Effect<Option.Option<GuildSnap>> =>
      SubscriptionRef.changes(ref).pipe(
        Stream.filter((snapshot) => snapshot.guilds.has(guild)),
        Stream.runHead,
        Effect.map(Option.flatMap((snapshot) => Option.fromUndefinedOr(snapshot.guilds.get(guild)))),
        Effect.timeoutOrElse({ duration: within, orElse: () => Effect.succeedNone })
      )

    const fetchChannel = (id: ChannelId): Effect.Effect<Fetched, Transient> =>
      send("/channels/{channel.id}", "GET", rest.getChannel(id), deadline).pipe(
        Effect.flatMap((answer) => {
          if (answer._tag === "Rejected") {
            const code = answer.response.code
            return isUnseenCode(code)
              ? Effect.succeed<Fetched>({ _tag: "Unseen", code })
              : Effect.die(new Error(`GuildState.refresh: unmapped answer to getChannel: ${answer.response.status} ${answer.response.code}`))
          }
          return decodeOrDie(Schemas.Channel, "/channels/{channel.id}")(answer.body).pipe(
            Effect.flatMap((wire) => {
              const converted = toChannel(wire)
              switch (converted._tag) {
                case "Malformed":
                  return Effect.die(new Error(`GuildState.refresh: ${converted.reason}`))
                case "Unmodelled":
                  return Effect.succeed<Fetched>({ _tag: "Seen", wire, channel: undefined })
                case "Channel":
                  return Effect.succeed<Fetched>({ _tag: "Seen", wire, channel: converted.channel })
              }
            })
          )
        })
      )

    const required = <A>(route: string, answer: Answered<A>): Effect.Effect<A> =>
      answer._tag === "Ok" ? Effect.succeed(answer.body) : Effect.die(new Error(`GuildState.refresh: unmapped answer to ${route}: ${answer.response.status} ${answer.response.code}`))

    const refreshWith = (guildId: GuildId, channelId: ChannelId | undefined): Effect.Effect<Refreshed, Transient> =>
      Effect.gen(function* () {
        const before = (yield* SubscriptionRef.get(ref)).guilds.get(guildId)
        const captured = before?.generations ?? new Map<EntityKey, number>()
        const channel = channelId === undefined ? undefined : yield* fetchChannel(channelId)
        const parentId = channel?._tag === "Seen" && channel.channel?.thread !== undefined ? channel.channel.parentId : undefined
        const parent = parentId === undefined ? undefined : yield* fetchChannel(parentId)
        const member = yield* send("/guilds/{guild.id}/members/{user.id}", "GET", rest.getGuildMember(guildId, botUserId), deadline).pipe(
          Effect.flatMap((answer) => required("/guilds/{guild.id}/members/{user.id}", answer)),
          Effect.flatMap(decodeOrDie(Schemas.Member, "/guilds/{guild.id}/members/{user.id}"))
        )
        const guild = yield* send("/guilds/{guild.id}", "GET", rest.getGuild(guildId), deadline).pipe(
          Effect.flatMap((answer) => required("/guilds/{guild.id}", answer)),
          Effect.flatMap(decodeOrDie(Schemas.Guild, "/guilds/{guild.id}"))
        )

        return yield* SubscriptionRef.modify(ref, (snapshot): readonly [Refreshed, Snapshot] => {
          const current = snapshot.guilds.get(guildId)
          // the guild was deleted (or never created) meanwhile: nothing to commit into
          if (current === undefined) return [{ committed: false }, snapshot]
          let skipped = false
          const unchanged = (key: EntityKey): boolean => {
            const same = generationOf(current, key) === (captured.get(key) ?? 0)
            if (!same) skipped = true
            return same
          }
          const roles = new Map(current.roles)
          const fetchedRoles = new Map(guild.roles.map((role) => [role.id, toRole(role)] as const))
          for (const [id, role] of fetchedRoles) if (unchanged(entityKey.role(id))) roles.set(id, role)
          for (const id of current.roles.keys()) if (!fetchedRoles.has(id) && unchanged(entityKey.role(id))) roles.delete(id)
          const channels = new Map(current.channels)
          const unseen = new Set(current.unseen)
          const threadMembership = new Map(current.threadMembership)
          const commit = (id: ChannelId, fetched: Fetched) => {
            if (!unchanged(entityKey.channel(id))) return
            if (fetched._tag === "Unseen") {
              const held = channels.get(id)
              // a voice or stage channel answers 50001 without Connect as well as without View (M6 live, H-152), so
              // the answer says nothing the gateway's copy does not: the resolver's Connect mask decides there
              if (held !== undefined && isVoiceKind(held.kind) && fetched.code === 50001) return
              // an obfuscated copy (the codec, M7) already says no View, and Discord replaces it with the real data
              // when View returns (H-161), so a 50001 adds nothing; marking it unseen would keep the channel blind
              // under another name until some event retires the mark (M7 live: the next row in the same setup)
              if (held !== undefined && held.thread === undefined && held.obfuscated && fetched.code === 50001) return
              unseen.add(id)
              // a thread's copy is dropped: the gateway sends nothing for a thread the bot cannot see. A guild
              // channel keeps the gateway's copy, which GUILD_CREATE and CHANNEL_* keep current whether or not
              // the bot can see it (obfuscated from 2026-11-16, H-160), for when the mark is retired (M6)
              if (channels.get(id)?.thread === undefined && channels.has(id)) return
              channels.delete(id)
              threadMembership.delete(id)
              return
            }
            if (fetched.channel === undefined) {
              channels.delete(id)
              threadMembership.delete(id)
              return
            }
            channels.set(id, fetched.channel)
            unseen.delete(id)
            // a REST read carries the bot's thread member object exactly when it is a member
            if (fetched.channel.thread !== undefined) threadMembership.set(id, fetched.wire.member !== undefined)
          }
          if (channelId !== undefined && channel !== undefined) commit(channelId, channel)
          if (parentId !== undefined && parent !== undefined) commit(parentId, parent)
          const next: GuildSnap = {
            ...current,
            ownerId: unchanged(entityKey.guild) ? guild.owner_id : current.ownerId,
            roles,
            channels,
            unseen,
            threadMembership,
            botMember: unchanged(entityKey.member) ? toBotMember(member) : current.botMember,
            stale: skipped ? current.stale : false
          }
          return [{ committed: !skipped }, { ...snapshot, guilds: new Map(snapshot.guilds).set(guildId, next) }]
        })
      })

    return GuildState.of({
      snapshot: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
      apply,
      awaitGuild,
      refresh: (guildId, channelId) => refreshWith(guildId, channelId),
      refreshGuild: (guildId) => refreshWith(guildId, undefined)
    })
  })
