/**
 * Command definitions as Discord JSON, and the canonical form registration compares (DESIGN §4.14, D18; open
 * question 11).
 *
 * - {@link toDiscord} is the JSON a definition is registered as: one element of the bulk overwrite
 *   (`PUT /applications/{application.id}/guilds/{guild.id}/commands`), with the option types and channel types as
 *   Discord numbers.
 * - {@link canonical} is the form two commands are compared in, applied alike to what the library sends and what
 *   Discord stores: the server-assigned fields (`id`, `application_id`, `guild_id`, `version`) are dropped; a field
 *   holding the default Discord fills in or echoes is dropped, but only with exactly that value
 *   ({@link commandDefaults}, {@link optionDefaults}, {@link choiceDefaults}), so a stored command whose field has
 *   been changed from the default compares as different and is overwritten; `channel_types` are sorted (a set: M8
 *   live, Discord stored `[5, 0, 11]` as `[0, 11, 5]`); and keys are sorted at every level. Any field Discord stores that the tables do not name is kept, so it compares as different
 *   too, and the check after a write (`Registration.ts`) turns that into a defect naming it.
 *
 * The defaults are those `fixtures/commands-canonical.json` recorded from a live GET of registered commands (M8,
 * `harness/main.ts record-commands`); `test/unit/canonical.test.ts` holds the tables to that recording.
 */
import { Schema } from "effect"
import { channelTypes } from "../state/Snapshot.ts"
import type { CommandDefinition, OptionLike } from "./Command.ts"

/** Discord's application command option type for each option kind (application-commands.mdx "Option Type"). */
export const optionTypes = { subcommand: 1, group: 2, string: 3, integer: 4, boolean: 5, user: 6, channel: 7, role: 8, number: 10 } as const

/** Discord's application command type for a chat-input command. */
export const chatInputType = 1

/** `{ [key]: value }`, or nothing when `value` is absent. */
const field = (key: string, value: Schema.Json | undefined): Schema.JsonObject => (value === undefined ? {} : { [key]: value })

const choicesOf = (choices: ReadonlyArray<{ readonly name: string; readonly value: string | number }> | undefined): ReadonlyArray<Schema.JsonObject> | undefined =>
  choices === undefined ? undefined : choices.map((choice) => ({ name: choice.name, value: choice.value }))

/** One option as Discord JSON. */
const optionJson = (option: OptionLike): Schema.JsonObject => {
  const head = { name: option.name, description: option.description }
  switch (option.type) {
    case "subcommand":
      return { type: optionTypes.subcommand, ...head, ...field("options", option.options === undefined || option.options.length === 0 ? undefined : option.options.map(optionJson)) }
    case "group":
      return { type: optionTypes.group, ...head, options: option.subcommands.map(optionJson) }
    case "string":
      return {
        type: optionTypes.string,
        ...head,
        ...field("required", option.required),
        ...field("choices", choicesOf(option.choices)),
        ...field("autocomplete", option.autocomplete),
        ...field("min_length", option.minLength),
        ...field("max_length", option.maxLength)
      }
    case "integer":
    case "number":
      return {
        type: optionTypes[option.type],
        ...head,
        ...field("required", option.required),
        ...field("choices", choicesOf(option.choices)),
        ...field("autocomplete", option.autocomplete),
        ...field("min_value", option.minValue),
        ...field("max_value", option.maxValue)
      }
    case "boolean":
    case "user":
    case "role":
      return { type: optionTypes[option.type], ...head, ...field("required", option.required) }
    case "channel":
      return {
        type: optionTypes.channel,
        ...head,
        ...field("required", option.required),
        ...field("channel_types", option.channelTypes === undefined ? undefined : option.channelTypes.map((kind) => channelTypes[kind]))
      }
  }
}

/** The JSON a chat-input definition is registered as (see the module comment). */
export const toDiscord = (definition: CommandDefinition): Schema.JsonObject => ({
  type: chatInputType,
  name: definition.name,
  description: definition.description,
  ...field("options", definition.options.length === 0 ? undefined : definition.options.map(optionJson))
})

/** Fields Discord assigns to a stored command; never compared. */
export const serverAssigned: ReadonlyArray<string> = ["id", "application_id", "guild_id", "version"]

/**
 * The command fields a stored command carries at their defaults, each with that default; dropped only when it holds
 * exactly this value. Recorded (M8, `fixtures/commands-canonical.json`): a guild command comes back with
 * `default_member_permissions: null` and `nsfw: false`, which the library never sends, and nothing else beyond what
 * was sent and the server-assigned fields (no `contexts`, `integration_types` or `dm_permission` on guild commands, and
 * no localizations from a GET without `with_localizations`).
 */
export const commandDefaults: Readonly<Record<string, Schema.Json>> = { default_member_permissions: null, nsfw: false }

/** The option fields at their defaults. Recorded: an option sent with `required: false` comes back without the field. */
export const optionDefaults: Readonly<Record<string, Schema.Json>> = { required: false }

/** The choice fields at their defaults. Recorded: a choice comes back exactly as sent. */
export const choiceDefaults: Readonly<Record<string, Schema.Json>> = {}

const isObject = (value: Schema.Json): value is Schema.JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)
const isArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value)

/** Whether two JSON values are equal (object keys in any order). */
export const sameJson = (a: Schema.Json, b: Schema.Json): boolean => jsonText(a) === jsonText(b)

/** A JSON value as text with every object's keys sorted, so equal values have equal text. */
export const jsonText = (value: Schema.Json): string => {
  if (isArray(value)) return `[${value.map(jsonText).join(",")}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jsonText(value[key] ?? null)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

/** `object` without the fields whose value is exactly their entry in `defaults`, and without `dropped`. */
const withoutDefaults = (object: Schema.JsonObject, defaults: Readonly<Record<string, Schema.Json>>, dropped: ReadonlyArray<string>): Record<string, Schema.Json> => {
  const kept: Record<string, Schema.Json> = {}
  for (const [key, value] of Object.entries(object)) {
    const fallback = defaults[key]
    if (dropped.includes(key) || (fallback !== undefined && sameJson(value, fallback))) continue
    kept[key] = value
  }
  return kept
}

const canonicalChoice = (choice: Schema.Json): Schema.Json => (isObject(choice) ? withoutDefaults(choice, choiceDefaults, []) : choice)

/** One option in canonical form: defaults dropped, an empty option list dropped, channel types sorted, nested options and choices canonical. */
const canonicalOption = (option: Schema.Json): Schema.Json => {
  if (!isObject(option)) return option
  const kept = withoutDefaults(option, optionDefaults, [])
  const options = kept["options"]
  if (options !== undefined && isArray(options)) {
    if (options.length === 0) delete kept["options"]
    else kept["options"] = options.map(canonicalOption)
  }
  const choices = kept["choices"]
  if (choices !== undefined && isArray(choices)) kept["choices"] = choices.map(canonicalChoice)
  const kinds = kept["channel_types"]
  if (kinds !== undefined && isArray(kinds)) kept["channel_types"] = [...kinds].sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : 0))
  return kept
}

/** A command (as sent, or as Discord stores it) in canonical form (see the module comment). */
export const canonical = (command: Schema.JsonObject): Schema.JsonObject => {
  const kept = withoutDefaults(command, commandDefaults, serverAssigned)
  const options = kept["options"]
  if (options !== undefined && isArray(options)) {
    if (options.length === 0) delete kept["options"]
    else kept["options"] = options.map(canonicalOption)
  }
  return kept
}

/** The name of a command in canonical form (the comparison's key). */
const nameOf = (command: Schema.JsonObject): string => {
  const name = command["name"]
  return typeof name === "string" ? name : jsonText(name ?? null)
}

/**
 * How two command sets differ, each command in canonical form and matched by name: one line per command present on
 * one side only or different on the two, naming its first differing field. Empty when the sets are equal.
 */
export const differences = (local: ReadonlyArray<Schema.JsonObject>, remote: ReadonlyArray<Schema.JsonObject>): ReadonlyArray<string> => {
  const byName = (commands: ReadonlyArray<Schema.JsonObject>) => {
    const map = new Map<string, Array<Schema.JsonObject>>()
    for (const command of commands.map(canonical)) map.set(nameOf(command), [...(map.get(nameOf(command)) ?? []), command])
    return map
  }
  const mine = byName(local)
  const theirs = byName(remote)
  const lines: Array<string> = []
  for (const name of [...new Set([...mine.keys(), ...theirs.keys()])].sort()) {
    const a = mine.get(name) ?? []
    const b = theirs.get(name) ?? []
    if (a.length !== 1 || b.length !== 1) {
      lines.push(`${name}: ${a.length} local, ${b.length} registered`)
      continue
    }
    const [left] = a
    const [right] = b
    if (left !== undefined && right !== undefined && !sameJson(left, right)) lines.push(`${name}: ${firstDifference(left, right, "")}`)
  }
  return lines
}

/** The first path at which `a` and `b` differ, with both values. */
const firstDifference = (a: Schema.Json, b: Schema.Json, path: string): string => {
  if (isObject(a) && isObject(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const left = a[key]
      const right = b[key]
      if (left === undefined || right === undefined) return `${path}${key}: ${left === undefined ? "absent" : jsonText(left)} locally, ${right === undefined ? "absent" : jsonText(right)} registered`
      if (!sameJson(left, right)) return firstDifference(left, right, `${path}${key}.`)
    }
  }
  if (isArray(a) && isArray(b) && a.length === b.length) {
    for (const [index, left] of a.entries()) {
      const right = b[index]
      if (right !== undefined && !sameJson(left, right)) return firstDifference(left, right, `${path}${index}.`)
    }
  }
  return `${path.replace(/\.$/, "") || "(whole)"}: ${jsonText(a)} locally, ${jsonText(b)} registered`
}

/** A registered command as Discord returns it: a JSON object (decoded at the boundary, `Registration.ts`). */
export const StoredCommand = Schema.JsonObject
