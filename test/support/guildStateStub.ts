/**
 * A guild state for tests of what reads it (the recompute, `DiscordApi`): the snapshot is whatever the test says,
 * and a refresh replaces it with what the test says Discord would answer, recording each refresh. The real
 * refresh (its REST reads and generations) is `test/unit/state.test.ts`'s subject.
 */
import { Effect, Option, Ref, Stream } from "effect"
import type { Transient } from "../../src/errors/Transient.ts"
import type * as GuildState from "../../src/state/GuildState.ts"
import type { ChannelSnap, GuildSnap, RoleSnap, Snapshot } from "../../src/state/Snapshot.ts"
import type { ChannelId, RoleId } from "../../src/Snowflake.ts"
import { botId, guildId, ownerId } from "./guild.ts"

/** A stubbed guild state and the refreshes it saw (`refresh <channel>` or `refreshGuild`). */
export interface StubbedState {
  readonly state: GuildState.Interface
  readonly refreshes: Effect.Effect<ReadonlyArray<string>>
}

/**
 * A guild state holding `before`; each refresh replaces it with `after` (or fails with `fail`, for a refresh that
 * gets no answer).
 */
export const stubGuildState = (before: Snapshot, after: Snapshot, fail?: Transient): Effect.Effect<StubbedState> =>
  Effect.gen(function* () {
    const current = yield* Ref.make(before)
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    const refreshed = (what: string) =>
      Ref.update(seen, (entries) => [...entries, what]).pipe(
        Effect.andThen(fail === undefined ? Ref.set(current, after) : Effect.fail(fail)),
        Effect.as({ committed: true })
      )
    const state: GuildState.Interface = {
      snapshot: Ref.get(current),
      changes: Stream.fromEffect(Ref.get(current)),
      apply: () => Effect.void,
      awaitGuild: (guild) => Effect.map(Ref.get(current), (snapshot) => Option.fromNullishOr(snapshot.guilds.get(guild))),
      refresh: (_guild, channel) => refreshed(`refresh ${channel}`),
      refreshGuild: () => refreshed("refreshGuild")
    }
    return { state, refreshes: Ref.get(seen) }
  })

/** A snapshot of the test guild (`guild.ts`'s IDs) with the bot as a member. */
export const snapshotOf = (options: {
  readonly roles: ReadonlyArray<RoleSnap>
  readonly channels: ReadonlyArray<ChannelSnap>
  readonly botRoles: ReadonlyArray<RoleId>
  readonly timedOutUntil?: string | null
  readonly threadMembership?: ReadonlyArray<readonly [ChannelId, boolean]>
}): Snapshot => {
  const guild: GuildSnap = {
    id: guildId,
    ownerId,
    stale: false,
    roles: new Map(options.roles.map((role) => [role.id, role])),
    channels: new Map(options.channels.map((channel) => [channel.id, channel])),
    unseen: new Set(),
    threadMembership: new Map(options.threadMembership ?? []),
    botMember: { roleIds: options.botRoles, timedOutUntil: options.timedOutUntil ?? null },
    generations: new Map()
  }
  return { botUserId: botId, guilds: new Map([[guildId, guild]]) }
}
