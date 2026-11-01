/**
 * Hover snapshots (DESIGN §5.3, D31).
 *
 *   bun run hover               check every test/hover/*.ts marker against its expectation and its snapshot
 *   bun run hover -- --update   also rewrite the snapshots (review the diff; verify:offline never passes it)
 *
 * The hover text comes from the real language server (`tsc --lsp --stdio`), so it is what the editor shows.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { Schema } from "effect"
import { expectationProblems, type HoverResult, hoverSnapshotPathOf, parseMarkers, renderHoverSnapshot } from "./lib/hover.ts"
import { startLsp } from "./lib/lsp.ts"
import { assertPinnedCompiler, listFilesEndingWith, listTypeScriptFiles, repoRoot, tscBinary } from "./lib/tsc.ts"

const args = process.argv.slice(2)
const update = args.includes("--update")
const unknownArgs = args.filter((arg) => arg !== "--update")
if (unknownArgs.length > 0) {
  console.error(`unknown arguments: ${unknownArgs.join(" ")} (the only option is --update)`)
  process.exit(2)
}

/** The hover result shape for plaintext content (the client only accepts plaintext). */
const HoverResponse = Schema.NullOr(Schema.Struct({ contents: Schema.Struct({ kind: Schema.String, value: Schema.String }) }))
const decodeHover = Schema.decodeUnknownSync(HoverResponse)

const hoverDir = path.join(repoRoot, "test", "hover")
const files = listTypeScriptFiles(hoverDir)
const rel = (file: string): string => path.relative(repoRoot, file)
const failures: Array<string> = []
let markerCount = 0
let written = 0

assertPinnedCompiler()
if (files.length === 0) failures.push("test/hover has no hover files")

const rootUri = pathToFileURL(repoRoot).href
const lsp = startLsp(tscBinary(), repoRoot, 60_000)
try {
  await lsp.request("initialize", {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: path.basename(repoRoot) }],
    capabilities: { textDocument: { hover: { contentFormat: ["plaintext"] } } }
  })
  lsp.notify("initialized", {})
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8")
    const { markers, problems } = parseMarkers(source)
    for (const problem of problems) failures.push(`${rel(file)}:${problem}`)
    if (markers.length === 0) failures.push(`${rel(file)}: hover file has no //  ^? marker`)
    const uri = pathToFileURL(file).href
    lsp.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text: source } })
    const results: Array<HoverResult> = []
    for (const marker of markers) {
      markerCount++
      const hover = decodeHover(await lsp.request("textDocument/hover", { textDocument: { uri }, position: marker.position }))
      if (hover === null) {
        failures.push(`${rel(file)}:L${marker.markerLine}: no hover at the marked position`)
        continue
      }
      if (hover.contents.kind !== "plaintext") {
        failures.push(`${rel(file)}:L${marker.markerLine}: hover content is ${hover.contents.kind}, not plaintext`)
        continue
      }
      const value = hover.contents.value
      results.push({ source: marker.source, value })
      for (const problem of expectationProblems(value, marker.expectation)) {
        failures.push(`${rel(file)}:L${marker.markerLine}: ${problem}\n${value}`)
      }
    }
    lsp.notify("textDocument/didClose", { textDocument: { uri } })
    const snapshotPath = hoverSnapshotPathOf(file)
    const actual = renderHoverSnapshot(results)
    const expected = fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, "utf8") : undefined
    if (actual === expected) continue
    if (update) {
      fs.writeFileSync(snapshotPath, actual)
      written++
    } else {
      failures.push(
        `${rel(snapshotPath)}: hover snapshot ${expected === undefined ? "missing" : "differs"} (run with -- --update and review)\n` +
          `--- expected\n${expected ?? "<none>"}\n+++ actual\n${actual}`
      )
    }
  }
} finally {
  await lsp.shutdown()
}

const liveSnapshots = new Set(files.map(hoverSnapshotPathOf))
for (const snapshot of listFilesEndingWith(hoverDir, ".hover.txt")) {
  if (liveSnapshots.has(snapshot)) continue
  if (update) {
    fs.rmSync(snapshot)
    written++
  } else {
    failures.push(`${rel(snapshot)}: hover snapshot has no hover file (run with -- --update to delete it)`)
  }
}

const summary = `${files.length} hover file(s), ${markerCount} marker(s)` + (update ? `, ${written} snapshot file(s) written or deleted` : "")
if (failures.length > 0) {
  console.error(failures.join("\n\n"))
  console.error(`\nhover FAIL ${failures.length} problem(s); ${summary}`)
  process.exit(1)
}
console.log(`hover ok ${summary}`)
