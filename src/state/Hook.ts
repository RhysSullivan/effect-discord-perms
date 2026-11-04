/**
 * The `DispatchHook` that feeds `GuildState` (DESIGN §4.5, D15). dfx runs it for every dispatch, serially per
 * shard and before publishing to subscribers, so the state cannot miss GUILD_CREATE (dfx.md §4). It is fast
 * (a pure reduction into a `SubscriptionRef`) and never fails: a failing hook makes dfx reconnect, so a payload
 * that does not decode is logged and marks its guild stale instead.
 */
import { DispatchHook } from "dfx/gateway"
import { Context, Effect, Layer } from "effect"
import { Dispatches } from "../gateway/Dispatches.ts"
import { GuildState } from "./GuildState.ts"

/**
 * A second observer of every dispatch, after the reducer (internal: the harness's intent sessions record what
 * Discord delivered with it, from the first dispatch on, M7). It must be fast and never fail, like the hook. The
 * default observes nothing.
 */
export const DispatchTap = Context.Reference<(event: string, data: unknown) => Effect.Effect<void>>("state/DispatchTap", { defaultValue: () => () => Effect.void })

/**
 * The hook: every dispatch goes through `GuildState.apply`, then the tap, then the bot's dispatch stream
 * (`bot.on`, `gateway/Dispatches.ts`), so a handler sees a state that includes its event. Provide it below dfx's
 * gateway, in the same build as the state and the stream.
 */
export const layer = Layer.effect(
  DispatchHook,
  Effect.gen(function* () {
    const state = yield* GuildState
    const tap = yield* DispatchTap
    const dispatches = yield* Dispatches
    return (payload) => Effect.andThen(state.apply(payload.t, payload.d), Effect.andThen(tap(payload.t, payload.d), dispatches.publish({ event: payload.t, data: payload.d })))
  })
)
