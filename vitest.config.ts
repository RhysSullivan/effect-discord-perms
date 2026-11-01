import { defineConfig } from "vitest/config"

/**
 * Unit tests run under Node. `envDir` points at an empty directory, so Vite never loads the repository's
 * `.env` (which holds the Perms Lab tokens) into a test process (DESIGN §4.3, D14).
 *
 * Under the Bun runtime (`bun node_modules/.bin/vitest`, `bunx --bun vitest`), vitest starts its workers with
 * Bun's executable and without `--no-env-file`, so Bun itself would load `.env` into every worker. That run is
 * refused here, before any worker starts; `bun run test` runs vitest under Node.
 */
if (process.versions.bun !== undefined) {
  throw new Error("run the unit tests with `bun run test` (vitest under Node): under the Bun runtime, vitest's workers would load .env")
}

export default defineConfig({
  envDir: "test/env",
  test: {
    include: ["test/unit/**/*.test.ts", "test/replay/**/*.test.ts"]
  }
})
