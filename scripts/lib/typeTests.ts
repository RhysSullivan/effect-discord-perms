/**
 * The type-test gate (DESIGN §5.2, D2, D30): parsing `tsc --pretty false` output, the fail-fixture directive
 * language, the readability gate and the diagnostic snapshot format. Everything here is pure; the runner in
 * `scripts/type-tests.ts` does the I/O.
 *
 * Fail fixtures use two kinds of comment lines, each on its own line:
 *
 * - `// @expect-error TS<code> <mention>` owns the diagnostics up to the next directive or `// @valid`.
 *   Consecutive directive lines form one block that matches that many diagnostics, in order.
 * - `// @valid` opens a block that must produce no diagnostic: the pass twin that proves the fixture's setup.
 */
import * as path from "node:path"
import { scanTypeArguments } from "./typeText.ts"

/** One located diagnostic, exactly as `tsc --pretty false` printed it. */
export interface Diagnostic {
  /** Absolute path of the file the diagnostic is in. */
  readonly file: string
  readonly line: number
  readonly column: number
  /** For example `TS2345`. */
  readonly code: string
  /** The head message followed by the chain lines, indentation as printed, joined with `\n`. */
  readonly text: string
}

/**
 * Parsed compiler output: located diagnostics, the files `--listFiles` printed (the program), and every other
 * non-blank line (config errors, crashes).
 */
export interface TscOutput {
  readonly diagnostics: ReadonlyArray<Diagnostic>
  /** Absolute paths of the files in the compiled program, as `--listFiles` printed them. */
  readonly listed: ReadonlyArray<string>
  readonly unlocated: ReadonlyArray<string>
}

const locatedLine = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/
/** A `--listFiles` line: an absolute path to a TypeScript source or declaration file, alone on its line. */
const listedLine = /^(?:\/|[A-Za-z]:[\\/])\S.*\.(?:d\.)?[cm]?tsx?$/

/**
 * Parses `tsc --pretty false --listFiles` output. A located head line starts a diagnostic, lines starting with
 * a space continue its chain, an absolute path alone on its line is a file of the program, and anything else
 * is unlocated output, which the runner treats as a failure. Paths are resolved against `cwd`, the directory
 * tsc ran in. Diagnostics are returned sorted by file, line and column.
 */
export const parseTscOutput = (output: string, cwd: string): TscOutput => {
  const diagnostics: Array<{ file: string; line: number; column: number; code: string; text: string }> = []
  const listed: Array<string> = []
  const unlocated: Array<string> = []
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "")
    const located = locatedLine.exec(line)
    const last = diagnostics.at(-1)
    if (located !== null) {
      const [, file = "", lineNumber = "", column = "", code = "", head = ""] = located
      diagnostics.push({ file: path.resolve(cwd, file), line: Number(lineNumber), column: Number(column), code, text: head })
    } else if (line.startsWith(" ") && last !== undefined) {
      last.text += `\n${line}`
    } else if (listedLine.test(line)) {
      listed.push(path.resolve(cwd, line))
    } else if (line.trim() !== "") {
      unlocated.push(line)
    }
  }
  return { diagnostics: [...diagnostics].sort(compareDiagnostics), listed, unlocated }
}

const compareDiagnostics = (a: Diagnostic, b: Diagnostic): number =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column

/** One `// @expect-error TS<code> <mention>` line. */
export interface Expectation {
  readonly line: number
  readonly code: string
  readonly mention: string
}

/** A run of consecutive directives, or a `// @valid` block. `line` is the block's first comment line. */
export type Block =
  | { readonly kind: "expect"; readonly line: number; readonly expectations: ReadonlyArray<Expectation> }
  | { readonly kind: "valid"; readonly line: number }

/** The directive structure of one fail fixture, plus malformed-directive problems. */
export interface FixtureDirectives {
  readonly blocks: ReadonlyArray<Block>
  readonly problems: ReadonlyArray<string>
}

const directiveLine = /^\s*\/\/ @expect-error (TS\d+) (\S.*)$/
const validLine = /^\s*\/\/ @valid(?:\s.*)?$/
/**
 * A comment that starts with a marker, anywhere on a line. When it does not parse as the marker it is an error,
 * so a trailing `code() // @expect-error ...` or a `//@valid` is never silently ignored. Prose that merely
 * mentions a marker inside a comment is left alone.
 */
const directiveAttempt = /\/\/\s*@expect-error\b/
const validAttempt = /\/\/\s*@valid/
/** Compiler suppression comments hide the very text the snapshots exist to show. */
const suppression = /@ts-(?:expect-error|ignore|nocheck)\b/

/** A line that is code: not blank and not only a comment. */
const isCodeLine = (text: string): boolean => {
  const trimmed = text.trim()
  return trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("*")
}

/**
 * Parses the directive blocks of a fail fixture's source. Line numbers are 1-based. A `// @valid` block with no
 * code line before the next directive (or the end of the file) is a problem: an empty pass twin proves nothing
 * about the fixture's setup.
 */
export const parseDirectives = (source: string): FixtureDirectives => {
  const blocks: Array<Block> = []
  const problems: Array<string> = []
  const lines = source.split("\n")
  lines.forEach((text, index) => {
    const line = index + 1
    const directive = directiveLine.exec(text)
    if (directive !== null) {
      const [, code = "", mention = ""] = directive
      const expectation: Expectation = { line, code, mention: mention.trim() }
      const last = blocks.at(-1)
      if (last !== undefined && last.kind === "expect" && last.line + last.expectations.length === line) {
        blocks[blocks.length - 1] = { ...last, expectations: [...last.expectations, expectation] }
      } else {
        blocks.push({ kind: "expect", line, expectations: [expectation] })
      }
    } else if (directiveAttempt.test(text)) {
      problems.push(`L${line}: malformed directive; write "// @expect-error TS<code> <mention>" on its own line`)
    } else if (validLine.test(text)) {
      blocks.push({ kind: "valid", line })
    } else if (validAttempt.test(text)) {
      problems.push(`L${line}: malformed @valid marker; write "// @valid" on its own line`)
    }
  })
  blocks.forEach((block, index) => {
    if (block.kind !== "valid") return
    const end = blocks[index + 1]?.line ?? lines.length + 1
    if (!lines.slice(block.line, end - 1).some(isCodeLine)) {
      problems.push(`L${block.line}: the @valid block has no code before the next directive; its pass twin must exercise the fixture's setup`)
    }
  })
  return { blocks, problems }
}

/** Every directive mention in a fail fixture, in source order (the claims rules-check matches, §5.5). */
export const directiveMentions = (source: string): ReadonlyArray<string> =>
  parseDirectives(source).blocks.flatMap((block) => (block.kind === "expect" ? block.expectations.map((e) => e.mention) : []))

/** Problems every fixture (pass or fail) is checked for before its diagnostics are looked at. */
export const fixtureShapeProblems = (source: string): ReadonlyArray<string> => {
  const problems: Array<string> = []
  if (!/^\s*(?:import|export)\b/m.test(source)) {
    problems.push("a fixture must be a module (have an import or an export), because all fixtures share one program")
  }
  if (/^\s*declare\s+(?:global|module)\b/m.test(source)) {
    problems.push("a fixture must not use `declare global` or module augmentation, because all fixtures share one program")
  }
  source.split("\n").forEach((text, index) => {
    if (suppression.test(text)) {
      problems.push(`L${index + 1}: compiler suppression comments (@ts-expect-error, @ts-ignore, @ts-nocheck) are not allowed in fixtures`)
    }
  })
  return problems
}

/** Pass fixtures assert with `expectTypeOf` or `Equals`; one with neither proves nothing. */
export const passFixtureAsserts = (source: string): boolean => /\bexpectTypeOf\s*[<(]|\bEquals\s*</.test(source)

// ---- the readability gate (D2) -------------------------------------------------------------------

/** At most this many lines (head plus chain) per diagnostic. */
export const maxLines = 4
/** At most this many characters per diagnostic, measured after {@link collapseUnions}. */
export const maxGatedChars = 800

/** Unresolved names and imports: a fixture failing with one of these fails for the wrong reason. */
export const wrongReasonCodes: ReadonlySet<string> = new Set(["TS2304", "TS2305", "TS2307", "TS2552", "TS2614", "TS2724"])

/** Types that carry the rule's message; a truncation inside one can hide the mention. */
export const messageCarryingTypes: ReadonlyArray<string> = ["UnhandledErrors", "Invalid"]

const bannedTexts: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "exactOptionalPropertyTypes", pattern: /exactOptionalPropertyTypes/ },
  { label: "parameter of type 'never'", pattern: /parameter of type 'never'/ },
  { label: "type 'never'.", pattern: /type 'never'\./ },
  { label: "Expected N arguments", pattern: /Expected \d+(-\d+)? arguments/ }
]

/**
 * Collapses every run of two or more plain names or string literals joined by ` | ` into one token, so a
 * user's long tag list does not trip the size gate (the regex is the one in `[sd:check-fail.ts]`).
 */
export const collapseUnions = (text: string): string =>
  text.replace(/(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)(?:\s\|\s(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_]*))+/g, "U")

const truncationMarker = /\.\.\. \d+ more \.\.\./

/**
 * The text of each type-argument list of a message-carrying type, from just after its `<` to its matching
 * `>`. An unbalanced list (a cut-off type) runs to the end of the text, so it is still searched.
 */
export const messageTypeArguments = (text: string): ReadonlyArray<string> =>
  messageCarryingTypes.flatMap((name) =>
    [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_$])${name}<`, "g"))].map((match) => {
      const start = match.index + match[0].length
      return text.slice(start, scanTypeArguments(text, start).end)
    })
  )

/** The size of a diagnostic as the gate measures it. */
export interface DiagnosticSize {
  readonly lines: number
  readonly rawChars: number
  readonly gatedChars: number
}

/** Measures a diagnostic's text for the gate. */
export const measure = (text: string): DiagnosticSize => ({
  lines: text.split("\n").length,
  rawChars: text.length,
  gatedChars: collapseUnions(text).length
})

/**
 * Every reason one diagnostic fails its directive (§5.2 gate items 1-6). An empty list means it passes.
 */
export const gateProblems = (diagnostic: Diagnostic, want: Expectation): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const size = measure(diagnostic.text)
  if (wrongReasonCodes.has(diagnostic.code)) {
    problems.push(`wrong-reason code ${diagnostic.code} (an unresolved name or import)`)
  }
  if (diagnostic.code !== want.code) problems.push(`code ${diagnostic.code}, but the directive says ${want.code}`)
  if (size.lines > maxLines || size.gatedChars > maxGatedChars) {
    problems.push(`unreadable: ${size.lines} lines and ${size.gatedChars} gated characters (limit ${maxLines} lines, ${maxGatedChars} characters)`)
  }
  if (!diagnostic.text.includes(want.mention)) problems.push(`does not mention "${want.mention}"`)
  for (const banned of bannedTexts) {
    if (banned.pattern.test(diagnostic.text)) problems.push(`contains banned text "${banned.label}"`)
  }
  if (messageTypeArguments(diagnostic.text).some((args) => truncationMarker.test(args))) {
    problems.push(`truncates ("... N more ...") inside a message-carrying type (${messageCarryingTypes.join(", ")})`)
  }
  return problems
}

// ---- snapshots ---------------------------------------------------------------------------------

/**
 * Renders a fixture's diagnostics in the snapshot format: one block per diagnostic, `L<line>:<col> TS<code>`
 * followed by the text exactly as tsc printed it, blocks separated by a blank line.
 */
export const renderSnapshot = (diagnostics: ReadonlyArray<Diagnostic>): string =>
  diagnostics.map((d) => `L${d.line}:${d.column} ${d.code}\n${d.text}\n`).join("\n")

/** The snapshot path of a fail fixture: `<fixture>.diagnostics.txt` next to it. */
export const snapshotPathOf = (fixture: string): string => fixture.replace(/\.ts$/, ".diagnostics.txt")

// ---- whole-run checks --------------------------------------------------------------------------

/** A fixture file and its source. */
export interface Fixture {
  /** Absolute path. */
  readonly file: string
  readonly source: string
}

/** A fail fixture, its source and its committed snapshot (if any). */
export interface FailFixture extends Fixture {
  readonly snapshot: string | undefined
}

/** A fail fixture whose rendered diagnostics differ from its committed snapshot. */
export interface SnapshotMismatch {
  /** Absolute path of the snapshot file. */
  readonly snapshotPath: string
  readonly expected: string | undefined
  readonly actual: string
}

/** The outcome of checking every fixture against one compiler run. */
export interface RunCheck {
  /** Failures other than snapshot differences, each already prefixed with its location. */
  readonly problems: ReadonlyArray<string>
  readonly mismatches: ReadonlyArray<SnapshotMismatch>
  /** The largest gated size of a diagnostic that passed its gate, for the summary line. */
  readonly largestGatedChars: number
}

/**
 * Checks one compiler run against every pass and fail fixture: type-testing §6's failure modes plus the §5.2
 * gate. `root` is only used to print relative paths.
 */
export const checkRun = (
  tsc: TscOutput,
  passFixtures: ReadonlyArray<Fixture>,
  failFixtures: ReadonlyArray<FailFixture>,
  root: string
): RunCheck => {
  const problems: Array<string> = []
  const mismatches: Array<SnapshotMismatch> = []
  let largestGatedChars = 0
  const rel = (file: string): string => path.relative(root, file)
  const fixtureFiles = new Set([...passFixtures, ...failFixtures].map((f) => f.file))

  if (tsc.unlocated.length > 0) {
    problems.push(`tsc printed output that is not a located diagnostic:\n${tsc.unlocated.join("\n")}`)
  }
  // A fixture the program does not include would pass silently (type-testing §6, the dropped-fixture trap).
  const listed = new Set(tsc.listed)
  for (const file of fixtureFiles) {
    if (!listed.has(file)) problems.push(`${rel(file)}: not in the compiled program (check the include list of test/types/tsconfig.json)`)
  }
  for (const d of tsc.diagnostics) {
    if (!fixtureFiles.has(d.file)) problems.push(`${rel(d.file)}:${d.line}:${d.column} diagnostic outside the fixtures (${d.code})\n${d.text}`)
  }

  for (const fixture of passFixtures) {
    for (const problem of fixtureShapeProblems(fixture.source)) problems.push(`${rel(fixture.file)}: ${problem}`)
    if (!passFixtureAsserts(fixture.source)) problems.push(`${rel(fixture.file)}: pass fixture has no expectTypeOf or Equals assertion`)
    for (const d of tsc.diagnostics.filter((x) => x.file === fixture.file)) {
      problems.push(`${rel(fixture.file)}:${d.line}:${d.column} pass fixture has a type error (${d.code})\n${d.text}`)
    }
  }

  for (const fixture of failFixtures) {
    const name = rel(fixture.file)
    const own = tsc.diagnostics.filter((d) => d.file === fixture.file)
    const { blocks, problems: directiveProblems } = parseDirectives(fixture.source)
    for (const problem of [...fixtureShapeProblems(fixture.source), ...directiveProblems]) problems.push(`${name}: ${problem}`)
    if (!blocks.some((b) => b.kind === "expect")) problems.push(`${name}: fail fixture has no // @expect-error directive`)
    if (!blocks.some((b) => b.kind === "valid")) problems.push(`${name}: fail fixture has no // @valid block (its pass twin)`)
    if (own.length === 0) problems.push(`${name}: expected to fail but compiled cleanly`)
    // Each diagnostic belongs to the last block that starts above it, so every diagnostic has exactly one owner.
    const ownerOf = (d: Diagnostic): Block | undefined => blocks.findLast((b) => b.line < d.line)
    for (const d of own) {
      if (ownerOf(d) === undefined) problems.push(`${name}:${d.line}:${d.column} diagnostic before any directive (${d.code})\n${d.text}`)
    }
    blocks.forEach((block) => {
      const mine = own.filter((d) => ownerOf(d) === block)
      if (block.kind === "valid") {
        for (const d of mine) problems.push(`${name}:${d.line}:${d.column} diagnostic inside the @valid block at L${block.line} (${d.code})\n${d.text}`)
        return
      }
      const directives = block.expectations.map((e) => `${e.code} ${e.mention}`).join(", ")
      if (mine.length !== block.expectations.length) {
        problems.push(`${name}:${block.line}: // @expect-error block (${directives}) expects ${block.expectations.length} diagnostic(s), got ${mine.length}`)
      }
      mine.forEach((d, k) => {
        const want = block.expectations[Math.min(k, block.expectations.length - 1)]
        if (want === undefined) return
        const issues = gateProblems(d, want)
        if (issues.length > 0) {
          problems.push(`${name}:${d.line}:${d.column} ${d.code} fails its directive "${want.code} ${want.mention}": ${issues.join("; ")}\n${d.text}`)
        } else {
          largestGatedChars = Math.max(largestGatedChars, measure(d.text).gatedChars)
        }
      })
    })
    const actual = renderSnapshot(own)
    if (actual !== fixture.snapshot) {
      mismatches.push({ snapshotPath: snapshotPathOf(fixture.file), expected: fixture.snapshot, actual })
    }
  }
  return { problems, mismatches, largestGatedChars }
}
