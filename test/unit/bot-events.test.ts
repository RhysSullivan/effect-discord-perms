import { describe, expect, it } from "@effect/vitest"
import { ApplicationFlags } from "discord-api-types/v10"
import { Config, Deferred, Effect, Exit, Layer, Redacted, Ref, Tracer } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { Bot, BotRuntime } from "../../src/bot/Bot.ts"
import { DiscordUnavailable } from "../../src/errors/Transient.ts"
import { DiscordResponse } from "../../src/errors/Cause.ts"
import type { Intent } from "../../src/gateway/Intents.ts"
import { contentUnavailable } from "../../src/gateway/Events.ts"
import { GuildId } from "../../src/Snowflake.ts"
import { channelUpdate, guildCreate, ids } from "../support/dispatches.ts"
import { makeFakeGateway } from "../support/fakeGateway.ts"

/**
 * `bot.on` (DESIGN §2.7, §4.14, D25, D29) through the real bot layer (`Bot.layerWith`) over a fake base client and a
 * fake gateway: each event runs in its own fiber and scope (finalizers run per event), a failing or dying handler
 * does not stop later events, `message.content` is the frozen `ContentUnavailable` exactly when Discord would not
 * deliver content, the DM branch has a DM channel whose `send` posts to it, READY reaches a handler registered
 * after it, and a channel the bot cannot view arrives obfuscated.
 */
const guildId = GuildId.make(ids.guild)
const dmChannel = "300000000000000099"

const message = (overrides: Record<string, unknown> = {}) => ({
  id: "500000000000000001",
  channel_id: ids.text,
  guild_id: ids.guild,
  type: 0,
  author: { id: ids.target, bot: true },
  content: "lab hello",
  tts: false,
  mention_everyone: false,
  mentions: [],
  mention_roles: [],
  embeds: [],
  attachments: [],
  pinned: false,
  ...overrides
})

/** Runs `body` with a bot declaring `intents`, over a fake world; `posted` records the bodies of the messages it sends. */
const withBot = <A, E>(intents: ReadonlyArray<Intent>, body: (gateway: Effect.Success<ReturnType<typeof makeFakeGateway>>, posted: Ref.Ref<ReadonlyArray<string>>) => Effect.Effect<A, E, BotRuntime>) =>
  Effect.gen(function* () {
    const posted = yield* Ref.make<ReadonlyArray<string>>([])
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const path = new URL(request.url).pathname.replace(/^\/api\/v\d+/, "")
        const answer = (status: number, json: unknown) => HttpClientResponse.fromWeb(request, new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }))
        if (path === "/users/@me") return answer(200, { id: ids.bot, username: "Perms Subject" })
        if (path === "/applications/@me") return answer(200, { id: "100000000000000002", flags: ApplicationFlags.GatewayGuildMembers | ApplicationFlags.GatewayMessageContent })
        if (path === `/guilds/${ids.guild}/members/${ids.bot}`) return answer(200, { user: { id: ids.bot }, roles: [] })
        if (path === `/channels/${dmChannel}/messages` && request.method === "POST") {
          yield* Ref.update(posted, (all) => [...all, path])
          return answer(200, message({ id: "500000000000000077", channel_id: dmChannel, guild_id: undefined, author: { id: ids.bot, bot: true }, content: "pong" }))
        }
        return answer(404, { message: "404: Not Found", code: 0 })
      })
    )
    const gateway = yield* makeFakeGateway({ userFor: () => ids.bot, guildsFor: () => [guildCreate] }, () => 0)
    const bot = Bot.make({ intents })
    const layer = Bot.layerWith(bot, { token: Config.succeed(Redacted.make("fake-token")), guildId }).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), gateway.layer)))
    return yield* body(gateway, posted).pipe(Effect.provide(layer))
  })

/** Waits (a real-time poll, the fake gateway is real-time) until `ref` holds `count` entries. */
const until = <A>(ref: Ref.Ref<ReadonlyArray<A>>, count: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      if ((yield* Ref.get(ref)).length >= count) return yield* Ref.get(ref)
      yield* Effect.sleep("5 millis")
    }
    return yield* Ref.get(ref)
  })

describe("bot.on", () => {
  it.live("runs each event's finalizers when that event finishes, not at shutdown", () =>
    withBot(["Guilds", "GuildMessages", "MessageContent"], (gateway) =>
      Effect.gen(function* () {
        const log = yield* Ref.make<ReadonlyArray<string>>([])
        const bot = Bot.make({ intents: ["Guilds", "GuildMessages", "MessageContent"] })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* bot.on("MESSAGE_CREATE", (event) =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Ref.update(log, (all) => [...all, `closed ${event.message.id}`]))
                yield* Ref.update(log, (all) => [...all, `handled ${event.message.id}`])
              })
            )
            yield* gateway.dispatch("MESSAGE_CREATE", message({ id: "500000000000000001" }))
            expect(yield* until(log, 2)).toEqual(["handled 500000000000000001", "closed 500000000000000001"])
            yield* gateway.dispatch("MESSAGE_CREATE", message({ id: "500000000000000002" }))
            expect(yield* until(log, 4)).toEqual(["handled 500000000000000001", "closed 500000000000000001", "handled 500000000000000002", "closed 500000000000000002"])
          })
        )
      })
    )
  )

  it.live("keeps handling later events after a handler fails with a transient error or dies", () =>
    withBot(["Guilds", "GuildMessages", "MessageContent"], (gateway) =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        const bot = Bot.make({ intents: ["Guilds", "GuildMessages", "MessageContent"] })
        const unavailable = new DiscordUnavailable({
          cause: new DiscordResponse({ status: 503, code: 0, message: "unavailable", method: "POST", route: "/channels/{channel.id}/messages", fieldErrors: [], attributedBy: "code" })
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* bot.on("MESSAGE_CREATE", (event) =>
              Effect.gen(function* () {
                yield* Ref.update(seen, (all) => [...all, event.message.contentDelivered ? event.message.content : "?"])
                if (event.message.content === "fail") return yield* Effect.fail(unavailable)
                if (event.message.content === "die") return yield* Effect.die(new Error("a handler bug"))
              })
            )
            yield* gateway.dispatch("MESSAGE_CREATE", message({ id: "500000000000000001", content: "fail" }))
            yield* until(seen, 1)
            yield* gateway.dispatch("MESSAGE_CREATE", message({ id: "500000000000000002", content: "die" }))
            yield* until(seen, 2)
            yield* gateway.dispatch("MESSAGE_CREATE", message({ id: "500000000000000003", content: "later" }))
            expect(yield* until(seen, 3)).toEqual(["fail", "die", "later"])
          })
        )
      })
    )
  )

  it.live("runs each event in a discord.event.<NAME> span, failed when the handler failed though the failure was reported (D28)", () =>
    withBot(["Guilds", "GuildMessages", "MessageContent"], (gateway) =>
      Effect.gen(function* () {
        const spans: Array<Tracer.NativeSpan> = []
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options)
            spans.push(span)
            return span
          }
        })
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        const bot = Bot.make({ intents: ["Guilds", "GuildMessages", "MessageContent"] })
        const unavailable = new DiscordUnavailable({
          cause: new DiscordResponse({ status: 503, code: 0, message: "unavailable", method: "POST", route: "/channels/{channel.id}/messages", fieldErrors: [], attributedBy: "code" })
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* bot
              .on("MESSAGE_CREATE", (event) => Effect.andThen(Ref.update(seen, (all) => [...all, event.message.id]), event.message.id.endsWith("1") ? Effect.fail(unavailable) : Effect.void))
              .pipe(Effect.provideService(Tracer.Tracer, tracer))
            yield* gateway.dispatch("MESSAGE_CREATE", message({ id: "500000000000000001" }))
            yield* until(seen, 1)
            yield* gateway.dispatch("MESSAGE_CREATE", message({ id: "500000000000000002" }))
            yield* until(seen, 2)
            yield* Effect.sleep("20 millis")
          })
        )
        const events = spans.filter((span) => span.name === "discord.event.MESSAGE_CREATE")
        expect(events.map((span) => span.status._tag === "Ended" && Exit.isFailure(span.status.exit))).toEqual([true, false])
      })
    )
  )

  it.live("gives a foreign message the frozen ContentUnavailable without MessageContent, unless it mentions the bot or is the bot's own", () =>
    withBot(["Guilds", "GuildMessages"], (gateway) =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<readonly [boolean, unknown, string]>>([])
        const bot = Bot.make({ intents: ["Guilds", "GuildMessages"] })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* bot.on("MESSAGE_CREATE", (event) => Ref.update(seen, (all) => [...all, [event.message.contentDelivered, event.message.content, event.message.author] as const]))
            // Discord sends empty content to a bot without the intent; the library never shows that as a string
            yield* gateway.dispatch("MESSAGE_CREATE", message({ id: "500000000000000001", content: "" }))
            yield* until(seen, 1)
            yield* gateway.dispatch("MESSAGE_CREATE", message({ id: "500000000000000002", content: `<@${ids.bot}> hi`, mentions: [{ id: ids.bot, bot: true }] }))
            yield* until(seen, 2)
            yield* gateway.dispatch("MESSAGE_CREATE", message({ id: "500000000000000003", content: "mine", author: { id: ids.bot, bot: true } }))
            const all = yield* until(seen, 3)
            expect(all).toEqual([
              [false, contentUnavailable, "other"],
              [true, `<@${ids.bot}> hi`, "other"],
              [true, "mine", "self"]
            ])
            expect(all[0]?.[1]).toBe(contentUnavailable)
            expect(Object.isFrozen(contentUnavailable)).toBe(true)
          })
        )
      })
    )
  )

  it.live("delivers a DM through the DM branch: no guild, a DM channel whose send posts to it, content as a string", () =>
    withBot(["Guilds", "DirectMessages"], (gateway, posted) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<readonly [string | undefined, string, string, string]>()
        const bot = Bot.make({ intents: ["Guilds", "DirectMessages"] })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* bot.on("MESSAGE_CREATE", (event) =>
              event.guildId !== undefined
                ? Effect.void
                : event.channel.send({ content: "pong" }).pipe(
                  Effect.flatMap((sent) => Deferred.succeed(done, [event.guildId, event.channel.kind, event.channel.recipientId, `${event.message.content} ${sent.message.channelKind}`] as const)),
                  Effect.catchTag("CannotMessageUser", () => Effect.void),
                  Effect.catchTag("UnknownChannel", () => Effect.void)
                )
            )
            yield* gateway.dispatch("MESSAGE_CREATE", message({ channel_id: dmChannel, guild_id: undefined, content: "ping" }))
            expect(yield* Deferred.await(done)).toEqual([undefined, "dm", ids.target, "ping dm"])
            expect(yield* Ref.get(posted)).toEqual([`/channels/${dmChannel}/messages`])
          })
        )
      })
    )
  )

  it.live("runs a READY handler registered after READY once, for the session that is ready", () =>
    withBot(["Guilds"], () =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        const bot = Bot.make({ intents: [] })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* bot.on("READY", (event) => Ref.update(seen, (all) => [...all, event.userId]))
            expect(yield* until(seen, 1)).toEqual([ids.bot])
          })
        )
      })
    )
  )

  it.live("dies at registration when the Bot declares an intent the running build lacks, and accepts a Bot with fewer (the M7 verifier)", () =>
    withBot(["Guilds", "GuildMessages"], () =>
      Effect.gen(function* () {
        // typed with MessageContent (content: string), but the build identified without it
        const wider = Bot.make({ intents: ["Guilds", "GuildMessages", "MessageContent"] })
        const exit = yield* Effect.exit(Effect.scoped(wider.on("MESSAGE_CREATE", (event) => Effect.log(event.message.content.toUpperCase()))))
        expect(Exit.isFailure(exit) && !exit.cause.reasons.some((reason) => reason._tag === "Fail")).toBe(true)
        expect(Exit.isFailure(exit) ? String(exit.cause) : "").toContain("this Bot declares MessageContent, which the running bot build did not identify with")
        const narrower = Bot.make({ intents: ["Guilds"] })
        expect(yield* Effect.exit(Effect.scoped(narrower.on("CHANNEL_UPDATE", () => Effect.void)))).toStrictEqual(Exit.void)
      })
    )
  )

  it.live("hands CHANNEL_UPDATE a handle of the channel's kind, flagged when Discord obfuscated it (H-160)", () =>
    withBot(["Guilds"], (gateway) =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<readonly [string, string, boolean]>>([])
        const bot = Bot.make({ intents: ["Guilds"] })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* bot.on("CHANNEL_UPDATE", (event) => Ref.update(seen, (all) => [...all, [event.channel.id, event.channel.kind, event.obfuscated] as const]))
            yield* gateway.dispatch("CHANNEL_UPDATE", channelUpdate(ids.voice, 2, [], 1 << 17))
            yield* until(seen, 1)
            yield* gateway.dispatch("CHANNEL_UPDATE", channelUpdate(ids.text, 0, []))
            expect(yield* until(seen, 2)).toEqual([
              [ids.voice, "voice", true],
              [ids.text, "text", false]
            ])
          })
        )
      })
    )
  )
})
