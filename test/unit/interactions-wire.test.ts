import { describe, expect, it } from "@effect/vitest"
import { DiscordREST } from "dfx/DiscordREST"
import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect"
import type { Runtime } from "../../src/bot/Runtime.ts"
import { coreOf } from "../../src/channels/Ops.ts"
import { Command } from "../../src/commands/Command.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import * as DiscordApi from "../../src/rest/DiscordApi.ts"
import { ApplicationId } from "../../src/Snowflake.ts"
import { CommandData, focusedOf, invocationOf, type Malformed, modalFields } from "../../src/interactions/Wire.ts"
import { json, scriptedRest } from "../support/fakeDiscord.ts"
import { botId, channel, everyone, guildId, role, set, textId } from "../support/guild.ts"
import { snapshotOf, stubGuildState } from "../support/guildStateStub.ts"

/**
 * An invocation decoded against the command's own definition (DESIGN §2.8, §4.14): the shape `Command.*` computed,
 * each value of its option's type, and anything that does not fit the definition `Malformed` (Q-18's offline half: the
 * option values a handler receives, decoded from Discord's payload).
 */
/** A runtime the decoder builds channel handles over (nothing here runs an operation or reads an event). */
const makeRuntime = Effect.gen(function* () {
  const snapshot = snapshotOf({ roles: [role(everyone, set("ViewChannel"), 0)], channels: [channel("text")], botRoles: [] })
  const stub = yield* stubGuildState(snapshot, snapshot)
  const api = yield* DiscordApi.make(yield* DiscordREST, stub.state)
  const runtime: Runtime = {
    identity: { userId: botId, username: "bot", applicationId: ApplicationId.make("100000000000000002"), applicationFlags: 0, guildRoles: [] },
    intents: [],
    guildId,
    guildState: stub.state,
    api,
    events: { subscribe: () => Effect.void }
  }
  return runtime
}).pipe(Effect.provide(scriptedRest(() => json(404, { message: "404: Not Found", code: 0 }))))

const ban = Command.chatInput({
  name: "ban",
  description: "d",
  options: [
    { type: "user", name: "user", description: "d", required: true },
    { type: "string", name: "reason", description: "d", choices: [{ name: "Spam", value: "spam" }] },
    { type: "channel", name: "log", description: "d", channelTypes: ["text"] },
    { type: "integer", name: "days", description: "d" },
    { type: "boolean", name: "quiet", description: "d" },
    { type: "role", name: "role", description: "d" },
    { type: "number", name: "ratio", description: "d" }
  ]
})
const admin = Command.withSubcommands({
  name: "admin",
  description: "d",
  subcommands: [
    { type: "subcommand", name: "warn", description: "d", options: [{ type: "user", name: "user", description: "d", required: true }] },
    { type: "group", name: "role", description: "d", subcommands: [{ type: "subcommand", name: "add", description: "d", options: [{ type: "role", name: "role", description: "d", required: true }] }] }
  ]
})

const data = (name: string, options: ReadonlyArray<unknown>, channels: Record<string, { readonly id: string; readonly type: number; readonly permissions?: string }> = {}): CommandData =>
  Schema.decodeUnknownSync(CommandData)({ name, type: 1, options, resolved: { channels } })

const decode = (command: typeof ban | typeof admin, payload: CommandData) => Effect.flatMap(makeRuntime, (runtime) => Effect.exit(invocationOf(runtime, guildId, command.definition, payload)))

/** A decoded invocation's option by name (the decoder returns `unknown`; the handler sees it typed). */
const optionOf = (value: unknown, name: string): unknown =>
  Predicate.hasProperty(value, "options") && Predicate.isObject(value.options) && Predicate.hasProperty(value.options, name) ? value.options[name] : undefined
const malformedDetail = <A>(exit: Exit.Exit<A, Malformed>): string => {
  if (!Exit.isFailure(exit)) return ""
  const failure = Cause.findErrorOption(exit.cause)
  return Option.isSome(failure) ? failure.value.detail : ""
}

describe("invocationOf", () => {
  it.effect("decodes every option type, a channel option as a handle of its kind whose preflight reads the resolved channel's permissions", () =>
    Effect.gen(function* () {
      const exit = yield* decode(
        ban,
        data(
          "ban",
          [
            { name: "user", type: 6, value: "200000000000000077" },
            { name: "reason", type: 3, value: "spam" },
            { name: "log", type: 7, value: textId },
            { name: "days", type: 4, value: 3 },
            { name: "quiet", type: 5, value: true },
            { name: "role", type: 8, value: "400000000000000001" },
            { name: "ratio", type: 10, value: 0.5 }
          ],
          { [textId]: { id: textId, type: 0, permissions: String(set("ViewChannel")) } }
        )
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) return
      expect(exit.value).toMatchObject({ options: { user: { id: "200000000000000077" }, reason: "spam", days: 3, quiet: true, role: { id: "400000000000000001" }, ratio: 0.5 } })
      const log = optionOf(exit.value, "log")
      expect(Predicate.hasProperty(log, "kind") ? log.kind : undefined).toBe("text")
      const core = Predicate.isObject(log) ? coreOf(log) : undefined
      expect(core?.basis).toBe("app-permissions")
      expect(core?.appPermissions === undefined ? undefined : Flags.toSortedNames(core.appPermissions)).toEqual(["ViewChannel"])
    })
  )

  it.effect("decodes a subcommand and a grouped subcommand as { group, subcommand, options }", () =>
    Effect.gen(function* () {
      const warn = yield* decode(admin, data("admin", [{ name: "warn", type: 1, options: [{ name: "user", type: 6, value: "200000000000000077" }] }]))
      expect(Exit.isSuccess(warn) ? warn.value : undefined).toEqual({ group: undefined, subcommand: "warn", options: { user: { id: "200000000000000077" } } })
      const add = yield* decode(admin, data("admin", [{ name: "role", type: 2, options: [{ name: "add", type: 1, options: [{ name: "role", type: 8, value: "400000000000000001" }] }] }]))
      expect(Exit.isSuccess(add) ? add.value : undefined).toEqual({ group: "role", subcommand: "add", options: { role: { id: "400000000000000001" } } })
    })
  )

  it.effect("is Malformed when the payload does not fit the definition", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, CommandData, string]> = [
        ["a missing required option", data("ban", []), "required option user is missing"],
        ["a value of another type", data("ban", [{ name: "user", type: 6, value: "200000000000000077" }, { name: "days", type: 4, value: 1.5 }]), "option days is not an integer"],
        ["a choice the definition does not list", data("ban", [{ name: "user", type: 6, value: "200000000000000077" }, { name: "reason", type: 3, value: "other" }]), "not one of its choices"],
        ["an option the definition does not have", data("ban", [{ name: "user", type: 6, value: "200000000000000077" }, { name: "extra", type: 3, value: "x" }]), "option extra is not in the definition"],
        ["an option type that differs", data("ban", [{ name: "user", type: 3, value: "200000000000000077" }]), "option user has type 3, not user"],
        [
          "a channel of a kind the option does not allow",
          data("ban", [{ name: "user", type: 6, value: "200000000000000077" }, { name: "log", type: 7, value: textId }], { [textId]: { id: textId, type: 2 } }),
          "a voice channel, which the option does not allow"
        ],
        ["a channel not in resolved", data("ban", [{ name: "user", type: 6, value: "200000000000000077" }, { name: "log", type: 7, value: textId }]), "is not in resolved"],
        ["another command", data("kick", []), "command kick (type 1) is not ban"],
        ["an unknown subcommand", data("admin", [{ name: "mute", type: 1 }]), "subcommand mute is not in the definition"]
      ]
      for (const [what, payload, detail] of cases) {
        const exit = yield* decode(payload.name === "admin" ? admin : ban, payload)
        expect([what, malformedDetail(exit)]).toEqual([what, expect.stringContaining(detail)])
      }
    })
  )
})

describe("focusedOf and modalFields", () => {
  it("finds the focused option at any depth, and reads a modal's text inputs by custom_id", () => {
    expect(focusedOf([{ name: "role", type: 2, options: [{ name: "add", type: 1, options: [{ name: "q", type: 3, value: "ab", focused: true }] }] }])).toEqual({ name: "q", value: "ab" })
    expect(focusedOf([{ name: "q", type: 3, value: "ab" }])).toBeUndefined()
    expect(modalFields({ custom_id: "f:1", components: [{ type: 1, components: [{ type: 4, custom_id: "why", value: "busy" }] }, { type: 18, component: { type: 4, custom_id: "how", value: "fast" } }] })).toEqual(
      new Map([
        ["why", "busy"],
        ["how", "fast"]
      ])
    )
  })
})
