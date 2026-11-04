/**
 * Command registration (DESIGN §4.14, D18; startup check 5 of §4.4).
 *
 * `sync` registers a bot's chat-input commands in one guild (guild scope only, never global): it GETs the guild's
 * commands of the application, compares them with the local definitions in canonical form (`Canonical.ts`, matched by
 * name), and sends the bulk overwrite (`PUT`) only when they differ. After a write it GETs again and requires the
 * stored set to equal the local one; a difference then means Discord stored something the canonicaliser does not
 * model, a defect naming it. Commands are therefore re-registered only when their definitions change (R-registration-
 * diff), which the harness counts at the shared base client (§5.10).
 *
 * Both requests go through `rest.httpClient` (`Request.sendJson`): dfx's generated `ChannelTypes` lacks GuildMedia (16),
 * so a definition with a media channel option cannot be typed as dfx's request (LOG.md, "dfx deviations").
 *
 * Failures are `StartupFailed` (§3.1): 50035 is `command-rejected` (the detail lists Discord's field errors) and 30034
 * `daily-command-limit` (H-205; 400 or a coded 429); 30032 (the per-guild command limit, H-204) is `command-rejected`;
 * a transient failure is `discord-unavailable`; any other answer is an unmapped defect.
 */
import type { DiscordRestService } from "dfx/DiscordREST"
import type { Duration } from "effect"
import { Effect, Schema } from "effect"
import { StartupFailed } from "../bot/Startup.ts"
import type { DiscordResponse } from "../errors/Cause.ts"
import type { Transient } from "../errors/Transient.ts"
import { type Answered, sendJson } from "../rest/Request.ts"
import type { ApplicationId, GuildId } from "../Snowflake.ts"
import { canonical, differences, StoredCommand, toDiscord } from "./Canonical.ts"
import type { AnyChatInputCommand } from "./Command.ts"

/** Where commands are registered: the bot's application in one guild. */
export interface Target {
  readonly applicationId: ApplicationId
  readonly guildId: GuildId
}

/** The route template of the guild's commands (GET lists them, PUT overwrites them all). */
export const route = "/applications/{application.id}/guilds/{guild.id}/commands"

/** The path of `target`'s guild commands. */
export const pathOf = (target: Target): string => `/applications/${target.applicationId}/guilds/${target.guildId}/commands`

/** What a sync did. */
export interface Synced {
  /** Whether the stored commands differed, so the bulk overwrite was sent (and the stored set then checked). */
  readonly wrote: boolean
  /** How the stored commands differed before the write (empty when nothing was written). */
  readonly differences: ReadonlyArray<string>
}

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredCommand))

const unavailable = (what: string) => (error: Transient): StartupFailed =>
  new StartupFailed({ reason: "discord-unavailable", detail: `${route}: ${what}: ${error._tag}`, cause: error.cause })

const fieldList = (response: DiscordResponse): string =>
  response.fieldErrors.length === 0 ? "" : `: ${response.fieldErrors.map((error) => `${error.path.join(".") || "(body)"} ${error.code}`).join(", ")}`

/** A refusal of the bulk overwrite as the startup failure it is, or `undefined` for an answer this route does not expect. */
const rejection = (response: DiscordResponse): StartupFailed | undefined => {
  if (response.code === 30034) return new StartupFailed({ reason: "daily-command-limit", detail: `${route}: ${response.status} 30034 ${response.message}`, cause: response })
  if (response.code === 50035 || response.code === 30032) {
    return new StartupFailed({ reason: "command-rejected", detail: `${route}: ${response.status} ${response.code} ${response.message}${fieldList(response)}`, cause: response })
  }
  if (response.status === 401) return new StartupFailed({ reason: "invalid-token", detail: `${route}: 401`, cause: response })
  return undefined
}

const unmapped = (what: string, response: DiscordResponse) =>
  Effect.die(new Error(`${route}: ${what}: unmapped Discord answer ${response.status} ${response.code} ${response.message}`))

/** The guild's stored commands of the application. */
const listStored = (rest: DiscordRestService, target: Target, deadline: Duration.Duration): Effect.Effect<ReadonlyArray<Schema.JsonObject>, StartupFailed> =>
  Effect.gen(function* () {
    const answer: Answered<Schema.Json> = yield* sendJson(rest, route, "GET", pathOf(target), undefined, deadline).pipe(Effect.mapError(unavailable("list")))
    if (answer._tag === "Rejected") {
      const failed = answer.response.status === 401 ? new StartupFailed({ reason: "invalid-token", detail: `${route}: 401`, cause: answer.response }) : undefined
      return failed === undefined ? yield* unmapped("list", answer.response) : yield* failed
    }
    return yield* decodeStored(answer.body).pipe(
      Effect.mapError((error) => new Error(`${route}: the stored commands did not decode: ${error.message}`)),
      Effect.orDie
    )
  })

/**
 * Registers `commands` for `target` (see the module comment): no request but the GET when the stored commands already
 * equal them in canonical form; otherwise the bulk overwrite, then a GET that must find them stored as sent.
 */
export const sync = (rest: DiscordRestService, target: Target, commands: ReadonlyArray<AnyChatInputCommand>, deadline: Duration.Duration): Effect.Effect<Synced, StartupFailed> =>
  Effect.gen(function* () {
    const local = commands.map((command) => toDiscord(command.definition))
    const before = differences(local, yield* listStored(rest, target, deadline))
    if (before.length === 0) return { wrote: false, differences: [] }
    const answer = yield* sendJson(rest, route, "PUT", pathOf(target), local, deadline).pipe(Effect.mapError(unavailable("overwrite")))
    if (answer._tag === "Rejected") {
      const failed = rejection(answer.response)
      return failed === undefined ? yield* unmapped("overwrite", answer.response) : yield* failed
    }
    const after = differences(local, yield* listStored(rest, target, deadline))
    if (after.length > 0) {
      return yield* Effect.die(new Error(`${route}: after the overwrite, Discord stores the commands differently from what was sent (a field the canonicaliser does not model): ${after.join("; ")}`))
    }
    return { wrote: true, differences: before }
  })

/** The canonical form of `commands` as registration compares them (for tests and the harness's readback). */
export const canonicalOf = (commands: ReadonlyArray<AnyChatInputCommand>): ReadonlyArray<Schema.JsonObject> => commands.map((command) => canonical(toDiscord(command.definition)))
