import * as CommandBudget from "../../harness/CommandBudget.ts"
import { describe, expect, it } from "@effect/vitest"
import { ApplicationFlags } from "discord-api-types/v10"
import { Effect, Exit, Option } from "effect"
import * as Headers from "effect/http/Headers"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import { compose, TargetRest } from "../../harness/Identities.ts"
import * as IdentityCheck from "../../harness/IdentityCheck.ts"
import { LabCheckFailed, LabGuard } from "../../harness/Lab.ts"
import { ChannelId } from "../../src/Snowflake.ts"
import { type Answer, fakeCredentials, fakeGuildCreate, fakeGuildId, makeRecordingClient } from "../support/fakeDiscord.ts"
import { makeFakeGateway } from "../support/fakeGateway.ts"

/**
 * The harness identity checks (DESIGN §4.4), run over the real wiring (`compose`) with a recording fake that
 * answers per token. Each check is made to fail in turn: the command fails with `LabCheckFailed`, and the
 * guard stays unarmed, so the next write is refused before it is sent. When every check passes, the guard is
 * armed with the protected channels, including the guild's rules channel whatever its name.
 */
type Identity = "harness" | "subject" | "target"

const identityOf = (request: HttpClientRequest.HttpClientRequest): Identity | undefined => {
  switch (Option.getOrUndefined(Headers.get(request.headers, "authorization"))) {
    case "Bot fake-harness-token":
      return "harness"
    case "Bot fake-subject-token":
      return "subject"
    case "Bot fake-target-token":
      return "target"
    default:
      return undefined
  }
}

interface World {
  readonly users: Readonly<Record<Identity, string>>
  readonly apps: Readonly<Record<Identity, string>>
  readonly guildName: string
  readonly channels: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly roles: ReadonlyArray<{ readonly id: string; readonly name: string; readonly position: number }>
  /** The user the subject's gateway READY names (its token's user unless a case breaks it). */
  readonly readyUser?: string
}

const harnessRole = "400000000000000050"
const rulesChannel = "300000000000000098"
const modUpdates = "300000000000000097"
/** The guild's rules channel: a lab name, but protected because the guild names it. */
const welcome = ChannelId.make("300000000000000096")
const labText = ChannelId.make("300000000000000001")

const baseline: World = {
  users: { harness: "200000000000000000", subject: "200000000000000001", target: "200000000000000002" },
  // the application IDs `fakeCredentials` expects
  apps: { harness: "100000000000000001", subject: "100000000000000002", target: "100000000000000003" },
  guildName: "Perms Lab",
  channels: [
    { id: rulesChannel, name: "rules" },
    { id: modUpdates, name: "mod-updates" },
    { id: welcome, name: "lab-welcome" },
    { id: labText, name: "lab-text" }
  ],
  roles: [
    { id: fakeGuildId, name: "@everyone", position: 0 },
    { id: "400000000000000001", name: "lab-high", position: 1 },
    { id: harnessRole, name: "Perms Harness", position: 2 }
  ]
}

const flags = ApplicationFlags.GatewayGuildMembers | ApplicationFlags.GatewayMessageContent

const respond =
  (world: World) =>
  (request: HttpClientRequest.HttpClientRequest): Answer => {
    const identity = identityOf(request)
    if (identity === undefined) return { status: 401, body: { message: "401: Unauthorized", code: 0 } }
    const path = new URL(request.url).pathname.replace(/^\/api\/v\d+/, "")
    const guild = `/guilds/${fakeGuildId}`
    if (path === "/users/@me") return { status: 200, body: { id: world.users[identity], username: `Perms ${identity}` } }
    if (path === "/applications/@me") return { status: 200, body: { id: world.apps[identity], flags } }
    if (path === `${guild}/members/${world.users[identity]}`) return { status: 200, body: { roles: identity === "harness" ? [harnessRole] : [] } }
    if (path === guild) {
      return {
        status: 200,
        body: { id: fakeGuildId, name: world.guildName, owner_id: "200000000000000099", mfa_level: 0, rules_channel_id: welcome, public_updates_channel_id: modUpdates, features: [] }
      }
    }
    if (path === `${guild}/channels`) return { status: 200, body: world.channels.map((channel) => ({ ...channel, type: 0 })) }
    if (path === `${guild}/roles`) {
      return { status: 200, body: world.roles.map((role) => ({ ...role, permissions: "0", managed: role.id === harnessRole, mentionable: false })) }
    }
    if (request.method === "POST" && path === `/channels/${labText}/messages`) {
      return { status: 200, body: { id: "600000000000000001", channel_id: labText, content: "x", author: { id: world.users[identity] } } }
    }
    return { status: 404, body: { message: "Unknown", code: 10000 } }
  }

/** Runs the identity checks over `world`, then tries a write to `lab-text` as the target. */
const attempt = (world: World, admitLabText: boolean) =>
  Effect.gen(function* () {
    const client = yield* makeRecordingClient(respond(world))
    const gateway = yield* makeFakeGateway({ userFor: (token) => (token === "fake-subject-token" ? (world.readyUser ?? world.users.subject) : undefined), guildsFor: (user) => [fakeGuildCreate(user)] }, () => 0)
    return yield* Effect.gen(function* () {
      const checked = yield* Effect.exit(IdentityCheck.run)
      const guard = yield* LabGuard
      const admitted = admitLabText ? yield* Effect.exit(guard.admitChannel({ id: labText, name: "lab-text" })) : undefined
      const welcomeAdmitted = yield* Effect.exit(guard.admitChannel({ id: welcome, name: "lab-welcome" }))
      const sentBefore = (yield* client.recorded).length
      const write = yield* Effect.exit((yield* TargetRest).createMessage(labText, { content: "after the identity checks" }))
      const writeSent = (yield* client.recorded).length > sentBefore
      return { checked, admitted, welcomeAdmitted, write, writeSent }
    }).pipe(Effect.provide(compose(client.layer, gateway.layer, fakeCredentials, { requestsPerSecond: 5, invalidCap: 1500 }, CommandBudget.layerMemory())))
  })

const failedCheck = <A, E>(exit: Exit.Exit<A, E>): LabCheckFailed | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const reason = exit.cause.reasons[0]
  return reason?._tag === "Fail" && reason.error instanceof LabCheckFailed ? reason.error : undefined
}

describe.concurrent("harness identity checks", () => {
  it.live("pass, report the protected channels and arm the guard", () =>
    Effect.gen(function* () {
      const result = yield* attempt(baseline, true)
      expect(Exit.isSuccess(result.checked)).toBe(true)
      if (Exit.isSuccess(result.checked)) {
        const report = result.checked.value
        expect(report.protectedChannels.map((channel) => channel.name)).toEqual(["rules", "mod-updates", "lab-welcome"])
        expect(report.harnessTopRole.id).toBe(harnessRole)
        expect([report.harness.userId, report.subject.userId, report.target.userId]).toEqual([baseline.users.harness, baseline.users.subject, baseline.users.target])
      }
      // the guild's rules channel is never admitted, even with a lab name
      expect(Exit.isFailure(result.welcomeAdmitted)).toBe(true)
      expect(result.admitted !== undefined && Exit.isSuccess(result.admitted)).toBe(true)
      expect(Exit.isSuccess(result.write)).toBe(true)
      expect(result.writeSent).toBe(true)
    })
  )

  const failures: ReadonlyArray<readonly [what: string, world: World, check: string, detail: string]> = [
    ["a token of another application", { ...baseline, apps: { ...baseline.apps, target: "100000000000000009" } }, "identity", "the target token belongs to application 100000000000000009"],
    ["two tokens of the same bot", { ...baseline, users: { ...baseline.users, subject: baseline.users.harness } }, "identity", "not three distinct bots"],
    ["a subject gateway READY for another user", { ...baseline, readyUser: "200000000000000055" }, "identity", "READY named 200000000000000055"],
    ["a guild with another name", { ...baseline, guildName: "Rhys's server" }, "guild", `names "Rhys's server", not "Perms Lab"`],
    ["a guild without #rules", { ...baseline, channels: baseline.channels.filter((channel) => channel.name !== "rules") }, "guild", "has no #rules"],
    ["a guild without #mod-updates", { ...baseline, channels: baseline.channels.filter((channel) => channel.name !== "mod-updates") }, "guild", "has no #mod-updates"],
    [
      "a role above the harness's",
      { ...baseline, roles: [...baseline.roles, { id: "400000000000000060", name: "Moderators", position: 3 }] },
      "harness role",
      "the highest is Moderators"
    ]
  ]

  // One test, the cases concurrently: each pays the pacing bucket's 200 ms per request, about 2 s in all.
  it.live("fail on each broken check, and leave the guard unarmed", () =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(failures, ([, world]) => attempt(world, false), { concurrency: "unbounded" })
      failures.forEach(([what, , check, detail], index) => {
        const result = results[index]
        if (result === undefined) throw new Error(`no result for ${what}`)
        expect(failedCheck(result.checked)?.check, what).toBe(check)
        expect(failedCheck(result.checked)?.detail, what).toContain(detail)
        // nothing was armed: admission dies, and the write is refused before it is sent
        expect(Exit.isFailure(result.welcomeAdmitted), what).toBe(true)
        expect(String(result.welcomeAdmitted), what).toContain("admission before the identity checks")
        expect(Exit.isFailure(result.write) && !Exit.hasFails(result.write), what).toBe(true)
        expect(String(result.write), what).toContain("no writes before the identity checks arm the guard")
        expect(result.writeSent, what).toBe(false)
      })
    })
  )
})
