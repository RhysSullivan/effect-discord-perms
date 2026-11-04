/**
 * The bot (DESIGN §2.7, §4.14; `[sd:src/bot.ts]`): `Bot.make` with the declared intents, `bot.on` for the
 * gateway's events, and the layers that run a bot.
 *
 * **`bot.on(event, handler)`** (D29, §4.14) subscribes to the build's dispatch stream (`gateway/Dispatches.ts`,
 * fed by the hook after the guild state, so no dispatch after `on` returns is missed). Each dispatch runs in its
 * own fiber as `decode(event).pipe(Effect.flatMap(handler), Effect.scoped, Effect.withSpan("discord.event.<NAME>"),
 * Effect.catchCause(report))`:
 *
 * - `Effect.scoped` gives each event its own scope, so a handler's finalizers run when that event finishes, not at
 *   shutdown;
 * - the span is applied before the recovery, so a failed handler still shows as failed in traces (D28);
 * - `report` logs an unhandled (transient) failure at Warning with its tag, a dispatch the library could not decode
 *   at Error (malformed) or Warning (a channel it could not resolve), and a defect at Error. Nothing escapes the
 *   event's fiber, so a failing handler never stops later events;
 * - handlers run concurrently and unordered (dfx semantics);
 * - `READY` already received when the handler registers (the build waits for the guild, so the first one always
 *   is) runs the handler once for that session, then again for every new session.
 *
 * The event name is checked against the declared intents (`IntentCheck`, D24), and the handler's result against
 * the boundary (`Handled`, D1, D6): only purely transient errors may escape.
 *
 * **Layers.** `Bot.layerWith(bot, config)` is the library's real build (`Internals.ts`: startup checks, guild
 * state, REST wrapper, the gateway with the capabilities codec) with the base `HttpClient` and the
 * `WebSocketConstructor` left open, so tests and the harness can wrap or replace them; `Bot.layer` provides Bun's.
 */
import { BunHttpClient, BunSocket } from "@effect/platform-bun"
import { Cause, type Config, Effect, Layer, Option, Predicate, type Scope } from "effect"
import type * as HttpClient from "effect/http/HttpClient"
import type * as Socket from "effect/socket/Socket"
import { type AnyEvent, decode, Dropped, type EventPayloads } from "../gateway/Events.ts"
import type { EventName, Intent, IntentCheck } from "../gateway/Intents.ts"
import type { Handled, UnhandledErrors } from "./Handler.ts"
import { BotInternals } from "./Internals.ts"
import { type BotConfig, BotRuntime } from "./Runtime.ts"
import type { StartupFailed } from "./Startup.ts"

export { type BotConfig, BotRuntime, type Runtime } from "./Runtime.ts"
export { type Intent, intentBits, privilegedIntents } from "../gateway/Intents.ts"

/** A bot definition: its declared intents, and `on` for the events they deliver. */
export interface Bot<I extends Intent> {
  readonly intents: ReadonlyArray<I>
  /**
   * Runs `handler` for every `event` dispatch while the caller's scope is open, each in its own fiber, scope and span
   * (see the module comment). Compiles only for an event the declared intents deliver, and a handler whose
   * remaining errors are all purely transient.
   */
  readonly on: <K extends EventName, A, E, R>(
    event: K & IntentCheck<K, NoInfer<I>>,
    handler: (event: EventPayloads<I>[K]) => Handled<A, E, R>
  ) => Effect.Effect<void, never, Exclude<R, Scope.Scope> | BotRuntime | Scope.Scope>
}

/**
 * A handler's checked result as the Effect it is at run time. `Handled<A, E, R>` is the Effect itself whenever the
 * program compiles (the boundary's message type has no runtime value), so the overload attaches the precise type to
 * the wide implementation (rule 7 of §2.12); anything else is a defect.
 */
function handled<A, E, R>(value: Handled<A, E, R>): Effect.Effect<A, E, R>
function handled(value: Effect.Effect<unknown, unknown, unknown> | UnhandledErrors<string>): Effect.Effect<unknown, unknown, unknown> {
  return Effect.isEffect(value) ? value : Effect.die(new Error("Bot.on: a handler returned no Effect"))
}

const tagOf = (error: unknown): string => (Predicate.hasProperty(error, "_tag") && typeof error._tag === "string" ? error._tag : "an untagged error")

/** What one event's failure is logged as (see the module comment); never fails. */
const report = (event: EventName) => <E>(cause: Cause.Cause<E>): Effect.Effect<void> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  const failure = Cause.findErrorOption(cause)
  if (Option.isNone(failure)) return Effect.logError(`discord.event.${event}: the handler died`, cause)
  const error = failure.value
  if (error instanceof Dropped) {
    return error.reason === "malformed" ? Effect.logError(`discord.event.${event}: a dispatch did not decode: ${error.detail}`) : Effect.logWarning(`discord.event.${event}: dropped: ${error.detail}`)
  }
  return Effect.logWarning(`discord.event.${event}: unhandled ${tagOf(error)}`)
}

/**
 * Subscribes `run` to `event`'s dispatches (see the module comment). The overload carries the payload type of the
 * declared intents; the implementation hands `run` what `decode` built, which for those intents is that type.
 */
function subscribe<I extends Intent, K extends EventName, A, E, R>(
  event: K,
  run: (payload: EventPayloads<I>[K]) => Effect.Effect<A, E, R>
): Effect.Effect<void, never, Exclude<R, Scope.Scope> | BotRuntime | Scope.Scope>
function subscribe<A, E, R>(event: EventName, run: (payload: AnyEvent) => Effect.Effect<A, E, R>): Effect.Effect<void, never, Exclude<R, Scope.Scope> | BotRuntime | Scope.Scope> {
  return Effect.gen(function* () {
    const runtime = yield* BotRuntime
    const once = (payload: Effect.Effect<AnyEvent, Dropped | import("../errors/Transient.ts").Transient>) =>
      payload.pipe(Effect.flatMap(run), Effect.scoped, Effect.withSpan(`discord.event.${event}`), Effect.catchCause(report(event)))
    if (event === "READY") {
      const user = (yield* runtime.guildState.snapshot).botUserId
      if (user !== undefined) yield* Effect.forkScoped(once(Effect.succeed({ userId: user })))
    }
    yield* runtime.events.subscribe(event, (data) => once(decode(runtime, event, data)))
  })
}

const makeBot = <I extends Intent>(intents: ReadonlyArray<I>): Bot<I> => {
  function on<K extends EventName, A, E, R>(
    event: K & IntentCheck<K, NoInfer<I>>,
    handler: (event: EventPayloads<I>[K]) => Handled<A, E, R>
  ): Effect.Effect<void, never, Exclude<R, Scope.Scope> | BotRuntime | Scope.Scope> {
    return subscribe<I, K, A, E, R>(event, (payload) => handled(handler(payload)))
  }
  return { intents, on }
}

/** The bot constructors and layers (§2.7, §4.2). */
export const Bot = {
  /** A bot that identifies with exactly `intents`. */
  make: <const I extends ReadonlyArray<Intent>>(config: { readonly intents: I }): Bot<I[number]> => makeBot(config.intents),
  /**
   * The bot's runtime: startup checks 1-3 (§4.4), the guild state, the REST wrapper and the gateway (with the
   * capabilities codec), waiting for the configured guild's GUILD_CREATE (check 4). The base `HttpClient` and the
   * `WebSocketConstructor` are left open.
   */
  layerWith: <I extends Intent>(bot: Bot<I>, config: BotConfig): Layer.Layer<BotRuntime, StartupFailed | Config.ConfigError, HttpClient.HttpClient | Socket.WebSocketConstructor> =>
    Layer.effect(BotRuntime, Effect.service(BotRuntime)).pipe(Layer.provide(BotInternals.layerWith(bot, config))),
  /** {@link Bot.layerWith} over Bun's HTTP client and WebSocket. */
  layer: <I extends Intent>(bot: Bot<I>, config: BotConfig): Layer.Layer<BotRuntime, StartupFailed | Config.ConfigError> =>
    Bot.layerWith(bot, config).pipe(Layer.provide(Layer.mergeAll(BunHttpClient.layer, BunSocket.layerWebSocketConstructor)))
}
