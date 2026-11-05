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
 * **The declared intents must be the running build's.** The types of `bot.on` (which events compile, whether
 * `content` is a `string`) follow the intents of the `Bot` whose `on` is called, while delivery follows the build in
 * `BotRuntime`. Registering on a `Bot` that declares an intent the running build did not identify with (a program
 * provided `Bot.layer` of another `Bot`) would let `content: string` compile and receive `ContentUnavailable`, so
 * `on` dies at registration naming the intents the build lacks (after the M7 verifier). A build with more intents
 * than the `Bot` only makes the types conservative.
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
import type { Invalid, IsUnion } from "../payload/Components.ts"
import { type Handled, handledEffect } from "./Handler.ts"
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
  declared: ReadonlyArray<I>,
  event: K,
  run: (payload: EventPayloads<I>[K]) => Effect.Effect<A, E, R>
): Effect.Effect<void, never, Exclude<R, Scope.Scope> | BotRuntime | Scope.Scope>
function subscribe<A, E, R>(declared: ReadonlyArray<Intent>, event: EventName, run: (payload: AnyEvent) => Effect.Effect<A, E, R>): Effect.Effect<void, never, Exclude<R, Scope.Scope> | BotRuntime | Scope.Scope> {
  return Effect.gen(function* () {
    const runtime = yield* BotRuntime
    const lacking = declared.filter((intent) => !runtime.intents.includes(intent))
    if (lacking.length > 0) {
      return yield* Effect.die(
        new Error(`bot.on("${event}"): this Bot declares ${lacking.join(", ")}, which the running bot build did not identify with; provide Bot.layer of the same Bot`)
      )
    }
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
    return subscribe<I, K, A, E, R>(intents, event, (payload) => handledEffect(handler(payload), "Bot.on"))
  }
  return { intents, on }
}

/**
 * The declared intents must be written as a list of literals (after the final audit, and round 2): the types read
 * them off the list's type (`I[number]`), so a type wider than the value would let events (and `content: string`)
 * compile that the bot, identifying with fewer intents, never receives. Each such list is an error on `Bot.make`'s
 * argument that names the rule:
 *
 * - a list whose type is not a tuple (`ReadonlyArray<Intent>`);
 * - an element typed as a union of intents (`[cond ? "GuildMembers" : "GuildMessages"]`, `[one]` with `one: Intent`);
 * - a list typed as a union of tuples (`[...(cond ? ["MessageContent"] as const : [] as const)]`).
 *
 * It is intersected onto the whole argument, not onto the list, so tsc does not elaborate a union of tuples element by
 * element (which named no rule). An intent chosen at run time is a choice between two `Bot`s, each with a literal list.
 */
export type LiteralIntents<I extends ReadonlyArray<Intent>> = number extends I["length"]
  ? Invalid<"intents must be written as a literal list: Bot.make({ intents: [...] })">
  : true extends IsUnion<I>
    ? Invalid<"each intent must be a literal, not a union or a conditional spread">
    : { readonly [K in keyof I]: IsUnion<I[K]> } extends ReadonlyArray<false>
      ? unknown
      : Invalid<"each intent must be a literal, not a union or a conditional spread">

/**
 * A bot whose intents are a run-time value (internal, not in the public barrel: the harness's intent sessions). Its
 * types follow every intent, so they hold only for a caller that reads each event as the widest payload
 * (`EventPayloads<Intent>`), as the sessions do; `bot.on`'s registration check still dies if the build lacks an intent.
 */
export const botWithRuntimeIntents = (intents: ReadonlyArray<Intent>): Bot<Intent> => makeBot(intents)

/** The bot constructors and layers (§2.7, §4.2). */
export const Bot = {
  /** A bot that identifies with exactly `intents`, written as a list of literals ({@link LiteralIntents}). */
  make: <const I extends ReadonlyArray<Intent>>(config: { readonly intents: I } & LiteralIntents<I>): Bot<I[number]> => makeBot(config.intents),
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
