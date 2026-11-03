/**
 * Error mapping (DESIGN §3.1, §4.9): from what dfx failed with to what the operation fails with.
 *
 * **1. `classify`: dfx's failure shapes (dfx.md §3) copied into our serialisable causes.**
 *
 * - `DiscordRestError("ErrorResponse")`: a 4xx with a JSON body. The code is read from `e.data.code`, never
 *   `e.code` (dfx's type claims a `code` that is `undefined` at run time). The inner 50035 tree is flattened
 *   into `FieldError`s with codes normalised to strings (H-084).
 * - `HttpClientError`:
 *   - `TransportError` -> no response (`NoResponse`, reason `transport`);
 *   - `StatusCodeError` carrying a `Coded429` (the interceptor, `Coded429.ts`) -> a Discord answer with status
 *     429, its code and its `retry_after`;
 *   - `StatusCodeError` with status >= 500 -> Discord unavailable, with the response;
 *   - `DecodeError` on a 4xx or 5xx (an HTML page from Cloudflare) -> Discord unavailable;
 *   - `DecodeError` on a 2xx, `EmptyBodyError`, `EncodeError`, `InvalidUrlError`, and any other `StatusCodeError`
 *     below 500 (dfx's "unexpected status") -> defects.
 * - `DiscordRestError("RatelimitedResponse")`: dfx retries every uncoded 429 itself, so this is a defect (D10).
 *
 * Live request and response objects are never retained: only status, code, message, method, route template
 * and field errors are copied.
 *
 * **2. `mapResponse`: the `(operation, status, code, inner path) -> tag` table.** {@link Codes} says what each
 * code means and which statuses it comes with (observed live where the truth table has it, otherwise the
 * hypothesis of discord-semantics §8.1). For one request, a code maps only when its tag is one the operation
 * declares: a tag of its row in the operation table, a missing flag of the request's own requirements, or a
 * payload- or argument-derived tag the request declares through its {@link LimitFacts} (§2.3-§2.6). Anything
 * else is unmapped, which the caller turns into an {@link UnmappedDiscordError} defect, so the matrix has to find
 * it (§3.1). 50013, 50001 and the dedicated permission-like codes 160002, 160005 and 50083 map to the recompute
 * (`permissions/Recompute.ts`), with the code's own tag as the fallback when the recompute finds nothing (§3.2).
 */
import type { DiscordRESTError } from "dfx/DiscordREST"
import { Effect, Schema } from "effect"
import { DiscordResponse, FieldError, HttpMethod, NoResponse } from "../errors/Cause.ts"
import type { PermissionFlag } from "../errors/Missing.generated.ts"
import { ContentTooLong, EmbedTooLarge, MessageEmpty, MessagesTooOld, NameTooLong, NicknameTooLong, PollTooLarge, SlowmodeOutOfRange, TimeoutTooLong, TooManyMessagesToDelete, TopicTooLong } from "../errors/Payload.ts"
import { PermissionDeniedUnattributed } from "../errors/Permission.ts"
import {
  AlreadyCrossposted,
  CannotMessageUser,
  MaximumActiveThreads,
  MaximumPinsReached,
  MaximumReactionsReached,
  SlowmodeActive,
  TagRequired,
  ThreadAlreadyExists,
  ThreadArchived,
  ThreadLocked,
  TwoFactorRequired,
  UnknownChannel,
  UnknownEmoji,
  UnknownMember,
  UnknownMessage,
  UnknownRole
} from "../errors/State.ts"
import { RateLimited } from "../errors/Transient.ts"
import { Observed } from "../permissions/Observed.ts"
import { errorFor, type OpName, Operations, type OpPermissionErrors, type OpSpec, type TagName } from "../permissions/Operations.ts"
import { type DecideArgs, errorModeFlags } from "../permissions/Preflight.ts"
import { Coded429 } from "./Coded429.ts"

// ---- 1. classify ----------------------------------------------------------------------------------------

/** A dfx failure, classified. */
export type DfxFailure =
  /**
   * Discord answered with a JSON error body (a 4xx, or a coded 429 the interceptor surfaced). `retryAfterMs` is
   * the body's `retry_after` when it has one (a coded 429's always does).
   */
  | { readonly _tag: "Response"; readonly response: DiscordResponse; readonly retryAfterMs: number | undefined }
  /** Discord answered 5xx, or a 4xx without a JSON body. */
  | { readonly _tag: "Unavailable"; readonly response: DiscordResponse }
  /** No response at all (a transport error). */
  | { readonly _tag: "NoResponse"; readonly cause: NoResponse }

interface ErrorLeaf {
  readonly code: string | number
  readonly message: string
}
interface ErrorTree {
  readonly [key: string]: ErrorTree | ReadonlyArray<ErrorLeaf>
}

const ErrorLeafSchema = Schema.Struct({ code: Schema.Union([Schema.String, Schema.Number]), message: Schema.String })
const ErrorTreeSchema: Schema.Codec<ErrorTree> = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Array(ErrorLeafSchema), Schema.suspend((): Schema.Codec<ErrorTree> => ErrorTreeSchema)])
)

/** Discord's JSON error body (REF "Error Messages"). `errors` is present only on 50035 and a few others. */
export const DiscordErrorBody = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  errors: Schema.optionalKey(ErrorTreeSchema),
  /** Seconds; on rate-limit answers (REF "Rate Limits"). */
  retry_after: Schema.optionalKey(Schema.Number)
})

const decodeBody = Schema.decodeUnknownEffect(DiscordErrorBody)
const decodeMethod = Schema.decodeUnknownEffect(HttpMethod)

const isLeafList = (value: ErrorTree | ReadonlyArray<ErrorLeaf>): value is ReadonlyArray<ErrorLeaf> => Array.isArray(value)

/**
 * Flattens the nested 50035 `errors` tree into field errors, in document order. `_errors` lists sit under the
 * path of their parent keys; inner codes become strings.
 */
export const flattenFieldErrors = (tree: ErrorTree, path: ReadonlyArray<string> = []): ReadonlyArray<FieldError> =>
  Object.entries(tree).flatMap(([key, value]) =>
    isLeafList(value)
      ? key === "_errors"
        ? value.map((leaf) => new FieldError({ path, code: String(leaf.code), message: leaf.message }))
        : []
      : flattenFieldErrors(value, [...path, key])
  )

const defect = (route: string, what: string) => Effect.die(new Error(`${route}: ${what}`))

/**
 * Classifies a dfx failure for the request made on `route` (a template, never a URL). Never fails: anything
 * that is not a Discord answer or a missing answer is a defect.
 */
export const classify = (error: DiscordRESTError, route: string, afterMs: number): Effect.Effect<DfxFailure> =>
  Effect.gen(function* () {
    const method = yield* decodeMethod(error.request.method).pipe(Effect.orDie)
    const fromStatus = (status: number, message: string) =>
      new DiscordResponse({ status, code: 0, message, method, route, fieldErrors: [], attributedBy: "code" })
    switch (error._tag) {
      case "ErrorResponse": {
        const body = yield* decodeBody(error.data).pipe(Effect.catch(() => defect(route, `malformed Discord error body (status ${error.response.status})`)))
        const fieldErrors = body.errors === undefined ? [] : flattenFieldErrors(body.errors)
        return {
          _tag: "Response",
          response: new DiscordResponse({ status: error.response.status, code: body.code, message: body.message, method, route, fieldErrors, attributedBy: "code" }),
          retryAfterMs: body.retry_after === undefined ? undefined : Math.ceil(body.retry_after * 1000)
        }
      }
      case "RatelimitedResponse":
        return yield* defect(route, "a rate-limited response escaped dfx's retry loop (D10)")
      case "HttpClientError": {
        const reason = error.reason
        switch (reason._tag) {
          case "TransportError":
            return { _tag: "NoResponse", cause: new NoResponse({ route, method, reason: "transport", afterMs }) }
          case "StatusCodeError": {
            const coded = reason.cause
            if (coded instanceof Coded429) {
              return {
                _tag: "Response",
                response: new DiscordResponse({ status: reason.response.status, code: coded.code, message: coded.message, method, route, fieldErrors: [], attributedBy: "code" }),
                retryAfterMs: coded.retryAfterMs
              }
            }
            return reason.response.status >= 500
              ? { _tag: "Unavailable", response: fromStatus(reason.response.status, "Discord unavailable") }
              : yield* defect(route, `unexpected status ${reason.response.status}`)
          }
          case "DecodeError":
            return reason.response.status >= 400
              ? { _tag: "Unavailable", response: fromStatus(reason.response.status, "non-JSON error body") }
              : yield* defect(route, `malformed ${reason.response.status} body`)
          case "EmptyBodyError":
          case "EncodeError":
          case "InvalidUrlError":
            return yield* defect(route, reason._tag)
        }
      }
    }
  })

// ---- 2. the table ---------------------------------------------------------------------------------------

/** The state tags a Discord code names directly (no recompute): each must be in the operation's row. */
type CodeTag =
  | "UnknownChannel"
  | "UnknownMember"
  | "UnknownMessage"
  | "UnknownRole"
  | "UnknownEmoji"
  | "MaximumPinsReached"
  | "MaximumReactionsReached"
  | "AlreadyCrossposted"
  | "TagRequired"
  | "CannotMessageUser"
  | "TwoFactorRequired"
  | "ThreadAlreadyExists"
  | "MaximumActiveThreads"
  | "MessagesTooOld"

/** The tag a recompute that finds nothing falls back to (§4.9): Unattributed, or the dedicated code's own tag. */
type FallbackTag = "PermissionDeniedUnattributed" | "ThreadLocked" | "ThreadArchived" | "MissingReadMessageHistory"

/** What a Discord code means, before the operation is known. */
export type Meaning =
  /** A permission-like refusal: the recompute attributes it (§4.9), falling back to `fallback`. */
  | { readonly _tag: "Recompute"; readonly fallback: FallbackTag }
  /** A state the code names. */
  | { readonly _tag: "Tag"; readonly tag: CodeTag }
  /** A coded rate limit (`retry_after` required): `RateLimited` (transient), or `SlowmodeActive` while observed. */
  | { readonly _tag: "RateLimit"; readonly tag: "RateLimited" | "SlowmodeActive" }
  /** 50006: nothing in the message (`MessageEmpty`, when the request may be empty). */
  | { readonly _tag: "Empty" }
  /** 50016: too many messages to bulk delete (`TooManyMessagesToDelete`, with the request's count). */
  | { readonly _tag: "Count" }
  /** 50035: the inner errors' paths name the limit (§4.9). */
  | { readonly _tag: "Fields" }

/** One code: the statuses it comes with, and its meaning. */
export interface CodeEntry {
  readonly statuses: ReadonlyArray<number>
  readonly meaning: Meaning
}

/**
 * Every code the library maps (§3.1). Statuses observed by the M4 matrix: 50013 and 50001 (403), 50083 (400),
 * 40067 (400), 160002 (403), 160005 (403). The rest are the statuses discord-semantics §8.1 and DESIGN §3.1 give
 * (20016: a coded 429 or 400, the only code they give two for); a status outside the list is unmapped (H-082). Phase-3 codes (InteractionExpired) and
 * command registration (30034, `DailyCommandCreateLimit`) are mapped by their own modules (M8, M9).
 */
export const Codes: { readonly [code: number]: CodeEntry } = {
  50001: { statuses: [403], meaning: { _tag: "Recompute", fallback: "PermissionDeniedUnattributed" } },
  50013: { statuses: [403], meaning: { _tag: "Recompute", fallback: "PermissionDeniedUnattributed" } },
  160002: { statuses: [403], meaning: { _tag: "Recompute", fallback: "MissingReadMessageHistory" } },
  160005: { statuses: [403], meaning: { _tag: "Recompute", fallback: "ThreadLocked" } },
  50083: { statuses: [400], meaning: { _tag: "Recompute", fallback: "ThreadArchived" } },
  10003: { statuses: [404], meaning: { _tag: "Tag", tag: "UnknownChannel" } },
  10007: { statuses: [404], meaning: { _tag: "Tag", tag: "UnknownMember" } },
  10008: { statuses: [404], meaning: { _tag: "Tag", tag: "UnknownMessage" } },
  10011: { statuses: [404], meaning: { _tag: "Tag", tag: "UnknownRole" } },
  10014: { statuses: [404], meaning: { _tag: "Tag", tag: "UnknownEmoji" } },
  30003: { statuses: [400], meaning: { _tag: "Tag", tag: "MaximumPinsReached" } },
  30010: { statuses: [400], meaning: { _tag: "Tag", tag: "MaximumReactionsReached" } },
  40033: { statuses: [400], meaning: { _tag: "Tag", tag: "AlreadyCrossposted" } },
  40067: { statuses: [400], meaning: { _tag: "Tag", tag: "TagRequired" } },
  50007: { statuses: [403], meaning: { _tag: "Tag", tag: "CannotMessageUser" } },
  60003: { statuses: [403], meaning: { _tag: "Tag", tag: "TwoFactorRequired" } },
  160004: { statuses: [400], meaning: { _tag: "Tag", tag: "ThreadAlreadyExists" } },
  160006: { statuses: [400], meaning: { _tag: "Tag", tag: "MaximumActiveThreads" } },
  50034: { statuses: [400], meaning: { _tag: "Tag", tag: "MessagesTooOld" } },
  20016: { statuses: [429, 400], meaning: { _tag: "RateLimit", tag: "SlowmodeActive" } },
  20022: { statuses: [429], meaning: { _tag: "RateLimit", tag: "RateLimited" } },
  20028: { statuses: [429], meaning: { _tag: "RateLimit", tag: "RateLimited" } },
  30046: { statuses: [429], meaning: { _tag: "RateLimit", tag: "RateLimited" } },
  50006: { statuses: [400], meaning: { _tag: "Empty" } },
  50016: { statuses: [400], meaning: { _tag: "Count" } },
  50035: { statuses: [400], meaning: { _tag: "Fields" } }
}

/** Every mapped code, ascending. */
export const codes: ReadonlyArray<number> = Object.keys(Codes)
  .map(Number)
  .sort((a, b) => a - b)

const tagOfMeaning = (meaning: Meaning): string | undefined => {
  switch (meaning._tag) {
    case "Recompute":
      return meaning.fallback === "PermissionDeniedUnattributed" ? undefined : meaning.fallback
    case "Tag":
    case "RateLimit":
      return meaning.tag
    case "Empty":
      return "MessageEmpty"
    case "Count":
      return "TooManyMessagesToDelete"
    case "Fields":
      return undefined
  }
}

/**
 * The tag each code names before any recompute or path refinement: the matrix records it as `raw.mappedTag`, and
 * agreement accepts it when it is in the row's `preflightSet` (§3.2). 50013, 50001 and 50035 have none.
 */
export const dedicatedCodeTags: ReadonlyMap<number, string> = new Map(
  codes.flatMap((code): ReadonlyArray<readonly [number, string]> => {
    const entry = Codes[code]
    const tag = entry === undefined ? undefined : tagOfMeaning(entry.meaning)
    return tag === undefined ? [] : [[code, tag]]
  })
)

// ---- limits: the payload- and argument-derived tags a request declares ----------------------------------

/** A length a request carries, with the limit `Limits` gives it (M6). */
export interface Length {
  readonly length: number
  readonly limit: number
}

/**
 * The payload- and argument-derived tags a request's type declares (§2.3-§2.6), with what building them needs.
 * A key is present exactly when the operation's signature for this request includes the tag; a 50035 on a field
 * the request does not declare, or a 50006 on a request that cannot be empty, is unmapped.
 */
export interface LimitFacts {
  /** `MessageEmpty` (50006): the payload may be empty. */
  readonly empty?: true
  /** `ContentTooLong`: the content is not a finite literal. */
  readonly content?: Length
  /** `EmbedTooLarge`: the payload may carry embeds. */
  readonly embeds?: true
  /** `PollTooLarge`: the payload may carry a poll. */
  readonly poll?: true
  /** `NameTooLong`: a channel, thread or post name that is not a finite literal. */
  readonly name?: Length
  /** `TopicTooLong`. */
  readonly topic?: Length
  /** `SlowmodeOutOfRange`, with the requested seconds. */
  readonly slowmode?: { readonly seconds: number }
  /** `NicknameTooLong`. */
  readonly nick?: Length
  /** `TimeoutTooLong`: a timeout with a date. */
  readonly timeout?: true
  /** `TooManyMessagesToDelete` (50016): a bulk delete's message count. */
  readonly messageCount?: number
}

/** A limit field. */
export type LimitField = keyof LimitFacts

/** Every limit field, in declaration order. */
export const limitFieldNames: ReadonlyArray<LimitField> = ["empty", "content", "embeds", "poll", "name", "topic", "slowmode", "nick", "timeout", "messageCount"]

/** The limit fields each operation's requests may declare (§2.3-§2.6); other operations declare none. */
export const limitFields: { readonly [Op in OpName]?: ReadonlyArray<LimitField> } = {
  "channel.send": ["empty", "content", "embeds", "poll"],
  "thread.send": ["empty", "content", "embeds", "poll"],
  "voice.send": ["empty", "content", "embeds", "poll"],
  "dm.send": ["empty", "content", "embeds", "poll"],
  "forum.createPost": ["empty", "content", "embeds", "poll", "name"],
  "message.edit.channel": ["empty", "content", "embeds"],
  "message.edit.thread": ["empty", "content", "embeds"],
  "message.edit.voice": ["empty", "content", "embeds"],
  "channel.createThread.public": ["name"],
  "channel.createThread.private": ["name"],
  "channel.edit": ["name", "topic", "slowmode"],
  "voice.edit": ["name", "slowmode"],
  "thread.edit": ["name", "slowmode"],
  "member.setNickname": ["nick"],
  "member.timeout": ["timeout"],
  "channel.bulkDelete": ["messageCount"],
  "thread.bulkDelete": ["messageCount"],
  "voice.bulkDelete": ["messageCount"]
}

/** The fields `limits` declares that `op`'s requests may not (a library bug); empty when it is consistent. */
export const undeclarableFields = (op: OpName, limits: LimitFacts): ReadonlyArray<LimitField> => {
  const allowed = limitFields[op] ?? []
  return limitFieldNames.filter((field) => limits[field] !== undefined && !allowed.includes(field))
}

/** The 50035 field errors' tags, in §3.2 tier 7's order (the first is the one an operation fails with). */
export type FieldTag = ContentTooLong | EmbedTooLarge | PollTooLarge | NameTooLong | TopicTooLong | SlowmodeOutOfRange | NicknameTooLong | TimeoutTooLong

const fieldOrder: ReadonlyArray<FieldTag["_tag"]> = ["ContentTooLong", "EmbedTooLarge", "PollTooLarge", "NameTooLong", "TopicTooLong", "SlowmodeOutOfRange", "NicknameTooLong", "TimeoutTooLong"]

const isIndex = (segment: string | undefined): boolean => segment !== undefined && /^\d+$/.test(segment)

/** Which embed limit an inner path under `embeds` names (hypotheses until M6's limit rows record the paths). */
const embedLimit = (rest: ReadonlyArray<string>): EmbedTooLarge["limit"] | undefined => {
  if (rest.length === 0) return "count"
  const [index, field, nested, sub] = rest
  if (!isIndex(index)) return undefined
  if (rest.length === 1) return "total"
  if (rest.length === 2 && field === "title") return "title"
  if (rest.length === 2 && field === "description") return "description"
  if (rest.length === 2 && field === "fields") return "fields"
  if (rest.length === 4 && field === "fields" && isIndex(nested) && sub === "name") return "fieldName"
  if (rest.length === 4 && field === "fields" && isIndex(nested) && sub === "value") return "fieldValue"
  if (rest.length === 3 && field === "footer" && nested === "text") return "footer"
  if (rest.length === 3 && field === "author" && nested === "name") return "author"
  return undefined
}

/** Which poll limit an inner path under `poll` names. */
const pollLimit = (rest: ReadonlyArray<string>): PollTooLarge["limit"] | undefined => {
  const [first, second, third, fourth] = rest
  if (rest.length === 2 && first === "question" && second === "text") return "question"
  if (rest.length === 1 && first === "answers") return "answerCount"
  if (rest.length === 4 && first === "answers" && isIndex(second) && third === "poll_media" && fourth === "text") return "answerText"
  if (rest.length === 1 && first === "duration") return "duration"
  return undefined
}

/** The tag one inner 50035 error maps to for this request, or why it does not map. */
const fieldTag = (op: OpName, limits: LimitFacts, error: FieldError, cause: DiscordResponse): FieldTag | string => {
  const path = error.path
  const where = path.join(".") || "(root)"
  // a forum post's message fields sit under `message` (its body is `{ name, message: { content, ... } }`)
  const message = op === "forum.createPost" ? (path[0] === "message" ? path.slice(1) : undefined) : path
  const head = message?.[0]
  if (message !== undefined && message.length === 1 && head === "content") {
    return limits.content === undefined ? `${where} is not declared` : new ContentTooLong({ ...limits.content, cause })
  }
  if (message !== undefined && head === "embeds") {
    const limit = embedLimit(message.slice(1))
    return limits.embeds === undefined || limit === undefined ? `${where} is not a declared embed limit` : new EmbedTooLarge({ limit, cause })
  }
  if (message !== undefined && head === "poll") {
    const limit = pollLimit(message.slice(1))
    return limits.poll === undefined || limit === undefined ? `${where} is not a declared poll limit` : new PollTooLarge({ limit, cause })
  }
  if (path.length === 1) {
    switch (path[0]) {
      case "name":
        return limits.name === undefined ? `${where} is not declared` : new NameTooLong({ ...limits.name, cause })
      case "topic":
        return limits.topic === undefined ? `${where} is not declared` : new TopicTooLong({ ...limits.topic, cause })
      case "rate_limit_per_user":
        return limits.slowmode === undefined ? `${where} is not declared` : new SlowmodeOutOfRange({ ...limits.slowmode, cause })
      case "nick":
        return limits.nick === undefined ? `${where} is not declared` : new NicknameTooLong({ ...limits.nick, cause })
      case "communication_disabled_until":
        return limits.timeout === undefined ? `${where} is not declared` : new TimeoutTooLong({ cause })
    }
  }
  return `${where} names no limit`
}

// ---- mapping one answer ---------------------------------------------------------------------------------

/** What a request is, as far as mapping its refusal needs: its operation-table row, its facts and its limits. */
export interface RequestFacts {
  readonly op: OpName
  /** The request's static facts (the payload's features); the recompute completes the rest. */
  readonly args: DecideArgs
  readonly limits: LimitFacts
}

/** The error a recompute that finds nothing falls back to. */
export type FallbackError = PermissionDeniedUnattributed | ThreadLocked | ThreadArchived | OpPermissionErrors[OpName]["ReadMessageHistory"]

/** An error a code names directly. */
export type CodeError =
  | UnknownChannel
  | UnknownMember
  | UnknownMessage
  | UnknownRole
  | UnknownEmoji
  | MaximumPinsReached
  | MaximumReactionsReached
  | AlreadyCrossposted
  | TagRequired
  | CannotMessageUser
  | TwoFactorRequired
  | ThreadAlreadyExists
  | MaximumActiveThreads
  | MessagesTooOld
  | TooManyMessagesToDelete
  | MessageEmpty
  | RateLimited
  | SlowmodeActive
  | FieldTag

/** What one Discord answer means for one request. */
export type Mapped =
  /** Attribute it by the recompute; `fallback` (its cause `attributedBy: "code"`) when the recompute finds nothing. */
  | { readonly _tag: "Recompute"; readonly fallback: FallbackError }
  /** Fail with `error`, the code's own (its cause `attributedBy: "code"`). */
  | { readonly _tag: "Fail"; readonly error: CodeError }
  /** Not a failure this request declares: a defect (`UnmappedDiscordError`). */
  | { readonly _tag: "Unmapped"; readonly reason: string }

const codeTagConstructors: { readonly [T in CodeTag]: (cause: DiscordResponse) => CodeError } = {
  UnknownChannel: (cause) => new UnknownChannel({ cause }),
  UnknownMember: (cause) => new UnknownMember({ cause }),
  UnknownMessage: (cause) => new UnknownMessage({ cause }),
  UnknownRole: (cause) => new UnknownRole({ cause }),
  UnknownEmoji: (cause) => new UnknownEmoji({ cause }),
  MaximumPinsReached: (cause) => new MaximumPinsReached({ cause }),
  MaximumReactionsReached: (cause) => new MaximumReactionsReached({ cause }),
  AlreadyCrossposted: (cause) => new AlreadyCrossposted({ cause }),
  TagRequired: (cause) => new TagRequired({ cause }),
  CannotMessageUser: (cause) => new CannotMessageUser({ cause }),
  TwoFactorRequired: (cause) => new TwoFactorRequired({ cause }),
  ThreadAlreadyExists: (cause) => new ThreadAlreadyExists({ cause }),
  MaximumActiveThreads: (cause) => new MaximumActiveThreads({ cause }),
  MessagesTooOld: (cause) => new MessagesTooOld({ cause })
}

const unmapped = (reason: string): Mapped => ({ _tag: "Unmapped", reason })

const recomputeOf = (request: RequestFacts, fallback: FallbackTag, response: DiscordResponse): Mapped => {
  const { op, args } = request
  const row: OpSpec = Operations[op]
  switch (fallback) {
    case "PermissionDeniedUnattributed":
      return row.tags.includes("PermissionDeniedUnattributed")
        ? { _tag: "Recompute", fallback: new PermissionDeniedUnattributed({ cause: response }) }
        : unmapped(`${op} sends no request Discord refuses with ${response.code}`)
    case "ThreadLocked":
      return row.tags.includes("ThreadLocked") ? { _tag: "Recompute", fallback: new ThreadLocked({ cause: response }) } : unmapped(`${op} does not list ThreadLocked`)
    case "ThreadArchived":
      return row.tags.includes("ThreadArchived") ? { _tag: "Recompute", fallback: new ThreadArchived({ cause: response }) } : unmapped(`${op} does not list ThreadArchived`)
    case "MissingReadMessageHistory": {
      const needed: ReadonlyArray<PermissionFlag> = errorModeFlags(op, args)
      return needed.includes("ReadMessageHistory")
        ? { _tag: "Recompute", fallback: errorFor(op, "ReadMessageHistory", response) }
        : unmapped(`${op} with this request does not need ReadMessageHistory`)
    }
  }
}

/**
 * Maps Discord's answer `response` to request `request` (see the module comment). `retryAfterMs` is the answer's
 * `retry_after`, which a rate-limit tag needs. Pure.
 */
export const mapResponse = (request: RequestFacts, response: DiscordResponse, retryAfterMs: number | undefined): Mapped => {
  const { op, limits } = request
  const entry = Codes[response.code]
  if (entry === undefined) return unmapped(`code ${response.code} is not in the error map`)
  if (!entry.statuses.includes(response.status)) return unmapped(`code ${response.code} came with status ${response.status}, not ${entry.statuses.join(" or ")}`)
  const row: OpSpec = Operations[op]
  const lists = (tag: TagName): boolean => row.tags.includes(tag)
  const meaning = entry.meaning
  switch (meaning._tag) {
    case "Recompute":
      return recomputeOf(request, meaning.fallback, response)
    case "Tag":
      return lists(meaning.tag) ? { _tag: "Fail", error: codeTagConstructors[meaning.tag](response) } : unmapped(`${op} does not list ${meaning.tag}`)
    case "RateLimit": {
      if (retryAfterMs === undefined) return unmapped(`code ${response.code} without retry_after`)
      if (meaning.tag === "SlowmodeActive") {
        // gated by the live matrix (D11, H-053): while bots are exempt from slowmode, 20016 is not a declared failure
        return Observed.slowmodeAppliesToBots && lists("SlowmodeActive")
          ? { _tag: "Fail", error: new SlowmodeActive({ retryAfterMs, cause: response }) }
          : unmapped(`SlowmodeActive is not declared for ${op} (Observed.slowmodeAppliesToBots is ${String(Observed.slowmodeAppliesToBots)})`)
      }
      return lists("RateLimited") ? { _tag: "Fail", error: new RateLimited({ retryAfterMs, cause: response }) } : unmapped(`${op} does not list RateLimited`)
    }
    case "Empty":
      return limits.empty === true ? { _tag: "Fail", error: new MessageEmpty({ cause: response }) } : unmapped(`${op} with this request cannot be empty`)
    case "Count":
      return lists("TooManyMessagesToDelete") && limits.messageCount !== undefined
        ? { _tag: "Fail", error: new TooManyMessagesToDelete({ count: limits.messageCount, cause: response }) }
        : unmapped(`${op} with this request declares no message count`)
    case "Fields": {
      const tags: Array<FieldTag> = []
      for (const error of response.fieldErrors) {
        const tag = fieldTag(op, limits, error, response)
        if (typeof tag === "string") return unmapped(`50035 for ${op}: ${tag}`)
        tags.push(tag)
      }
      const [first] = tags.sort((a, b) => fieldOrder.indexOf(a._tag) - fieldOrder.indexOf(b._tag))
      return first === undefined ? unmapped("a 50035 without inner errors") : { _tag: "Fail", error: first }
    }
  }
}

/**
 * A Discord answer the error map does not map for the operation (§3.1): a defect, never in an error channel,
 * carrying the whole answer so the matrix (or a log) shows what to add.
 */
export class UnmappedDiscordError extends Schema.TaggedError<UnmappedDiscordError>()("UnmappedDiscordError", {
  operation: Schema.String,
  reason: Schema.String,
  response: DiscordResponse
}) {
  override get message(): string {
    return `unmapped Discord answer for ${this.operation}: ${this.response.status} ${this.response.code} ${this.response.message} (${this.reason}; ${this.response.route})`
  }
}
