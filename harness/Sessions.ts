/**
 * The intent sessions' execution (DESIGN §5.10 "Intent sessions", M7; the descriptions are `catalog/intents.ts`).
 *
 * One session: open a fresh subject session with the declared intents (`Identities.Sessions`), recording every
 * dispatch from the first (`DispatchTap`) and subscribing the library's `bot.on` to the observed event; require
 * READY to name the subject and the codec's Identify to carry exactly the declared intents (a difference is an
 * infrastructure abort: the session would not be the one the row describes); run the trigger; run the canary; wait
 * for the canary (up to {@link canaryWithin}), then up to {@link graceAfterCanary} more for the trigger's own
 * dispatch (Discord does not order dispatches across resources); and close the session.
 *
 * The observation (`Dsl.Observation`):
 *
 * - delivery sessions: `EventDelivered { event }` when the trigger's own dispatch arrived, else `EventAbsent { event,
 *   canary }` with the canary event that arrived, or `none` (which no expectation accepts: an absence without a canary
 *   is no evidence);
 * - content sessions: `Applied`/`Ignored` `content` from the trigger message's `content` in Discord's dispatch (H-172),
 *   or `EventAbsent` when it never arrived;
 * - in both, where Discord's dispatch arrived, the library's `bot.on` must have received the event decoded within
 *   the grace, and for content its `contentDelivered` and `content` must say what Discord delivered. A disagreement
 *   is recorded as a `Rejected` with status 0 and the path `library`, which no expectation accepts.
 *
 * What a session leaves (the target's messages and reaction, the subject's message and nickname, the target's
 * nickname, `lab-bots-only`'s slowmode) is cleaned by the subject's nickname reset here and by the runner's cleanup and
 * next Converge (the probe touches `lab-bots-only`; a rule row forgets the target's view).
 */
import type { DiscordRestService } from "dfx/DiscordREST"
import { Clock, Duration, Effect, Option, Ref, Schema } from "effect"
import { BotRuntime, botWithRuntimeIntents } from "../src/bot/Bot.ts"
import { SubjectRaw } from "../src/bot/Internals.ts"
import type { EventPayloads } from "../src/gateway/Events.ts"
import { type EventName, type Intent, intentBits } from "../src/gateway/Intents.ts"
import { channelObfuscation } from "../src/gateway/Codec.ts"
import { ChannelId, MessageId, UserId } from "../src/Snowflake.ts"
import { HarnessRest, Sessions, TargetRest } from "./Identities.ts"
import { labStep, type LabRequestFailed } from "./Lab.ts"
import * as Outcome from "./Outcome.ts"
import type { ProbeContext, ProbeResult } from "./Probes.ts"
import { type SessionName, type SessionSpec, sessions, type Trigger } from "./scenario/catalog/intents.ts"
import type { Observation } from "./scenario/Dsl.ts"
import * as Wire from "./Wire.ts"

/** How long a session waits for its canary after the trigger. */
export const canaryWithin = Duration.seconds(10)

/** How long it waits, after the canary, for the trigger's own dispatch (and for the library's handler). */
export const graceAfterCanary = Duration.seconds(2)

/** How long it waits for READY. */
export const readyWithin = Duration.seconds(20)

/** An event as `bot.on` hands it to a session's handler (the session's intents are only known at run time). */
type AnyEvent = EventPayloads<Intent>[EventName]

/** One recorded dispatch. */
interface Recorded {
  readonly event: string
  readonly data: unknown
}

const Created = Schema.Struct({ id: MessageId })
const ReadyUser = Schema.Struct({ user: Schema.Struct({ id: UserId }) })
const MessageDispatch = Schema.Struct({ id: MessageId, content: Schema.String })
const ReactionDispatch = Schema.Struct({ message_id: MessageId, user_id: UserId })
const TypingDispatch = Schema.Struct({ channel_id: ChannelId, user_id: UserId })
const MemberDispatch = Schema.Struct({ user: Schema.Struct({ id: UserId }) })
const ChannelDispatch = Schema.Struct({ id: ChannelId })

const matches = <S extends Schema.Decoder<unknown>>(schema: S, test: (value: S["Type"]) => boolean) => (data: unknown): boolean =>
  Option.match(Schema.decodeUnknownOption(schema)(data), { onNone: () => false, onSome: test })

/** The first recorded dispatch named `event` that `test` accepts, waiting up to `within` for it. */
const awaitDispatch = (log: Ref.Ref<ReadonlyArray<Recorded>>, event: string, test: (data: unknown) => boolean, within: Duration.Duration): Effect.Effect<Option.Option<Recorded>> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(within)
    for (;;) {
      const found = (yield* Ref.get(log)).find((entry) => entry.event === event && test(entry.data))
      if (found !== undefined) return Option.some(found)
      if ((yield* Clock.currentTimeMillis) >= deadline) return Option.none()
      yield* Effect.sleep(Duration.millis(50))
    }
  })

/** The first event the library's handler received that `test` accepts, waiting up to `within`. */
const awaitReceived = (received: Ref.Ref<ReadonlyArray<AnyEvent>>, test: (event: AnyEvent) => boolean, within: Duration.Duration): Effect.Effect<Option.Option<AnyEvent>> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(within)
    for (;;) {
      const found = (yield* Ref.get(received)).find(test)
      if (found !== undefined) return Option.some(found)
      if ((yield* Clock.currentTimeMillis) >= deadline) return Option.none()
      yield* Effect.sleep(Duration.millis(50))
    }
  })

const need = <A>(value: A | undefined, what: string): Effect.Effect<A> => (value === undefined ? Effect.die(new Error(`session: no ${what}`)) : Effect.succeed(value))

const quiet = { allowed_mentions: { parse: [] } } as const

/** What a trigger produced: how to recognise its own dispatch, and (for a message) the library's event. */
interface Fired {
  readonly matches: (data: unknown) => boolean
  readonly library: (event: AnyEvent) => boolean
}

const postBy = (rest: DiscordRestService, channel: ChannelId, body: Record<string, unknown>, step: string): Effect.Effect<MessageId, LabRequestFailed> =>
  rest.createMessage(channel, { ...quiet, ...body }).pipe(labStep(step), Effect.flatMap(Wire.decode(Created, "createMessage")), Effect.map((created) => created.id))

const messageFired = (id: MessageId): Fired => ({
  matches: matches(MessageDispatch, (message) => message.id === id),
  library: (event) => "message" in event && event.message.id === id
})

const fire = (trigger: Trigger, context: ProbeContext): Effect.Effect<Fired, LabRequestFailed, HarnessRest | TargetRest | SubjectRaw> =>
  Effect.gen(function* () {
    const harness = yield* HarnessRest
    const target = yield* TargetRest
    const subject = yield* SubjectRaw
    const { ids } = context
    const here = context.channelId
    switch (trigger) {
      case "target-message":
        return messageFired(yield* postBy(target, here, { content: "lab session" }, "session: the target's message"))
      case "target-mention":
        return messageFired(
          yield* postBy(target, here, { content: `lab session <@${ids.subjectUserId}>`, allowed_mentions: { parse: [], users: [ids.subjectUserId] } }, "session: the target's mention of the subject")
        )
      case "target-reply": {
        const replied = yield* need(context.subjectMessage, "subject message to reply to")
        return messageFired(
          yield* postBy(
            target,
            here,
            { content: "lab session reply", message_reference: { message_id: replied.id, fail_if_not_exists: true }, allowed_mentions: { parse: [], replied_user: true } },
            "session: the target's ping-on reply to the subject"
          )
        )
      }
      case "subject-message":
        return messageFired(yield* postBy(subject, here, { content: "lab session own" }, "session: the subject's own message"))
      case "target-reaction": {
        const message = yield* need(context.harnessMessage, "harness message to react to")
        yield* target.addMyMessageReaction(here, message.id, encodeURIComponent("👍")).pipe(labStep("session: the target's reaction"))
        return {
          matches: matches(ReactionDispatch, (reaction) => reaction.message_id === message.id && reaction.user_id === ids.targetUserId),
          library: (event) => "messageId" in event && event.messageId === message.id && event.userId === ids.targetUserId
        }
      }
      case "target-typing":
        yield* target.triggerTypingIndicator(here).pipe(labStep("session: the target types"))
        return {
          matches: matches(TypingDispatch, (typing) => typing.channel_id === here && typing.user_id === ids.targetUserId),
          library: (event) => "channelId" in event && !("messageId" in event) && event.channelId === here && event.userId === ids.targetUserId
        }
      case "target-nickname":
        yield* harness.updateGuildMember(ids.guildId, ids.targetUserId, { nick: "lab-session" }).pipe(labStep("session: the target's nickname"))
        return {
          matches: matches(MemberDispatch, (member) => member.user.id === ids.targetUserId),
          library: (event) => "roleIds" in event && event.userId === ids.targetUserId
        }
      case "channel-slowmode": {
        const botsOnly = yield* need(ids.channels.get("lab-bots-only"), "ID for lab-bots-only")
        yield* harness.updateChannel(botsOnly, { rate_limit_per_user: 2 }).pipe(labStep("session: lab-bots-only slowmode (the trigger)"))
        return {
          matches: matches(ChannelDispatch, (channel) => channel.id === botsOnly),
          library: (event) => "obfuscated" in event && event.channel.id === botsOnly
        }
      }
    }
  })

/** Runs the canary, and returns how to recognise its dispatch. */
const canary = (spec: SessionSpec, context: ProbeContext): Effect.Effect<(data: unknown) => boolean, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const harness = yield* HarnessRest
    const { ids } = context
    if (spec.canary === "GUILD_MEMBER_UPDATE") {
      yield* harness.updateGuildMember(ids.guildId, ids.subjectUserId, { nick: "lab-canary" }).pipe(labStep("session: the subject's nickname (the canary)"))
      return matches(MemberDispatch, (member) => member.user.id === ids.subjectUserId)
    }
    const botsOnly = yield* need(ids.channels.get("lab-bots-only"), "ID for lab-bots-only")
    yield* harness.updateChannel(botsOnly, { rate_limit_per_user: 1 }).pipe(labStep("session: lab-bots-only slowmode (the canary)"))
    return matches(ChannelDispatch, (channel) => channel.id === botsOnly)
  })

const libraryDisagrees = (what: string): Observation => ({ _tag: "Rejected", status: 0, code: 0, inner: [{ path: "library", code: what }] })

/** Runs the session `name` (see the module comment). */
export const run = (name: SessionName, context: ProbeContext): Effect.Effect<ProbeResult, LabRequestFailed, HarnessRest | TargetRest | SubjectRaw | Sessions> =>
  Effect.gen(function* () {
    const spec = sessions[name]
    const log = yield* Ref.make<ReadonlyArray<Recorded>>([])
    const received = yield* Ref.make<ReadonlyArray<AnyEvent>>([])
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* Sessions)
          .open(spec.intents, (event, data) => Ref.update(log, (all) => [...all, { event, data }]))
          .pipe(Effect.catch((error) => Effect.die(new Error(`infrastructure abort: session ${name} did not start: ${error._tag} ${"reason" in error ? error.reason : ""}`))))
        // the library's handler for the observed event, through the session's own runtime
        yield* botWithRuntimeIntents(spec.intents)
          .on(spec.event, (event: AnyEvent) => Ref.update(received, (all) => [...all, event]))
          .pipe(Effect.provideService(BotRuntime, session.runtime))
        const ready = yield* awaitDispatch(log, "READY", () => true, readyWithin)
        const readyUser = Option.flatMap(ready, (entry) => Schema.decodeUnknownOption(ReadyUser)(entry.data))
        if (Option.isNone(readyUser) || readyUser.value.user.id !== context.ids.subjectUserId) {
          return yield* Effect.die(new Error(`infrastructure abort: session ${name}: READY ${Option.isNone(readyUser) ? "never arrived" : `named ${readyUser.value.user.id}`}, not the subject`))
        }
        const sent = (yield* session.identified).at(-1)
        if (sent === undefined || sent.intents !== intentBits(spec.intents) || sent.capabilities !== channelObfuscation) {
          return yield* Effect.die(new Error(`infrastructure abort: session ${name}: Identify sent ${JSON.stringify(sent)}, not intents ${intentBits(spec.intents)} with ChannelObfuscation`))
        }
        const fired = yield* fire(spec.trigger, context)
        const isCanary = yield* canary(spec, context)
        const canaryArrived = yield* awaitDispatch(log, spec.canary, isCanary, canaryWithin)
        const own = yield* awaitDispatch(log, spec.event, fired.matches, graceAfterCanary)
        const library = Option.isSome(own) ? yield* awaitReceived(received, fired.library, graceAfterCanary) : Option.none()
        return { canaryArrived: Option.isSome(canaryArrived), own, library }
      })
    )
    // the canary's nickname is the subject's; nothing else resets it before the next reset
    if (spec.canary === "GUILD_MEMBER_UPDATE") {
      yield* (yield* HarnessRest).updateGuildMember(context.ids.guildId, context.ids.subjectUserId, { nick: null }).pipe(labStep("session: clear the subject's nickname"))
    }
    const absent: Observation = { _tag: "EventAbsent", event: spec.event, canary: outcome.canaryArrived ? spec.canary : "none" }
    if (Option.isNone(outcome.own)) return { observation: absent, raw: Outcome.event(false), created: [] }
    if (Option.isNone(outcome.library)) return { observation: libraryDisagrees(`bot.on received no ${spec.event}`), raw: Outcome.event(true), created: [] }
    if (spec.observe === "delivery") return { observation: { _tag: "EventDelivered", event: spec.event }, raw: Outcome.event(true), created: [] }
    const raw = yield* Schema.decodeUnknownEffect(MessageDispatch)(outcome.own.value.data).pipe(Effect.orDie)
    const event = outcome.library.value
    if (!("message" in event)) return { observation: libraryDisagrees("bot.on's MESSAGE_CREATE has no message"), raw: Outcome.event(true), created: [] }
    const delivered = raw.content.length > 0
    const agrees = event.message.contentDelivered ? delivered && event.message.content === raw.content : !delivered
    if (!agrees) {
      return {
        observation: libraryDisagrees(`contentDelivered ${event.message.contentDelivered}, Discord ${delivered ? "delivered" : "withheld"} the content`),
        raw: Outcome.event(true),
        created: []
      }
    }
    return { observation: delivered ? { _tag: "Applied", field: "content" } : { _tag: "Ignored", field: "content" }, raw: Outcome.event(true), created: [] }
  })
