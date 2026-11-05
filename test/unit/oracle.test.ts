import { BunFileSystem } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { onTestFinished } from "vitest"
import { Duration, Effect, Exit, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { DiscordREST } from "dfx/DiscordREST"
import { HarnessRest } from "../../harness/Identities.ts"
import { LabCheckFailed } from "../../harness/Lab.ts"
import * as LabIds from "../../harness/LabIds.ts"
import { DiscordResponse } from "../../src/errors/Cause.ts"
import { availabilityOf, checkOracle, type OracleResult, oracleProblems, oracleReads, oracleTargets } from "../../harness/Smoke.ts"
import { memberPermissions, OracleFailed, route } from "../../src/rest/Oracle.ts"
import type * as Reset from "../../harness/Reset.ts"
import { ApplicationId, ChannelId, GuildId, UserId } from "../../src/Snowflake.ts"
import { json, type Scripted, scriptedRest } from "../support/fakeDiscord.ts"

/** The permission oracle (DESIGN §5.10 step 8) and the lab-state file (§5.7). */
const channel = ChannelId.make("300000000000000001")
const user = UserId.make("200000000000000001")

/** Answers only the oracle route with `implicit=false` (H-240); anything else is a 500 the oracle reports. */
const read = (answer: Scripted) =>
  Effect.gen(function* () {
    const rest = yield* DiscordREST
    return yield* memberPermissions(rest, channel, user, Duration.seconds(30))
  }).pipe(
    Effect.provide(
      scriptedRest((method, requestPath, query) =>
        method === "GET" && requestPath === `/channels/${channel}/permissions/member/${user}` && query.getAll("implicit").join() === "false" ? answer : json(500, {})
      )
    ),
    Effect.exit
  )

describe("the permission oracle", () => {
  it.effect("reads the stringified bitfield", () =>
    Effect.gen(function* () {
      expect(yield* read(json(200, { permissions: "1024" }))).toEqual(Exit.succeed({ _tag: "Permissions", permissions: 1024n }))
    })
  )

  it.effect("is unavailable on a 404 without a code, or a 405", () =>
    Effect.gen(function* () {
      expect(yield* read(json(404, { message: "404: Not Found", code: 0 }))).toEqual(Exit.succeed({ _tag: "Unavailable", status: 404 }))
      expect(yield* read(json(405, { message: "405: Method Not Allowed", code: 0 }))).toEqual(Exit.succeed({ _tag: "Unavailable", status: 405 }))
    })
  )

  it.effect("fails with the Discord response for a coded error, and dies on a malformed 2xx", () =>
    Effect.gen(function* () {
      expect(yield* read(json(404, { message: "Unknown Channel", code: 10003 }))).toEqual(
        Exit.fail(
          new OracleFailed({
            cause: new DiscordResponse({ status: 404, code: 10003, message: "Unknown Channel", method: "GET", route, fieldErrors: [], attributedBy: "code" })
          })
        )
      )
      const malformed = yield* read(json(200, { permissions: 1024 }))
      expect(Exit.isFailure(malformed) && !Exit.hasFails(malformed)).toBe(true)
    })
  )
})

describe("the lab state file", () => {
  const guild = GuildId.make("100000000000000000")
  /** A fresh temporary file path, its directory removed when the current test finishes. */
  const temp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edp-state-"))
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
    return path.join(dir, "state.json")
  }

  it.effect("is empty when missing, round-trips, and refuses another guild's file", () =>
    Effect.gen(function* () {
      const file = temp()
      expect(yield* LabIds.load(guild, file)).toEqual(LabIds.empty(guild))
      const state: LabIds.LabState = { ...LabIds.empty(guild), channels: { "lab-text": channel }, unavailable: { "lab-media": { status: 400, code: 50024 } } }
      yield* LabIds.save(state, file)
      expect(yield* LabIds.load(guild, file)).toEqual(state)
      const other = yield* Effect.exit(LabIds.load(GuildId.make("100000000000000001"), file))
      expect(Exit.isFailure(other)).toBe(true)
      fs.writeFileSync(file, "{}")
      expect(Exit.isFailure(yield* Effect.exit(LabIds.load(guild, file)))).toBe(true)
    }).pipe(Effect.provide(BunFileSystem.layer))
  )
})

describe("smoke's judgment of the oracle", () => {
  const allow = LabIds.targetOverwriteAllow
  const result = (reads: ReadonlyArray<bigint | undefined>, control: bigint | undefined): OracleResult => ({
    availability: availabilityOf([...reads, control]),
    reads: reads.map((permissions, index) => ({ channel: `lab-${index}`, permissions })),
    control: { permissions: control, expected: allow }
  })

  it("counts availability over every read and the control", () => {
    expect(availabilityOf([0n, 1024n])).toBe("available")
    expect(availabilityOf([undefined, undefined])).toBe("unavailable")
    expect(availabilityOf([0n, undefined])).toBe("mixed")
  })

  it.effect("passes an available oracle at baseline, and records an unavailable one without failing", () =>
    Effect.gen(function* () {
      expect(oracleProblems(result([0n, 0n], allow))).toEqual([])
      expect(oracleProblems(result([undefined, undefined], undefined))).toEqual([])
      yield* checkOracle(result([0n, 0n], allow))
    })
  )

  it.effect("fails when the control differs, the subject holds a flag at baseline, or availability is mixed", () =>
    Effect.gen(function* () {
      expect(oracleProblems(result([0n], allow | 8192n))).toHaveLength(1)
      expect(oracleProblems(result([0n], 0n))).toHaveLength(1)
      expect(oracleProblems(result([0n, 1024n], allow))).toEqual(["the subject has ViewChannel in lab-1 at baseline"])
      expect(oracleProblems(result([0n, undefined], allow))).toEqual(["the oracle answered some reads and not others: unavailable in lab-1"])
      expect(oracleProblems(result([0n], undefined))).toEqual(["the oracle answered some reads and not others: unavailable in the control"])
      const exit = yield* Effect.exit(checkOracle(result([0n], 0n)))
      expect(Exit.isFailure(exit) && Exit.hasFails(exit)).toBe(true)
      expect(exit).toEqual(Exit.fail(new LabCheckFailed({ check: "oracle", detail: oracleProblems(result([0n], 0n)).join("; ") })))
    })
  )
})

describe("smoke's oracle reads", () => {
  const guildId = GuildId.make("100000000000000000")
  const subject = UserId.make("200000000000000001")
  const target = UserId.make("200000000000000002")
  const names = [...LabIds.channelSpecs.map((spec) => spec.name), ...LabIds.threadSpecs.map((spec) => spec.name)]
  const ids = Object.fromEntries(names.map((name, index) => [name, ChannelId.make(`3000000000000000${String(index).padStart(2, "0")}`)]))
  const { "lab-media": _media, ...withoutMedia } = ids
  const provisioned: LabIds.LabState = { ...LabIds.empty(guildId), channels: withoutMedia, unavailable: { "lab-media": { status: 400, code: 50024 } } }
  const context: Reset.Context = { guildId, harnessUserId: UserId.make("200000000000000000"), subjectUserId: subject, targetUserId: target, subjectApplicationId: ApplicationId.make("100000000000000002") }

  it.effect("read every lab channel and thread but the category and an unavailable kind", () =>
    Effect.gen(function* () {
      const { targets, control } = yield* oracleTargets(provisioned)
      expect(targets.map((entry) => entry.name)).toEqual(names.filter((name) => name !== "lab" && name !== "lab-media"))
      expect(control).toBe(ids["lab-text"])
    })
  )

  it.effect("fail when a channel or thread that is not unavailable has no stored ID", () =>
    Effect.gen(function* () {
      const { "lab-private-thread": _thread, ...withoutThread } = withoutMedia
      expect(yield* Effect.exit(oracleTargets({ ...provisioned, channels: withoutThread }))).toEqual(
        Exit.fail(new LabCheckFailed({ check: "oracle", detail: "not provisioned, so smoke cannot read them: lab-private-thread" }))
      )
      const { unavailable: _unavailable, ...mediaForgotten } = provisioned
      expect(yield* Effect.exit(oracleTargets(mediaForgotten))).toEqual(
        Exit.fail(new LabCheckFailed({ check: "oracle", detail: "not provisioned, so smoke cannot read them: lab-media" }))
      )
      expect(Exit.isFailure(yield* Effect.exit(oracleTargets(LabIds.empty(guildId))))).toBe(true)
      const { "lab-text": _text, ...withoutText } = withoutMedia
      expect(yield* Effect.exit(oracleTargets({ ...provisioned, channels: withoutText, unavailable: { ...provisioned.unavailable, "lab-text": { status: 400, code: 50024 } } }))).toEqual(
        Exit.fail(new LabCheckFailed({ check: "oracle", detail: "not provisioned, so smoke cannot read them: lab-text (the control)" }))
      )
    })
  )

  it.effect("read the subject in each, and the target in lab-text for the control", () =>
    Effect.gen(function* () {
      const asked: Array<string> = []
      const rest = scriptedRest((method, requestPath, query) => {
        const match = /^\/channels\/(\d+)\/permissions\/member\/(\d+)$/.exec(requestPath)
        if (method !== "GET" || match === null || query.get("implicit") !== "false") return json(500, {})
        asked.push(`${match[1]}:${match[2]}`)
        return json(200, { permissions: match[2] === target && match[1] === ids["lab-text"] ? LabIds.targetOverwriteAllow.toString() : "0" })
      })
      const harnessRest = Layer.effect(HarnessRest, Effect.map(Effect.service(DiscordREST), (client) => HarnessRest.of(client))).pipe(Layer.provide(rest))
      const result = yield* oracleReads(context, provisioned).pipe(Effect.provide(harnessRest))
      expect(result.reads).toHaveLength(10)
      expect(result.reads.every((entry) => entry.permissions === 0n)).toBe(true)
      expect(result.control).toEqual({ permissions: LabIds.targetOverwriteAllow, expected: LabIds.targetOverwriteAllow })
      expect(result.availability).toBe("available")
      expect(asked.at(-1)).toBe(`${ids["lab-text"]}:${target}`)
      expect(asked.slice(0, -1).every((entry) => entry.endsWith(`:${subject}`))).toBe(true)
      expect(oracleProblems(result)).toEqual([])
    })
  )
})
