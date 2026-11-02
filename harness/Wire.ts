/**
 * Schemas for the Discord objects the harness reads, and its raw-request helper.
 *
 * dfx casts every 2xx body to its generated type without validating it (dfx.md §3), so the harness decodes
 * each body it relies on with these schemas. Only the fields the harness uses are listed; excess fields are
 * ignored. A body that does not decode is a defect: the harness would otherwise act on data it misread.
 *
 * `raw` sends a request through an identity's `rest.httpClient` (authenticated, rate-limited, and, below dfx,
 * guarded and paced) for routes dfx cannot express: creating a GuildMedia (16) channel, which dfx's generated
 * request type lacks (dfx.md §0), and the permission oracle (`src/rest/Oracle.ts`).
 */
import type { DiscordRestService } from "dfx/DiscordREST"
import { Clock, Duration, Effect, Option, Schema } from "effect"
import * as Headers from "effect/http/Headers"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { DiscordErrorBody } from "../src/rest/ErrorMap.ts"
import { ChannelId, EmojiId, GuildId, MessageId, RoleId, StickerId, UserId } from "../src/Snowflake.ts"
import { LabRequestFailed, labStepDeadline } from "./Lab.ts"

/** A permission bitfield as Discord serialises it: a decimal string. */
export const Bitfield = Schema.String.check(Schema.isPattern(/^\d+$/))

/** A channel permission overwrite. `type` 0 is a role, 1 a member. */
export const Overwrite = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals([0, 1]),
  allow: Bitfield,
  deny: Bitfield
})
/** A channel permission overwrite. */
export type Overwrite = typeof Overwrite.Type

/** A forum or media tag. */
export const ForumTag = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  moderated: Schema.Boolean,
  emoji_id: Schema.NullOr(Schema.String),
  emoji_name: Schema.NullOr(Schema.String)
})
/** A forum or media tag. */
export type ForumTag = typeof ForumTag.Type

/** A guild channel or thread. */
export const Channel = Schema.Struct({
  id: ChannelId,
  type: Schema.Int,
  name: Schema.String,
  guild_id: Schema.optionalKey(GuildId),
  parent_id: Schema.optionalKey(Schema.NullOr(ChannelId)),
  flags: Schema.optionalKey(Schema.Int),
  rate_limit_per_user: Schema.optionalKey(Schema.Int),
  permission_overwrites: Schema.optionalKey(Schema.Array(Overwrite)),
  available_tags: Schema.optionalKey(Schema.Array(ForumTag)),
  owner_id: Schema.optionalKey(UserId),
  thread_metadata: Schema.optionalKey(
    Schema.Struct({
      archived: Schema.Boolean,
      locked: Schema.Boolean,
      auto_archive_duration: Schema.Int,
      archive_timestamp: Schema.optionalKey(Schema.NullOr(Schema.String))
    })
  )
})
/** A guild channel or thread. */
export type Channel = typeof Channel.Type

/** A guild role. `tags.bot_id` marks a bot's managed role. */
export const Role = Schema.Struct({
  id: RoleId,
  name: Schema.String,
  permissions: Bitfield,
  position: Schema.Int,
  managed: Schema.Boolean,
  mentionable: Schema.Boolean,
  tags: Schema.optionalKey(Schema.Struct({ bot_id: Schema.optionalKey(UserId) }))
})
/** A guild role. */
export type Role = typeof Role.Type

/** A guild member. */
export const Member = Schema.Struct({
  user: Schema.Struct({ id: UserId }),
  roles: Schema.Array(RoleId),
  nick: Schema.optionalKey(Schema.NullOr(Schema.String)),
  communication_disabled_until: Schema.optionalKey(Schema.NullOr(Schema.String))
})
/** A guild member. */
export type Member = typeof Member.Type

/** The guild. */
export const Guild = Schema.Struct({
  id: GuildId,
  name: Schema.String,
  owner_id: UserId,
  mfa_level: Schema.Int,
  rules_channel_id: Schema.NullOr(ChannelId),
  public_updates_channel_id: Schema.NullOr(ChannelId),
  features: Schema.Array(Schema.String)
})
/** The guild. */
export type Guild = typeof Guild.Type

/** A page of threads (active or archived). */
export const ThreadPage = Schema.Struct({
  threads: Schema.Array(Channel),
  has_more: Schema.optionalKey(Schema.Boolean)
})

/** A message, as far as reset needs it. */
export const Message = Schema.Struct({
  id: MessageId,
  type: Schema.Int,
  author: Schema.Struct({ id: UserId }),
  pinned: Schema.Boolean
})
/** A message. */
export type Message = typeof Message.Type

/** A page of pins (the paginated pins route). */
export const PinPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ pinned_at: Schema.String, message: Message })),
  has_more: Schema.Boolean
})

/** A thread member. */
export const ThreadMember = Schema.Struct({ user_id: UserId })

/** An application command, as far as reset needs it. */
export const Command = Schema.Struct({ id: Schema.String, name: Schema.String })

/** An AutoMod rule, as far as reset needs it. */
export const AutoModRule = Schema.Struct({ id: Schema.String, name: Schema.String })

/** A guild sticker. */
export const Sticker = Schema.Struct({ id: StickerId, name: Schema.String })

/** A guild emoji. */
export const Emoji = Schema.Struct({ id: EmojiId, name: Schema.String })

/** Decodes a body the harness received from Discord. A mismatch is a defect naming `what`. */
export const decode =
  <S extends Schema.Codec<unknown, unknown>>(schema: S, what: string) =>
  (body: unknown): Effect.Effect<S["Type"]> =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError((error) => new Error(`${what}: unexpected response shape: ${error.message}`)),
      Effect.orDie
    )

/** A raw request's outcome: the status, the response headers, and the decoded JSON body (or `None` for an empty or non-JSON body). */
export interface RawResponse {
  readonly status: number
  readonly headers: Headers.Headers
  readonly body: Option.Option<unknown>
}

/**
 * Sends `method path` with an optional JSON body through `rest.httpClient`. Never fails on a status: the
 * caller decides. A transport failure is `LabRequestFailed` with status 0.
 */
export const raw = (
  rest: DiscordRestService,
  step: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  options: { readonly body?: unknown; readonly urlParams?: Readonly<Record<string, string>> } = {}
): Effect.Effect<RawResponse, LabRequestFailed> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const base = HttpClientRequest.make(method)(path, options.urlParams === undefined ? undefined : { urlParams: options.urlParams })
    const request = options.body === undefined ? base : yield* HttpClientRequest.bodyJson(base, options.body).pipe(Effect.orDie)
    const response = yield* rest.httpClient.execute(request).pipe(
      Effect.catch((error) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            error.reason._tag === "TransportError"
              ? Effect.fail(new LabRequestFailed({ step, status: 0, code: 0, message: `no response (transport after ${now - started} ms)` }))
              : Effect.die(new Error(`${step}: ${error.reason._tag}`))
          )
        )
      ),
      Effect.timeoutOrElse({
        duration: labStepDeadline,
        orElse: () => Effect.fail(new LabRequestFailed({ step, status: 0, code: 0, message: `no response within ${Duration.format(labStepDeadline)}` }))
      })
    )
    const body = yield* response.json.pipe(Effect.option)
    return { status: response.status, headers: response.headers, body }
  })

/** Fails with `LabRequestFailed` unless the raw response is a 2xx; copies Discord's code and message when present. */
export const ensureOk = (step: string, response: RawResponse): Effect.Effect<Option.Option<unknown>, LabRequestFailed> => {
  if (response.status >= 200 && response.status < 300) return Effect.succeed(response.body)
  const error = Option.flatMap(response.body, Schema.decodeUnknownOption(DiscordErrorBody))
  return Effect.fail(
    new LabRequestFailed({
      step,
      status: response.status,
      code: Option.match(error, { onNone: () => 0, onSome: (body) => body.code }),
      message: Option.match(error, { onNone: () => "non-JSON error body", onSome: (body) => body.message })
    })
  )
}
