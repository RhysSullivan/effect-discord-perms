/**
 * The live harness's identities (DESIGN §4.2, §5.6; G1, D13).
 *
 * - **One shared base `HttpClient`**, outside every `Layer.fresh`: it runs the Perms Lab guard on every request
 *   (`Lab.ts`), takes a slot of the global bucket and counts the request (`Pacing.ts`), and counts 401, 403
 *   and 429 responses. Because it is outside every fresh boundary, there is exactly one bucket and one set of
 *   counters for all identities (a shared service provided inside a fresh layer would be rebuilt per identity).
 * - **Each identity's dfx stack is wrapped in `Layer.fresh`.** Without it Effect memoises `DiscordRESTLive` by
 *   reference and every identity would send the first token (G1: `auth=["Bot HARNESS","Bot HARNESS"]`). Each
 *   fresh stack leaves its `HttpClient` and `Credentials` requirements open, so both are the shared ones.
 * - `HarnessRest` and `TargetRest` are REST-only. `SubjectRaw` is REST-only too in M2; M3 builds it from the
 *   library's `BotInternals.layerWith`, in the same build as `BotRuntime` (§4.2).
 *
 * `compose` is the single wiring. `live` passes it the Bun HTTP client and `Credentials.layer` (which takes the
 * live lock and reads `.env`); the identity test passes a recording fake client and fake credentials, and
 * nothing else differs.
 */
import { BunHttpClient } from "@effect/platform-bun"
import { DiscordConfig, DiscordRESTMemoryLive } from "dfx"
import { DiscordREST, type DiscordRestService } from "dfx/DiscordREST"
import { Context, Effect, Layer } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import { SubjectRaw } from "../src/bot/Internals.ts"
import { Credentials, type IdentityCredentials, type LabCredentials, layer as credentialsLayer } from "../src/config/Credentials.ts"
import * as Lab from "./Lab.ts"
import * as PacingModule from "./Pacing.ts"

/** The harness bot's raw dfx REST client (Administrator, top role). Every write goes through the Lab guard. */
export class HarnessRest extends Context.Service<HarnessRest, DiscordRestService>()("harness/HarnessRest") {}

/** The target bot's raw dfx REST client. */
export class TargetRest extends Context.Service<TargetRest, DiscordRestService>()("harness/TargetRest") {}

/**
 * The base client every identity's dfx sees: guarded, paced and counted. It requires the real base client,
 * the pacing service and the guard, all from outside every identity's fresh boundary.
 */
export const SharedHttpClient: Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient | PacingModule.Pacing | Lab.LabGuard> = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const base = yield* HttpClient.HttpClient
    const pacing = yield* PacingModule.Pacing
    const guard = yield* Lab.LabGuard
    return base.pipe(
      HttpClient.tapRequest((request) => Effect.andThen(guard.check(request), pacing.take(request.method, request.url))),
      HttpClient.transformResponse(Effect.tap((response) => pacing.recordStatus(response.status)))
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

/** The three REST identities, each in its own fresh stack. */
export const identities: Layer.Layer<HarnessRest | TargetRest | SubjectRaw, never, HttpClient.HttpClient | Credentials> = Layer.mergeAll(
  as(HarnessRest, restIdentity((credentials) => credentials.harness)),
  as(TargetRest, restIdentity((credentials) => credentials.target)),
  as(SubjectRaw, restIdentity((credentials) => credentials.subject))
)

/** Everything the harness's commands use. */
export type Services = HarnessRest | TargetRest | SubjectRaw | PacingModule.Pacing | Lab.LabGuard | Credentials

/**
 * The single harness wiring: the identities over the shared client, with pacing and the guard exposed so the
 * commands can read the counters and arm the guard. `base` is the real HTTP client; `credentials` provides
 * the tokens and the lab guild.
 */
export const compose = <E1, E2>(
  base: Layer.Layer<HttpClient.HttpClient, E1>,
  credentials: Layer.Layer<Credentials, E2>,
  pacing: PacingModule.Options
): Layer.Layer<Services, E1 | E2> => {
  const guard = Layer.unwrap(Effect.map(Effect.service(Credentials), (lab) => Lab.layer(lab.guildId)))
  const shared = SharedHttpClient.pipe(Layer.provideMerge(Layer.mergeAll(PacingModule.layer(pacing), guard)), Layer.provide(base))
  return identities.pipe(Layer.provideMerge(shared), Layer.provideMerge(credentials))
}

/** The live wiring: Bun's HTTP client and the real credentials (which take the live lock). */
export const live = (pacing: PacingModule.Options) => compose(BunHttpClient.layer, credentialsLayer, pacing)
