/**
 * Scanning printed TypeScript type text (diagnostics and hovers) for generic argument lists.
 */

/** A type-argument list read from printed type text. */
export interface TypeArgumentList {
  /** The top-level arguments, trimmed. */
  readonly args: ReadonlyArray<string>
  /** Index just past the closing `>`, or the text's length when the list never closes. */
  readonly end: number
  /** False when the text ended before the list closed (for example, a cut-off type). */
  readonly closed: boolean
}

/**
 * Reads the type-argument list whose first argument starts at `start` (just after a `<`). Nested `<>`, `()`,
 * `[]` and `{}` are tracked, string literals are skipped, and the `>` of `=>` is not a closer.
 */
export const scanTypeArguments = (text: string, start: number): TypeArgumentList => {
  const args: Array<string> = []
  let depth = 0
  let current = ""
  let index = start
  while (index < text.length) {
    const char = text[index] ?? ""
    if (char === '"' || char === "'") {
      const end = endOfStringLiteral(text, index)
      current += text.slice(index, end)
      index = end
      continue
    }
    const isCloseAngle = char === ">" && text[index - 1] !== "="
    if (depth === 0 && isCloseAngle) {
      args.push(current.trim())
      return { args, end: index + 1, closed: true }
    }
    if (depth === 0 && char === ",") {
      args.push(current.trim())
      current = ""
    } else {
      if (char === "<" || char === "(" || char === "[" || char === "{") depth++
      else if (char === ")" || char === "]" || char === "}" || isCloseAngle) depth--
      current += char
    }
    index++
  }
  if (current.trim() !== "") args.push(current.trim())
  return { args, end: text.length, closed: false }
}

/** Index just past the string literal that opens at `start`; TypeScript prints escapes with a backslash. */
export const endOfStringLiteral = (text: string, start: number): number => {
  const quote = text[start]
  let index = start + 1
  while (index < text.length && text[index] !== quote) index += text[index] === "\\" ? 2 : 1
  return Math.min(index + 1, text.length)
}
