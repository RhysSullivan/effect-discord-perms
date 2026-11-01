import { describe, expect, it } from "@effect/vitest"
import { ApplicationFlags } from "discord-api-types/v10"
import { DiscordREST } from "dfx/DiscordREST"
import { Duration, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { missingPrivilegedIntents, restChecks, StartupFailed } from "../../src/bot/Startup.ts"
import { DiscordResponse, NoResponse } from "../../src/errors/Cause.ts"
import { classify, flattenFieldErrors } from "../../src/rest/ErrorMap.ts"
import { GuildId, UserId } from "../../src/Snowflake.ts"
import { json, type Scripted, scriptedRest } from "../support/fakeDiscord.ts"

/**
 * The REST startup checks (DESIGN §4.4, D19) and the dfx failure shapes they rest on (§4.9, dfx.md §3), over
 * the real dfx client with a scripted fake base client.
 */
const guildId = GuildId.make("100000000000000000")
const userId = "200000000000000001"
const user = json(200, { id: userId, username: "Perms Subject" })
const app = (flags: number) => json(200, { id: "100000000000000002", flags })
const member = json(200, { roles: ["400000000000000001"] })
const allFlags = ApplicationFlags.GatewayGuildMembers | ApplicationFlags.GatewayMessageContentLimited

const script =
  (answers: { readonly user?: Scripted; readonly app?: Scripted; readonly member?: Scripted }) =>
  (_method: string, path: string): Scripted =>
    path === "/users/@me" ? (answers.user ?? user) : path === "/applications/@me" ? (answers.app ?? app(allFlags)) : (answers.member ?? member)

const check = (answers: Parameters<typeof script>[0]) =>
  Effect.gen(function* () {
    const rest = yield* DiscordREST
    return yield* restChecks(rest, { guildId, privilegedIntents: ["GuildMembers", "MessageContent"], requestDeadline: Duration.seconds(30) })
  }).pipe(Effect.provide(scriptedRest(script(answers))))

const reasonOf = <A>(exit: Exit.Exit<A, StartupFailed>) => (Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error.reason : undefined)

describe("startup checks", () => {
  it.effect("succeed with the identity, application flags and guild roles", () =>
    Effect.gen(function* () {
      const identity = yield* check({})
      expect(identity).toEqual({
        userId: UserId.make(userId),
        username: "Perms Subject",
        applicationId: "100000000000000002",
        applicationFlags: allFlags,
        guildRoles: ["400000000000000001"]
      })
    })
  )

  it.effect("fail with invalid-token on a 401", () =>
    Effect.gen(function* () {
      expect(reasonOf(yield* Effect.exit(check({ user: json(401, { message: "401: Unauthorized", code: 0 }) })))).toBe("invalid-token")
    })
  )

  it.effect("fail with privileged-intent-not-enabled when a declared intent's flag is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(check({ app: app(ApplicationFlags.GatewayGuildMembers) }))
      expect(reasonOf(exit)).toBe("privileged-intent-not-enabled")
      expect(missingPrivilegedIntents(ApplicationFlags.GatewayGuildMembersLimited, ["GuildMembers", "MessageContent", "GuildPresences"])).toEqual(["MessageContent", "GuildPresences"])
    })
  )

  it.effect("fail with not-in-guild on a 404 member read", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(check({ member: json(404, { message: "Unknown Member", code: 10007 }) }))
      expect(reasonOf(exit)).toBe("not-in-guild")
    })
  )

  it.effect("fail with discord-unavailable, carrying the cause, on a 5xx or a transport error", () =>
    Effect.gen(function* () {
      const server = yield* Effect.exit(check({ user: json(502, { message: "bad gateway" }) }))
      expect(reasonOf(server)).toBe("discord-unavailable")
      const transport = yield* Effect.exit(check({ app: { _tag: "Transport" } }))
      expect(reasonOf(transport)).toBe("discord-unavailable")
      if (Exit.isFailure(transport) && transport.cause.reasons[0]?._tag === "Fail") {
        expect(transport.cause.reasons[0].error.cause).toBeInstanceOf(NoResponse)
      }
    })
  )

  it.effect("fail with discord-unavailable and a deadline NoResponse when Discord never answers", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(check({ user: { _tag: "Never" } })))
      yield* TestClock.adjust("30 seconds")
      const exit = yield* Fiber.join(fiber)
      expect(exit).toEqual(
        Exit.fail(
          new StartupFailed({
            reason: "discord-unavailable",
            detail: "/users/@me: no response within 30s",
            cause: new NoResponse({ route: "/users/@me", method: "GET", reason: "deadline", afterMs: 30000 })
          })
        )
      )
    })
  )

  it.effect("treat an answer no check expects as a defect", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(check({ user: json(403, { message: "Missing Access", code: 50001 }) }))
      expect(Exit.isFailure(exit) && !Exit.hasFails(exit)).toBe(true)
    })
  )
})

describe("classify (dfx failure shapes)", () => {
  const classified = (answer: Scripted) =>
    Effect.gen(function* () {
      const rest = yield* DiscordREST
      return yield* rest.getMyUser().pipe(
        Effect.as(undefined),
        Effect.catch((error) => classify(error, "/users/@me", 5))
      )
    }).pipe(Effect.provide(scriptedRest(() => answer)), Effect.exit)

  it.effect("copies a JSON error answer, reading data.code, with flattened field errors", () =>
    Effect.gen(function* () {
      const body = { code: 50035, message: "Invalid Form Body", errors: { content: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "too long" }] }, embeds: { "0": { title: { _errors: [{ code: 1, message: "n" }] } } } } }
      const exit = yield* classified(json(400, body))
      expect(Exit.isSuccess(exit) ? exit.value : undefined).toEqual({
        _tag: "Response",
        response: new DiscordResponse({
          status: 400,
          code: 50035,
          message: "Invalid Form Body",
          method: "GET",
          route: "/users/@me",
          fieldErrors: flattenFieldErrors(body.errors),
          attributedBy: "code"
        })
      })
      expect(flattenFieldErrors(body.errors).map((error) => [error.path, error.code])).toEqual([
        [["content"], "BASE_TYPE_MAX_LENGTH"],
        [["embeds", "0", "title"], "1"]
      ])
    })
  )

  it.effect("classifies 5xx and non-JSON 4xx as unavailable, transport as no response", () =>
    Effect.gen(function* () {
      const server = yield* classified(json(503, { message: "x" }))
      expect(Exit.isSuccess(server) ? server.value?._tag : undefined).toBe("Unavailable")
      const html = yield* classified({ _tag: "Text", status: 403, text: "<html>cloudflare</html>" })
      expect(Exit.isSuccess(html) ? html.value?._tag : undefined).toBe("Unavailable")
      const transport = yield* classified({ _tag: "Transport" })
      expect(Exit.isSuccess(transport) ? transport.value : undefined).toEqual({
        _tag: "NoResponse",
        cause: new NoResponse({ route: "/users/@me", method: "GET", reason: "transport", afterMs: 5 })
      })
    })
  )

  it.effect("makes a malformed Discord error body a defect", () =>
    Effect.gen(function* () {
      const exit = yield* classified(json(400, { nope: true }))
      expect(Exit.isFailure(exit) && !Exit.hasFails(exit)).toBe(true)
    })
  )
})

