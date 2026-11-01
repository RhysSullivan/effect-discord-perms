/**
 * Fail-fast startup checks (DESIGN §4.4, D19).
 *
 * dfx does not fail on a bad token or a disallowed intent: its sharder swallows `getBotGateway()` failures
 * and its socket reconnects forever, logging at Debug (dfx.md §2). So the library checks, before the gateway
 * starts, that the identity can work at all, and fails with a typed `StartupFailed`.
 *
 * `restChecks` holds the three REST checks:
 *
 * 1. `getMyUser()`: 401 gives `invalid-token`; 5xx, a transport error or the deadline gives
 *    `discord-unavailable` with the cause.
 * 2. `getMyApplication().flags` contains, for each declared privileged intent, its gateway flag or the
 *    `...Limited` flag; otherwise `privileged-intent-not-enabled`.
 * 3. With a guild, `getGuildMember(guild, botUser)` (not `getMyGuildMember`, C6): 404 gives `not-in-guild`.
 *
 * The harness runs them for all three identities (`harness/IdentityCheck.ts`). `Bot.layer` (M7) runs them,
 * then waits for GUILD_CREATE (`guild-not-ready`), and M8 adds registration (`command-rejected`,
 * `daily-command-limit`).
 */
import { ApplicationFlags } from "discord-api-types/v10"
import type { DiscordRESTError, DiscordRestService } from "dfx/DiscordREST"
import { Clock, Duration, Effect, Schema } from "effect"
import { ErrorCause, NoResponse } from "../errors/Cause.ts"
import { classify, type DfxFailure } from "../rest/ErrorMap.ts"
import { ApplicationId, type GuildId, RoleId, UserId } from "../Snowflake.ts"

/** The bot cannot start; a layer error, never a handler error (§3.1). */
export class StartupFailed extends Schema.TaggedError<StartupFailed>()("StartupFailed", {
  reason: Schema.Literals([
    "invalid-token",
    "privileged-intent-not-enabled",
    "not-in-guild",
    "guild-not-ready",
    "command-rejected",
    "daily-command-limit",
    "discord-unavailable"
  ]),
  detail: Schema.String,
  /** The Discord response (or `NoResponse`) behind the failure, when there was a request. */
  cause: Schema.optionalKey(ErrorCause)
}) {}

/** The intents Discord gates behind an application flag. */
export type PrivilegedIntent = "GuildPresences" | "GuildMembers" | "MessageContent"

/** The application flags that allow each privileged intent: the full flag or the `...Limited` one. */
export const privilegedIntentFlags: { readonly [I in PrivilegedIntent]: readonly [number, number] } = {
  GuildPresences: [ApplicationFlags.GatewayPresence, ApplicationFlags.GatewayPresenceLimited],
  GuildMembers: [ApplicationFlags.GatewayGuildMembers, ApplicationFlags.GatewayGuildMembersLimited],
  MessageContent: [ApplicationFlags.GatewayMessageContent, ApplicationFlags.GatewayMessageContentLimited]
}

/** The privileged intents whose flags `applicationFlags` does not contain, in declaration order. */
export const missingPrivilegedIntents = (applicationFlags: number, declared: ReadonlyArray<PrivilegedIntent>): ReadonlyArray<PrivilegedIntent> =>
  declared.filter((intent) => privilegedIntentFlags[intent].every((flag) => (applicationFlags & flag) === 0))

/** Who the token belongs to, as the REST checks found it. */
export interface StartupIdentity {
  readonly userId: UserId
  readonly username: string
  readonly applicationId: ApplicationId
  /** The raw application flags (the privileged-intent and other bits). */
  readonly applicationFlags: number
  /** The bot's roles in the configured guild, when one was configured. */
  readonly guildRoles: ReadonlyArray<RoleId> | undefined
}

/** Options for {@link restChecks}. */
export interface RestCheckOptions {
  readonly guildId: GuildId | undefined
  readonly privilegedIntents: ReadonlyArray<PrivilegedIntent>
  /** Bounds each call, including dfx's unbounded 429 retries (§4.10). */
  readonly requestDeadline: Duration.Duration
}

const decodeUser = Schema.decodeUnknownEffect(Schema.Struct({ id: UserId, username: Schema.String }))
const decodeApplication = Schema.decodeUnknownEffect(Schema.Struct({ id: ApplicationId, flags: Schema.Int }))
const decodeMember = Schema.decodeUnknownEffect(Schema.Struct({ roles: Schema.Array(RoleId) }))

const routes = {
  user: "/users/@me",
  application: "/applications/@me",
  member: "/guilds/{guild.id}/members/{user.id}"
} as const

const unavailable = (route: string, failure: DfxFailure): StartupFailed =>
  failure._tag === "NoResponse"
    ? new StartupFailed({ reason: "discord-unavailable", detail: `${route}: no response`, cause: failure.cause })
    : new StartupFailed({ reason: "discord-unavailable", detail: `${route}: status ${failure.response.status}`, cause: failure.response })

/**
 * One startup call: bounded by the deadline, its failures classified, its body decoded. `onResponse` maps a
 * Discord JSON error answer to a `StartupFailed`, or returns `undefined` for an answer this call does not
 * expect, which is a defect (an unmapped code).
 */
const call = <A, T>(
  route: string,
  request: Effect.Effect<A, DiscordRESTError>,
  decode: (body: unknown) => Effect.Effect<T, Schema.SchemaError>,
  deadline: Duration.Duration,
  onResponse: (failure: Extract<DfxFailure, { _tag: "Response" }>) => StartupFailed | undefined
): Effect.Effect<T, StartupFailed> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const body = yield* request.pipe(
      Effect.catch((error) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => classify(error, route, now - started)),
          Effect.flatMap((failure) => {
            if (failure._tag !== "Response") return Effect.fail(unavailable(route, failure))
            const mapped = onResponse(failure)
            return mapped === undefined
              ? Effect.die(new Error(`${route}: unmapped Discord answer ${failure.response.status} ${failure.response.code} ${failure.response.message}`))
              : Effect.fail(mapped)
          })
        )
      ),
      Effect.timeoutOrElse({
        duration: deadline,
        orElse: () =>
          Effect.fail(
            new StartupFailed({
              reason: "discord-unavailable",
              detail: `${route}: no response within ${Duration.format(deadline)}`,
              cause: new NoResponse({ route, method: "GET", reason: "deadline", afterMs: Duration.toMillis(deadline) })
            })
          )
      })
    )
    return yield* decode(body).pipe(Effect.orDie)
  })

const invalidToken = (route: string) => (failure: Extract<DfxFailure, { _tag: "Response" }>): StartupFailed | undefined =>
  failure.response.status === 401 ? new StartupFailed({ reason: "invalid-token", detail: `${route}: 401`, cause: failure.response }) : undefined

/**
 * Runs checks 1-3 of §4.4 with `rest`, the identity's own dfx client. Succeeds with who the token belongs to;
 * fails with `StartupFailed`. A Discord answer none of the checks expects is a defect.
 */
export const restChecks = (rest: DiscordRestService, options: RestCheckOptions): Effect.Effect<StartupIdentity, StartupFailed> =>
  Effect.gen(function* () {
    const user = yield* call(routes.user, rest.getMyUser(), decodeUser, options.requestDeadline, invalidToken(routes.user))
    const application = yield* call(routes.application, rest.getMyApplication(), decodeApplication, options.requestDeadline, invalidToken(routes.application))
    const missing = missingPrivilegedIntents(application.flags, options.privilegedIntents)
    if (missing.length > 0) {
      return yield* new StartupFailed({
        reason: "privileged-intent-not-enabled",
        detail: `application ${application.id} lacks the portal flag for ${missing.join(", ")}`
      })
    }
    const guildRoles =
      options.guildId === undefined
        ? undefined
        : (yield* call(routes.member, rest.getGuildMember(options.guildId, user.id), decodeMember, options.requestDeadline, (failure) =>
          // 404 is the documented answer. A bot outside a guild may instead get 403 50001 (Missing Access);
          // both mean the guild cannot be used. Unverified live: Perms Lab is the only guild the bots may touch.
          failure.response.status === 404 || (failure.response.status === 403 && failure.response.code === 50001)
            ? new StartupFailed({ reason: "not-in-guild", detail: `${routes.member}: ${failure.response.status} ${failure.response.code}`, cause: failure.response })
            : invalidToken(routes.member)(failure))).roles
    return { userId: user.id, username: user.username, applicationId: application.id, applicationFlags: application.flags, guildRoles }
  })
