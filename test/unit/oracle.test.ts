import { BunFileSystem } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Duration, Effect, Exit, Redacted } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { DiscordREST } from "dfx/DiscordREST"
import * as LabIds from "../../harness/LabIds.ts"
import { config } from "../../src/config/Credentials.ts"
import { DiscordResponse } from "../../src/errors/Cause.ts"
import { memberPermissions, OracleFailed, route } from "../../src/rest/Oracle.ts"
import { ChannelId, GuildId, UserId } from "../../src/Snowflake.ts"
import { json, type Scripted, scriptedRest } from "../support/fakeDiscord.ts"

/** The permission oracle (DESIGN §5.10 step 8), the lab-state file (§5.7) and the credentials recipe (§4.3). */
const channel = ChannelId.make("300000000000000001")
const user = UserId.make("200000000000000001")

const read = (answer: Scripted) =>
  Effect.gen(function* () {
    const rest = yield* DiscordREST
    return yield* memberPermissions(rest, channel, user, Duration.seconds(30))
  }).pipe(Effect.provide(scriptedRest((_, requestPath) => (requestPath === `/channels/${channel}/permissions/member/${user}` ? answer : json(500, {})))), Effect.exit)

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
  const temp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "edp-state-")), "state.json")

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

describe("the credentials recipe", () => {
  const values = {
    DISCORD_TEST_GUILD_ID: "100000000000000000",
    DISCORD_HARNESS_TOKEN: "fake-h",
    DISCORD_HARNESS_APP_ID: "100000000000000001",
    DISCORD_SUBJECT_TOKEN: "fake-s",
    DISCORD_SUBJECT_APP_ID: "100000000000000002",
    DISCORD_TARGET_TOKEN: "fake-t",
    DISCORD_TARGET_APP_ID: "100000000000000003"
  }

  it.effect("reads tokens as Redacted and decodes the branded IDs", () =>
    Effect.gen(function* () {
      const credentials = yield* config.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))))
      expect(credentials.guildId).toBe(GuildId.make("100000000000000000"))
      expect(String(credentials.subject.token)).not.toContain("fake-s")
      expect(Redacted.value(credentials.subject.token)).toBe("fake-s")
      expect(credentials.target.applicationId).toBe("100000000000000003")
    })
  )

  it.effect("fails on a malformed ID", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(config.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...values, DISCORD_TEST_GUILD_ID: "Perms Lab" })))))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )
})
