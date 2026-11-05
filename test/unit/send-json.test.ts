import { describe, expect, it } from "@effect/vitest"
import { DiscordREST } from "dfx/DiscordREST"
import { Cause, Duration, Effect, Exit } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as Coded429 from "../../src/rest/Coded429.ts"
import { sendJson } from "../../src/rest/Request.ts"
import { checked } from "../../src/rest/RouteCheck.ts"
import { json, type Scripted, scriptedRest } from "../support/fakeDiscord.ts"

/**
 * `Request.sendJson` (M8, the registration's requests through `rest.httpClient`): it classifies an answer as `send`
 * does, keeps a coded 429's `retry_after`, and makes its request under the declared route, so the bot build's checked
 * client holds it to the route like every other request (the M8 verifier's surviving mutants).
 */
const route = "/applications/{application.id}/guilds/{guild.id}/commands"
const path = "/applications/100000000000000002/guilds/100000000000000001/commands"
const deadline = Duration.seconds(5)

/** The bot build's client stack over a scripted fake: the coded-429 interceptor inside the route check. */
const restWith = (script: (method: string, path: string) => Scripted) => scriptedRest(script, (client: HttpClient.HttpClient) => checked(Coded429.surface(client)))

describe("sendJson", () => {
  it.effect("answers a 2xx with its JSON body, and a refusal (a 400 or a coded 429) with its code, route and retry_after", () =>
    Effect.gen(function* () {
      const rest = yield* DiscordREST
      const ok = yield* sendJson(rest, route, "GET", path, undefined, deadline)
      expect(ok).toStrictEqual({ _tag: "Ok", body: [{ name: "x" }] })
      for (const [method, status] of [["PUT", 400], ["POST", 429]] as const) {
        const refused = yield* sendJson(rest, route, method, path, method === "PUT" ? [{ name: "x" }] : { name: "x" }, deadline)
        expect(refused._tag).toBe("Rejected")
        if (refused._tag === "Rejected") {
          expect([refused.response.status, refused.response.code, refused.retryAfterMs, refused.response.route]).toStrictEqual([status, 30034, 2500, route])
        }
      }
    }).pipe(
      Effect.provide(
        restWith((method) => {
          const limit = { code: 30034, message: "Max number of daily application command creates has been reached (200)", retry_after: 2.5, global: false }
          return method === "GET" ? json(200, [{ name: "x" }]) : method === "PUT" ? json(400, limit) : json(429, limit, { "retry-after": "3" })
        })
      )
    )
  )

  it.effect("makes its request under the declared route: a path the template does not match is a defect before anything is sent", () =>
    Effect.gen(function* () {
      const rest = yield* DiscordREST
      const exit = yield* Effect.exit(sendJson(rest, route, "PUT", "/applications/100000000000000002/commands", [], deadline))
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : "")).toContain(`route check: declared PUT ${route}, but the request is PUT /applications/{…}/commands`)
      expect(Exit.isSuccess(yield* Effect.exit(sendJson(rest, route, "PUT", path, [], deadline)))).toBe(true)
    }).pipe(Effect.provide(restWith(() => json(200, []))))
  )
})
