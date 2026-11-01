import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Option } from "effect"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { type GuardState, make, verdict } from "../../harness/Lab.ts"
import { ChannelId, GuildId, RoleId, UserId } from "../../src/Snowflake.ts"

/**
 * The Perms Lab guard (DESIGN §5.6): a pure decision per request, and the service that dies before a refused
 * request is sent. Every write the lab does not need is refused, and so is every guild route outside the lab.
 */
const guild = GuildId.make("100000000000000000")
const otherGuild = "100000000000000999"
const harness = UserId.make("200000000000000000")
const subject = UserId.make("200000000000000001")
const target = UserId.make("200000000000000002")
const rhys = "200000000000000099"
const labChannel = ChannelId.make("300000000000000001")
const rules = ChannelId.make("300000000000000098")
const elsewhere = "300000000000000099"
const labRole = RoleId.make("400000000000000001")
const foreignRole = "400000000000000099"
const harnessRole = "400000000000000050"
const labRule = "500000000000000001"
const otherRule = "500000000000000099"

const armed: GuardState = {
  guildId: guild,
  armed: Option.some({ harnessUserId: harness, subjectUserId: subject, targetUserId: target, protectedChannels: new Set([rules]) }),
  channels: new Set([labChannel]),
  roles: new Set([labRole]),
  positionRoles: new Set([harnessRole]),
  autoModRules: new Set([labRule])
}
const api = (path: string) => `https://discord.com/api/v10${path}`
const decide = (method: string, path: string, body?: string, state: GuardState = armed) =>
  verdict(state, method, api(path), body === undefined ? Option.none() : Option.some(body))._tag
const json = (value: unknown): string => JSON.stringify(value)

describe("the guard's verdict", () => {
  it("allows reads, but never of another guild", () => {
    expect(decide("GET", "/users/@me")).toBe("Allow")
    expect(decide("GET", `/channels/${elsewhere}`)).toBe("Allow")
    expect(decide("GET", `/guilds/${guild}/channels`)).toBe("Allow")
    expect(decide("GET", `/guilds/${otherGuild}`)).toBe("Refuse")
    expect(decide("GET", `/applications/1/guilds/${otherGuild}/commands`)).toBe("Refuse")
  })

  it("refuses every write before it is armed", () => {
    const unarmed: GuardState = { ...armed, armed: Option.none() }
    expect(decide("POST", `/channels/${labChannel}/messages`, undefined, unarmed)).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/roles/${guild}`, undefined, unarmed)).toBe("Refuse")
  })

  it("allows writes to admitted lab channels only, never to protected or other channels", () => {
    expect(decide("POST", `/channels/${labChannel}/messages`)).toBe("Allow")
    expect(decide("PATCH", `/channels/${labChannel}`)).toBe("Allow")
    expect(decide("DELETE", `/channels/${labChannel}/messages/1`)).toBe("Allow")
    expect(decide("POST", `/channels/${elsewhere}/messages`)).toBe("Refuse")
    expect(decide("POST", `/channels/${rules}/messages`)).toBe("Refuse")
    expect(decide("POST", `/channels/${labChannel}/webhooks`)).toBe("Refuse")
    expect(decide("POST", `/channels/${labChannel}/invites`)).toBe("Refuse")
    expect(decide("POST", `/channels/${labChannel}/followers`)).toBe("Refuse")
  })

  it("creates only lab-named channels under lab parents, and never reorders or re-parents the guild's channels", () => {
    expect(decide("POST", `/guilds/${guild}/channels`, json({ name: "lab-text", type: 0, parent_id: labChannel }))).toBe("Allow")
    expect(decide("POST", `/guilds/${guild}/channels`, json({ name: "lab", type: 4 }))).toBe("Allow")
    expect(decide("POST", `/guilds/${guild}/channels`, json({ name: "general", type: 0, parent_id: labChannel }))).toBe("Refuse")
    expect(decide("POST", `/guilds/${guild}/channels`, json({ name: "lab-text", type: 0, parent_id: elsewhere }))).toBe("Refuse")
    expect(decide("POST", `/guilds/${guild}/channels`, json({ name: "lab-text", type: 0, parent_id: rules }))).toBe("Refuse")
    expect(decide("POST", `/guilds/${guild}/channels`)).toBe("Refuse")
    // the channel-list PATCH moves any channel, #rules included, whatever its body says
    expect(decide("PATCH", `/guilds/${guild}/channels`, json([{ id: rules, position: 0, parent_id: labChannel }]))).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/channels`, json([{ id: labChannel, position: 0 }]))).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/channels`, json({ name: "lab-text", type: 0 }))).toBe("Refuse")
  })

  it("changes thread membership only for the bots, never a human", () => {
    expect(decide("PUT", `/channels/${labChannel}/thread-members/@me`)).toBe("Allow")
    expect(decide("DELETE", `/channels/${labChannel}/thread-members/@me`)).toBe("Allow")
    expect(decide("PUT", `/channels/${labChannel}/thread-members/${target}`)).toBe("Allow")
    expect(decide("DELETE", `/channels/${labChannel}/thread-members/${subject}`)).toBe("Allow")
    expect(decide("PUT", `/channels/${labChannel}/thread-members/${rhys}`)).toBe("Refuse")
    expect(decide("DELETE", `/channels/${labChannel}/thread-members/${rhys}`)).toBe("Refuse")
    expect(decide("PUT", `/channels/${labChannel}/thread-members/${harness}`)).toBe("Refuse")
    expect(decide("PUT", `/channels/${elsewhere}/thread-members/@me`)).toBe("Refuse")
  })

  it("allows overwrites only for lab roles, @everyone and the two bots", () => {
    expect(decide("PUT", `/channels/${labChannel}/permissions/${labRole}`)).toBe("Allow")
    expect(decide("PUT", `/channels/${labChannel}/permissions/${guild}`)).toBe("Allow")
    expect(decide("PUT", `/channels/${labChannel}/permissions/${subject}`)).toBe("Allow")
    expect(decide("PUT", `/channels/${labChannel}/permissions/${rhys}`)).toBe("Refuse")
    expect(decide("PUT", `/channels/${labChannel}/permissions/${foreignRole}`)).toBe("Refuse")
  })

  it("refuses kick and ban outright, and member edits of anyone but the two bots", () => {
    expect(decide("DELETE", `/guilds/${guild}/members/${target}`)).toBe("Refuse")
    expect(decide("PUT", `/guilds/${guild}/bans/${target}`)).toBe("Refuse")
    expect(decide("DELETE", `/guilds/${guild}/bans/${target}`)).toBe("Refuse")
    expect(decide("POST", `/guilds/${guild}/bulk-ban`)).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/members/${target}`, json({ nick: null, communication_disabled_until: null }))).toBe("Allow")
    expect(decide("PATCH", `/guilds/${guild}/members/${subject}`, json({ communication_disabled_until: "2026-11-01T23:00:00Z" }))).toBe("Allow")
    expect(decide("PATCH", `/guilds/${guild}/members/@me`, json({ nick: "lab" }))).toBe("Allow")
    expect(decide("PATCH", `/guilds/${guild}/members/${rhys}`, json({ nick: null }))).toBe("Refuse")
  })

  it("edits members' nicknames and timeouts only: never roles, voice channels or other fields", () => {
    const member = `/guilds/${guild}/members/${target}`
    expect(decide("PATCH", member, json({ roles: [foreignRole] }))).toBe("Refuse")
    expect(decide("PATCH", member, json({ roles: [labRole] }))).toBe("Refuse")
    expect(decide("PATCH", member, json({ nick: null, roles: [] }))).toBe("Refuse")
    expect(decide("PATCH", member, json({ channel_id: labChannel }))).toBe("Refuse")
    expect(decide("PATCH", member, json({ channel_id: null }))).toBe("Refuse")
    expect(decide("PATCH", member, json({ mute: true }))).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/members/@me`, json({ roles: [foreignRole] }))).toBe("Refuse")
    expect(decide("PATCH", member)).toBe("Refuse")
    expect(decide("PATCH", member, "not json")).toBe("Refuse")
    expect(decide("PUT", `/guilds/${guild}/members/${subject}/roles/${labRole}`)).toBe("Allow")
    expect(decide("PUT", `/guilds/${guild}/members/${subject}/roles/${foreignRole}`)).toBe("Refuse")
    expect(decide("PUT", `/guilds/${guild}/members/${rhys}/roles/${labRole}`)).toBe("Refuse")
  })

  it("allows role writes on lab roles and @everyone, and role positions that move lab roles only", () => {
    expect(decide("POST", `/guilds/${guild}/roles`, json({ name: "lab-grant", permissions: 0 }))).toBe("Allow")
    expect(decide("POST", `/guilds/${guild}/roles`, json({ name: "Moderators", permissions: 8 }))).toBe("Refuse")
    expect(decide("POST", `/guilds/${guild}/roles`)).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/roles/${labRole}`)).toBe("Allow")
    expect(decide("PATCH", `/guilds/${guild}/roles/${guild}`)).toBe("Allow")
    expect(decide("DELETE", `/guilds/${guild}/roles/${guild}`)).toBe("Refuse")
    expect(decide("DELETE", `/guilds/${guild}/roles/${foreignRole}`)).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/roles`, JSON.stringify([{ id: labRole, position: 1 }]))).toBe("Allow")
    expect(decide("PATCH", `/guilds/${guild}/roles`, JSON.stringify([{ id: labRole, position: 1 }, { id: foreignRole, position: 2 }]))).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/roles`)).toBe("Refuse")
    // the harness's own role may move in a position PATCH (Discord requires it), but nothing else touches it
    expect(decide("PATCH", `/guilds/${guild}/roles`, JSON.stringify([{ id: harnessRole, position: 2 }, { id: labRole, position: 1 }]))).toBe("Allow")
    expect(decide("PATCH", `/guilds/${guild}/roles/${harnessRole}`)).toBe("Refuse")
    expect(decide("DELETE", `/guilds/${guild}/roles/${harnessRole}`)).toBe("Refuse")
    expect(decide("PUT", `/guilds/${guild}/members/${subject}/roles/${harnessRole}`)).toBe("Refuse")
  })

  it("deletes only admitted lab AutoMod rules, and creates or edits none", () => {
    expect(decide("DELETE", `/guilds/${guild}/auto-moderation/rules/${labRule}`)).toBe("Allow")
    expect(decide("DELETE", `/guilds/${guild}/auto-moderation/rules/${otherRule}`)).toBe("Refuse")
    expect(decide("POST", `/guilds/${guild}/auto-moderation/rules`, json({ name: "lab-rule" }))).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/auto-moderation/rules/${labRule}`, json({ enabled: false }))).toBe("Refuse")
  })

  it("refuses guild edits, DMs, leaving the guild, global commands and other hosts", () => {
    expect(decide("PATCH", `/guilds/${guild}`)).toBe("Refuse")
    expect(decide("POST", `/guilds/${otherGuild}/channels`)).toBe("Refuse")
    expect(decide("POST", "/users/@me/channels")).toBe("Refuse")
    expect(decide("DELETE", `/users/@me/guilds/${guild}`)).toBe("Refuse")
    expect(decide("PUT", "/applications/1/commands")).toBe("Refuse")
    expect(decide("PUT", `/applications/1/guilds/${guild}/commands`)).toBe("Allow")
    expect(decide("POST", `/interactions/1/token/callback`)).toBe("Refuse")
    expect(verdict(armed, "GET", "https://example.com/api/v10/users/@me", Option.none())._tag).toBe("Refuse")
  })
})

describe("the guard service", () => {
  it.effect("dies on a refused request and admits only lab objects", () =>
    Effect.gen(function* () {
      const guard = yield* make(guild)
      const write = HttpClientRequest.post(api(`/channels/${labChannel}/messages`))
      expect(Exit.isFailure(yield* Effect.exit(guard.check(write)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.admitChannel({ id: labChannel, name: "lab-text" })))).toBe(true)

      yield* guard.arm({ harnessUserId: harness, subjectUserId: subject, targetUserId: target, protectedChannels: new Set([rules]) })
      expect(Exit.isFailure(yield* Effect.exit(guard.check(write)))).toBe(true)
      yield* guard.admitChannel({ id: labChannel, name: "lab-text" })
      expect(Exit.isSuccess(yield* Effect.exit(guard.check(write)))).toBe(true)

      expect(Exit.isFailure(yield* Effect.exit(guard.admitChannel({ id: rules, name: "lab-rules" })))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.admitChannel({ id: ChannelId.make(elsewhere), name: "general" })))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.admitRole({ id: RoleId.make(guild), name: "lab-everyone", botId: undefined })))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.admitRole({ id: RoleId.make(foreignRole), name: "Moderators", botId: undefined })))).toBe(true)
      yield* guard.admitRole({ id: RoleId.make(foreignRole), name: "Perms Subject", botId: subject })
      expect(Exit.isFailure(yield* Effect.exit(guard.admitRole({ id: RoleId.make(harnessRole), name: "Perms Harness", botId: harness })))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.admitHarnessRoleForPositions({ id: RoleId.make(harnessRole), botId: subject })))).toBe(true)
      yield* guard.admitHarnessRoleForPositions({ id: RoleId.make(harnessRole), botId: harness })
      expect(Exit.isFailure(yield* Effect.exit(guard.admitAutoModRule({ id: otherRule, name: "Block Mention Spam" })))).toBe(true)
      yield* guard.admitAutoModRule({ id: labRule, name: "lab-keyword" })
      expect(Exit.isSuccess(yield* Effect.exit(guard.check(HttpClientRequest.delete(api(`/guilds/${guild}/auto-moderation/rules/${labRule}`)))))).toBe(true)
    })
  )

  it.effect("reads JSON request bodies as dfx and the raw helper send them", () =>
    Effect.gen(function* () {
      const guard = yield* make(guild)
      yield* guard.arm({ harnessUserId: harness, subjectUserId: subject, targetUserId: target, protectedChannels: new Set([rules]) })
      const edit = (body: unknown) => HttpClientRequest.bodyJson(HttpClientRequest.patch(api(`/guilds/${guild}/members/${target}`)), body).pipe(Effect.orDie)
      expect(Exit.isSuccess(yield* Effect.exit(guard.check(yield* edit({ nick: null }))))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.check(yield* edit({ roles: [foreignRole] }))))).toBe(true)
      const create = (body: unknown) => HttpClientRequest.bodyJson(HttpClientRequest.post(api(`/guilds/${guild}/channels`)), body).pipe(Effect.orDie)
      expect(Exit.isSuccess(yield* Effect.exit(guard.check(yield* create({ name: "lab-text", type: 0 }))))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.check(yield* create({ name: "general", type: 0 }))))).toBe(true)
    })
  )
})
