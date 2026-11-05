import { BunFileSystem } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { onTestFinished } from "vitest"
import { Effect, Exit, FileSystem, Scope } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { acquire, type Holder, LockHeld } from "../../harness/Lock.ts"

/**
 * The single-driver live lock (DESIGN §5.6): created atomically, refused while a live process on this host
 * holds it, taken over by rename when its pid is dead, never taken from another host, and released only by
 * its owner.
 */
const me: Holder = { hostname: "host-a", pid: 1000, command: "harness smoke" }
const other: Holder = { hostname: "host-a", pid: 2000, command: "harness reset" }
/** A fresh temporary directory, removed when the current test finishes. */
const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const tempLock = () => path.join(tempDir("edp-lock-"), "live.lock")
const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"))
const withLock = (file: string, owner: Holder, alive: ReadonlyArray<number>) =>
  acquire({ path: file, owner, isAlive: (pid) => alive.includes(pid) })

describe("the live lock", () => {
  it.effect("is created with the holder and removed when the scope closes", () =>
    Effect.gen(function* () {
      const file = tempLock()
      const scope = yield* Scope.make()
      yield* withLock(file, me, [1000]).pipe(Scope.provide(scope))
      expect(read(file)).toEqual(me)
      yield* Scope.close(scope, Exit.void)
      expect(fs.existsSync(file)).toBe(false)
    }).pipe(Effect.provide(BunFileSystem.layer))
  )

  it.effect("is refused while a live process on this host holds it, and left in place", () =>
    Effect.gen(function* () {
      const file = tempLock()
      fs.writeFileSync(file, JSON.stringify(other))
      const exit = yield* withLock(file, me, [1000, 2000]).pipe(Effect.scoped, Effect.exit)
      expect(exit).toEqual(Exit.fail(new LockHeld({ path: file, holder: "host-a pid 2000 (harness reset)" })))
      expect(read(file)).toEqual(other)
    }).pipe(Effect.provide(BunFileSystem.layer))
  )

  it.effect("is taken over when the holder's pid is dead on this host", () =>
    Effect.gen(function* () {
      const file = tempLock()
      fs.writeFileSync(file, JSON.stringify(other))
      const scope = yield* Scope.make()
      yield* withLock(file, me, [1000]).pipe(Scope.provide(scope))
      expect(read(file)).toEqual(me)
      expect(fs.readdirSync(path.dirname(file))).toEqual(["live.lock"])
      yield* Scope.close(scope, Exit.void)
      expect(fs.existsSync(file)).toBe(false)
    }).pipe(Effect.provide(BunFileSystem.layer))
  )

  it.effect("is never taken from another host, nor when the lock file cannot be decoded", () =>
    Effect.gen(function* () {
      const remote = tempLock()
      fs.writeFileSync(remote, JSON.stringify({ ...other, hostname: "host-b" }))
      const fromRemote = yield* withLock(remote, me, [1000]).pipe(Effect.scoped, Effect.exit)
      expect(Exit.isFailure(fromRemote)).toBe(true)
      expect(read(remote)).toEqual({ ...other, hostname: "host-b" })

      const garbled = tempLock()
      fs.writeFileSync(garbled, "not json")
      const fromGarbled = yield* withLock(garbled, me, [1000]).pipe(Effect.scoped, Effect.exit)
      expect(fromGarbled).toEqual(Exit.fail(new LockHeld({ path: garbled, holder: "a lock file that cannot be read or decoded" })))
    }).pipe(Effect.provide(BunFileSystem.layer))
  )

  it.effect("is not removed by a scope that no longer owns it", () =>
    Effect.gen(function* () {
      const file = tempLock()
      const scope = yield* Scope.make()
      yield* withLock(file, me, [1000]).pipe(Scope.provide(scope))
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.writeFileString(file, JSON.stringify(other))
      yield* Scope.close(scope, Exit.void)
      expect(read(file)).toEqual(other)
    }).pipe(Effect.provide(BunFileSystem.layer))
  )
})
