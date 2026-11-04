/**
 * The dry-run switch and the live capture (DESIGN §5.10 step (b) and the request check), two `Context.Reference`s the
 * shared base `HttpClient` reads for every request.
 *
 * - **{@link DryRun}**: when it holds a recorder, the request still passes the Lab guard (judged as the live request
 *   would be, `LabGuard.checkDry`), then is recorded and answered with a canned 2xx body from `fixtures/canned/`
 *   instead of being sent; nothing is paced or counted by the harness, because nothing reaches Discord. A request
 *   without a canned body is a defect. The matrix's step (b) runs the real public operation in `"enforce"` mode under
 *   it (M6), so the run exercises the user-facing path without an extra Discord request.
 * - **{@link Capture}**: when it holds a recorder, a request that passes the guard is recorded and then sent as usual.
 *   Steps (c) and (d) run under it, so the request check (the M6 verifier) compares the requests Discord received:
 *   step (c)'s with step (d)'s, and with step (b)'s when (b) reached the stub ({@link requestDifferences}: the method,
 *   the path with its IDs and query, and the body). It adds no request: a dry one still counts in dfx's own per-route
 *   limiter, which sits above the stub, so two dry requests per row delayed the live ones that followed past the
 *   request deadline (M6 verifier, first run).
 */
import { Context, Effect, FileSystem, Option, Ref, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type * as HttpBody from "effect/http/HttpBody"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as UrlParams from "effect/http/UrlParams"
import { routeKey } from "./Pacing.ts"
import { canonicalJson } from "./TruthTable.ts"

/** One request the stub answered. */
export interface Recorded {
  readonly method: string
  /** The route as the pacing counters key it: `POST /channels/{id}/messages`. */
  readonly route: string
  /** The path under the API base, with its IDs, and the query parameters sorted: `/channels/1/messages/pins?limit=50`. */
  readonly path: string
  /**
   * The body as canonical JSON (`TruthTable.canonicalJson`): a JSON body as sent, a multipart body as its parts in
   * order (`payload_json` as JSON, each file by name, type and size), `null` for none.
   */
  readonly body: string
}

/** A dry run in progress: what it recorded, and the canned bodies by route. */
export interface Recorder {
  readonly record: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<void>
  readonly recorded: Effect.Effect<ReadonlyArray<Recorded>>
  readonly canned: (route: string) => Option.Option<unknown>
}

/** The switch: `None` (the default) sends every request; a recorder answers them instead. */
export const DryRun = Context.Reference<Option.Option<Recorder>>("harness/DryRun", { defaultValue: () => Option.none() })

/** The live capture: `None` (the default) records nothing; a recorder records every request sent, which still goes out. */
export const Capture = Context.Reference<Option.Option<Recorder>>("harness/Capture", { defaultValue: () => Option.none() })

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

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** A text body as JSON, or as `{ text }` when it is not JSON. */
const jsonOrText = (text: string): Schema.Json => Option.getOrElse(decodeJson(text), (): Schema.Json => ({ text }))

/** A form part's value, as `FormData` holds it. */
type Part = NonNullable<ReturnType<globalThis.FormData["get"]>>

/** A form part: a string, `payload_json` read as JSON, any other file by name, type and size. */
const partOf = (name: string, value: Part): Effect.Effect<Schema.Json> => {
  if (typeof value === "string") return Effect.succeed({ name, value: jsonOrText(value) })
  if (name === "payload_json") return Effect.map(Effect.promise(() => value.text()), (text) => ({ name, value: jsonOrText(text) }))
  return Effect.succeed({ name, file: { name: value.name, type: value.type, size: value.size } })
}

/** A request body as the recorder keeps it (see {@link Recorded}). */
export const bodyOf = (body: HttpBody.HttpBody): Effect.Effect<Schema.Json> => {
  switch (body._tag) {
    case "Empty":
      return Effect.succeed(null)
    case "Uint8Array":
      return Effect.succeed(jsonOrText(new TextDecoder().decode(body.body)))
    case "FormData":
      return Effect.forEach([...body.formData.entries()], ([name, value]) => partOf(name, value))
    case "Raw":
    case "Stream":
      return Effect.succeed({ unreadable: body._tag })
  }
}

/** A request's path under the API base, with the query parameters (the URL's and `urlParams`) sorted. */
export const pathOf = (request: HttpClientRequest.HttpClientRequest): string => {
  const url = new URL(request.url)
  const query = new URLSearchParams(url.search)
  for (const [key, value] of new URLSearchParams(UrlParams.toString(request.urlParams))) query.append(key, value)
  query.sort()
  const search = query.toString()
  return `${url.pathname.replace(/^\/api\/v\d+/, "")}${search === "" ? "" : `?${search}`}`
}

/** A request as the recorder keeps it. */
export const recordedOf = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<Recorded> =>
  Effect.map(bodyOf(request.body), (body) => ({ method: request.method, route: cannedRoute(request.method, request.url), path: pathOf(request), body: canonicalJson(body) }))

/** A recorder over `bodies` (route to canned body). */
export const makeRecorder = (bodies: ReadonlyMap<string, unknown>): Effect.Effect<Recorder> =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<Recorded>>([])
    return {
      record: (request) => Effect.flatMap(recordedOf(request), (entry) => Ref.update(log, (entries) => [...entries, entry])),
      recorded: Ref.get(log),
      canned: (route) => Option.fromUndefinedOr(bodies.get(route))
    }
  })

/** A recorder for {@link Capture}: it answers nothing, so it holds no canned bodies. */
export const makeCapture: Effect.Effect<Recorder> = Effect.suspend(() => makeRecorder(new Map()))

/**
 * A live step's own request among what its capture recorded: the first. The operation sends one request; a 429 that
 * dfx retries sends it again, and the recompute's reads (step (d)) follow it.
 */
export const operationRequest = (recorded: ReadonlyArray<Recorded>): ReadonlyArray<Recorded> => recorded.slice(0, 1)

/**
 * How the requests `actual` recorded differ from the `expected` ones (the raw call's), each difference named with
 * `label`; empty when they are the same requests: the same number, and each with the same method, path and body.
 */
export const requestDifferences = (label: string, actual: ReadonlyArray<Recorded>, expected: ReadonlyArray<Recorded>): ReadonlyArray<string> => {
  if (actual.length !== expected.length) {
    const list = (entries: ReadonlyArray<Recorded>) => entries.map((entry) => entry.route).join(", ") || "none"
    return [`${label}: ${actual.length} request(s) (${list(actual)}), the raw call ${expected.length} (${list(expected)})`]
  }
  const flat = (body: string) => body.replace(/\s+/g, " ")
  return actual.flatMap((entry, index) => {
    const reference = expected[index]
    if (reference === undefined) return []
    const at = `${label}: request ${index + 1}`
    return [
      ...(entry.method === reference.method ? [] : [`${at}: method ${entry.method}, the raw call's ${reference.method}`]),
      ...(entry.path === reference.path ? [] : [`${at}: path ${entry.path}, the raw call's ${reference.path}`]),
      ...(entry.body === reference.body ? [] : [`${at}: body ${flat(entry.body)}, the raw call's ${flat(reference.body)}`])
    ]
  })
}

/** One library side of the request check: which step made the requests, and the requests. */
export type RequestSide = readonly [label: string, requests: ReadonlyArray<Recorded>]

/**
 * The library's sides the request check holds to step (c)'s request (§5.10): step (b)'s, when (b) reached the stub,
 * and step (d)'s own request as sent, when (d) ran. Empty when neither did; the runner then records the operation
 * in bypass mode over the stub instead (`Library.bypassedRequests`).
 */
export const librarySides = (
  stepB: { readonly reachedStub: boolean; readonly requests: ReadonlyArray<Recorded> },
  stepD: ReadonlyArray<Recorded> | undefined
): ReadonlyArray<RequestSide> => [
  ...(stepB.reachedStub ? [["step (b)", stepB.requests] as const] : []),
  ...(stepD === undefined ? [] : [["step (d)", operationRequest(stepD)] as const])
]

/**
 * The request check (§5.10): every way a library side differs from the request step (c) sent (its first, as
 * captured); empty when every side made exactly that request.
 */
export const requestCheck = (sides: ReadonlyArray<RequestSide>, rawCaptured: ReadonlyArray<Recorded>): ReadonlyArray<string> => {
  const raw = operationRequest(rawCaptured)
  return sides.flatMap(([label, requests]) => requestDifferences(label, requests, raw))
}

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
