/**
 * Harness identity checks (DESIGN §4.4), run by `harness:smoke`, `harness:reset` and `verify:live` before any
 * write. Any difference aborts the command:
 *
 * - each identity passes the library's REST startup checks (`src/bot/Startup.ts`): a valid token, the portal
 *   flags for its privileged intents (harness: GuildMembers; subject: GuildMembers and MessageContent), and
 *   membership of the lab guild;
 * - each identity's `getMyApplication().id` equals its `DISCORD_<ID>_APP_ID`, and the three `getMyUser().id`
 *   values are distinct;
 * - `getGuild(DISCORD_TEST_GUILD_ID)` is named "Perms Lab" and has `#rules` and `#mod-updates`;
 * - the harness's highest role is the highest role in the guild, so it can manage every lab role.
 *
 * The subject's READY `user.id` and the intents its codec sent need the subject's gateway, which arrives with
 * the library's bot layer (M3, codec M7); until then they are reported as not checked.
 *
 * On success the Lab guard is armed with the bots' user IDs and the protected channels, and writes may start.
 */
import { Duration, Effect, Schema } from "effect"
import { SubjectRaw } from "../src/bot/Internals.ts"
import { missingPrivilegedIntents, restChecks, type StartupFailed, type StartupIdentity } from "../src/bot/Startup.ts"
import { Credentials } from "../src/config/Credentials.ts"
import type { ChannelId } from "../src/Snowflake.ts"
import { HarnessRest, TargetRest } from "./Identities.ts"
import { LabCheckFailed, LabGuard, type LabRequestFailed, labStep } from "./Lab.ts"
import * as Wire from "./Wire.ts"

/** The lab guild's expected name. */
export const labGuildName = "Perms Lab"
/** The channels Community requires, which the harness must never touch. */
export const protectedChannelNames: ReadonlyArray<string> = ["rules", "mod-updates"]

/** The per-call deadline the harness uses for its own requests. */
export const requestDeadline = Duration.seconds(30)

/** What the identity checks found. */
export interface IdentityReport {
  readonly guild: Wire.Guild
  readonly harness: StartupIdentity
  readonly subject: StartupIdentity
  readonly target: StartupIdentity
  /** Whether the harness application has the Message Content flag, so its REST reads see content (D35). */
  readonly harnessHasMessageContent: boolean
  /** `#rules`, `#mod-updates` and the guild's rules and public-updates channels. */
  readonly protectedChannels: ReadonlyArray<{ readonly id: ChannelId; readonly name: string }>
  /** The harness's highest role, the top of the guild. */
  readonly harnessTopRole: Wire.Role
  /** Checks that need the subject's gateway, which M2 does not have yet. */
  readonly notCheckedYet: ReadonlyArray<string>
}

const fail = (check: string, detail: string) => Effect.fail(new LabCheckFailed({ check, detail }))

/** Runs the identity checks and arms the Lab guard. Reads only. */
export const run: Effect.Effect<
  IdentityReport,
  StartupFailed | LabCheckFailed | LabRequestFailed,
  HarnessRest | TargetRest | SubjectRaw | Credentials | LabGuard
> = Effect.gen(function* () {
  const credentials = yield* Credentials
  const harnessRest = yield* HarnessRest
  const options = { guildId: credentials.guildId, requestDeadline }
  const harness = yield* restChecks(harnessRest, { ...options, privilegedIntents: ["GuildMembers"] })
  const subject = yield* restChecks(yield* SubjectRaw, { ...options, privilegedIntents: ["GuildMembers", "MessageContent"] })
  const target = yield* restChecks(yield* TargetRest, { ...options, privilegedIntents: [] })

  for (const [name, found, expected] of [
    ["harness", harness, credentials.harness],
    ["subject", subject, credentials.subject],
    ["target", target, credentials.target]
  ] as const) {
    if (found.applicationId !== expected.applicationId) {
      return yield* fail("identity", `the ${name} token belongs to application ${found.applicationId}, but DISCORD_${name.toUpperCase()}_APP_ID is ${expected.applicationId}`)
    }
  }
  if (new Set([harness.userId, subject.userId, target.userId]).size !== 3) {
    return yield* fail("identity", `the three tokens are not three distinct bots: ${harness.userId}, ${subject.userId}, ${target.userId}`)
  }

  const guild = yield* harnessRest.getGuild(credentials.guildId).pipe(labStep("identity: get guild"), Effect.flatMap(Wire.decode(Wire.Guild, "getGuild")))
  if (guild.name !== labGuildName) return yield* fail("guild", `DISCORD_TEST_GUILD_ID names "${guild.name}", not "${labGuildName}"`)
  const channels = yield* harnessRest.listGuildChannels(credentials.guildId).pipe(
    labStep("identity: list channels"),
    Effect.flatMap(Wire.decode(Schema.Array(Wire.Channel), "listGuildChannels"))
  )
  for (const name of protectedChannelNames) {
    if (!channels.some((channel) => channel.name === name)) return yield* fail("guild", `${labGuildName} has no #${name}`)
  }
  const protectedIds = new Set<string>([guild.rules_channel_id, guild.public_updates_channel_id].filter((id) => id !== null))
  const protectedChannels = channels.filter((channel) => protectedChannelNames.includes(channel.name) || protectedIds.has(channel.id))

  const roles = yield* harnessRest.listGuildRoles(credentials.guildId).pipe(
    labStep("identity: list roles"),
    Effect.flatMap(Wire.decode(Schema.Array(Wire.Role), "listGuildRoles"))
  )
  const harnessRoles = new Set<string>(harness.guildRoles ?? [])
  const byRank = [...roles].sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : 1))
  const top = byRank[0]
  if (top === undefined || !harnessRoles.has(top.id)) {
    return yield* fail("harness role", `the harness's role must be the highest in ${labGuildName}; the highest is ${top?.name ?? "none"}`)
  }

  const guard = yield* LabGuard
  yield* guard.arm({ harnessUserId: harness.userId, subjectUserId: subject.userId, targetUserId: target.userId, protectedChannels: new Set(protectedChannels.map((channel) => channel.id)) })

  return {
    guild,
    harness,
    subject,
    target,
    harnessHasMessageContent: missingPrivilegedIntents(harness.applicationFlags, ["MessageContent"]).length === 0,
    protectedChannels: protectedChannels.map((channel) => ({ id: channel.id, name: channel.name })),
    harnessTopRole: top,
    notCheckedYet: ["subject READY user.id (needs the subject gateway, M3)", "intents sent in Identify (needs the codec, M7)"]
  }
})
