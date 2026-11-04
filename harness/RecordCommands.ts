/**
 * `harness/main.ts record-commands` (DESIGN §8 item 11, §6 M8): records how Discord stores commands, for the
 * canonicaliser (`src/commands/Canonical.ts`).
 *
 * The subject overwrites its Perms Lab commands with the recording samples (`catalog/commands.ts`), as the library
 * sends them (`Canonical.toDiscord`), reads them back with a GET, and writes `fixtures/commands-canonical.json`: for
 * each sample, what was sent and what Discord stored, with the snowflakes Discord assigns (`id`, `application_id`,
 * `guild_id`, `version`) replaced by placeholders, so the fixture holds no IDs and a re-recording diffs only where
 * Discord's storage changed. It then overwrites the commands with none. Run it on minisforum under the lock, like every
 * live command; it creates the three samples, which the command-create budget counts.
 */
import { BunFileSystem } from "@effect/platform-bun"
import { Duration, Effect, FileSystem, Schema } from "effect"
import { SubjectRaw } from "../src/bot/Internals.ts"
import { StoredCommand, toDiscord } from "../src/commands/Canonical.ts"
import { pathOf, route } from "../src/commands/Registration.ts"
import { sendJson } from "../src/rest/Request.ts"
import type { IdentityReport } from "./IdentityCheck.ts"
import { recordingSamples } from "./scenario/catalog/commands.ts"

/** The fixture this command writes. */
export const fixturePath = new URL("../fixtures/commands-canonical.json", import.meta.url).pathname

/** One recorded sample: the JSON sent, and the JSON Discord stored. */
export const RecordedCommand = Schema.Struct({ sent: Schema.JsonObject, stored: Schema.JsonObject })

/** The fixture: the recorded samples, in the samples' order. */
export const CommandsFixture = Schema.Struct({ commands: Schema.Array(RecordedCommand) })
export interface CommandsFixture extends Schema.Schema.Type<typeof CommandsFixture> {}

/** The placeholder each server-assigned snowflake field is recorded as. */
export const placeholders: Readonly<Record<string, string>> = {
  id: "{command.id}",
  application_id: "{application.id}",
  guild_id: "{guild.id}",
  version: "{version}"
}

/** `stored` with its server-assigned snowflakes replaced by {@link placeholders} (top level only, where Discord puts them). */
export const withPlaceholders = (stored: Schema.JsonObject): Schema.JsonObject =>
  Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, placeholders[key] ?? value] as const))

const deadline = Duration.seconds(30)

const answerOrDie = (what: string) => <A>(answer: { readonly _tag: "Ok"; readonly body: A } | { readonly _tag: "Rejected"; readonly response: { readonly status: number; readonly code: number; readonly message: string } }) =>
  answer._tag === "Ok" ? Effect.succeed(answer.body) : Effect.die(new Error(`record-commands: ${what}: ${answer.response.status} ${answer.response.code} ${answer.response.message}`))

/** Records the samples (see the module comment) and returns the fixture written. */
export const run = (report: IdentityReport) =>
  Effect.gen(function* () {
    const subject = yield* SubjectRaw
    const target = { applicationId: report.subject.applicationId, guildId: report.guild.id }
    const sent = recordingSamples.map((command) => toDiscord(command.definition))
    const transient = (what: string) => (error: { readonly _tag: string }) => Effect.die(new Error(`infrastructure abort: record-commands: ${what}: ${error._tag}`))
    yield* sendJson(subject, route, "PUT", pathOf(target), sent, deadline).pipe(Effect.catch(transient("overwrite")), Effect.flatMap(answerOrDie("overwrite")))
    const listed = yield* sendJson(subject, route, "GET", pathOf(target), undefined, deadline).pipe(Effect.catch(transient("list")), Effect.flatMap(answerOrDie("list")))
    const stored = yield* Schema.decodeUnknownEffect(Schema.Array(StoredCommand))(listed).pipe(Effect.orDie)
    const commands = yield* Effect.forEach(sent, (command) => {
      const match = stored.find((entry) => entry["name"] === command["name"])
      return match === undefined
        ? Effect.die(new Error(`record-commands: Discord stores no command named ${String(command["name"])}`))
        : Effect.succeed({ sent: command, stored: withPlaceholders(match) })
    })
    const fixture: CommandsFixture = { commands }
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(fixturePath, `${JSON.stringify(Schema.encodeSync(CommandsFixture)(fixture), null, 2)}\n`)
    yield* sendJson(subject, route, "PUT", pathOf(target), [], deadline).pipe(Effect.catch(transient("clear")), Effect.flatMap(answerOrDie("clear")))
    return fixture
  }).pipe(Effect.provide(BunFileSystem.layer))
