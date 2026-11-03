/**
 * Step (c) per operation (DESIGN §5.10): the raw call through `SubjectRaw`, with no check, its outcome, and
 * what the call created that cleanup must delete. Each call is the request the library's operation sends for it
 * (the bodies come from `ToDfx` and the same field choices, so steps (c) and (d) send the same request), bounded
 * by the request deadline; a missing answer is the runner's infrastructure abort.
 */
import type { DiscordRESTError } from "dfx/DiscordREST"
import { Duration, Effect, Option, Schema } from "effect"
import { SubjectRaw } from "../src/bot/Internals.ts"
import type { HttpMethod } from "../src/errors/Cause.ts"
import type { Transient } from "../src/errors/Transient.ts"
import { type Answered, send } from "../src/rest/Request.ts"
import type { ChannelId, EmojiId, MessageId, RoleId, StickerId } from "../src/Snowflake.ts"
import { ChannelId as ChannelIdSchema } from "../src/Snowflake.ts"
import { DryRun, type Recorded, type Recorder } from "./DryRun.ts"
import { emoji, type PriorSend, priorSendProblem } from "./Fixtures.ts"
import * as LabIds from "./LabIds.ts"
import type * as Materialize from "./Materialize.ts"
import * as Outcome from "./Outcome.ts"
import * as ToDfx from "../src/payload/ToDfx.ts"
import { wirePayload } from "./scenario/catalog/send.ts"
import type { Scenario } from "./scenario/Dsl.ts"
import type { RawOutcome } from "./TruthTable.ts"

/** Bounds every raw call (§4.10). */
export const deadline = Duration.seconds(30)

/** Everything a raw call reads. */
export interface CallContext {
  readonly ids: Materialize.Ids
  readonly state: Materialize.Desired
  /** The scenario channel or thread. */
  readonly channelId: ChannelId
  readonly subjectMessage: MessageId | undefined
  readonly harnessMessage: MessageId | undefined
  readonly secondHarnessMessage: MessageId | undefined
  readonly stickerId: StickerId | undefined
  readonly emojiId: EmojiId | undefined
  /** The forum's `lab-tag`, for a tagged post. */
  readonly forumTag: string | undefined
  /** The role a role operation assigns or removes. */
  readonly roleId: RoleId | undefined
  /** Unix milliseconds, for a timeout's end and a unique topic. */
  readonly now: number
  /**
   * What `Fixtures.subjectPriorSend` did (only it makes one): `Sent` exactly when the setup has
   * `subject-prior-send`, which the raw call checks before it sends anything.
   */
  readonly priorSend: Exclude<PriorSend, { readonly _tag: "Refused" }>
}

/** A raw call's answer, and the thread or post it created (cleanup deletes it). */
export interface Called {
  readonly answer: Answered<unknown>
  readonly created: ChannelId | undefined
}

const Created = Schema.Struct({ id: ChannelIdSchema })

const need = <A>(value: A | undefined, what: string): Effect.Effect<A> => (value === undefined ? Effect.die(new Error(`drivers: no ${what}`)) : Effect.succeed(value))

const call = <A>(route: string, method: HttpMethod, request: Effect.Effect<A, DiscordRESTError>): Effect.Effect<Answered<unknown>, Transient> =>
  send(route, method, request, deadline)

/** How long a timeout the subject sets on the target lasts (cleared by the next Converge). */
const targetTimeoutMs = 600_000

/** The thread type a new thread gets: an announcement thread in an announcement channel, else public or private. */
const threadTypeOf = (state: Materialize.Desired, visibility: "public" | "private"): 10 | 11 | 12 =>
  visibility === "private" ? 12 : state.channel === "lab-announcement" ? 10 : 11

/**
 * Runs the scenario's raw call (§5.10 step 6). A prior send that does not match the setup (an H-053 row without
 * its prior send) is a defect, before anything is sent.
 */
export const rawCall = (scenario: Pick<Scenario, "operation" | "setup">, context: CallContext): Effect.Effect<Called, Transient, SubjectRaw> =>
  Effect.gen(function* () {
    const problem = priorSendProblem(scenario.setup, context.priorSend)
    if (problem !== undefined) return yield* Effect.die(new Error(`drivers: ${problem}`))
    const operation = scenario.operation
    const subject = yield* SubjectRaw
    const channel = context.channelId
    const done = (answer: Answered<unknown>): Called => ({ answer, created: undefined })
    const creating = (answer: Answered<unknown>): Called => ({
      answer,
      created: answer._tag === "Ok" ? Option.getOrUndefined(Option.map(Schema.decodeUnknownOption(Created)(answer.body), (body) => body.id)) : undefined
    })
    switch (operation._tag) {
      case "send": {
        const wire = wirePayload(operation.payload, { replyTo: context.harnessMessage, stickerId: context.stickerId, unmentionableRole: context.ids.roles.get("lab-unmentionable") })
        const request = subject.createMessage(channel, wire.request)
        return done(yield* call("/channels/{channel.id}/messages", "POST", wire.files.length > 0 ? subject.withFiles(wire.files)(request) : request))
      }
      case "createPost": {
        const tags = operation.tagged ? [yield* need(context.forumTag, "forum tag")] : []
        return creating(
          yield* call(
            "/channels/{channel.id}/threads",
            "POST",
            subject.createThread(channel, { name: LabIds.createdThreadName, ...(tags.length === 0 ? {} : { applied_tags: tags }), message: ToDfx.createRequest({ content: "lab post" }).request })
          )
        )
      }
      case "message": {
        const route = "/channels/{channel.id}/messages/{message.id}"
        switch (operation.action) {
          case "edit-own":
            return done(yield* call(route, "PATCH", subject.updateMessage(channel, yield* need(context.subjectMessage, "subject message"), ToDfx.editRequest({ content: "lab edited" }))))
          case "delete-own":
            return done(yield* call(route, "DELETE", subject.deleteMessage(channel, yield* need(context.subjectMessage, "subject message"))))
          case "delete-foreign":
            return done(yield* call(route, "DELETE", subject.deleteMessage(channel, yield* need(context.harnessMessage, "harness message"))))
          case "crosspost-own":
            return done(yield* call(`${route}/crosspost`, "POST", subject.crosspostMessage(channel, yield* need(context.subjectMessage, "subject message"))))
          case "crosspost-foreign":
            return done(yield* call(`${route}/crosspost`, "POST", subject.crosspostMessage(channel, yield* need(context.harnessMessage, "harness message"))))
          case "bulk-delete": {
            const messages = [yield* need(context.harnessMessage, "harness message"), yield* need(context.secondHarnessMessage, "second harness message")]
            return done(yield* call("/channels/{channel.id}/messages/bulk-delete", "POST", subject.bulkDeleteMessages(channel, { messages })))
          }
        }
      }
      // fallthrough is impossible: the inner switch returns on every action
      case "react": {
        const message = yield* need(context.harnessMessage, "harness message")
        const reaction =
          operation.emoji === "guild"
            ? `${LabIds.emojiSpec.name}:${yield* need(context.emojiId, "lab emoji")}`
            : encodeURIComponent(operation.emoji === "unicode-existing" ? emoji.existing : emoji.fresh)
        return done(yield* call("/channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me", "PUT", subject.addMyMessageReaction(channel, message, reaction)))
      }
      case "pins": {
        const route = "/channels/{channel.id}/messages/pins/{message.id}"
        switch (operation.action) {
          case "pin":
            return done(yield* call(route, "PUT", subject.createPin(channel, yield* need(context.harnessMessage, "harness message"))))
          case "unpin":
            return done(yield* call(route, "DELETE", subject.deletePin(channel, yield* need(context.harnessMessage, "harness message"))))
          case "list":
            return done(yield* call("/channels/{channel.id}/messages/pins", "GET", subject.listPins(channel, { limit: 50 })))
        }
      }
      // fallthrough is impossible: the inner switch returns on every action
      case "createThread": {
        const name = LabIds.createdThreadName
        if (operation.fromMessage) {
          const message = yield* need(context.harnessMessage, "harness message")
          return creating(
            yield* call("/channels/{channel.id}/messages/{message.id}/threads", "POST", subject.createThreadFromMessage(channel, message, { name }))
          )
        }
        return creating(
          yield* call(
            "/channels/{channel.id}/threads",
            "POST",
            subject.createThread(channel, { name, type: threadTypeOf(context.state, operation.visibility) })
          )
        )
      }
      case "thread": {
        const route = "/channels/{channel.id}"
        switch (operation.action) {
          case "join":
            return done(yield* call("/channels/{channel.id}/thread-members/@me", "PUT", subject.joinThread(channel)))
          case "leave":
            return done(yield* call("/channels/{channel.id}/thread-members/@me", "DELETE", subject.leaveThread(channel)))
          case "add-member":
            return done(yield* call("/channels/{channel.id}/thread-members/{user.id}", "PUT", subject.addThreadMember(channel, context.ids.targetUserId)))
          case "archive":
            return done(yield* call(route, "PATCH", subject.updateChannel(channel, { archived: true })))
          case "unarchive":
            return done(yield* call(route, "PATCH", subject.updateChannel(channel, { archived: false })))
          case "lock":
            return done(yield* call(route, "PATCH", subject.updateChannel(channel, { locked: true })))
          case "delete":
            return done(yield* call(route, "DELETE", subject.deleteChannel(channel)))
        }
      }
      // fallthrough is impossible: the inner switch returns on every action
      case "channelEdit": {
        const route = "/channels/{channel.id}"
        switch (operation.field) {
          case "slowmode":
            return done(yield* call(route, "PATCH", subject.updateChannel(channel, { rate_limit_per_user: 5 })))
          case "name":
            return done(yield* call(route, "PATCH", subject.updateChannel(channel, { name: `${context.state.channel}-b` })))
          case "topic":
            return done(yield* call(route, "PATCH", subject.updateChannel(channel, { topic: `lab topic ${context.now}` })))
        }
      }
      // fallthrough is impossible: the inner switch returns on every field
      case "rule":
        return yield* Effect.die(new Error("drivers: a rule row runs its probe (harness/Probes.ts), not a matrix call"))
      case "member": {
        const guild = context.ids.guildId
        const target = context.ids.targetUserId
        const memberRoute = "/guilds/{guild.id}/members/{user.id}"
        switch (operation.action) {
          case "add-role":
            return done(yield* call(`${memberRoute}/roles/{role.id}`, "PUT", subject.addGuildMemberRole(guild, target, yield* need(context.roleId, "assigned role"))))
          case "remove-role":
            return done(yield* call(`${memberRoute}/roles/{role.id}`, "DELETE", subject.deleteGuildMemberRole(guild, target, yield* need(context.roleId, "assigned role"))))
          case "nickname":
            return done(yield* call(memberRoute, "PATCH", subject.updateGuildMember(guild, target, { nick: "lab-nick" })))
          case "timeout":
            return done(yield* call(memberRoute, "PATCH", subject.updateGuildMember(guild, target, { communication_disabled_until: new Date(context.now + targetTimeoutMs).toISOString() })))
          case "kick":
            return done(yield* call(memberRoute, "DELETE", subject.deleteGuildMember(guild, target)))
          case "ban":
            return done(yield* call("/guilds/{guild.id}/bans/{user.id}", "PUT", subject.banUserFromGuild(guild, target, { delete_message_seconds: 0 })))
        }
      }
    }
  })

/**
 * The request check's reference (§5.10): the scenario's raw call over the dry-run stub, which records the request
 * step (c) sends (method, path with its IDs and query, body) and answers it without sending it.
 */
export const dryRequests = (scenario: Pick<Scenario, "operation" | "setup">, context: CallContext, recorder: Recorder): Effect.Effect<ReadonlyArray<Recorded>, Transient, SubjectRaw> =>
  rawCall(scenario, context).pipe(Effect.provideService(DryRun, Option.some(recorder)), Effect.andThen(recorder.recorded))

const PinsPage = Schema.Struct({ items: Schema.Array(Schema.Unknown) })

/**
 * The raw outcome of a call (§5.10 step 6, §4.12): a Discord error answer as `Outcome.rejected`; a send's
 * degradation read back from its create response; the pins list `degraded` (ReadMessageHistory) when it came
 * back empty although the harness pinned a message (H-107); any other 2xx a success. A 2xx body that does not
 * decode is a defect.
 */
export const outcomeOf = (scenario: Pick<Scenario, "operation" | "setup">, called: Called): Effect.Effect<RawOutcome> =>
  Effect.gen(function* () {
    const answer = called.answer
    if (answer._tag === "Rejected") return Outcome.rejected(answer.response)
    const operation = scenario.operation
    if (operation._tag === "send") {
      const message = yield* Schema.decodeUnknownEffect(Outcome.CreatedMessage)(answer.body).pipe(Effect.orDie)
      return Outcome.succeeded(operation.payload, message)
    }
    if (operation._tag === "pins" && operation.action === "list") {
      const page = yield* Schema.decodeUnknownEffect(PinsPage)(answer.body).pipe(Effect.orDie)
      return Outcome.ok(page.items.length === 0 && scenario.setup.fixtures.includes("pinned-harness-message") ? ["ReadMessageHistory"] : [])
    }
    return Outcome.ok([])
  })

/** The message a call created, for the run log (a send's). */
export const createdMessageOf = (called: Called): string | undefined =>
  called.answer._tag === "Ok" ? Option.getOrUndefined(Option.map(Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))(called.answer.body), (body) => body.id)) : undefined
