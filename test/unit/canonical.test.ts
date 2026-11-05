import * as fs from "node:fs"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { CommandsFixture, fixturePath, placeholders } from "../../harness/RecordCommands.ts"
import { recordingSamples } from "../../harness/scenario/catalog/commands.ts"
import { Command } from "../../src/commands/Command.ts"
import { canonical, choiceDefaults, commandDefaults, differences, jsonText, optionDefaults, sameJson, serverAssigned, toDiscord } from "../../src/commands/Canonical.ts"

/**
 * The canonicaliser (DESIGN §4.14, open question 11) against the recording of how Discord stores commands
 * (`fixtures/commands-canonical.json`, M8 live): what the library sends and what Discord stores compare equal; the
 * default tables hold exactly what the recording shows Discord adding or dropping; and every field the library sends
 * matters, so changing any of them makes the stored command differ.
 */
const fixture = Schema.decodeUnknownSync(Schema.fromJsonString(CommandsFixture))(fs.readFileSync(fixturePath, "utf8"))

type Json = Schema.Json
const isObject = (value: Json): value is Schema.JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)

/** Each `level: key = value` present on one side only, walking objects by key and arrays by index (choices and options). */
const oneSided = (sent: Json, stored: Json, level: string, out: Array<string>): void => {
  if (Array.isArray(sent) && Array.isArray(stored)) {
    sent.forEach((item, index) => oneSided(item, stored[index] ?? null, level, out))
    return
  }
  if (!isObject(sent) || !isObject(stored)) return
  const child = (key: string) => (key === "options" ? "option" : key === "choices" ? "choice" : level)
  for (const key of new Set([...Object.keys(sent), ...Object.keys(stored)])) {
    const a = sent[key]
    const b = stored[key]
    if (a === undefined && b !== undefined) out.push(`${level} added ${key}=${jsonText(b)}`)
    else if (b === undefined && a !== undefined) out.push(`${level} dropped ${key}=${jsonText(a)}`)
    else if (a !== undefined && b !== undefined && key !== "channel_types") oneSided(a, b, child(key), out)
  }
}

/** Every leaf path of a JSON value with its value. */
const leaves = (value: Json, path: ReadonlyArray<string | number> = []): ReadonlyArray<readonly [ReadonlyArray<string | number>, Json]> => {
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, [...path, index]))
  if (isObject(value)) return Object.entries(value).flatMap(([key, item]) => leaves(item, [...path, key]))
  return [[path, value]]
}

/** `value` with the leaf at `path` replaced by `next`. */
const setAt = (value: Json, path: ReadonlyArray<string | number>, next: Json): Json => {
  const [head, ...rest] = path
  if (head === undefined) return next
  if (Array.isArray(value) && typeof head === "number") return value.map((item, index) => (index === head ? setAt(item, rest, next) : item))
  if (isObject(value) && typeof head === "string") return { ...value, [head]: setAt(value[head] ?? null, rest, next) }
  return value
}

const mutated = (leaf: Json): Json => (typeof leaf === "string" ? `${leaf}x` : typeof leaf === "number" ? leaf + 1 : typeof leaf === "boolean" ? !leaf : "x")

describe("the canonicaliser, against the recorded storage (fixtures/commands-canonical.json)", () => {
  it("records every sample, sent exactly as the library sends it", () => {
    expect(fixture.commands.map((command) => command.sent)).toStrictEqual(recordingSamples.map((command) => toDiscord(command.definition)))
  })

  it("compares each stored command equal to what was sent", () => {
    for (const command of fixture.commands) expect(jsonText(canonical(command.stored))).toBe(jsonText(canonical(command.sent)))
    expect(differences(fixture.commands.map((command) => command.sent), fixture.commands.map((command) => command.stored))).toStrictEqual([])
  })

  it("names in its tables exactly what the recording shows Discord adding or dropping", () => {
    const seen = new Set<string>()
    for (const command of fixture.commands) {
      const out: Array<string> = []
      oneSided(command.sent, command.stored, "command", out)
      for (const line of out) seen.add(line)
    }
    const expected = new Set<string>([
      ...serverAssigned.map((key) => `command added ${key}=${jsonText(placeholders[key] ?? null)}`),
      ...Object.entries(commandDefaults).map(([key, value]) => `command added ${key}=${jsonText(value)}`),
      ...Object.entries(optionDefaults).map(([key, value]) => `option dropped ${key}=${jsonText(value)}`),
      ...Object.entries(choiceDefaults).map(([key, value]) => `choice dropped ${key}=${jsonText(value)}`)
    ])
    expect([...seen].sort()).toStrictEqual([...expected].sort())
  })

  it("treats channel_types as a set, as Discord does (it stored [5, 0, 11] as [0, 11, 5])", () => {
    const [options] = fixture.commands
    expect(options === undefined ? undefined : jsonText(options.stored).includes(`"channel_types":[0,11,5]`)).toBe(true)
    expect(sameJson(canonical({ type: 1, name: "x", description: "d", options: [{ type: 7, name: "c", description: "d", channel_types: [11, 0] }] }), canonical({ type: 1, name: "x", description: "d", options: [{ type: 7, name: "c", description: "d", channel_types: [0, 11] }] }))).toBe(true)
  })

  it("makes a stored command differ when any field the library sends changes (a property over every leaf)", () => {
    let checked = 0
    for (const command of fixture.commands) {
      for (const [path, leaf] of leaves(command.sent)) {
        const changed = setAt(command.sent, path, mutated(leaf))
        expect(isObject(changed) && !sameJson(canonical(changed), canonical(command.stored)), `${String(command.sent["name"])}: ${path.join(".")}`).toBe(true)
        checked++
      }
    }
    // every leaf of the four samples (106): a recording with fewer fields would test fewer
    expect(checked).toBe(106)
  })

  it("sends autocomplete on string, integer and number options alike (the M8 verifier: integer and number were untested)", () => {
    const command = Command.chatInput({
      name: "x",
      description: "d",
      options: [
        { type: "string", name: "s", description: "d", autocomplete: true },
        { type: "integer", name: "i", description: "d", autocomplete: true },
        { type: "number", name: "n", description: "d", autocomplete: true }
      ]
    })
    expect(toDiscord(command.definition)["options"]).toStrictEqual([
      { type: 3, name: "s", description: "d", autocomplete: true },
      { type: 4, name: "i", description: "d", autocomplete: true },
      { type: 10, name: "n", description: "d", autocomplete: true }
    ])
  })

  it("keeps a default field Discord holds at another value, so registration overwrites it", () => {
    const [plain] = fixture.commands.slice(-1)
    if (plain === undefined) throw new Error("no sample")
    expect(sameJson(canonical({ ...plain.stored, default_member_permissions: "8" }), canonical(plain.sent))).toBe(false)
    expect(sameJson(canonical({ ...plain.stored, nsfw: true }), canonical(plain.sent))).toBe(false)
    expect(sameJson(canonical({ ...plain.stored, contexts: [0] }), canonical(plain.sent))).toBe(false)
  })

  it("names the first differing field of a differing command, and a command on one side only", () => {
    const [options] = fixture.commands
    if (options === undefined) throw new Error("no sample")
    const changed = setAt(options.sent, ["options", 1, "max_value"], 11)
    expect(isObject(changed) ? differences([changed], [options.stored]) : []).toStrictEqual(["lab-record-options: options.1.max_value: 11 locally, 10 registered"])
    expect(differences([], [options.stored])).toStrictEqual(["lab-record-options: 0 local, 1 registered"])
  })
})
