import * as fs from "node:fs"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { documentedChannelTypes, storedAsDefined } from "../../harness/CommandProbes.ts"
import { CommandsFixture, fixturePath } from "../../harness/RecordCommands.ts"
import { baseCommand, recordingSamples } from "../../harness/scenario/catalog/commands.ts"
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
