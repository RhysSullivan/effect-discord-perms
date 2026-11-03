/**
 * The dry-run switch (DESIGN §5.10 step (b)): a `Context.Reference` the shared base `HttpClient` reads for every
 * request. When it holds a recorder, the request still passes the Lab guard, then is recorded and answered
 * with a canned 2xx body from `fixtures/canned/` instead of being sent; nothing is paced or counted, because
 * nothing reaches Discord. A request without a canned body is a defect.
 *
 * The matrix's step (b) runs the real public operation in `"enforce"` mode under it (M6), so the run exercises the
 * user-facing path without an extra Discord request.
 */
import { Context, Effect, FileSystem, Option, Ref, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import { routeKey } from "./Pacing.ts"

/** One request the stub answered. */
export interface Recorded {
  readonly method: string
  /** The route as the pacing counters key it: `POST /channels/{id}/messages`. */
  readonly route: string
}

/** A dry run in progress: what it recorded, and the canned bodies by route. */
export interface Recorder {
  readonly record: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<void>
  readonly recorded: Effect.Effect<ReadonlyArray<Recorded>>
  readonly canned: (route: string) => Option.Option<unknown>
}

/** The switch: `None` (the default) sends every request; a recorder answers them instead. */
export const DryRun = Context.Reference<Option.Option<Recorder>>("harness/DryRun", { defaultValue: () => Option.none() })

/**
 * The canned 2xx bodies, by route (`fixtures/canned/`): one per route the library's operations send (M6), each
 * decoding with the operation's response schema (`src/rest/Schemas.ts`). Routes answered with no content take
 * `empty.json`, which dfx ignores.
 */
export const cannedFiles: Readonly<Record<string, string>> = {
  "POST /channels/{id}/messages": "create-message.json",
  "PATCH /channels/{id}/messages/{id}": "create-message.json",
  "DELETE /channels/{id}/messages/{id}": "empty.json",
  "POST /channels/{id}/messages/{id}/crosspost": "create-message.json",
  "POST /channels/{id}/messages/bulk-delete": "empty.json",
  "PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me": "empty.json",
  "PUT /channels/{id}/messages/pins/{id}": "empty.json",
  "DELETE /channels/{id}/messages/pins/{id}": "empty.json",
  "GET /channels/{id}/messages/pins": "pins.json",
  "POST /channels/{id}/threads": "thread.json",
  "POST /channels/{id}/messages/{id}/threads": "thread.json",
  "PUT /channels/{id}/thread-members/@me": "empty.json",
  "DELETE /channels/{id}/thread-members/@me": "empty.json",
  "PUT /channels/{id}/thread-members/{id}": "empty.json",
  "PATCH /channels/{id}": "channel.json",
  "DELETE /channels/{id}": "channel.json",
  "PUT /guilds/{id}/members/{id}/roles/{id}": "empty.json",
  "DELETE /guilds/{id}/members/{id}/roles/{id}": "empty.json",
  "PATCH /guilds/{id}/members/{id}": "member.json",
  "DELETE /guilds/{id}/members/{id}": "empty.json",
  "PUT /guilds/{id}/bans/{id}": "empty.json"
}

/** The route a canned body is looked up by: `routeKey`, with a reaction's emoji segment as `{emoji}`. */
export const cannedRoute = (method: string, url: string): string => routeKey(method, url).replace(/\/reactions\/[^/]+\/@me$/, "/reactions/{emoji}/@me")

/** A recorder over `bodies` (route to canned body). */
export const makeRecorder = (bodies: ReadonlyMap<string, unknown>): Effect.Effect<Recorder> =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<Recorded>>([])
    return {
      record: (request) => Ref.update(log, (entries) => [...entries, { method: request.method, route: cannedRoute(request.method, request.url) }]),
      recorded: Ref.get(log),
      canned: (route) => Option.fromUndefinedOr(bodies.get(route))
    }
  })

/** The canned bodies' directory. */
export const cannedDirectory = new URL("../fixtures/canned/", import.meta.url).pathname

const CannedBody = Schema.fromJsonString(Schema.Unknown)

/** Reads every canned body listed in {@link cannedFiles}. A missing or malformed file is a defect. */
export const loadCanned: Effect.Effect<ReadonlyMap<string, unknown>, PlatformError, FileSystem.FileSystem> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const bodies = new Map<string, unknown>()
  for (const [route, file] of Object.entries(cannedFiles)) {
    const text = yield* fs.readFileString(`${cannedDirectory}${file}`)
    bodies.set(route, yield* Schema.decodeUnknownEffect(CannedBody)(text).pipe(Effect.orDie))
  }
  return bodies
})
