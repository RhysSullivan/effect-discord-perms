import { describe, expect, it } from "vitest"
import { commandWrites } from "../../harness/CommandProbes.ts"
import { baseCommand, labCommandName, mutatedFields, mutations, nestedCommand, optionsCommand, rawBodies, recordingSamples } from "../../harness/scenario/catalog/commands.ts"
import type { Stats } from "../../harness/Pacing.ts"
import { canonical, jsonText, toDiscord } from "../../src/commands/Canonical.ts"
import type { AnyChatInputCommand } from "../../src/commands/Command.ts"

/**
 * The registration rows' catalog (`catalog/commands.ts`, M8): the assumptions the probes rest on. A mutation row syncs
 * over whatever the row before registered, so every mutation must differ from every other definition the catalog
 * registers; the raw sides must use the one command name except the three whose name is the point; and the write count
 * must leave out the 429s dfx sends again.
 */
const text = (command: AnyChatInputCommand) => jsonText(canonical(toDiscord(command.definition)))

describe("the registration rows' catalog", () => {
  it("has mutations that each differ from the base, from each other and from every other registered definition", () => {
    const registered = [baseCommand, optionsCommand, nestedCommand, ...recordingSamples]
    const all = [...mutatedFields.map((field) => mutations[field]), ...registered]
    expect(new Set(all.map(text)).size).toBe(all.length)
  })

  it("changes exactly one field of the base in each mutation", () => {
    const base = canonical(toDiscord(baseCommand.definition))
    for (const field of mutatedFields) {
      const changed = canonical(toDiscord(mutations[field].definition))
      const top = Object.keys(base).filter((key) => jsonText(base[key] ?? null) !== jsonText(changed[key] ?? null))
      expect([field, top.length]).toStrictEqual([field, 1])
    }
  })

  it("registers every typed definition under the one command name but the name mutation's", () => {
    for (const command of [baseCommand, optionsCommand, nestedCommand, ...mutatedFields.filter((field) => field !== "name").map((field) => mutations[field])]) expect(command.name).toBe(labCommandName)
    expect(mutations.name.name).not.toBe(labCommandName)
  })

  it("POSTs every raw side under the one command name, except the three whose name is what the types forbid", () => {
    const named = Object.entries(rawBodies).filter(([, body]) => body["name"] !== labCommandName).map(([probe]) => probe)
    expect(named.sort()).toStrictEqual(["raw-command-name-33", "raw-command-name-space", "raw-command-name-upper"])
  })

  it("counts the command writes the base client sent, less the ones Discord answered 429 (which dfx sends again)", () => {
    const stats = (writes: ReadonlyArray<readonly [string, number]>, limited: ReadonlyArray<readonly [string, number]>): Stats => ({
      requests: 0,
      writes: 0,
      writesByRoute: writes,
      invalid: 0,
      rateLimitedByRoute: limited,
      labRetries: []
    })
    const put = "PUT /applications/{id}/guilds/{id}/commands"
    const post = "POST /applications/{id}/guilds/{id}/commands"
    expect(commandWrites(stats([[put, 2], [post, 3], ["PATCH /channels/{id}", 4]], [[put, 1], ["GET /applications/{id}/guilds/{id}/commands", 1], ["PATCH /channels/{id}", 2]]))).toBe(4)
    expect(commandWrites(stats([], []))).toBe(0)
  })
})
