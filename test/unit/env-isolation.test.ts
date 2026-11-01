import { describe, expect, it } from "vitest"

/**
 * Credentials are bound to a process explicitly, never inherited (DESIGN §4.3, D14). Unit tests never need a
 * Perms Lab credential, so none may be visible to them: not loaded by Vite from `.env` (vitest's `envDir` is
 * the empty `test/env`), and not inherited from the shell. Only variable names are compared, never values.
 */
describe("test environment", () => {
  const discordNames = (env: Readonly<Record<string, unknown>>): ReadonlyArray<string> => Object.keys(env).filter((name) => name.startsWith("DISCORD_"))

  it("has no DISCORD_ variables in process.env", () => {
    expect(discordNames(process.env)).toEqual([])
  })

  it("has no DISCORD_ variables in import.meta.env", () => {
    expect(discordNames(import.meta.env)).toEqual([])
  })
})
