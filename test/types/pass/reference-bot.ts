// The reference bot (DESIGN §2.11, §6 M10; examples/reference-bot/bot.ts), with exact types: each registration leaves
// only its service, the bot's runtime and the scope to provide (every library error is handled, none dies), and the
// running bot needs nothing and can fail only at startup.
import type { Config, Effect, Layer, Scope } from "effect"
import { expectTypeOf } from "vitest"
import type { BotRuntime, ChatInputCommand, StartupFailed, TextChannel, AnnouncementChannel } from "effect-discord-perms"
import { Handlers, layer, onMessage, onPoll, onReady, onVote, poll, type Polls } from "../../../examples/reference-bot/bot.ts"
import { Main } from "../../../examples/reference-bot/main.ts"
import type { LockHeld } from "../../../harness/Lock.ts"
import type { PlatformError } from "effect/PlatformError"

expectTypeOf(onMessage).toEqualTypeOf<Effect.Effect<void, never, BotRuntime | Scope.Scope>>()
expectTypeOf(onReady).toEqualTypeOf<Effect.Effect<void, never, BotRuntime | Scope.Scope>>()
expectTypeOf(onPoll).toEqualTypeOf<Effect.Effect<void, never, Polls | BotRuntime | Scope.Scope>>()
expectTypeOf(onVote).toEqualTypeOf<Effect.Effect<void, never, Polls | BotRuntime | Scope.Scope>>()
expectTypeOf(Handlers).toEqualTypeOf<Layer.Layer<never, never, Polls | BotRuntime>>()
expectTypeOf(poll).toEqualTypeOf<ChatInputCommand<"poll", { readonly options: { readonly question: string; readonly where?: TextChannel | AnnouncementChannel } }>>()
expectTypeOf(layer).returns.toEqualTypeOf<Layer.Layer<never, StartupFailed | Config.ConfigError>>()
// the entry point adds the live lock's and the .env file's failures (config/Credentials.ts)
expectTypeOf(Main).toEqualTypeOf<Layer.Layer<never, StartupFailed | Config.ConfigError | LockHeld | PlatformError>>()
