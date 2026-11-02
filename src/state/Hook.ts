/**
 * The `DispatchHook` that feeds `GuildState` (DESIGN §4.5, D15). dfx runs it for every dispatch, serially per
 * shard and before publishing to subscribers, so the state cannot miss GUILD_CREATE (dfx.md §4). It is fast
 * (a pure reduction into a `SubscriptionRef`) and never fails: a failing hook makes dfx reconnect, so a payload
 * that does not decode is logged and marks its guild stale instead.
 */
import { DispatchHook } from "dfx/gateway"
import { Effect, Layer } from "effect"
import { GuildState } from "./GuildState.ts"

/** The hook: every dispatch goes through `GuildState.apply`. Provide it below dfx's gateway, in the same build as the state. */
export const layer = Layer.effect(
  DispatchHook,
  Effect.gen(function* () {
    const state = yield* GuildState
    return (payload) => state.apply(payload.t, payload.d)
  })
)
