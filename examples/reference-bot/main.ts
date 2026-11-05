/**
 * Runs the reference bot (`bot.ts`) as Perms Subject in Perms Lab, until interrupted:
 *
 *   bun --no-env-file examples/reference-bot/main.ts
 *
 * The token is read the only way this repository reads a Perms Lab token: through `config/Credentials.ts`, which takes
 * the host's live lock first and holds it while the bot runs (DESIGN §4.3, §5.6), so the bot never drives Perms Lab
 * while the harness does. Run it only on minisforum (the lock is host-local) and only when nothing else live runs.
 * `/poll` is registered in Perms Lab at startup; the next harness reset removes it. Unlike the harness's identities,
 * its requests do not pass the lab guard (§5.6, which lives in the harness's shared client): it is an ordinary bot,
 * run by hand only. `test/unit/reference-bot.test.ts` drives it through the real bot build over a fake Discord.
 *
 * Every startup failure is a typed error (`StartupFailed`, `ConfigError`, `LockHeld`, `PlatformError`), which
 * `runMain` reports before exiting non-zero.
 */
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Credentials, layer as labCredentials } from "../../src/config/Credentials.ts"
import * as ReferenceBot from "./bot.ts"

/** The reference bot with the subject's token, in the lab guild, behind the live lock. */
export const Main = Layer.unwrap(Effect.map(Effect.service(Credentials), (lab) => ReferenceBot.layer({ token: lab.subject.token, guildId: lab.guildId }))).pipe(
  Layer.provide(labCredentials)
)

if (import.meta.main) BunRuntime.runMain(Layer.launch(Main))
