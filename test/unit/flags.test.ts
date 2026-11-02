import { PermissionFlagsBits } from "discord-api-types/v10"
import { describe, expect, it } from "vitest"
import { PermissionFlags } from "../../src/errors/Missing.generated.ts"
import * as Flags from "../../src/permissions/Flags.ts"

/** Permission sets (DESIGN §1.2): bits from discord-api-types, canonical sorted names, decimal parsing. */
describe("permission sets", () => {
  it("maps every generated flag to its discord-api-types bit, and `all` to exactly their union", () => {
    for (const flag of PermissionFlags) expect(Flags.bitOf(flag)).toBe(PermissionFlagsBits[flag])
    expect(Flags.toSortedNames(Flags.all)).toEqual(PermissionFlags)
    expect(Flags.fromBits(1n << 47n)).toBe(Flags.empty)
  })

  it("parses Discord's decimal bitfields and refuses anything else", () => {
    expect(Flags.parse("3072")).toBe(Flags.fromFlags(["ViewChannel", "SendMessages"]))
    expect(Flags.parse("-1")).toBeUndefined()
    expect(Flags.parse("0x10")).toBeUndefined()
  })

  it("applies an overwrite as (set & ~deny) | allow, and lists names sorted and deduplicated", () => {
    const set = Flags.fromFlags(["ViewChannel", "SendMessages"])
    const after = Flags.applyOverwrite(set, Flags.fromFlags(["EmbedLinks"]), Flags.fromFlags(["SendMessages", "EmbedLinks"]))
    expect(Flags.toSortedNames(after)).toEqual(["EmbedLinks", "ViewChannel"])
    expect(Flags.sortFlags(["ViewChannel", "AddReactions", "ViewChannel"])).toEqual(["AddReactions", "ViewChannel"])
  })

  it("stars exactly the 2FA permissions of Discord's table (H-059, H-072), without PinMessages", () => {
    expect([...Flags.twoFactorFlags].sort()).toEqual(["Administrator", "BanMembers", "KickMembers", "ManageChannels", "ManageMessages", "ManageRoles", "ManageThreads"])
  })
})
