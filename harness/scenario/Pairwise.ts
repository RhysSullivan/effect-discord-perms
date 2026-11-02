/**
 * Deterministic pairwise selection with per-family validity predicates (DESIGN §5.9, `[sd:pairwise.ts]`).
 *
 * Greedy and free of randomness: the uncovered pairs are enumerated in a fixed order, each row is seeded with
 * the first uncovered pair, and every other dimension takes the value covering the most uncovered pairs (ties
 * go to the first value) among those that still allow a valid completion. Every selected row satisfies its
 * family's predicate, and every valid pair of values is covered.
 */

/** A family's dimensions: name to values, in a fixed order. */
export type Dimensions = Readonly<Record<string, ReadonlyArray<string>>>

/** One selected combination: dimension name to value. */
export type Combination = Readonly<Record<string, string>>

/** A family: its dimensions and the predicate every row must satisfy. */
export interface Family {
  readonly dimensions: Dimensions
  readonly valid: (row: Combination) => boolean
}

const pairKey = (a: string, va: string, b: string, vb: string): string => `${a}=${va}|${b}=${vb}`

/** Whether some completion of `partial` over the remaining dimensions is valid (exhaustive; families are small). */
export const completable = (partial: Combination, family: Family): boolean => {
  const rest = Object.keys(family.dimensions).filter((name) => partial[name] === undefined)
  const go = (index: number, row: Combination): boolean => {
    const name = rest[index]
    if (name === undefined) return family.valid(row)
    return (family.dimensions[name] ?? []).some((value) => go(index + 1, { ...row, [name]: value }))
  }
  return go(0, partial)
}

/** Every pair of values (across two dimensions) that some valid row contains, in enumeration order. */
export const validPairs = (family: Family): ReadonlyArray<string> => {
  const names = Object.keys(family.dimensions)
  const pairs: Array<string> = []
  names.forEach((a, i) => {
    for (const b of names.slice(i + 1)) {
      for (const va of family.dimensions[a] ?? []) {
        for (const vb of family.dimensions[b] ?? []) if (completable({ [a]: va, [b]: vb }, family)) pairs.push(pairKey(a, va, b, vb))
      }
    }
  })
  return pairs
}

/** The pairs `row` covers. */
export const pairsOf = (row: Combination, family: Family): ReadonlyArray<string> => {
  const names = Object.keys(family.dimensions)
  return names.flatMap((a, i) => names.slice(i + 1).map((b) => pairKey(a, row[a] ?? "", b, row[b] ?? "")))
}

/** The selected rows (see the module comment). */
export const pairwise = (family: Family): ReadonlyArray<Combination> => {
  const names = Object.keys(family.dimensions)
  const uncovered = new Set(validPairs(family))
  const rows: Array<Combination> = []
  while (uncovered.size > 0) {
    const [first] = uncovered
    if (first === undefined) break
    const row: Record<string, string> = {}
    for (const part of first.split("|")) {
      const [name = "", value = ""] = part.split("=")
      row[name] = value
    }
    for (const name of names) {
      if (row[name] !== undefined) continue
      let best: string | undefined
      let bestScore = -1
      for (const value of family.dimensions[name] ?? []) {
        const trial = { ...row, [name]: value }
        if (!completable(trial, family)) continue
        let score = 0
        for (const other of names) {
          const otherValue = trial[other]
          if (other === name || otherValue === undefined) continue
          const [a, b] = names.indexOf(other) < names.indexOf(name) ? [other, name] : [name, other]
          if (uncovered.has(pairKey(a, trial[a] ?? "", b, trial[b] ?? ""))) score++
        }
        if (score > bestScore) {
          best = value
          bestScore = score
        }
      }
      // the seed pair is completable, so some value always is
      if (best === undefined) throw new Error(`pairwise: no valid value for ${name} after ${JSON.stringify(row)}`)
      row[name] = best
    }
    for (const pair of pairsOf(row, family)) uncovered.delete(pair)
    rows.push(row)
  }
  return rows
}

/**
 * What is wrong with a family's selection, empty when nothing is (§5.9): a selected row its predicate rejects,
 * a valid pair no row covers, a value of a dimension that some valid row has but no selected row does, or rows
 * that differ from a fresh selection (the selection must be deterministic). The catalog test runs it offline and
 * the runner again at run start, before any write.
 */
export const selectionProblems = (name: string, family: Family, rows: ReadonlyArray<Combination> = pairwise(family)): ReadonlyArray<string> => {
  const problems: Array<string> = []
  for (const row of rows) if (!family.valid(row)) problems.push(`${name}: selected an invalid row ${JSON.stringify(row)}`)
  const covered = new Set(rows.flatMap((row) => pairsOf(row, family)))
  const valid = validPairs(family)
  for (const pair of valid) if (!covered.has(pair)) problems.push(`${name}: no row covers ${pair}`)
  for (const [dimension, values] of Object.entries(family.dimensions)) {
    for (const value of values) {
      const possible = completable({ [dimension]: value }, family)
      if (possible && !rows.some((row) => row[dimension] === value)) problems.push(`${name}: no row has ${dimension}=${value}`)
    }
  }
  if (JSON.stringify(pairwise(family)) !== JSON.stringify(rows)) problems.push(`${name}: the selection is not deterministic`)
  return problems
}

const isVoice = (channel: string | undefined): boolean => channel === "voice" || channel === "stage"

/** The payloads whose feature needs a flag (`missing=payload` removes it). A guild sticker needs none (H-138). */
export const payloadsWithFlag: ReadonlySet<string> = new Set(["embed", "file", "reply", "tts", "poll"])

/**
 * The docs model's independent prediction that a kick or ban fails (used by Safety offline and by the guard
 * before the call): the flag is missing, or the target is not below the subject. A timeout is not a reason,
 * since whether timeouts bind bots is itself open (H-022).
 */
export const kickBanMustFail = (row: Combination): boolean => row.missing === "op-flag" || row.targetRank !== "below"

/** The families (§5.9). M3 runs `send`; the others' catalogs arrive in M4. */
export const families = {
  send: {
    dimensions: {
      channel: ["text", "announcement", "voice", "stage", "forum-post", "public-thread", "private-thread", "announcement-thread", "archived-thread", "locked-thread"],
      payload: ["plain", "embed", "file", "reply", "tts", "poll", "guild-sticker", "mention-everyone"],
      grantSource: ["everyone", "role", "role-overwrite-allow", "member-overwrite-allow", "administrator"],
      missing: ["none", "view", "base", "payload", "connect"],
      removal: ["absent", "role-overwrite-deny", "member-overwrite-deny", "everyone-overwrite-deny"],
      memberState: ["normal", "timed-out"]
    },
    valid: (r) =>
      !(r.missing === "payload" && !payloadsWithFlag.has(r.payload ?? "")) &&
      // MentionEveryone is never granted in an @everyone row, so administrator never appears with it (Safety)
      !(r.grantSource === "administrator" && (r.missing !== "none" || r.memberState === "timed-out" || r.payload === "mention-everyone")) &&
      !(r.missing === "none" && r.removal !== "absent") &&
      !(r.missing === "connect" && !isVoice(r.channel))
  },
  react: {
    dimensions: {
      channel: ["text", "voice", "public-thread", "private-thread", "archived-thread"],
      emoji: ["unicode-new", "unicode-existing", "guild"],
      missing: ["none", "view", "read-history", "add-reactions", "connect"],
      removal: ["absent", "role-overwrite-deny", "member-overwrite-deny"],
      memberState: ["normal", "timed-out"]
    },
    valid: (r) => !(r.missing === "none" && r.removal !== "absent") && !(r.missing === "connect" && r.channel !== "voice")
  },
  pins: {
    // no voice or stage: their text chat has no pins (400 50019 even for the harness, M2 and M4 live)
    dimensions: {
      channel: ["text", "announcement", "public-thread", "archived-thread"],
      op: ["pin", "unpin", "list"],
      missing: ["none", "view", "pin-messages", "read-history"],
      removal: ["absent", "role-overwrite-deny", "member-overwrite-deny"],
      memberState: ["normal", "timed-out"]
    },
    valid: (r) => !(r.missing === "none" && r.removal !== "absent")
  },
  createThread: {
    dimensions: { parent: ["text", "announcement"], visibility: ["public", "private"], missing: ["none", "view", "op-flag"], memberState: ["normal", "timed-out"] },
    // private threads under an announcement channel are a targeted invalid row (H-041)
    valid: (r) => !(r.parent === "announcement" && r.visibility === "private")
  },
  threads: {
    dimensions: {
      thread: ["public", "private", "announcement-thread", "forum-post"],
      op: ["join", "leave", "add-member", "archive", "lock", "delete"],
      creator: ["subject", "harness"],
      missing: ["none", "view", "op-flag"],
      memberState: ["normal", "timed-out"],
      membership: ["member", "not-member"]
    },
    valid: (r) =>
      !((r.op === "join" || r.op === "leave") && r.missing === "op-flag") &&
      !(r.op === "delete" && r.creator !== "subject") &&
      !(r.op === "leave" && r.membership === "not-member") &&
      !(r.op === "join" && r.membership === "member")
  },
  channelEdit: {
    // slowmode only: name and topic edits are targeted rows, at most one per lab channel per run (H-162)
    dimensions: {
      channel: ["text", "voice", "stage", "forum", "public-thread", "private-thread"],
      missing: ["none", "view", "manage", "connect"],
      removal: ["absent", "role-overwrite-deny", "member-overwrite-deny"],
      memberState: ["normal", "timed-out"]
    },
    valid: (r) => !(r.missing === "none" && r.removal !== "absent") && !(r.missing === "connect" && !isVoice(r.channel))
  },
  messages: {
    dimensions: {
      op: ["edit-own", "delete-own", "delete-foreign", "crosspost-own", "crosspost-foreign", "bulk-delete"],
      channel: ["text", "announcement", "voice", "public-thread"],
      missing: ["none", "view", "op-flag"],
      memberState: ["normal", "timed-out"]
    },
    valid: (r) =>
      !((r.op === "crosspost-own" || r.op === "crosspost-foreign") && r.channel !== "announcement") &&
      !((r.op === "edit-own" || r.op === "delete-own") && r.missing === "op-flag")
  },
  members: {
    dimensions: {
      op: ["add-role", "remove-role", "nickname", "timeout", "kick-expect-fail", "ban-expect-fail"],
      targetRank: ["below", "equal", "above"],
      roleRank: ["below", "equal", "above", "n/a"],
      missing: ["none", "op-flag"],
      targetAdmin: ["no", "yes"],
      memberState: ["normal", "timed-out"]
    },
    valid: (r) => {
      const roleOp = r.op === "add-role" || r.op === "remove-role"
      if (roleOp !== (r.roleRank !== "n/a")) return false
      // the lab has one role per position (§5.7), so a rank and a role of the same rank are the same role: the
      // target cannot be given a role it already holds for its rank (add-role), and holding the role to remove
      // makes its rank at least the role's (remove-role)
      const rank = (value: string | undefined): number => (value === "below" ? 0 : value === "equal" ? 1 : 2)
      if (r.op === "add-role" && r.roleRank !== "below" && r.roleRank === r.targetRank) return false
      if (r.op === "remove-role" && rank(r.targetRank) < rank(r.roleRank)) return false
      // kick and ban only where the docs model predicts failure; never missing=none with the target below (L1)
      const kickOrBan = r.op === "kick-expect-fail" || r.op === "ban-expect-fail"
      return !(kickOrBan && r.missing === "none" && r.targetRank === "below")
    }
  }
} as const satisfies Record<string, Family>

/** A family name. */
export type FamilyName = keyof typeof families
