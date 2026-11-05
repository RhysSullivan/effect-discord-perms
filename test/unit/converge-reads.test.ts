import { describe, expect, it } from "@effect/vitest"
import { DiscordREST } from "dfx/DiscordREST"
import { Deferred, Duration, Effect, Layer, Option, Ref } from "effect"
import * as Converge from "../../harness/Converge.ts"
import { HarnessRest } from "../../harness/Identities.ts"
import * as Materialize from "../../harness/Materialize.ts"
import { Setup } from "../../harness/scenario/Dsl.ts"
import { RoleId } from "../../src/Snowflake.ts"
import { json, type Scripted, scriptedRestEffect } from "../support/fakeDiscord.ts"
import { channelIdOf, fakeIds, labGuildId } from "../support/lab.ts"

/**
 * Converge's read and the wait's read-back make their independent reads together (DESIGN §5.11, before M9): each
 * request still takes its slot of the shared bucket, but none waits for another's answer. The fake holds every
 * answer until all the expected reads have started, so reads made one after another would never finish.
 */
const state = Materialize.desired(
  new Setup({ channel: "public-thread", grants: [{ flags: ["ViewChannel"], via: "role" }], removals: [], memberState: "normal", fixtures: [] }),
  fakeIds
)

const answer = (method: string, path: string): Scripted => {
  if (method !== "GET") return json(500, { message: "unexpected write", code: 0 })
  if (path === `/guilds/${labGuildId}/roles`) return json(200, [{ id: RoleId.make(labGuildId), name: "@everyone", permissions: "0", position: 0, managed: false, mentionable: false }])
  if (path.startsWith(`/guilds/${labGuildId}/members/`)) return json(200, { user: { id: path.split("/").at(-1) }, roles: [], communication_disabled_until: null })
  if (path.endsWith("/thread-members")) return json(200, [])
  const id = path.split("/").at(-1) ?? ""
  return json(200, { id, type: path.includes(channelIdOf("lab-public-thread")) ? 11 : 0, name: "x", permission_overwrites: [], thread_metadata: { archived: false, locked: false, auto_archive_duration: 1440 } })
}

/** A harness client whose answers wait until `expected` requests have started; the paths seen, in start order. */
const holdingRest = (expected: number) =>
  Effect.gen(function* () {
    const started = yield* Ref.make<ReadonlyArray<string>>([])
    const all = yield* Deferred.make<void>()
    const rest = scriptedRestEffect((method, path) =>
      Effect.gen(function* () {
        const seen = yield* Ref.updateAndGet(started, (paths) => [...paths, `${method} ${path}`])
        if (seen.length >= expected) yield* Deferred.succeed(all, undefined)
        yield* Deferred.await(all)
        return answer(method, path)
      })
    )
    const harness = Layer.effect(HarnessRest, Effect.map(Effect.service(DiscordREST), (client) => HarnessRest.of(client))).pipe(Layer.provide(rest))
    return { harness, started: Ref.get(started) }
  })

describe("Converge's reads", () => {
  it.live("read the roles, both members, the lab channels, the thread and its members together", () =>
    Effect.gen(function* () {
      const channels = new Set(["lab-text", "lab-voice"] as const)
      // roles, subject, target, two channels, the thread, its members
      const { harness, started } = yield* holdingRest(7)
      const view = yield* Converge.readView(state, fakeIds, channels).pipe(Effect.provide(harness), Effect.timeoutOption(Duration.seconds(5)))
      expect(Option.isSome(view)).toBe(true)
      expect((yield* started).length).toBe(7)
      if (Option.isSome(view)) {
        expect(view.value.channels.map((channel) => channel.id)).toEqual([channelIdOf("lab-text"), channelIdOf("lab-voice")])
        expect(view.value.thread?.id).toBe(channelIdOf("lab-public-thread"))
        expect(view.value.threadMembers).toEqual([])
      }
    })
  )

  it.live("re-read exactly what was written, together", () =>
    Effect.gen(function* () {
      const base = yield* holdingRest(7)
      const view = yield* Converge.readView(state, fakeIds, new Set(["lab-text", "lab-voice"] as const)).pipe(Effect.provide(base.harness))
      // the roles, the subject, lab-text, the thread and its members were written: five reads
      const { harness, started } = yield* holdingRest(5)
      const written: Converge.Written = { roles: true, subject: true, target: false, channels: new Set([channelIdOf("lab-text")]), thread: true }
      const reread = yield* Converge.rereadWritten(state, fakeIds, view, written).pipe(Effect.provide(harness), Effect.timeoutOption(Duration.seconds(5)))
      expect(Option.isSome(reread)).toBe(true)
      expect([...(yield* started)].sort()).toEqual(
        [
          `GET /guilds/${labGuildId}/roles`,
          `GET /guilds/${labGuildId}/members/${fakeIds.subjectUserId}`,
          `GET /channels/${channelIdOf("lab-text")}`,
          `GET /channels/${channelIdOf("lab-public-thread")}`,
          `GET /channels/${channelIdOf("lab-public-thread")}/thread-members`
        ].sort()
      )
      if (Option.isSome(reread)) expect(reread.value.target).toBe(view.target)
    })
  )
})
