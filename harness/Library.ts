/**
 * Steps (b) and (d) through the library (DESIGN §5.10): the scenario's operation as a user would write it, the
 * public method on a handle (`channel.send(payload)`, `message.pin()`, `member.kick()`, ...).
 *
 * - **(b)** runs it in `"enforce"` mode with the dry-run stub set (`DryRun.ts`): the shared client applies the Lab
 *   guard, then records the request and answers a canned 2xx body without sending it. The step records `pass` when
 *   the stub was called, otherwise the error, which must carry a `PreflightDecision` cause; it must equal
 *   `Preflight.decide`'s (`preflight-wiring` otherwise). This exercises the user-facing path (handle, the row for
 *   the kind, the guild state, the order, `errorFor`) without an extra Discord request.
 * - **(d)** runs it in `"bypass"` mode, live, for rows whose raw call Discord refused with 50013, 50001 or a
 *   dedicated code: the request goes out, Discord refuses it again, and the recompute decides the error, which must
 *   equal step (b)'s, tag and categories (`recompute-vs-preflight`). The Lab guard and Safety apply as to (c).
 * - **The request check** (the M6 verifier): the runner records step (d)'s request as sent (`DryRun.Capture`) and
 *   compares it, and step (b)'s when (b) reached the stub, with the raw call's, recorded the same way: the method,
 *   the path with its IDs and query, and the body (`request-wiring` otherwise). A row with neither falls back to
 *   {@link bypassedRequests}, the operation in `"bypass"` mode over the dry-run stub (no row of the M6 table needs
 *   it); `test/unit/request-check.test.ts` runs that and `Drivers.dryRequests` over the whole catalog offline.
 *
 * The handles are built from what the lab knows, as a bot holds handles it got earlier: the scenario channel by
 * its kind, the fixtures' messages from the harness's read of them (their author and reactions), and the target
 * member from the subject's read (as `Members.get` would).
 */
import { Effect, Option } from "effect"
import type { Runtime } from "../src/channels/Ops.ts"
import { channelHandle, messageHandle } from "../src/channels/Ops.ts"
import type { AnyMessage } from "../src/channels/Message.ts"
import type { GuildChannel, GuildChannelKind, GuildMessageKind, MessageChannel } from "../src/channels/Channel.ts"
import { PreflightDecision } from "../src/errors/Cause.ts"
import { catchCategory } from "../src/errors/Category.ts"
import type { AllErrors } from "../src/errors/index.ts"
import { memberHandle } from "../src/members/Member.ts"
import * as Preflight from "../src/permissions/Preflight.ts"
import type * as Schemas from "../src/rest/Schemas.ts"
import type { ChannelId, EmojiId, ForumTagId, MessageId, RoleId, StickerId } from "../src/Snowflake.ts"
import { DryRun, type Recorded, type Recorder } from "./DryRun.ts"
import { emoji } from "./Fixtures.ts"
import * as LabIds from "./LabIds.ts"
import * as Materialize from "./Materialize.ts"
import { typedPayload } from "./scenario/catalog/send.ts"
import type { Operation } from "./scenario/Dsl.ts"
import { type RecordedError, recordError } from "./TruthTable.ts"

/** Everything the library's call needs. */
export interface LibraryContext {
  readonly runtime: Runtime
  readonly ids: Materialize.Ids
  readonly state: Materialize.Desired
  /** The scenario channel or thread. */
  readonly channelId: ChannelId
  /** The fixtures' messages as the harness read them after the fixtures (author, reactions). */
  readonly subjectMessage: Schemas.Message | undefined
  readonly harnessMessage: Schemas.Message | undefined
  readonly secondHarnessMessage: MessageId | undefined
  readonly stickerId: StickerId | undefined
  readonly emojiId: EmojiId | undefined
  readonly forumTag: ForumTagId | undefined
  readonly roleId: RoleId | undefined
  /** The target member as the subject read it (member operations). */
  readonly target: Schemas.Member | undefined
  /** Unix milliseconds, for a timeout's end and a unique topic. */
  readonly now: number
}

/** What the library's call created that cleanup must delete. */
export interface Operated {
  readonly created: ChannelId | undefined
}

const need = <A>(value: A | undefined, what: string): Effect.Effect<A> => (value === undefined ? Effect.die(new Error(`library step: no ${what}`)) : Effect.succeed(value))

const isMessageChannel = (channel: GuildChannel): channel is MessageChannel =>
  channel.kind !== "category" && channel.kind !== "forum" && channel.kind !== "media"

const done: Operated = { created: undefined }
const created = (channel: { readonly id: ChannelId }): Operated => ({ created: channel.id })

/** Runs `operation` through the library's public method (see the module comment). */
export const operate = (operation: Operation, context: LibraryContext): Effect.Effect<Operated, AllErrors> =>
  Effect.gen(function* () {
    const kind: GuildChannelKind = Materialize.kindOf(context.state.channel)
    const channel = channelHandle(context.runtime, { guildId: context.ids.guildId, id: context.channelId, kind })
    const messageChannel = isMessageChannel(channel) ? channel : undefined
    const message = (wire: Schemas.Message | undefined, what: string): Effect.Effect<AnyMessage<GuildMessageKind>> =>
      Effect.flatMap(need(wire, what), (read) => {
        if (messageChannel === undefined) return Effect.die(new Error(`library step: a message in a ${kind} channel`))
        return Effect.succeed(messageHandle(context.runtime, { guildId: context.ids.guildId, id: context.channelId, kind: messageChannel.kind }, read))
      })
    switch (operation._tag) {
      case "send": {
        const target = yield* need(messageChannel, "message channel")
        const payload = typedPayload(operation.payload, { replyTo: context.harnessMessage?.id, stickerId: context.stickerId, unmentionableRole: context.ids.roles.get("lab-unmentionable") })
        yield* target.send(payload)
        return done
      }
      case "createPost": {
        if (channel.kind !== "forum" && channel.kind !== "media") return yield* Effect.die(new Error(`library step: a post in a ${channel.kind} channel`))
        const tags = operation.tagged ? [yield* need(context.forumTag, "forum tag")] : []
        return created(yield* channel.createPost({ name: LabIds.createdThreadName, message: { content: "lab post" }, tags }))
      }
      case "message": {
        switch (operation.action) {
          case "edit-own": {
            const own = yield* message(context.subjectMessage, "subject message")
            if (own.author !== "self") return yield* Effect.die(new Error("library step: the subject message is not the subject's"))
            yield* own.edit({ content: "lab edited" })
            return done
          }
          case "delete-own":
          case "delete-foreign": {
            const target = yield* message(operation.action === "delete-own" ? context.subjectMessage : context.harnessMessage, "message")
            yield* target.delete()
            return done
          }
          case "crosspost-own":
          case "crosspost-foreign": {
            const target = yield* message(operation.action === "crosspost-own" ? context.subjectMessage : context.harnessMessage, "message")
            if (target.channelKind !== "announcement") return yield* Effect.die(new Error("library step: a crosspost outside an announcement channel"))
            yield* target.crosspost()
            return done
          }
          case "bulk-delete": {
            const first = (yield* need(context.harnessMessage, "harness message")).id
            const second = yield* need(context.secondHarnessMessage, "second harness message")
            switch (channel.kind) {
              case "text":
              case "announcement":
              case "voice":
              case "stage":
              case "public-thread":
              case "private-thread":
              case "announcement-thread":
                yield* channel.bulkDelete([first, second])
                return done
              case "category":
              case "forum":
              case "media":
                return yield* Effect.die(new Error(`library step: a bulk delete in a ${channel.kind} channel`))
            }
          }
        }
      }
      // fallthrough is impossible: every action returns
      case "react": {
        const target = yield* message(context.harnessMessage, "harness message")
        const chosen =
          operation.emoji === "guild"
            ? { origin: "guild" as const, id: yield* need(context.emojiId, "lab emoji"), name: LabIds.emojiSpec.name }
            : { origin: "unicode" as const, name: operation.emoji === "unicode-existing" ? emoji.existing : emoji.fresh }
        yield* target.react(chosen)
        return done
      }
      case "pins": {
        if (operation.action === "list") {
          switch (channel.kind) {
            case "text":
            case "announcement":
            case "voice":
            case "stage":
            case "public-thread":
            case "private-thread":
            case "announcement-thread":
              yield* channel.pins()
              return done
            case "category":
            case "forum":
            case "media":
              return yield* Effect.die(new Error(`library step: pins of a ${channel.kind} channel`))
          }
        }
        const target = yield* message(context.harnessMessage, "harness message")
        if (!("pin" in target)) return yield* Effect.die(new Error(`library step: a pin in ${target.channelKind} text chat, which has no pins`))
        yield* operation.action === "pin" ? target.pin() : target.unpin()
        return done
      }
      case "createThread": {
        const name = LabIds.createdThreadName
        if (operation.fromMessage) {
          const target = yield* message(context.harnessMessage, "harness message")
          if (!("createThread" in target)) return yield* Effect.die(new Error(`library step: a thread from a message in ${target.channelKind}`))
          return created(yield* target.createThread({ name }))
        }
        if (channel.kind === "text") return created(yield* channel.createThread({ name, private: operation.visibility === "private" }))
        if (channel.kind === "announcement" && operation.visibility === "public") return created(yield* channel.createThread({ name }))
        return yield* Effect.die(new Error(`library step: a ${operation.visibility} thread in a ${channel.kind} channel`))
      }
      case "thread": {
        if (channel.kind !== "public-thread" && channel.kind !== "private-thread" && channel.kind !== "announcement-thread") return yield* Effect.die(new Error(`library step: a thread operation on a ${channel.kind} channel`))
        switch (operation.action) {
          case "join":
            yield* channel.join()
            return done
          case "leave":
            yield* channel.leave()
            return done
          case "add-member":
            yield* channel.addMember(context.ids.targetUserId)
            return done
          case "archive":
            yield* channel.setArchived(true)
            return done
          case "unarchive":
            yield* channel.setArchived(false)
            return done
          case "lock":
            yield* channel.setLocked(true)
            return done
          case "delete":
            yield* channel.delete()
            return done
        }
      }
      // fallthrough is impossible: every action returns
      case "channelEdit": {
        const name = `${context.state.channel}-b`
        const topic = `lab topic ${context.now}`
        switch (channel.kind) {
          case "text":
          case "announcement":
          case "forum":
          case "media":
          case "stage":
            yield* operation.field === "slowmode" ? channel.edit({ slowmodeSeconds: 5 }) : operation.field === "name" ? channel.edit({ name }) : channel.edit({ topic })
            return done
          case "voice":
          case "public-thread":
          case "private-thread":
          case "announcement-thread":
            if (operation.field === "topic") return yield* Effect.die(new Error(`library step: a topic on a ${channel.kind} channel`))
            yield* operation.field === "slowmode" ? channel.edit({ slowmodeSeconds: 5 }) : channel.edit({ name })
            return done
          case "category":
            if (operation.field !== "name") return yield* Effect.die(new Error("library step: only a category's name"))
            yield* channel.edit({ name })
            return done
        }
      }
      // fallthrough is impossible: every kind returns
      case "member": {
        const member = memberHandle(context.runtime, context.ids.guildId, yield* need(context.target, "target member"))
        switch (operation.action) {
          case "add-role":
            yield* member.addRole(yield* need(context.roleId, "assigned role"))
            return done
          case "remove-role":
            yield* member.removeRole(yield* need(context.roleId, "assigned role"))
            return done
          case "nickname":
            yield* member.setNickname("lab-nick")
            return done
          case "timeout":
            yield* member.timeout(new Date(context.now + 600_000))
            return done
          case "kick":
            yield* member.kick()
            return done
          case "ban":
            yield* member.ban()
            return done
        }
      }
      // fallthrough is impossible: every action returns
      case "rule":
        return yield* Effect.die(new Error("library step: a rule row runs its probe (harness/Probes.ts)"))
    }
  })

/** Step (b)'s record: `pass` when the operation reached the stub, else its error (see the module comment). */
export type Step = "pass" | RecordedError

/** Step (b)'s record and the requests the stub answered (none when preflight refused). */
export interface PreflightStep {
  readonly step: Step
  readonly requests: ReadonlyArray<Recorded>
}

/** Step (b): the operation in enforce mode over the dry-run stub. A defect (no canned body, a refused guard check) aborts. */
export const preflightStep = (operation: Operation, context: LibraryContext, recorder: Recorder): Effect.Effect<PreflightStep> =>
  operate(operation, context).pipe(
    Effect.provideService(Preflight.Mode, "enforce"),
    Effect.provideService(DryRun, Option.some(recorder)),
    Effect.matchEffect({
      onSuccess: () => Effect.succeed<Step>("pass"),
      onFailure: (error) => {
        const cause: unknown = error.cause
        return Effect.succeed<Step>(
          cause instanceof PreflightDecision
            ? recordError(error)
            : // an error Discord or the stub decided is wiring, never a preflight result: it cannot equal decide's
              { tag: `${error._tag} (not a preflight decision)`, categories: [] }
        )
      }
    }),
    Effect.flatMap((step) =>
      Effect.flatMap(recorder.recorded, (requests) =>
        step === "pass" && requests.length === 0
          ? Effect.die(new Error("library step (b): the operation succeeded without reaching the dry-run stub"))
          : Effect.succeed<PreflightStep>({ step, requests })
      )
    )
  )

/**
 * The operation in bypass mode over the dry-run stub, which records what step (d) would send (the request check's
 * fallback, and its library side offline). A typed failure (a local check) records nothing, which no raw call
 * equals; a defect aborts.
 */
export const bypassedRequests = (operation: Operation, context: LibraryContext, recorder: Recorder): Effect.Effect<ReadonlyArray<Recorded>> =>
  operate(operation, context).pipe(
    Effect.provideService(Preflight.Mode, "bypass"),
    Effect.provideService(DryRun, Option.some(recorder)),
    Effect.ignore,
    Effect.andThen(recorder.recorded)
  )

/**
 * Step (d)'s record: the error with preflight bypassed; a success (Discord let it through this time) never equals (b).
 * A `Transient` (no answer, the deadline, a 5xx, or a recompute read without an answer) is an infrastructure abort,
 * never a row outcome (§5.10).
 */
export const recomputeStep = (operation: Operation, context: LibraryContext): Effect.Effect<{ readonly record: RecordedError; readonly created: ChannelId | undefined }> =>
  operate(operation, context).pipe(
    Effect.provideService(Preflight.Mode, "bypass"),
    catchCategory("transient", (error) => Effect.die(new Error(`infrastructure abort: step (d): ${error._tag}`))),
    Effect.matchEffect({
      onSuccess: (operated) => Effect.succeed({ record: { tag: "(succeeded)", categories: [] }, created: operated.created }),
      onFailure: (error) => Effect.succeed({ record: recordError(error), created: undefined })
    })
  )
