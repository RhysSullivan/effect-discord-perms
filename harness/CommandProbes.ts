/**
 * The registration rows' probes (DESIGN §5.5, §6 M8; the definitions are `catalog/commands.ts`). Each is one side of a
 * command rule's live pair, run on `catalog/rules.ts`'s `commands` setup, through the subject's own client
 * (`SubjectRaw`, the build's dfx REST over the shared base client: guarded, paced, counted, and held to the
 * command-create budget):
 *
 * - `typed-register-*` registers a definition that compiles through the library (`Registration.sync`): `Succeeded`, or
 *   Discord's refusal as a `Rejected` (which no expectation of a typed side accepts); `typed-register-choices` also
 *   reads the command back and observes `Applied options` when Discord stores its choices, required flags and channel
 *   types as defined (R-options-typed), compared field by field with the definition as written ({@link storedAsDefined}),
 *   never through the canonicaliser, whose equality `Registration.sync`'s check after writing already requires (the M8
 *   verifier: comparing canonically could never observe `Ignored`);
 * - `typed-sync-identical` first makes sure {@link baseCommand} is registered, then syncs it again; `typed-sync-<field>`
 *   syncs a definition with one canonical field of the base changed, over whatever the row before registered (every
 *   mutation differs from every other definition the catalog registers, so the guild never already holds it; M8 live:
 *   Discord's bucket for the bulk overwrite allows about one PUT every 30 s, 429s with `retry-after` 56 to 58 s, so a
 *   base re-registration before each mutation doubled the rows' time). Each observes the writes the shared base client
 *   counted to the commands routes during that sync, less the 429s it counted there (a 429 is a refusal Discord
 *   applied nothing for, which dfx sends again: M8 live, one PUT answered 429 then 200 was counted twice) (`Writes`,
 *   R-registration-diff);
 * - `raw-*` first makes sure {@link baseCommand} is registered, so a POST under its name is an update, then POSTs what
 *   the types forbid (`Rejected` with Discord's status, code and inner 50035 errors with their paths, or `Succeeded`).
 *
 * A transient failure (no answer, a 5xx) is an infrastructure abort, never an observation.
 */
import { Effect, Option, Schema } from "effect"
import { SubjectRaw } from "../src/bot/Internals.ts"
import type { StartupFailed } from "../src/bot/Startup.ts"
import { StoredCommand } from "../src/commands/Canonical.ts"
import type { AnyChatInputCommand, OptionLike } from "../src/commands/Command.ts"
import * as Registration from "../src/commands/Registration.ts"
import { DiscordResponse } from "../src/errors/Cause.ts"
import { channelTypes } from "../src/state/Snapshot.ts"
import type { Transient } from "../src/errors/Transient.ts"
import { type Answered, sendJson } from "../src/rest/Request.ts"
import { labStepDeadline } from "./Lab.ts"
import * as Outcome from "./Outcome.ts"
import { Pacing, type Stats } from "./Pacing.ts"
import type { ProbeContext, ProbeResult } from "./Probes.ts"
import { baseCommand, labCommandName, mutatedFields, type MutatedField, mutations, nestedCommand, optionsCommand, rawBodies, type RawRegistration } from "./scenario/catalog/commands.ts"
import type { Observation } from "./scenario/Dsl.ts"

/** A registration probe (every command probe but the two custom_id ones, which `Probes.ts` runs). */
export type RegistrationProbe =
  | "typed-register-options"
  | "typed-register-subcommands"
  | "typed-register-choices"
  | "typed-sync-identical"
  | `typed-sync-${MutatedField}`
  | RawRegistration

const registrationProbes: ReadonlySet<string> = new Set<string>([
  "typed-register-options",
  "typed-register-subcommands",
  "typed-register-choices",
  "typed-sync-identical",
  ...mutatedFields.map((field) => `typed-sync-${field}`),
  ...Object.keys(rawBodies)
])

/** Whether `probe` is a registration probe. */
export const isRegistrationProbe = (probe: string): probe is RegistrationProbe => registrationProbes.has(probe)

const isRaw = (probe: RegistrationProbe): probe is RawRegistration => probe in rawBodies

type SyncProbe = "typed-sync-identical" | `typed-sync-${MutatedField}`

const isSync = (probe: RegistrationProbe): probe is SyncProbe => probe.startsWith("typed-sync-")

/** The field a sync probe mutates, `undefined` for the identical sync. */
const mutatedFieldOf = (probe: SyncProbe): MutatedField | undefined => mutatedFields.find((field) => probe === `typed-sync-${field}`)

/**
 * The per-call deadline of the probes' requests: the lab steps' 90 s (`Lab.labStepDeadline`), not the matrix's 30 s.
 * Discord's bucket for command writes is small (M8 live: a POST answered 429 with `retry-after` 18 s, scope user, after
 * about a dozen writes in half a minute), and dfx waits it out, so a bulk overwrite queued behind it outlasted 30 s.
 * Only the wait is longer; a request that gets no answer still aborts the run.
 */
const deadline = labStepDeadline

const commandWrite = /^(PUT|POST|PATCH) \/applications\/\{id\}\/guilds\/\{id\}\/commands(\/|$)/

/**
 * The writes to an application's guild commands (the bulk overwrite, a create, an edit) the shared base client sent and
 * Discord did not answer with a 429: dfx sends a 429's request again, and Discord applied nothing for it.
 */
export const commandWrites = (stats: Stats): number => {
  const sum = (entries: ReadonlyArray<readonly [string, number]>) => entries.filter(([route]) => commandWrite.test(route)).reduce((total, [, count]) => total + count, 0)
  return sum(stats.writesByRoute) - sum(stats.rateLimitedByRoute)
}

const succeeded: Observation = { _tag: "Succeeded" }
const rejected = (response: DiscordResponse): Observation => ({ _tag: "Rejected", status: response.status, code: response.code, inner: [...Outcome.rejected(response).inner] })

/** A library sync's outcome: its value, or Discord's refusal (a `discord-unavailable` failure aborts the run). */
const library = (context: ProbeContext, commands: ReadonlyArray<AnyChatInputCommand>) =>
  Effect.flatMap(Effect.service(SubjectRaw), (subject) =>
    Registration.sync(subject, { applicationId: context.runtime.identity.applicationId, guildId: context.ids.guildId }, commands, deadline).pipe(
      Effect.map((synced) => ({ _tag: "Synced", synced }) as const),
      Effect.catch((error: StartupFailed) =>
        error.reason === "discord-unavailable" || !(error.cause instanceof DiscordResponse)
          ? Effect.die(new Error(`infrastructure abort: the library's registration: ${error.reason} ${error.detail}`))
          : Effect.succeed({ _tag: "Refused", response: error.cause } as const)
      )
    )
  )

/** Makes sure {@link baseCommand} is registered, so the probe's own request is an update of it (see the module comment). */
const ensureBase = (context: ProbeContext) =>
  Effect.flatMap(library(context, [baseCommand]), (outcome) =>
    outcome._tag === "Synced" ? Effect.void : Effect.die(new Error(`probe: Discord refused the base registration: ${outcome.response.status} ${outcome.response.code} ${outcome.response.message}`))
  )

/** A typed registration's observation and raw outcome. */
const registered = (context: ProbeContext, commands: ReadonlyArray<AnyChatInputCommand>) =>
  Effect.map(library(context, commands), (outcome): ProbeResult =>
    outcome._tag === "Synced" ? { observation: succeeded, raw: Outcome.ok([]), created: [] } : { observation: rejected(outcome.response), raw: Outcome.rejected(outcome.response), created: [] }
  )

const isObject = (value: Schema.Json | undefined): value is Schema.JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)

/** A stored choice list as `name=value` lines, in order; `[]` when absent. */
const storedChoices = (option: Schema.JsonObject): ReadonlyArray<string> => {
  const choices = option["choices"]
  return Array.isArray(choices) ? choices.map((choice) => (isObject(choice) ? `${String(choice["name"])}=${JSON.stringify(choice["value"])}` : "?")) : []
}

/** A stored channel-type list as a sorted set of numbers; `[]` when absent. */
const storedKinds = (option: Schema.JsonObject): ReadonlyArray<number> => {
  const kinds = option["channel_types"]
  return Array.isArray(kinds) ? [...new Set(kinds.filter((kind): kind is number => typeof kind === "number"))].sort((a, b) => a - b) : []
}

/**
 * Whether `stored` (a command as Discord's GET returns it) holds each of `options` as written: an option of the same
 * name, `required: true` exactly when the definition says so, the same choices (names and values, in order) and the
 * same channel types as a set (Discord's documented numbers, `Snapshot.channelTypes`). Read straight from the stored
 * JSON, independent of `Canonical.ts` (R-options-typed's valid side).
 */
export const storedAsDefined = (options: ReadonlyArray<OptionLike>, stored: Schema.JsonObject): boolean => {
  const listed = stored["options"]
  const storedOptions = Array.isArray(listed) ? listed.filter(isObject) : []
  if (storedOptions.length !== options.length) return false
  return options.every((option) => {
    const match = storedOptions.find((candidate) => candidate["name"] === option.name)
    if (match === undefined) return false
    const required = "required" in option && option.required === true
    if ((match["required"] === true) !== required) return false
    const choices = "choices" in option && option.choices !== undefined ? option.choices.map((choice) => `${choice.name}=${JSON.stringify(choice.value)}`) : []
    if (storedChoices(match).join("\n") !== choices.join("\n")) return false
    const kinds = option.type === "channel" && option.channelTypes !== undefined ? [...new Set(option.channelTypes.map((kind) => channelTypes[kind]))].sort((a, b) => a - b) : []
    return storedKinds(match).join() === kinds.join()
  })
}

/** Runs the registration probe `probe` (see the module comment). */
export const run = (probe: RegistrationProbe, context: ProbeContext): Effect.Effect<ProbeResult, Transient, SubjectRaw | Pacing> =>
  Effect.gen(function* () {
    const subject = yield* SubjectRaw
    const target = { applicationId: context.runtime.identity.applicationId, guildId: context.ids.guildId }
    if (isRaw(probe)) {
      yield* ensureBase(context)
      const answer: Answered<Schema.Json> = yield* sendJson(subject, Registration.route, "POST", Registration.pathOf(target), rawBodies[probe], deadline)
      return answer._tag === "Rejected"
        ? { observation: rejected(answer.response), raw: Outcome.rejected(answer.response), created: [] }
        : { observation: succeeded, raw: Outcome.ok([]), created: [] }
    }
    if (isSync(probe)) {
      const field = mutatedFieldOf(probe)
      if (field === undefined) yield* ensureBase(context)
      const pacing = yield* Pacing
      const before = commandWrites(yield* pacing.stats)
      const outcome = yield* library(context, [field === undefined ? baseCommand : mutations[field]])
      const after = commandWrites(yield* pacing.stats)
      if (outcome._tag === "Refused") return { observation: rejected(outcome.response), raw: Outcome.rejected(outcome.response), created: [] }
      return { observation: { _tag: "Writes", count: after - before }, raw: Outcome.ok([]), created: [] }
    }
    switch (probe) {
      case "typed-register-options":
        return yield* registered(context, [optionsCommand])
      case "typed-register-subcommands":
        return yield* registered(context, [nestedCommand])
      case "typed-register-choices": {
        const outcome = yield* registered(context, [baseCommand])
        if (outcome.observation._tag !== "Succeeded") return outcome
        // the stored options, read back and compared field by field with the definition as written (R-options-typed)
        const listed = yield* sendJson(subject, Registration.route, "GET", Registration.pathOf(target), undefined, deadline)
        if (listed._tag === "Rejected") return yield* Effect.die(new Error(`probe: the registered commands could not be read: ${listed.response.status} ${listed.response.code}`))
        const stored = yield* Schema.decodeUnknownEffect(Schema.Array(StoredCommand))(listed.body).pipe(Effect.orDie)
        const mine = Option.fromUndefinedOr(stored.find((command) => command["name"] === labCommandName))
        const applied = Option.isSome(mine) && storedAsDefined(baseCommand.definition.options, mine.value)
        return { observation: { _tag: applied ? "Applied" : "Ignored", field: "options" }, raw: Outcome.ok([]), created: [] }
      }
    }
  })
