import { describe, expect, it } from "@effect/vitest"
import { ApplicationFlags } from "discord-api-types/v10"
import { Config, Effect, Layer, Redacted, Ref, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { Bot, GuildId } from "effect-discord-perms"
import * as ReferenceBot from "../../examples/reference-bot/bot.ts"
import { guildCreate, ids, memberObject } from "../support/dispatches.ts"
import { makeFakeGateway } from "../support/fakeGateway.ts"
import { set } from "../support/guild.ts"

/**
 * The reference bot (DESIGN §2.11, §6 M10) through the real bot build (`Bot.layerWith`, as `ReferenceBot.layer` uses
 * `Bot.layer`) over a fake Discord and a fake gateway: it registers `/poll`, answers a human's `!ping` with `pong` (and
 * ignores a bot's), posts a poll with its buttons where `Permissions.require` passes and says why where it does not, and
 * tallies votes on the poll message. Nothing leaves the process; the live bot is `examples/reference-bot/main.ts`.
 */
const guildId = GuildId.make(ids.guild)
const applicationId = "100000000000000002"
const human = "200000000000000077"
const otherHuman = "200000000000000078"
const commandsPath = `/applications/${applicationId}/guilds/${ids.guild}/commands`
const messagesPath = `/channels/${ids.text}/messages`
const token = "aW50ZXJhY3Rpb246dG9rZW4"

interface Request {
  readonly method: string
  readonly path: string
  readonly body: Schema.Json | undefined
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const isObject = (value: Schema.Json | undefined): value is Schema.JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)

/** A message as Discord answers a create: the sent body's content, embeds and components, by the bot, in #text. */
const created = (id: string, body: Schema.Json | undefined) => ({
  id,
  channel_id: ids.text,
  guild_id: ids.guild,
  type: 0,
  author: { id: ids.bot, username: "Perms Subject", bot: true },
  content: isObject(body) && typeof body["content"] === "string" ? body["content"] : "",
  tts: false,
  mention_everyone: false,
  mentions: [],
  mention_roles: [],
  embeds: isObject(body) && Array.isArray(body["embeds"]) ? body["embeds"] : [],
  components: isObject(body) && Array.isArray(body["components"]) ? body["components"] : [],
  attachments: [],
  pinned: false
})

/** A guild message in #text from `author`. */
const incoming = (id: string, author: { readonly id: string; readonly bot?: boolean }, content: string) => ({
  id,
  channel_id: ids.text,
  guild_id: ids.guild,
  type: 0,
  author: { id: author.id, username: `user-${author.id.slice(-2)}`, ...(author.bot === true ? { bot: true } : {}) },
  member: { roles: [] },
  content,
  tts: false,
  mention_everyone: false,
  mentions: [],
  mention_roles: [],
  embeds: [],
  attachments: [],
  pinned: false
})

/** An INTERACTION_CREATE in #text from `user`, with the bot's `app_permissions` there. */
const interaction = (id: string, type: number, user: string, appPermissions: bigint, data: Schema.Json, extra: Record<string, Schema.Json> = {}) => ({
  id,
  application_id: applicationId,
  type,
  token,
  guild_id: ids.guild,
  channel: { id: ids.text, type: 0 },
  member: { user: { id: user } },
  app_permissions: String(appPermissions),
  data,
  ...extra
})

const pollInvocation = (id: string, question: string, appPermissions: bigint) =>
  interaction(id, 2, human, appPermissions, { id: "700000000000000001", name: "poll", type: 1, options: [{ name: "question", type: 3, value: question }] })
const click = (id: string, user: string, customId: string) => interaction(id, 3, user, set("ViewChannel", "SendMessages"), { custom_id: customId, component_type: 2 }, { message: { id: "500000000000000100" } })

/** The `custom_id`s of a message body's buttons. */
const buttonsOf = (body: Schema.Json | undefined): ReadonlyArray<string> => {
  const rows = isObject(body) ? body["components"] : undefined
  if (!Array.isArray(rows)) return []
  return rows.flatMap((entry) => {
    const elements = isObject(entry) ? entry["components"] : undefined
    return Array.isArray(elements) ? elements.flatMap((element) => (isObject(element) && typeof element["custom_id"] === "string" ? [element["custom_id"]] : [])) : []
  })
}

/** Runs `body` with the reference bot's handlers registered on a bot build over a fake world, recording every request. */
const withReferenceBot = <A, E>(
  body: (world: { readonly dispatch: (event: string, data: unknown) => Effect.Effect<void>; readonly requests: Effect.Effect<ReadonlyArray<Request>> }) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<Request>>([])
    const stored = yield* Ref.make<Schema.Json>([])
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const path = new URL(request.url).pathname.replace(/^\/api\/v\d+/, "")
        const text = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
        const sent = text === undefined ? undefined : decodeJson(text)
        yield* Ref.update(requests, (all) => [...all, { method: request.method, path, body: sent }])
        const answer = (status: number, json: unknown) => HttpClientResponse.fromWeb(request, new Response(json === undefined ? null : JSON.stringify(json), { status, headers: { "content-type": "application/json" } }))
        if (path === "/users/@me") return answer(200, { id: ids.bot, username: "Perms Subject" })
        if (path === "/applications/@me") return answer(200, { id: applicationId, flags: ApplicationFlags.GatewayMessageContent })
        if (path === `/guilds/${ids.guild}/members/${ids.bot}`) return answer(200, memberObject(ids.bot, [ids.roleA, ids.managed]))
        if (path === commandsPath && request.method === "GET") return answer(200, yield* Ref.get(stored))
        if (path === commandsPath && request.method === "PUT") {
          const commands = Array.isArray(sent) ? sent.map((entry) => (isObject(entry) ? { id: "700000000000000001", application_id: applicationId, version: "1", default_member_permissions: null, guild_id: ids.guild, nsfw: false, ...entry } : entry)) : []
          yield* Ref.set(stored, commands)
          return answer(200, commands)
        }
        if (path === messagesPath && request.method === "POST") return answer(200, created("500000000000000100", sent))
        if (path.endsWith("/callback")) return answer(204, undefined)
        return answer(404, { message: "404: Not Found", code: 0 })
      })
    )
    const gateway = yield* makeFakeGateway({ userFor: () => ids.bot, guildsFor: () => [guildCreate] }, () => 0)
    const build = Bot.layerWith(ReferenceBot.bot, { token: Config.succeed(Redacted.make("fake-token")), guildId, commands: [ReferenceBot.poll] }).pipe(
      Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), gateway.layer))
    )
    const running = ReferenceBot.Handlers.pipe(Layer.provide(ReferenceBot.Polls.layer), Layer.provide(build))
    return yield* body({ dispatch: gateway.dispatch, requests: Ref.get(requests) }).pipe(Effect.provide(running))
  })

/** Waits (real time: the fake gateway is real-time) until `requests` holds a request `matching`, and returns them all. */
const until = (requests: Effect.Effect<ReadonlyArray<Request>>, matching: (request: Request) => boolean, count = 1) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      const all = yield* requests
      if (all.filter(matching).length >= count) return all
      yield* Effect.sleep("5 millis")
    }
    return yield* requests
  })

const isCallback = (request: Request) => request.path.endsWith("/callback")
const isMessagePost = (request: Request) => request.method === "POST" && request.path === messagesPath

describe("the reference bot", () => {
  it.live("registers /poll at startup, answers a human's !ping with pong in its channel, and ignores a bot's and any other message", () =>
    withReferenceBot(({ dispatch, requests }) =>
      Effect.gen(function* () {
        const registered = (yield* requests).filter((request) => request.path === commandsPath).map((request) => request.method)
        expect(registered).toEqual(["GET", "PUT", "GET"])
        yield* dispatch("MESSAGE_CREATE", incoming("500000000000000001", { id: ids.target, bot: true }, "!ping"))
        yield* dispatch("MESSAGE_CREATE", incoming("500000000000000002", { id: human }, "hello"))
        yield* dispatch("MESSAGE_CREATE", incoming("500000000000000003", { id: human }, "!ping"))
        const all = yield* until(requests, isMessagePost)
        yield* Effect.sleep("50 millis")
        const posts = (yield* requests).filter(isMessagePost)
        expect(posts.length).toBe(1)
        expect(all.filter(isMessagePost)[0]?.body).toEqual({ content: "pong", allowed_mentions: { parse: [] } })
      })
    )
  )

  it.live("posts a poll with its Yes and No buttons where require passes, answers privately, and tallies each voter's latest vote on the poll message", () =>
    withReferenceBot(({ dispatch, requests }) =>
      Effect.gen(function* () {
        yield* dispatch("INTERACTION_CREATE", pollInvocation("900000000000000001", "Lunch?", set("ViewChannel", "SendMessages", "EmbedLinks")))
        const afterPoll = yield* until(requests, isCallback)
        const post = afterPoll.find(isMessagePost)
        expect(isObject(post?.body) ? post.body["embeds"] : undefined).toEqual([{ title: "Lunch?" }])
        const [yes, no] = buttonsOf(post?.body)
        expect([yes, no]).toEqual(['vote:{"poll":1,"choice":"yes"}', 'vote:{"poll":1,"choice":"no"}'])
        expect(afterPoll.filter(isCallback).map((request) => request.body)).toEqual([
          { type: 4, data: { allowed_mentions: { parse: [] }, content: "Posted poll 1 (message 500000000000000100).", flags: 64 } }
        ])
        // three clicks: a yes, another voter's no, then the first voter changes to no
        yield* dispatch("INTERACTION_CREATE", click("900000000000000002", human, yes ?? ""))
        yield* until(requests, isCallback, 2)
        yield* dispatch("INTERACTION_CREATE", click("900000000000000003", otherHuman, no ?? ""))
        yield* until(requests, isCallback, 3)
        yield* dispatch("INTERACTION_CREATE", click("900000000000000004", human, no ?? ""))
        const all = yield* until(requests, isCallback, 4)
        const updates = all.filter(isCallback).slice(1).map((request) => request.body)
        expect(updates).toEqual([
          { type: 7, data: { allowed_mentions: { parse: [] }, embeds: [{ title: "Lunch?", description: "Yes 1, no 0" }] } },
          { type: 7, data: { allowed_mentions: { parse: [] }, embeds: [{ title: "Lunch?", description: "Yes 1, no 1" }] } },
          { type: 7, data: { allowed_mentions: { parse: [] }, embeds: [{ title: "Lunch?", description: "Yes 0, no 2" }] } }
        ])
      })
    )
  )

  it.live("refuses a poll where require fails (no EmbedLinks in app_permissions) before opening it, so the next poll is number 1; says when a question does not fit; an old poll's button says it closed", () =>
    withReferenceBot(({ dispatch, requests }) =>
      Effect.gen(function* () {
        yield* dispatch("INTERACTION_CREATE", pollInvocation("900000000000000001", "Lunch?", set("ViewChannel", "SendMessages")))
        const afterRefusal = yield* until(requests, isCallback)
        expect(afterRefusal.filter(isMessagePost)).toEqual([])
        // `require` refused before `polls.open`: without it the send's own preflight gives the same answer, but only
        // after a poll was opened, and this one would be number 2
        yield* dispatch("INTERACTION_CREATE", pollInvocation("900000000000000002", "Lunch?", set("ViewChannel", "SendMessages", "EmbedLinks")))
        yield* until(requests, isCallback, 2)
        // an embed title holds 256 characters
        yield* dispatch("INTERACTION_CREATE", pollInvocation("900000000000000003", "?".repeat(257), set("ViewChannel", "SendMessages", "EmbedLinks")))
        yield* until(requests, isCallback, 3)
        yield* dispatch("INTERACTION_CREATE", click("900000000000000004", human, 'vote:{"poll":7,"choice":"yes"}'))
        const all = yield* until(requests, isCallback, 4)
        expect(all.filter(isMessagePost).map((request) => (isObject(request.body) ? request.body["embeds"] : undefined))).toEqual([[{ title: "Lunch?" }]])
        expect(all.filter(isCallback).map((request) => request.body)).toEqual([
          { type: 4, data: { allowed_mentions: { parse: [] }, content: "I can't post the poll there (MissingEmbedLinks).", flags: 64 } },
          { type: 4, data: { allowed_mentions: { parse: [] }, content: "Posted poll 1 (message 500000000000000100).", flags: 64 } },
          { type: 4, data: { allowed_mentions: { parse: [] }, content: "That poll does not fit in a message.", flags: 64 } },
          { type: 7, data: { allowed_mentions: { parse: [] }, content: "This poll has closed.", components: [] } }
        ])
      })
    )
  )
})
