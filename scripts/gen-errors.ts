/**
 * Writes `src/errors/Missing.generated.ts` from discord-api-types' `PermissionFlagsBits` (DESIGN §2.2).
 *
 *   bun run gen:errors              rewrite the module
 *   bun run gen:errors -- --check   exit 1 if the committed module is missing or differs from what would be written
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { PermissionFlagsBits } from "discord-api-types/v10"
import { checkGenerated, errorCategories, generatedPath, permissionFlagNames, renderMissingModule } from "./lib/genErrors.ts"
import { repoRoot } from "./lib/tsc.ts"

const args = process.argv.slice(2)
const check = args.includes("--check")
const unknownArgs = args.filter((arg) => arg !== "--check")
if (unknownArgs.length > 0) {
  console.error(`unknown arguments: ${unknownArgs.join(" ")} (the only option is --check)`)
  process.exit(2)
}

const flags = permissionFlagNames(PermissionFlagsBits)
const rendered = renderMissingModule(flags)
const target = path.join(repoRoot, generatedPath)
const counts = `${flags.length} flags, ${errorCategories(flags).length} classes in ErrorCategories`

if (check) {
  const result = checkGenerated(fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined, rendered)
  switch (result.kind) {
    case "up-to-date":
      console.log(`gen:errors ok: ${generatedPath} is up to date (${counts})`)
      break
    case "missing":
      console.error(`gen:errors FAIL: ${generatedPath} does not exist; run bun run gen:errors`)
      process.exit(1)
      break
    case "stale":
      console.error(`gen:errors FAIL: ${generatedPath} is stale from line ${result.firstDifferentLine}; run bun run gen:errors and review the diff`)
      process.exit(1)
      break
  }
} else {
  fs.writeFileSync(target, rendered)
  console.log(`gen:errors wrote ${generatedPath} (${counts})`)
}
