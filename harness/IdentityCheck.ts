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
 * - the subject's gateway READY named the same user as its `getMyUser()` (the subject is the library's bot build,
 *   whose startup already ran checks 1-3 and waited for the lab guild's GUILD_CREATE).
 *
 * The intents the subject's codec sent in Identify need the codec (M7); until then that check is reported as
 * not checked.
 *
 * On success the Lab guard is armed with the bots' user IDs and the protected channels, and writes may start.
 */
import { Duration, Effect, Schema } from "effect"
import { BotRuntime } from "../src/bot/Bot.ts"
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
  /** Checks that need parts built in later milestones. */
  readonly notCheckedYet: ReadonlyArray<string>
}

const fail = (check: string, detail: string) => Effect.fail(new LabCheckFailed({ check, detail }))

/** Runs the identity checks and arms the Lab guard. Reads only. */
export const run: Effect.Effect<
  IdentityReport,
  StartupFailed | LabCheckFailed | LabRequestFailed,
  HarnessRest | TargetRest | BotRuntime | Credentials | LabGuard
> = Effect.gen(function* () {
  const credentials = yield* Credentials
  const harnessRest = yield* HarnessRest
  const options = { guildId: credentials.guildId, requestDeadline }
  const harness = yield* restChecks(harnessRest, { ...options, privilegedIntents: ["GuildMembers"] })
  const target = yield* restChecks(yield* TargetRest, { ...options, privilegedIntents: [] })
  // the subject's build ran checks 1-3 for its declared intents; the matrix also needs Message Content (M7)
  const runtime = yield* BotRuntime
  const subject = runtime.identity
  const missing = missingPrivilegedIntents(subject.applicationFlags, ["GuildMembers", "MessageContent"])
  if (missing.length > 0) return yield* fail("identity", `the subject application lacks the portal flag for ${missing.join(", ")}`)
  const readyUser = (yield* runtime.guildState.snapshot).botUserId
  if (readyUser !== subject.userId) {
    return yield* fail("identity", `the subject gateway's READY named ${readyUser ?? "nobody"}, but its token belongs to ${subject.userId}`)
  }

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
    notCheckedYet: ["intents sent in Identify (needs the codec, M7)"]
  }
})
