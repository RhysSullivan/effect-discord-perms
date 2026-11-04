/**
 * Library internals the harness needs and the public barrel never exports (DESIGN §1.2, §4.2).
 *
 * `BotInternals.layerWith(bot, config)` is the library's real bot composition, returning `BotRuntime` and
 * `SubjectRaw` from **one** fresh build, with the base `HttpClient` and the `WebSocketConstructor` left open:
 *
 * 1. dfx's REST client for the token runs the startup checks 1-3 (`Startup.ts`): a valid token, the portal
 *    flags of the declared privileged intents, and membership of the configured guild;
 * 2. the guild state and the REST wrapper (`rest/DiscordApi.ts`) are built over the same client, and dfx's
 *    gateway starts with the `DispatchHook` that feeds the state (`state/Hook.ts`), only after the checks pass. The
 *    gateway is dfx's `DiscordLive` composition with the capabilities codec (`gateway/Codec.ts`, D20, M7), so the
 *    bot identifies with channel obfuscation, and the codec records what Identify sent (`SentIdentify`, which the
 *    build also returns, for the harness's identity check);
 * 3. with a guild configured, the build waits for its GUILD_CREATE (check 4, `guild-not-ready` after 30 s).
 *
 * `SubjectRaw` is the raw `DiscordREST` of that same build, so the matrix's step (c) shares the subject's token,
 * HTTP client and rate-limit store with the library's operations. Every HTTP client in the build is the base
 * client wrapped by the coded-429 interceptor (`rest/Coded429.ts`, G2), so dfx never retries a coded 429, and by
 * the declared-route check (`rest/RouteCheck.ts`), so a request that is not the route its caller declares is a defect.
 * Requests are bounded by `DiscordApiConfig`'s deadline (§4.10). `Layer.fresh` keeps two builds (two bots)
 * from sharing a memoised dfx stack (G1); services that must be shared across identities (the paced base
 * client) come from outside as requirements.
 */
import { DiscordConfig, DiscordRESTMemoryLive } from "dfx"
import { DiscordREST, type DiscordRestService } from "dfx/DiscordREST"
import { DiscordGateway } from "dfx/gateway"
import { type Config, Context, Duration, Effect, Layer, Option } from "effect"
import type * as HttpClient from "effect/http/HttpClient"
import type * as Socket from "effect/socket/Socket"
import { DiscordLiveWithCapabilities, SentIdentify } from "../gateway/Codec.ts"
import * as Dispatches from "../gateway/Dispatches.ts"
import { intentBits, privilegedIntents } from "../gateway/Intents.ts"
import * as Coded429 from "../rest/Coded429.ts"
import * as DiscordApi from "../rest/DiscordApi.ts"
import * as RouteCheck from "../rest/RouteCheck.ts"
import * as GuildState from "../state/GuildState.ts"
import * as Hook from "../state/Hook.ts"
import { type BotConfig, type BotDefinition, BotRuntime, type EventSource } from "./Runtime.ts"
import { restChecks, StartupFailed, type StartupIdentity } from "./Startup.ts"

/** The subject's raw dfx REST client (internal; harness only). */
export class SubjectRaw extends Context.Service<SubjectRaw, DiscordRestService>()("internal/SubjectRaw") {}

/** How long the build waits for the configured guild's GUILD_CREATE (check 4, §4.4). */
export const guildReadyWithin = Duration.seconds(30)

/** The startup checks' result and the state built on the same client, before the gateway starts. */
class Checked extends Context.Service<Checked, { readonly identity: StartupIdentity; readonly state: GuildState.Interface; readonly api: DiscordApi.Interface }>()(
  "internal/Checked"
) {}

const build = (bot: BotDefinition, guildId: BotConfig["guildId"]) => {
  const checked = Layer.effect(
    Checked,
    Effect.gen(function* () {
      const rest = yield* DiscordREST
      const { requestDeadline } = yield* DiscordApi.DiscordApiConfig
      const identity = yield* restChecks(rest, { guildId, privilegedIntents: privilegedIntents(bot.intents), requestDeadline })
      const state = yield* GuildState.make(rest, identity.userId, requestDeadline)
      const api = yield* DiscordApi.make(rest, state)
      return Checked.of({ identity, state, api })
    })
  )
  const state = Layer.effect(GuildState.GuildState, Effect.map(Effect.service(Checked), (value) => value.state))
  const gateway = DiscordLiveWithCapabilities.pipe(Layer.provide(Hook.layer), Layer.provide(state))
  const runtime = Layer.effect(
    BotRuntime,
    Effect.gen(function* () {
      const { identity, state: guildState, api } = yield* Checked
      // the gateway is running once its layer is built; with a guild, wait for its GUILD_CREATE
      yield* DiscordGateway
      const dispatches = yield* Dispatches.Dispatches
      const events: EventSource = { subscribe: dispatches.subscribe }
      if (guildId !== undefined) {
        const ready = yield* guildState.awaitGuild(guildId, guildReadyWithin)
        if (Option.isNone(ready)) {
          return yield* new StartupFailed({ reason: "guild-not-ready", detail: `no GUILD_CREATE for ${guildId} within ${Duration.format(guildReadyWithin)}` })
        }
      }
      return BotRuntime.of({ identity, intents: bot.intents, guildId, guildState, api, events })
    })
  )
  const raw = Layer.effect(SubjectRaw, Effect.map(Effect.service(DiscordREST), (rest) => SubjectRaw.of(rest)))
  // `checked` is built (and its checks pass) before `gateway`, which reuses the same memoised dfx REST client
  const identified = Layer.effect(SentIdentify, Effect.service(SentIdentify))
  // one dispatch stream for the build: the hook (inside the gateway) publishes, the runtime's `events` subscribes
  return Layer.mergeAll(runtime, raw, identified).pipe(Layer.provide(gateway), Layer.provide(checked), Layer.provide(Dispatches.layer), Layer.provide(DiscordRESTMemoryLive))
}

/** The library's bot build with the platform open (see the module comment). */
export const layerWith = (
  bot: BotDefinition,
  config: BotConfig
): Layer.Layer<BotRuntime | SubjectRaw | SentIdentify, StartupFailed | Config.ConfigError, HttpClient.HttpClient | Socket.WebSocketConstructor> =>
  Layer.fresh(
    Layer.unwrap(
      Effect.gen(function* () {
        const token = yield* config.token
        const discordConfig = DiscordConfig.layer({ token, gateway: { intents: intentBits(bot.intents) } })
        return build(bot, config.guildId).pipe(Layer.provide(discordConfig), Layer.provide(Coded429.layer), Layer.provide(RouteCheck.layer))
      })
    )
  )

/** The internal bot API. */
export const BotInternals = { layerWith }
