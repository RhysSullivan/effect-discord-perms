/**
 * The interaction state machine's types (DESIGN §2.10, phase 3; `[sd:src/interactions.ts]`).
 *
 * The state machine is **value-level**. A handler returns exactly one initial {@link Response}, which only the
 * interaction's own methods make; follow-ups exist only inside the continuation that receives {@link Answered}. So
 * answering twice, or following up before answering, cannot be written.
 *
 * - **Responses are validated locally.** `ix.reply(...)`, `ix.update(...)`, `ix.defer(...)` and `ix.showModal(...)`
 *   return `Effect<Response<R>, E>`, where `E` holds the payload's limit errors (`ContentTooLong`, `MessageEmpty`,
 *   `EmbedTooLarge`, each only when the payload's type may break the limit, as for a send). The reply can be returned
 *   directly (`(ix) => ix.reply({ content: "pong" })`).
 * - **The defer mode is fixed at registration by a string argument** (rule 8 of §2.12): `"public"` and `"ephemeral"`
 *   auto-defer with DEFERRED_CHANNEL_MESSAGE (5), the second with EPHEMERAL, and offer `reply` and `defer`; `"update"`
 *   (components only, their default) auto-defers with DEFERRED_UPDATE_MESSAGE (6) and offers `update` and
 *   `deferUpdate`; `"manual"` posts nothing (Discord's 3 s limit applies) and also offers `showModal` (and `update` on
 *   a component). A modal submit never offers `showModal`; autocomplete offers only `choices`.
 * - **Ephemeral must match the mode** (H-227: a deferral fixes it).
 * - **A deferral must be completed**: its continuation succeeds with the nominal {@link Completed}, which only
 *   `editOriginal` and `giveUp` produce. The honest end of an expired token is
 *   `editOriginal(...).pipe(Effect.catchTag("InteractionExpired", deferred.giveUp))`.
 * - **Handlers must return a response**: anything else is {@link MustRespond}, a message-carrying type.
 *
 * The registration entry points (`Interactions.*`) and the runner are in `Runner.ts`.
 */
import type { Effect, Scope } from "effect"
import type { Handled } from "../bot/Handler.ts"
import type { BotRuntime } from "../bot/Runtime.ts"
import type { MessageChannel } from "../channels/Channel.ts"
import type { ChatInputCommand } from "../commands/Command.ts"
import type { ComponentRoute } from "../components/CustomId.ts"
import type { PermissionErrors } from "../errors/Missing.generated.ts"
import type { ContentTooLong, EmbedTooLarge, MessageEmpty } from "../errors/Payload.ts"
import type { PermissionDeniedUnattributed } from "../errors/Permission.ts"
import type { InteractionExpired } from "../errors/State.ts"
import type { Transient } from "../errors/Transient.ts"
import type { ActionRow, CustomId, Invalid } from "../payload/Components.ts"
import type { EditArg, EditMessage, Embed, KnownKeys, NonEmpty } from "../payload/Message.ts"
import type { EditMayEmpty, MayBeEmpty, MayBeTooLong, MayInclude } from "../payload/PayloadRules.ts"
import type { GuildId, UserId } from "../Snowflake.ts"

// ---- payloads -------------------------------------------------------------------------------------------

/** Fields valid in an interaction reply or follow-up; `ephemeral` exists only here (H-105, H-132). */
export interface ReplyPayload {
  readonly content?: string
  readonly embeds?: ReadonlyArray<Embed>
  readonly components?: ReadonlyArray<ActionRow>
  readonly ephemeral?: boolean
  readonly suppressNotifications?: boolean
}

/** A modal's text input. Discord allows a label of 45 characters and a value of 4000. */
export interface TextInput {
  readonly customId: string
  readonly label: string
  readonly style: "short" | "paragraph"
  readonly required?: boolean
  readonly minLength?: number
  readonly maxLength?: number
  readonly placeholder?: string
  readonly value?: string
}

/** A modal: its route-built `custom_id`, its title (45 characters) and one to five text inputs. */
export interface Modal {
  readonly customId: CustomId
  readonly title: string
  readonly inputs: readonly [TextInput, ...Array<TextInput>]
}

/** The defer mode of a command, fixed at registration ("manual": no auto-defer, `showModal` allowed). */
export type CommandMode = "public" | "ephemeral" | "manual"
/** The defer mode of a component ("update", the default, auto-defers with DEFERRED_UPDATE_MESSAGE). */
export type ComponentMode = "update" | "public" | "ephemeral" | "manual"
/** The defer mode of a modal submit (no modal can open from it, so no "manual" either). */
export type ModalMode = "public" | "ephemeral"

/** The ephemeral state a mode fixes: `false` for "public", `true` for "ephemeral", either for "manual". */
export type EphemeralFor<M> = M extends "public" ? false : M extends "ephemeral" ? true : boolean

/** An `ephemeral` value `X` under mode `M`: itself when the mode allows it, else a type naming the rule and the mode. */
export type EphemeralMatches<X, M> = [X] extends [EphemeralFor<M>] ? unknown : Invalid<`ephemeral must match the registration mode ${M & string}`>

/** After a deferral the ephemeral state cannot change (H-227), so a reply must agree with the registration. */
export type EphemeralCheck<P, M> = P extends { readonly ephemeral: infer X }
  ? [X] extends [EphemeralFor<M>]
    ? unknown
    : { readonly ephemeral: X & EphemeralMatches<X, M> }
  : unknown

/** Everything checked on a reply or follow-up: a body, known keys, the mode's ephemeral state. */
export type CheckReply<P, M> = NonEmpty<P> & KnownKeys<P, keyof ReplyPayload, "replying to an interaction"> & EphemeralCheck<P, M>

/** A reply argument: the payload with its checks (an alias, as `CreateArg` is, so implementations relate). */
export type ReplyArg<P, M> = P & CheckReply<P, M>

// ---- responses ------------------------------------------------------------------------------------------

/** How an initial response answers the interaction (Discord's callback types 4 to 9). */
export type ResponseKind = "reply" | "defer" | "update" | "defer-update" | "modal" | "choices"

/** The key of a response's phantom requirement. Not exported, so only {@link makeResponse} makes a `Response`. */
const ResponseTypeId: unique symbol = Symbol.for("effect-discord-perms/Response")

/**
 * What the runner posts for a response (internal): the callback's body, the body that delivers it after the runner's
 * own deferral (`PATCH .../messages/@original`; `undefined` when the response is itself a deferral), and the
 * continuation, which runs after posting and never fails (its failures are logged when it is made).
 */
export interface ResponsePlan<R> {
  readonly kind: ResponseKind
  readonly callback: { readonly type: number; readonly data?: object }
  readonly afterDeferral: object | undefined
  readonly continuation: ((answered: Answered) => Effect.Effect<void, never, R>) | undefined
}

/**
 * An initial response. Only interaction methods make one (its phantom key is a symbol this module does not export, so
 * an object literal is no `Response`, and the runner posts only a value {@link makeResponse} registered). `R` is what
 * its continuation needs.
 */
export interface Response<R> {
  readonly _tag: "Response"
  readonly kind: ResponseKind
  /** Phantom: what the continuation needs. Its value is always `undefined`; nothing reads it. */
  readonly [ResponseTypeId]: R
}

const plans = new WeakMap<object, ResponsePlan<unknown>>()

/** A response with `plan` (internal: the interaction methods in `Runner.ts`). */
export function makeResponse<R>(plan: ResponsePlan<R>): Response<R>
// SAFETY: the overload attaches the continuation's requirement to the wide response (rule 7 of §2.12). The phantom's
// value is `undefined` and never read; the plan, which is what the runner posts, is kept in `plans`.
export function makeResponse(plan: ResponsePlan<unknown>): Response<unknown> {
  const response: Response<unknown> = { _tag: "Response", kind: plan.kind, [ResponseTypeId]: undefined }
  plans.set(response, plan)
  return response
}

/** The plan of a value a handler returned, or `undefined` for anything {@link makeResponse} did not make. */
export const planOf = (value: unknown): ResponsePlan<unknown> | undefined => (typeof value === "object" && value !== null ? plans.get(value) : undefined)

/** The key of {@link Completed}'s brand. Not exported: only `editOriginal` and `giveUp` (the runner) make one. */
const CompletedTypeId: unique symbol = Symbol.for("effect-discord-perms/Completed")

/** Proof that a deferred interaction was finished. Nominal: only `editOriginal` and `giveUp` produce one. */
export interface Completed {
  readonly [CompletedTypeId]: "Completed"
}

/** The one `Completed` value (internal: the runner's `editOriginal` and `giveUp`). */
export const completed: Completed = Object.freeze({ [CompletedTypeId]: "Completed" as const })

/** After the initial response: follow-ups and edits exist only here. */
export interface Answered {
  /** Posts a follow-up message (`POST /webhooks/{application.id}/{interaction.token}`). */
  readonly followUp: <const P extends ReplyPayload>(
    payload: ReplyArg<P, "manual">
  ) => Effect.Effect<
    void,
    | PermissionErrors["SendMessages"]
    | PermissionDeniedUnattributed
    | InteractionExpired
    | Transient
    | (true extends MayBeTooLong<P> ? ContentTooLong : never)
    | (true extends MayBeEmpty<P> ? MessageEmpty : never)
    | (MayInclude<P, "embeds"> extends true ? EmbedTooLarge : never)
  >
  /** Edits the original response (`PATCH .../messages/@original`); the deferral's completion. */
  readonly editOriginal: <const P extends EditMessage>(
    patch: EditArg<P>
  ) => Effect.Effect<
    Completed,
    | InteractionExpired
    | Transient
    | (true extends MayBeTooLong<P> ? ContentTooLong : never)
    | (EditMayEmpty<P> extends true ? MessageEmpty : never)
    | (P extends { readonly embeds: infer E } ? (E extends readonly [] ? never : EmbedTooLarge) : never)
  >
  /** Deletes the original response. */
  readonly deleteOriginal: () => Effect.Effect<void, InteractionExpired | Transient>
  /**
   * The honest end of a deferral whose token expired (Discord's 15 minutes): needs the `InteractionExpired` value,
   * logs it at Info, and completes. `Effect.catchTag("InteractionExpired", deferred.giveUp)`.
   */
  readonly giveUp: (expired: InteractionExpired) => Effect.Effect<Completed>
}

/** Shown instead of a deferral's continuation when it does not finish with `Completed`. */
export interface MustComplete {
  readonly "a deferred interaction must finish with deferred.editOriginal(...) or deferred.giveUp(...)": true
}

/** A deferral's continuation, checked on a message-carrying type (rule 5 of §2.12). */
export type HandledCompletion<A, E, R> = [A] extends [Completed] ? Handled<A, E, R> : MustComplete

/** `reply` and `defer`, under mode `M`. */
export interface Replies<M> {
  /**
   * Answers with a message (callback 4; after the runner's deferral, `PATCH .../messages/@original`). `then`, if
   * given, runs after the answer is posted, with the follow-ups.
   */
  readonly reply: <const P extends ReplyPayload, A2 = unknown, E2 = never, R2 = never>(
    payload: ReplyArg<P, M>,
    then?: (answered: Answered) => Handled<A2, E2, R2>
  ) => Effect.Effect<
    Response<R2>,
    | (true extends MayBeTooLong<P> ? ContentTooLong : never)
    | (true extends MayBeEmpty<P> ? MessageEmpty : never)
    | (MayInclude<P, "embeds"> extends true ? EmbedTooLarge : never)
  >
  /**
   * Defers (callback 5, EPHEMERAL as the mode fixes it); the continuation must complete the deferral. An `ephemeral`
   * the mode does not allow names the rule and the mode (`EphemeralMatches`).
   */
  readonly defer: <const X extends boolean, A2, E2, R2>(
    options: { readonly ephemeral: X & EphemeralMatches<X, M> },
    then: (deferred: Answered) => HandledCompletion<A2, E2, R2>
  ) => Effect.Effect<Response<R2>>
}

/** `update` and `deferUpdate`, on a component's message. */
export interface Updates {
  /** Edits the component's message (callback 7; after the runner's deferral, `PATCH .../messages/@original`). */
  readonly update: <const P extends EditMessage>(
    patch: EditArg<P>
  ) => Effect.Effect<
    Response<never>,
    | (true extends MayBeTooLong<P> ? ContentTooLong : never)
    | (EditMayEmpty<P> extends true ? MessageEmpty : never)
    | (P extends { readonly embeds: infer E } ? (E extends readonly [] ? never : EmbedTooLarge) : never)
  >
  /** Defers the update (callback 6); the continuation must complete it. */
  readonly deferUpdate: <A2, E2, R2>(then: (deferred: Answered) => HandledCompletion<A2, E2, R2>) => Effect.Effect<Response<R2>>
}

/** `showModal`: only before answering, with auto-defer off. */
export interface OpensModal {
  /** Opens a modal (callback 9). A title or label over 45 characters is a defect (a literal in the code). */
  readonly showModal: (modal: Modal) => Effect.Effect<Response<never>>
}

/**
 * Where the interaction happened. `channel` is a handle whose preflight reads the interaction's `app_permissions`
 * (basis `"app-permissions"`, §4.7), not the gateway state.
 */
export interface InteractionContext {
  readonly guildId: GuildId
  readonly user: { readonly id: UserId }
  readonly channel: MessageChannel
}

/** A command under auto-defer ("public" or "ephemeral"): no `showModal`, replies must match the mode. */
export interface CommandInteraction<I, M extends "public" | "ephemeral"> extends InteractionContext, Replies<M> {
  readonly invocation: I
}
/** A command with auto-defer off: it may open a modal, and must answer within 3 seconds by itself. */
export interface ManualCommandInteraction<I> extends InteractionContext, Replies<"manual">, OpensModal {
  readonly invocation: I
}
/** The interaction a command handler receives under mode `M`. */
export type CommandIx<I, M extends CommandMode> = M extends "manual" ? ManualCommandInteraction<I> : M extends "public" | "ephemeral" ? CommandInteraction<I, M> : never

/** A component in "update" mode (auto-defers with DEFERRED_UPDATE_MESSAGE), so only `update` and `deferUpdate`. */
export interface UpdateComponentInteraction<A> extends InteractionContext, Updates {
  readonly data: A
}
/** A component that answers with a new message ("public" or "ephemeral"). */
export interface ReplyComponentInteraction<A, M extends "public" | "ephemeral"> extends InteractionContext, Replies<M> {
  readonly data: A
}
/** A component with auto-defer off: reply, update or open a modal, within 3 seconds. */
export interface ManualComponentInteraction<A> extends InteractionContext, Replies<"manual">, Updates, OpensModal {
  readonly data: A
}
/** The interaction a component handler receives under mode `M`. */
export type ComponentIx<A, M extends ComponentMode> = M extends "update"
  ? UpdateComponentInteraction<A>
  : M extends "manual"
    ? ManualComponentInteraction<A>
    : M extends "public" | "ephemeral"
      ? ReplyComponentInteraction<A, M>
      : never

/** A modal submit: its route's data and the text inputs' values by `custom_id`. No modal opens from it. */
export interface ModalSubmitInteraction<A, M extends ModalMode> extends InteractionContext, Replies<M> {
  readonly data: A
  readonly fields: ReadonlyMap<string, string>
}

/** Autocomplete: the focused option, and `choices`, its only response (callback 8; at most 25). */
export interface AutocompleteInteraction<V extends string | number> {
  readonly guildId: GuildId
  readonly user: { readonly id: UserId }
  readonly focused: { readonly name: string; readonly value: string }
  readonly choices: (choices: ReadonlyArray<{ readonly name: string; readonly value: V }>) => Effect.Effect<Response<never>>
}

// ---- registration ---------------------------------------------------------------------------------------

/** Shown instead of a handler's result when it does not return a response. */
export interface MustRespond {
  readonly "interaction handlers must return ix.reply, ix.defer, ix.update or ix.showModal": true
}

/** A handler's checked result: the boundary of `Bot.on` (only transient errors escape), and a response. */
export type HandledIx<A, E, R> = [A] extends [Response<infer _>] ? Handled<A, E, R> : MustRespond

/** What a response's continuation needs. */
export type RequirementOf<A> = A extends Response<infer R> ? R : never

/** The registration entry points (`Runner.ts`). Overloads differ by arity only (§2.10). */
export interface Interactions {
  readonly command: {
    /** Auto-defer "public" (DEFERRED_CHANNEL_MESSAGE, not ephemeral) after 2.5 s. */
    <I, A, E, R>(command: ChatInputCommand<string, I>, handler: (ix: CommandInteraction<I, "public">) => HandledIx<A, E, R>): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
    <I, const M extends CommandMode, A, E, R>(
      command: ChatInputCommand<string, I>,
      mode: M,
      handler: (ix: CommandIx<I, M>) => HandledIx<A, E, R>
    ): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
  }
  readonly component: {
    /** Auto-defer "update" (DEFERRED_UPDATE_MESSAGE) after 2.5 s. */
    <Name extends string, D, A, E, R>(route: ComponentRoute<Name, D>, handler: (ix: UpdateComponentInteraction<D>) => HandledIx<A, E, R>): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
    <Name extends string, D, const M extends ComponentMode, A, E, R>(
      route: ComponentRoute<Name, D>,
      mode: M,
      handler: (ix: ComponentIx<D, M>) => HandledIx<A, E, R>
    ): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
  }
  readonly modal: {
    /** Auto-defer "public" after 2.5 s. */
    <Name extends string, D, A, E, R>(route: ComponentRoute<Name, D>, handler: (ix: ModalSubmitInteraction<D, "public">) => HandledIx<A, E, R>): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
    <Name extends string, D, const M extends ModalMode, A, E, R>(
      route: ComponentRoute<Name, D>,
      mode: M,
      handler: (ix: ModalSubmitInteraction<D, M>) => HandledIx<A, E, R>
    ): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
  }
  /** No auto-defer: Discord gives an autocomplete 3 s and has no deferral for it. */
  readonly autocomplete: <I, A, E, R>(
    command: ChatInputCommand<string, I>,
    handler: (ix: AutocompleteInteraction<string | number>) => HandledIx<A, E, R>
  ) => Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
}
