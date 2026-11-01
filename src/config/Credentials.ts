/**
 * Perms Lab credentials (DESIGN §4.3, §5.6; G3, D14).
 *
 * The only way any code in this repository reads a Perms Lab token. `layer` (the repository's `.env` and the
 * host's live lock) and `layerFrom` (the same, with the paths given, for tests):
 *
 * 1. takes the single-driver live lock (`harness/Lock.ts`) for the lifetime of the layer, so no two processes
 *    drive Perms Lab at once, whatever the entry point (harness, examples, dev runs);
 * 2. reads `.env` itself through `ConfigProvider.fromDotEnv` over the Bun file system. Every package script
 *    runs `bun --no-env-file`, so Bun never copies `.env` into `process.env`, and nothing is inherited from the
 *    shell;
 * 3. reads each token only as `Config.Redacted`, and decodes the IDs through the branded schemas.
 *
 * Tokens stay `Redacted` until dfx puts them in the `Authorization` header. They are never logged, printed,
 * put in spans or errors, or written to the truth table.
 *
 * Code that needs no Perms Lab token (unit tests with fake tokens) provides `Credentials` directly with
 * `Layer.succeed`; such tokens are not Perms Lab credentials, so no lock is needed.
 */
import { BunFileSystem } from "@effect/platform-bun"
import { Config, ConfigProvider, Context, Effect, Layer, type Redacted } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { hostname } from "node:os"
import * as Lock from "../../harness/Lock.ts"
import { ApplicationId, GuildId } from "../Snowflake.ts"

/** One bot identity's credentials. */
export interface IdentityCredentials {
  readonly token: Redacted.Redacted<string>
  readonly applicationId: ApplicationId
}

/** The three Perms Lab identities and the lab guild. */
export interface LabCredentials {
  readonly guildId: GuildId
  /** Perms Harness: Administrator, highest role; creates and changes all lab state. */
  readonly harness: IdentityCredentials
  /** Perms Subject: the bot under test. */
  readonly subject: IdentityCredentials
  /** Perms Target: the member the subject acts on. */
  readonly target: IdentityCredentials
}

/** The lab's credentials. Built only by `layer` (which holds the live lock) or by a test with fake tokens. */
export class Credentials extends Context.Service<Credentials, LabCredentials>()("config/Credentials") {}

/** The identity names, as they appear in the `.env` keys (`DISCORD_<NAME>_TOKEN`). */
export type Identity = "harness" | "subject" | "target"

const identity = (name: "HARNESS" | "SUBJECT" | "TARGET"): Config.Config<IdentityCredentials> =>
  Config.all({
    token: Config.Redacted(`DISCORD_${name}_TOKEN`),
    applicationId: Config.schema(ApplicationId, `DISCORD_${name}_APP_ID`)
  })

const config: Config.Config<LabCredentials> = Config.all({
  guildId: Config.schema(GuildId, "DISCORD_TEST_GUILD_ID"),
  harness: identity("HARNESS"),
  subject: identity("SUBJECT"),
  target: identity("TARGET")
})

/** Where the credentials and the live lock are. */
export interface Sources {
  /** The `.env` file holding the tokens and IDs. */
  readonly dotEnvPath: string
  /** The live lock taken before `.env` is read. */
  readonly lockPath: string
}

/**
 * Takes the live lock at `sources.lockPath`, then reads the credentials from `sources.dotEnvPath`. The lock is
 * released when the layer's scope closes. Nothing is read from `.env` unless the lock was taken.
 *
 * Fails with `LockHeld` if another live process holds the lock, `Config.ConfigError` if a value is missing or
 * malformed, and `PlatformError` if `.env` or the lock file cannot be read or written.
 */
export const layerFrom = (sources: Sources): Layer.Layer<Credentials, Lock.LockHeld | Config.ConfigError | PlatformError> =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      yield* Lock.acquire({
        path: sources.lockPath,
        owner: { hostname: hostname(), pid: process.pid, command: process.argv.slice(1).join(" ") },
        isAlive: Lock.isAlive
      })
      const provider = yield* ConfigProvider.fromDotEnv({ path: sources.dotEnvPath })
      const values = yield* config.pipe(Effect.provide(ConfigProvider.layer(provider)))
      return Credentials.of(values)
    })
  ).pipe(Layer.provide(BunFileSystem.layer))

/**
 * The Perms Lab credentials: the repository's `.env` (resolved from this module, so the working directory does
 * not matter) behind the host's live lock (`/tmp/effect-discord-perms-live.lock`). See {@link layerFrom}.
 */
export const layer: Layer.Layer<Credentials, Lock.LockHeld | Config.ConfigError | PlatformError> = layerFrom({
  dotEnvPath: new URL("../../.env", import.meta.url).pathname,
  lockPath: Lock.livePath
})
