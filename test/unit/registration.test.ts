import { describe, expect, it } from "@effect/vitest"
import { DiscordConfig, DiscordRESTMemoryLive } from "dfx"
import { DiscordREST } from "dfx/DiscordREST"
import { Duration, Effect, Exit, Layer, Redacted, Ref, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { StartupFailed } from "../../src/bot/Startup.ts"
import type { GuildChannelKind } from "../../src/channels/Channel.ts"
import { type AnyChatInputCommand, Command } from "../../src/commands/Command.ts"
import { sync } from "../../src/commands/Registration.ts"
import { ApplicationId, GuildId } from "../../src/Snowflake.ts"

/**
 * Command registration (DESIGN §4.14, D18; R-registration-diff): over a fake of Discord's command store that stores as
 * the M8 recording showed (server-assigned IDs, `default_member_permissions: null`, `nsfw: false`, no `required: false`,
 * `channel_types` reordered), a sync writes once, an identical one only reads, each canonical field's change writes
 * exactly once, a store that keeps something else after the write is a defect, and each refusal is its
 * `StartupFailed`. The writes are counted at the base client, as the harness counts them live.
 */
const target = { applicationId: ApplicationId.make("100000000000000002"), guildId: GuildId.make("100000000000000001") }
const deadline = Duration.seconds(5)

type Json = Schema.Json
const isObject = (value: Json): value is Schema.JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * An option as Discord stores it: no `required: false`, `autocomplete: false`, `choices: []` or `channel_types: []`, and
 * `channel_types` in Discord's own order (reversed here).
 */
const storedOption = (option: Schema.JsonObject): Schema.JsonObject => {
  const { required, autocomplete, choices, channel_types, options, ...rest } = option
  return {
    ...rest,
    ...(required === true ? { required } : {}),
    ...(autocomplete === true ? { autocomplete } : {}),
    ...(Array.isArray(choices) && choices.length > 0 ? { choices } : {}),
    ...(Array.isArray(channel_types) && channel_types.length > 0 ? { channel_types: [...channel_types].reverse() } : {}),
    ...(Array.isArray(options) ? { options: options.filter(isObject).map(storedOption) } : {})
  }
}
const storedCommand = (command: Schema.JsonObject, index: number): Schema.JsonObject => ({
  id: `20000000000000000${index}`,
  application_id: target.applicationId,
  version: `30000000000000000${index}`,
  default_member_permissions: null,
  guild_id: target.guildId,
  nsfw: false,
  ...storedOption(command)
})

interface Store {
  readonly layer: Layer.Layer<DiscordREST>
  readonly writes: Effect.Effect<number>
  readonly requests: Effect.Effect<ReadonlyArray<string>>
  readonly set: (commands: ReadonlyArray<Schema.JsonObject>) => Effect.Effect<void>
}

/**
 * A fake command store. `onPut` answers a bulk overwrite instead of storing it (a refusal), and `tamper` changes what is
 * stored after a write (a field the canonicaliser does not model).
 */
const makeStore = (
  options: {
    readonly onGet?: { readonly status: number; readonly body: Json }
    readonly onPut?: { readonly status: number; readonly body: Json }
    readonly tamper?: (stored: Schema.JsonObject) => Schema.JsonObject
  } = {}
) =>
  Effect.gen(function* () {
    const stored = yield* Ref.make<ReadonlyArray<Schema.JsonObject>>([])
    const log = yield* Ref.make<ReadonlyArray<string>>([])
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const path = new URL(request.url).pathname.replace(/^\/api\/v\d+/, "")
        yield* Ref.update(log, (all) => [...all, `${request.method} ${path}`])
        const answer = (status: number, json: Json) => HttpClientResponse.fromWeb(request, new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }))
        if (path !== `/applications/${target.applicationId}/guilds/${target.guildId}/commands`) return answer(404, { message: "404: Not Found", code: 0 })
        if (request.method === "GET") return options.onGet === undefined ? answer(200, yield* Ref.get(stored)) : answer(options.onGet.status, options.onGet.body)
        if (request.method !== "PUT" || request.body._tag !== "Uint8Array") return answer(405, { message: "405: Method Not Allowed", code: 0 })
        if (options.onPut !== undefined) return answer(options.onPut.status, options.onPut.body)
        const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.JsonObject)))(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie)
        const next = body.map(storedCommand).map(options.tamper ?? ((command) => command))
        yield* Ref.set(stored, next)
        return answer(200, next)
      })
    )
    const layer = DiscordRESTMemoryLive.pipe(Layer.provide(DiscordConfig.layer({ token: Redacted.make("fake-token") })), Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))
    const store: Store = {
      layer,
      writes: Effect.map(Ref.get(log), (all) => all.filter((entry) => !entry.startsWith("GET ")).length),
      requests: Ref.get(log),
      set: (commands) => Ref.set(stored, commands.map(storedCommand))
    }
    return store
  })

const syncWith = (store: Store, commands: ReadonlyArray<AnyChatInputCommand>) => Effect.flatMap(Effect.service(DiscordREST), (rest) => sync(rest, target, commands, deadline)).pipe(Effect.provide(store.layer))

const base = Command.chatInput({
  name: "lab-command-name-at-the-32-limit",
  description: "Perms Lab: the registration probe",
  options: [
    { type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] },
    { type: "integer", name: "days", description: "history", minValue: 0, maxValue: 7 },
    { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] },
    { type: "boolean", name: "quiet", description: "no notice", required: false }
  ]
})
const nested = Command.withSubcommands({
  name: "lab-nested",
  description: "Perms Lab: nested",
  subcommands: [
    { type: "subcommand", name: "warn", description: "warn", options: [{ type: "user", name: "user", description: "who", required: true }] },
    { type: "group", name: "role", description: "roles", subcommands: [{ type: "subcommand", name: "add", description: "add", options: [{ type: "role", name: "role", description: "r", required: true }] }] }
  ]
})

/** One definition for every canonical field changed from `base` and `nested` (each must cost one write). */
const mutations: ReadonlyArray<readonly [field: string, commands: ReadonlyArray<AnyChatInputCommand>]> = [
  ["the command's name", [Command.chatInput({ ...base.definition, name: "lab-command-renamed", options: [] }), nested]],
  ["the command's description", [Command.chatInput({ name: "lab-command-name-at-the-32-limit", description: "changed", options: base.definition.options }), nested]],
  ["an option's required", [Command.chatInput({ name: "lab-command-name-at-the-32-limit", description: "Perms Lab: the registration probe", options: [{ type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] }, { type: "integer", name: "days", description: "history", required: true, minValue: 0, maxValue: 7 }] }), nested]],
  ["a choice's value", [Command.chatInput({ name: "lab-command-name-at-the-32-limit", description: "Perms Lab: the registration probe", options: [{ type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "other" }] }, { type: "integer", name: "days", description: "history", minValue: 0, maxValue: 7 }, { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] }, { type: "boolean", name: "quiet", description: "no notice", required: false }] }), nested]],
  ["a choice added", [Command.chatInput({ name: "lab-command-name-at-the-32-limit", description: "Perms Lab: the registration probe", options: [{ type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }, { name: "Other", value: "other" }] }, { type: "integer", name: "days", description: "history", minValue: 0, maxValue: 7 }, { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] }, { type: "boolean", name: "quiet", description: "no notice", required: false }] }), nested]],
  ["channel_types", [Command.chatInput({ name: "lab-command-name-at-the-32-limit", description: "Perms Lab: the registration probe", options: [{ type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] }, { type: "integer", name: "days", description: "history", minValue: 0, maxValue: 7 }, { type: "channel", name: "log", description: "where", channelTypes: ["text"] }, { type: "boolean", name: "quiet", description: "no notice", required: false }] }), nested]],
  ["an option's max_value", [Command.chatInput({ name: "lab-command-name-at-the-32-limit", description: "Perms Lab: the registration probe", options: [{ type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] }, { type: "integer", name: "days", description: "history", minValue: 0, maxValue: 8 }, { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] }, { type: "boolean", name: "quiet", description: "no notice", required: false }] }), nested]],
  ["an option's type", [Command.chatInput({ name: "lab-command-name-at-the-32-limit", description: "Perms Lab: the registration probe", options: [{ type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] }, { type: "number", name: "days", description: "history", minValue: 0, maxValue: 7 }, { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] }, { type: "boolean", name: "quiet", description: "no notice", required: false }] }), nested]],
  ["a nested option's name", [base, Command.withSubcommands({ name: "lab-nested", description: "Perms Lab: nested", subcommands: [{ type: "subcommand", name: "warn", description: "warn", options: [{ type: "user", name: "member", description: "who", required: true }] }, { type: "group", name: "role", description: "roles", subcommands: [{ type: "subcommand", name: "add", description: "add", options: [{ type: "role", name: "role", description: "r", required: true }] }] }] })]],
  ["a grouped subcommand's description", [base, Command.withSubcommands({ name: "lab-nested", description: "Perms Lab: nested", subcommands: [{ type: "subcommand", name: "warn", description: "warn", options: [{ type: "user", name: "user", description: "who", required: true }] }, { type: "group", name: "role", description: "roles", subcommands: [{ type: "subcommand", name: "add", description: "give", options: [{ type: "role", name: "role", description: "r", required: true }] }] }] })]],
  ["a command removed", [base]]
]

const failureOf = <A>(exit: Exit.Exit<A, StartupFailed>) => (Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail") : undefined)

describe("command registration", () => {
  it.effect("writes once to register new commands, reading them back after, and only reads when they are already stored", () =>
    Effect.gen(function* () {
      const store = yield* makeStore()
      expect((yield* syncWith(store, [base, nested])).wrote).toBe(true)
      const path = `/applications/${target.applicationId}/guilds/${target.guildId}/commands`
      expect(yield* store.requests).toStrictEqual([`GET ${path}`, `PUT ${path}`, `GET ${path}`])
      expect(yield* syncWith(store, [base, nested])).toStrictEqual({ wrote: false, differences: [] })
      expect(yield* store.writes).toBe(1)
      // channel kinds in another order are the same set
      const kinds: ReadonlyArray<GuildChannelKind> = ["announcement", "text"]
      const reordered = Command.chatInput({ ...base.definition, name: "lab-command-name-at-the-32-limit", options: base.definition.options.map((option) => (option.type === "channel" ? { ...option, channelTypes: kinds } : option)) })
      expect((yield* syncWith(store, [reordered, nested])).wrote).toBe(false)
    }))

  it.effect("writes exactly once for each canonical field that changed (a property over the fields)", () =>
    Effect.gen(function* () {
      for (const [field, commands] of mutations) {
        const store = yield* makeStore()
        yield* syncWith(store, [base, nested])
        const before = yield* store.writes
        const synced = yield* syncWith(store, commands)
        expect([field, synced.wrote, (yield* store.writes) - before]).toStrictEqual([field, true, 1])
        expect(synced.differences.length, field).toBeGreaterThan(0)
        // and the changed definitions are then in place
        expect([field, (yield* syncWith(store, commands)).wrote]).toStrictEqual([field, false])
      }
    }))

  it.effect("overwrites a stored command whose default field was changed, and removes one the bot does not define", () =>
    Effect.gen(function* () {
      const store = yield* makeStore()
      yield* syncWith(store, [base])
      const listed = yield* Effect.flatMap(Effect.service(DiscordREST), (rest) => rest.listGuildApplicationCommands(target.applicationId, target.guildId)).pipe(Effect.provide(store.layer), Effect.orDie)
      expect(listed?.[0]?.nsfw).toBe(false)
      yield* store.set([{ type: 1, name: "lab-command-name-at-the-32-limit", description: "Perms Lab: the registration probe", options: [], default_member_permissions: "8" }])
      expect((yield* syncWith(store, [base])).differences).toStrictEqual(["lab-command-name-at-the-32-limit: default_member_permissions: absent locally, \"8\" registered"])
      yield* store.set([{ type: 1, name: "lab-other", description: "someone else's" }])
      expect((yield* syncWith(store, [base])).differences).toStrictEqual(["lab-command-name-at-the-32-limit: 1 local, 0 registered", "lab-other: 0 local, 1 registered"])
    }))

  it.effect("dies when Discord stores the commands differently from what was sent (a field the canonicaliser does not model)", () =>
    Effect.gen(function* () {
      const store = yield* makeStore({ tamper: (command) => (isObject(command) ? { ...command, integration_types: [0] } : command) })
      const exit = yield* Effect.exit(syncWith(store, [base]))
      expect(Exit.isFailure(exit) && failureOf(exit) === undefined).toBe(true)
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("integration_types: absent locally, [0] registered")
    }))

  it.effect("fails a refused overwrite with its StartupFailed: 50035 command-rejected with the field paths, 30034 daily-command-limit; a 5xx is discord-unavailable", () =>
    Effect.gen(function* () {
      const reasonOf = (onPut: { readonly status: number; readonly body: Json }) =>
        Effect.gen(function* () {
          const failure = failureOf(yield* Effect.exit(syncWith(yield* makeStore({ onPut }), [base])))
          return failure?._tag === "Fail" && failure.error instanceof StartupFailed ? [failure.error.reason, failure.error.detail] : undefined
        })
      const rejected = yield* reasonOf({
        status: 400,
        body: { code: 50035, message: "Invalid Form Body", errors: { "0": { name: { _errors: [{ code: "APPLICATION_COMMAND_INVALID_NAME", message: "Command name is invalid" }] } } } }
      })
      expect(rejected?.[0]).toBe("command-rejected")
      expect(rejected?.[1]).toContain("0.name APPLICATION_COMMAND_INVALID_NAME")
      expect((yield* reasonOf({ status: 400, body: { code: 30034, message: "Max number of daily application command creates has been reached (200)" } }))?.[0]).toBe("daily-command-limit")
      expect((yield* reasonOf({ status: 400, body: { code: 30032, message: "Maximum number of application commands reached" } }))?.[0]).toBe("command-rejected")
      expect((yield* reasonOf({ status: 503, body: { message: "unavailable", code: 0 } }))?.[0]).toBe("discord-unavailable")
    }))

  it.effect("only reads after registering a definition with false and empty values, which Discord drops (the recording)", () =>
    Effect.gen(function* () {
      const store = yield* makeStore()
      const defaults = Command.chatInput({
        name: "lab-defaults",
        description: "d",
        options: [
          { type: "string", name: "text", description: "d", autocomplete: false, choices: [] },
          { type: "integer", name: "count", description: "d", autocomplete: true },
          { type: "channel", name: "where", description: "d", channelTypes: [] }
        ]
      })
      expect((yield* syncWith(store, [defaults])).wrote).toBe(true)
      expect(yield* syncWith(store, [defaults])).toStrictEqual({ wrote: false, differences: [] })
    }))

  it.effect("fails a 401 on the listing or on the overwrite with invalid-token, writing nothing after a refused listing", () =>
    Effect.gen(function* () {
      const unauthorized = { status: 401, body: { code: 0, message: "401: Unauthorized" } }
      for (const options of [{ onGet: unauthorized }, { onPut: unauthorized }]) {
        const store = yield* makeStore(options)
        const failure = failureOf(yield* Effect.exit(syncWith(store, [base])))
        expect(failure?._tag === "Fail" && failure.error instanceof StartupFailed ? failure.error.reason : undefined).toBe("invalid-token")
        expect(yield* store.writes).toBe("onGet" in options ? 0 : 1)
      }
    }))

  it.effect("dies on an answer the route does not expect (an unmapped code)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(syncWith(yield* makeStore({ onPut: { status: 403, body: { code: 50001, message: "Missing Access" } } }), [base]))
      expect(Exit.isFailure(exit) && failureOf(exit) === undefined).toBe(true)
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("unmapped Discord answer 403 50001")
    }))
})
