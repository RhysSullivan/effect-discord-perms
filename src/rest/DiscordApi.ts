/**
 * The library's REST wrapper (DESIGN §4.7-§4.11): one dfx call per operation request, with everything §4.8's
 * steps 3 to 5 add around it. The operations (M6) build a {@link Request} and run it with `execute` after their
 * local checks and preflight; nothing in the library calls dfx's REST methods for an operation any other way.
 *
 * - **Deadline** (§4.10, D9): the call, dfx's 429 retries included, is bounded by `DiscordApiConfig`'s
 *   `requestDeadline` (30 s by default); past it the request fails with `RequestTimedOut`, whose `NoResponse`
 *   cause says `deadline`. The outcome is unknown: Discord may have applied it, so the library never retries.
 * - **Failures** (§4.9): `ErrorMap.classify` copies dfx's failure (a transport error is `NetworkError`, a 5xx or a
 *   non-JSON body `DiscordUnavailable`), and `ErrorMap.mapResponse` maps Discord's answer for this request. 50013,
 *   50001, 160002, 160005 and 50083 go through the recompute (`permissions/Recompute.ts`). An answer the request
 *   does not declare is a defect, `UnmappedDiscordError` with the whole answer.
 * - **Decoding** (§4.11, D12): a 2xx body is decoded with the request's schema (`Schemas.ts`), which brands its
 *   IDs; a body that does not decode is a defect naming the route template.
 * - **Span** (§4.13, D28): `discord.rest`, with the route template, method, operation and guild (and channel)
 *   as attributes, never a URL or a token. Nothing inside it recovers: an error the caller catches still marks
 *   the span (and the operation's span around it) failed.
 */
import type { DiscordRESTError, DiscordRestService } from "dfx/DiscordREST"
import { Context, Duration, Effect, Schema } from "effect"
import type { DiscordResponse, HttpMethod } from "../errors/Cause.ts"
import type { Transient } from "../errors/Transient.ts"
import * as Recompute from "../permissions/Recompute.ts"
import type * as GuildState from "../state/GuildState.ts"
import { type CodeError, type LimitFacts, mapResponse, UnmappedDiscordError, undeclarableFields } from "./ErrorMap.ts"
import { send } from "./Request.ts"

/** The wrapper's settings. */
export interface Config {
  /** Bounds every call, dfx's 429 retries included (§4.10). */
  readonly requestDeadline: Duration.Duration
}

/** The wrapper's settings, read when a bot is built; the default deadline is 30 s (§4.10). */
export const DiscordApiConfig = Context.Reference<Config>("rest/DiscordApiConfig", { defaultValue: () => ({ requestDeadline: Duration.seconds(30) }) })

/** A route, as spans and causes name it: the method and the template (never the URL, which may carry tokens). */
export interface Route {
  readonly method: HttpMethod
  /** For example `/channels/{channel.id}/messages`. */
  readonly template: string
}

/** One operation request. */
export interface Request<A> {
  /** The request as the error map and the recompute see it (its operation-table row, scope and arguments). */
  readonly target: Recompute.Target
  readonly route: Route
  /** The dfx call, through the bot's own client. */
  readonly call: (rest: DiscordRestService) => Effect.Effect<unknown, DiscordRESTError>
  /** Decodes and brands the 2xx body (`Schema.Void` for a request answered with no body). */
  readonly response: Schema.Decoder<A>
  /** The payload- and argument-derived tags the request declares (§2.3-§2.6). */
  readonly limits: LimitFacts
}

/**
 * Every error `execute` can fail with. The operations narrow it to their declared unions through their
 * overloads (§4.7); every tag here is declared by the request it came from (see `ErrorMap`).
 */
export type ApiError = CodeError | Recompute.Attributed | Transient

/** The wrapper. */
export interface Interface {
  /** Runs `request` (see the module comment). */
  readonly execute: <A>(request: Request<A>) => Effect.Effect<A, ApiError>
  /**
   * A read that is not an operation-table row (a handle's lookup: `Channels.get`, `Members.get`), bounded by the
   * deadline and decoded like `execute`'s. `refusal` maps the Discord answers the caller expects (an unknown or
   * hidden object) to its errors; any other answer is an `UnmappedDiscordError` defect.
   */
  readonly read: <A, E>(read: Read<A, E>) => Effect.Effect<A, E | Transient>
  /**
   * Runs a request outside any guild (a DM, M7): bounded, mapped and decoded like `execute`'s, with no recompute:
   * a DM has no guild permissions to refresh, so a permission-like refusal fails with the code's own tag (for
   * 50013, `PermissionDeniedUnattributed`), never a guess.
   */
  readonly executeDirect: <A>(request: DirectRequest<A>) => Effect.Effect<A, ApiError>
}

/** One request outside any guild (a DM's send, edit or delete). */
export interface DirectRequest<A> {
  /** The operation-table row whose tags the answer is mapped against. */
  readonly op: Recompute.Target["op"]
  readonly args: Recompute.Target["args"]
  readonly channelId: string
  readonly route: Route
  readonly call: (rest: DiscordRestService) => Effect.Effect<unknown, DiscordRESTError>
  readonly response: Schema.Decoder<A>
  readonly limits: LimitFacts
}

/** One lookup read. */
export interface Read<A, E> {
  readonly route: Route
  readonly call: (rest: DiscordRestService) => Effect.Effect<unknown, DiscordRESTError>
  readonly response: Schema.Decoder<A>
  /** The error an expected refusal means, or `undefined` for one the caller does not expect. */
  readonly refusal: (response: DiscordResponse) => E | undefined
}

/** The REST wrapper of one bot build. */
export class DiscordApi extends Context.Service<DiscordApi, Interface>()("rest/DiscordApi") {}

/**
 * Builds the wrapper over `rest` (the bot's dfx client) and `guildState` (which the recompute refreshes), with
 * `DiscordApiConfig`'s settings.
 */
export const make = (rest: DiscordRestService, guildState: GuildState.Interface): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const config = yield* DiscordApiConfig
    const recompute: Recompute.Context = { rest, guildState, deadline: config.requestDeadline }

    const execute = <A>(request: Request<A>): Effect.Effect<A, ApiError> =>
      Effect.gen(function* () {
        const { target, route, limits } = request
        const extra = undeclarableFields(target.op, limits)
        if (extra.length > 0) return yield* Effect.die(new Error(`DiscordApi: ${target.op} cannot declare ${extra.join(", ")}`))
        const answer = yield* send(route.template, route.method, request.call(rest), config.requestDeadline)
        if (answer._tag === "Ok") {
          return yield* Schema.decodeUnknownEffect(request.response)(answer.body).pipe(
            Effect.mapError((error) => new Error(`${route.method} ${route.template}: a 2xx body did not decode: ${error.message}`)),
            Effect.orDie
          )
        }
        const mapped = mapResponse({ op: target.op, args: target.args, limits }, answer.response, answer.retryAfterMs)
        switch (mapped._tag) {
          case "Unmapped":
            return yield* Effect.die(new UnmappedDiscordError({ operation: target.op, reason: mapped.reason, response: answer.response }))
          case "Fail":
            return yield* Effect.fail(mapped.error)
          case "Recompute":
            return yield* Effect.fail(yield* Recompute.attribute(recompute, target, answer.response, mapped.fallback))
        }
      }).pipe(
        Effect.withSpan("discord.rest", {
          attributes: {
            "discord.route": request.route.template,
            "discord.method": request.route.method,
            "discord.operation": request.target.op,
            "discord.guild_id": request.target.guildId,
            ...(request.target.scope._tag === "Channel" ? { "discord.channel_id": request.target.scope.channelId } : {})
          }
        })
      )

    const read = <A, E>(lookup: Read<A, E>): Effect.Effect<A, E | Transient> =>
      Effect.gen(function* () {
        const { route } = lookup
        const answer = yield* send(route.template, route.method, lookup.call(rest), config.requestDeadline)
        if (answer._tag === "Ok") {
          return yield* Schema.decodeUnknownEffect(lookup.response)(answer.body).pipe(
            Effect.mapError((error) => new Error(`${route.method} ${route.template}: a 2xx body did not decode: ${error.message}`)),
            Effect.orDie
          )
        }
        const refused = lookup.refusal(answer.response)
        if (refused === undefined) return yield* Effect.die(new UnmappedDiscordError({ operation: `read ${route.template}`, reason: "an answer the lookup does not expect", response: answer.response }))
        return yield* Effect.fail(refused)
      }).pipe(Effect.withSpan("discord.rest", { attributes: { "discord.route": lookup.route.template, "discord.method": lookup.route.method } }))

    const executeDirect = <A>(request: DirectRequest<A>): Effect.Effect<A, ApiError> =>
      Effect.gen(function* () {
        const { route, limits } = request
        const extra = undeclarableFields(request.op, limits)
        if (extra.length > 0) return yield* Effect.die(new Error(`DiscordApi: ${request.op} cannot declare ${extra.join(", ")}`))
        const answer = yield* send(route.template, route.method, request.call(rest), config.requestDeadline)
        if (answer._tag === "Ok") {
          return yield* Schema.decodeUnknownEffect(request.response)(answer.body).pipe(
            Effect.mapError((error) => new Error(`${route.method} ${route.template}: a 2xx body did not decode: ${error.message}`)),
            Effect.orDie
          )
        }
        const mapped = mapResponse({ op: request.op, args: request.args, limits }, answer.response, answer.retryAfterMs)
        switch (mapped._tag) {
          case "Unmapped":
            return yield* Effect.die(new UnmappedDiscordError({ operation: request.op, reason: mapped.reason, response: answer.response }))
          case "Fail":
            return yield* Effect.fail(mapped.error)
          case "Recompute":
            return yield* Effect.fail(mapped.fallback)
        }
      }).pipe(
        Effect.withSpan("discord.rest", {
          attributes: { "discord.route": request.route.template, "discord.method": request.route.method, "discord.operation": request.op, "discord.channel_id": request.channelId }
        })
      )

    return DiscordApi.of({ execute, read, executeDirect })
  })
