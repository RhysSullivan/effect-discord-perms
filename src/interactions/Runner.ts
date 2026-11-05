/**
 * The interaction runner (DESIGN §4.14, phase 3): `Interactions.command`, `.component`, `.modal` and `.autocomplete`
 * register handlers on the bot's INTERACTION_CREATE dispatches, and the runner answers each interaction.
 *
 * - **Routing.** A command (and an autocomplete) by its type and name; a component or a modal submit by its
 *   `custom_id`'s route prefix (`CustomId.routeNameOf`). A `custom_id` with the route's prefix that does not decode is
 *   an old control, not a defect: the runner answers with an ephemeral "This control has expired." and logs it. Each
 *   registration subscribes on its own, as `bot.on` does: register a command or route once.
 * - **Auto-defer never interrupts the handler.** The runner forks the handler and waits for it with
 *   `Fiber.await(fiber).pipe(Effect.timeoutOption(2500 millis))`, through `Clock` (so `TestClock` drives it). A handler
 *   that finishes first gives the initial response. Otherwise the runner posts the mode's deferral (5, with EPHEMERAL in
 *   "ephemeral"; 6 in "update") and waits for the handler again; its reply or update is then delivered as
 *   `PATCH /webhooks/{application.id}/{interaction.token}/messages/@original` (the deferred message, or in "update" the
 *   component's message), and a handler that deferred itself posts nothing more. "manual" (and autocomplete, which has
 *   no deferral) posts nothing: a handler slower than Discord's 3 s gets `InteractionExpired` (10062), which is logged.
 * - **Continuations** (`reply`'s `then`, `defer`'s and `deferUpdate`'s) run only after their response was posted or
 *   delivered, within 14 minutes (the token lasts 15); `giveUp` logs at Info.
 * - **Failures** never escape a registration: a handler's transient failure or defect, a payload that does not decode
 *   or fit the command's definition (`Wire.Malformed`), and a response Discord refused are logged; a handler span
 *   (`discord.interaction.<kind>`) is applied before any recovery, so a failed handler shows as failed in traces.
 * - **Interaction context.** `ix.channel` is a handle whose preflight reads `app_permissions` (basis
 *   `"app-permissions"`, §4.7); a channel option's handle reads its resolved channel's `permissions`.
 *
 * Interactions outside a guild are dropped with a log: commands are registered in a guild only (D18).
 */
import { Cause, Duration, Effect, Exit, Fiber, Option, Predicate, type Scope } from "effect"
import { type Handled, handledEffect } from "../bot/Handler.ts"
import { BotRuntime } from "../bot/Runtime.ts"
import type { GuildMessageKind, MessageChannel } from "../channels/Channel.ts"
import { channelHandle, type Runtime } from "../channels/Ops.ts"
import type { AnyChatInputCommand, ChatInputCommand } from "../commands/Command.ts"
import { type ComponentRoute, routeNameOf } from "../components/CustomId.ts"
import { type DiscordResponse, PreflightDecision } from "../errors/Cause.ts"
import { missing, type PermissionErrors } from "../errors/Missing.generated.ts"
import { ContentTooLong, EmbedTooLarge, MessageEmpty } from "../errors/Payload.ts"
import { PermissionDeniedUnattributed } from "../errors/Permission.ts"
import { InteractionExpired } from "../errors/State.ts"
import type { Transient } from "../errors/Transient.ts"
import { embedLimitExceeded, Limits, lengthOf } from "../payload/Limits.ts"
import type { EditArg, EditMessage } from "../payload/Message.ts"
import type { ContentTooLongIn, EditEmbedTooLargeIn, EditMessageEmptyIn, EmbedTooLargeIn, MessageEmptyIn } from "../payload/PayloadRules.ts"
import { actionRow, editRequest, embedRequest } from "../payload/ToDfx.ts"
import * as Flags from "../permissions/Flags.ts"
import type { Route } from "../rest/DiscordApi.ts"
import { UnmappedDiscordError } from "../rest/ErrorMap.ts"
import type { GuildId } from "../Snowflake.ts"
import { kindOfType } from "../state/Snapshot.ts"
import {
  type Answered,
  type AutocompleteInteraction,
  type CommandInteraction,
  type CommandIx,
  type CommandMode,
  type Completed,
  completed,
  type ComponentIx,
  type ComponentMode,
  type EphemeralMatches,
  type HandledCompletion,
  type HandledIx,
  type InteractionContext,
  type Interactions as InteractionsApi,
  makeResponse,
  type ManualCommandInteraction,
  type ManualComponentInteraction,
  type Modal,
  type ModalMode,
  type ModalSubmitInteraction,
  type MustComplete,
  type MustRespond,
  planOf,
  type Replies,
  type ReplyArg,
  type ReplyComponentInteraction,
  type ReplyPayload,
  type RequirementOf,
  type Response,
  type ResponsePlan,
  type UpdateComponentInteraction,
  type Updates
} from "./Interaction.ts"
import { CommandData, ComponentData, decodeAs, focusedOf, InteractionType, InteractionWire, invocationOf, Malformed, ModalData, modalFields } from "./Wire.ts"

/** How long the runner waits for a handler before it posts the mode's deferral (Discord allows 3 s). */
export const autoDeferAfter = Duration.millis(2500)

/** How long a continuation may run (an interaction token lasts 15 minutes). */
export const continuationDeadline = Duration.minutes(14)

/** The ephemeral reply to a control whose `custom_id` no longer decodes. */
export const expiredControl = "This control has expired."

/** Discord's interaction callback types. */
export const CallbackType = { reply: 4, defer: 5, deferUpdate: 6, update: 7, choices: 8, modal: 9 } as const

/** Message flags an interaction response sets. */
export const ResponseFlags = { ephemeral: 64, suppressNotifications: 4096 } as const

/** The routes the runner calls (the token is a path segment, so only these templates reach spans and causes). */
export const routes = {
  callback: { method: "POST", template: "/interactions/{interaction.id}/{interaction.token}/callback" },
  followUp: { method: "POST", template: "/webhooks/{application.id}/{interaction.token}" },
  editOriginal: { method: "PATCH", template: "/webhooks/{application.id}/{interaction.token}/messages/@original" },
  deleteOriginal: { method: "DELETE", template: "/webhooks/{application.id}/{interaction.token}/messages/@original" }
} as const satisfies Record<string, Route>

/** What every response method closes over: the interaction's REST identity and what the logs name it by. */
export interface Session {
  readonly runtime: Runtime
  readonly wire: InteractionWire
  /** `app_permissions`, for a follow-up's refusal. */
  readonly appPermissions: Flags.PermissionSet | undefined
  /** For logs and spans: `command ban`, `component vote`. Never the token. */
  readonly label: string
}

/** The defer behaviour of one registration. */
export type DeferMode = "public" | "ephemeral" | "update" | "manual"

const callbackPath = (session: Session): string => `/interactions/${session.wire.id}/${session.wire.token}/callback`
const webhookPath = (session: Session): string => `/webhooks/${session.wire.application_id}/${session.wire.token}`
const originalPath = (session: Session): string => `${webhookPath(session)}/messages/@original`

const localCause = (route: string): PreflightDecision => new PreflightDecision({ route, basis: "payload-check" })

/** Interaction codes that mean the token is gone: unknown interaction, unknown webhook, invalid webhook token. */
const expiredCodes: ReadonlySet<number> = new Set([10062, 10015, 50027])

/** A refusal of one of the runner's calls, mapped: an expired token, an emptied message, or an unmapped defect. */
const refusalOf = (route: Route, response: DiscordResponse): Effect.Effect<InteractionExpired | MessageEmpty> => {
  if (expiredCodes.has(response.code)) return Effect.succeed(new InteractionExpired({ cause: response }))
  if (response.code === 50006 && route.method !== "DELETE") return Effect.succeed(new MessageEmpty({ cause: response }))
  return Effect.die(new UnmappedDiscordError({ operation: `interaction ${route.method} ${route.template}`, reason: "an answer the interaction routes do not expect", response }))
}

// ---- local checks and bodies ------------------------------------------------------------------------------

type ReplyFailure = MessageEmpty | ContentTooLong | EmbedTooLarge

/** A reply's or follow-up's local problems, in tier 7's order. */
const replyFailures = (payload: ReplyPayload, route: string): ReadonlyArray<ReplyFailure> => {
  const cause = localCause(route)
  const out: Array<ReplyFailure> = []
  const empty = (payload.content ?? "").length === 0 && (payload.embeds ?? []).length === 0 && (payload.components ?? []).length === 0
  if (empty) out.push(new MessageEmpty({ cause }))
  if (payload.content !== undefined && lengthOf(payload.content) > Limits.content) out.push(new ContentTooLong({ length: lengthOf(payload.content), limit: Limits.content, cause }))
  const embed = embedLimitExceeded(payload.embeds ?? [])
  if (embed !== undefined) out.push(new EmbedTooLarge({ limit: embed, cause }))
  return out
}

/** An edit's local problems (its emptiness depends on the message, so Discord judges it: 50006). */
const editFailures = (patch: EditMessage, route: string): ReadonlyArray<ContentTooLong | EmbedTooLarge> => {
  const cause = localCause(route)
  const out: Array<ContentTooLong | EmbedTooLarge> = []
  if (patch.content !== undefined && lengthOf(patch.content) > Limits.content) out.push(new ContentTooLong({ length: lengthOf(patch.content), limit: Limits.content, cause }))
  const embed = embedLimitExceeded(patch.embeds ?? [])
  if (embed !== undefined) out.push(new EmbedTooLarge({ limit: embed, cause }))
  return out
}

/** A reply's message body. The library pings nobody from an interaction response (H-133). */
const messageBody = (payload: ReplyPayload): Readonly<Record<string, unknown>> => ({
  allowed_mentions: { parse: [] },
  ...(payload.content === undefined ? {} : { content: payload.content }),
  ...(payload.embeds === undefined ? {} : { embeds: payload.embeds.map(embedRequest) }),
  ...(payload.components === undefined ? {} : { components: payload.components.map(actionRow) })
})

/** A reply's or follow-up's flags: EPHEMERAL and SUPPRESS_NOTIFICATIONS, as set. */
const flagsOf = (payload: ReplyPayload): number => (payload.ephemeral === true ? ResponseFlags.ephemeral : 0) | (payload.suppressNotifications === true ? ResponseFlags.suppressNotifications : 0)

/** A message body with its flags (none when zero). */
const withFlags = (payload: ReplyPayload): Readonly<Record<string, unknown>> => {
  const flags = flagsOf(payload)
  return flags === 0 ? messageBody(payload) : { ...messageBody(payload), flags }
}

const modalLimits = { title: 45, label: 45, inputs: 5 } as const

/** A modal's callback data; a title, label or input count past Discord's limits is a defect (literals in the code). */
const modalData = (modal: Modal): Effect.Effect<Readonly<Record<string, unknown>>> => {
  if (lengthOf(modal.title) > modalLimits.title) return Effect.die(new Error(`showModal: the title has ${lengthOf(modal.title)} characters (at most ${modalLimits.title})`))
  if (modal.inputs.length > modalLimits.inputs) return Effect.die(new Error(`showModal: ${modal.inputs.length} inputs (at most ${modalLimits.inputs})`))
  const long = modal.inputs.find((input) => lengthOf(input.label) > modalLimits.label)
  if (long !== undefined) return Effect.die(new Error(`showModal: input ${long.customId}'s label has ${lengthOf(long.label)} characters (at most ${modalLimits.label})`))
  return Effect.succeed({
    custom_id: modal.customId,
    title: modal.title,
    components: modal.inputs.map((input) => ({
      type: 1,
      components: [
        {
          type: 4,
          custom_id: input.customId,
          label: input.label,
          style: input.style === "short" ? 1 : 2,
          ...(input.required === undefined ? {} : { required: input.required }),
          ...(input.minLength === undefined ? {} : { min_length: input.minLength }),
          ...(input.maxLength === undefined ? {} : { max_length: input.maxLength }),
          ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
          ...(input.value === undefined ? {} : { value: input.value })
        }
      ]
    }))
  })
}

// ---- reporting ------------------------------------------------------------------------------------------

const tagOf = (error: unknown): string => (Predicate.hasProperty(error, "_tag") && typeof error._tag === "string" ? error._tag : "an untagged error")

/** What a failure is logged as; never fails. */
const report = (label: string, what: string) => <E>(cause: Cause.Cause<E>): Effect.Effect<void> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  const failure = Cause.findErrorOption(cause)
  if (Option.isNone(failure)) return Effect.logError(`discord.interaction ${label}: ${what} died`, cause)
  const error = failure.value
  if (error instanceof Malformed) return Effect.logError(`discord.interaction ${label}: dropped: ${error.detail}`)
  return Effect.logWarning(`discord.interaction ${label}: ${what} failed: ${tagOf(error)}`)
}

// ---- answering ------------------------------------------------------------------------------------------

/** Posts the initial response (or a deferral); whether Discord took it. A refusal or no answer is logged. */
const postCallback = (session: Session, callback: ResponsePlan<unknown>["callback"], what: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const answer = yield* session.runtime.api.sendJson(routes.callback, callbackPath(session), callback)
    if (answer._tag === "Ok") return true
    const refused = yield* refusalOf(routes.callback, answer.response)
    yield* Effect.logWarning(`discord.interaction ${session.label}: ${what} was refused: ${refused._tag} (${answer.response.code})`)
    return false
  }).pipe(Effect.catch((error: Transient) => Effect.as(Effect.logWarning(`discord.interaction ${session.label}: ${what} got no answer: ${error._tag}`), false)))

/** Delivers a response after the runner's own deferral; whether it was delivered. */
const deliverAfterDeferral = (session: Session, mode: Exclude<DeferMode, "manual">, plan: ResponsePlan<unknown>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const updating = plan.kind === "update" || plan.kind === "defer-update"
    if (plan.kind === "modal" || plan.kind === "choices" || updating !== (mode === "update")) {
      return yield* Effect.die(new Error(`discord.interaction ${session.label}: a ${plan.kind} response cannot follow the ${mode} mode's deferral`))
    }
    // a handler that deferred itself (as the mode fixes it) has nothing more to post
    if (plan.afterDeferral === undefined) return true
    const answer = yield* session.runtime.api.sendJson(routes.editOriginal, originalPath(session), plan.afterDeferral)
    if (answer._tag === "Ok") return true
    const refused = yield* refusalOf(routes.editOriginal, answer.response)
    yield* Effect.logWarning(`discord.interaction ${session.label}: the ${plan.kind} after the deferral was refused: ${refused._tag} (${answer.response.code})`)
    return false
  }).pipe(Effect.catch((error: Transient) => Effect.as(Effect.logWarning(`discord.interaction ${session.label}: the ${plan.kind} after the deferral got no answer: ${error._tag}`), false)))

/** The deferral the runner posts for `mode` when the handler is slow. */
const deferralOf = (mode: Exclude<DeferMode, "manual">): ResponsePlan<unknown>["callback"] =>
  mode === "update" ? { type: CallbackType.deferUpdate } : mode === "ephemeral" ? { type: CallbackType.defer, data: { flags: ResponseFlags.ephemeral } } : { type: CallbackType.defer }

/**
 * The plan of the response a handler of result type `A` returned. Only `makeResponse<R>` registers a plan, for the
 * `Response<R>` it returns, so the plan of a value of type `Response<R>` is a `ResponsePlan<R>`.
 */
function planFor<A>(value: A): ResponsePlan<RequirementOf<A>> | undefined
// SAFETY: see the comment above; the wide implementation only looks the plan up.
function planFor(value: unknown): ResponsePlan<unknown> | undefined {
  return planOf(value)
}

/**
 * Answers one interaction with `handler`'s response under `mode` (see the module comment): the auto-defer, the
 * posting and the continuation. Never fails.
 */
export const respond = <A, E, R>(session: Session, mode: DeferMode, handler: Effect.Effect<A, E, R>): Effect.Effect<void, never, R | RequirementOf<A>> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(handler)
    const early = mode === "manual" ? Option.some(yield* Fiber.await(fiber)) : yield* Fiber.await(fiber).pipe(Effect.timeoutOption(autoDeferAfter))
    const deferredBy = Option.isSome(early) || mode === "manual" ? undefined : mode
    const deferred = deferredBy === undefined ? true : yield* postCallback(session, deferralOf(deferredBy), "the deferral")
    const exit = Option.isSome(early) ? early.value : yield* Fiber.await(fiber)
    if (Exit.isFailure(exit)) return yield* report(session.label, "the handler")(exit.cause)
    const plan = planFor(exit.value)
    if (plan === undefined) return yield* Effect.logError(`discord.interaction ${session.label}: the handler returned no response`)
    const posted = deferredBy === undefined ? yield* postCallback(session, plan.callback, `the ${plan.kind}`) : deferred && (yield* deliverAfterDeferral(session, deferredBy, plan))
    if (!posted || plan.continuation === undefined) return
    const finished = yield* plan.continuation(answeredFor(session)).pipe(Effect.timeoutOption(continuationDeadline))
    if (Option.isNone(finished)) yield* Effect.logWarning(`discord.interaction ${session.label}: the continuation passed ${Duration.format(continuationDeadline)}; the token lasts 15 minutes`)
  })

/** A continuation as the runner runs it: in its span, failures logged, never escaping. */
const continuation = <A, E, R>(session: Session, run: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
  run.pipe(Effect.asVoid, Effect.withSpan("discord.interaction.continuation", { attributes: { "discord.interaction": session.label } }), Effect.catchCause(report(session.label, "the continuation")))

// ---- Answered ---------------------------------------------------------------------------------------------

type FollowUpFailure = PermissionErrors["SendMessages"] | PermissionDeniedUnattributed | InteractionExpired | Transient | ReplyFailure

/** The follow-ups and edits of an answered interaction (see `Interaction.ts`). */
const answeredFor = (session: Session): Answered => {
  function followUp<const P extends ReplyPayload>(
    payload: ReplyArg<P, "manual">
  ): Effect.Effect<
    void,
    | PermissionErrors["SendMessages"]
    | PermissionDeniedUnattributed
    | InteractionExpired
    | Transient
    | ContentTooLongIn<P>
    | MessageEmptyIn<P>
    | EmbedTooLargeIn<P>
  >
  function followUp(payload: ReplyPayload): Effect.Effect<void, FollowUpFailure> {
    return Effect.gen(function* () {
      const [local] = replyFailures(payload, routes.followUp.template)
      if (local !== undefined) return yield* Effect.fail(local)
      const answer = yield* session.runtime.api.sendJson(routes.followUp, webhookPath(session), withFlags(payload))
      if (answer._tag === "Ok") return
      if (answer.response.code === 50013) {
        // attributed from the interaction's own permissions, never guessed: MissingSendMessages only when app_permissions
        // is present and lacks the flag; held, or absent, it is unattributed
        const lacks = session.appPermissions !== undefined && !Flags.has(session.appPermissions, "SendMessages")
        return yield* Effect.fail(lacks ? missing.SendMessages(answer.response) : new PermissionDeniedUnattributed({ cause: answer.response }))
      }
      return yield* Effect.fail(yield* refusalOf(routes.followUp, answer.response))
    }).pipe(Effect.withSpan("discord.interaction.followUp", { attributes: { "discord.interaction": session.label } }))
  }
  function editOriginal<const P extends EditMessage>(
    patch: EditArg<P>
  ): Effect.Effect<
    Completed,
    | InteractionExpired
    | Transient
    | ContentTooLongIn<P>
    | EditMessageEmptyIn<P>
    | EditEmbedTooLargeIn<P>
  >
  function editOriginal(patch: EditMessage): Effect.Effect<Completed, InteractionExpired | Transient | ReplyFailure> {
    return Effect.gen(function* () {
      const [local] = editFailures(patch, routes.editOriginal.template)
      if (local !== undefined) return yield* Effect.fail(local)
      const answer = yield* session.runtime.api.sendJson(routes.editOriginal, originalPath(session), editRequest(patch))
      if (answer._tag === "Ok") return completed
      return yield* Effect.fail(yield* refusalOf(routes.editOriginal, answer.response))
    }).pipe(Effect.withSpan("discord.interaction.editOriginal", { attributes: { "discord.interaction": session.label } }))
  }
  const deleteOriginal = (): Effect.Effect<void, InteractionExpired | Transient> =>
    Effect.gen(function* () {
      const answer = yield* session.runtime.api.sendJson(routes.deleteOriginal, originalPath(session), undefined)
      if (answer._tag === "Ok") return
      const refused = yield* refusalOf(routes.deleteOriginal, answer.response)
      if (refused._tag === "InteractionExpired") return yield* Effect.fail(refused)
      return yield* Effect.die(new UnmappedDiscordError({ operation: "interaction deleteOriginal", reason: "an answer a delete does not expect", response: answer.response }))
    }).pipe(Effect.withSpan("discord.interaction.deleteOriginal", { attributes: { "discord.interaction": session.label } }))
  const giveUp = (expired: InteractionExpired): Effect.Effect<Completed> =>
    Effect.as(Effect.logInfo(`discord.interaction ${session.label}: gave up: the interaction token expired (${expired._tag})`), completed)
  return { followUp, editOriginal, deleteOriginal, giveUp }
}

// ---- the response methods -----------------------------------------------------------------------------

/** A deferral's continuation as the Effect it is when the program compiles (see `handledEffect`). */
function completion<A, E, R>(value: HandledCompletion<A, E, R>, what: string): Effect.Effect<A, E, R>
// SAFETY: `HandledCompletion<A, E, R>` resolves to `Handled<A, E, R>`, so to `Effect<A, E, R>`, in every program that
// compiles; `MustComplete` and `UnhandledErrors` have no runtime value.
function completion(value: Effect.Effect<unknown, unknown, unknown> | MustComplete | Handled<unknown, unknown, unknown>, what: string): Effect.Effect<unknown, unknown, unknown> {
  return Effect.isEffect(value) ? value : Effect.die(new Error(`${what}: a continuation returned no Effect`))
}

/** A handler's result as the Effect it is when the program compiles. */
function handlerResult<A, E, R>(value: HandledIx<A, E, R>, what: string): Effect.Effect<A, E, R>
// SAFETY: `HandledIx<A, E, R>` resolves to `Handled<A, E, R>`, so to `Effect<A, E, R>`, in every program that compiles;
// `MustRespond` and `UnhandledErrors` have no runtime value.
function handlerResult(value: Effect.Effect<unknown, unknown, unknown> | MustRespond | Handled<unknown, unknown, unknown>, what: string): Effect.Effect<unknown, unknown, unknown> {
  return Effect.isEffect(value) ? value : Effect.die(new Error(`${what}: a handler returned no Effect`))
}

/** `reply` and `defer` under mode `M`. */
const repliesFor = <M>(session: Session): Replies<M> => {
  function reply<const P extends ReplyPayload, A2 = unknown, E2 = never, R2 = never>(
    payload: ReplyArg<P, M>,
    then?: (answered: Answered) => Handled<A2, E2, R2>
  ): Effect.Effect<
    Response<R2>,
    | ContentTooLongIn<P>
    | MessageEmptyIn<P>
    | EmbedTooLargeIn<P>
  >
  function reply<A2, E2, R2>(payload: ReplyPayload, then?: (answered: Answered) => Handled<A2, E2, R2>): Effect.Effect<Response<R2>, ReplyFailure> {
    const [local] = replyFailures(payload, routes.callback.template)
    if (local !== undefined) return Effect.fail(local)
    return Effect.succeed(
      makeResponse<R2>({
        kind: "reply",
        callback: { type: CallbackType.reply, data: withFlags(payload) },
        afterDeferral: messageBody(payload),
        continuation: then === undefined ? undefined : (answered) => continuation(session, Effect.suspend(() => handledEffect(then(answered), `discord.interaction ${session.label}`)))
      })
    )
  }
  function defer<const X extends boolean, A2, E2, R2>(
    options: { readonly ephemeral: X & EphemeralMatches<X, M> },
    then: (deferred: Answered) => HandledCompletion<A2, E2, R2>
  ): Effect.Effect<Response<R2>>
  function defer<A2, E2, R2>(options: { readonly ephemeral: boolean }, then: (deferred: Answered) => HandledCompletion<A2, E2, R2>): Effect.Effect<Response<R2>> {
    return Effect.succeed(
      makeResponse<R2>({
        kind: "defer",
        callback: options.ephemeral === true ? { type: CallbackType.defer, data: { flags: ResponseFlags.ephemeral } } : { type: CallbackType.defer },
        afterDeferral: undefined,
        continuation: (answered) => continuation(session, Effect.suspend(() => completion(then(answered), `discord.interaction ${session.label}`)))
      })
    )
  }
  return { reply, defer }
}

/** `update` and `deferUpdate`. */
const updatesFor = (session: Session): Updates => {
  function update<const P extends EditMessage>(
    patch: EditArg<P>
  ): Effect.Effect<
    Response<never>,
    | ContentTooLongIn<P>
    | EditMessageEmptyIn<P>
    | EditEmbedTooLargeIn<P>
  >
  function update(patch: EditMessage): Effect.Effect<Response<never>, ContentTooLong | EmbedTooLarge> {
    const [local] = editFailures(patch, routes.callback.template)
    if (local !== undefined) return Effect.fail(local)
    const body = editRequest(patch)
    return Effect.succeed(makeResponse<never>({ kind: "update", callback: { type: CallbackType.update, data: body }, afterDeferral: body, continuation: undefined }))
  }
  const deferUpdate = <A2, E2, R2>(then: (deferred: Answered) => HandledCompletion<A2, E2, R2>): Effect.Effect<Response<R2>> =>
    Effect.succeed(
      makeResponse<R2>({
        kind: "defer-update",
        callback: { type: CallbackType.deferUpdate },
        afterDeferral: undefined,
        continuation: (answered) => continuation(session, Effect.suspend(() => completion(then(answered), `discord.interaction ${session.label}`)))
      })
    )
  return { update, deferUpdate }
}

/** `showModal`. */
const showModal = (modal: Modal): Effect.Effect<Response<never>> =>
  Effect.map(modalData(modal), (data) => makeResponse<never>({ kind: "modal", callback: { type: CallbackType.modal, data }, afterDeferral: undefined, continuation: undefined }))

const maxChoices = 25

/** `choices`: at most 25 (more is a defect: Discord refuses them). */
const choices = <V extends string | number>(list: ReadonlyArray<{ readonly name: string; readonly value: V }>): Effect.Effect<Response<never>> =>
  list.length > maxChoices
    ? Effect.die(new Error(`autocomplete: ${list.length} choices (at most ${maxChoices})`))
    : Effect.succeed(
      makeResponse<never>({
        kind: "choices",
        callback: { type: CallbackType.choices, data: { choices: list.map((choice) => ({ name: choice.name, value: choice.value })) } },
        afterDeferral: undefined,
        continuation: undefined
      })
    )

// ---- context and routing -----------------------------------------------------------------------------------

const isGuildMessageKind = (kind: string | undefined): kind is GuildMessageKind =>
  kind === "text" || kind === "announcement" || kind === "voice" || kind === "stage" || kind === "public-thread" || kind === "private-thread" || kind === "announcement-thread"

interface Context extends InteractionContext {
  readonly appPermissions: Flags.PermissionSet | undefined
}

/** The interaction's guild, user and channel (with `app_permissions` as its preflight basis). */
const contextOf = (runtime: Runtime, wire: InteractionWire): Effect.Effect<Context, Malformed> =>
  Effect.gen(function* () {
    const guildId: GuildId | undefined = wire.guild_id
    if (guildId === undefined) return yield* new Malformed({ detail: "an interaction outside a guild (commands are guild commands, D18)" })
    const user = wire.member?.user ?? wire.user
    if (user === undefined) return yield* new Malformed({ detail: "an interaction without a user" })
    const channel = wire.channel
    const kind = channel === undefined ? undefined : kindOfType(channel.type)
    if (channel === undefined || !isGuildMessageKind(kind)) return yield* new Malformed({ detail: `an interaction in a channel the library cannot answer in (type ${channel?.type ?? "absent"})` })
    const appPermissions = wire.app_permissions === undefined ? undefined : Flags.parse(wire.app_permissions)
    const handle: MessageChannel = channelHandle(runtime, { guildId, id: channel.id, kind }, [], appPermissions)
    return { guildId, user: { id: user.id }, channel: handle, appPermissions }
  })

/** The command's invocation, decoded against its own definition. */
function invocationFor<I>(runtime: Runtime, guildId: GuildId, command: ChatInputCommand<string, I>, data: CommandData): Effect.Effect<I, Malformed>
// SAFETY: `Command.*` computed `I` from `command.definition`, and `invocationOf` decodes `data` against that same
// definition (every required option present, each value of its option's type, choices and channel kinds checked), so
// the value has the shape `I` describes.
function invocationFor(runtime: Runtime, guildId: GuildId, command: AnyChatInputCommand, data: CommandData): Effect.Effect<unknown, Malformed> {
  return invocationOf(runtime, guildId, command.definition, data)
}

/**
 * Subscribes `handle` to INTERACTION_CREATE for the caller's scope; each interaction runs in its own fiber and scope,
 * and nothing it fails with escapes.
 */
const subscribe = <R>(label: string, handle: (runtime: Runtime, wire: InteractionWire) => Effect.Effect<void, Malformed, R>): Effect.Effect<void, never, Exclude<R, Scope.Scope> | BotRuntime | Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* BotRuntime
    yield* runtime.events.subscribe("INTERACTION_CREATE", (data) =>
      decodeAs(InteractionWire, "INTERACTION_CREATE", data).pipe(Effect.flatMap((wire) => handle(runtime, wire)), Effect.scoped, Effect.catchCause(report(label, "the interaction")))
    )
  })

/** Answers an old control with the ephemeral expired reply, and logs it. */
const expired = (session: Session, customId: string): Effect.Effect<void> =>
  Effect.andThen(
    Effect.logWarning(`discord.interaction ${session.label}: a custom_id of ${customId.length} characters no longer decodes; answering "${expiredControl}"`),
    postCallback(session, { type: CallbackType.reply, data: { content: expiredControl, flags: ResponseFlags.ephemeral, allowed_mentions: { parse: [] } } }, "the expired-control reply")
  )

/** The handler's run, in its span (applied before any recovery). */
const handlerSpan = <A, E, R>(kind: string, name: string, run: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  run.pipe(Effect.withSpan(`discord.interaction.${kind}`, { attributes: { "discord.interaction.name": name } }))

// ---- the entry points -----------------------------------------------------------------------------------

/**
 * A registration's handler as the runner calls it. The entry points' implementations accept a handler of any
 * interaction type (`(ix: never) => ...`, the supertype of every overload's handler), so this attaches the type of the
 * interaction the runner builds.
 */
function withMode<Ix, T>(handler: (ix: never) => T): (ix: Ix) => T
// SAFETY: the runner builds the interaction of the mode the caller registered, which is exactly the parameter type the
// overload gave the handler (`CommandIx<I, M>`, `ComponentIx<D, M>`, `ModalSubmitInteraction<D, M>` for that `M`), so
// the handler always receives the type it declared.
function withMode<T>(handler: (ix: never) => T): (ix: never) => T {
  return handler
}

type AnyCommandIx<I> = CommandInteraction<I, "public"> | CommandInteraction<I, "ephemeral"> | ManualCommandInteraction<I>
type AnyComponentIx<D> = UpdateComponentInteraction<D> | ReplyComponentInteraction<D, "public"> | ReplyComponentInteraction<D, "ephemeral"> | ManualComponentInteraction<D>
type AnyModalIx<D> = ModalSubmitInteraction<D, "public"> | ModalSubmitInteraction<D, "ephemeral">

function command<I, A, E, R>(command: ChatInputCommand<string, I>, handler: (ix: CommandInteraction<I, "public">) => HandledIx<A, E, R>): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
function command<I, const M extends CommandMode, A, E, R>(
  command: ChatInputCommand<string, I>,
  mode: M,
  handler: (ix: CommandIx<I, M>) => HandledIx<A, E, R>
): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
function command<I, A, E, R>(
  command: ChatInputCommand<string, I>,
  modeOrHandler: CommandMode | ((ix: never) => HandledIx<A, E, R>),
  maybeHandler?: (ix: never) => HandledIx<A, E, R>
): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope> {
  const mode: CommandMode = typeof modeOrHandler === "string" ? modeOrHandler : "public"
  const given = typeof modeOrHandler === "string" ? maybeHandler : modeOrHandler
  const handler = given === undefined ? undefined : withMode<AnyCommandIx<I>, HandledIx<A, E, R>>(given)
  const label = `command ${command.name}`
  if (handler === undefined) return Effect.die(new Error(`Interactions.command(${command.name}): no handler`))
  return subscribe(label, (runtime, wire) =>
    Effect.gen(function* () {
      if (wire.type !== InteractionType.command) return
      const data = yield* decodeAs(CommandData, `${label}: data`, wire.data)
      if (data.type !== 1 || data.name !== command.name) return
      const context = yield* contextOf(runtime, wire)
      const invocation = yield* invocationFor(runtime, context.guildId, command, data)
      const session: Session = { runtime, wire, appPermissions: context.appPermissions, label }
      const base = { guildId: context.guildId, user: context.user, channel: context.channel, invocation }
      const ix: AnyCommandIx<I> =
        mode === "manual"
          ? { ...base, ...repliesFor<"manual">(session), showModal }
          : mode === "ephemeral"
            ? { ...base, ...repliesFor<"ephemeral">(session) }
            : { ...base, ...repliesFor<"public">(session) }
      yield* respond(session, mode, handlerSpan("command", command.name, Effect.suspend(() => handlerResult(handler(ix), `discord.interaction ${label}`))))
    })
  )
}

function component<Name extends string, D, A, E, R>(route: ComponentRoute<Name, D>, handler: (ix: UpdateComponentInteraction<D>) => HandledIx<A, E, R>): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
function component<Name extends string, D, const M extends ComponentMode, A, E, R>(
  route: ComponentRoute<Name, D>,
  mode: M,
  handler: (ix: ComponentIx<D, M>) => HandledIx<A, E, R>
): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
function component<Name extends string, D, A, E, R>(
  route: ComponentRoute<Name, D>,
  modeOrHandler: ComponentMode | ((ix: never) => HandledIx<A, E, R>),
  maybeHandler?: (ix: never) => HandledIx<A, E, R>
): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope> {
  const mode: ComponentMode = typeof modeOrHandler === "string" ? modeOrHandler : "update"
  const given = typeof modeOrHandler === "string" ? maybeHandler : modeOrHandler
  const handler = given === undefined ? undefined : withMode<AnyComponentIx<D>, HandledIx<A, E, R>>(given)
  const label = `component ${route.name}`
  if (handler === undefined) return Effect.die(new Error(`Interactions.component(${route.name}): no handler`))
  return subscribe(label, (runtime, wire) =>
    Effect.gen(function* () {
      if (wire.type !== InteractionType.component) return
      const data = yield* decodeAs(ComponentData, `${label}: data`, wire.data)
      if (routeNameOf(data.custom_id) !== route.name) return
      const context = yield* contextOf(runtime, wire)
      const session: Session = { runtime, wire, appPermissions: context.appPermissions, label }
      const decoded = route.decode(data.custom_id)
      if (Option.isNone(decoded)) return yield* expired(session, data.custom_id)
      const base = { guildId: context.guildId, user: context.user, channel: context.channel, data: decoded.value }
      const ix: AnyComponentIx<D> =
        mode === "update"
          ? { ...base, ...updatesFor(session) }
          : mode === "manual"
            ? { ...base, ...repliesFor<"manual">(session), ...updatesFor(session), showModal }
            : mode === "ephemeral"
              ? { ...base, ...repliesFor<"ephemeral">(session) }
              : { ...base, ...repliesFor<"public">(session) }
      yield* respond(session, mode, handlerSpan("component", route.name, Effect.suspend(() => handlerResult(handler(ix), `discord.interaction ${label}`))))
    })
  )
}

function modal<Name extends string, D, A, E, R>(route: ComponentRoute<Name, D>, handler: (ix: ModalSubmitInteraction<D, "public">) => HandledIx<A, E, R>): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
function modal<Name extends string, D, const M extends ModalMode, A, E, R>(
  route: ComponentRoute<Name, D>,
  mode: M,
  handler: (ix: ModalSubmitInteraction<D, M>) => HandledIx<A, E, R>
): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
function modal<Name extends string, D, A, E, R>(
  route: ComponentRoute<Name, D>,
  modeOrHandler: ModalMode | ((ix: never) => HandledIx<A, E, R>),
  maybeHandler?: (ix: never) => HandledIx<A, E, R>
): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope> {
  const mode: ModalMode = typeof modeOrHandler === "string" ? modeOrHandler : "public"
  const given = typeof modeOrHandler === "string" ? maybeHandler : modeOrHandler
  const handler = given === undefined ? undefined : withMode<AnyModalIx<D>, HandledIx<A, E, R>>(given)
  const label = `modal ${route.name}`
  if (handler === undefined) return Effect.die(new Error(`Interactions.modal(${route.name}): no handler`))
  return subscribe(label, (runtime, wire) =>
    Effect.gen(function* () {
      if (wire.type !== InteractionType.modalSubmit) return
      const data = yield* decodeAs(ModalData, `${label}: data`, wire.data)
      if (routeNameOf(data.custom_id) !== route.name) return
      const context = yield* contextOf(runtime, wire)
      const session: Session = { runtime, wire, appPermissions: context.appPermissions, label }
      const decoded = route.decode(data.custom_id)
      if (Option.isNone(decoded)) return yield* expired(session, data.custom_id)
      const base = { guildId: context.guildId, user: context.user, channel: context.channel, data: decoded.value, fields: modalFields(data) }
      const ix: AnyModalIx<D> = mode === "ephemeral" ? { ...base, ...repliesFor<"ephemeral">(session) } : { ...base, ...repliesFor<"public">(session) }
      yield* respond(session, mode, handlerSpan("modal", route.name, Effect.suspend(() => handlerResult(handler(ix), `discord.interaction ${label}`))))
    })
  )
}

const autocomplete = <I, A, E, R>(
  command: ChatInputCommand<string, I>,
  handler: (ix: AutocompleteInteraction<string | number>) => HandledIx<A, E, R>
): Effect.Effect<void, never, Exclude<R | RequirementOf<A>, Scope.Scope> | BotRuntime | Scope.Scope> => {
  const label = `autocomplete ${command.name}`
  return subscribe(label, (runtime, wire) =>
    Effect.gen(function* () {
      if (wire.type !== InteractionType.autocomplete) return
      const data = yield* decodeAs(CommandData, `${label}: data`, wire.data)
      if (data.type !== 1 || data.name !== command.name) return
      const focused = focusedOf(data.options ?? [])
      if (focused === undefined) return yield* new Malformed({ detail: `${label}: no focused option` })
      const context = yield* contextOf(runtime, wire)
      const session: Session = { runtime, wire, appPermissions: context.appPermissions, label }
      const ix: AutocompleteInteraction<string | number> = { guildId: context.guildId, user: context.user, focused, choices }
      yield* respond(session, "manual", handlerSpan("autocomplete", command.name, Effect.suspend(() => handlerResult(handler(ix), `discord.interaction ${label}`))))
    })
  )
}

/** The interaction entry points (DESIGN §2.10; see the module comment). */
export const Interactions: InteractionsApi = { command, component, modal, autocomplete }
