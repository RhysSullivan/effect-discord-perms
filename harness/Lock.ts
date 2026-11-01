/**
 * The single-driver live lock (DESIGN §5.6). Only one process may drive Perms Lab at a time, whatever the
 * entry point, so `config/Credentials.ts` takes this lock before it reads any Perms Lab token.
 *
 * - The lock is a file created atomically (`wx`, O_CREAT | O_EXCL) holding the hostname, pid and command.
 * - A lock whose pid is dead **on this host** is taken over: the new owner writes a temporary file and renames
 *   it over the lock (an atomic replace), then reads the lock back and keeps it only if it holds its own pid.
 *   Two processes taking over the same stale lock in the same instant could, in one interleaving, both read
 *   back their own pid; that needs both to have read the stale lock before either renamed, and is accepted
 *   (§8 item 20 records that the lock is host-local in any case).
 * - A lock from another host, or one that cannot be read, is never taken over: its holder cannot be checked.
 * - The lock is released in the scope's finalizer, and only if it still holds this process's pid.
 */
import { Effect, FileSystem, Schema, type Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"

/** The lock path on the host that runs live commands (`minisforum`). */
export const livePath = "/tmp/effect-discord-perms-live.lock"

/** Who holds the lock. */
export const Holder = Schema.Struct({
  hostname: Schema.String,
  pid: Schema.Int,
  command: Schema.String
})
/** Who holds the lock. */
export type Holder = typeof Holder.Type

const HolderJson = Schema.fromJsonString(Holder)
const decodeHolder = Schema.decodeUnknownEffect(HolderJson)
const encodeHolder = Schema.encodeSync(HolderJson)

/** Another live process holds the lock (or a lock exists that cannot be checked). Nothing was read. */
export class LockHeld extends Schema.TaggedError<LockHeld>()("LockHeld", {
  path: Schema.String,
  /** The holder as recorded in the lock file, or a note when it cannot be read. */
  holder: Schema.String
}) {}

/** How to tell whether a pid on this host is alive. The default sends signal 0. */
export type IsAlive = (pid: number) => boolean

/**
 * Signal 0 checks that a process exists without touching it. ESRCH means it is gone; EPERM means it exists
 * but belongs to someone else, so it counts as alive.
 */
export const isAlive: IsAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

const describe = (holder: Holder): string => `${holder.hostname} pid ${holder.pid} (${holder.command})`

/**
 * Takes the lock at `path` for `owner` for the lifetime of the current scope.
 *
 * Fails with `LockHeld` when a live process on this host holds it, when the holder is on another host, or
 * when the lock file cannot be decoded. File-system failures other than "already exists" are
 * `PlatformError`s.
 */
export const acquire = (options: {
  readonly path: string
  readonly owner: Holder
  readonly isAlive: IsAlive
}): Effect.Effect<void, LockHeld | PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = encodeHolder(options.owner)

    const readHolder = fs.readFileString(options.path).pipe(
      Effect.flatMap((text) => decodeHolder(text)),
      Effect.mapError(() => new LockHeld({ path: options.path, holder: "a lock file that cannot be read or decoded" }))
    )

    const created = yield* fs.writeFileString(options.path, content, { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false))
    )

    if (!created) {
      const holder = yield* readHolder
      const stale = holder.hostname === options.owner.hostname && holder.pid !== options.owner.pid && !options.isAlive(holder.pid)
      if (!stale) return yield* new LockHeld({ path: options.path, holder: describe(holder) })
      const temporary = `${options.path}.${options.owner.pid}.tmp`
      yield* fs.writeFileString(temporary, content)
      yield* fs.rename(temporary, options.path)
      const after = yield* readHolder
      if (after.hostname !== options.owner.hostname || after.pid !== options.owner.pid) {
        return yield* new LockHeld({ path: options.path, holder: describe(after) })
      }
    }

    yield* Effect.addFinalizer(() =>
      readHolder.pipe(
        Effect.flatMap((holder) =>
          holder.hostname === options.owner.hostname && holder.pid === options.owner.pid ? fs.remove(options.path) : Effect.void
        ),
        Effect.catch((error) => Effect.logWarning(`live lock not released: ${error._tag}`))
      )
    )
  })
