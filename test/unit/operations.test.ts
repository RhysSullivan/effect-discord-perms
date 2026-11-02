import { describe, expect, it } from "vitest"
import { ErrorClasses, PermissionFlags } from "../../src/errors/index.ts"
import { type OpName, Operations, type OpSpec } from "../../src/permissions/Operations.ts"

/**
 * Invariants of the operation table that the design states for every row (DESIGN §2.4, §2.5, §3.1, §4.7). The
 * oracles below are written from the research and design text, not read from the implementation.
 */

const isOpName = (name: string): name is OpName => Object.hasOwn(Operations, name)
const rows: ReadonlyArray<readonly [OpName, OpSpec]> = Object.keys(Operations)
  .filter(isOpName)
  .map((op) => [op, Operations[op]] as const)

/** The permissions that carry the 2FA asterisk in Discord's permission table (H-059, H-072). */
const twoFactorFlags: ReadonlySet<string> = new Set([
  "ManageMessages",
  "ManageThreads",
  "ManageChannels",
  "ManageRoles",
  "KickMembers",
  "BanMembers",
  "Administrator"
])

/** The permissions a timeout leaves a member (H-020). Every other flag is removed by the timeout mask. */
const keptByTimeout: ReadonlySet<string> = new Set(["ViewChannel", "ReadMessageHistory"])

describe("the operation table", () => {
  it("has 47 rows, each with known flags and tags and no duplicates", () => {
    expect(rows).toHaveLength(47)
    const flags: ReadonlySet<string> = new Set(PermissionFlags)
    const classes: ReadonlySet<string> = new Set(Object.keys(ErrorClasses))
    for (const [op, row] of rows) {
      expect({ op, unknownFlags: row.flags.filter((flag) => !flags.has(flag)) }).toEqual({ op, unknownFlags: [] })
      expect({ op, unknownTags: row.tags.filter((tag) => !classes.has(tag)) }).toEqual({ op, unknownTags: [] })
      expect({ op, flags: new Set(row.flags).size, tags: new Set(row.tags).size }).toEqual({ op, flags: row.flags.length, tags: row.tags.length })
    }
  })

  it("lists TwoFactorRequired exactly in the rows that require a 2FA-starred flag (H-072)", () => {
    for (const [op, row] of rows) {
      const starred = row.flags.some((flag) => twoFactorFlags.has(flag))
      expect({ op, listsTwoFactorRequired: row.tags.includes("TwoFactorRequired") }).toEqual({ op, listsTwoFactorRequired: starred })
    }
  })

  it("lists CommunicationDisabled in every row whose flags the timeout mask removes (H-020)", () => {
    for (const [op, row] of rows) {
      if (row.flags.some((flag) => !keptByTimeout.has(flag))) {
        expect({ op, listsCommunicationDisabled: row.tags.includes("CommunicationDisabled") }).toEqual({ op, listsCommunicationDisabled: true })
      }
    }
  })

  it("leaves CommunicationDisabled out only of channel pins, join, leave, own delete outside voice and DMs (§2.4)", () => {
    // own deletes: a timed-out subject that sees the channel deletes its own message, in a text channel and in a
    // thread (M4 live, `message/targeted/delete-own-timed-out` and `...-thread`)
    const without = rows.filter(([, row]) => !row.tags.includes("CommunicationDisabled")).map(([op]) => op)
    expect(without.sort()).toEqual(["channel.pins", "dm.send", "message.deleteOwn", "message.deleteOwn.thread", "thread.join", "thread.leave"])
  })

  it("lists PermissionDeniedUnattributed in every row that sends a guild request, because a 50013 or 50001 recompute may find nothing (§3.1, §4.9)", () => {
    for (const [op, row] of rows) {
      const guildRequest = op !== "dm.send" && op !== "permissions.require"
      expect({ op, listsUnattributed: row.tags.includes("PermissionDeniedUnattributed") }).toEqual({ op, listsUnattributed: guildRequest })
    }
  })

  it("requires ViewChannel first in every channel row, and Connect second in every voice row (§3.2; H-015, H-152)", () => {
    for (const [op, row] of rows) {
      // leaving a thread needs no View (M4 live: it succeeds with View denied on the parent)
      if (op.startsWith("member.") || op === "dm.send" || op === "thread.leave") continue
      expect({ op, first: row.flags[0] }).toEqual({ op, first: "ViewChannel" })
      if (op.startsWith("voice.") || op.endsWith(".voice")) expect({ op, second: row.flags[1] }).toEqual({ op, second: "Connect" })
    }
  })

  it("uses the reply variant exactly for the operations whose payload may reply, and the reaction variant for reactions (D5)", () => {
    const byVariant = (variant: string): ReadonlyArray<string> => rows.filter(([, row]) => row.variant === variant).map(([op]) => op).sort()
    expect(byVariant("reply")).toEqual(["channel.send", "forum.createPost", "thread.send", "voice.send"])
    expect(byVariant("reaction")).toEqual(["message.react.channel", "message.react.thread", "message.react.voice"])
  })

  it("never lists ThreadArchived on a send (C16, H-035), join, leave or addMember (M4 live), and lists it on the thread variants of edit, delete, bulk delete, react, pin and unpin", () => {
    for (const [op, row] of rows) {
      if (op.endsWith(".send") || op === "forum.createPost") expect({ op, archived: row.tags.includes("ThreadArchived") }).toEqual({ op, archived: false })
    }
    for (const op of ["message.edit.thread", "message.deleteOwn.thread", "message.deleteForeign.thread", "thread.bulkDelete", "message.react.thread", "message.pin.thread", "message.unpin.thread"] as const) {
      expect({ op, archived: Operations[op].tags.some((tag) => tag === "ThreadArchived") }).toEqual({ op, archived: true })
    }
    for (const op of ["thread.join", "thread.leave", "thread.addMember"] as const) {
      const tags: ReadonlyArray<string> = Operations[op].tags
      expect({ op, archived: tags.includes("ThreadArchived") }).toEqual({ op, archived: false })
    }
  })
})
