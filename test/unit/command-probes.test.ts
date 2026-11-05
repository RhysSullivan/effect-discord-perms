import * as fs from "node:fs"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { definedKeys, documentedChannelTypes, misplacedKeyObservation, storedAsDefined, storedKeysAsDefined } from "../../harness/CommandProbes.ts"
import { CommandsFixture, fixturePath } from "../../harness/RecordCommands.ts"
import { baseCommand, misplacedKeys, optionKeyBody, optionKeysCommand, recordingSamples } from "../../harness/scenario/catalog/commands.ts"
import { channelTypes } from "../../src/state/Snapshot.ts"

/**
 * R-options-typed's valid side (the M8 verifier): the probe compares the stored command with the definition as written,
 * field by field, without the canonicaliser, so `Ignored` is observable when Discord stores a choice, a required flag or
 * a channel kind other than the definition's.
 */
const fixture = Schema.decodeUnknownSync(Schema.fromJsonString(CommandsFixture))(fs.readFileSync(fixturePath, "utf8"))

const storedBase: Schema.JsonObject = {
  id: "{command.id}",
  name: baseCommand.name,
  description: "Perms Lab: the registration probe",
  default_member_permissions: null,
  nsfw: false,
  options: [
    { type: 6, name: "user", description: "who", required: true },
    { type: 3, name: "reason", description: "why", required: true, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "abuse" }] },
    // Discord's own order of a set
    { type: 7, name: "log", description: "where", channel_types: [5, 0] },
    { type: 4, name: "days", description: "history", min_value: 0, max_value: 7 }
  ]
}

const withOption = (index: number, change: (option: Schema.JsonObject) => Schema.JsonObject): Schema.JsonObject => {
  const options = storedBase["options"]
  return { ...storedBase, options: Array.isArray(options) ? options.map((option, at) => (at === index && typeof option === "object" && option !== null && !Array.isArray(option) ? change(option) : option)) : [] }
}

describe("the options readback (storedAsDefined)", () => {
  it("accepts each recorded sample as Discord stored it, and the base command as Discord stores it", () => {
    const [options] = fixture.commands
    const [sample] = recordingSamples
    expect(options !== undefined && sample !== undefined && storedAsDefined(sample.definition.options, options.stored)).toBe(true)
    expect(storedAsDefined(baseCommand.definition.options, storedBase)).toBe(true)
  })

  it("observes a choice, a required flag, a channel kind or an option that differs from the definition", () => {
    expect(storedAsDefined(baseCommand.definition.options, withOption(1, (option) => ({ ...option, choices: [{ name: "Spam", value: "spam" }] })))).toBe(false)
    expect(storedAsDefined(baseCommand.definition.options, withOption(1, (option) => ({ ...option, choices: [{ name: "Spam", value: "spam" }, { name: "Abuse", value: "other" }] })))).toBe(false)
    expect(storedAsDefined(baseCommand.definition.options, withOption(0, ({ required: _, ...option }) => option))).toBe(false)
    expect(storedAsDefined(baseCommand.definition.options, withOption(3, (option) => ({ ...option, required: true })))).toBe(false)
    expect(storedAsDefined(baseCommand.definition.options, withOption(2, (option) => ({ ...option, channel_types: [0] })))).toBe(false)
    expect(storedAsDefined(baseCommand.definition.options, withOption(2, ({ channel_types: _, ...option }) => option))).toBe(false)
    expect(storedAsDefined(baseCommand.definition.options, withOption(3, (option) => ({ ...option, name: "day" })))).toBe(false)
    expect(storedAsDefined(baseCommand.definition.options, { ...storedBase, options: [] })).toBe(false)
  })

  it("reads channel types against Discord's documented numbers, not the library's table, and the two agree offline", () => {
    // the live readback is independent of the table the library writes with; offline, any disagreement shows here
    expect(documentedChannelTypes).toEqual({
      text: 0,
      voice: 2,
      category: 4,
      announcement: 5,
      "announcement-thread": 10,
      "public-thread": 11,
      "private-thread": 12,
      stage: 13,
      forum: 15,
      media: 16
    })
    expect(channelTypes).toEqual(documentedChannelTypes)
  })
})

/**
 * R-option-keys's readbacks (after the final audit): the valid side compares every key of every option with the
 * definition as written; an invalid side names the option types that kept a misplaced key, or observes it ignored.
 */
const storedKeys: Schema.JsonObject = {
  id: "{command.id}",
  name: optionKeysCommand.name,
  description: "Perms Lab: every option key on its own type",
  options: [
    { type: 3, name: "text", description: "a string", autocomplete: true, min_length: 2, max_length: 50 },
    { type: 3, name: "pick", description: "a string", choices: [{ name: "One", value: "one" }] },
    { type: 4, name: "count", description: "an integer", autocomplete: true, min_value: 1, max_value: 10 },
    { type: 4, name: "level", description: "an integer", choices: [{ name: "Five", value: 5 }] },
    { type: 10, name: "ratio", description: "a number", autocomplete: true, min_value: 0, max_value: 1.5 },
    { type: 10, name: "share", description: "a number", choices: [{ name: "Half", value: 0.5 }] },
    { type: 7, name: "where", description: "a channel", channel_types: [0] },
    // Discord's empty values for keys an option does not set
    { type: 5, name: "flag", description: "a boolean", autocomplete: false },
    { type: 6, name: "who", description: "a user", choices: [] },
    { type: 8, name: "role", description: "a role" }
  ]
}

const withStoredOption = (name: string, change: (option: Schema.JsonObject) => Schema.JsonObject): Schema.JsonObject => {
  const options = storedKeys["options"]
  return {
    ...storedKeys,
    options: Array.isArray(options) ? options.map((option) => (typeof option === "object" && option !== null && !Array.isArray(option) && option["name"] === name ? change(option) : option)) : []
  }
}

describe("the option keys readback (storedKeysAsDefined, misplacedKeyObservation)", () => {
  it("reads each key from the definition as written, under Discord's name", () => {
    const [text, pick, , , ratio, , where, flag] = optionKeysCommand.definition.options
    expect(text !== undefined && definedKeys(text)).toEqual({ autocomplete: true, min_length: 2, max_length: 50 })
    expect(pick !== undefined && definedKeys(pick)).toEqual({ choices: [{ name: "One", value: "one" }] })
    expect(ratio !== undefined && definedKeys(ratio)).toEqual({ autocomplete: true, min_value: 0, max_value: 1.5 })
    expect(where !== undefined && definedKeys(where)).toEqual({ channel_types: [0] })
    expect(flag !== undefined && definedKeys(flag)).toEqual({})
  })

  it("accepts the definition as Discord stores it, with empty values for keys an option does not set", () => {
    expect(storedKeysAsDefined(optionKeysCommand.definition.options, storedKeys)).toBe(true)
  })

  it("observes a key dropped, changed, or added to an option that does not set it", () => {
    expect(storedKeysAsDefined(optionKeysCommand.definition.options, withStoredOption("text", ({ min_length: _, ...option }) => option))).toBe(false)
    expect(storedKeysAsDefined(optionKeysCommand.definition.options, withStoredOption("count", (option) => ({ ...option, max_value: 9 })))).toBe(false)
    expect(storedKeysAsDefined(optionKeysCommand.definition.options, withStoredOption("ratio", ({ autocomplete: _, ...option }) => option))).toBe(false)
    expect(storedKeysAsDefined(optionKeysCommand.definition.options, withStoredOption("where", (option) => ({ ...option, channel_types: [0, 5] })))).toBe(false)
    expect(storedKeysAsDefined(optionKeysCommand.definition.options, withStoredOption("flag", (option) => ({ ...option, choices: [{ name: "One", value: "one" }] })))).toBe(false)
    expect(storedKeysAsDefined(optionKeysCommand.definition.options, withStoredOption("role", (option) => ({ ...option, min_value: 1 })))).toBe(false)
    expect(storedKeysAsDefined(optionKeysCommand.definition.options, { ...storedKeys, options: [] })).toBe(false)
  })

  it("posts one option of every refusing type per misplaced key, and names the types that kept it", () => {
    for (const key of Object.keys(misplacedKeys) as ReadonlyArray<keyof typeof misplacedKeys>) {
      const body = optionKeyBody(key)
      const options = Array.isArray(body["options"]) ? body["options"] : []
      expect(options.map((option) => (typeof option === "object" && option !== null && !Array.isArray(option) ? [option["name"], key in option] : []))).toEqual(misplacedKeys[key].on.map((type) => [type, true]))
      // as POSTed: every option kept the key
      expect(misplacedKeyObservation(key, body)).toEqual({ _tag: "Applied", field: `${key} on ${misplacedKeys[key].on.join(",")}` })
    }
    const body = optionKeyBody("choices")
    const options = Array.isArray(body["options"]) ? body["options"] : []
    const dropped = options.map((option) => (typeof option === "object" && option !== null && !Array.isArray(option) ? Object.fromEntries(Object.entries(option).filter(([key]) => key !== "choices")) : option))
    expect(misplacedKeyObservation("choices", { ...body, options: dropped })).toEqual({ _tag: "Ignored", field: "choices" })
    const one = dropped.map((option, index) => (index === 3 && typeof option === "object" && option !== null && !Array.isArray(option) ? { ...option, choices: [{ name: "One", value: "one" }] } : option))
    expect(misplacedKeyObservation("choices", { ...body, options: one })).toEqual({ _tag: "Applied", field: "choices on channel" })
    expect(misplacedKeyObservation("choices", undefined)).toEqual({ _tag: "Ignored", field: "choices" })
  })
})
