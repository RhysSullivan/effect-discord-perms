import { defineConfig } from "vitest/config"

/**
 * Unit tests run under Node. `envDir` points at an empty directory, so Vite never loads the repository's
 * `.env` (which holds the Perms Lab tokens) into a test process (DESIGN §4.3, D14).
 */
export default defineConfig({
  envDir: "test/env",
  test: {
    include: ["test/unit/**/*.test.ts", "test/replay/**/*.test.ts"]
  }
})
