/**
 * The operations (DESIGN §4.7, §4.8): the pipeline every public operation runs, and the channel and message
 * handles whose methods run it.
 *
 * **The pipeline** (`perform`), inside the operation's span (`discord.<area>.<op>`, with the route template, the
 * channel kind, the guild and the required flags; recovery always happens outside, §4.13):
 *
 * 1. preflight (unless `Preflight.Mode` is `"bypass"`): the bot's permissions resolved over the guild state
 *    (refreshed first when the state lacks what the resolver needs, or is stale), the request's arguments
 *    completed (`Preflight.stateArgs`), and `Preflight.decide`; the first failure in §3.2 order is the error,
 *    with a `PreflightDecision` cause, and a flag the handle's `require` checked is `PermissionRevokedSinceCheck`
 *    (D8). When even a refresh leaves the state unable to resolve the request (the guild or the channel left it
 *    meanwhile: the bot was removed, the channel deleted), the request is sent unchecked, with a warning: Discord
 *    decides, and a refusal goes through the error map (a 50013 or 50001 to the recompute, which finds the same
 *    and gives the code's own tag; §4.7);
 * 2. the local checks (`Limits.ts`, basis `payload-check`), which rank last (§3.2 tier 7);
 * 3. `DiscordApi.execute`: the call with its deadline, the error map, the recompute and the decode (§4.8 steps
 *    3-5);
 * 4. the operation's own readback (a send's degradation, §4.12; a pins list's, H-107).
 *
 * **The handles** close over the bot's runtime, so their methods need nothing. Each method is an overload: its
 * signature carries the precise union from the operation table (`Channel.ts`, `Message.ts`), over an
 * implementation typed with the wide union (`WideError`, or `Wide<...>` with the overload's table term; rules 7
 * and 10 of §2.12). `test/unit/op-errors.test.ts` holds the runtime to the declared unions;
 * `test/types/pass/op-errors.ts` holds each method's union to its row.
 *
 * `channelHandle` and `messageHandle` build handles from what the bot knows (a channel's kind, a message object);
 * they are internal (not in the public barrel), for `Channels.get`, the operations' results and the harness.
 */
import type { MessageCreateRequest } from "dfx/DiscordREST/Generated"
import { Clock, Effect, Schema } from "effect"
import { BotRuntime } from "../bot/Runtime.ts"
import { DiscordResponse, PreflightDecision } from "../errors/Cause.ts"
import type { PermissionFlag } from "../errors/Missing.generated.ts"
import type { PermissionRevokedSinceCheck } from "../errors/Permission.ts"
import { UnknownChannel } from "../errors/State.ts"
import type { Transient } from "../errors/Transient.ts"
import * as Flags from "../permissions/Flags.ts"
import { errorFor, type OpErrors, type OpFlags, type OpName, type OpPermissionErrors, type OpTags, type Revoked } from "../permissions/Operations.ts"
import * as Preflight from "../permissions/Preflight.ts"
import type * as Recompute from "../permissions/Recompute.ts"
import { type FromSnapshot, fromAppPermissions, guildInputFromSnapshot, inputFromSnapshot, type MemberInput, type Resolution, resolve } from "../permissions/Resolver.ts"
import * as Limits from "../payload/Limits.ts"
import type { CreateArg, EditArg, EditMessage, Emoji, MessagePayload } from "../payload/Message.ts"
import { isV2 } from "../payload/Message.ts"
import { type ContentTooLongIn, customEmojiTokens, type EditEmbedTooLargeIn, type EditMessageEmptyIn, type EmbedTooLargeIn, features, type MessageEmptyIn, type NameTooLongIn, type PatchNameTooLongIn, type PatchSlowmodeOutOfRangeIn, type PatchTopicTooLongIn, type PayloadFlags, payloadRuleNames, PayloadRules, type PollTooLargeIn } from "../payload/PayloadRules.ts"
import * as ToDfx from "../payload/ToDfx.ts"
import type * as DiscordApi from "../rest/DiscordApi.ts"
import type { LimitFacts } from "../rest/ErrorMap.ts"
import * as Schemas from "../rest/Schemas.ts"
import type { ChannelId, ForumTagId, GuildId, MessageId, RoleId, UserId } from "../Snowflake.ts"
import { toChannel } from "../state/Reducer.ts"
import { isThreadKind, isVoiceKind } from "../state/Snapshot.ts"
import type {
  AnnouncementChannel,
  AnnouncementThread,
  Basis,
  BulkDeletes,
  CategoryChannel,
  ChannelKinds,
  ChannelPatch,
  CreateThreadOp,
  Editable,
  ForumChannel,
  GrantedOf,
  GuildChannel,
  GuildChannelKind,
  GuildMessageKind,
  PatchArg,
  MediaChannel,
  MessageKind,
  Pins,
  PinsList,
  PostsMessages,
  PrivateThread,
  PublicThread,
  SendFlags,
  SendMethod,
  SendOpByKind,
  SendReceiver,
  SendSuccess,
  SentDegradable,
  StageChannel,
  StartsThreads,
  TextChannel,
  ThreadArg,
  ThreadKind,
  ThreadOf,
  ThreadOps,
  VoiceChannel
} from "./Channel.ts"
import type {
  AnyMessage,
  CreateThreadFromMessage,
  CrosspostMethod,
  CrosspostOp,
  DeleteMethod,
  DeleteOp,
  EditOp,
  EditOwnMethod,
  ForeignMessages,
  KindOf,
  MessageReceiver,
  OwnMessages,
  OwnReceiver,
  Pinnable,
  PinOp,
  ReactErrors,
  ReactMethod,
  ReactOp,
  ThreadFrom,
  UnpinOp
} from "./Message.ts"

/** The bot a handle belongs to. */
export type Runtime = BotRuntime["Service"]

/** Every error an operation's implementation can fail with; each public signature narrows it (§4.7). */
export type WideError = Preflight.PreflightError | PermissionRevokedSinceCheck | DiscordApi.ApiError | Limits.LocalFailure

/**
 * An implementation's error type when its overload indexes the operation table with a type parameter
 * (`OpErrors<G>[Op]`): the wide union, plus that term. It adds nothing `WideError` lacks, but with the term in both
 * signatures tsc's overload check relates it to itself instead of resolving its constraint over every row of the
 * table, which costs a consumer's compile hundreds of types per method (compile budget, DESIGN §5.4).
 */
export type Wide<E> = E | WideError

// ---- the pipeline -------------------------------------------------------------------------------------

/** One operation request, as the pipeline runs it. */
export interface Plan<A> {
  /** The span, `discord.<area>.<op>`. */
  readonly span: string
  /** The channel kind for the span (`guild` for member operations). */
  readonly kind: string
  /** The request as preflight, the error map and the recompute see it. */
  readonly target: Recompute.Target
  /** The local checks' problems, in tier 7's order. */
  readonly local: ReadonlyArray<Limits.LocalFailure>
  readonly request: DiscordApi.Request<A>
  /** For a member operation: the target member as the handle holds it (its rank, H-064). */
  readonly targetMember?: MemberInput
}

/** The resolver's input for `target`, refreshing first when the state lacks it or is stale; `NeedsRefresh` when even a refresh leaves it short. */
const resolverInput = (runtime: Runtime, target: Recompute.Target): Effect.Effect<FromSnapshot, Transient> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const scope = target.scope
    const read = Effect.map(runtime.guildState.snapshot, (snapshot) => ({
      stale: snapshot.guilds.get(target.guildId)?.stale ?? true,
      input: scope._tag === "Channel" ? inputFromSnapshot(snapshot, target.guildId, scope.channelId, now) : guildInputFromSnapshot(snapshot, target.guildId, now)
    }))
    let current = yield* read
    if (current.input._tag === "NeedsRefresh" || current.stale) {
      if (scope._tag === "Channel") yield* runtime.guildState.refresh(target.guildId, scope.channelId)
      else yield* runtime.guildState.refreshGuild(target.guildId)
      current = yield* read
    }
    return current.input
  })

/**
 * Preflight's decision for a request over the current state, or `Undecidable` with the reason when even a refresh
 * leaves the state unable to resolve it (`perform` then sends it unchecked, `Permissions.require` fails with
 * `UnknownChannel`).
 */
export type Decided =
  | { readonly _tag: "Decided"; readonly resolution: Resolution; readonly decision: Preflight.Decision }
  | { readonly _tag: "Undecidable"; readonly reason: string }

/** Preflight's decision for a plan over the current state (see {@link Decided}). */
export const decisionOf = <A>(runtime: Runtime, plan: Pick<Plan<A>, "target" | "targetMember"> & { readonly kind?: string }): Effect.Effect<Decided, Transient> =>
  Effect.gen(function* () {
    const { target } = plan
    const input = yield* resolverInput(runtime, target)
    const app = target.appPermissions
    if (app !== undefined) {
      // an interaction's channel: Discord's app_permissions, with the state's timeout and thread facts when it has them
      const state = input._tag === "NeedsRefresh" ? undefined : resolve(input.input)
      const voice = plan.kind === "voice" || plan.kind === "stage"
      const resolution = fromAppPermissions(app, state, voice)
      const args = Preflight.stateArgs(target.op, target.args, resolution, undefined)
      return { _tag: "Decided", resolution, decision: Preflight.decide(target.op, resolution, args) }
    }
    if (input._tag === "NeedsRefresh") return { _tag: "Undecidable", reason: input.reason }
    const resolution = resolve(input.input)
    const role = target.completion._tag === "Member" ? target.completion.role : undefined
    const hierarchy = plan.targetMember === undefined ? undefined : { guild: input.input.guild, bot: input.input.member, target: plan.targetMember, role }
    const args = Preflight.stateArgs(target.op, target.args, resolution, hierarchy)
    return { _tag: "Decided", resolution, decision: Preflight.decide(target.op, resolution, args) }
  })

/** Runs one operation request (see the module comment). */
export const perform = <A>(runtime: Runtime, plan: Plan<A>): Effect.Effect<A, WideError> =>
  Effect.gen(function* () {
    const mode = yield* Preflight.Mode
    if (mode === "enforce") {
      const decided = yield* decisionOf(runtime, plan)
      if (decided._tag === "Undecidable") yield* Effect.logWarning(`preflight: ${plan.target.op}: the state cannot resolve the request even after a refresh (${decided.reason}); sending it unchecked`)
      const [first] = decided._tag === "Decided" ? decided.decision.failures : []
      if (first !== undefined) {
        const cause = new PreflightDecision({ route: plan.request.route.template, basis: plan.target.appPermissions === undefined ? "gateway-state" : "app-permissions" })
        return yield* Effect.fail(Preflight.toHandleError(plan.target.op, first, plan.target.granted, cause))
      }
    }
    const [local] = plan.local
    if (local !== undefined) return yield* Effect.fail(local)
    return yield* runtime.api.execute(plan.request)
  }).pipe(
    Effect.withSpan(plan.span, {
      attributes: {
        "discord.route": plan.request.route.template,
        "discord.channel_kind": plan.kind,
        "discord.guild_id": plan.target.guildId,
        "discord.required_flags": Flags.sortFlags(Preflight.requiredFlags(plan.target.op, plan.target.args)).join(",")
      }
    })
  )

const localCause = (route: string): PreflightDecision => new PreflightDecision({ route, basis: "payload-check" })

const channelTarget = (core: ChannelCore, op: OpName, args: Preflight.DecideArgs, completion: Recompute.Completion = { _tag: "Static" }): Recompute.Target => ({
  op,
  guildId: core.guildId,
  scope: { _tag: "Channel", channelId: core.id },
  granted: core.granted,
  args,
  completion,
  ...(core.appPermissions === undefined ? {} : { appPermissions: core.appPermissions })
})

const noPayload: Preflight.DecideArgs = { payload: [] }

const contentLimit = (content: string | undefined): Pick<LimitFacts, "content"> => (content === undefined ? {} : { content: { length: Limits.lengthOf(content), limit: Limits.Limits.content } })

/** The limits a create payload declares: every field the request carries (see `LimitFacts`). Internal (the DM send uses it too). */
export const createLimits = (payload: MessagePayload): LimitFacts => {
  if (isV2(payload)) return { empty: true }
  return {
    empty: true,
    ...contentLimit(payload.content),
    ...(payload.embeds !== undefined && payload.embeds.length > 0 ? { embeds: true } : {}),
    ...(payload.poll === undefined ? {} : { poll: true })
  }
}

// ---- cores --------------------------------------------------------------------------------------------

/** What a channel handle's methods close over. */
export interface ChannelCore {
  readonly runtime: Runtime
  readonly guildId: GuildId
  readonly id: ChannelId
  readonly kind: GuildChannelKind
  readonly granted: ReadonlyArray<PermissionFlag>
  readonly basis: Basis
  /** The interaction's `app_permissions` for this channel, exactly when `basis` is `"app-permissions"`. */
  readonly appPermissions: Flags.PermissionSet | undefined
}

/** A reaction already on a message, as the message object names it. */
export type EmojiKey = Recompute.EmojiKey

/** What a message handle's methods close over. */
export interface MessageCore {
  readonly runtime: Runtime
  readonly guildId: GuildId
  readonly channelId: ChannelId
  readonly kind: GuildMessageKind
  readonly id: MessageId
  /** The emoji already on the message, or `undefined` when the handle does not know (§4.7). */
  readonly reactions: ReadonlyArray<EmojiKey> | undefined
}

// ---- sending ------------------------------------------------------------------------------------------

const sendOps: { readonly [K in MessageKind]: SendOpByKind[K] } = {
  text: "channel.send",
  announcement: "channel.send",
  voice: "voice.send",
  stage: "voice.send",
  "public-thread": "thread.send",
  "private-thread": "thread.send",
  "announcement-thread": "thread.send",
  dm: "dm.send"
}

/**
 * The flags whose effect the create response lacks (§4.12, D35), among the payload's degrade-mode features:
 * `@everyone` that did not mention everyone (H-100), a role missing from `mention_roles` (H-101), a custom emoji
 * Discord rewrote (H-104), TTS sent as a normal message (H-102).
 */
export const degradedOf = (payload: MessagePayload, message: Schemas.Message): ReadonlyArray<PermissionFlag> => {
  const dropped = new Set<PermissionFlag>()
  const present = features(payload)
  const lost = {
    reply: message.message_reference === undefined || message.message_reference === null,
    embeds: message.embeds.length === 0,
    files: message.attachments.length === 0,
    tts: !message.tts,
    poll: message.poll === undefined || message.poll === null,
    externalSticker: false,
    externalEmojiInContent: !isV2(payload) && customEmojiTokens(payload.content ?? "").some((token) => !message.content.includes(token)),
    mentionsEveryone: !message.mention_everyone,
    unmentionableRole: (payload.mentions?.roles ?? []).some((role) => !message.mention_roles.includes(role))
  } as const
  for (const name of payloadRuleNames) {
    const rule = PayloadRules[name]
    if (present.includes(name) && rule.mode === "degrade" && lost[name]) dropped.add(rule.flag)
  }
  return Flags.sortFlags(dropped)
}

const messagesRoute = "/channels/{channel.id}/messages"

/**
 * `SendMethod` over a wide implementation `run` (rule 7 of §2.12): the one place its precise signature is attached,
 * shared by the guild and DM sends. Internal (the DM send uses it too).
 */
export const sendMethodOf = (run: (payload: MessagePayload) => Effect.Effect<SentDegradable<MessageKind, PermissionFlag>, WideError>): SendMethod => {
  function send<C extends SendReceiver, const P extends MessagePayload>(
    this: C,
    payload: CreateArg<P>
  ): Effect.Effect<
    SendSuccess<C, P>,
    | OpPermissionErrors[SendOpByKind[C["kind"]]][Exclude<SendFlags<C, P>, GrantedOf<C>>]
    | Revoked<SendFlags<C, P>, GrantedOf<C>>
    | ContentTooLongIn<P>
    | MessageEmptyIn<P>
    | EmbedTooLargeIn<P>
    | PollTooLargeIn<P>
    | OpTags[SendOpByKind[C["kind"]]]
    | Transient
  >
  function send(this: SendReceiver, payload: MessagePayload): Effect.Effect<SentDegradable<MessageKind, PermissionFlag>, WideError> {
    return run(payload)
  }
  return send
}

const sendMethod = (core: ChannelCore & { readonly kind: GuildMessageKind }): SendMethod =>
  sendMethodOf((payload) => {
    const wire = ToDfx.createRequest(payload)
    const request: MessageCreateRequest = wire.request
    return perform(core.runtime, {
      span: "discord.channel.send",
      kind: core.kind,
      target: channelTarget(core, sendOps[core.kind], { payload: features(payload) }),
      local: Limits.checkCreate(payload, localCause(messagesRoute)),
      request: {
        target: channelTarget(core, sendOps[core.kind], { payload: features(payload) }),
        route: { method: "POST", template: messagesRoute },
        call: (rest) => (wire.files.length > 0 ? rest.withFiles(wire.files)(rest.createMessage(core.id, request)) : rest.createMessage(core.id, request)),
        response: Schemas.Message,
        limits: createLimits(payload)
      }
    }).pipe(Effect.map((message) => ({ message: ownMessageOf(core, message), degraded: degradedOf(payload, message) })))
  })

// ---- channel operations --------------------------------------------------------------------------------

const channelRoute = "/channels/{channel.id}"

const editMethod = <Op extends "channel.edit" | "voice.edit" | "thread.edit", G extends PermissionFlag, Fields extends keyof ChannelPatch>(core: ChannelCore, op: Op): Editable<Op, G, Fields>["edit"] => {
  function edit<const P extends ChannelPatch>(
    patch: PatchArg<P, Fields>
  ): Effect.Effect<
    void,
    | OpErrors<G>[Op]
    | PatchNameTooLongIn<P>
    | PatchTopicTooLongIn<P>
    | PatchSlowmodeOutOfRangeIn<P>
  >
  function edit(patch: ChannelPatch): Effect.Effect<void, Wide<OpErrors<G>[Op]>> {
    const forum = core.kind === "forum" || core.kind === "media"
    const limits: LimitFacts = {
      ...(patch.name === undefined ? {} : { name: { length: Limits.lengthOf(patch.name), limit: Limits.Limits.name.max } }),
      ...(patch.topic === undefined ? {} : { topic: { length: Limits.lengthOf(patch.topic), limit: forum ? Limits.Limits.topic.forum : Limits.Limits.topic.channel } }),
      ...(patch.slowmodeSeconds === undefined ? {} : { slowmode: { seconds: Math.trunc(patch.slowmodeSeconds) } })
    }
    const target = channelTarget(core, op, noPayload)
    return perform(core.runtime, {
      span: "discord.channel.edit",
      kind: core.kind,
      target,
      local: Limits.checkChannelEdit(patch, forum, localCause(channelRoute)),
      request: {
        target,
        route: { method: "PATCH", template: channelRoute },
        call: (rest) =>
          rest.updateChannel(core.id, {
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.topic === undefined ? {} : { topic: patch.topic }),
            ...(patch.slowmodeSeconds === undefined ? {} : { rate_limit_per_user: patch.slowmodeSeconds })
          }),
        response: Schemas.Channel,
        limits
      }
    }).pipe(Effect.asVoid)
  }
  return edit
}

/** A wire channel as a handle of its kind (an unmodelled or malformed one is a defect: Discord answered our own create). */
const handleOfWire = (core: Pick<ChannelCore, "runtime" | "guildId">, wire: Schemas.Channel, route: string): Effect.Effect<GuildChannel> => {
  const converted = toChannel(wire)
  return converted._tag === "Channel"
    ? Effect.succeed(channelHandle(core.runtime, { guildId: core.guildId, id: converted.channel.id, kind: converted.channel.kind }))
    : Effect.die(new Error(`${route}: the answer is not a channel the library models (${converted._tag === "Malformed" ? converted.reason : `type ${wire.type}`})`))
}

const threadsRoute = "/channels/{channel.id}/threads"

const createThreadMethod = <Private extends boolean, Public extends ThreadKind, G extends PermissionFlag>(core: ChannelCore, publicKind: Public): StartsThreads<Private, Public, G>["createThread"] => {
  function createThread<const T extends { readonly name: string; readonly private?: boolean }>(
    thread: ThreadArg<T, Private>
  ): Effect.Effect<ChannelKinds<never>[ThreadOf<T, Public>], OpErrors<G>[CreateThreadOp<T>] | NameTooLongIn<T["name"]>>
  function createThread(thread: { readonly name: string; readonly private?: boolean }): Effect.Effect<GuildChannel, WideError> {
    const isPrivate = thread.private === true
    const op = isPrivate ? "channel.createThread.private" : "channel.createThread.public"
    const target = channelTarget(core, op, noPayload)
    const type = isPrivate ? 12 : publicKind === "announcement-thread" ? 10 : 11
    return perform(core.runtime, {
      span: "discord.channel.createThread",
      kind: core.kind,
      target,
      local: Limits.checkName(thread.name, localCause(threadsRoute)),
      request: {
        target,
        route: { method: "POST", template: threadsRoute },
        call: (rest) => rest.createThread(core.id, { name: thread.name, type }),
        response: Schemas.Channel,
        limits: { name: { length: Limits.lengthOf(thread.name), limit: Limits.Limits.name.max } }
      }
    }).pipe(Effect.flatMap((wire) => handleOfWire(core, wire, threadsRoute)))
  }
  return createThread
}

const pinsRoute = "/channels/{channel.id}/messages/pins"

const PinsPage = Schema.Struct({ items: Schema.Array(Schema.Struct({ message: Schemas.Message })) })

const pinsMethod = <G extends PermissionFlag, Op extends "channel.pins" | "voice.pins">(core: ChannelCore & { readonly kind: GuildMessageKind }, op: Op): Pins<G, Op>["pins"] => {
  function pins(): ReturnType<Pins<G, Op>["pins"]>
  function pins(): Effect.Effect<PinsList, Wide<OpErrors<G>[Op]>> {
    const target = channelTarget(core, op, noPayload)
    const plan: Plan<typeof PinsPage.Type> = {
      span: "discord.channel.pins",
      kind: core.kind,
      target,
      local: [],
      request: { target, route: { method: "GET", template: pinsRoute }, call: (rest) => rest.listPins(core.id, { limit: 50 }), response: PinsPage, limits: {} }
    }
    return Effect.gen(function* () {
      const page = yield* perform(core.runtime, plan)
      // an empty list without ReadMessageHistory means nothing was readable, not that nothing is pinned (H-107); a
      // state that cannot resolve the channel even after a refresh cannot tell, and the list is taken as read
      const decided = page.items.length === 0 ? yield* decisionOf(core.runtime, plan) : undefined
      if (decided?._tag === "Undecidable") yield* Effect.logWarning(`pins: the state cannot resolve the channel even after a refresh (${decided.reason}); the empty list is not reported degraded`)
      const unreadable = decided?._tag === "Decided" && !Flags.has(decided.resolution.effective, "ReadMessageHistory")
      return {
        messages: page.items.map((item) => messageOf(core, item.message)),
        degraded: unreadable ? ["ReadMessageHistory" as const] : []
      }
    })
  }
  return pins
}

const bulkDeleteRoute = "/channels/{channel.id}/messages/bulk-delete"

const bulkDeleteMethod = <G extends PermissionFlag, Op extends "channel.bulkDelete" | "thread.bulkDelete" | "voice.bulkDelete">(core: ChannelCore, op: Op): BulkDeletes<G, Op>["bulkDelete"] => {
  function bulkDelete(...ids: Parameters<BulkDeletes<G, Op>["bulkDelete"]>): ReturnType<BulkDeletes<G, Op>["bulkDelete"]>
  function bulkDelete(ids: ReadonlyArray<MessageId>): Effect.Effect<void, Wide<OpErrors<G>[Op]>> {
    const target = channelTarget(core, op, noPayload)
    return Effect.flatMap(Clock.currentTimeMillis, (now) =>
      perform(core.runtime, {
        span: "discord.channel.bulkDelete",
        kind: core.kind,
        target,
        local: Limits.checkBulkDelete(ids, now, localCause(bulkDeleteRoute)),
        request: {
          target,
          route: { method: "POST", template: bulkDeleteRoute },
          call: (rest) => rest.bulkDeleteMessages(core.id, { messages: ids }),
          response: Schema.Void,
          limits: { messageCount: ids.length }
        }
      })
    )
  }
  return bulkDelete
}

const createPostMethod = <G extends PermissionFlag>(core: ChannelCore): PostsMessages<G>["createPost"] => {
  function createPost<const N extends string, const P extends MessagePayload>(post: { readonly name: N; readonly message: CreateArg<P>; readonly tags?: ReadonlyArray<ForumTagId> }): Effect.Effect<
    PublicThread<never>,
    | OpPermissionErrors["forum.createPost"][Exclude<OpFlags["forum.createPost"] | PayloadFlags<P>, G>]
    | Revoked<OpFlags["forum.createPost"] | PayloadFlags<P>, G>
    | ContentTooLongIn<P>
    | MessageEmptyIn<P>
    | EmbedTooLargeIn<P>
    | PollTooLargeIn<P>
    | NameTooLongIn<N>
    | OpTags["forum.createPost"]
    | Transient
  >
  function createPost(post: { readonly name: string; readonly message: MessagePayload; readonly tags?: ReadonlyArray<ForumTagId> }): Effect.Effect<PublicThread<never>, WideError> {
    const tags = post.tags ?? []
    const target = channelTarget(core, "forum.createPost", { payload: features(post.message), tagged: tags.length > 0 })
    const wire = ToDfx.createRequest(post.message)
    const body = { name: post.name, ...(tags.length === 0 ? {} : { applied_tags: tags }), message: wire.request }
    return perform(core.runtime, {
      span: "discord.forum.createPost",
      kind: core.kind,
      target,
      local: [...Limits.checkCreate(post.message, localCause(threadsRoute)), ...Limits.checkName(post.name, localCause(threadsRoute))],
      request: {
        target,
        route: { method: "POST", template: threadsRoute },
        call: (rest) => (wire.files.length > 0 ? rest.withFiles(wire.files)(rest.createThread(core.id, body)) : rest.createThread(core.id, body)),
        response: Schemas.Channel,
        limits: { ...createLimits(post.message), name: { length: Limits.lengthOf(post.name), limit: Limits.Limits.name.max } }
      }
    }).pipe(
      Effect.flatMap((thread) =>
        thread.type === 11 ? Effect.succeed(channelHandle(core.runtime, { guildId: core.guildId, id: thread.id, kind: "public-thread" })) : Effect.die(new Error(`${threadsRoute}: a post came back as channel type ${thread.type}`))
      )
    )
  }
  return createPost
}


const threadMembersRoute = "/channels/{channel.id}/thread-members/@me"

const threadOps = <G extends PermissionFlag>(core: ChannelCore): ThreadOps<G> => {
  const simple = <A>(span: string, op: OpName, route: DiscordApi.Route, call: DiscordApi.Request<A>["call"], response: Schema.Decoder<A>) => {
    const target = channelTarget(core, op, noPayload)
    return perform(core.runtime, { span, kind: core.kind, target, local: [], request: { target, route, call, response, limits: {} } }).pipe(Effect.asVoid)
  }
  function join(): ReturnType<ThreadOps<G>["join"]>
  function join(): Effect.Effect<void, WideError> {
    return simple("discord.thread.join", "thread.join", { method: "PUT", template: threadMembersRoute }, (rest) => rest.joinThread(core.id), Schema.Void)
  }
  function leave(): ReturnType<ThreadOps<G>["leave"]>
  function leave(): Effect.Effect<void, WideError> {
    return simple("discord.thread.leave", "thread.leave", { method: "DELETE", template: threadMembersRoute }, (rest) => rest.leaveThread(core.id), Schema.Void)
  }
  function addMember(user: UserId): ReturnType<ThreadOps<G>["addMember"]>
  function addMember(user: UserId): Effect.Effect<void, WideError> {
    return simple("discord.thread.addMember", "thread.addMember", { method: "PUT", template: "/channels/{channel.id}/thread-members/{user.id}" }, (rest) => rest.addThreadMember(core.id, user), Schema.Void)
  }
  function setArchived<const A extends boolean>(archived: A): Effect.Effect<void, OpErrors<G>[A extends true ? "thread.setArchived" : "thread.unarchive"]>
  function setArchived(archived: boolean): Effect.Effect<void, WideError> {
    return simple(
      "discord.thread.setArchived",
      archived ? "thread.setArchived" : "thread.unarchive",
      { method: "PATCH", template: channelRoute },
      (rest) => rest.updateChannel(core.id, { archived }),
      Schemas.Channel
    )
  }
  function setLocked(locked: boolean): ReturnType<ThreadOps<G>["setLocked"]>
  function setLocked(locked: boolean): Effect.Effect<void, WideError> {
    return simple("discord.thread.setLocked", "thread.setLocked", { method: "PATCH", template: channelRoute }, (rest) => rest.updateChannel(core.id, { locked }), Schemas.Channel)
  }
  function deleteThread(): ReturnType<ThreadOps<G>["delete"]>
  function deleteThread(): Effect.Effect<void, WideError> {
    return simple("discord.thread.delete", "thread.delete", { method: "DELETE", template: channelRoute }, (rest) => rest.deleteChannel(core.id), Schemas.Channel)
  }
  return { join, leave, addMember, setArchived, setLocked, delete: deleteThread }
}

// ---- channel handles ------------------------------------------------------------------------------------

const base = <K extends GuildChannelKind, G extends PermissionFlag>(core: ChannelCore, kind: K, granted: ReadonlyArray<G>) => ({ kind, id: core.id, guildId: core.guildId, granted, basis: core.basis })

const textChannel = <G extends PermissionFlag>(core: ChannelCore & { readonly kind: "text" }, granted: ReadonlyArray<G>): TextChannel<G> => ({
  ...base(core, "text", granted),
  send: sendMethod(core),
  edit: editMethod<"channel.edit", G, "name" | "topic" | "slowmodeSeconds">(core, "channel.edit"),
  createThread: createThreadMethod<boolean, "public-thread", G>(core, "public-thread"),
  pins: pinsMethod<G, "channel.pins">(core, "channel.pins"),
  bulkDelete: bulkDeleteMethod<G, "channel.bulkDelete">(core, "channel.bulkDelete")
})

const announcementChannel = <G extends PermissionFlag>(core: ChannelCore & { readonly kind: "announcement" }, granted: ReadonlyArray<G>): AnnouncementChannel<G> => ({
  ...base(core, "announcement", granted),
  send: sendMethod(core),
  edit: editMethod<"channel.edit", G, "name" | "topic" | "slowmodeSeconds">(core, "channel.edit"),
  createThread: createThreadMethod<false, "announcement-thread", G>(core, "announcement-thread"),
  pins: pinsMethod<G, "channel.pins">(core, "channel.pins"),
  bulkDelete: bulkDeleteMethod<G, "channel.bulkDelete">(core, "channel.bulkDelete")
})

const voiceChannel = <G extends PermissionFlag>(core: ChannelCore & { readonly kind: "voice" }, granted: ReadonlyArray<G>): VoiceChannel<G> => ({
  ...base(core, "voice", granted),
  send: sendMethod(core),
  edit: editMethod<"voice.edit", G, "name" | "slowmodeSeconds">(core, "voice.edit"),
  pins: pinsMethod<G, "voice.pins">(core, "voice.pins"),
  bulkDelete: bulkDeleteMethod<G, "voice.bulkDelete">(core, "voice.bulkDelete")
})

const stageChannel = <G extends PermissionFlag>(core: ChannelCore & { readonly kind: "stage" }, granted: ReadonlyArray<G>): StageChannel<G> => ({
  ...base(core, "stage", granted),
  send: sendMethod(core),
  edit: editMethod<"voice.edit", G, "name" | "topic" | "slowmodeSeconds">(core, "voice.edit"),
  pins: pinsMethod<G, "voice.pins">(core, "voice.pins"),
  bulkDelete: bulkDeleteMethod<G, "voice.bulkDelete">(core, "voice.bulkDelete")
})

const categoryChannel = <G extends PermissionFlag>(core: ChannelCore, granted: ReadonlyArray<G>): CategoryChannel<G> => ({
  ...base(core, "category", granted),
  edit: editMethod<"channel.edit", G, "name">(core, "channel.edit")
})

const forumChannel = <G extends PermissionFlag>(core: ChannelCore, granted: ReadonlyArray<G>): ForumChannel<G> => ({
  ...base(core, "forum", granted),
  edit: editMethod<"channel.edit", G, "name" | "topic" | "slowmodeSeconds">(core, "channel.edit"),
  createPost: createPostMethod<G>(core)
})

const mediaChannel = <G extends PermissionFlag>(core: ChannelCore, granted: ReadonlyArray<G>): MediaChannel<G> => ({
  ...base(core, "media", granted),
  edit: editMethod<"channel.edit", G, "name" | "topic" | "slowmodeSeconds">(core, "channel.edit"),
  createPost: createPostMethod<G>(core)
})

const threadParts = <G extends PermissionFlag>(core: ChannelCore & { readonly kind: ThreadKind }) => ({
  send: sendMethod(core),
  edit: editMethod<"thread.edit", G, "name" | "slowmodeSeconds">(core, "thread.edit"),
  pins: pinsMethod<G, "channel.pins">(core, "channel.pins"),
  bulkDelete: bulkDeleteMethod<G, "thread.bulkDelete">(core, "thread.bulkDelete"),
  ...threadOps<G>(core)
})

const publicThread = <G extends PermissionFlag>(core: ChannelCore, granted: ReadonlyArray<G>): PublicThread<G> => ({
  ...base(core, "public-thread", granted),
  ...threadParts<G>({ ...core, kind: "public-thread" })
})

const privateThread = <G extends PermissionFlag>(core: ChannelCore, granted: ReadonlyArray<G>): PrivateThread<G> => ({
  ...base(core, "private-thread", granted),
  ...threadParts<G>({ ...core, kind: "private-thread" })
})

const announcementThread = <G extends PermissionFlag>(core: ChannelCore, granted: ReadonlyArray<G>): AnnouncementThread<G> => ({
  ...base(core, "announcement-thread", granted),
  ...threadParts<G>({ ...core, kind: "announcement-thread" })
})

/** What a channel handle is built from: the channel's guild, ID and kind. */
export interface ChannelInfo<K extends GuildChannelKind> {
  readonly guildId: GuildId
  readonly id: ChannelId
  readonly kind: K
}

/**
 * The handle of a channel the bot knows the kind of (internal: `Channels.get` builds handles from the guild state,
 * operations from Discord's answers, and the harness from the lab's own records). `granted` is what a
 * `Permissions.require` checked (D8).
 */
export function channelHandle<K extends GuildChannelKind, G extends PermissionFlag = never>(runtime: Runtime, info: ChannelInfo<K>, granted?: ReadonlyArray<G>, appPermissions?: Flags.PermissionSet): ChannelKinds<G>[K]
export function channelHandle(runtime: Runtime, info: ChannelInfo<GuildChannelKind>, granted: ReadonlyArray<PermissionFlag> = [], appPermissions?: Flags.PermissionSet): ChannelKinds<PermissionFlag>[GuildChannelKind] {
  const core: ChannelCore = { runtime, guildId: info.guildId, id: info.id, kind: info.kind, granted, basis: appPermissions === undefined ? "gateway-state" : "app-permissions", appPermissions }
  const handle = buildHandle(core, granted)
  cores.set(handle, core)
  return handle
}

/** The core of every handle the library built, so `Permissions.require` can re-type one (§2.6). */
const cores = new WeakMap<object, ChannelCore>()

/** The core a channel handle was built with; `undefined` for an object the library did not build. */
export const coreOf = (handle: object): ChannelCore | undefined => cores.get(handle)

const buildHandle = (core: ChannelCore, granted: ReadonlyArray<PermissionFlag>): ChannelKinds<PermissionFlag>[GuildChannelKind] => {
  const info = core
  switch (info.kind) {
    case "text":
      return textChannel<PermissionFlag>({ ...core, kind: "text" }, granted)
    case "announcement":
      return announcementChannel<PermissionFlag>({ ...core, kind: "announcement" }, granted)
    case "voice":
      return voiceChannel<PermissionFlag>({ ...core, kind: "voice" }, granted)
    case "stage":
      return stageChannel<PermissionFlag>({ ...core, kind: "stage" }, granted)
    case "category":
      return categoryChannel<PermissionFlag>(core, granted)
    case "forum":
      return forumChannel<PermissionFlag>(core, granted)
    case "media":
      return mediaChannel<PermissionFlag>(core, granted)
    case "public-thread":
      return publicThread<PermissionFlag>(core, granted)
    case "private-thread":
      return privateThread<PermissionFlag>(core, granted)
    case "announcement-thread":
      return announcementThread<PermissionFlag>(core, granted)
  }
}

// ---- message operations ---------------------------------------------------------------------------------

const messageRoute = "/channels/{channel.id}/messages/{message.id}"

const messageTarget = (core: MessageCore, op: OpName, args: Preflight.DecideArgs, completion: Recompute.Completion = { _tag: "Static" }): Recompute.Target => ({
  op,
  guildId: core.guildId,
  scope: { _tag: "Channel", channelId: core.channelId },
  granted: [],
  args,
  completion
})

const plainMessageOp = <A>(core: MessageCore, span: string, op: OpName, route: DiscordApi.Route, call: DiscordApi.Request<A>["call"], response: Schema.Decoder<A>): Effect.Effect<A, WideError> => {
  const target = messageTarget(core, op, noPayload)
  return perform(core.runtime, { span, kind: core.kind, target, local: [], request: { target, route, call, response, limits: {} } })
}

const emojiKeyOf = (emoji: Emoji): EmojiKey => (emoji.origin === "unicode" ? { _tag: "Unicode", name: emoji.name } : { _tag: "Custom", id: emoji.id })
const sameKey = (a: EmojiKey, b: EmojiKey): boolean => (a._tag === "Unicode" ? b._tag === "Unicode" && a.name === b.name : b._tag === "Custom" && a.id === b.id)

const reactOps: { readonly [K in GuildMessageKind]: ReactOp<K> } = {
  text: "message.react.channel",
  announcement: "message.react.channel",
  voice: "message.react.voice",
  stage: "message.react.voice",
  "public-thread": "message.react.thread",
  "private-thread": "message.react.thread",
  "announcement-thread": "message.react.thread"
}

// Each message method is its shared method type (`Message.ts`) over a wide implementation that ignores `this` and
// runs for the handle it closes over (rule 7 of §2.12; the implementation's error type carries the overload's term,
// `Wide<...>`, so tsc relates the two by identity).

const reactMethod = (core: MessageCore): ReactMethod => {
  function react<M extends MessageReceiver, const E extends Emoji>(this: M, emoji: E): Effect.Effect<void, ReactErrors<M, E> | Transient>
  function react<M extends MessageReceiver, const E extends Emoji>(this: M, emoji: E): Effect.Effect<void, Wide<ReactErrors<M, E> | Transient>> {
    const key = emojiKeyOf(emoji)
    const known = core.reactions
    const reaction = known === undefined ? "unknown" : known.some((existing) => sameKey(existing, key)) ? "existing" : "new"
    const args: Preflight.DecideArgs = { payload: [], reaction, ...(emoji.origin === "external" ? { extraFlags: ["UseExternalEmojis"] } : {}) }
    const completion: Recompute.Completion = reaction === "unknown" ? { _tag: "Reaction", channelId: core.channelId, messageId: core.id, emoji: key } : { _tag: "Static" }
    const target = messageTarget(core, reactOps[core.kind], args, completion)
    const encoded = emoji.origin === "unicode" ? encodeURIComponent(emoji.name) : `${emoji.name}:${emoji.id}`
    return perform(core.runtime, {
      span: "discord.message.react",
      kind: core.kind,
      target,
      local: [],
      request: {
        target,
        route: { method: "PUT", template: `${messageRoute}/reactions/{emoji}/@me` },
        call: (rest) => rest.addMyMessageReaction(core.channelId, core.id, encoded),
        response: Schema.Void,
        limits: {}
      }
    })
  }
  return react
}

const pinMethods = (core: MessageCore, ops: { readonly pin: OpName; readonly unpin: OpName }): Pinnable => {
  const route = "/channels/{channel.id}/messages/pins/{message.id}"
  function pin<M extends MessageReceiver>(this: M): Effect.Effect<void, OpErrors<never>[PinOp<KindOf<M>>]>
  function pin<M extends MessageReceiver>(this: M): Effect.Effect<void, Wide<OpErrors<never>[PinOp<KindOf<M>>]>> {
    return plainMessageOp(core, "discord.message.pin", ops.pin, { method: "PUT", template: route }, (rest) => rest.createPin(core.channelId, core.id), Schema.Void)
  }
  function unpin<M extends MessageReceiver>(this: M): Effect.Effect<void, OpErrors<never>[UnpinOp<KindOf<M>>]>
  function unpin<M extends MessageReceiver>(this: M): Effect.Effect<void, Wide<OpErrors<never>[UnpinOp<KindOf<M>>]>> {
    return plainMessageOp(core, "discord.message.unpin", ops.unpin, { method: "DELETE", template: route }, (rest) => rest.deletePin(core.channelId, core.id), Schema.Void)
  }
  return { pin, unpin }
}

const createThreadFromMessage = (core: MessageCore): CreateThreadFromMessage => {
  const route = `${messageRoute}/threads`
  function createThread<M extends MessageReceiver, const T extends { readonly name: string }>(
    this: M,
    thread: T
  ): Effect.Effect<ChannelKinds<never>[ThreadFrom<KindOf<M>>], OpErrors<never>["channel.createThread.public"] | NameTooLongIn<T["name"]>>
  function createThread(this: MessageReceiver, thread: { readonly name: string }): Effect.Effect<GuildChannel, WideError> {
    const target = messageTarget(core, "channel.createThread.public", noPayload)
    return perform(core.runtime, {
      span: "discord.message.createThread",
      kind: core.kind,
      target,
      local: Limits.checkName(thread.name, localCause(route)),
      request: {
        target,
        route: { method: "POST", template: route },
        call: (rest) => rest.createThreadFromMessage(core.channelId, core.id, { name: thread.name }),
        response: Schemas.Channel,
        limits: { name: { length: Limits.lengthOf(thread.name), limit: Limits.Limits.name.max } }
      }
    }).pipe(Effect.flatMap((wire) => handleOfWire(core, wire, route)))
  }
  return createThread
}

const crosspostMethod = (core: MessageCore, op: "message.crosspostOwn" | "message.crosspostForeign"): CrosspostMethod => {
  function crosspost<M extends MessageReceiver>(this: M): Effect.Effect<void, OpErrors<never>[CrosspostOp<M>]>
  function crosspost<M extends MessageReceiver>(this: M): Effect.Effect<void, Wide<OpErrors<never>[CrosspostOp<M>]>> {
    return plainMessageOp(core, "discord.message.crosspost", op, { method: "POST", template: `${messageRoute}/crosspost` }, (rest) => rest.crosspostMessage(core.channelId, core.id), Schemas.Message).pipe(Effect.asVoid)
  }
  return crosspost
}

const byKind = <K extends GuildMessageKind, A, B, C>(kind: K, rows: { readonly channel: A; readonly thread: B; readonly voice: C }): A | B | C => (isThreadKind(kind) ? rows.thread : isVoiceKind(kind) ? rows.voice : rows.channel)

const editOwnMethod = (core: MessageCore): EditOwnMethod => {
  function edit<M extends OwnReceiver, const P extends EditMessage>(
    this: M,
    patch: EditArg<P>
  ): Effect.Effect<
    OwnMessages<KindOf<M>>,
    | OpErrors<never>[EditOp<KindOf<M>>]
    | ContentTooLongIn<P>
    | EditEmbedTooLargeIn<P>
    | EditMessageEmptyIn<P>
  >
  function edit<M extends OwnReceiver>(this: M, patch: EditMessage): Effect.Effect<unknown, Wide<OpErrors<never>[EditOp<KindOf<M>>]>> {
    const op = byKind(core.kind, { channel: "message.edit.channel", thread: "message.edit.thread", voice: "message.edit.voice" } as const)
    const target = messageTarget(core, op, noPayload)
    return perform(core.runtime, {
      span: "discord.message.edit",
      kind: core.kind,
      target,
      local: Limits.checkEdit(patch, localCause(messageRoute)),
      request: {
        target,
        route: { method: "PATCH", template: messageRoute },
        call: (rest) => rest.updateMessage(core.channelId, core.id, ToDfx.editRequest(patch)),
        response: Schemas.Message,
        limits: { empty: true, ...contentLimit(patch.content), ...(patch.embeds !== undefined && patch.embeds.length > 0 ? { embeds: true } : {}) }
      }
    }).pipe(Effect.map((message) => ownMessageOf({ runtime: core.runtime, guildId: core.guildId, id: core.channelId, kind: core.kind }, message)))
  }
  return edit
}

const deleteMethod = (core: MessageCore, op: OpName): DeleteMethod => {
  function deleteMessage<M extends MessageReceiver>(this: M): Effect.Effect<void, OpErrors<never>[DeleteOp<M>]>
  function deleteMessage<M extends MessageReceiver>(this: M): Effect.Effect<void, Wide<OpErrors<never>[DeleteOp<M>]>> {
    return plainMessageOp(core, "discord.message.delete", op, { method: "DELETE", template: messageRoute }, (rest) => rest.deleteMessage(core.channelId, core.id), Schema.Void)
  }
  return deleteMessage
}

// ---- message handles ------------------------------------------------------------------------------------

const reactionsOf = (message: Schemas.Message): ReadonlyArray<EmojiKey> =>
  (message.reactions ?? []).filter((reaction) => reaction.count > 0).flatMap((reaction): ReadonlyArray<EmojiKey> => {
    if (reaction.emoji.id !== null) return [{ _tag: "Custom", id: reaction.emoji.id }]
    return reaction.emoji.name === null ? [] : [{ _tag: "Unicode", name: reaction.emoji.name }]
  })

const pinOps = { channel: { pin: "message.pin.channel", unpin: "message.unpin.channel" }, thread: { pin: "message.pin.thread", unpin: "message.unpin.thread" } } as const

const deleteOwnOps = { channel: "message.deleteOwn", thread: "message.deleteOwn.thread", voice: "message.deleteOwn.voice" } as const
const deleteForeignOps = { channel: "message.deleteForeign", thread: "message.deleteForeign.thread", voice: "message.deleteForeign.voice" } as const

const ownHandle = (core: MessageCore): OwnMessages<GuildMessageKind> => {
  const shared = { id: core.id, channelId: core.channelId, guildId: core.guildId, author: "self" as const, react: reactMethod(core), edit: editOwnMethod(core) }
  switch (core.kind) {
    case "text":
      return { ...shared, channelKind: "text", ...pinMethods(core, pinOps.channel), createThread: createThreadFromMessage(core), delete: deleteMethod(core, deleteOwnOps.channel) }
    case "announcement":
      return {
        ...shared,
        channelKind: "announcement",
        ...pinMethods(core, pinOps.channel),
        createThread: createThreadFromMessage(core),
        crosspost: crosspostMethod(core, "message.crosspostOwn"),
        delete: deleteMethod(core, deleteOwnOps.channel)
      }
    case "voice":
      return { ...shared, channelKind: "voice", delete: deleteMethod(core, deleteOwnOps.voice) }
    case "stage":
      return { ...shared, channelKind: "stage", delete: deleteMethod(core, deleteOwnOps.voice) }
    case "public-thread":
      return { ...shared, channelKind: "public-thread", ...pinMethods(core, pinOps.thread), delete: deleteMethod(core, deleteOwnOps.thread) }
    case "private-thread":
      return { ...shared, channelKind: "private-thread", ...pinMethods(core, pinOps.thread), delete: deleteMethod(core, deleteOwnOps.thread) }
    case "announcement-thread":
      return { ...shared, channelKind: "announcement-thread", ...pinMethods(core, pinOps.thread), delete: deleteMethod(core, deleteOwnOps.thread) }
  }
}

const foreignHandle = (core: MessageCore, authorId: UserId, authorIsBot: boolean): ForeignMessages<GuildMessageKind> => {
  const shared = { id: core.id, channelId: core.channelId, guildId: core.guildId, author: "other" as const, authorId, authorIsBot, react: reactMethod(core) }
  switch (core.kind) {
    case "text":
      return { ...shared, channelKind: "text", ...pinMethods(core, pinOps.channel), createThread: createThreadFromMessage(core), delete: deleteMethod(core, deleteForeignOps.channel) }
    case "announcement":
      return {
        ...shared,
        channelKind: "announcement",
        ...pinMethods(core, pinOps.channel),
        createThread: createThreadFromMessage(core),
        crosspost: crosspostMethod(core, "message.crosspostForeign"),
        delete: deleteMethod(core, deleteForeignOps.channel)
      }
    case "voice":
      return { ...shared, channelKind: "voice", delete: deleteMethod(core, deleteForeignOps.voice) }
    case "stage":
      return { ...shared, channelKind: "stage", delete: deleteMethod(core, deleteForeignOps.voice) }
    case "public-thread":
      return { ...shared, channelKind: "public-thread", ...pinMethods(core, pinOps.thread), delete: deleteMethod(core, deleteForeignOps.thread) }
    case "private-thread":
      return { ...shared, channelKind: "private-thread", ...pinMethods(core, pinOps.thread), delete: deleteMethod(core, deleteForeignOps.thread) }
    case "announcement-thread":
      return { ...shared, channelKind: "announcement-thread", ...pinMethods(core, pinOps.thread), delete: deleteMethod(core, deleteForeignOps.thread) }
  }
}

const isGuildMessageKind = (kind: GuildChannelKind): kind is GuildMessageKind => kind !== "category" && kind !== "forum" && kind !== "media"

const messageCoreOf = (channel: Pick<ChannelCore, "runtime" | "guildId" | "id" | "kind">, message: Schemas.Message, reactions: ReadonlyArray<EmojiKey> | undefined): MessageCore => {
  if (!isGuildMessageKind(channel.kind)) throw new Error(`a message in a ${channel.kind} channel`)
  return { runtime: channel.runtime, guildId: channel.guildId, channelId: channel.id, kind: channel.kind, id: message.id, reactions }
}

/** The bot's own message from Discord's answer to its send or edit (no reactions yet). */
const ownMessageOf = (channel: Pick<ChannelCore, "runtime" | "guildId" | "id" | "kind">, message: Schemas.Message): OwnMessages<GuildMessageKind> => ownHandle(messageCoreOf(channel, message, []))

/** A message object as a handle: own when its author is the bot (§2.5), with the reactions it carries. */
const messageOf = (channel: Pick<ChannelCore, "runtime" | "guildId" | "id" | "kind">, message: Schemas.Message): AnyMessage<GuildMessageKind> => {
  const core = messageCoreOf(channel, message, reactionsOf(message))
  return message.author.id === channel.runtime.identity.userId ? ownHandle(core) : foreignHandle(core, message.author.id, message.author.bot === true)
}

/**
 * The handle of a message object read over REST, in a channel the bot knows (internal: the harness builds the
 * handles of its fixtures with it). The object's reactions are what preflight knows of them (§4.7).
 */
export const messageHandle = <K extends GuildMessageKind>(runtime: Runtime, channel: ChannelInfo<K>, message: Schemas.Message): AnyMessage<K> => {
  const handle = messageOf({ runtime, guildId: channel.guildId, id: channel.id, kind: channel.kind }, message)
  return narrowMessage(handle, channel.kind)
}

function narrowMessage<K extends GuildMessageKind>(handle: AnyMessage<GuildMessageKind>, kind: K): AnyMessage<K>
function narrowMessage(handle: AnyMessage<GuildMessageKind>, kind: GuildMessageKind): AnyMessage<GuildMessageKind> {
  if (handle.channelKind !== kind) throw new Error(`a message handle of kind ${handle.channelKind} for a ${kind} channel`)
  return handle
}

// ---- Channels -------------------------------------------------------------------------------------------

const ChannelsGetDecode = Schemas.Channel

/** Looking channels up (§2.4). */
export const Channels = {
  /**
   * The handle of a guild channel, from the guild state (or a REST read when the state does not hold it, which is
   * then refreshed). A channel the bot cannot see (obfuscated, or unseen by a refresh) fails with
   * `MissingViewChannel`; one that does not exist with `UnknownChannel`.
   */
  get: (id: ChannelId): Effect.Effect<GuildChannel, OpPermissionErrors["permissions.require"]["ViewChannel"] | OpTags["permissions.require"] | Transient, BotRuntime> =>
    Effect.gen(function* () {
      const runtime = yield* BotRuntime
      const blind = (cause: PreflightDecision | DiscordResponse) => errorFor("permissions.require", "ViewChannel", cause)
      const local = new PreflightDecision({ route: channelRoute, basis: "gateway-state" })
      const find = Effect.map(runtime.guildState.snapshot, (snapshot) => {
        for (const guild of snapshot.guilds.values()) {
          if (guild.unseen.has(id)) return { _tag: "Unseen" as const }
          const channel = guild.channels.get(id)
          if (channel !== undefined) return { _tag: "Known" as const, guildId: guild.id, channel }
        }
        return { _tag: "Absent" as const }
      })
      const found = yield* find
      if (found._tag === "Unseen") return yield* Effect.fail(blind(local))
      if (found._tag === "Known") return found.channel.obfuscated ? yield* Effect.fail(blind(local)) : channelHandle(runtime, { guildId: found.guildId, id, kind: found.channel.kind })
      const wire = yield* runtime.api.read({
        route: { method: "GET", template: channelRoute },
        call: (rest) => rest.getChannel(id),
        response: ChannelsGetDecode,
        refusal: (response) => (response.code === 50001 ? blind(response) : response.code === 10003 ? new UnknownChannel({ cause: response }) : undefined)
      })
      const guildId = wire.guild_id
      if (guildId === undefined) return yield* Effect.fail(new UnknownChannel({ cause: local }))
      yield* runtime.guildState.refresh(guildId, id)
      const after = yield* find
      if (after._tag === "Known" && !after.channel.obfuscated) return channelHandle(runtime, { guildId: after.guildId, id, kind: after.channel.kind })
      return yield* Effect.fail(blind(local))
    }),
  /** Whether a guild channel carries messages. */
  isMessageChannel: (channel: GuildChannel): channel is ChannelKinds<never>["text" | "announcement" | "voice" | "stage" | ThreadKind] => isGuildMessageKind(channel.kind)
}
