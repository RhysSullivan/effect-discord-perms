import { describe, expect, it } from "@effect/vitest"
import { ApplicationFlags } from "discord-api-types/v10"
import { Cause, Config, Context, Duration, Effect, Exit, Fiber, Layer, Option, Redacted } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as Headers from "effect/http/Headers"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { Bot, BotRuntime, intentBits } from "../../src/bot/Bot.ts"
import { BotInternals, SubjectRaw } from "../../src/bot/Internals.ts"
import { StartupFailed } from "../../src/bot/Startup.ts"
import * as DiscordApi from "../../src/rest/DiscordApi.ts"
import { send } from "../../src/rest/Request.ts"
import * as Schemas from "../../src/rest/Schemas.ts"
import { ChannelId, GuildId, RoleId, UserId } from "../../src/Snowflake.ts"
import { channelUpdate, guildCreate, ids, memberObject, overwrite } from "../support/dispatches.ts"
import { makeFakeGateway } from "../support/fakeGateway.ts"

/**
 * The library's bot build (DESIGN §4.2, §4.4): startup checks 1-3 over REST before the gateway starts, the
 * gateway's dispatches reduced into the guild state by the hook, the configured guild awaited (check 4), and
 * `SubjectRaw` from the same build. Driven by a fake base client and a fake gateway.
 */
const guildId = GuildId.make(ids.guild)
const bot = Bot.make({ intents: ["Guilds", "GuildMembers"] })

interface World {
  readonly token: string
  readonly status: number
  readonly guildArrives: boolean
}

const setup = (world: World) =>
  Effect.gen(function* () {
    let tick = 0
    const clock = () => ++tick
    const requests: Array<{ readonly at: number; readonly path: string }> = []
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const path = new URL(request.url).pathname.replace(/^\/api\/v\d+/, "")
        requests.push({ at: clock(), path })
        const answer = (status: number, body: unknown) =>
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
        if (world.status !== 200) return answer(world.status, { message: "401: Unauthorized", code: 0 })
        if (path === "/users/@me") return answer(200, { id: ids.bot, username: "Perms Subject" })
        if (path === "/applications/@me") return answer(200, { id: "100000000000000002", flags: ApplicationFlags.GatewayGuildMembers })
        if (path === `/guilds/${ids.guild}/members/${ids.bot}`) return answer(200, memberObject(ids.bot, [ids.roleA]))
        if (path === `/channels/${ids.text}`) return answer(200, channelUpdate(ids.text, 0, []))
        if (path === `/channels/${ids.text}/messages`) return answer(429, { message: "You are sending messages too quickly", code: 20028, retry_after: 2.5, global: false })
        return answer(404, { message: "404: Not Found", code: 0 })
      })
    )
    const gateway = yield* makeFakeGateway(
      { userFor: (token) => (token === world.token ? ids.bot : undefined), guildsFor: () => (world.guildArrives ? [guildCreate] : []) },
      clock
    )
    const layer = BotInternals.layerWith(bot, { token: Config.succeed(Redacted.make(world.token)), guildId }).pipe(
      Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), gateway.layer))
    )
    return { layer, gateway, requests }
  })

const reasonOf = <A, E>(exit: Exit.Exit<A, E>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const error = Cause.findErrorOption(exit.cause)
  return Option.isSome(error) && error.value instanceof StartupFailed ? error.value.reason : undefined
}

describe("the bot build", () => {
  it.live("checks over REST, then starts the gateway, reduces GUILD_CREATE and later dispatches, and shares its REST client", () =>
    Effect.gen(function* () {
      const { layer, gateway, requests } = yield* setup({ token: "fake-subject-token", status: 200, guildArrives: true })
      yield* Effect.gen(function* () {
        const runtime = yield* BotRuntime
        expect(runtime.identity.userId).toBe(ids.bot)
        expect(runtime.intents).toEqual(["Guilds", "GuildMembers"])
        const snapshot = yield* runtime.guildState.snapshot
        expect(snapshot.botUserId).toBe(ids.bot)
        expect(snapshot.guilds.get(guildId)?.botMember?.roleIds).toEqual([ids.roleA, ids.managed])

        // startup checks 1-3 ran before the gateway started (§4.4): dfx's sharder asks for /gateway/bot first
        const opened = yield* gateway.opened
        expect(requests.filter((entry) => entry.at < opened).map((entry) => entry.path)).toEqual([
          "/users/@me",
          "/applications/@me",
          `/guilds/${ids.guild}/members/${ids.bot}`,
          "/gateway/bot"
        ])
        expect(yield* gateway.identified).toEqual([{ user: ids.bot, intents: intentBits(["Guilds", "GuildMembers"]) }])

        // a later dispatch reaches the state through the hook
        yield* gateway.dispatch("CHANNEL_UPDATE", channelUpdate(ids.text, 0, [overwrite(ids.guild, 0, "0", "1024")]))
        let overwrites = 0
        for (let attempt = 0; attempt < 200 && overwrites !== 1; attempt++) {
          yield* Effect.sleep("5 millis")
          overwrites = (yield* runtime.guildState.snapshot).guilds.get(guildId)?.channels.get(ChannelId.make(ids.text))?.overwrites.length ?? -1
        }
        expect(overwrites).toBe(1)

        // SubjectRaw is the build's dfx client, carrying the build's token through the same base client
        const raw = yield* SubjectRaw
        yield* raw.getChannel(ids.text)
        expect(requests.at(-1)?.path).toBe(`/channels/${ids.text}`)
      }).pipe(Effect.provide(layer), Effect.scoped)
    })
  )

  it.live("wraps the build's HTTP client in the coded-429 interceptor: a coded 429 reaches the API and SubjectRaw once, unretried", () =>
    Effect.gen(function* () {
      const { layer, requests } = yield* setup({ token: "fake-subject-token", status: 200, guildArrives: true })
      yield* Effect.gen(function* () {
        const runtime = yield* BotRuntime
        const posts = () => requests.filter((entry) => entry.path === `/channels/${ids.text}/messages`).length
        const exit = yield* runtime.api
          .execute({
            target: { op: "channel.send", guildId, scope: { _tag: "Channel", channelId: ChannelId.make(ids.text) }, granted: [], args: { payload: [] }, completion: { _tag: "Static" } },
            route: { method: "POST", template: "/channels/{channel.id}/messages" },
            call: (rest) => rest.createMessage(ids.text, { content: "hi" }),
            response: Schemas.Message,
            limits: {}
          })
          .pipe(Effect.exit)
        const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
        expect(error?._tag === "RateLimited" ? [error.retryAfterMs, error.cause.code] : error?._tag).toEqual([2500, 20028])
        expect(posts()).toBe(1)
        const raw = yield* SubjectRaw
        const answer = yield* send("/channels/{channel.id}/messages", "POST", raw.createMessage(ids.text, { content: "hi" }), Duration.seconds(5))
        expect(answer._tag === "Rejected" ? [answer.response.status, answer.response.code, answer.retryAfterMs] : answer._tag).toEqual([429, 20028, 2500])
        expect(posts()).toBe(2)
      }).pipe(Effect.provide(layer), Effect.scoped)
    })
  )

  it.live("fails with invalid-token, without opening the gateway", () =>
    Effect.gen(function* () {
      const { layer, gateway } = yield* setup({ token: "fake-subject-token", status: 401, guildArrives: true })
      const exit = yield* Effect.exit(Effect.provide(Effect.service(BotRuntime), layer).pipe(Effect.scoped))
      expect(reasonOf(exit)).toBe("invalid-token")
      expect(yield* gateway.opened).toBe(-1)
    })
  )

  it.live("keeps two bot builds in one layer graph apart: each has its own token, dfx client and guild state (Layer.fresh, G1)", () =>
    Effect.gen(function* () {
      const users: Readonly<Record<string, string>> = { "Bot fake-token-a": ids.bot, "Bot fake-token-b": ids.target }
      const seen: Array<{ readonly authorization: string; readonly path: string }> = []
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname.replace(/^\/api\/v\d+/, "")
          const authorization = Option.getOrElse(Headers.get(request.headers, "authorization"), () => "")
          seen.push({ authorization, path })
          const user = users[authorization]
          const answer = (status: number, body: unknown) =>
            HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
          if (user === undefined) return answer(401, { message: "401: Unauthorized", code: 0 })
          if (path === "/users/@me") return answer(200, { id: user, username: `user-${user.slice(-2)}` })
          if (path === "/applications/@me") return answer(200, { id: "100000000000000002", flags: ApplicationFlags.GatewayGuildMembers })
          if (path === `/guilds/${ids.guild}/members/${user}`) return answer(200, memberObject(user, []))
          if (path === `/channels/${ids.text}`) return answer(200, channelUpdate(ids.text, 0, []))
          return answer(404, { message: "404: Not Found", code: 0 })
        })
      )
      const gateway = yield* makeFakeGateway({ userFor: (token) => users[`Bot ${token}`], guildsFor: () => [guildCreate] }, () => 0)
      class RawA extends Context.Service<RawA, SubjectRaw["Service"]>()("test/RawA") {}
      class RawB extends Context.Service<RawB, SubjectRaw["Service"]>()("test/RawB") {}
      class RuntimeB extends Context.Service<RuntimeB, BotRuntime["Service"]>()("test/RuntimeB") {}
      const build = (token: string) => BotInternals.layerWith(bot, { token: Config.succeed(Redacted.make(token)), guildId })
      const a = Layer.merge(Layer.effect(RawA, Effect.service(SubjectRaw)), Layer.effect(BotRuntime, Effect.service(BotRuntime))).pipe(Layer.provide(build("fake-token-a")))
      const b = Layer.merge(Layer.effect(RawB, Effect.service(SubjectRaw)), Layer.effect(RuntimeB, Effect.service(BotRuntime))).pipe(Layer.provide(build("fake-token-b")))
      const both = Layer.mergeAll(a, b).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), gateway.layer)))
      yield* Effect.gen(function* () {
        const runtimeA = yield* BotRuntime
        const runtimeB = yield* RuntimeB
        expect([runtimeA.identity.userId, runtimeB.identity.userId]).toEqual([ids.bot, ids.target])
        expect(runtimeA.guildState).not.toBe(runtimeB.guildState)
        expect((yield* runtimeA.guildState.snapshot).botUserId).toBe(ids.bot)
        expect((yield* runtimeB.guildState.snapshot).botUserId).toBe(ids.target)
        const rawA = yield* RawA
        const rawB = yield* RawB
        expect(rawA).not.toBe(rawB)
        seen.length = 0
        yield* rawA.getChannel(ids.text)
        yield* rawB.getChannel(ids.text)
        expect(seen.map((entry) => entry.authorization)).toEqual(["Bot fake-token-a", "Bot fake-token-b"])
      }).pipe(Effect.provide(both), Effect.scoped)
    })
  )

  it.effect("fails with guild-not-ready when GUILD_CREATE does not come within 30 s", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({ token: "fake-subject-token", status: 200, guildArrives: false })
      const fiber = yield* Effect.provide(Effect.service(BotRuntime), layer).pipe(Effect.scoped, Effect.exit, Effect.forkChild)
      for (let step = 0; step < 40; step++) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2)))
        yield* TestClock.adjust("1 second")
      }
      expect(reasonOf(yield* Fiber.join(fiber))).toBe("guild-not-ready")
    })
  )

  describe("the request deadline comes from DiscordApiConfig, for every call of the build (§4.1, §4.10)", () => {
    /** A build whose base client never answers `stalled` paths; everything else as in `setup`. */
    const stalledBuild = (stalled: (path: string) => boolean, deadline: Duration.Duration) =>
      Effect.gen(function* () {
        const client = HttpClient.make((request) => {
          const path = new URL(request.url).pathname.replace(/^\/api\/v\d+/, "")
          if (stalled(path)) return Effect.never
          const answer = (status: number, body: unknown) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })))
          if (path === "/users/@me") return answer(200, { id: ids.bot, username: "Perms Subject" })
          if (path === "/applications/@me") return answer(200, { id: "100000000000000002", flags: ApplicationFlags.GatewayGuildMembers })
          if (path === `/guilds/${ids.guild}/members/${ids.bot}`) return answer(200, memberObject(ids.bot, [ids.roleA]))
          if (path === `/guilds/${ids.guild}`) return answer(200, guildCreate)
          if (path === `/guilds/${ids.guild}/members/${ids.target}`) return answer(200, memberObject(ids.target, []))
          if (path === `/guilds/${ids.guild}/members/${ids.target}/roles/${ids.roleA}`) return answer(403, { message: "Missing Permissions", code: 50013 })
          return answer(404, { message: "404: Not Found", code: 0 })
        })
        const gateway = yield* makeFakeGateway({ userFor: (token) => (token === "fake-subject-token" ? ids.bot : undefined), guildsFor: () => [guildCreate] }, () => 0)
        return BotInternals.layerWith(bot, { token: Config.succeed(Redacted.make("fake-subject-token")), guildId }).pipe(
          Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), gateway.layer)),
          Layer.provide(Layer.succeed(DiscordApi.DiscordApiConfig, { requestDeadline: deadline }))
        )
      })
    const deadline = Duration.millis(150)

    it.live("a startup check that gets no answer fails with discord-unavailable after the configured deadline", () =>
      Effect.gen(function* () {
        const layer = yield* stalledBuild((path) => path === "/users/@me", deadline)
        const exit = yield* Effect.exit(Effect.provide(Effect.service(BotRuntime), layer).pipe(Effect.scoped))
        const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
        expect(error instanceof StartupFailed ? [error.reason, error.cause?._tag === "NoResponse" ? error.cause.afterMs : undefined] : error).toEqual(["discord-unavailable", 150])
      })
    )

    it.live("a guild-state refresh read that gets no answer fails with RequestTimedOut after the configured deadline", () =>
      Effect.gen(function* () {
        const layer = yield* stalledBuild((path) => path === `/channels/${ids.text}`, deadline)
        yield* Effect.gen(function* () {
          const runtime = yield* BotRuntime
          const exit = yield* runtime.guildState.refresh(guildId, ChannelId.make(ids.text)).pipe(Effect.exit)
          const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
          expect(error?._tag === "RequestTimedOut" ? [error.cause.reason, error.cause.afterMs] : error).toEqual(["deadline", 150])
        }).pipe(Effect.provide(layer), Effect.scoped)
      })
    )

    it.live("a recompute read that gets no answer fails with RequestTimedOut after the configured deadline", () =>
      Effect.gen(function* () {
        // the role assignment is refused with 50013; the recompute refreshes, then reads the target, which stalls
        let targetReads = 0
        const layer = yield* stalledBuild((path) => path === `/guilds/${ids.guild}/members/${ids.target}` && ++targetReads > 0, deadline)
        yield* Effect.gen(function* () {
          const runtime = yield* BotRuntime
          const exit = yield* runtime.api
            .execute({
              target: {
                op: "member.addRole",
                guildId,
                scope: { _tag: "Guild" },
                granted: [],
                args: { payload: [] },
                completion: { _tag: "Member", targetUserId: UserId.make(ids.target), role: RoleId.make(ids.roleA) }
              },
              route: { method: "PUT", template: "/guilds/{guild.id}/members/{user.id}/roles/{role.id}" },
              call: (rest) => rest.addGuildMemberRole(ids.guild, ids.target, ids.roleA),
              response: Schemas.Message,
              limits: {}
            })
            .pipe(Effect.exit)
          const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
          expect(error?._tag === "RequestTimedOut" ? [error.cause.route, error.cause.afterMs] : error).toEqual(["/guilds/{guild.id}/members/{user.id}", 150])
          expect(targetReads).toBe(1)
        }).pipe(Effect.provide(layer), Effect.scoped)
      })
    )
  })
})
