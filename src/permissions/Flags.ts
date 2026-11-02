/**
 * Permission sets (DESIGN §1.2, §4.5, §4.6): a bitfield of Discord permission flags, branded so that a raw
 * bigint from the wire is never mistaken for a parsed set.
 *
 * Bits come from discord-api-types' `PermissionFlagsBits`, keyed by the generated flag names
 * (`PermissionFlags`, which drops the deprecated alias `ManageEmojisAndStickers`, H-059). Names are always
 * listed in `PermissionFlags` order, which is sorted, so every list a set produces is canonical.
 */
import { PermissionFlagsBits } from "discord-api-types/v10"
import { Brand } from "effect"
import { type PermissionFlag, PermissionFlags } from "../errors/Missing.generated.ts"

/** A set of permission flags as a bitfield. Build one with {@link fromBits}, {@link fromFlags} or {@link parse}. */
export type PermissionSet = bigint & Brand.Brand<"PermissionSet">

const brand = Brand.nominal<PermissionSet>()

/** A flag's bit. */
export const bitOf = (flag: PermissionFlag): bigint => PermissionFlagsBits[flag]

/** Every known bit: what the guild owner and an Administrator hold (H-002, H-003). */
export const all: PermissionSet = brand(PermissionFlags.reduce((bits, flag) => bits | bitOf(flag), 0n))

/** No flags. */
export const empty: PermissionSet = brand(0n)

/** The set of `bits`, keeping only known flags (an unknown bit grants nothing the library can name). */
export const fromBits = (bits: bigint): PermissionSet => brand(bits & all)

/** The set of the given flags. */
export const fromFlags = (flags: Iterable<PermissionFlag>): PermissionSet => {
  let bits = 0n
  for (const flag of flags) bits |= bitOf(flag)
  return brand(bits)
}

/** Parses Discord's decimal-string bitfield. Returns `undefined` for anything that is not a decimal integer. */
export const parse = (decimal: string): PermissionSet | undefined => (/^\d+$/.test(decimal) ? fromBits(BigInt(decimal)) : undefined)

/** Whether `set` holds `flag`. */
export const has = (set: PermissionSet, flag: PermissionFlag): boolean => (set & bitOf(flag)) !== 0n

/** `a` with every flag of `b` added. */
export const union = (a: PermissionSet, b: PermissionSet): PermissionSet => brand(a | b)

/** `a` without the flags of `b`. */
export const minus = (a: PermissionSet, b: PermissionSet): PermissionSet => brand(a & ~b)

/** The flags in both. */
export const intersect = (a: PermissionSet, b: PermissionSet): PermissionSet => brand(a & b)

/** Discord's overwrite step: `(set & ~deny) | allow`. */
export const applyOverwrite = (set: PermissionSet, allow: PermissionSet, deny: PermissionSet): PermissionSet => brand((set & ~deny) | allow)

/** The flags of `set`, sorted by name. */
export const toSortedNames = (set: PermissionSet): ReadonlyArray<PermissionFlag> => PermissionFlags.filter((flag) => has(set, flag))

/** The given flags, deduplicated and sorted by name. */
export const sortFlags = (flags: Iterable<PermissionFlag>): ReadonlyArray<PermissionFlag> => toSortedNames(fromFlags(flags))

/**
 * The 2FA-starred permissions (permissions.mdx, H-059, H-072): with guild `mfa_level = 1`, using them needs the
 * bot owner's account to have 2FA, or Discord answers 60003. PinMessages carries no star.
 */
export const twoFactorFlags: ReadonlySet<PermissionFlag> = new Set([
  "Administrator",
  "BanMembers",
  "KickMembers",
  "ManageChannels",
  "ManageMessages",
  "ManageRoles",
  "ManageThreads"
])
