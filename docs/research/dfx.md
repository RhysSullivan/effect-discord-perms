# dfx 1.1.1 deep-read

Research for effect-discord-perms. Everything below comes from reading
`node_modules/dfx/src` (dfx 1.1.1, effect 4.1.1, discord-api-types 0.38.57,
TypeScript 7.0.2, Bun 1.4.4) and from local experiments in
`.scratch/dfx/`. **No call reached discord.com.** Every runtime experiment uses a
fake `HttpClient`, a fake gateway `PubSub`, or plain function calls, plus a fake
token. Claims I could not check locally are marked **UNVERIFIED**.

Scratch files. Each type-checks with `tsc -p .scratch/dfx`; the `*-runtime.ts`
files run with `bun run`:

| file | what it shows |
|---|---|
| `boot.ts` | a minimal Bun bot that type-checks (not run) |
| `types-probe.ts` | REST error union, `.code` bug, IDs, channel types, gateway typing, Ix option typing |
| `errors-runtime.ts` | the exact runtime shape of each REST failure (403/404/400/5xx/HTML/429/malformed/BigInt) |
| `ratelimit-runtime.ts` | 429 retry has no upper bound |
| `dispatch-runtime.ts` | `handleDispatch` is concurrent, and one failure ends the subscription |
| `cache-runtime.ts` | what the cache prelude stores from fake dispatches |
| `perms-runtime.ts` | where `Perms.forChannel` disagrees with the documented algorithm |
| `ix-boundary-probe.ts`, `ix-rules-probe.ts`, `ix-subcommand-probe.ts`, `ix-helper-runtime.ts` | interactions typing |
| `intents-probe.ts`, `flags-runtime.ts` | intents and permission flag typing |
| `universes-probe.ts` | generated REST types vs discord-api-types interaction types |
| `category-probe.ts`, `reason-probe.ts` | Effect v4 `catchIf` and `catchReasons` over these errors |
| `hook-probe.ts`, `escape-hatch-probe.ts`, `escape-hatch-runtime.ts` | `DispatchHook`, raw client, `Discord.make` |

## 0. Verdict

| dfx piece | use it? | why |
|---|---|---|
| `DiscordREST` (generated client, rate limiter) | **Build on it** | Calls are thin. Errors carry the Discord `code`, the status, the method and the URL. Path params are `string`, so branded IDs pass straight in. We wrap every call we expose: map errors, put a bound on 429 retries, brand responses. |
| `DiscordGateway` (shards, `fromDispatch`, `handleDispatch`) | **Build on it, wrap the handler API** | It is solid transport. Event typing ignores intents, and `handleDispatch` stops for good at the first handler failure. |
| `DispatchHook` | **Use it** to feed our state cache | It runs for every dispatch before subscribers see it, so it cannot miss one through subscription timing. |
| `Cache` prelude (guilds, channels, roles) | **Probably replace with our own cache fed by DispatchHook** (decision below) | It has no member cache. The guild cache drops roles, channels and members. Role misses never fall back to REST. Channels from GUILD_CREATE lack `guild_id`, which breaks `Perms`. |
| `Helpers/permissions` (`Perms`) | **Do not use** for the resolver. `Perms.has` and `Perms.toList` are fine. | Overwrites are applied in array order. It ignores the owner, timeouts and implicit permissions, has no thread support, finds @everyone by name, and returns `member.permissions` without checking the channel. |
| `Interactions` (`Ix`, `InteractionsRegistry`) | **Do not build on it. Write our own layer** over `INTERACTION_CREATE` + REST. Reuse small pure helpers if useful. | Options are loosely typed (choices are not narrowed, the subcommand typing is unsound). It has no auto-defer, follow-ups or state machine, and no `custom_id` schema. Registration ignores name rules, and every register does a full bulk PUT. `register` requires every error to be handled, transient ones included. |
| `UI` builders | Optional | These are thin object constructors with no layout rules. |
| Generated request/response types | Use as the wire format under our own types | Every guild channel shares one interface. GuildMedia (16) is missing. IDs are `string`. Payloads are bags of optional fields. |

## 1. Package layout and entry points

`package.json` exports `"."` and `"./*"`, mapping to `dist/*.js` / `dist/*.d.ts`.
The `.d.ts` files import siblings with `.ts` extensions. They resolve under our
tsconfig (NodeNext, `allowImportingTsExtensions`): the probes assert exact types,
and a deliberately false assertion fails, so nothing is silently `any`.

- `dfx`: `Cache`, `Discord` (= `types.ts`: all generated REST types, `make`,
  `DiscordRestError`, gateway payload types copied from discord-api-types,
  `GatewayIntentBits`, `Permissions` = discord-api-types `PermissionFlagsBits`,
  `MessageFlags`), `DiscordConfig`, `Flags`, `Intents`, `Ix`, `IxHelpers`, `Members`,
  `Perms`, `UI`, `DiscordREST`, `DiscordRESTLive`, `DiscordRESTMemoryLive`,
  `RateLimitStore`, `RateLimiter`, `RateLimiterLive`, `MemoryRateLimitStoreLive`.
- `dfx/gateway`: `DiscordGateway`, `DiscordGatewayLive`, `DiscordLive`,
  `DiscordIxLive`, `InteractionsRegistry(Live)`, `interactionsSync`,
  `setInteractionsSync`, `runIx`, `CachePrelude`, `DiscordWS`, `SendEvent`, `Shard`,
  `ShardStore`, `DispatchHook`.
- `dfx/webhooks`: the HTTP-interactions handler (`makeHandler`, `WebhookConfig`,
  ...) and a **different** `DiscordLive` (REST + RateLimiter only). The two
  `DiscordLive` names mean different things.
- Deep imports work too: `dfx/DiscordREST`, `dfx/DiscordGateway`,
  `dfx/DiscordGateway/Messaging`, `dfx/Interactions/commandHelper`,
  `dfx/DiscordREST/utils`, ...

The generated client has 244 REST methods (`DiscordREST/Generated.ts`, 12,926
lines). It is generated with `@tim-smart/openapi-gen` (a devDependency), probably
from Discord's OpenAPI spec (UNVERIFIED which spec revision). dfx does not use
`effect/Schema` anywhere. Neither responses nor gateway payloads are validated at
runtime; they are cast.

## 2. Booting on Bun

### Config

`DiscordConfig` is a `Context.Service` holding:

```ts
interface DiscordConfigService {
  readonly token: Redacted.Redacted
  readonly rest: { baseUrl: string; globalRateLimit: { limit: number; window: Duration.Input } }
  readonly gateway: {
    readonly intents: number                // plain number, default GatewayIntentBits.Guilds
    readonly presence?: Discord.GatewayPresenceUpdateData
    readonly shardCount?: number
    readonly identifyRateLimit: readonly [window: number, limit: number] // default [5000, 1]
  }
}
```

The defaults come from `DiscordConfig.make`: base URL `https://discord.com/api/v10`,
a global REST limit of 50 per 1 s, and intents `Guilds` only.
`DiscordConfig.layer(opts)` takes plain values. `DiscordConfig.layerConfig(wrapped)`
takes a `Config.Wrap<MakeOpts>`, so every leaf must be a `Config`, for example
`intents: Config.succeed(n)`.

### Platform requirements

`dfx/gateway` `DiscordLive` / `DiscordIxLive` require
`DiscordConfig | WebSocketConstructor | HttpClient.HttpClient`. On Bun:

- `HttpClient`: `BunHttpClient.layer` (a re-export of `effect/http/FetchHttpClient`)
- `WebSocketConstructor`: `BunSocket.layerWebSocketConstructor` (Bun's global `WebSocket`)

Both come from `@effect/platform-bun`.

### Minimal example (type-checks, not run): `.scratch/dfx/boot.ts`

```ts
import { BunHttpClient, BunRuntime, BunSocket } from "@effect/platform-bun"
import { DiscordConfig, Discord, Intents } from "dfx"
import { DiscordGateway, DiscordIxLive } from "dfx/gateway"
import { DiscordREST } from "dfx/DiscordREST"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const DiscordConfigLive = DiscordConfig.layerConfig({
  token: Config.Redacted("DISCORD_SUBJECT_TOKEN"),
  gateway: {
    intents: Config.succeed(Intents.fromList(["Guilds", "GuildMessages", "GuildMembers", "MessageContent"])),
  },
})

export const DiscordLayer = DiscordIxLive.pipe(
  Layer.provide([DiscordConfigLive, BunHttpClient.layer, BunSocket.layerWebSocketConstructor]),
)
// asserted in the file:
// Layer<RateLimiter | DiscordGateway | DiscordREST | InteractionsRegistry, ConfigError, never>

const Main = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway
    const rest = yield* DiscordREST
    yield* gateway
      .handleDispatch("MESSAGE_CREATE", (m) =>
        m.content === "!ping" ? rest.createMessage(m.channel_id, { content: "pong" }) : Effect.void,
      )
      .pipe(Effect.catchCause(Effect.logError), Effect.forkScoped)
  }),
).pipe(Layer.provide(DiscordLayer))

export const run = () => BunRuntime.runMain(Layer.launch(Main))
```

Notes:

- The dfx README uses `Config.redacted(...)`, which does not exist in effect
  4.1.1. The name is `Config.Redacted(...)` (compile error checked).
- Use `DiscordLive` instead of `DiscordIxLive` if we do not use the dfx
  interactions registry. `DiscordIxLive` only adds `InteractionsRegistry`.
- **Bun loads `.env` from the working directory into `process.env`
  automatically** (checked with a fake `.env` in `.scratch/dfx/envtest`). Without
  any opt-in, `Config.Redacted("DISCORD_SUBJECT_TOKEN")` reads the token from the
  project `.env`. `bun --no-env-file` turns this off. The brief wants credentials
  "bound to the process explicitly, not inherited", so this is a decision for us
  (see Decisions).
- **No startup failure on a bad token or a disallowed intent.** The Sharder
  swallows any `getBotGateway()` failure and falls back to
  `wss://gateway.discord.gg/` with 1 shard (`Sharder.ts`: `Effect.catch(() =>
  Effect.succeed(...))`). `DiscordWS` retries every socket close forever:
  `Effect.catchCause(cause => Effect.logDebug("Got socket error, reconnecting",
  cause))` + `Effect.repeat(min(exponential(500), spaced(10s)))`. Nothing in dfx
  checks `GatewayCloseCodes`; the only close code it looks at is its own 3000. So
  close code 4004 (bad token) or 4014 (disallowed intents) becomes a silent
  reconnect loop that logs only at Debug level. Our harness must fail fast
  itself, for example `rest.getMyUser()` plus the privileged-intent bits in
  `getMyApplication().flags`. (The close-code behaviour is read from source;
  observing it live is UNVERIFIED.)
- dfx has no "ready" signal. Wait for `READY`/`GUILD_CREATE` yourself (see §4 on
  `DispatchHook`).

## 3. DiscordREST

### Call path (source: `DiscordREST.ts`, `DiscordREST/Generated.ts`)

1. A generated method builds an `HttpClientRequest`, for example
   `createMessage: (channelId, options) => HttpClientRequest.post(\`/channels/${channelId}/messages\`).pipe(HttpClientRequest.bodyJsonUnsafe(options), onRequest(["2xx"], { "429": "RatelimitedResponse", "4xx": "ErrorResponse" }))`.
2. `onRequest` runs it through `httpClient.execute`, then
   `HttpClientResponse.matchStatus(cases)`:
   - a success code (`"2xx"`, or `"200","201"` for some endpoints) → `response.json as Effect<A>`. **No validation.** For void endpoints (`onRequest([])`), any 2xx → `Effect.void`.
   - `"429"` → `DiscordRestError("RatelimitedResponse", body)`
   - `"4xx"` → `DiscordRestError("ErrorResponse", body)`
   - anything else (5xx, 3xx, a 204 on an endpoint that expects 200/201) → `unexpectedStatus` → `HttpClientError({ reason: StatusCodeError({ description: JSON.stringify(body) | "Unexpected status code" }) })`
3. The `httpClient` passed in is dfx's wrapper:
   - `mapRequestInputEffect`: prepends `rest.baseUrl` and sets `Authorization: Bot <token>` and `User-Agent: DiscordBot (https://github.com/tim-smart/dfx, 1.1.1)` (checked at runtime with a fake token). If a `DiscordFormData` service is in the fiber context, the JSON body moves into a `payload_json` part of that `FormData`. This is how `rest.withFiles(files)(effect)` / `rest.withFormData(fd)(effect)` send attachments.
   - `tapRequest`: waits on the route bucket (`store.getBucketForRoute(routeFromConfig(url, method))`), then on the "invalid route" limiter, then on the proactive global limiter (`dfx.rest.global`, 50/s by default).
   - `transformResponse`: updates buckets from the `x-ratelimit-*` headers. A **403** adds the route to `badRoutes` and bumps the `dfx.rest.invalid` counter (10,000 per 10 min), then returns the response unchanged. A **429** does the same, then sleeps and retries (next section).
   - It disables trace-context propagation headers (`TracerPropagationEnabled false`).

### Typing

Every method is typed like this:

```ts
readonly createMessage: (
  channelId: string,
  options: MessageCreateRequest,
) => Effect.Effect<
  MessageResponse,
  | HttpClientError.HttpClientError
  | DiscordRestError<"RatelimitedResponse", RatelimitedResponse>
  | DiscordRestError<"ErrorResponse", ErrorResponse>
>
```

`DiscordRESTError` in `dfx/DiscordREST` is exactly that union (`types-probe.ts`
asserts `Equals`). `R = never`, and there is no per-endpoint error typing.

- Path params are plain `string`. `Discord.Snowflake = string`. Response IDs are plain `string`.
- Request types are generated interfaces in which nearly every field is
  `?: X | null | undefined`, so they work with `exactOptionalPropertyTypes`. Our
  narrower payload types will be assignable to them.
- `MessageCreateRequest` accepts `{}` (an empty message compiles). `flags` is
  `number`. `ButtonComponentForMessageRequest` is one interface with optional
  `custom_id`, `url`, `sku_id` and `label`. `ActionRowComponentForMessageRequest.components`
  is an unbounded `ReadonlyArray`. `MessageAllowedMentionsRequest` is all optional.
  dfx enforces none of the payload rules in the brief (`ix-rules-probe.ts`: six
  buttons plus a select in one row, a link button with a `custom_id`, a premium
  button with a label, and a 500-char `custom_id` all compile).
- `MessageResponse.content: string` always.

### Exactly how failures are represented (runtime results, `errors-runtime.ts`)

| situation | error in E | `_tag` | Discord code | status, method, URL |
|---|---|---|---|---|
| 403 `{"code":50013,...}` | `DiscordRestErrorImpl` (a `Data.Error`) | `"ErrorResponse"` | `e.data.code === 50013` | `e.response.status` 403, `e.request.method` POST, `e.request.url` = full URL with IDs |
| 404 `{"code":10003}` | same | `"ErrorResponse"` | `e.data.code` 10003 | 404 |
| 400 `{"code":50035,"errors":{...}}` | same | `"ErrorResponse"` | `e.data.code` 50035, `e.data.errors` = the field tree | 400 |
| 500 JSON body | `HttpClientError` | `"HttpClientError"` | not parsed; `e.reason.description` is the JSON body as a string | `e.reason._tag === "StatusCodeError"`, `e.response.status` 500 |
| 502 HTML body | `HttpClientError` | `"HttpClientError"` | none; description `"Unexpected status code"` | `StatusCodeError` |
| 403 HTML body (e.g. Cloudflare) | `HttpClientError` | `"HttpClientError"` | none | `reason._tag === "DecodeError"` (the 4xx decoder's `response.json` failed) |
| 429 (any number of times) | **never surfaces** | n/a | n/a | retried until it succeeds |
| 200 with a malformed JSON body | `HttpClientError` | `"HttpClientError"` | n/a | `reason._tag === "DecodeError"`. **A typed failure, not a defect** |
| 200 with a well-formed but wrong-shaped body | **nothing**: it succeeds, cast to the response type | | | |
| network failure | `HttpClientError` with `reason._tag === "TransportError"` (from Effect's client; read from source, not triggered) | | | |
| request body contains a `BigInt` | **defect** (`TypeError: JSON.stringify cannot serialize BigInt`). `bodyJsonUnsafe` runs synchronously, so outside `Effect.suspend` it throws at the call site | | | |

Details that matter for our error layer:

- **dfx type bug: `e.code` type-checks as `number` but is `undefined` at
  runtime.** `export interface DiscordRestError<Tag, E> extends Error` sits inside
  `Generated.ts`, where `Error` is the generated Discord error interface
  (`{ readonly code: number; readonly message: string }`, line 792), not the
  global `Error`. The implementation (`DiscordRestErrorImpl extends
  Data.Error<{ _tag, data, message, request, response }>`) never sets `code`.
  Always read **`e.data.code`**. (`types-probe.ts` `_2`; `errors-runtime.ts`
  prints `code: undefined, dataCode: 50013`.)
- `e.message` is `JSON.stringify(e.data)`. `e.name === "DiscordRestError"`.
  `e instanceof Error` is true.
- `ErrorResponse.errors` is typed `Record<string, unknown> | InnerErrors`.
  Anything we put in an error `cause` needs its own schema; using this type would
  bring `unknown` into our errors.
- Route: dfx gives us `e.request.method` and the full `e.request.url`, not a
  route template. `routeFromConfig(path, method)` in `dfx/DiscordREST/utils` is
  the rate-limit bucket key (it keeps channel/guild/webhook IDs and drops the
  others), not a template. Our wrapper knows which operation it called, so it
  should stamp the route template itself.
- `request` and `response` are live objects (the body is already consumed). They
  are not serializable. Copy out `{ code, message, status, method, route, errors }`.
- `RatelimitedResponse` is in the type but unreachable in practice (next section).

### 429 handling

```ts
case 429:
  return Effect.annotateLogs(Effect.logDebug("429"), "url", request.url).pipe(
    Effect.andThen(addBadRoute(routeFromConfig(request.url, request.method))),
    Effect.andThen(updateBuckets(request, response)),
    Effect.andThen(Effect.sleep(Option.getOrElse(retryAfter(response.headers), () => Duration.seconds(5)))),
    Effect.andThen(rateLimitedClient.execute(request)),
  )
```

- The wait comes from `retryAfter`: `x-ratelimit-reset-after`, else
  `retry-after`, else 5 s. It does not read the JSON `retry_after` or
  `x-ratelimit-global`/`scope`.
- **There is no upper bound.** `ratelimit-runtime.ts`: a fake server that always
  returns 429 got **152 calls in 3 s** and the call never finished. The brief's
  "`transient`: retries that were given up" needs **our** bound, for example
  `Effect.timeout` around each wrapped call, mapped to a transient
  `RateLimitedGaveUp`/`RequestTimedOut` error. dfx's retry loop is internal and
  not configurable.
- Shared-scope 429s count toward dfx's invalid-request counter even though
  Discord does not count them (read from source). dfx does not count 401s.

### Defects in dfx's REST path

- A non-JSON-serializable body (BigInt) is a defect.
- `Fiber.getCurrent()!` sits in the request mapper. It is always set while a
  fiber is running, so it is harmless.
- 2xx bodies are cast without validation. "Malformed response is a defect" (from
  the brief) only happens if **we** decode responses with Schema and `orDie`,
  and also turn `DecodeError` on a 2xx into a defect.

### Escape hatches (compiled: `escape-hatch-probe.ts`; checked at runtime: `escape-hatch-runtime.ts`)

- `rest.httpClient` is the authenticated, rate-limited `HttpClient`.
  `rest.httpClient.execute(HttpClientRequest.get("/users/@me"))` sends
  `GET https://discord.com/api/v10/users/@me` with the auth and UA headers.
  Use it for endpoints we want to decode ourselves.
- `Discord.make(httpClient, { transformClient? })` is the generated factory. We
  can build a second typed client over `rest.httpClient.pipe(...)` to add span
  names, header capture and so on, and keep dfx's limiter and `withFiles`
  behaviour.
- Effect's HTTP client opens one span per request, named by
  `HttpClient.SpanNameGenerator` (defaults to just the method, e.g. `"POST"`).
  We can provide a generator that adds the route. `authorization` is redacted by
  default (`Headers.CurrentRedactedNames`), and request headers are not recorded
  (`TracerHeaderFilter` defaults to `constFalse`). URL **paths** are recorded and
  appear in `HttpClientError.message`. Interaction and webhook **tokens** sit in
  the path (`/interactions/{id}/{token}/callback`), so they can end up in traces
  and error logs.
- No generated method sets `X-Audit-Log-Reason`. To set it, use
  `rest.httpClient` directly.

## 4. DiscordGateway

### Service

```ts
interface DiscordGateway {
  readonly dispatch: Stream.Stream<Discord.GatewayReceivePayload>   // only dispatches are ever published
  readonly fromDispatch: <K extends `${Discord.GatewayDispatchEvents}`>(event: K) =>
    Stream.Stream<Extract<Discord.DistributedGatewayDispatchPayload, { readonly t: K }>["d"]>
  readonly handleDispatch: <K extends `${Discord.GatewayDispatchEvents}`, R, E, A>(event: K,
    handle: (event: Extract<Discord.DistributedGatewayDispatchPayload, { readonly t: K }>["d"]) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<never, E, R>
  readonly send: (payload: Discord.GatewaySendPayload) => Effect.Effect<boolean>
  readonly shards: Effect.Effect<ReadonlySet<RunningShard>>
}
export const DiscordGateway = Context.Service<DiscordGateway>("dfx/DiscordGateway")
```

- Events are typed by event-name literal only, through the copied
  discord-api-types dispatch union. `GatewayDispatchPayload` discriminates on `t`
  (`hook-probe.ts` narrows `payload.t === "GUILD_CREATE"` → `payload.d.members`).
- **Event typing ignores intents.** `fromDispatch("MESSAGE_CREATE")` compiles
  with any intents, and `MESSAGE_CREATE` `content` is always `string`
  (`types-probe.ts` `_7`). `DiscordConfig.gateway.intents` is a plain `number`.
  `GatewayIntentBits` values are `number`, not literals (`1 << n` does not
  produce a literal type). `Intents.fromList` takes a mutable `Array<keyof ...>`
  (it rejects a `readonly` tuple) and returns `number` (`intents-probe.ts`).
  Intent typing has to live entirely in our layer. We keep a literal tuple of
  intent names, compute the number for `DiscordConfig`, and derive event and
  field types from the tuple.
- `Intents` helpers: `ALL`, `PRIVILEGED` (`GuildPresences | GuildMembers |
  MessageContent` = 33026), `UNPRIVILEGED`, `toList`, `fromList`, `has`.
  `GatewayIntentBits` has 21 names, including `GuildMessagePolls` and
  `DirectMessagePolls`.
- The interaction payload type is discord-api-types' `APIInteraction`, while the
  other payloads use the generated REST types (`APIGuild = Rest.GuildResponse`,
  `APIMessage = Rest.MessageResponse`, ...). **These two type universes are not
  mutually assignable** (`universes-probe.ts`). An `APIInteractionGuildMember`
  is rejected by `Perms.forChannel` ("Property 'avatar' is optional ... but
  required"), and a discord-api-types `APIMessage` is not a `MessageResponse`
  (the `MessageType` enums differ).

### `handleDispatch` semantics (`dispatch-runtime.ts`)

Implemented by `utils/Effect.subscribeForEachPar`: it subscribes to the PubSub
and `runFork`s each matching event, and the first failure wins a `raceFirst`
against the loop.

- Handlers run **concurrently and unordered**. Events 1–4 published in order
  with delays 30/10/50/5 ms finished as `[4, 2]`.
- **The first handler failure ends the whole `handleDispatch`.** The returned
  effect fails with that error. In-flight handlers (1 and 3) are interrupted when
  the scope closes, and later events (5) are never handled.
- Our `Bot.on(...)` must isolate each event. Under our enforcement rule,
  `transient` errors may stay unhandled at the handler boundary, so `Bot.on` has
  to catch and log those per event, not let them reach `handleDispatch`.
  Otherwise one 5xx would silently stop the subscription.
- `fromDispatch` streams: each call is a new PubSub subscription. Events
  published before a subscriber exists are lost.

### `DispatchHook`

`Context.Reference<(payload, { shard, sessionId }) => Effect<void>>` with a no-op
default. The Shard reads it at construction and runs it **for every dispatch,
serially per shard, before the sequence is stored and before publishing to the
PubSub**. A failing hook makes the shard reconnect and resume. Provide it with
`DiscordLive.pipe(Layer.provide(Layer.succeed(DispatchHook, fn)))`
(`hook-probe.ts`). This is the race-free place to keep our own guild, channel,
role and member state current. Keep it fast: it runs on the read loop, and a hook
slower than the heartbeat interval can make the shard reconnect.

### Other gateway internals

- `Sharder` calls `rest.getBotGateway()` (errors swallowed, see §2) and claims
  shard IDs from `ShardStore` (memory by default). It spawns
  `session_start_limit.max_concurrency` workers, with identify spacing set by
  `DiscordConfig.gateway.identifyRateLimit`.
- `Shard` handles HELLO, heartbeats (it reconnects if an ACK is missed),
  IDENTIFY/RESUME, INVALID_SESSION and RECONNECT. It sends at most 120 payloads
  per minute (`dfx.shard.send`), with failure backoff from 1 s to 2 min.
  `ShardStateStore` (memory or KeyValueStore) keeps the resume state.
- `send` queues `GatewaySendPayload`s; `SendEvent.requestGuildMembers(...)`
  builds them.

## 5. Cache

### What exists (`Cache.ts`, `Cache/prelude.ts`, `Cache/memory*.ts`)

- Generic `Cache.make` (key → A) and `Cache.makeWithParent` (parentId → id → A).
  Each takes a driver, an `ops` stream, `onMiss` and `onParentMiss`. They return
  `Effect<Cache, never, Scope>` values, **not services**, so you wrap them in
  your own `Layer.effect`.
- Drivers: `Cache.memoryDriver()`, `memoryParentDriver()`, and
  `memoryTTLDriver(opts)` / `memoryTTLParentDriver(opts)`.
- Prelude (`CachePrelude` from `dfx/gateway`), with requirements
  `DiscordGateway | DiscordREST | Scope`:
  - `guilds(driver)`: `Cache<E, DiscordRESTError, GuildResponse>`. Ops: GUILD_CREATE (**stored with `channels: [], roles: [], emojis: [], members: []`**), GUILD_UPDATE, GUILD_DELETE. `onMiss` → `rest.getGuild(id)`. It keeps `owner_id`.
  - `channels(driver)`: `ParentCache<E, DiscordRESTError, DiscordRESTError, GetChannel200>`, keyed `(guildId, channelId)`. Ops: GUILD_CREATE `channels.concat(threads)`, CHANNEL_/THREAD_ CREATE/UPDATE/DELETE, and GUILD_DELETE → parentDelete. `onMiss` → `rest.getChannel(id)` (ignores the parent). `onParentMiss` → `rest.listGuildChannels`.
  - `roles(driver)`: `ParentCache<E, CacheMissError, DiscordRESTError, GuildRoleResponse>`, keyed `(guildId, roleId)`. Ops: GUILD_CREATE roles and GUILD_ROLE_CREATE/UPDATE/DELETE. **`get` miss → `CacheMissError` (no REST fallback).** `getForParent` miss → `rest.listGuildRoles`.
  - **There is no member cache, and nothing for voice states or thread members.**
    THREAD_LIST_SYNC, THREAD_MEMBERS_UPDATE and GUILD_MEMBER_* are not handled.
- `CacheMissError` is a `Data.Error` with `_tag = "CacheMissError"` and fields
  `{ cacheName, id }`.
- Ops-stream or driver failures are logged and retried (500 ms exponential, at
  most 10 s apart).

### What the prelude stores (`cache-runtime.ts`, fake dispatches)

- `guilds.get(G)` → `members: 0, roles: 0, channels: 0, owner_id: "999"`.
- `channels.getForParent(G)` → the text channel **and** the active thread, both
  under guild G.
- A channel stored from GUILD_CREATE keeps whatever object the dispatch carried.
  If Discord omits `guild_id` on GUILD_CREATE channels (as I believe, UNVERIFIED
  live), the cached channel has **no `guild_id`**. Section 6 shows why that
  breaks `Perms.forChannel`.
- `roles.get(G, "777")` → `CacheMissError`. `channels.get(G, unknown)` → one REST
  `GET /channels/{id}` → `ErrorResponse` in the error channel.
- CHANNEL_UPDATE replaces the whole channel, so new `permission_overwrites`
  show up. THREAD_UPDATE updates `thread_metadata` (`archived`, `locked`).

### Reading what the permission resolver needs

| input | where to get it with dfx |
|---|---|
| guild `owner_id` | `guilds` cache, or `rest.getGuild` |
| @everyone role and all roles | `roles.getForParent(guildId)`. @everyone has `id === guildId` |
| channel overwrites, `type`, `parent_id` | `channels.get(guildId, channelId)`. Threads have no overwrites, so look up `parent_id` |
| thread `archived` / `locked` | `channels.get(guildId, threadId).thread_metadata` |
| **bot member roles and `communication_disabled_until`** | **dfx has nothing.** Options: GUILD_CREATE `members` (should include the bot's own member, UNVERIFIED), GUILD_MEMBER_UPDATE (needs GuildMembers, which the subject has), or `rest.getGuildMember(guildId, botUserId)`. (`rest.getMyGuildMember` is `/users/@me/guilds/{id}/member`, which probably needs an OAuth bearer token; UNVERIFIED with a bot token.) |
| bot user ID | READY `d.user.id`, or `rest.getMyUser()` |
| exact permissions in an interaction | `interaction.app_permissions` (string bitfield, discord-api-types). dfx never reads it |

Race note: shards start while `DiscordGatewayLive` is being built, and the
prelude caches subscribe later. A cache can miss the first GUILD_CREATE; channels
and roles then recover through REST on `getForParent`. A cache fed by
`DispatchHook` cannot miss it.

## 6. Helpers/permissions (`Perms`)

### The code (quoted, `src/Helpers/permissions.ts`)

```ts
export const ALL = Flags.all(Discord.Permissions)
export const has = Flags.hasBigInt
export const toList = Flags.toList(Discord.Permissions)
export const fromList = Flags.fromListBigint(Discord.Permissions)

export const forRoles = (roles: Array<Discord.GuildRoleResponse>) =>
  roles.reduce((permissions, role) => permissions | BigInt(role.permissions), BigInt(0))

export const forMember = (roles: Array<Discord.GuildRoleResponse>) => (member: Discord.GuildMemberResponse) =>
  pipe(Members.roles(roles)(member), forRoles)

const overwriteIsForMember = (guildId?: string) => (member: Discord.GuildMemberResponse) =>
  (overwrite: Discord.ChannelPermissionOverwriteResponse) => {
    if (overwrite.type === 0) {
      return overwrite.id === guildId || member.roles.includes(overwrite.id)
    }
    return overwrite.id === member.user?.id
  }

export const forChannel = (roles: Array<Discord.GuildRoleResponse>) =>
  ({ guild_id, permission_overwrites }: Discord.GuildChannelResponse) =>
  (memberOrRole: Discord.GuildMemberResponse | Discord.GuildRoleResponse) => {
    const overwrites = permission_overwrites || []
    const hasAdmin = has(Discord.Permissions.Administrator)
    let basePermissions: bigint
    let filteredOverwrites: Array<Discord.ChannelPermissionOverwriteResponse>

    if (Members.is(memberOrRole)) {
      if ((memberOrRole as any).permissions)
        return BigInt((memberOrRole as any).permissions)

      const memberRoles = Members.roles(roles)(memberOrRole)
      basePermissions = forRoles(memberRoles)
      filteredOverwrites = overwrites.filter(overwriteIsForMember(guild_id)(memberOrRole))
    } else {
      const everyone = roles.find(role => role.name === "@everyone")
      basePermissions = BigInt(everyone?.permissions || "0") | BigInt(memberOrRole.permissions)
      filteredOverwrites = overwrites.filter(overwriteIsForRole(guild_id)(memberOrRole))
    }

    if (hasAdmin(basePermissions)) {
      return ALL
    }
    return applyOverwrites(basePermissions)(filteredOverwrites)
  }

export const applyOverwrites = (permissions: bigint) =>
  (overwrites: ReadonlyArray<Discord.ChannelPermissionOverwriteResponse>) =>
    overwrites.reduce((current, overwrite) => (current & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow), permissions)

export const hasInGuild = <E>(rolesCache: RolesCache<E>, permission: bigint) =>
  (guildId: Discord.Snowflake, member: Discord.GuildMemberResponse) =>
    Effect.map(rolesCache.getForParent(guildId), roles => {
      const hasPerm = has(permission)
      return member.roles.some(id => {
        const role = roles.get(id)
        return role ? hasPerm(role.permissions) : false
      })
    })
```

And from `Helpers/members.ts`:

```ts
export const roles = (guildRoles: Array<Discord.GuildRoleResponse>) => (member: Discord.GuildMemberResponse) =>
  guildRoles.filter(role => member.roles.includes(role.id) || role.name === "@everyone")
export const is = (thing: unknown): thing is Discord.GuildMemberResponse =>
  Object.prototype.hasOwnProperty.call(thing, "roles") && Object.prototype.hasOwnProperty.call(thing, "joined_at")
```

### What it computes

The member's base is the OR of the @everyone role (found **by name**) and the
member's roles. With Administrator in the base it returns `ALL`. Otherwise it
folds the matching overwrites (@everyone by `guild_id`, the member's roles, the
member by `user.id`) **in array order**, each as `(current & ~deny) | allow`. If
the member object has a truthy `permissions` field (interaction members do), it
returns that **without looking at the channel**.

### What it misses (`perms-runtime.ts`; "docs" means Discord's documented algorithm, which the live matrix still has to confirm)

| case | dfx | docs | cause |
|---|---|---|---|
| role A allow + role B deny on the same bit, array `[A, B]` | denied | allowed | sequential fold; Discord ORs all role denies, then ORs all role allows |
| same, array `[B, A]` | allowed | allowed | result depends on array order |
| member allow listed before @everyone deny | denied | allowed | no fixed @everyone → roles → member order |
| Administrator role + deny overwrite | ALL | ALL | correct |
| **guild owner** | not considered (`forChannel` never gets the guild or `owner_id`) | ALL | missing input |
| **timed-out member** (`communication_disabled_until` in the future) | SendMessages | only ViewChannel + ReadMessageHistory | ignored |
| **implicit:** ViewChannel denied, SendMessages allowed | SendMessages | none | implicit permissions ignored |
| **implicit:** SendMessages denied, EmbedLinks allowed | EmbedLinks | no EmbedLinks/AttachFiles/MentionEveryone/SendTTSMessages | implicit permissions ignored |
| @everyone role under another name (only the id is guaranteed) | base 0 | @everyone perms | found by name, not `id === guild_id` |
| channel without `guild_id` (as cached from GUILD_CREATE) + @everyone deny | allowed | denied | `overwrite.id === guildId` with `guildId` undefined skips the @everyone overwrite |
| interaction member with `permissions`, computed for another channel | the interaction channel's bits | that channel's bits | short-circuit |
| `hasInGuild` via @everyone only | false | true | ignores @everyone |
| `hasInGuild` via Administrator | false | true | ignores Administrator |
| **threads** | `forChannel` rejects `ThreadResponse` at compile time | perms come from the parent; SendMessagesInThreads replaces SendMessages; archived/locked state matters | no support |
| thread/channel state (archived, locked, slowmode) | not modelled | separate from permissions | out of scope for dfx |
| voice/stage implicit rules (e.g. Connect) | not modelled | UNVERIFIED which apply | |

`Perms.ALL` equals the OR of all 53 `PermissionFlagsBits` entries (52 distinct
bits). `ManageEmojisAndStickers` is a deprecated alias of the
`ManageGuildExpressions` bit, so `Perms.toList(ManageGuildExpressions)` returns
**both names**. Our generated `Missing*` classes must drop deprecated aliases.
Flag values are typed `bigint`, not literals, but the **keys** are literal names
(`keyof typeof Discord.Permissions`), so we can generate classes from them.

**Conclusion:** write our own resolver. Keep `Perms.has` (or plain bigint ops).
Do not use `forChannel`, `forMember` or `hasInGuild`.

## 7. Interactions (`Ix`, `InteractionsRegistry`)

### What exists

- Definitions: `Ix.global(command, handler)`, `Ix.guild(command, handler)`,
  `Ix.messageComponent(pred, effect)`, `Ix.modalSubmit(pred, effect)`,
  `Ix.autocomplete(pred, effect)`. The command type is
  `const A extends ApplicationCommandCreateRequest`. The handler is either an
  `Effect<CreateInteractionResponseRequest, E, R>` or
  `(ix: CommandHelper<A>) => Effect<...>`.
- Context services provided to handlers: `Ix.Interaction` (APIInteraction),
  `Ix.ApplicationCommand`, `Ix.MessageComponentData`, `Ix.ModalSubmitData`,
  `Ix.FocusedOptionContext`, `Ix.SubCommandContext`. The definition removes them
  from `R`.
- Predicates: `Ix.id(s)`, `Ix.idStartsWith(s)`, `Ix.idRegex(re)` for `custom_id`,
  and `Ix.option(cmd, opt)`, `Ix.optionOnly(opt)` for autocomplete.
- `CommandHelper<A>`: `optionValue(name)` (required options only),
  `optionValueOptional`, `optionValueOrElse`, `option`, `resolve(name, f)`,
  `resolvedValues(f)`, `subCommands({ name: effect })`, `optionsMap`, `target`.
- Accessors: `Ix.modalValue(name)` (fails with `NoSuchElementError`),
  `Ix.modalValues`, `Ix.focusedOptionValue`, `Ix.resolved`, `Ix.resolvedValues`,
  `Ix.currentSubCommand`.
- `Ix.response(r)` narrows the response to the `InteractionResponse` union: type
  4 / 7 with `data` and optional `files`, 9 with modal data, 5 / 6 with no data,
  8 with choices, 12.
- `Ix.builder.add(def)`, `.concat`, `.catchAllCause`, `.catchAll`, `.catchTag`,
  plus the `*Respond` variants, `.syncGlobal`, `.syncGuild(appId, guildId)`.
- `InteractionsRegistry.register(builder)` / `runIx(postHandler)(builder)`. For
  each `INTERACTION_CREATE` it dispatches by type, runs the handler, then posts
  the one returned response with `rest.createInteractionResponse` (using
  `withFiles` when the response has `files`).
- Webhook mode (`dfx/webhooks`) uses the same definitions, verified with
  `discord-verify`.

### What it does not do (each compiled or run)

- **Option typing is shallow.** `CommandValue` maps BOOLEAN → `boolean`,
  INTEGER/NUMBER → `number`, and **everything else → `string`**. Choices are not
  narrowed (`optionValue("color")` is `string`, not `"red" | "blue"`). A channel
  option gives a raw id `string`, not narrowed by `channel_types`. Required vs
  optional is enforced: `optionValue("count")` on an optional option is a
  compile error, and unknown names are rejected (`types-probe.ts` §8).
- **Subcommand option typing is unsound.** The required options of *every*
  subcommand are visible from every branch. In subcommand `a`,
  `ix.optionValue("only_in_b")` type-checks (`ix-subcommand-probe.ts`) and at
  runtime throws `Error: getOrThrow called on a None`, a defect
  (`ix-helper-runtime.ts`).
- `CommandHelper<any>` hits `TS2589: Type instantiation is excessively deep`
  when `optionValue` is called (seen in `ix-helper-runtime.ts`).
- **No definition rules.** An uppercase name with spaces over 32 chars, an
  optional option before a required one, and any number of options all compile
  (`ix-rules-probe.ts`). The registry dispatches commands by `data.name` only,
  into one `Commands` record, so a CHAT command and a USER/MESSAGE context
  command with the same name overwrite each other (read from
  `Interactions/utils.ts` `splitDefinitions`).
- **No response state machine.** Every handler returns one
  `CreateInteractionResponseRequest`. A modal-submit handler may return MODAL,
  and an autocomplete handler may return a channel message (both compile). There
  are no follow-up or edit-original helpers (use `rest.executeWebhook`,
  `rest.updateOriginalWebhookMessage`, `rest.getOriginalWebhookMessage` directly).
  **No auto-defer.** The response is posted when the handler finishes, so a
  handler slower than 3 s loses the interaction.
- **No `custom_id` schema.** Routing is a string predicate and the first match
  wins. Nothing decodes data or checks the 100-char limit (`UI.button({ custom_id:
  "x".repeat(500) })` compiles).
- `Ix.response` / `UI.components` do not check flag contexts. `IsComponentsV2 |
  SuppressNotifications` together with `content` compiles.
- **Registration has no diffing.** `run` calls `getMyApplication()`, then
  `bulkSetApplicationCommands(app.id, all globals)` on every (re)register. Guild
  commands are bulk-set to *every* guild in `listMyGuilds` and again on every
  `GUILD_CREATE`. `setInteractionsSync(false)` turns syncing off.
- **Each `register` restarts the runner after `Effect.delay(5 seconds)`**
  (`foreverSwitch`). Interactions that arrive in that window get no handler.
- **The error boundary is stricter than our rule.**
  `register: <E>(ix: InteractionBuilder<never, E, never>)` requires the builder's
  `TE` (handler errors plus `DiscordRESTError` from posting the response) to be
  `never` (`ix-boundary-probe.ts`). Unhandled transient errors are therefore a
  compile error, while our rule allows them. `builder.catchTag("Boom", ...)`
  removes exactly `Boom`.
- Interactions use discord-api-types types (§4), so `ix.member` cannot go into
  `Perms` without a conversion. `app_permissions` is available on the payload as
  a string.
- `handle[i.type](i)` has no fallback for unknown interaction types; a new type
  would crash with a TypeError (read from source).

**Recommendation:** do not wrap `Ix`. Build our own interactions layer on
`gateway.fromDispatch("INTERACTION_CREATE")` (or a `DispatchHook`-fed queue) and
`rest.createInteractionResponse` / webhook endpoints. Run it on `DiscordLive`,
not `DiscordIxLive`, or with `setInteractionsSync(false)`. If useful, reuse the
pure helpers in `IxHelpers` (`optionsWithNested`, `focusedOption`,
`componentsMap`, ...) and the `UI` constructors.

## 8. Effect v4 idioms dfx uses (match these)

Effect 4.1.1 has **no `ServiceMap` module**; services are `Context.Service`.

- Class-style service: `class DiscordREST extends Context.Service<DiscordREST, DiscordRestService>()("dfx/DiscordREST") {}`, with `DiscordREST.of({...})` and `DiscordREST.use(rest => ...)`.
- Function-style service: `export const DiscordGateway = Context.Service<DiscordGateway>("dfx/DiscordGateway")`.
- Service with a `make`: `class Messaging extends Context.Service<Messaging>()("dfx/DiscordGateway/Messaging", { make }) {}`.
- References with defaults: `Context.Reference("dfx/Interactions/sync", { defaultValue: () => true })`, and `DispatchHook`.
- Layers: `Layer.effect(Tag, make)`, `Layer.succeed`, `Layer.sync`, `Layer.provide`, `Layer.provideMerge`, `Layer.mergeAll`, `Layer.effectDiscard`, `Layer.launch`.
- Effects: `Effect.gen`, `Effect.fnUntraced` (dfx uses no `Effect.fn` spans; its only spans are `dfx.Interaction` and Effect's own HTTP client spans), `Effect.forkScoped`, `Effect.forkChild`, `Effect.catch` (v4 name for catchAll), `Effect.catchCause`, `Effect.catchTag`, `Effect.Success/Error/Services<>` type helpers.
- Errors: `Data.Error` and `Data.TaggedError`, never `Schema`. Some error classes are hand-rolled (`class DefinitionNotFound { readonly _tag = ... }`, `RequiredOptionNotFound`, `BadWebhookSignature`); these are not `YieldableError`s.
- Config: `Config.Wrap<T>` / `Config.unwrap`; `Config.Redacted(name)`.

Relevant Effect v4 facts for our error design (compiled):

- `Effect.catchIf(refinement, f)` removes exactly the refined members from `E`.
  With a category marker on the instance type (`Schema.TaggedError<Self,
  Brand>()` has a second `Brand` generic that is intersected into the instance
  type), `catchIf(isCategory("permission"))` removed exactly
  `MissingSendMessages | MissingEmbedLinks` and left `Transient`
  (`category-probe.ts`). So `catchCategory` can be a thin wrapper over
  `Effect.catchIf`. Neither dfx nor Effect ships a category concept.
- `Effect.catchReason` / `Effect.catchReasons("HttpClientError", {
  TransportError, StatusCodeError, ... })` work on dfx's `HttpClientError`,
  because it has a tagged `reason` (`reason-probe.ts`). This is a clean way to
  split transport and 5xx (transient) from decode, encode and URL errors
  (defect).
- `Schema.TaggedError<Self>()("Tag", fields)` is the v4 Schema tagged error (the
  brief requires Schema tagged errors with declared fields).

## 9. What gets in the way of our requirements

| requirement | obstacle in dfx | workaround |
|---|---|---|
| per-cause tagged errors | All 4xx share `_tag: "ErrorResponse"`, with the code only in `data.code`. 5xx and decode problems are the same `HttpClientError`. `RatelimitedResponse` is typed but unreachable. `.code` is typed but undefined. | Map in our wrapper: `catchTag("ErrorResponse", e => byCode(e.data.code, e.response.status))`, `catchReasons("HttpClientError", ...)`. Never read `e.code`. |
| `cause` with code, message, route; no `unknown` | `ErrorResponse.errors: Record<string, unknown> | InnerErrors`; request and response are live objects | Our own Schema struct for the cause (code, message, status, method, route template, `errors` as `Schema.Json` or a typed tree) |
| transient = gave-up retries | the 429 retry never gives up | `Effect.timeout` (or a deadline) per wrapped call → typed transient error |
| malformed response = defect | 2xx bodies are cast; malformed JSON → typed `HttpClientError(DecodeError)` | Decode the responses we expose with Schema → `orDie` on a decode failure, and turn a 2xx `DecodeError` into a defect |
| branded IDs | params and responses are `string`; nothing stops passing a `MessageId` as a channel id (`types-probe.ts` §4) | Our ops take branded IDs (assignable to dfx's `string`, no cast) and brand the IDs in responses (by Schema decode) |
| channel-kind unions | one `GuildChannelResponse` for types 0/2/4/5/13/14/15, `ThreadResponse` for 10/11/12; **GuildMedia (16) is missing from `ChannelTypes` and every response type**; `createMessage` takes any channel id | Our own union decoded from `type` (and from dispatches), including 16. Kind-specific operations live on our channel types |
| payload-dependent permissions and rules | request types are flat optional bags; `{}` is a valid `MessageCreateRequest`; no component, flag or allowed_mentions rules | Our payload types, converted to dfx's request types at the edge |
| intent-typed events | `intents: number`; event types ignore intents; `content: string` always | A literal intents tuple in our `Bot` config; our `Bot.on` maps event names to intent requirements and field availability; dfx's `fromDispatch` underneath |
| handler boundary allows unhandled transient | `handleDispatch` dies on the first failure; `InteractionsRegistry` requires all errors handled | Our `Bot.on` and command runners catch and log transient errors per event; do not use `register` |
| permission state for preflight and 50013 recompute | no member cache; the guild cache drops roles and members; role `get` has no REST fallback; GUILD_CREATE channels may lack `guild_id` | Our own state store fed by `DispatchHook`, with explicit REST refresh (`getChannel`, `listGuildRoles`, `getGuildMember`, `getGuild`) for the recompute step |
| spans before recovery | dfx adds no spans on REST calls (only Effect's per-request `"POST"`-named span) | `Effect.withSpan` in our wrapper, inside and before our `catchTag` mapping; optionally a `SpanNameGenerator` with the route |
| live runs must respect limits | dfx counts invalid requests only for 403/429 and only against its own 10k / 10 min counter; 401s are not counted | The matrix produces many intentional 403s. Pace it well under 10,000 invalid requests per 10 min (Discord's Cloudflare limit), and log the counts |

dfx has nothing that makes these impossible. All the information we need (status,
Discord code, method, URL, the `errors` tree) reaches us, and every hard
guarantee lives in our wrapper types.

## 10. Decisions this raises

1. **Cache:** use dfx's `CachePrelude` channels and roles plus our own member
   cache, or build one state store fed by `DispatchHook` (recommended: race-free,
   fills in `guild_id`, tracks the bot member and timeouts)?
2. **Bounding 429s:** what deadline per call, and is a given-up rate limit one
   transient tag (`RateLimited`) or part of a general `RequestTimedOut`?
3. **`RatelimitedResponse` (typed, unreachable):** map it to a transient tag or
   treat it as a defect?
4. **2xx `DecodeError` and response validation:** Schema-decode every response
   we expose (cost: decode time, and schemas for each response) and make a
   mismatch a defect, or trust dfx's casts for some endpoints?
5. **Interactions:** confirm we replace `Ix`/`InteractionsRegistry` rather than
   wrap them, and whether to reuse `IxHelpers` and `UI`.
6. **Credentials:** Bun auto-loads `.env` into `process.env`. Is that acceptable
   as "explicit binding" through `Config.Redacted`, or should the harness run
   with `--no-env-file` and parse `.env` itself into `DiscordConfig.layer({
   token: Redacted.make(...) })`?
7. **Fail-fast startup:** add an auth and privileged-intent check
   (`getMyUser`, `getMyApplication().flags`), because dfx reconnects forever on
   4004/4014.
8. **Type universe:** normalise interaction payloads (discord-api-types) and REST
   payloads (generated) into one set of our own types at the boundary.
9. **Command registration:** turn off dfx sync and do our own diff with
   `listApplicationCommands` / `bulkSetGuildApplicationCommands` against Perms Lab
   only (the dfx guild sync would PUT to every guild the bot is in).

## 11. UNVERIFIED

- Whether Discord omits `guild_id` on channel objects in GUILD_CREATE (and so
  whether the prelude-cached channels make `Perms.forChannel` skip @everyone
  overwrites in practice).
- Whether GUILD_CREATE `members` always includes the bot's own member, and
  whether GUILD_MEMBER_UPDATE for the bot itself arrives without GuildMembers.
- Live behaviour on close codes 4004 and 4014 (read from source: a silent
  reconnect loop).
- Whether `rest.getMyGuildMember` works with a bot token.
- Which Discord OpenAPI spec revision `Generated.ts` was built from.
- Whether `DiscordRESTLive`, provided both inside `SharderLive` and at the top
  of `DiscordLive`, is one instance through layer memoization or two (it only
  affects the in-memory `badRoutes` set; the `RateLimitStore` is shared either
  way).
- The Discord-side rules in §6's "docs" column (overwrite order, timeouts,
  implicit permissions, threads, voice). They describe Discord's documentation;
  the live matrix decides.
- Whether re-PUTting identical commands counts toward Discord's daily
  command-create limit.
- The network `TransportError` path (read from Effect source; not triggered).
