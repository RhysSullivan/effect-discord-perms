/**
 * The bot's own dispatch stream (DESIGN §4.14, D29; M7). The `DispatchHook` (`state/Hook.ts`) publishes every
 * dispatch here after reducing it into the guild state, so a handler always sees a state that includes its event.
 * `subscribe` takes its subscription in the caller's fiber before it returns, so no dispatch published after
 * `bot.on(...)` completes is missed (dfx's `handleDispatch` subscribes inside a forked fiber, and its first
 * handler failure ends the subscription; neither suits `bot.on`, dfx.md §4).
 *
 * Each matching dispatch runs `handle` in its own fiber, forked in the subscriber's scope: handlers run
 * concurrently and unordered, and closing the scope interrupts the loop and the handlers in flight.
 */
import { Context, Effect, Layer, PubSub, Scope } from "effect"
import type { EventName } from "./Intents.ts"

/**
 * A dispatch a subscriber can name: an event `bot.on` supports, or INTERACTION_CREATE, which needs no intent and which
 * the interaction runner (`interactions/Runner.ts`, phase 3) subscribes to.
 */
export type DispatchName = EventName | "INTERACTION_CREATE"

/** One dispatch: its event name and Discord's payload. */
export interface Dispatch {
  readonly event: string
  readonly data: unknown
}

/** The dispatch stream of one bot build. */
export interface Interface {
  /** Publishes a dispatch (the hook's, after the reducer). Never fails. */
  readonly publish: (dispatch: Dispatch) => Effect.Effect<void>
  /**
   * Runs `handle` in its own fiber for every dispatch named `name` published from now until the scope closes (see
   * the module comment). Returns once subscribed.
   */
  readonly subscribe: <R>(name: DispatchName, handle: (data: unknown) => Effect.Effect<void, never, R>) => Effect.Effect<void, never, R | Scope.Scope>
}

/** The dispatch stream of one bot build (internal; `bot.on` reads it through `BotRuntime.events`). */
export class Dispatches extends Context.Service<Dispatches, Interface>()("gateway/Dispatches") {}

/** The stream, shut down with the build. */
export const layer: Layer.Layer<Dispatches> = Layer.effect(
  Dispatches,
  Effect.gen(function* () {
    const hub = yield* Effect.acquireRelease(PubSub.unbounded<Dispatch>(), PubSub.shutdown)
    const subscribe = <R>(name: DispatchName, handle: (data: unknown) => Effect.Effect<void, never, R>): Effect.Effect<void, never, R | Scope.Scope> =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const subscription = yield* PubSub.subscribe(hub)
        const loop = Effect.forever(
          Effect.flatMap(PubSub.take(subscription), (dispatch) => (dispatch.event === name ? Effect.asVoid(Effect.forkIn(handle(dispatch.data), scope)) : Effect.void))
        )
        yield* Effect.forkIn(loop, scope)
      })
    return Dispatches.of({ publish: (dispatch) => Effect.asVoid(PubSub.publish(hub, dispatch)), subscribe })
  })
)
