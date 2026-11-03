import * as fs from "node:fs"
import { Predicate, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { scenarios } from "../../harness/scenario/catalog/index.ts"
import { staticFactsOf } from "../../harness/scenario/Facts.ts"
import * as TruthTable from "../../harness/TruthTable.ts"
import { DiscordResponse, FieldError } from "../../src/errors/Cause.ts"
import { ErrorClasses } from "../../src/errors/index.ts"
import { ErrorCategories, PermissionFlags } from "../../src/errors/Missing.generated.ts"
import { Observed } from "../../src/permissions/Observed.ts"
import type { OpName } from "../../src/permissions/Operations.ts"
import { Codes, dedicatedCodeTags, type LimitFacts, type LimitField, limitFields, type Mapped, mapResponse, undeclarableFields } from "../../src/rest/ErrorMap.ts"
import { Operations } from "../../src/permissions/Operations.ts"
import { categoriesOf } from "../support/categories.ts"
import { declaredTags, promisedClass } from "../support/declared.ts"

/**
 * The error map (DESIGN §3.1, §4.9): every `(operation, status, code, inner path)` the truth table recorded maps to
 * the declared tag and categories; codes, statuses and paths a request does not declare are unmapped (defects
 * through `DiscordApi`, `test/unit/discord-api.test.ts`); 50035's inner paths refine to the limit tags.
 */
const tablePath = new URL("../../fixtures/truth-table.json", import.meta.url).pathname
const table = Schema.decodeUnknownSync(Schema.fromJsonString(TruthTable.TruthTable))(fs.readFileSync(tablePath, "utf8"))
const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
const classes: Readonly<Record<string, object>> = ErrorClasses

const response = (status: number, code: number, fieldErrors: ReadonlyArray<FieldError> = []) =>
  new DiscordResponse({ status, code, message: "x", method: "POST", route: "/channels/{channel.id}/messages", fieldErrors, attributedBy: "code" })
const at = (...path: ReadonlyArray<string>) => new FieldError({ path, code: "BASE_TYPE_MAX_LENGTH", message: "too long" })

/** The mapped error's tag and categories, or why it is unmapped. */
const outcome = (mapped: Mapped) => {
  if (mapped._tag === "Unmapped") return { unmapped: mapped.reason }
  const error = mapped._tag === "Fail" ? mapped.error : mapped.fallback
  return { via: mapped._tag, tag: error._tag, categories: [...categoriesOf(error)] }
}
type DecideArgsPayload = Parameters<typeof mapResponse>[0]["args"]["payload"]
const mapped = (op: OpName, status: number, code: number, options: { readonly limits?: LimitFacts; readonly payload?: DecideArgsPayload; readonly fieldErrors?: ReadonlyArray<FieldError>; readonly retryAfterMs?: number } = {}) =>
  outcome(mapResponse({ op, args: { payload: options.payload ?? [] }, limits: options.limits ?? {} }, response(status, code, options.fieldErrors), options.retryAfterMs))

describe("the truth table's refusals", () => {
  // the matrix rows: a rule row's raw side sends what the types forbid (the replay's limit block holds its 50035s)
  const refused = Object.entries(table.scenarios).filter(
    ([id, row]) => byId.get(id)?.operation._tag !== "rule" && (row.raw.class === "50013" || row.raw.class === "50001" || row.raw.class === "other-error")
  )

  it("each maps, for its operation, to its declared tag with its class's categories", () => {
    expect(refused.length).toBeGreaterThan(150)
    for (const [id, row] of refused) {
      const scenario = byId.get(id)
      if (scenario === undefined) throw new Error(`${id} is not in the catalog`)
      const { op, args } = staticFactsOf(scenario)
      const inner = row.raw.inner.map((error) => new FieldError({ path: error.path.split("."), code: error.code, message: "" }))
      const result = mapResponse({ op, args, limits: {} }, response(row.raw.status, row.raw.code, inner), undefined)
      expect({ id, mapped: result._tag !== "Unmapped" }).toEqual({ id, mapped: true })
      if (result._tag === "Unmapped") continue
      const error = result._tag === "Fail" ? result.error : result.fallback
      // the code's own tag: the matrix's `mappedTag`, or Unattributed for 50013 and 50001
      expect({ id, tag: error._tag }).toEqual({ id, tag: row.raw.mappedTag === "n/a" ? "PermissionDeniedUnattributed" : row.raw.mappedTag })
      expect({ id, declared: declaredTags(op, args).has(error._tag) }).toEqual({ id, declared: true })
      const flag = Predicate.hasProperty(error, "flag") ? PermissionFlags.find((candidate) => candidate === error.flag) : undefined
      const Class = classes[error._tag]
      const promised = flag !== undefined ? ErrorCategories[promisedClass(op, flag)] : Class !== undefined && "prototype" in Class && Predicate.isObject(Class.prototype) ? categoriesOf(Class.prototype) : []
      expect({ id, categories: categoriesOf(error) }).toEqual({ id, categories: promised })
      // 50013, 50001 and the dedicated permission-like codes go through the recompute (§3.2); 40067 names its tag
      expect({ id, via: result._tag }).toEqual({ id, via: row.raw.code === 40067 ? "Fail" : "Recompute" })
    }
  })

  it("every (status, code) the matrix recorded is in the table with that status (H-082)", () => {
    const pairs = new Set(refused.map(([, row]) => `${row.raw.status} ${row.raw.code}`))
    expect([...pairs].sort()).toEqual(["400 40067", "400 50083", "403 160002", "403 160005", "403 50001", "403 50013"])
    for (const pair of pairs) {
      const [status, code] = pair.split(" ").map(Number)
      if (status === undefined || code === undefined) continue
      expect({ pair, listed: Codes[code]?.statuses.includes(status) }).toEqual({ pair, listed: true })
    }
  })

  it("dedicatedCodeTags names each code's own tag, as the matrix records it", () => {
    expect(dedicatedCodeTags.get(50083)).toBe("ThreadArchived")
    expect(dedicatedCodeTags.get(160002)).toBe("MissingReadMessageHistory")
    expect(dedicatedCodeTags.get(160005)).toBe("ThreadLocked")
    expect(dedicatedCodeTags.get(40067)).toBe("TagRequired")
    expect(dedicatedCodeTags.get(20028)).toBe("RateLimited")
    expect(dedicatedCodeTags.has(50013)).toBe(false)
    expect(dedicatedCodeTags.has(50001)).toBe(false)
    expect(dedicatedCodeTags.has(50035)).toBe(false)
  })
})

describe("what is unmapped (a defect through DiscordApi)", () => {
  it("a code the table does not know", () => {
    expect(mapped("channel.send", 400, 99999)).toEqual({ unmapped: "code 99999 is not in the error map" })
  })

  it("a known code with a status it does not come with", () => {
    expect(mapped("channel.send", 400, 50013)).toEqual({ unmapped: "code 50013 came with status 400, not 403" })
  })

  it("a tag the operation's row does not list", () => {
    expect(mapped("channel.send", 404, 10008)).toEqual({ unmapped: "channel.send does not list UnknownMessage" })
    expect(mapped("message.edit.channel", 404, 10008)).toMatchObject({ via: "Fail", tag: "UnknownMessage", categories: ["state"] })
    expect(mapped("dm.send", 403, 50013)).toEqual({ unmapped: "dm.send sends no request Discord refuses with 50013" })
  })

  it("160002 on a request that does not reply", () => {
    expect(mapped("channel.send", 403, 160002)).toEqual({ unmapped: "channel.send with this request does not need ReadMessageHistory" })
    expect(mapped("channel.send", 403, 160002, { payload: ["reply"] })).toEqual({ via: "Recompute", tag: "MissingReadMessageHistory", categories: ["payload", "permission"] })
  })

  it("20016 while the matrix says slowmode does not apply to bots (D11, H-053)", () => {
    expect(Observed.slowmodeAppliesToBots).toBe(false)
    expect(mapped("channel.send", 429, 20016, { retryAfterMs: 1000 })).toEqual({ unmapped: "SlowmodeActive is not declared for channel.send (Observed.slowmodeAppliesToBots is false)" })
  })

  it("a coded rate limit without retry_after, or on an operation that does not list RateLimited", () => {
    expect(mapped("channel.send", 429, 20028)).toEqual({ unmapped: "code 20028 without retry_after" })
    expect(mapped("channel.send", 429, 20028, { retryAfterMs: 1500 })).toEqual({ via: "Fail", tag: "RateLimited", categories: ["transient"] })
    expect(mapped("message.pin.channel", 429, 20028, { retryAfterMs: 1500 })).toEqual({ unmapped: "message.pin.channel does not list RateLimited" })
  })

  it("50006 on a request that cannot be empty, and 50016 without a message count", () => {
    expect(mapped("channel.send", 400, 50006)).toEqual({ unmapped: "channel.send with this request cannot be empty" })
    expect(mapped("channel.send", 400, 50006, { limits: { empty: true } })).toEqual({ via: "Fail", tag: "MessageEmpty", categories: ["payload"] })
    expect(mapped("channel.bulkDelete", 400, 50016)).toEqual({ unmapped: "channel.bulkDelete with this request declares no message count" })
    expect(mapped("channel.bulkDelete", 400, 50016, { limits: { messageCount: 101 } })).toEqual({ via: "Fail", tag: "TooManyMessagesToDelete", categories: ["payload"] })
  })

  it("a request declaring a limit its operation cannot have", () => {
    expect(undeclarableFields("channel.send", { name: { length: 1, limit: 100 } })).toEqual(["name"])
    expect(undeclarableFields("channel.send", { content: { length: 1, limit: 2000 }, embeds: true })).toEqual([])
  })
})

describe("50035 refined by its inner paths (§4.9)", () => {
  const send = { content: { length: 2001, limit: 2000 }, embeds: true, poll: true } as const

  it("maps each declared field's path to its limit tag", () => {
    expect(mapped("channel.send", 400, 50035, { limits: send, fieldErrors: [at("content")] })).toEqual({ via: "Fail", tag: "ContentTooLong", categories: ["payload"] })
    expect(mapped("channel.send", 400, 50035, { limits: send, fieldErrors: [at("embeds", "0", "fields", "3", "value")] })).toEqual({ via: "Fail", tag: "EmbedTooLarge", categories: ["payload"] })
    expect(mapped("channel.send", 400, 50035, { limits: send, fieldErrors: [at("poll", "answers", "2", "poll_media", "text")] })).toEqual({ via: "Fail", tag: "PollTooLarge", categories: ["payload"] })
    expect(mapped("forum.createPost", 400, 50035, { limits: { ...send, name: { length: 101, limit: 100 } }, fieldErrors: [at("message", "content")] })).toMatchObject({ tag: "ContentTooLong" })
    expect(mapped("forum.createPost", 400, 50035, { limits: { ...send, name: { length: 101, limit: 100 } }, fieldErrors: [at("name")] })).toMatchObject({ tag: "NameTooLong" })
    expect(mapped("channel.edit", 400, 50035, { limits: { topic: { length: 1025, limit: 1024 } }, fieldErrors: [at("topic")] })).toMatchObject({ tag: "TopicTooLong" })
    expect(mapped("thread.edit", 400, 50035, { limits: { slowmode: { seconds: 21601 } }, fieldErrors: [at("rate_limit_per_user")] })).toMatchObject({ tag: "SlowmodeOutOfRange" })
    expect(mapped("member.setNickname", 400, 50035, { limits: { nick: { length: 33, limit: 32 } }, fieldErrors: [at("nick")] })).toMatchObject({ tag: "NicknameTooLong" })
    expect(mapped("member.timeout", 400, 50035, { limits: { timeout: true }, fieldErrors: [at("communication_disabled_until")] })).toMatchObject({ tag: "TimeoutTooLong" })
  })

  it("carries the request's length, the limit and the embed or poll limit's name", () => {
    const content = mapResponse({ op: "channel.send", args: { payload: [] }, limits: send }, response(400, 50035, [at("content")]), undefined)
    expect(content._tag === "Fail" && content.error._tag === "ContentTooLong" ? [content.error.length, content.error.limit] : undefined).toEqual([2001, 2000])
    const embed = mapResponse({ op: "channel.send", args: { payload: [] }, limits: send }, response(400, 50035, [at("embeds", "1", "title")]), undefined)
    expect(embed._tag === "Fail" && embed.error._tag === "EmbedTooLarge" ? embed.error.limit : undefined).toBe("title")
    const poll = mapResponse({ op: "channel.send", args: { payload: [] }, limits: send }, response(400, 50035, [at("poll", "duration")]), undefined)
    expect(poll._tag === "Fail" && poll.error._tag === "PollTooLarge" ? poll.error.limit : undefined).toBe("duration")
  })

  it("fails with the first in §3.2 tier 7's order when several fields are over", () => {
    expect(mapped("channel.send", 400, 50035, { limits: send, fieldErrors: [at("poll", "duration"), at("embeds", "0", "title"), at("content")] })).toMatchObject({ tag: "ContentTooLong" })
  })

  it("leaves unmapped a path the request does not declare, a path that names no limit, and a 50035 without inner errors", () => {
    expect(mapped("channel.send", 400, 50035, { limits: { embeds: true }, fieldErrors: [at("content")] })).toEqual({ unmapped: "50035 for channel.send: content is not declared" })
    expect(mapped("channel.send", 400, 50035, { limits: send, fieldErrors: [at("content"), at("allowed_mentions", "parse")] })).toEqual({ unmapped: "50035 for channel.send: allowed_mentions.parse names no limit" })
    expect(mapped("channel.send", 400, 50035, { limits: send, fieldErrors: [at("embeds", "0", "url")] })).toEqual({ unmapped: "50035 for channel.send: embeds.0.url is not a declared embed limit" })
    // an embed field directly under `embeds` (no index) names no embed
    expect(mapped("channel.send", 400, 50035, { limits: send, fieldErrors: [at("embeds", "title")] })).toEqual({ unmapped: "50035 for channel.send: embeds.title is not a declared embed limit" })
    expect(mapped("forum.createPost", 400, 50035, { limits: send, fieldErrors: [at("content")] })).toEqual({ unmapped: "50035 for forum.createPost: content names no limit" })
    expect(mapped("channel.send", 400, 50035, { limits: send })).toEqual({ unmapped: "a 50035 without inner errors" })
  })
})

describe("which payload- and argument-derived tags each operation may declare (ErrorMap.limitFields)", () => {
  /**
   * Transcribed by hand from DESIGN §3.1's "Raised by" column and §2.3-§2.6 (not derived from `limitFields`), so
   * the error map cannot widen or narrow an operation's declared limits without this table changing too:
   * `ContentTooLong`, `EmbedTooLarge` and `MessageEmpty` on every send, a forum post and an own edit; `PollTooLarge`
   * on sends and posts (an edit carries no poll); `NameTooLong` on thread creation, posts and channel, voice and
   * thread edits; `TopicTooLong` on channel edits and voice-row edits (a stage channel's topic, M6 live; threads have
   * none); `SlowmodeOutOfRange`
   * on channel, voice and thread edits; `NicknameTooLong`, `TimeoutTooLong` and `TooManyMessagesToDelete` on their
   * one operation each.
   */
  const send: ReadonlyArray<LimitField> = ["empty", "content", "embeds", "poll"]
  const edit: ReadonlyArray<LimitField> = ["empty", "content", "embeds"]
  const expected: Readonly<Record<string, ReadonlyArray<LimitField>>> = {
    "channel.send": send,
    "thread.send": send,
    "voice.send": send,
    "dm.send": send,
    "forum.createPost": [...send, "name"],
    "message.edit.channel": edit,
    "message.edit.thread": edit,
    "message.edit.voice": edit,
    "channel.createThread.public": ["name"],
    "channel.createThread.private": ["name"],
    "channel.edit": ["name", "topic", "slowmode"],
    "voice.edit": ["name", "topic", "slowmode"],
    "thread.edit": ["name", "slowmode"],
    "member.setNickname": ["nick"],
    "member.timeout": ["timeout"],
    "channel.bulkDelete": ["messageCount"],
    "thread.bulkDelete": ["messageCount"],
    "voice.bulkDelete": ["messageCount"]
  }

  it.each(Object.keys(Operations))("%s", (op) => {
    const declared: Readonly<Record<string, ReadonlyArray<LimitField> | undefined>> = limitFields
    expect([...(declared[op] ?? [])].sort()).toEqual([...(expected[op] ?? [])].sort())
  })
})
