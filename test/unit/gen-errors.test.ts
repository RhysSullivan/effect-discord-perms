import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { PermissionFlagsBits } from "discord-api-types/v10"
import { describe, expect, it } from "vitest"
import {
  categoriesOf,
  checkGenerated,
  errorCategories,
  generatedPath,
  permissionFlagNames,
  renderMissingModule
} from "../../scripts/lib/genErrors.ts"
import { repoRoot } from "../../scripts/lib/tsc.ts"

/** The permission-error generator (DESIGN §2.2) and its `--check` mode (§5.1, M1). */

describe("permissionFlagNames", () => {
  it("keeps 52 flags: every discord-api-types flag except the deprecated alias (H-059)", () => {
    const flags = permissionFlagNames(PermissionFlagsBits)
    expect(flags).toHaveLength(52)
    expect(flags).not.toContain("ManageEmojisAndStickers")
    expect(flags).toContain("ManageGuildExpressions")
    expect([...flags].sort()).toEqual(flags)
  })

  it("refuses an unlisted alias, a listed alias that aliases nothing, and an unknown flag in the tables", () => {
    expect(() => permissionFlagNames({ ViewChannel: 1n, SendMessages: 2n, SeeChannel: 1n })).toThrow(/share bit/)
    const withoutTarget = Object.fromEntries(Object.entries(PermissionFlagsBits).filter(([name]) => name !== "ManageGuildExpressions"))
    expect(() => permissionFlagNames(withoutTarget)).toThrow(/does not alias any kept flag/)
    const withoutConnect = Object.fromEntries(Object.entries(PermissionFlagsBits).filter(([name]) => name !== "Connect"))
    expect(() => permissionFlagNames(withoutConnect)).toThrow(/names Connect/)
  })
})

describe("the category table", () => {
  it("puts every flag in permission, the four access flags in access and the eight payload flags in payload", () => {
    const flags = permissionFlagNames(PermissionFlagsBits)
    const inCategory = (category: string): ReadonlyArray<string> => flags.filter((flag) => categoriesOf(flag).includes(category))
    expect(inCategory("permission")).toEqual(flags)
    expect(inCategory("access")).toEqual(["Connect", "SendMessages", "SendMessagesInThreads", "ViewChannel"])
    expect(inCategory("payload")).toEqual([
      "AttachFiles",
      "EmbedLinks",
      "MentionEveryone",
      "SendPolls",
      "SendTTSMessages",
      "SendVoiceMessages",
      "UseExternalEmojis",
      "UseExternalStickers"
    ])
  })

  it("mirrors the D5 variants with their base categories plus their own", () => {
    const mirror = new Map(errorCategories(permissionFlagNames(PermissionFlagsBits)))
    expect(mirror.get("MissingReadMessageHistory")).toEqual(["permission"])
    expect(mirror.get("MissingReadMessageHistoryForReply")).toEqual(["payload", "permission"])
    expect(mirror.get("MissingReadMessageHistoryForReaction")).toEqual(["access", "permission"])
    expect(mirror.size).toBe(54)
  })
})

describe("the generated module", () => {
  const rendered = renderMissingModule(permissionFlagNames(PermissionFlagsBits))

  it("is committed exactly as the generator writes it", () => {
    expect(fs.readFileSync(path.join(repoRoot, generatedPath), "utf8")).toBe(rendered)
  })

  it("has no any and no casts", () => {
    expect(rendered).not.toMatch(/\bany\b/)
    expect(rendered).not.toMatch(/\bas (?!const\b)/)
  })

  it("checkGenerated reports up to date, missing, and the first stale line", () => {
    expect(checkGenerated(rendered, rendered)).toEqual({ kind: "up-to-date" })
    expect(checkGenerated(undefined, rendered)).toEqual({ kind: "missing" })
    const lines = rendered.split("\n")
    const edited = [...lines.slice(0, 20), "// hand edit", ...lines.slice(21)].join("\n")
    expect(checkGenerated(edited, rendered)).toEqual({ kind: "stale", firstDifferentLine: 21 })
    expect(checkGenerated(`${rendered}\n// appended`, rendered)).toEqual({ kind: "stale", firstDifferentLine: lines.length + 1 })
  })
})

describe("gen:errors -- --check", () => {
  it("exits 0 against the committed module", () => {
    const result = spawnSync("bun", ["--no-env-file", "scripts/gen-errors.ts", "--check"], { cwd: repoRoot, encoding: "utf8" })
    expect({ status: result.status, stdout: result.stdout }).toEqual({
      status: 0,
      stdout: `gen:errors ok: ${generatedPath} is up to date (52 flags, 54 classes in ErrorCategories)\n`
    })
  })
})
