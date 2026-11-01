/**
 * Hover snapshots (DESIGN §5.3, D31): `//  ^?` markers, their expectation comments and the snapshot format.
 * Pure; `scripts/hover.ts` asks the real language server (`tsc --lsp --stdio`) for the hover text.
 *
 * A marker sits on the line below the hovered code, with its caret under the hovered identifier, and states
 * what the hover must show:
 *
 * ```ts
 * export const sent = channel.send({ content: "hi" })
 * //           ^? names: Effect.Effect, MissingSendMessages; no-object
 * ```
 *
 * - `names: A, B` (required): each name appears in the hover as a whole identifier;
 * - `no-object` (optional): the error type argument of the hovered `Effect` contains no `{`, so the error
 *   channel reads as named types rather than a structural wall.
 */
import { scanTypeArguments } from "./typeText.ts"

/** What one marker requires of its hover. */
export interface HoverExpectation {
  readonly names: ReadonlyArray<string>
  readonly noObject: boolean
}

/** One `^?` marker: where to hover and what to expect. Lines and characters are 0-based, as in LSP. */
export interface HoverMarker {
  /** The 1-based line of the marker comment, for messages. */
  readonly markerLine: number
  /** The hovered position: the line above the marker, at the caret's column. */
  readonly position: { readonly line: number; readonly character: number }
  /** The hovered source line, trimmed, as written to the snapshot. */
  readonly source: string
  readonly expectation: HoverExpectation
}

/** The markers of one hover file, plus malformed-marker problems. */
export interface HoverMarkers {
  readonly markers: ReadonlyArray<HoverMarker>
  readonly problems: ReadonlyArray<string>
}

const markerLine = /^(\s*\/\/\s*)\^\?(.*)$/

/** Parses an expectation comment such as `names: A, B; no-object`. */
export const parseExpectation = (text: string): { readonly expectation: HoverExpectation } | { readonly problem: string } => {
  let names: ReadonlyArray<string> = []
  let noObject = false
  for (const clause of text.split(";").map((c) => c.trim()).filter((c) => c !== "")) {
    if (clause === "no-object") {
      noObject = true
      continue
    }
    const named = /^names:\s*(.*)$/.exec(clause)
    if (named === null) return { problem: `unknown expectation clause "${clause}" (use "names: A, B" and optionally "no-object")` }
    names = (named[1] ?? "").split(",").map((n) => n.trim()).filter((n) => n !== "")
  }
  if (names.length === 0) return { problem: `a marker needs "names: A, B" naming what the hover must show` }
  return { expectation: { names, noObject } }
}

/** Finds every `^?` marker in a hover file's source. */
export const parseMarkers = (source: string): HoverMarkers => {
  const lines = source.split("\n")
  const markers: Array<HoverMarker> = []
  const problems: Array<string> = []
  lines.forEach((text, index) => {
    const marker = markerLine.exec(text)
    if (marker === null) {
      if (text.includes("^?")) problems.push(`L${index + 1}: a marker must be a line of its own: "//  ^? names: ..."`)
      return
    }
    const above = lines[index - 1]
    if (above === undefined || markerLine.test(above)) {
      problems.push(`L${index + 1}: a marker must sit directly below the code it hovers`)
      return
    }
    const character = (marker[1] ?? "").length
    if (character >= above.length || /\s/.test(above[character] ?? " ")) {
      problems.push(`L${index + 1}: the caret points past the end of the line above or at whitespace`)
      return
    }
    const parsed = parseExpectation(marker[2] ?? "")
    if ("problem" in parsed) {
      problems.push(`L${index + 1}: ${parsed.problem}`)
      return
    }
    markers.push({ markerLine: index + 1, position: { line: index - 1, character }, source: above.trim(), expectation: parsed.expectation })
  })
  return { markers, problems }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Whether `name` occurs in `text` as a whole (possibly dotted) identifier. */
export const containsName = (text: string, name: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`).test(text)

/**
 * The top-level type arguments of the first `Effect` type in a hover (`Effect.Effect<...>` or `Effect<...>`),
 * or `undefined` when the hover shows none. String literals are skipped and `=>` does not close a list.
 */
export const effectTypeArguments = (text: string): ReadonlyArray<string> | undefined => {
  const opener = /(?<![A-Za-z0-9_$])(?:Effect\.)?Effect</.exec(text)
  if (opener === null) return undefined
  const list = scanTypeArguments(text, opener.index + opener[0].length)
  return list.closed ? list.args : undefined
}

/** Every way a hover text fails its marker's expectation. An empty list means it holds. */
export const expectationProblems = (hover: string, expectation: HoverExpectation): ReadonlyArray<string> => {
  const problems: Array<string> = []
  for (const name of expectation.names) {
    if (!containsName(hover, name)) problems.push(`hover does not show "${name}"`)
  }
  if (expectation.noObject) {
    const error = effectTypeArguments(hover)?.[1]
    if (error === undefined) problems.push("no-object: the hover shows no Effect type with an error argument")
    else if (error.includes("{")) problems.push(`no-object: the error type argument contains an object type: ${error}`)
  }
  return problems
}

/** One hovered marker, as written to the snapshot. */
export interface HoverResult {
  readonly source: string
  /** The plaintext hover value, verbatim (the `const x: ` prefix kept). */
  readonly value: string
}

/** Renders a hover file's snapshot: per marker, the hovered source line and the hover value, blank-line separated. */
export const renderHoverSnapshot = (results: ReadonlyArray<HoverResult>): string =>
  results.map((r) => `${r.source}\n${r.value}\n`).join("\n")

/** The snapshot path of a hover file: `<file>.hover.txt` next to it. */
export const hoverSnapshotPathOf = (file: string): string => file.replace(/\.ts$/, ".hover.txt")
