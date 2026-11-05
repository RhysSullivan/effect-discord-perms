/**
 * INTERACTION_CREATE as the runner decodes it (DESIGN §4.14, phase 3), and the invocation a command handler receives,
 * decoded against the command's own definition.
 *
 * Discord's payload is external input: anything that does not decode, or a command invocation that does not fit the
 * definition the library registered (a missing required option, a value of another type, a choice the definition
 * does not list, a channel of a kind the option does not allow), is a `Malformed` interaction the runner logs and
 * drops. A `custom_id` whose route does not decode is not malformed: it is an old control (`CustomId.ts`).
 */
import { Effect, Option, Schema } from "effect"
import type { GuildChannelKind } from "../channels/Channel.ts"
import { channelHandle, type Runtime } from "../channels/Ops.ts"
import type { CommandDefinition, OptionLike, SubcommandDef, ValueOption } from "../commands/Command.ts"
import * as Flags from "../permissions/Flags.ts"
import { ApplicationId, ChannelId, GuildId, InteractionId, MessageId, RoleId, UserId } from "../Snowflake.ts"
import { kindOfType } from "../state/Snapshot.ts"

/** An interaction the runner cannot use: it does not decode, or it does not fit the registered definition. */
export class Malformed extends Schema.TaggedError<Malformed>()("Malformed", { detail: Schema.String }) {}

/** Discord's interaction types (interactions/receiving-and-responding.mdx). */
export const InteractionType = { command: 2, component: 3, autocomplete: 4, modalSubmit: 5 } as const

/** One option of an invocation as Discord sends it (subcommands and groups nest their options). */
export interface OptionWire {
  readonly name: string
  readonly type: number
  readonly value?: string | number | boolean
  readonly options?: ReadonlyArray<OptionWire>
  readonly focused?: boolean
}
const OptionWire: Schema.Codec<OptionWire> = Schema.Struct({
  name: Schema.String,
  type: Schema.Int,
  value: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  options: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<OptionWire> => OptionWire))),
  focused: Schema.optionalKey(Schema.Boolean)
})

const ResolvedChannel = Schema.Struct({ id: ChannelId, type: Schema.Int, permissions: Schema.optionalKey(Schema.String) })

/** A chat-input command's data (and an autocomplete's, which carries the focused option). */
export const CommandData = Schema.Struct({
  name: Schema.String,
  type: Schema.Int,
  options: Schema.optionalKey(Schema.Array(OptionWire)),
  resolved: Schema.optionalKey(Schema.Struct({ channels: Schema.optionalKey(Schema.Record(Schema.String, ResolvedChannel)) }))
})
export interface CommandData extends Schema.Schema.Type<typeof CommandData> {}

/** A component's data. */
export const ComponentData = Schema.Struct({ custom_id: Schema.String, component_type: Schema.Int, values: Schema.optionalKey(Schema.Array(Schema.String)) })

const TextInputWire = Schema.Struct({ type: Schema.Int, custom_id: Schema.optionalKey(Schema.String), value: Schema.optionalKey(Schema.String) })

/** A modal submit's data: its `custom_id` and its text inputs' values, in action rows. */
export const ModalData = Schema.Struct({
  custom_id: Schema.String,
  components: Schema.Array(Schema.Struct({ type: Schema.Int, components: Schema.optionalKey(Schema.Array(TextInputWire)), component: Schema.optionalKey(TextInputWire) }))
})

/** The fields of INTERACTION_CREATE the runner reads. */
export const InteractionWire = Schema.Struct({
  id: InteractionId,
  application_id: ApplicationId,
  type: Schema.Int,
  token: Schema.String,
  guild_id: Schema.optionalKey(GuildId),
  channel: Schema.optionalKey(Schema.Struct({ id: ChannelId, type: Schema.Int })),
  member: Schema.optionalKey(Schema.Struct({ user: Schema.Struct({ id: UserId }) })),
  user: Schema.optionalKey(Schema.Struct({ id: UserId })),
  app_permissions: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.Struct({ id: MessageId })),
  data: Schema.optionalKey(Schema.Unknown)
})
export interface InteractionWire extends Schema.Schema.Type<typeof InteractionWire> {}

/** Decodes `data` with `schema`, or fails with `Malformed` naming `what`. */
export const decodeAs = <S extends Schema.Decoder<unknown>>(schema: S, what: string, data: unknown): Effect.Effect<S["Type"], Malformed> =>
  Schema.decodeUnknownEffect(schema)(data).pipe(Effect.mapError((error) => new Malformed({ detail: `${what}: ${error.message}` })))

/** A modal submit's text input values by `custom_id`. */
export const modalFields = (data: typeof ModalData.Type): ReadonlyMap<string, string> => {
  const fields = new Map<string, string>()
  for (const row of data.components) {
    for (const input of [...(row.components ?? []), ...(row.component === undefined ? [] : [row.component])]) {
      if (input.custom_id !== undefined && input.value !== undefined) fields.set(input.custom_id, input.value)
    }
  }
  return fields
}

/** The option, at any depth, an autocomplete is for (`focused`). */
export const focusedOf = (options: ReadonlyArray<OptionWire>): { readonly name: string; readonly value: string } | undefined => {
  for (const option of options) {
    if (option.focused === true) return { name: option.name, value: option.value === undefined ? "" : String(option.value) }
    const nested = focusedOf(option.options ?? [])
    if (nested !== undefined) return nested
  }
  return undefined
}

/** What a channel option's handle is built from. */
interface Place {
  readonly runtime: Runtime
  readonly guildId: GuildId
  readonly resolved: CommandData["resolved"]
}

const malformed = (detail: string) => Effect.fail(new Malformed({ detail }))

const optionTypeOf: { readonly [K in ValueOption["type"]]: number } = { string: 3, integer: 4, boolean: 5, user: 6, channel: 7, role: 8, number: 10 }

/** One value option's value as the handler receives it. */
const valueOf = (place: Place, option: ValueOption, wire: OptionWire): Effect.Effect<unknown, Malformed> => {
  const value = wire.value
  if (wire.type !== optionTypeOf[option.type]) return malformed(`option ${option.name} has type ${wire.type}, not ${option.type}`)
  const listed = option.type === "string" || option.type === "integer" || option.type === "number" ? option.choices : undefined
  const choices = listed !== undefined && listed.length > 0 ? listed.map((choice) => choice.value) : undefined
  if (choices !== undefined && (typeof value !== "string" && typeof value !== "number" ? true : !choices.some((choice) => choice === value))) return malformed(`option ${option.name}: ${String(value)} is not one of its choices`)
  switch (option.type) {
    case "string":
      return typeof value === "string" ? Effect.succeed(value) : malformed(`option ${option.name} is not a string`)
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? Effect.succeed(value) : malformed(`option ${option.name} is not an integer`)
    case "number":
      return typeof value === "number" ? Effect.succeed(value) : malformed(`option ${option.name} is not a number`)
    case "boolean":
      return typeof value === "boolean" ? Effect.succeed(value) : malformed(`option ${option.name} is not a boolean`)
    case "user":
      return Effect.map(decodeAs(UserId, `option ${option.name}`, value), (id) => ({ id }))
    case "role":
      return Effect.map(decodeAs(RoleId, `option ${option.name}`, value), (id) => ({ id }))
    case "channel":
      return Effect.gen(function* () {
        const resolved = typeof value === "string" ? place.resolved?.channels?.[value] : undefined
        if (resolved === undefined) return yield* malformed(`option ${option.name}: channel ${String(value)} is not in resolved`)
        const kind: GuildChannelKind | undefined = kindOfType(resolved.type)
        if (kind === undefined) return yield* malformed(`option ${option.name}: channel type ${resolved.type} is not a guild channel the library models`)
        const allowed = option.channelTypes !== undefined && option.channelTypes.length > 0 ? option.channelTypes : undefined
        if (allowed !== undefined && !allowed.includes(kind)) return yield* malformed(`option ${option.name}: a ${kind} channel, which the option does not allow`)
        // a resolved channel carries the bot's permissions in it (basis app-permissions, §4.7)
        const app = resolved.permissions === undefined ? undefined : Flags.parse(resolved.permissions)
        return channelHandle(place.runtime, { guildId: place.guildId, id: resolved.id, kind }, [], app)
      })
  }
}

/** The option values of one level, by name: every required option present, every value of its option's type. */
const optionsOf = (place: Place, definitions: ReadonlyArray<ValueOption>, wires: ReadonlyArray<OptionWire>): Effect.Effect<Readonly<Record<string, unknown>>, Malformed> =>
  Effect.gen(function* () {
    const out: Record<string, unknown> = {}
    for (const wire of wires) if (!definitions.some((definition) => definition.name === wire.name)) return yield* malformed(`option ${wire.name} is not in the definition`)
    for (const definition of definitions) {
      const wire = wires.find((candidate) => candidate.name === definition.name)
      if (wire === undefined) {
        if (definition.required === true) return yield* malformed(`required option ${definition.name} is missing`)
        continue
      }
      out[definition.name] = yield* valueOf(place, definition, wire)
    }
    return out
  })

const isValueOption = (option: OptionLike): option is ValueOption => option.type !== "subcommand" && option.type !== "group"

/**
 * The invocation of `definition` that `data` carries: `{ options }` for a command with value options, `{ group,
 * subcommand, options }` for one with subcommands (`Command.ts`'s `OptionsOf` and `SubsInvocation`).
 */
export const invocationOf = (runtime: Runtime, guildId: GuildId, definition: CommandDefinition, data: CommandData): Effect.Effect<unknown, Malformed> =>
  Effect.gen(function* () {
    if (data.type !== 1 || data.name !== definition.name) return yield* malformed(`command ${data.name} (type ${data.type}) is not ${definition.name}`)
    const place: Place = { runtime, guildId, resolved: data.resolved }
    const wires = data.options ?? []
    const values = definition.options.filter(isValueOption)
    if (values.length === definition.options.length) return { options: yield* optionsOf(place, values, wires) }
    const [first] = wires
    if (first === undefined || wires.length !== 1) return yield* malformed(`command ${definition.name} needs exactly one subcommand`)
    const subcommands: ReadonlyArray<SubcommandDef> = definition.options.flatMap((option) => (option.type === "subcommand" ? [option] : []))
    if (first.type === 1) {
      const sub = subcommands.find((candidate) => candidate.name === first.name)
      if (sub === undefined) return yield* malformed(`subcommand ${first.name} is not in the definition`)
      return { group: undefined, subcommand: sub.name, options: yield* optionsOf(place, sub.options ?? [], first.options ?? []) }
    }
    const group = Option.fromUndefinedOr(definition.options.find((candidate) => candidate.type === "group" && candidate.name === first.name))
    const [inner] = first.options ?? []
    if (first.type !== 2 || Option.isNone(group) || group.value.type !== "group" || inner === undefined || inner.type !== 1) return yield* malformed(`group ${first.name} is not in the definition`)
    const sub = group.value.subcommands.find((candidate) => candidate.name === inner.name)
    if (sub === undefined) return yield* malformed(`subcommand ${first.name} ${inner.name} is not in the definition`)
    return { group: group.value.name, subcommand: sub.name, options: yield* optionsOf(place, sub.options ?? [], inner.options ?? []) }
  })
