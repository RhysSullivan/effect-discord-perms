import { describe, expect, it } from "@effect/vitest"
import { DiscordREST } from "dfx/DiscordREST"
import { Cause, Duration, Effect, Exit, Fiber, Option, Tracer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { DiscordResponse, NoResponse } from "../../src/errors/Cause.ts"
import type * as Recompute from "../../src/permissions/Recompute.ts"
import * as Coded429 from "../../src/rest/Coded429.ts"
import * as DiscordApi from "../../src/rest/DiscordApi.ts"
import { type LimitFacts, UnmappedDiscordError } from "../../src/rest/ErrorMap.ts"
import * as Schemas from "../../src/rest/Schemas.ts"
import { MessageId } from "../../src/Snowflake.ts"
import { json, type Scripted, scriptedRestEffect } from "../support/fakeDiscord.ts"
import { everyone, guildId, now, otherId, role, set, textId, channel } from "../support/guild.ts"
import { snapshotOf, stubGuildState } from "../support/guildStateStub.ts"

/**
 * The REST wrapper (DESIGN §4.8-§4.13) over the real dfx client and the coded-429 interceptor, with a scripted
 * base client: coded 429s surface and uncoded ones are retried by dfx; the deadline gives `RequestTimedOut` with a
 * `NoResponse` cause under `TestClock`; transport failures, 5xx answers, unmapped codes and 2xx bodies that do not
 * decode; and the span, which a caller's recovery does not turn into a success.
 */
const state = snapshotOf({ roles: [role(everyone, set("ViewChannel", "SendMessages"), 0)], channels: [channel("text")], botRoles: [] })
const send: Recompute.Target = { op: "channel.send", guildId, scope: { _tag: "Channel", channelId: textId }, granted: [], args: { payload: [] }, completion: { _tag: "Static" } }
const route = { method: "POST", template: "/channels/{channel.id}/messages" } as const
const message = { id: "500000000000000001", channel_id: textId, type: 0, author: { id: otherId, bot: true }, content: "hi", tts: false, mention_everyone: false, mention_roles: [], embeds: [], attachments: [], pinned: false }

/** Runs a send request through `DiscordApi` over a base client answering each request with `script`, and counts the requests. */
const execute = (script: (attempt: number) => Effect.Effect<Scripted>, options: { readonly limits?: LimitFacts } = {}) =>
  Effect.gen(function* () {
    let attempts = 0
    const stub = yield* stubGuildState(state, state)
    const rest = scriptedRestEffect(() => script(++attempts), Coded429.surface)
    const exit = yield* Effect.gen(function* () {
      const api = yield* DiscordApi.make(yield* DiscordREST, stub.state)
      return yield* api.execute({ target: send, route, call: (client) => client.createMessage(textId, { content: "hi" }), response: Schemas.Message, limits: options.limits ?? {} })
    }).pipe(Effect.provide(rest), Effect.exit)
    return { exit, attempts: () => attempts }
  })

const failureOf = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>): E | undefined => (Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined)
const defectOf = <A, E>(exit: Exit.Exit<A, E>): unknown => (Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? Cause.squash(exit.cause) : undefined)

describe("a successful request", () => {
  it.effect("decodes and brands the body with the request's schema", () =>
    Effect.gen(function* () {
      const { exit } = yield* execute(() => Effect.succeed(json(200, message)))
      expect(Exit.isSuccess(exit) ? exit.value.id : undefined).toBe(MessageId.make("500000000000000001"))
    })
  )

  it.effect("is a defect naming the route template when a 2xx body does not decode", () =>
    Effect.gen(function* () {
      const { exit } = yield* execute(() => Effect.succeed(json(200, { id: "not-a-snowflake" })))
      const defect = defectOf(exit)
      expect(defect).toBeInstanceOf(Error)
      expect(defect instanceof Error ? defect.message : "").toContain("POST /channels/{channel.id}/messages: a 2xx body did not decode")
    })
  )
})

describe("429s (§4.10, G2)", () => {
  it.effect("a coded 429 surfaces at once as RateLimited, with its retry_after, and is not retried", () =>
    Effect.gen(function* () {
      const { exit, attempts } = yield* execute(() => Effect.succeed(json(429, { message: "Channel write limit", code: 20028, retry_after: 1.5, global: false }, { "retry-after": "2" })))
      const error = failureOf(exit)
      expect(error?._tag).toBe("RateLimited")
      expect(error?._tag === "RateLimited" ? [error.retryAfterMs, error.cause.status, error.cause.code] : undefined).toEqual([1500, 429, 20028])
      expect(attempts()).toBe(1)
    })
  )

  it.effect("an uncoded 429 (or code 0) passes to dfx, which waits and retries it", () =>
    Effect.gen(function* () {
      for (const body of [{ message: "You are being rate limited.", retry_after: 0.05, global: false }, { message: "You are being rate limited.", code: 0, retry_after: 0.05, global: false }]) {
        const run = yield* execute((attempt) => Effect.succeed(attempt === 1 ? json(429, body, { "retry-after": "0.05" }) : json(200, message))).pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        const { exit, attempts } = yield* Fiber.join(run)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(attempts()).toBe(2)
      }
    })
  )

  it.effect("a coded 20016 is a defect while slowmode does not apply to bots (Observed, H-053)", () =>
    Effect.gen(function* () {
      const { exit, attempts } = yield* execute(() => Effect.succeed(json(429, { message: "Slowmode", code: 20016, retry_after: 4, global: false })))
      expect(defectOf(exit)).toBeInstanceOf(UnmappedDiscordError)
      expect(attempts()).toBe(1)
    })
  )
})

describe("no answer, and answers that are not Discord's (§4.9, §4.10)", () => {
  it.effect("the deadline gives RequestTimedOut with a NoResponse cause (deadline, after the deadline's ms)", () =>
    Effect.gen(function* () {
      const run = yield* execute(() => Effect.never).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(29))
      expect(run.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(Duration.seconds(1))
      const { exit } = yield* Fiber.join(run)
      const error = failureOf(exit)
      expect(error?._tag).toBe("RequestTimedOut")
      expect(error?._tag === "RequestTimedOut" ? error.cause : undefined).toEqual(new NoResponse({ route: route.template, method: "POST", reason: "deadline", afterMs: 30_000 }))
    })
  )

  it.effect("the deadline comes from DiscordApiConfig", () =>
    Effect.gen(function* () {
      const run = yield* execute(() => Effect.never).pipe(Effect.provideService(DiscordApi.DiscordApiConfig, { requestDeadline: Duration.seconds(5) }), Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(5))
      const { exit } = yield* Fiber.join(run)
      expect(failureOf(exit)?._tag).toBe("RequestTimedOut")
    })
  )

  it.effect("a transport failure is NetworkError, a 5xx DiscordUnavailable", () =>
    Effect.gen(function* () {
      const transport = yield* execute(() => Effect.succeed({ _tag: "Transport" }))
      expect(failureOf(transport.exit)?._tag).toBe("NetworkError")
      const server = yield* execute(() => Effect.succeed(json(502, { message: "Bad Gateway" })))
      const error = failureOf(server.exit)
      expect(error?._tag === "DiscordUnavailable" ? error.cause.status : undefined).toBe(502)
    })
  )

  it.effect("an unmapped code is a defect carrying the whole answer", () =>
    Effect.gen(function* () {
      const { exit } = yield* execute(() => Effect.succeed(json(404, { message: "Unknown Message", code: 10008 })))
      const defect = defectOf(exit)
      expect(defect).toBeInstanceOf(UnmappedDiscordError)
      expect(defect instanceof UnmappedDiscordError ? [defect.operation, defect.response] : undefined).toEqual([
        "channel.send",
        new DiscordResponse({ status: 404, code: 10008, message: "Unknown Message", method: "POST", route: route.template, fieldErrors: [], attributedBy: "code" })
      ])
    })
  )

  it.effect("a request declaring a limit its operation cannot have is a defect, before anything is sent", () =>
    Effect.gen(function* () {
      const { exit, attempts } = yield* execute(() => Effect.succeed(json(200, message)), { limits: { nick: { length: 1, limit: 32 } } })
      expect(defectOf(exit)).toBeInstanceOf(Error)
      expect(attempts()).toBe(0)
    })
  )
})

describe("the span (§4.13, D28)", () => {
  it.effect("is failed, with the route template as an attribute, even when the caller catches the error", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        }
      })
      const stub = yield* stubGuildState(state, state)
      const result = yield* Effect.gen(function* () {
        const api = yield* DiscordApi.make(yield* DiscordREST, stub.state)
        // the operation's own span (M6's `Effect.fn("discord.channel.send")`) around the request, recovery outside both
        return yield* api.execute({ target: send, route, call: (client) => client.createMessage(textId, { content: "hi" }), response: Schemas.Message, limits: {} }).pipe(
          Effect.withSpan("discord.channel.send"),
          Effect.catchTag("PermissionDeniedUnattributed", () => Effect.succeed("caught"))
        )
      }).pipe(
        Effect.provide(scriptedRestEffect(() => Effect.succeed(json(403, { message: "Missing Permissions", code: 50013 })), Coded429.surface)),
        Effect.provideService(Tracer.Tracer, tracer)
      )
      expect(result).toBe("caught")
      const byName = (name: string) => spans.find((span) => span.name === name)
      for (const name of ["discord.rest", "discord.channel.send"]) {
        const span = byName(name)
        expect({ name, status: span?.status._tag, failed: span?.status._tag === "Ended" && Exit.isFailure(span.status.exit) }).toEqual({ name, status: "Ended", failed: true })
      }
      const attributes = Object.fromEntries(byName("discord.rest")?.attributes ?? [])
      expect(attributes).toEqual({
        "discord.route": "/channels/{channel.id}/messages",
        "discord.method": "POST",
        "discord.operation": "channel.send",
        "discord.guild_id": guildId,
        "discord.channel_id": textId
      })
      // no token reaches any span (Effect's HTTP client span below ours records the URL, which for bot routes holds
      // only IDs, and redacts the Authorization header); the library's spans carry the template, never a URL
      expect(spans.map((span) => span.name)).toEqual(["discord.channel.send", "discord.rest", "POST"])
      for (const span of spans) for (const value of span.attributes.values()) expect(String(value)).not.toContain("fake-token")
      for (const span of spans.filter((candidate) => candidate.name.startsWith("discord."))) for (const value of span.attributes.values()) expect(String(value)).not.toMatch(/https?:/)
    })
  )
})
