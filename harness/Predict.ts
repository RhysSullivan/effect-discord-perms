/**
 * Steps (a) and (b) from the symbolic setup alone (DESIGN §5.13): the subject's guild state rebuilt from the
 * desired state and its projection, then the resolver and preflight over it. Pure. The offline replay runs it
 * over every truth-table row and must reproduce the live records exactly; the flip controls (§5.9) use it to
 * find each row's first missing flag before any run.
 *
 * The rebuilt state is what the live subject's state shows under the table's `obfuscation: "default"`: every
 * lab channel with its real overwrites (M3 live: before Discord's switch, without the codec, GUILD_CREATE lists
 * the channels a bot cannot view with their real overwrites), and the scenario thread as step (a) leaves it
 * after its refresh: present with its state and the subject's membership when the subject can see it, `unseen`
 * when it cannot (the refresh got 50001 or 10003).
 */
import { guildInputFromSnapshot, inputFromSnapshot, type Resolution, resolve } from "../src/permissions/Resolver.ts"
import type { ChannelSnap, GuildSnap, Snapshot } from "../src/state/Snapshot.ts"
import type { ChannelId, GuildId, RoleId } from "../src/Snowflake.ts"
import { ChannelId as ChannelIdSchema, GuildId as GuildIdSchema, RoleId as RoleIdSchema, UserId as UserIdSchema } from "../src/Snowflake.ts"
import * as LabIds from "./LabIds.ts"
import * as Materialize from "./Materialize.ts"
import type { Scenario } from "./scenario/Dsl.ts"
import * as Facts from "./scenario/Facts.ts"
import { type StepRecords, stepRecords } from "./TruthTable.ts"

/** How long Converge times the subject out for, as the rebuilt state's timeout end (10 minutes after `now`). */
const timeoutMs = 600_000

/**
 * Fixed lab IDs for predictions without a lab (the flip controls). Role positions, not IDs, order the lab's
 * roles, so any distinct snowflakes give the same predictions.
 */
export const symbolicIds: Materialize.Ids = (() => {
  const names: ReadonlyArray<Materialize.LabName> = [
    ...LabIds.channelSpecs.map((spec) => spec.name),
    ...LabIds.threadSpecs.map((spec) => spec.name),
    ...LabIds.scenarioThreadSpecs.map((spec) => spec.name)
  ]
  return {
    guildId: GuildIdSchema.make("100000000000000000"),
    ownerId: UserIdSchema.make("200000000000000099"),
    subjectUserId: UserIdSchema.make("200000000000000001"),
    targetUserId: UserIdSchema.make("200000000000000002"),
    roles: new Map(LabIds.roleSpecs.map((spec, index): readonly [LabIds.RoleName, RoleId] => [spec.name, RoleIdSchema.make(`4000000000000000${index + 10}`)])),
    channels: new Map(names.filter((name) => name !== "lab-media").map((name, index): readonly [Materialize.LabName, ChannelId] => [name, ChannelIdSchema.make(`3000000000000000${index + 10}`)])),
    unavailable: new Set(["lab-media"])
  }
})()

/** The subject's guild state for `state` (see the module comment). */
export const snapshotOf = (state: Materialize.Desired, ids: Materialize.Ids, now: number): Snapshot => {
  const guild = Materialize.guildOf(state, ids)
  const channels = new Map<ChannelId, ChannelSnap>()
  for (const name of state.overwrites.keys()) {
    const channel = Materialize.channelOf(state, ids, name)
    channels.set(channel.id, channel)
  }
  const unseen = new Set<ChannelId>()
  const threadMembership = new Map<ChannelId, boolean>()
  const thread = state.thread
  if (thread !== undefined) {
    const snap = Materialize.channelOf(state, ids, thread.name)
    if (Materialize.subjectSees(state, ids, thread.name, now)) {
      channels.set(snap.id, snap)
      threadMembership.set(snap.id, thread.subjectMember)
    } else unseen.add(snap.id)
  }
  const member = Materialize.memberOf(state, ids, "subject", new Date(now + timeoutMs).toISOString())
  const snap: GuildSnap = {
    id: ids.guildId,
    ownerId: ids.ownerId,
    stale: false,
    roles: guild.roles,
    channels,
    unseen,
    threadMembership,
    botMember: { roleIds: member.roleIds, timedOutUntil: member.timedOutUntil },
    generations: new Map()
  }
  return { botUserId: ids.subjectUserId, guilds: new Map<GuildId, GuildSnap>([[ids.guildId, snap]]) }
}

/** One prediction: the facts with their arguments complete, the resolution, and the records of steps (a) and (b). */
export interface Prediction {
  readonly facts: Facts.Facts
  readonly resolution: Resolution
  readonly records: StepRecords
}

/** The route the preflight cause names (a template; the records carry only tags and categories). */
const route = "(predicted)"

/** Steps (a) and (b) for a scenario from its setup alone, at `now` (see the module comment). */
export const predict = (scenario: Pick<Scenario, "setup" | "operation">, ids: Materialize.Ids, now: number): Prediction => {
  const state = Materialize.desired(scenario.setup, ids)
  const snapshot = snapshotOf(state, ids, now)
  const facts = Facts.staticFactsOf(scenario)
  const fromState =
    facts.scope === "guild" ? guildInputFromSnapshot(snapshot, ids.guildId, now) : inputFromSnapshot(snapshot, ids.guildId, lookup(ids.channels, state.channel), now)
  if (fromState._tag === "NeedsRefresh") throw new Error(`Predict: the rebuilt state lacks what step (a) needs: ${fromState.reason}`)
  const resolution = resolve(fromState.input)
  const assigned = Materialize.assignedRoleOf(scenario.setup)
  const hierarchy: Facts.Hierarchy | undefined = facts.onTarget
    ? {
      guild: fromState.input.guild,
      bot: fromState.input.member,
      target: Materialize.memberOf(state, ids, "target", new Date(now + timeoutMs).toISOString()),
      role: assigned === undefined ? undefined : lookup(ids.roles, assigned)
    }
    : undefined
  const complete = Facts.complete(facts, resolution, hierarchy)
  return { facts: complete, resolution, records: stepRecords(complete, resolution, route) }
}

const lookup = <K, V>(map: ReadonlyMap<K, V>, key: K): V => {
  const value = map.get(key)
  if (value === undefined) throw new Error(`Predict: no ID for ${String(key)}`)
  return value
}
