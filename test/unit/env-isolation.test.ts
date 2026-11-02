import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import config from "../../vitest.config.ts"

/**
 * Credentials are bound to a process explicitly, never inherited (DESIGN §4.3, D14). Unit tests never need a
 * Perms Lab credential, so none may be visible to them. Only variable names are compared, never values.
 *
 * Two separate guarantees:
 * - nothing is inherited from the shell: no `DISCORD_` name in `process.env` (or in `import.meta.env`);
 * - Vite never reads the repository's `.env`: vitest's `envDir` is `test/env`, which holds nothing but its
 *   `.gitkeep`. Vite exposes only `VITE_`-prefixed names in `import.meta.env`, so a `DISCORD_` name could never
 *   show up there whatever `envDir` is; the configuration itself is what is asserted.
 */
describe("test environment", () => {
  const discordNames = (env: Readonly<Record<string, unknown>>): ReadonlyArray<string> => Object.keys(env).filter((name) => name.startsWith("DISCORD_"))
  const root = path.resolve(import.meta.dirname, "..", "..")

  it("has no DISCORD_ variables in process.env", () => {
    expect(discordNames(process.env)).toEqual([])
  })

  it("has no DISCORD_ variables in import.meta.env", () => {
    expect(discordNames(import.meta.env)).toEqual([])
  })

  it("points vitest's envDir at test/env, which holds only .gitkeep", () => {
    expect(config.envDir).toBeTypeOf("string")
    expect(path.resolve(root, String(config.envDir))).toBe(path.join(root, "test", "env"))
    expect(fs.readdirSync(path.join(root, "test", "env"))).toEqual([".gitkeep"])
  })
})
