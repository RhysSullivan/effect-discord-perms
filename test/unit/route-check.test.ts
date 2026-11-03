import { describe, expect, it } from "@effect/vitest"
import { DiscordREST } from "dfx/DiscordREST"
import { Cause, Duration, Effect, Exit } from "effect"
import { send } from "../../src/rest/Request.ts"
import { checked, mismatch, pathShape, templatePattern } from "../../src/rest/RouteCheck.ts"
import { json, scriptedRest } from "../support/fakeDiscord.ts"

/**
 * The declared-route check (DESIGN §4.8, the M6 verifier): a request `send` makes must have the method and a path
 * matching the template its caller declared, or it is a defect that names the declared route and the shape of the
 * path sent (never the path itself, whose segments can be secrets).
 */
describe("templatePattern and mismatch", () => {
  it("matches a template under the API base, each placeholder one non-empty segment, the literals exactly", () => {
    const pins = templatePattern("/channels/{channel.id}/messages/pins/{message.id}")
    expect(pins.test("/api/v10/channels/1/messages/pins/2")).toBe(true)
    expect(pins.test("/channels/1/messages/pins/2")).toBe(true)
    expect(pins.test("/api/v10/channels/1/pins/2")).toBe(false)
    expect(pins.test("/api/v10/channels/1/messages/pins/2/3")).toBe(false)
    expect(pins.test("/api/v10/channels//messages/pins/2")).toBe(false)
    const reaction = templatePattern("/channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me")
    expect(reaction.test(`/api/v10/channels/1/messages/2/reactions/${encodeURIComponent("👍")}/@me`)).toBe(true)
    expect(reaction.test("/api/v10/channels/1/messages/2/reactions/lab_emoji:3/@me")).toBe(true)
    expect(reaction.test("/api/v10/channels/1/messages/2/reactions/lab_emoji:3/4")).toBe(false)
  })

  it("names the declared route and the path's shape when the method or the path differs", () => {
    const declared = { method: "PUT", template: "/channels/{channel.id}/messages/pins/{message.id}" } as const
    expect(mismatch(declared, "PUT", "https://discord.com/api/v10/channels/1/messages/pins/2")).toBeUndefined()
    expect(mismatch(declared, "DELETE", "https://discord.com/api/v10/channels/1/messages/pins/2")).toBe(
      "declared PUT /channels/{channel.id}/messages/pins/{message.id}, but the request is DELETE /channels/{…}/messages/pins/{…}"
    )
    expect(mismatch(declared, "PUT", "https://discord.com/api/v10/channels/1/pins/2")).toBe("declared PUT /channels/{channel.id}/messages/pins/{message.id}, but the request is PUT /channels/{…}/pins/{…}")
  })

  it("shows every segment that is not a lowercase word as {…}, so a token in a path never reaches the defect", () => {
    expect(pathShape("/webhooks/123/aW50ZXJhY3Rpb246MTIz/messages/@original")).toBe("/webhooks/{…}/{…}/messages/{…}")
    expect(pathShape("/channels/1/thread-members/@me")).toBe("/channels/{…}/thread-members/@me")
  })
})

describe("the checked client", () => {
  const rest = scriptedRest(() => json(200, {}), checked)

  it.effect("sends a request that is its declared route, and dies on one that is not, before it is sent", () =>
    Effect.gen(function* () {
      const client = yield* DiscordREST
      const deadline = Duration.seconds(5)
      const ok = yield* send("/channels/{channel.id}/messages/pins/{message.id}", "DELETE", client.deletePin("1", "2"), deadline)
      expect(ok._tag).toBe("Ok")
      const wrongMethod = yield* Effect.exit(send("/channels/{channel.id}/messages/pins/{message.id}", "DELETE", client.createPin("1", "2"), deadline))
      expect(Exit.isFailure(wrongMethod) && Cause.hasDies(wrongMethod.cause)).toBe(true)
      expect(String(Exit.isFailure(wrongMethod) ? Cause.squash(wrongMethod.cause) : "")).toContain(
        "route check: declared DELETE /channels/{channel.id}/messages/pins/{message.id}, but the request is PUT /channels/{…}/messages/pins/{…}"
      )
      const wrongPath = yield* Effect.exit(send("/guilds/{guild.id}/members/{user.id}/roles/{role.id}", "PUT", client.updateGuildMember("1", "2", { nick: "x" }), deadline))
      expect(Exit.isFailure(wrongPath) && Cause.hasDies(wrongPath.cause)).toBe(true)
    }).pipe(Effect.provide(rest))
  )

  it.effect("does not check a request made outside send, which declares no route", () =>
    Effect.gen(function* () {
      const client = yield* DiscordREST
      expect(yield* Effect.exit(client.getChannel("1"))).toMatchObject({ _tag: "Success" })
    }).pipe(Effect.provide(rest))
  )
})
