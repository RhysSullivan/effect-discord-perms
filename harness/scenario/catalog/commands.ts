/**
 * The command definitions of M8's live rows (DESIGN §5.5, §6 M8; pure). The registration rule pairs, the options
 * readback and the registration diff run as rule probes (`harness/Probes.ts`) on `catalog/rules.ts`'s `commands`
 * setup; their typed sides register the definitions here through the library (`Registration.sync`), and their raw
 * sides POST what the types forbid.
 *
 * **One command name.** Every registration but the three whose invalid part is the command's own name uses
 * {@link labCommandName}, 32 characters, the longest name allowed: the typed sides register it, and each raw side
 * first makes sure it is registered (a sync that writes nothing when it is), so a raw POST that Discord rejects is a
 * rejected update of an existing command, never a create (H-205: whether a rejected create counts toward the 200 a
 * day is open). The command-create budget (`harness/CommandBudget.ts`) counts what may still create.
 *
 * {@link recordingSamples} are the definitions `harness/main.ts record-commands` registers once to record how Discord
 * stores commands (`fixtures/commands-canonical.json`, open question 11), covering every field the library sends.
 */
import { Schema } from "effect"
import { type AnyChatInputCommand, Command } from "../../../src/commands/Command.ts"

/** The command name the registration rows share: 32 characters, lowercase, no spaces (H-190, H-191). */
export const labCommandName = "lab-command-name-at-the-32-limit"

/** The recording's definitions (see the module comment). */
export const recordingSamples: ReadonlyArray<AnyChatInputCommand> = [
  Command.chatInput({
    name: "lab-record-options",
    description: "Perms Lab: every option field",
    options: [
      { type: "string", name: "text", description: "a string", required: true, choices: [{ name: "One", value: "one" }, { name: "Two", value: "two" }] },
      { type: "integer", name: "count", description: "an integer", required: true, minValue: 1, maxValue: 10 },
      { type: "string", name: "free", description: "a string", minLength: 2, maxLength: 50, autocomplete: true },
      { type: "integer", name: "pick", description: "an integer", choices: [{ name: "Five", value: 5 }] },
      { type: "number", name: "ratio", description: "a number", minValue: 0, maxValue: 1.5 },
      { type: "boolean", name: "flag", description: "a boolean", required: false },
      { type: "user", name: "user", description: "a user" },
      { type: "role", name: "role", description: "a role" },
      { type: "channel", name: "where", description: "a channel", channelTypes: ["announcement", "text", "public-thread"] },
      { type: "channel", name: "anywhere", description: "any channel" }
    ]
  }),
  Command.withSubcommands({
    name: "lab-record-subcommands",
    description: "Perms Lab: subcommands and a group",
    subcommands: [
      { type: "subcommand", name: "plain", description: "no options" },
      { type: "subcommand", name: "with", description: "options", options: [{ type: "user", name: "user", description: "a user", required: true }] },
      {
        type: "group",
        name: "group",
        description: "a group",
        subcommands: [
          { type: "subcommand", name: "one", description: "one" },
          { type: "subcommand", name: "two", description: "two", options: [{ type: "boolean", name: "flag", description: "a boolean" }] }
        ]
      }
    ]
  }),
  Command.chatInput({ name: "lab-record-plain", description: "Perms Lab: no options" }),
  // before M9 (the M8 verifier): the false and empty values the types accept, and autocomplete on integer and number
  Command.chatInput({
    name: "lab-record-defaults",
    description: "Perms Lab: false and empty values",
    options: [
      { type: "string", name: "text", description: "a string", autocomplete: false, choices: [] },
      { type: "integer", name: "count", description: "an integer", autocomplete: true },
      { type: "number", name: "ratio", description: "a number", autocomplete: false, choices: [] },
      { type: "integer", name: "pick", description: "an integer", autocomplete: false },
      { type: "number", name: "share", description: "a number", autocomplete: true },
      { type: "channel", name: "where", description: "a channel", channelTypes: [] }
    ]
  })
]

/** The name of a subcommand at the limit, 32 characters (the nested side of the name rules). */
export const labSubcommandName = "lab-subcommand-at-the-32-chr-max"

/**
 * The top-level typed side of the registration rules: {@link labCommandName} with 25 value options, the required ones
 * first, every name lowercase (R-command-name-*, R-option-*, R-subcommand-mixing).
 */
export const optionsCommand = Command.chatInput({
  name: labCommandName,
  description: "Perms Lab: 25 value options",
  options: [
    { type: "user", name: "o1", description: "option 1", required: true },
    { type: "string", name: "o2", description: "option 2", required: true, choices: [{ name: "A", value: "a" }] },
    { type: "channel", name: "o3", description: "option 3", channelTypes: ["text"] },
    { type: "string", name: "o4", description: "option 4" },
    { type: "string", name: "o5", description: "option 5" },
    { type: "string", name: "o6", description: "option 6" },
    { type: "string", name: "o7", description: "option 7" },
    { type: "string", name: "o8", description: "option 8" },
    { type: "string", name: "o9", description: "option 9" },
    { type: "string", name: "o10", description: "option 10" },
    { type: "string", name: "o11", description: "option 11" },
    { type: "string", name: "o12", description: "option 12" },
    { type: "string", name: "o13", description: "option 13" },
    { type: "string", name: "o14", description: "option 14" },
    { type: "string", name: "o15", description: "option 15" },
    { type: "string", name: "o16", description: "option 16" },
    { type: "string", name: "o17", description: "option 17" },
    { type: "string", name: "o18", description: "option 18" },
    { type: "string", name: "o19", description: "option 19" },
    { type: "string", name: "o20", description: "option 20" },
    { type: "string", name: "o21", description: "option 21" },
    { type: "string", name: "o22", description: "option 22" },
    { type: "string", name: "o23", description: "option 23" },
    { type: "string", name: "o24", description: "option 24" },
    { type: "string", name: "o25", description: "option 25" }
  ]
})

/**
 * The nested typed side: {@link labCommandName} with 25 entries at the top (24 subcommands and a group), the group with
 * 25 subcommands, one of them named at 32 characters with 25 options, the required one first.
 */
export const nestedCommand = Command.withSubcommands({
  name: labCommandName,
  description: "Perms Lab: 25 subcommands, nested",
  subcommands: [
    { type: "subcommand", name: "s1", description: "subcommand 1", options: [{ type: "user", name: "user", description: "who", required: true }, { type: "string", name: "reason", description: "why" }] },
    { type: "subcommand", name: "s2", description: "subcommand 2" },
    { type: "subcommand", name: "s3", description: "subcommand 3" },
    { type: "subcommand", name: "s4", description: "subcommand 4" },
    { type: "subcommand", name: "s5", description: "subcommand 5" },
    { type: "subcommand", name: "s6", description: "subcommand 6" },
    { type: "subcommand", name: "s7", description: "subcommand 7" },
    { type: "subcommand", name: "s8", description: "subcommand 8" },
    { type: "subcommand", name: "s9", description: "subcommand 9" },
    { type: "subcommand", name: "s10", description: "subcommand 10" },
    { type: "subcommand", name: "s11", description: "subcommand 11" },
    { type: "subcommand", name: "s12", description: "subcommand 12" },
    { type: "subcommand", name: "s13", description: "subcommand 13" },
    { type: "subcommand", name: "s14", description: "subcommand 14" },
    { type: "subcommand", name: "s15", description: "subcommand 15" },
    { type: "subcommand", name: "s16", description: "subcommand 16" },
    { type: "subcommand", name: "s17", description: "subcommand 17" },
    { type: "subcommand", name: "s18", description: "subcommand 18" },
    { type: "subcommand", name: "s19", description: "subcommand 19" },
    { type: "subcommand", name: "s20", description: "subcommand 20" },
    { type: "subcommand", name: "s21", description: "subcommand 21" },
    { type: "subcommand", name: "s22", description: "subcommand 22" },
    { type: "subcommand", name: "s23", description: "subcommand 23" },
    { type: "subcommand", name: "s24", description: "subcommand 24" },
    {
      type: "group",
      name: "group",
      description: "a group of 25",
      subcommands: [
        {
          type: "subcommand",
          name: labSubcommandName,
          description: "25 options",
          options: [
            { type: "role", name: "n1", description: "nested option 1", required: true },
            { type: "string", name: "n2", description: "nested option 2" },
            { type: "string", name: "n3", description: "nested option 3" },
            { type: "string", name: "n4", description: "nested option 4" },
            { type: "string", name: "n5", description: "nested option 5" },
            { type: "string", name: "n6", description: "nested option 6" },
            { type: "string", name: "n7", description: "nested option 7" },
            { type: "string", name: "n8", description: "nested option 8" },
            { type: "string", name: "n9", description: "nested option 9" },
            { type: "string", name: "n10", description: "nested option 10" },
            { type: "string", name: "n11", description: "nested option 11" },
            { type: "string", name: "n12", description: "nested option 12" },
            { type: "string", name: "n13", description: "nested option 13" },
            { type: "string", name: "n14", description: "nested option 14" },
            { type: "string", name: "n15", description: "nested option 15" },
            { type: "string", name: "n16", description: "nested option 16" },
            { type: "string", name: "n17", description: "nested option 17" },
            { type: "string", name: "n18", description: "nested option 18" },
            { type: "string", name: "n19", description: "nested option 19" },
            { type: "string", name: "n20", description: "nested option 20" },
            { type: "string", name: "n21", description: "nested option 21" },
            { type: "string", name: "n22", description: "nested option 22" },
            { type: "string", name: "n23", description: "nested option 23" },
            { type: "string", name: "n24", description: "nested option 24" },
            { type: "string", name: "n25", description: "nested option 25" }
          ]
        },
        { type: "subcommand", name: "g2", description: "grouped 2" },
        { type: "subcommand", name: "g3", description: "grouped 3" },
        { type: "subcommand", name: "g4", description: "grouped 4" },
        { type: "subcommand", name: "g5", description: "grouped 5" },
        { type: "subcommand", name: "g6", description: "grouped 6" },
        { type: "subcommand", name: "g7", description: "grouped 7" },
        { type: "subcommand", name: "g8", description: "grouped 8" },
        { type: "subcommand", name: "g9", description: "grouped 9" },
        { type: "subcommand", name: "g10", description: "grouped 10" },
        { type: "subcommand", name: "g11", description: "grouped 11" },
        { type: "subcommand", name: "g12", description: "grouped 12" },
        { type: "subcommand", name: "g13", description: "grouped 13" },
        { type: "subcommand", name: "g14", description: "grouped 14" },
        { type: "subcommand", name: "g15", description: "grouped 15" },
        { type: "subcommand", name: "g16", description: "grouped 16" },
        { type: "subcommand", name: "g17", description: "grouped 17" },
        { type: "subcommand", name: "g18", description: "grouped 18" },
        { type: "subcommand", name: "g19", description: "grouped 19" },
        { type: "subcommand", name: "g20", description: "grouped 20" },
        { type: "subcommand", name: "g21", description: "grouped 21" },
        { type: "subcommand", name: "g22", description: "grouped 22" },
        { type: "subcommand", name: "g23", description: "grouped 23" },
        { type: "subcommand", name: "g24", description: "grouped 24" },
        { type: "subcommand", name: "g25", description: "grouped 25" }
      ]
    }
  ]
})

/**
 * The registration diff's base and R-options-typed's typed side: choices, required options before an optional channel
 * option with channel types, and an integer range.
 */
export const baseCommand = Command.chatInput({
  name: labCommandName,
  description: "Perms Lab: the registration probe",
  options: [
    { type: "user", name: "user", description: "who", required: true },
    { type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] },
    { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] },
    { type: "integer", name: "days", description: "history", minValue: 0, maxValue: 7 }
  ]
})

/**
 * The registration diff's mutations: each changes one canonical field of {@link baseCommand} (R-registration-diff), so
 * each differs from the base, from every other mutation and from every other definition the catalog registers.
 */
export const mutations = {
  description: Command.chatInput({
    name: labCommandName,
    description: "Perms Lab: the registration probe, changed",
    options: [
      { type: "user", name: "user", description: "who", required: true },
      { type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] },
      { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] },
      { type: "integer", name: "days", description: "history", minValue: 0, maxValue: 7 }
    ]
  }),
  required: Command.chatInput({
    name: labCommandName,
    description: "Perms Lab: the registration probe",
    options: [
      { type: "user", name: "user", description: "who", required: true },
      { type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] },
      { type: "channel", name: "log", description: "where", required: true, channelTypes: ["text", "announcement"] },
      { type: "integer", name: "days", description: "history", minValue: 0, maxValue: 7 }
    ]
  }),
  choices: Command.chatInput({
    name: labCommandName,
    description: "Perms Lab: the registration probe",
    options: [
      { type: "user", name: "user", description: "who", required: true },
      { type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }, { name: "Other", value: "other" }] },
      { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] },
      { type: "integer", name: "days", description: "history", minValue: 0, maxValue: 7 }
    ]
  }),
  "channel-types": Command.chatInput({
    name: labCommandName,
    description: "Perms Lab: the registration probe",
    options: [
      { type: "user", name: "user", description: "who", required: true },
      { type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] },
      { type: "channel", name: "log", description: "where", channelTypes: ["text"] },
      { type: "integer", name: "days", description: "history", minValue: 0, maxValue: 7 }
    ]
  }),
  "option-name": Command.chatInput({
    name: labCommandName,
    description: "Perms Lab: the registration probe",
    options: [
      { type: "user", name: "user", description: "who", required: true },
      { type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] },
      { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] },
      { type: "integer", name: "history", description: "history", minValue: 0, maxValue: 7 }
    ]
  }),
  name: Command.chatInput({
    name: "lab-command-renamed",
    description: "Perms Lab: the registration probe",
    options: [
      { type: "user", name: "user", description: "who", required: true },
      { type: "string", name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] },
      { type: "channel", name: "log", description: "where", channelTypes: ["text", "announcement"] },
      { type: "integer", name: "days", description: "history", minValue: 0, maxValue: 7 }
    ]
  })
} as const satisfies Readonly<Record<string, AnyChatInputCommand>>

/** A field the registration diff mutates. */
export type MutatedField = keyof typeof mutations

/** The mutated fields, in a fixed order. */
export const mutatedFields: ReadonlyArray<MutatedField> = ["channel-types", "choices", "description", "name", "option-name", "required"]

/** A command name of `length` characters, lowercase and without spaces, for the raw sides at and past the limit. */
export const nameOfLength = (length: number): string => `lab-${"n".repeat(length - 4)}`

/** A raw command body: {@link labCommandName} with these options (the raw sides POST what the types forbid). */
export const rawCommand = (options: ReadonlyArray<Schema.Json>, name: string = labCommandName): Schema.JsonObject => ({ type: 1, name, description: "Perms Lab: a raw registration", options: [...options] })

/** `count` string options named `prefix1`..: one past the limit is 26. */
export const rawOptions = (count: number, prefix = "o"): ReadonlyArray<Schema.JsonObject> =>
  Array.from({ length: count }, (_, index) => ({ type: 3, name: `${prefix}${index + 1}`, description: "d" }))

/** `count` subcommands named `s1`..: one past the limit is 26. */
export const rawSubcommands = (count: number): ReadonlyArray<Schema.JsonObject> =>
  Array.from({ length: count }, (_, index) => ({ type: 1, name: `s${index + 1}`, description: "d" }))

/**
 * The raw sides' bodies (Discord JSON), each what a rule's types forbid and otherwise valid, every one but the three
 * whose command name is the forbidden part on {@link labCommandName}.
 */
export const rawBodies = {
  "raw-command-name-upper": rawCommand([], "Lab-command-name-upper"),
  "raw-command-name-space": rawCommand([], "lab command"),
  "raw-command-name-33": rawCommand([], nameOfLength(33)),
  "raw-subcommand-name-upper": rawCommand([{ type: 1, name: "Sub", description: "d" }]),
  "raw-subcommand-name-space": rawCommand([{ type: 1, name: "lab sub", description: "d" }]),
  "raw-subcommand-name-33": rawCommand([{ type: 1, name: nameOfLength(33), description: "d" }]),
  "raw-option-name-upper": rawCommand([{ type: 3, name: "Reason", description: "why" }]),
  "raw-option-name-upper-nested": rawCommand([{ type: 1, name: "ban", description: "d", options: [{ type: 6, name: "User", description: "who" }] }]),
  "raw-option-order": rawCommand([{ type: 3, name: "reason", description: "why" }, { type: 6, name: "user", description: "who", required: true }]),
  "raw-option-order-nested": rawCommand([{ type: 1, name: "ban", description: "d", options: [{ type: 3, name: "reason", description: "why" }, { type: 6, name: "user", description: "who", required: true }] }]),
  "raw-option-count": rawCommand(rawOptions(26)),
  "raw-option-count-nested": rawCommand([{ type: 1, name: "many", description: "d", options: [...rawOptions(26)] }]),
  "raw-subcommand-count-nested": rawCommand([{ type: 2, name: "group", description: "d", options: [...rawSubcommands(26)] }]),
  "raw-group-in-subcommand": rawCommand([{ type: 1, name: "sub", description: "d", options: [{ type: 2, name: "group", description: "d", options: [{ type: 1, name: "inner", description: "d" }] }] }]),
  "raw-group-in-group": rawCommand([{ type: 2, name: "group", description: "d", options: [{ type: 2, name: "inner", description: "d", options: [{ type: 1, name: "leaf", description: "d" }] }] }]),
  "raw-subcommand-mixed": rawCommand([{ type: 3, name: "reason", description: "why" }, { type: 1, name: "sub", description: "d" }]),
  "raw-subcommand-mixed-nested": rawCommand([{ type: 2, name: "group", description: "d", options: [{ type: 1, name: "sub", description: "d" }, { type: 3, name: "reason", description: "why" }] }]),
  "raw-choice-wrong-type": rawCommand([{ type: 3, name: "reason", description: "why", choices: [{ name: "One", value: 1 }] }])
} as const satisfies Readonly<Record<string, Schema.JsonObject>>

/** A raw registration probe. */
export type RawRegistration = keyof typeof rawBodies

/** The command probes (`scenario/Probes.ts` lists them; `harness/CommandProbes.ts` runs them). */
export const commandProbeNames = [
  "typed-register-options",
  "typed-register-subcommands",
  "typed-register-choices",
  "typed-sync-identical",
  ...mutatedFields.map((field) => `typed-sync-${field}` as const),
  ...(Object.keys(rawBodies) as ReadonlyArray<RawRegistration>),
  "typed-custom-id-max",
  "raw-custom-id-over"
] as const
