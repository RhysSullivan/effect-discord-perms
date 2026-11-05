import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Option } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { formBody, type GuardState, kickBanPredictedToFail, kickBanRoute, labStep, labStepDeadline, make, noBody, type RequestBody, textBody, verdict } from "../../harness/Lab.ts"
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
  autoModRules: new Set([labRule]),
  kickBanPermits: new Set()
}
const api = (path: string) => `https://discord.com/api/v10${path}`
const decide = (method: string, path: string, body?: string | RequestBody, state: GuardState = armed) =>
  verdict(state, method, api(path), body === undefined ? noBody : typeof body === "string" ? textBody(body) : body)._tag
const form = (fields: Record<string, string>): RequestBody => formBody(new Map(Object.entries(fields)))
const json = (value: unknown): string => JSON.stringify(value)

describe("the guard's verdict", () => {
  it("allows reads, but never of another guild", () => {
    expect(decide("GET", "/users/@me")).toBe("Allow")
    expect(decide("GET", `/channels/${elsewhere}`)).toBe("Allow")
    expect(decide("GET", `/guilds/${guild}/channels`)).toBe("Allow")
    expect(decide("GET", `/guilds/${otherGuild}`)).toBe("Refuse")
    expect(decide("GET", `/applications/1/guilds/${otherGuild}/commands`)).toBe("Refuse")
  })

  it("allows an interaction's callback and the subject application's interaction webhook only (M9, the checklist)", () => {
    const subjectApp = "100000000000000002"
    const withApp: GuardState = { ...armed, armed: Option.map(armed.armed, (value) => ({ ...value, subjectApplicationId: subjectApp })) }
    expect(decide("POST", "/interactions/900000000000000001/token/callback", undefined, withApp)).toBe("Allow")
    expect(decide("PATCH", "/interactions/900000000000000001/token/callback", undefined, withApp)).toBe("Refuse")
    expect(decide("POST", "/interactions/900000000000000001/token", undefined, withApp)).toBe("Refuse")
    expect(decide("POST", `/webhooks/${subjectApp}/token`, undefined, withApp)).toBe("Allow")
    expect(decide("PATCH", `/webhooks/${subjectApp}/token/messages/@original`, undefined, withApp)).toBe("Allow")
    expect(decide("DELETE", `/webhooks/${subjectApp}/token/messages/@original`, undefined, withApp)).toBe("Allow")
    // another application's webhook, another message, the webhook itself, or no application armed: refused
    expect(decide("POST", "/webhooks/100000000000000003/token", undefined, withApp)).toBe("Refuse")
    expect(decide("PATCH", `/webhooks/${subjectApp}/token/messages/500000000000000001`, undefined, withApp)).toBe("Refuse")
    expect(decide("DELETE", `/webhooks/${subjectApp}/token`, undefined, withApp)).toBe("Refuse")
    expect(decide("POST", `/webhooks/${subjectApp}/token`)).toBe("Refuse")
    expect(decide("POST", "/interactions/900000000000000001/token/callback")).toBe("Refuse")
  })

  it("refuses every write before it is armed", () => {
    const unarmed: GuardState = { ...armed, armed: Option.none() }
    expect(decide("POST", `/channels/${labChannel}/messages`, undefined, unarmed)).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/roles/${guild}`, undefined, unarmed)).toBe("Refuse")
  })

  it("allows writes to admitted lab channels only, never to protected or other channels", () => {
    expect(decide("POST", `/channels/${labChannel}/messages`)).toBe("Allow")
    expect(decide("PATCH", `/channels/${labChannel}`, json({ rate_limit_per_user: 0 }))).toBe("Allow")
    expect(decide("DELETE", `/channels/${labChannel}/messages/1`)).toBe("Allow")
    expect(decide("POST", `/channels/${elsewhere}/messages`)).toBe("Refuse")
    expect(decide("POST", `/channels/${rules}/messages`)).toBe("Refuse")
    expect(decide("POST", `/channels/${labChannel}/webhooks`)).toBe("Refuse")
    expect(decide("POST", `/channels/${labChannel}/invites`)).toBe("Refuse")
    expect(decide("POST", `/channels/${labChannel}/followers`)).toBe("Refuse")
  })

  it("admits a message create aimed at a bot's user ID, which names no channel (R-ids-distinct), and nothing else there or at a human's ID", () => {
    expect(decide("POST", `/channels/${target}/messages`)).toBe("Allow")
    expect(decide("POST", `/channels/${subject}/messages`)).toBe("Allow")
    expect(decide("POST", `/channels/${rhys}/messages`)).toBe("Refuse")
    expect(decide("POST", `/channels/${harness}/messages`)).toBe("Refuse")
    expect(decide("PATCH", `/channels/${target}`, json({ name: "lab-x" }))).toBe("Refuse")
    expect(decide("POST", `/channels/${target}/messages/1/crosspost`)).toBe("Refuse")
    expect(decide("POST", `/channels/${target}/messages`, undefined, { ...armed, armed: Option.none() })).toBe("Refuse")
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

  it("creates only lab-named threads and forum posts", () => {
    expect(decide("POST", `/channels/${labChannel}/threads`, json({ name: "lab-scenario-thread", type: 11 }))).toBe("Allow")
    expect(decide("POST", `/channels/${labChannel}/threads`, json({ name: "lab-post", message: { content: "x" } }))).toBe("Allow")
    expect(decide("POST", `/channels/${labChannel}/messages/1/threads`, json({ name: "lab-from-message" }))).toBe("Allow")
    expect(decide("POST", `/channels/${labChannel}/threads`, json({ name: "general-chat", type: 11 }))).toBe("Refuse")
    expect(decide("POST", `/channels/${labChannel}/messages/1/threads`, json({ name: "Thread" }))).toBe("Refuse")
    expect(decide("POST", `/channels/${labChannel}/threads`)).toBe("Refuse")
    expect(decide("POST", `/channels/${labChannel}/threads`, form({ name: "lab-post" }))).toBe("Refuse")
    expect(decide("PATCH", `/channels/${labChannel}/threads`, json({ name: "lab-post" }))).toBe("Refuse")
    expect(decide("POST", `/channels/${elsewhere}/threads`, json({ name: "lab-post" }))).toBe("Refuse")
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
    expect(decide("PUT", `/channels/${labChannel}/permissions/${labRole}/x`)).toBe("Refuse")
    expect(decide("PUT", `/channels/${labChannel}/permissions`)).toBe("Refuse")
  })

  it("reads a channel PATCH: overwrites only for lab roles, @everyone and the bots; parents only in the lab", () => {
    const overwrite = (id: string) => ({ id, type: 0, allow: "1024", deny: "0" })
    expect(decide("PATCH", `/channels/${labChannel}`, json({ permission_overwrites: [overwrite(labRole), overwrite(guild), overwrite(subject), overwrite(target)] }))).toBe("Allow")
    expect(decide("PATCH", `/channels/${labChannel}`, json({ archived: false, locked: false }))).toBe("Allow")
    expect(decide("PATCH", `/channels/${labChannel}`, json({ parent_id: labChannel }))).toBe("Allow")
    expect(decide("PATCH", `/channels/${labChannel}`, json({ parent_id: null }))).toBe("Allow")
    expect(decide("PATCH", `/channels/${labChannel}`, json({ permission_overwrites: [overwrite(labRole), overwrite(rhys)] }))).toBe("Refuse")
    expect(decide("PATCH", `/channels/${labChannel}`, json({ permission_overwrites: [overwrite(foreignRole)] }))).toBe("Refuse")
    expect(decide("PATCH", `/channels/${labChannel}`, json({ parent_id: elsewhere }))).toBe("Refuse")
    expect(decide("PATCH", `/channels/${labChannel}`, json({ parent_id: rules }))).toBe("Refuse")
    expect(decide("PATCH", `/channels/${labChannel}`)).toBe("Refuse")
    expect(decide("PATCH", `/channels/${labChannel}`, "not json")).toBe("Refuse")
    // a rename keeps a lab name
    expect(decide("PATCH", `/channels/${labChannel}`, json({ name: "lab-text-b" }))).toBe("Allow")
    expect(decide("PATCH", `/channels/${labChannel}`, json({ name: "general" }))).toBe("Refuse")
  })

  it("creates only lab_ emoji, and never edits or deletes one", () => {
    expect(decide("POST", `/guilds/${guild}/emojis`, json({ name: "lab_emoji", image: "data:image/png;base64,AA==" }))).toBe("Allow")
    expect(decide("POST", `/guilds/${guild}/emojis`, json({ name: "wave", image: "data:image/png;base64,AA==" }))).toBe("Refuse")
    expect(decide("POST", `/guilds/${guild}/emojis`)).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/emojis/1`, json({ name: "lab_emoji" }))).toBe("Refuse")
    expect(decide("DELETE", `/guilds/${guild}/emojis/1`)).toBe("Refuse")
  })

  it("refuses kick and ban without a permit, allows exactly the permitted route on the target, and refuses member edits of anyone but the two bots", () => {
    expect(decide("DELETE", `/guilds/${guild}/members/${target}`)).toBe("Refuse")
    expect(decide("PUT", `/guilds/${guild}/bans/${target}`)).toBe("Refuse")
    expect(decide("DELETE", `/guilds/${guild}/bans/${target}`)).toBe("Refuse")
    expect(decide("POST", `/guilds/${guild}/bulk-ban`)).toBe("Refuse")
    const permitted: GuardState = { ...armed, kickBanPermits: new Set([kickBanRoute("kick", guild, target), kickBanRoute("ban", guild, target)]) }
    expect(decide("DELETE", `/guilds/${guild}/members/${target}`, undefined, permitted)).toBe("Allow")
    expect(decide("PUT", `/guilds/${guild}/bans/${target}`, json({ delete_message_seconds: 0 }), permitted)).toBe("Allow")
    // the permit names the target's route: the harness, the subject and Rhys are never kicked or banned
    for (const user of [harness, subject, rhys]) {
      expect(decide("DELETE", `/guilds/${guild}/members/${user}`, undefined, { ...permitted, kickBanPermits: new Set([`DELETE /guilds/${guild}/members/${user}`]) })).toBe("Refuse")
      expect(decide("PUT", `/guilds/${guild}/bans/${user}`, undefined, { ...permitted, kickBanPermits: new Set([`PUT /guilds/${guild}/bans/${user}`]) })).toBe("Refuse")
    }
    expect(decide("DELETE", `/guilds/${guild}/bans/${target}`, undefined, permitted)).toBe("Refuse")
    expect(decide("POST", `/guilds/${guild}/bulk-ban`, json({ user_ids: [target] }), permitted)).toBe("Refuse")
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

  it("creates only lab-named stickers, as a form, and never edits or deletes one", () => {
    expect(decide("POST", `/guilds/${guild}/stickers`, form({ name: "lab-sticker", tags: "lab" }))).toBe("Allow")
    expect(decide("POST", `/guilds/${guild}/stickers`, form({ name: "wave", tags: "lab" }))).toBe("Refuse")
    expect(decide("POST", `/guilds/${guild}/stickers`, form({ tags: "lab" }))).toBe("Refuse")
    expect(decide("POST", `/guilds/${guild}/stickers`, json({ name: "lab-sticker" }))).toBe("Refuse")
    expect(decide("POST", `/guilds/${guild}/stickers`)).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/stickers/1`, form({ name: "lab-sticker" }))).toBe("Refuse")
    expect(decide("PATCH", `/guilds/${guild}/stickers/1`, json({ name: "lab-sticker" }))).toBe("Refuse")
    expect(decide("DELETE", `/guilds/${guild}/stickers/1`)).toBe("Refuse")
  })

  it("refuses guild edits, DMs, leaving the guild, global commands and other hosts", () => {
    expect(decide("PATCH", `/guilds/${guild}`)).toBe("Refuse")
    expect(decide("POST", `/guilds/${otherGuild}/channels`)).toBe("Refuse")
    expect(decide("POST", "/users/@me/channels")).toBe("Refuse")
    expect(decide("DELETE", `/users/@me/guilds/${guild}`)).toBe("Refuse")
    expect(decide("PUT", "/applications/1/commands")).toBe("Refuse")
    expect(decide("PUT", `/applications/1/guilds/${guild}/commands`)).toBe("Allow")
    expect(decide("POST", `/interactions/1/token/callback`)).toBe("Refuse")
    expect(verdict(armed, "GET", "https://example.com/api/v10/users/@me", noBody)._tag).toBe("Refuse")
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

  it.effect("says a channel is a lab channel only once armed and admitted, never a protected or unknown one (the checklist's interactions, M9 verifier)", () =>
    Effect.gen(function* () {
      const guard = yield* make(guild)
      expect(yield* guard.isLabChannel(labChannel)).toBe(false)
      yield* guard.arm({ harnessUserId: harness, subjectUserId: subject, targetUserId: target, protectedChannels: new Set([rules]) })
      expect(yield* guard.isLabChannel(labChannel)).toBe(false)
      yield* guard.admitChannel({ id: labChannel, name: "lab-text" })
      expect(yield* guard.isLabChannel(labChannel)).toBe(true)
      expect(yield* guard.isLabChannel(rules)).toBe(false)
      expect(yield* guard.isLabChannel(elsewhere)).toBe(false)
    })
  )

  it.effect("issues a one-shot kick or ban permit only when the docs model predicts failure from the harness's reads (§5.6)", () =>
    Effect.gen(function* () {
      const guard = yield* make(guild)
      yield* guard.arm({ harnessUserId: harness, subjectUserId: subject, targetUserId: target, protectedChannels: new Set([rules]) })
      const roles = [
        { id: guild, permissions: "0", position: 0 },
        { id: "400000000000000010", permissions: String(1n << 1n), position: 9 },
        { id: "400000000000000011", permissions: "0", position: 10 }
      ]
      const kick = HttpClientRequest.delete(api(`/guilds/${guild}/members/${target}`))
      // the subject holds KickMembers and outranks the target: a kick could succeed, so no permit
      const succeeds = { guildId: guild, roles, subject: { roles: ["400000000000000010"] }, target: { roles: [] } }
      expect(kickBanPredictedToFail("kick", succeeds)).toBe(false)
      expect(Exit.isFailure(yield* Effect.exit(guard.permitKickOrBan("kick", succeeds)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.check(kick)))).toBe(true)
      // the target ranks above: the kick must fail, so one permit, used once
      const above = { ...succeeds, target: { roles: ["400000000000000011"] } }
      expect(kickBanPredictedToFail("kick", above)).toBe(true)
      yield* guard.permitKickOrBan("kick", above)
      expect(Exit.isSuccess(yield* Effect.exit(guard.check(kick)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.check(kick)))).toBe(true)
      // without the flag (and without Administrator) the ban must fail
      expect(kickBanPredictedToFail("ban", succeeds)).toBe(true)
      const admin = roles.map((role) => (role.id === "400000000000000010" ? { ...role, permissions: "8" } : role))
      expect(kickBanPredictedToFail("ban", { ...succeeds, roles: admin })).toBe(false)
      // equal positions break on the ID: the lower ID ranks higher (P role object)
      const tied = [...roles, { id: "400000000000000012", permissions: "0", position: 9 }]
      expect(kickBanPredictedToFail("kick", { ...succeeds, roles: tied, target: { roles: ["400000000000000012"] } })).toBe(false)
      expect(kickBanPredictedToFail("kick", { ...succeeds, roles: [...roles, { id: "400000000000000009", permissions: "0", position: 9 }], target: { roles: ["400000000000000009"] } })).toBe(true)
      // a member's highest role among equal positions is the lower ID, whatever the order it lists them in
      const three = [
        { id: guild, permissions: "0", position: 0 },
        { id: "400000000000000010", permissions: String(1n << 1n), position: 9 },
        { id: "400000000000000011", permissions: "0", position: 9 },
        { id: "400000000000000012", permissions: "0", position: 9 }
      ]
      expect(kickBanPredictedToFail("kick", { guildId: guild, roles: three, subject: { roles: ["400000000000000012", "400000000000000010"] }, target: { roles: ["400000000000000011"] } })).toBe(false)
      // equal rank fails; @everyone counts for a member with no roles
      expect(kickBanPredictedToFail("kick", { ...succeeds, target: { roles: ["400000000000000010"] } })).toBe(true)
      expect(kickBanPredictedToFail("kick", { ...succeeds, subject: { roles: [] }, roles: [{ id: guild, permissions: String(1n << 1n), position: 0 }] })).toBe(true)
      // a prediction for another guild is refused
      expect(Exit.isFailure(yield* Effect.exit(guard.permitKickOrBan("kick", { ...above, guildId: GuildId.make("100000000000000077") })))).toBe(true)
    })
  )

  it.effect("judges a dry run's request as the live one, a kick or ban of the target as if permitted, and uses or issues no permit", () =>
    Effect.gen(function* () {
      const guard = yield* make(guild)
      const kick = HttpClientRequest.delete(api(`/guilds/${guild}/members/${target}`))
      const ban = HttpClientRequest.put(api(`/guilds/${guild}/bans/${target}`))
      const write = HttpClientRequest.post(api(`/channels/${labChannel}/messages`))
      // before arming, a dry write is refused like a live one
      expect(Exit.isFailure(yield* Effect.exit(guard.checkDry(write)))).toBe(true)
      yield* guard.arm({ harnessUserId: harness, subjectUserId: subject, targetUserId: target, protectedChannels: new Set([rules]) })
      yield* guard.admitChannel({ id: labChannel, name: "lab-text" })
      expect(Exit.isSuccess(yield* Effect.exit(guard.checkDry(write)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.checkDry(HttpClientRequest.post(api(`/channels/${elsewhere}/messages`)))))).toBe(true)
      expect(Exit.isSuccess(yield* Effect.exit(guard.checkDry(kick)))).toBe(true)
      expect(Exit.isSuccess(yield* Effect.exit(guard.checkDry(ban)))).toBe(true)
      // never the harness, a human or another guild's member, dry or not
      expect(Exit.isFailure(yield* Effect.exit(guard.checkDry(HttpClientRequest.delete(api(`/guilds/${guild}/members/${harness}`)))))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.checkDry(HttpClientRequest.put(api(`/guilds/${guild}/bans/${rhys}`)))))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.checkDry(HttpClientRequest.delete(api(`/guilds/${otherGuild}/members/${target}`)))))).toBe(true)
      // the dry checks left no permit behind: the live kick and ban are still refused
      expect(Exit.isFailure(yield* Effect.exit(guard.check(kick)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.check(ban)))).toBe(true)
      // and a permit the live call needs is not used up by a dry check
      const roles = [
        { id: guild, permissions: "0", position: 0 },
        { id: "400000000000000011", permissions: "0", position: 10 }
      ]
      yield* guard.permitKickOrBan("kick", { guildId: guild, roles, subject: { roles: [] }, target: { roles: ["400000000000000011"] } })
      expect(Exit.isSuccess(yield* Effect.exit(guard.checkDry(kick)))).toBe(true)
      expect(Exit.isSuccess(yield* Effect.exit(guard.check(kick)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.check(kick)))).toBe(true)
    })
  )

  it.effect("bounds a lab step: a call that never answers (dfx waiting out a long 429) fails with status 0, naming the step", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.never.pipe(labStep("converge: get the subject"), Effect.flip, Effect.forkChild)
      yield* TestClock.adjust(labStepDeadline)
      const failure = yield* Fiber.join(fiber)
      expect(failure).toMatchObject({ _tag: "LabRequestFailed", step: "converge: get the subject", status: 0, code: 0 })
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
      const sticker = (name: string) => {
        const formData = new FormData()
        formData.set("name", name)
        formData.set("tags", "lab")
        formData.set("file", new File([new Uint8Array([1, 2, 3])], "lab.png", { type: "image/png" }))
        return HttpClientRequest.bodyFormData(HttpClientRequest.post(api(`/guilds/${guild}/stickers`)), formData)
      }
      expect(Exit.isSuccess(yield* Effect.exit(guard.check(sticker("lab-sticker"))))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(guard.check(sticker("wave"))))).toBe(true)
    })
  )
})
