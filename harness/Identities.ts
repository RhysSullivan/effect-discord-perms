/**
 * The live harness's identities (DESIGN §4.2, §5.6; G1, D13).
 *
 * - **One shared base `HttpClient`**, outside every `Layer.fresh`: it runs the Perms Lab guard on every request
 *   (`Lab.ts`), takes a slot of the global bucket and counts the request (`Pacing.ts`), and counts 401, 403
 *   and 429 responses. It records the methods a lab step sends (`Lab.CurrentLabStep`), so the step is retried
 *   after a 5xx only when they are repeatable, and counts each retry. Because it is outside every fresh boundary, there is exactly one bucket and one set of
 *   counters for all identities (a shared service provided inside a fresh layer would be rebuilt per identity).
 * - **Each identity's dfx stack is wrapped in `Layer.fresh`.** Without it Effect memoises `DiscordRESTLive` by
 *   reference and every identity would send the first token (G1: `auth=["Bot HARNESS","Bot HARNESS"]`). Each
 *   fresh stack leaves its `HttpClient` and `Credentials` requirements open, so both are the shared ones.
 * - `HarnessRest` and `TargetRest` are REST-only. The subject is the library's real bot build
 *   (`BotInternals.layerWith`, §4.2): `BotRuntime` with its gateway and guild state, and `SubjectRaw`, the raw
 *   dfx client of the same build, for the matrix's step (c). Its declared intents are `subjectBot`'s.
 *
 * `compose` is the single wiring. `live` passes it the Bun HTTP client, Bun's WebSocket and `Credentials.layer`
 * (which takes the live lock and reads `.env`); the identity tests pass a recording fake client, a fake gateway
 * and fake credentials, and nothing else differs.
 */
import { BunHttpClient, BunSocket } from "@effect/platform-bun"
import { DiscordConfig, DiscordRESTMemoryLive } from "dfx"
import { DiscordREST, type DiscordRestService } from "dfx/DiscordREST"
import { Clock, Config, Context, Duration, Effect, Layer, Option, Ref, type Scope } from "effect"
import * as Headers from "effect/http/Headers"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Socket from "effect/socket/Socket"
import { Bot, BotRuntime } from "../src/bot/Bot.ts"
import { BotInternals, type SubjectRaw } from "../src/bot/Internals.ts"
import { type Identified, SentIdentify } from "../src/gateway/Codec.ts"
import type { Intent } from "../src/gateway/Intents.ts"
import { DispatchTap } from "../src/state/Hook.ts"
import type { StartupFailed } from "../src/bot/Startup.ts"
import { Credentials, type IdentityCredentials, type LabCredentials, layer as credentialsLayer } from "../src/config/Credentials.ts"
import { cannedRoute, Capture, DryRun } from "./DryRun.ts"
import * as Lab from "./Lab.ts"
import * as PacingModule from "./Pacing.ts"

/** The harness bot's raw dfx REST client (Administrator, top role). Every write goes through the Lab guard. */
export class HarnessRest extends Context.Service<HarnessRest, DiscordRestService>()("harness/HarnessRest") {}

/** The target bot's raw dfx REST client. */
export class TargetRest extends Context.Service<TargetRest, DiscordRestService>()("harness/TargetRest") {}

/**
 * The base client every identity's dfx sees: guarded, paced and counted. It requires the real base client,
 * the pacing service and the guard, all from outside every identity's fresh boundary. Under a dry run
 * (`DryRun.ts`) a request passes the guard (`checkDry`: as the live request would, with no kick or ban permit used)
 * and is answered with its canned body instead of being sent; under a capture a request that passes the guard is
 * recorded, then sent.
 */
export const SharedHttpClient: Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient | PacingModule.Pacing | Lab.LabGuard> = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const base = yield* HttpClient.HttpClient
    const pacing = yield* PacingModule.Pacing
    const guard = yield* Lab.LabGuard
    const sent = base.pipe(
      HttpClient.tapRequest((request) => pacing.take(request.method, request.url)),
      HttpClient.transformResponse(
        Effect.tap((response) => {
          const header = (name: string) => Option.getOrUndefined(Headers.get(response.headers, name))
          return pacing.recordStatus(response.status, response.request.method, response.request.url, {
            retryAfter: header("retry-after"),
            scope: header("x-ratelimit-scope"),
            bucket: header("x-ratelimit-bucket")
          })
        })
      )
    )
    return HttpClient.make((request) =>
      Effect.gen(function* () {
        const dry = yield* DryRun
        if (Option.isNone(dry)) {
          yield* guard.check(request)
          // a lab step's requests are recorded, so it is sent again after a 5xx only when they are repeatable
          const step = yield* Lab.CurrentLabStep
          if (Option.isSome(step) && (yield* step.value.record(request.method))) yield* pacing.recordRetry(step.value.step)
          const capture = yield* Capture
          if (Option.isSome(capture)) yield* capture.value.record(request)
          return yield* sent.execute(request)
        }
        // nothing is sent: the guard judges the request as it would the live one, with no kick or ban permit used
        yield* guard.checkDry(request)
        const route = cannedRoute(request.method, request.url)
        const body = dry.value.canned(route)
        if (Option.isNone(body)) return yield* Effect.die(new Error(`dry run: no canned body for ${route}`))
        yield* dry.value.record(request)
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body.value), { status: 200, headers: { "content-type": "application/json" } }))
      })
    )
  })
)

/** A fresh dfx REST stack for one identity, with its token from the shared `Credentials`. */
const restIdentity = (pick: (credentials: LabCredentials) => IdentityCredentials): Layer.Layer<DiscordREST, never, HttpClient.HttpClient | Credentials> =>
  Layer.fresh(
    DiscordRESTMemoryLive.pipe(
      Layer.provide(Layer.unwrap(Effect.map(Effect.service(Credentials), (credentials) => DiscordConfig.layer({ token: pick(credentials).token }))))
    )
  )

const as = <I>(tag: Context.Service<I, DiscordRestService>, identity: Layer.Layer<DiscordREST, never, HttpClient.HttpClient | Credentials>) =>
  Layer.effect(tag, Effect.map(Effect.service(DiscordREST), (rest) => tag.of(rest))).pipe(Layer.provide(identity))

/**
 * The subject bot's declaration: Guilds for the guild state's events, and GuildMembers (a privileged intent the
 * subject's application has) so member events about the target reach it too.
 */
export const subjectBot = Bot.make({ intents: ["Guilds", "GuildMembers"] })

/** The subject: the library's bot build for the subject token in the lab guild (its own fresh build). */
export const subject: Layer.Layer<BotRuntime | SubjectRaw | SentIdentify, StartupFailed | Config.ConfigError, HttpClient.HttpClient | Socket.WebSocketConstructor | Credentials> = Layer.unwrap(
  Effect.map(Effect.service(Credentials), (credentials) =>
    BotInternals.layerWith(subjectBot, { token: Config.succeed(credentials.subject.token), guildId: credentials.guildId })
  )
)

/** The harness's and the target's REST identities, each in its own fresh stack. */
export const restIdentities: Layer.Layer<HarnessRest | TargetRest, never, HttpClient.HttpClient | Credentials> = Layer.mergeAll(
  as(HarnessRest, restIdentity((credentials) => credentials.harness)),
  as(TargetRest, restIdentity((credentials) => credentials.target))
)

/** One extra subject session (the intent sessions, M7): its runtime, and what its codec sent. */
export interface Session {
  readonly runtime: BotRuntime["Service"]
  readonly identified: Effect.Effect<ReadonlyArray<Identified>>
}

/**
 * Opens extra gateway sessions of the subject (DESIGN §5.10 "Intent sessions", M7): each is the library's real bot
 * build for the subject's token (its own fresh dfx stack, the capabilities codec, startup checks 1-3), over the
 * shared base client (guarded, paced, counted) and the run's WebSocket, identified with exactly the given intents.
 * The lab guild is configured (membership checked, GUILD_CREATE awaited) only when the intents include Guilds, the
 * one intent that delivers it. `tap` sees every dispatch from the first. The session closes with the caller's scope.
 * Opens are spaced at least {@link identifySpacing} apart, Discord's one Identify per 5 s per bot (max_concurrency 1).
 */
export class Sessions extends Context.Service<
  Sessions,
  { readonly open: (intents: ReadonlyArray<Intent>, tap: (event: string, data: unknown) => Effect.Effect<void>) => Effect.Effect<Session, StartupFailed | Config.ConfigError, Scope.Scope> }
>()("harness/Sessions") {}

/** The least time between two session opens (Identify is limited to one per 5 s per bot). */
export const identifySpacing = Duration.seconds(6)

const sessionsLayer: Layer.Layer<Sessions, never, HttpClient.HttpClient | Socket.WebSocketConstructor | Credentials> = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const socket = yield* Socket.WebSocketConstructor
    const credentials = yield* Credentials
    const lastOpened = yield* Ref.make<number | undefined>(undefined)
    const open = (intents: ReadonlyArray<Intent>, tap: (event: string, data: unknown) => Effect.Effect<void>) =>
      Effect.gen(function* () {
        const last = yield* Ref.get(lastOpened)
        const now = yield* Clock.currentTimeMillis
        const wait = last === undefined ? 0 : last + Duration.toMillis(identifySpacing) - now
        if (wait > 0) yield* Effect.sleep(Duration.millis(wait))
        yield* Ref.set(lastOpened, yield* Clock.currentTimeMillis)
        const build = BotInternals.layerWith(
          { intents },
          { token: Config.succeed(credentials.subject.token), ...(intents.includes("Guilds") ? { guildId: credentials.guildId } : {}) }
        ).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), Layer.succeed(Socket.WebSocketConstructor, socket), Layer.succeed(DispatchTap, tap))))
        const context = yield* Layer.build(build)
        const sent = Context.get(context, SentIdentify)
        return { runtime: Context.get(context, BotRuntime), identified: sent.identified }
      })
    return Sessions.of({ open })
  })
)

/** Everything the harness's commands use. */
export type Services = HarnessRest | TargetRest | SubjectRaw | BotRuntime | SentIdentify | Sessions | PacingModule.Pacing | Lab.LabGuard | Credentials

/**
 * The single harness wiring: the identities over the shared client, with pacing and the guard exposed so the
 * commands can read the counters and arm the guard. `base` is the real HTTP client, `socket` the WebSocket the
 * subject's gateway uses; `credentials` provides the tokens and the lab guild. Building it runs the subject's
 * startup checks and waits for its GUILD_CREATE (§4.4).
 */
export const compose = <E1, E2>(
  base: Layer.Layer<HttpClient.HttpClient, E1>,
  socket: Layer.Layer<Socket.WebSocketConstructor>,
  credentials: Layer.Layer<Credentials, E2>,
  pacing: PacingModule.Options
): Layer.Layer<Services, E1 | E2 | StartupFailed | Config.ConfigError> => {
  const guard = Layer.unwrap(Effect.map(Effect.service(Credentials), (lab) => Lab.layer(lab.guildId)))
  const shared = SharedHttpClient.pipe(Layer.provideMerge(Layer.mergeAll(PacingModule.layer(pacing), guard)), Layer.provide(base))
  return Layer.mergeAll(restIdentities, subject, sessionsLayer).pipe(Layer.provide(socket), Layer.provideMerge(shared), Layer.provideMerge(credentials))
}

/** The live wiring: Bun's HTTP client and WebSocket, and the real credentials (which take the live lock). */
export const live = (pacing: PacingModule.Options) => compose(BunHttpClient.layer, BunSocket.layerWebSocketConstructor, credentialsLayer, pacing)
