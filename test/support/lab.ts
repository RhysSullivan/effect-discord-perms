/**
 * Fake lab IDs for the offline harness tests: every lab role, channel and thread with a fake snowflake, and
 * `lab-media` unavailable, as in Perms Lab (M2). Test-only.
 */
import * as LabIds from "../../harness/LabIds.ts"
import type { Ids, LabName } from "../../harness/Materialize.ts"
import { ChannelId, GuildId, RoleId, UserId } from "../../src/Snowflake.ts"

export const labGuildId = GuildId.make("100000000000000000")

/** The fake lab. */
export const fakeIds: Ids = {
  guildId: labGuildId,
  ownerId: UserId.make("200000000000000099"),
  subjectUserId: UserId.make("200000000000000001"),
  targetUserId: UserId.make("200000000000000002"),
  roles: new Map(LabIds.roleSpecs.map((spec, index) => [spec.name, RoleId.make(`4000000000000000${String(index + 10)}`)])),
  channels: new Map(
    [...LabIds.channelSpecs.map((spec) => spec.name), ...LabIds.threadSpecs.map((spec) => spec.name)]
      .filter((name) => name !== "lab-media")
      .map((name, index): readonly [LabName, ChannelId] => [name, ChannelId.make(`3000000000000000${String(index + 10)}`)])
  ),
  unavailable: new Set(["lab-media"])
}

/** A lab role's fake ID. */
export const roleIdOf = (name: LabIds.RoleName): RoleId => {
  const id = fakeIds.roles.get(name)
  if (id === undefined) throw new Error(`fixture: ${name}`)
  return id
}

/** A lab channel's fake ID. */
export const channelIdOf = (name: LabName): ChannelId => {
  const id = fakeIds.channels.get(name)
  if (id === undefined) throw new Error(`fixture: ${name}`)
  return id
}
