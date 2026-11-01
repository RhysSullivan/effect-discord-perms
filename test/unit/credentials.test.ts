import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option, Redacted, Scope } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { LockHeld } from "../../harness/Lock.ts"
import { Credentials, layerFrom } from "../../src/config/Credentials.ts"
import { GuildId } from "../../src/Snowflake.ts"

/**
 * The credentials layer (DESIGN §4.3, §5.6): it takes the live lock before it reads `.env`, reads tokens only as
 * `Redacted` and decodes the branded IDs. Every file here is a temporary one with fake values.
 */
const values = {
  DISCORD_TEST_GUILD_ID: "100000000000000000",
  DISCORD_HARNESS_TOKEN: "fake-h",
  DISCORD_HARNESS_APP_ID: "100000000000000001",
  DISCORD_SUBJECT_TOKEN: "fake-s",
  DISCORD_SUBJECT_APP_ID: "100000000000000002",
  DISCORD_TARGET_TOKEN: "fake-t",
  DISCORD_TARGET_APP_ID: "100000000000000003"
}

const sources = (dotEnv: Readonly<Record<string, string>> | undefined) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edp-credentials-"))
  const dotEnvPath = path.join(dir, ".env")
  if (dotEnv !== undefined) fs.writeFileSync(dotEnvPath, Object.entries(dotEnv).map(([key, value]) => `${key}=${value}\n`).join(""))
  return { dotEnvPath, lockPath: path.join(dir, "live.lock") }
}

/** A lock held by pid 1 on this host: alive (signal 0 answers EPERM or succeeds), so never taken over. */
const holdLock = (lockPath: string) => fs.writeFileSync(lockPath, JSON.stringify({ hostname: os.hostname(), pid: 1, command: "another live run" }))

const build = (paths: { readonly dotEnvPath: string; readonly lockPath: string }) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const exit = yield* Layer.buildWithScope(layerFrom(paths), scope).pipe(Effect.exit)
    return { exit, scope }
  })

describe("the credentials layer", () => {
  it.effect("takes the lock, reads tokens as Redacted and decodes the branded IDs, and releases the lock", () =>
    Effect.gen(function* () {
      const paths = sources(values)
      const { exit, scope } = yield* build(paths)
      if (!Exit.isSuccess(exit)) throw new Error("expected the layer to build")
      expect(fs.existsSync(paths.lockPath)).toBe(true)
      const credentials = yield* Credentials.pipe(Effect.provideContext(exit.value))
      expect(credentials.guildId).toBe(GuildId.make("100000000000000000"))
      expect(String(credentials.subject.token)).not.toContain("fake-s")
      expect(Redacted.value(credentials.subject.token)).toBe("fake-s")
      expect(credentials.target.applicationId).toBe("100000000000000003")
      yield* Scope.close(scope, Exit.void)
      expect(fs.existsSync(paths.lockPath)).toBe(false)
    })
  )

  it.effect("fails on a malformed ID, and still releases the lock", () =>
    Effect.gen(function* () {
      const paths = sources({ ...values, DISCORD_TEST_GUILD_ID: "Perms Lab" })
      const { exit, scope } = yield* build(paths)
      expect(Exit.isFailure(exit)).toBe(true)
      yield* Scope.close(scope, Exit.void)
      expect(fs.existsSync(paths.lockPath)).toBe(false)
    })
  )

  it.effect("fails with LockHeld while another live process holds the lock, before reading .env", () =>
    Effect.gen(function* () {
      const present = sources(values)
      holdLock(present.lockPath)
      const held = yield* build(present)
      expect(held.exit).toEqual(Exit.fail(new LockHeld({ path: present.lockPath, holder: `${os.hostname()} pid 1 (another live run)` })))

      yield* Scope.close(held.scope, Exit.void)

      // With no .env at all, a free lock gets as far as reading it (a PlatformError), but a held lock stops first.
      const absent = sources(undefined)
      const unread = yield* build(absent)
      const failure = Exit.isFailure(unread.exit) ? Option.map(Cause.findErrorOption(unread.exit.cause), (error) => error._tag) : Option.none()
      expect(failure).toEqual(Option.some("PlatformError"))
      yield* Scope.close(unread.scope, Exit.void)
      holdLock(absent.lockPath)
      const stopped = yield* build(absent)
      expect(stopped.exit).toEqual(Exit.fail(new LockHeld({ path: absent.lockPath, holder: `${os.hostname()} pid 1 (another live run)` })))
      yield* Scope.close(stopped.scope, Exit.void)
      expect(fs.readFileSync(absent.lockPath, "utf8")).toContain("another live run")
    })
  )
})
