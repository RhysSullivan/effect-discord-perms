/**
 * The one TypeScript compiler every offline check uses (D32): the native `tsc` binary of the exactly pinned
 * `typescript` devDependency. Diagnostic text, hover text and compile counts all change between compiler
 * releases, so every script refuses to run when the installed compiler is not the pinned one.
 */
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { Schema } from "effect"

/** The repository root (the directory holding `package.json`). */
export const repoRoot: string = path.resolve(import.meta.dirname, "..", "..")

/** The slice of `package.json` the checks rely on. */
const PackageJson = Schema.Struct({
  devDependencies: Schema.Struct({ typescript: Schema.String })
})

const decodePackageJson = Schema.decodeUnknownSync(Schema.fromJsonString(PackageJson))

/** An exact `major.minor.patch` version; ranges such as `^7.0.2` are rejected. */
const exactVersion = /^\d+\.\d+\.\d+$/

/**
 * Reads the pinned TypeScript version from `package.json`.
 *
 * @throws a defect when `package.json` cannot be decoded or the version is a range rather than an exact pin.
 */
export const pinnedTypeScriptVersion = (root: string = repoRoot): string => {
  const version = decodePackageJson(fs.readFileSync(path.join(root, "package.json"), "utf8")).devDependencies.typescript
  if (!exactVersion.test(version)) {
    throw new Error(`package.json pins typescript as "${version}"; it must be an exact version such as "7.0.2" (D32)`)
  }
  return version
}

/**
 * The platform's native compiler binary, resolved the way `typescript/lib/getExePath.js` resolves it, so the
 * LSP and the CLI checks run exactly the program `node_modules/.bin/tsc` would `execve`.
 *
 * @throws a defect when the platform package is not installed.
 */
export const tscBinary = (root: string = repoRoot): string => {
  const binary = path.join(root, "node_modules", "@typescript", `typescript-${process.platform}-${process.arch}`, "lib", "tsc")
  if (!fs.existsSync(binary)) {
    throw new Error(`the native TypeScript compiler is not installed at ${path.relative(root, binary)}; run bun install`)
  }
  return binary
}

/** The output of one finished compiler process. */
export interface TscRun {
  readonly stdout: string
  readonly stderr: string
  /** The exit status; `null` when the process was killed by a signal. */
  readonly status: number | null
  readonly elapsedMs: number
}

/**
 * Runs the pinned compiler synchronously with `cwd` at the repository root.
 *
 * @throws a defect when the process cannot be spawned.
 */
export const runTsc = (args: ReadonlyArray<string>, root: string = repoRoot): TscRun => {
  const started = performance.now()
  const result = spawnSync(tscBinary(root), [...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (result.error !== undefined) throw result.error
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, elapsedMs: performance.now() - started }
}

/**
 * Asserts that the installed compiler is the pinned one and returns its version.
 *
 * @throws a defect when the versions differ; every snapshot and baseline would be meaningless.
 */
export const assertPinnedCompiler = (root: string = repoRoot): string => {
  const pinned = pinnedTypeScriptVersion(root)
  const printed = runTsc(["--version"], root).stdout.trim()
  const installed = printed.replace(/^Version /, "")
  if (installed !== pinned) {
    throw new Error(`the installed compiler is TypeScript ${installed}, but package.json pins ${pinned}; run bun install`)
  }
  return installed
}

/** Lists the `.ts` files under `dir` (recursively), as absolute paths in a stable order. */
export const listTypeScriptFiles = (dir: string): ReadonlyArray<string> =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".ts"))
        .map((file) => path.join(dir, file))
        .sort()
    : []

/** Lists the files under `dir` (recursively) whose names end with `suffix`, as absolute paths in a stable order. */
export const listFilesEndingWith = (dir: string, suffix: string): ReadonlyArray<string> =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(suffix))
        .map((file) => path.join(dir, file))
        .sort()
    : []
