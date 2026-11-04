/**
 * The rule rows' probes (DESIGN §5.5, §5.10): one side of a compile-time rule's live pair, and its full
 * observation, which the registry's expectation must equal in every field (`rule-observation` otherwise).
 *
 * - A `typed-*` probe calls the library's public operation, in enforce mode and live (`Succeeded`, or the field it
 *   applied, read back from Discord's answer or the harness's read of the message).
 * - A `raw-*` probe sends what the types forbid through `SubjectRaw`, with no check (`Rejected` with the status,
 *   the code and the sorted inner 50035 codes with their paths; or `Ignored`/`Applied` for a field Discord
 *   accepted the request without, or with).
 * - Probes derive their sizes from `Limits`, never a hard-coded 2001. The content-length pair separates the two
 *   counts H-121 weighs (2000 code points against the OpenAPI spec's 4000 UTF-16 units): the valid side sends
 *   `Limits.content` units of the character that is widest in the other count (a non-BMP emoji, two UTF-16 units,
 *   for `code-point`), which a UTF-16 count of 2000 refuses; the invalid side sends `Limits.content + 1` ASCII
 *   characters, one unit in every count, which a 4000-unit limit accepts. Only 2000 code points fits both answers.
 *
 * What a probe creates (threads, posts) is returned for cleanup; the channels it posts in or edits besides the
 * scenario channel are its metadata (`scenario/Probes.ts`), which the runner cleans and marks for the next
 * Converge.
 */
import type { DiscordRESTError, DiscordRestService } from "dfx/DiscordREST"
import { Clock, Effect, Exit, Option, Schema } from "effect"
import { channelHandle, messageHandle, type Runtime } from "../src/channels/Ops.ts"
import { SubjectRaw } from "../src/bot/Internals.ts"
import { ComponentRoute } from "../src/components/CustomId.ts"
import { DiscordResponse, type HttpMethod } from "../src/errors/Cause.ts"
import type { AllErrors } from "../src/errors/index.ts"
import type { Transient } from "../src/errors/Transient.ts"
import { memberHandle } from "../src/members/Member.ts"
import { row, textDisplay } from "../src/payload/Components.ts"
import { Limits } from "../src/payload/Limits.ts"
import { type Answered, send } from "../src/rest/Request.ts"
import type * as Schemas from "../src/rest/Schemas.ts"
import type { ChannelId, MessageId, RoleId, StickerId } from "../src/Snowflake.ts"
import { ChannelId as ChannelIdSchema } from "../src/Snowflake.ts"
import { deadline } from "./Drivers.ts"
import { HarnessRest } from "./Identities.ts"
import { LabGuard, labStep } from "./Lab.ts"
import type * as LabIds from "./LabIds.ts"
import type * as Materialize from "./Materialize.ts"
import * as Outcome from "./Outcome.ts"
import type { Observation } from "./scenario/Dsl.ts"
import type { ProbeName } from "./scenario/Probes.ts"
import type { RawOutcome } from "./TruthTable.ts"

/** Everything a probe reads. */
export interface ProbeContext {
  readonly runtime: Runtime
  readonly ids: Materialize.Ids
  /** The scenario channel or thread, and its lab name. */
  readonly channelId: ChannelId
  readonly channel: Materialize.LabName
  readonly subjectMessage: Schemas.Message | undefined
  readonly harnessMessage: Schemas.Message | undefined
  readonly secondHarnessMessage: MessageId | undefined
  readonly stickerId: StickerId | undefined
  /** The target member as the subject read it. */
  readonly target: Schemas.Member | undefined
  readonly now: number
}

/** What a probe saw, and what it created. */
export interface ProbeResult {
  readonly observation: Observation
  /** The probe's call as the truth table's raw outcome. */
  readonly raw: RawOutcome
  readonly created: ReadonlyArray<ChannelId>
}

/** The name lab objects a probe creates carry (the guard admits only `lab`/`lab-*` names). */
export const probeThreadName = "lab-rule-thread"

const need = <A>(value: A | undefined, what: string): Effect.Effect<A> => (value === undefined ? Effect.die(new Error(`probe: no ${what}`)) : Effect.succeed(value))

const lab = (context: ProbeContext, name: LabIds.ChannelName | LabIds.ThreadName): Effect.Effect<ChannelId> => need(context.ids.channels.get(name), `ID for ${name}`)

const sortedInner = (response: DiscordResponse): ReadonlyArray<{ readonly path: string; readonly code: string }> => Outcome.rejected(response).inner

const rejected = (response: DiscordResponse): Observation => ({ _tag: "Rejected", status: response.status, code: response.code, inner: [...sortedInner(response)] })

const field = (applied: boolean, name: string): Observation => (applied ? { _tag: "Applied", field: name } : { _tag: "Ignored", field: name })

const succeeded: Observation = { _tag: "Succeeded" }

const Created = Schema.Struct({ id: ChannelIdSchema })
const MessageRead = Schema.Struct({
  id: Schema.String,
  flags: Schema.optionalKey(Schema.Int),
  tts: Schema.Boolean,
  mentions: Schema.Array(Schema.Struct({ id: Schema.String })),
  mention_roles: Schema.Array(Schema.String)
})
const ChannelRead = Schema.Struct({ id: Schema.String, topic: Schema.optionalKey(Schema.NullOr(Schema.String)), rate_limit_per_user: Schema.optionalKey(Schema.Int) })

const decodeOrDie = <S extends Schema.Codec<unknown, unknown>>(schema: S, what: string) => (body: unknown): Effect.Effect<S["Type"]> =>
  Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError((error) => new Error(`probe: ${what} did not decode: ${error.message}`)),
    Effect.orDie
  )

/** One raw call through `SubjectRaw`, bounded like the matrix's (a missing answer aborts the run). */
const raw = (route: string, method: HttpMethod, call: (subject: DiscordRestService) => Effect.Effect<unknown, DiscordRESTError>): Effect.Effect<Answered<unknown>, Transient, SubjectRaw> =>
  Effect.flatMap(SubjectRaw, (subject) => send(route, method, call(subject), deadline))

/** A raw call's outcome as an observation (`Succeeded` for any 2xx). */
const observed = (answer: Answered<unknown>): Observation => (answer._tag === "Rejected" ? rejected(answer.response) : succeeded)

/** A raw call's outcome as the truth table's raw outcome. */
const rawOf = (answer: Answered<unknown>): RawOutcome => (answer._tag === "Rejected" ? Outcome.rejected(answer.response) : Outcome.ok([]))

const result = (observation: Observation, rawOutcome: RawOutcome, created: ReadonlyArray<ChannelId> = []): ProbeResult => ({ observation, raw: rawOutcome, created })

const fromRaw = (answer: Answered<unknown>, created: ReadonlyArray<ChannelId> = []): ProbeResult => result(observed(answer), rawOf(answer), created)

/** A thread a raw call created (it must be deleted), or none. */
const createdBy = (answer: Answered<unknown>): ReadonlyArray<ChannelId> =>
  answer._tag === "Ok" ? Option.match(Schema.decodeUnknownOption(Created)(answer.body), { onNone: () => [], onSome: (body) => [body.id] }) : []

/**
 * A typed call's outcome: `Succeeded`, or its error as a rejection (Discord's answer when Discord decided it; a
 * local or preflight refusal is recorded with status 0 and the tag as its path, which no registry entry expects).
 */
const typed = <A>(effect: Effect.Effect<A, AllErrors>): Effect.Effect<{ readonly value: A | undefined; readonly observation: Observation; readonly raw: RawOutcome }> =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) return { value: exit.value, observation: succeeded, raw: Outcome.ok([]) }
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (failure === undefined || failure._tag !== "Fail") throw new Error(`probe: the typed call died: ${String(exit.cause)}`)
    const error = failure.error
    const cause: unknown = error.cause
    if (cause instanceof DiscordResponse) return { value: undefined, observation: rejected(cause), raw: Outcome.rejected(cause) }
    return {
      value: undefined,
      observation: { _tag: "Rejected", status: 0, code: 0, inner: [{ path: error._tag, code: "refused before sending" }] },
      raw: { class: "other-error", status: 0, code: 0, inner: [{ path: error._tag, code: "refused before sending" }], degraded: [], mappedTag: "n/a" }
    }
  })

const quiet = { allowed_mentions: { parse: [] } } as const
const messagesRoute = "/channels/{channel.id}/messages"
const channelRoute = "/channels/{channel.id}"
const threadsRoute = "/channels/{channel.id}/threads"

/**
 * A string of `count` units as `Limits.unit` counts them, each the widest in the other count: a non-BMP emoji per
 * code point (two UTF-16 units), or an ASCII character per UTF-16 unit (the valid side of the content pair).
 */
export const unitString = (count: number): string => (Limits.unit === "code-point" ? "😀" : "a").repeat(count)

/** A string of `count` ASCII characters: one unit in every count (the invalid side of the content pair). */
export const asciiString = (count: number): string => "a".repeat(count)

const day = 86_400_000

/** Runs `probe` (see the module comment). */
export const run = (probe: ProbeName, context: ProbeContext): Effect.Effect<ProbeResult, Transient | import("./Lab.ts").LabRequestFailed, SubjectRaw | HarnessRest | LabGuard> =>
  Effect.gen(function* () {
    const { runtime, ids } = context
    const guildId = ids.guildId
    const here = context.channelId
    const textHandle = (id: ChannelId) => channelHandle(runtime, { guildId, id, kind: "text" })
    const scenarioText = textHandle(here)
    const harness = yield* HarnessRest
    const guard = yield* LabGuard
    /** The harness's read of a message the subject sent, for the fields the library does not return. */
    const readMessage = (channel: ChannelId, id: string) =>
      harness.getMessage(channel, id).pipe(labStep("probe: read the message back"), Effect.flatMap(decodeOrDie(MessageRead, "the message")))
    const typedSend = (payload: Parameters<typeof scenarioText.send>[0]) => typed(scenarioText.send(payload))
    const rawCreate = (channel: ChannelId, request: Record<string, unknown>) => raw(messagesRoute, "POST", (subject) => subject.createMessage(channel, { ...quiet, ...request }))
    const admit = (ids: ReadonlyArray<ChannelId>) => Effect.forEach(ids, (id) => guard.admitChannel({ id, name: probeThreadName }), { discard: true })

    switch (probe) {
      // ---- text, View and SendMessages ----
      case "typed-send": {
        const sent = yield* typedSend({ content: "lab rule" })
        return result(sent.observation, sent.raw)
      }
      case "raw-send-user-id":
        // a user's ID names no channel; the guard admits a message create aimed at a bot's user ID (R-ids-distinct)
        return fromRaw(yield* rawCreate(ChannelIdSchema.make(ids.targetUserId), { content: "lab rule" }))
      case "raw-send-category":
        return fromRaw(yield* rawCreate(yield* lab(context, "lab"), { content: "lab rule" }))
      case "raw-embed":
        return fromRaw(yield* rawCreate(here, { embeds: [{ title: "lab rule embed" }] }))
      case "raw-file": {
        const answer = yield* raw(messagesRoute, "POST", (subject) =>
          subject.withFiles([new File(["lab rule\n"], "lab.txt", { type: "text/plain" })])(subject.createMessage(here, { ...quiet, content: "lab rule file" }))
        )
        return fromRaw(answer)
      }
      case "raw-poll":
        return fromRaw(yield* rawCreate(here, { poll: { question: { text: "lab rule poll" }, answers: [{ poll_media: { text: "yes" } }, { poll_media: { text: "no" } }], duration: 1 } }))
      case "raw-tts": {
        const answer = yield* rawCreate(here, { content: "lab rule tts", tts: true })
        if (answer._tag === "Rejected") return fromRaw(answer)
        const message = yield* decodeOrDie(MessageRead, "the created message")(answer.body)
        return result(field(message.tts, "tts"), rawOf(answer))
      }
      case "raw-reply": {
        const target = yield* need(context.harnessMessage, "harness message")
        return fromRaw(yield* rawCreate(here, { content: "lab rule reply", message_reference: { message_id: target.id, fail_if_not_exists: true } }))
      }
      case "typed-guild-sticker": {
        const sent = yield* typedSend({ stickers: [{ origin: "guild", id: yield* need(context.stickerId, "lab sticker") }] })
        return result(sent.observation, sent.raw)
      }
      case "raw-unknown-sticker":
        // a well-formed snowflake that names no sticker
        return fromRaw(yield* rawCreate(here, { sticker_ids: ["100000000000000000"] }))
      case "raw-empty":
        return fromRaw(yield* rawCreate(here, {}))
      case "typed-cv2": {
        const sent = yield* typedSend({ componentsV2: [textDisplay("lab rule")] })
        return result(sent.observation, sent.raw)
      }
      case "raw-cv2-content":
        return fromRaw(yield* rawCreate(here, { flags: 32768, content: "lab rule", components: [{ type: 10, content: "lab rule" }] }))
      case "typed-mention-user": {
        const sent = yield* typedSend({ content: `lab rule <@${ids.targetUserId}>` })
        if (sent.value === undefined) return result(sent.observation, sent.raw)
        const message = yield* readMessage(here, sent.value.message.id)
        return result(field(message.mentions.length > 0, "mentions"), sent.raw)
      }
      case "raw-mention-user": {
        // no allowed_mentions at all: Discord's default parses the user mention
        const answer = yield* raw(messagesRoute, "POST", (subject) => subject.createMessage(here, { content: `lab rule <@${ids.targetUserId}>` }))
        if (answer._tag === "Rejected") return fromRaw(answer)
        const message = yield* decodeOrDie(MessageRead, "the created message")(answer.body)
        return result(field(message.mentions.some((user) => user.id === ids.targetUserId), "mentions"), rawOf(answer))
      }
      case "typed-suppress-notifications": {
        const sent = yield* typedSend({ content: "lab rule", suppressNotifications: true })
        if (sent.value === undefined) return result(sent.observation, sent.raw)
        const message = yield* readMessage(here, sent.value.message.id)
        return result(field(((message.flags ?? 0) & 4096) !== 0, "flags"), sent.raw)
      }
      case "raw-ephemeral": {
        const answer = yield* rawCreate(here, { content: "lab rule", flags: 64 })
        if (answer._tag === "Rejected") return fromRaw(answer)
        const message = yield* decodeOrDie(MessageRead, "the created message")(answer.body)
        return result(field(((message.flags ?? 0) & 64) !== 0, "flags"), rawOf(answer))
      }
      case "raw-edit-suppress-notifications": {
        const own = yield* need(context.subjectMessage, "subject message")
        const answer = yield* raw("/channels/{channel.id}/messages/{message.id}", "PATCH", (subject) => subject.updateMessage(here, own.id, { ...quiet, content: "lab rule edited", flags: 4096 }))
        if (answer._tag === "Rejected") return fromRaw(answer)
        const message = yield* decodeOrDie(MessageRead, "the edited message")(answer.body)
        return result(field(((message.flags ?? 0) & 4096) !== 0, "flags"), rawOf(answer))
      }
      case "typed-mention-mentionable":
      case "typed-mention-unmentionable": {
        const role: RoleId = yield* need(ids.roles.get(probe === "typed-mention-mentionable" ? "lab-mentionable" : "lab-unmentionable"), "the mentioned role")
        const sent = yield* typedSend({ content: `lab rule <@&${role}>`, mentions: { roles: [role] } })
        if (sent.value === undefined) return result(sent.observation, sent.raw)
        // the observation is the harness's own read of the message (the M6 verifier), not the library's readback;
        // the library's readback must say the same (a role mention Discord dropped is MentionEveryone, H-101)
        const message = yield* readMessage(here, sent.value.message.id)
        const applied = message.mention_roles.includes(role)
        const libraryDropped = sent.value.degraded.includes("MentionEveryone")
        if (libraryDropped === applied) {
          return yield* Effect.die(new Error(`probe ${probe}: the library's readback says MentionEveryone ${libraryDropped ? "dropped" : "kept"} the role mention, the harness reads mention_roles ${applied ? "with" : "without"} it`))
        }
        return result(field(applied, "mention_roles"), Outcome.ok(applied ? [] : ["MentionEveryone"]))
      }
      case "typed-five-links": {
        const link = { kind: "button", style: "link", label: "Docs", url: "https://discord.com/developers/docs" } as const
        const sent = yield* typedSend({ content: "lab rule", components: [row([link, link, link, link, link])] })
        return result(sent.observation, sent.raw)
      }
      case "raw-six-links": {
        const link = { type: 2, style: 5, label: "Docs", url: "https://discord.com/developers/docs" }
        return fromRaw(yield* rawCreate(here, { content: "lab rule", components: [{ type: 1, components: [link, link, link, link, link, link] }] }))
      }
      case "typed-select-alone": {
        const route = ComponentRoute.make("lab-select", Schema.Struct({}))
        const customId = yield* route.customId({}).pipe(Effect.orDie)
        const sent = yield* typedSend({ content: "lab rule", components: [row([{ kind: "string-select", customId, options: [{ label: "A", value: "a" }] }])] })
        return result(sent.observation, sent.raw)
      }
      case "raw-select-with-button":
        return fromRaw(
          yield* rawCreate(here, {
            content: "lab rule",
            components: [{ type: 1, components: [{ type: 3, custom_id: "lab-select:{}", options: [{ label: "A", value: "a" }] }, { type: 2, style: 1, label: "Go", custom_id: "lab-button:{}" }] }]
          })
        )
      case "raw-link-custom-id":
        return fromRaw(yield* rawCreate(here, { content: "lab rule", components: [{ type: 1, components: [{ type: 2, style: 5, label: "Docs", url: "https://discord.com/developers/docs", custom_id: "lab-link:{}" }] }] }))
      case "raw-premium-unlabelled":
      case "raw-premium-labelled": {
        // a well-formed SKU ID the application does not own; the differential is whether a `label` path appears (open question 6)
        const button = { type: 2, style: 6, sku_id: "100000000000000000", ...(probe === "raw-premium-labelled" ? { label: "Buy" } : {}) }
        return fromRaw(yield* rawCreate(here, { components: [{ type: 1, components: [button] }] }))
      }
      case "typed-content-max": {
        const sent = yield* typedSend({ content: unitString(Limits.content) })
        return result(sent.observation, sent.raw)
      }
      case "raw-content-over":
        return fromRaw(yield* rawCreate(here, { content: asciiString(Limits.content + 1) }))
      // ---- text with EmbedLinks and SendPolls ----
      case "typed-embed-max": {
        const sent = yield* typedSend({ embeds: [{ title: "t".repeat(Limits.embeds.title) }] })
        return result(sent.observation, sent.raw)
      }
      case "raw-embed-over":
        return fromRaw(yield* rawCreate(here, { embeds: [{ title: "t".repeat(Limits.embeds.title + 1) }] }))
      case "typed-poll-max": {
        const sent = yield* typedSend({ poll: { question: "q".repeat(Limits.poll.question), answers: ["yes", "no"], durationHours: 1 } })
        return result(sent.observation, sent.raw)
      }
      case "raw-poll-over":
        return fromRaw(
          yield* rawCreate(here, { poll: { question: { text: "q".repeat(Limits.poll.question + 1) }, answers: [{ poll_media: { text: "yes" } }, { poll_media: { text: "no" } }], duration: 1 } })
        )
      // ---- forum ----
      case "typed-post": {
        const forum = channelHandle(runtime, { guildId, id: here, kind: "forum" })
        const posted = yield* typed(forum.createPost({ name: probeThreadName, message: { content: "lab rule" } }))
        const created = posted.value === undefined ? [] : [posted.value.id]
        yield* admit(created)
        return result(posted.observation, posted.raw, created)
      }
      case "raw-send-forum":
        return fromRaw(yield* rawCreate(here, { content: "lab rule" }))
      case "raw-thread-forum": {
        const answer = yield* raw(threadsRoute, "POST", (subject) => subject.createThread(here, { name: probeThreadName, type: 11 }))
        yield* admit(createdBy(answer))
        return fromRaw(answer, createdBy(answer))
      }
      // ---- announcement ----
      case "typed-crosspost": {
        const announcement = channelHandle(runtime, { guildId, id: here, kind: "announcement" })
        const published = yield* typed(
          announcement.send({ content: "lab rule crosspost" }).pipe(
            Effect.flatMap((sent) => (sent.message.channelKind === "announcement" ? sent.message.crosspost() : Effect.die(new Error("probe: the sent message is not an announcement message"))))
          )
        )
        return result(published.observation, published.raw)
      }
      case "raw-crosspost-text": {
        const text = yield* lab(context, "lab-text")
        const posted = yield* rawCreate(text, { content: "lab rule" })
        if (posted._tag === "Rejected") return yield* Effect.die(new Error(`probe: the subject could not post in lab-text: ${posted.response.status} ${posted.response.code}`))
        const message = yield* decodeOrDie(MessageRead, "the created message")(posted.body)
        return fromRaw(yield* raw("/channels/{channel.id}/messages/{message.id}/crosspost", "POST", (subject) => subject.crosspostMessage(text, message.id)))
      }
      case "typed-announcement-thread": {
        const announcement = channelHandle(runtime, { guildId, id: here, kind: "announcement" })
        const made = yield* typed(announcement.createThread({ name: probeThreadName }))
        const created = made.value === undefined ? [] : [made.value.id]
        yield* admit(created)
        return result(made.observation, made.raw, created)
      }
      case "raw-private-announcement-thread": {
        const answer = yield* raw(threadsRoute, "POST", (subject) => subject.createThread(here, { name: probeThreadName, type: 12 }))
        yield* admit(createdBy(answer))
        return fromRaw(answer, createdBy(answer))
      }
      // ---- a public thread ----
      case "typed-join": {
        const joined = yield* typed(channelHandle(runtime, { guildId, id: here, kind: "public-thread" }).join())
        return result(joined.observation, joined.raw)
      }
      case "raw-join-text": {
        const text = yield* lab(context, "lab-text")
        return fromRaw(yield* raw("/channels/{channel.id}/thread-members/@me", "PUT", (subject) => subject.joinThread(text)))
      }
      case "typed-thread-send": {
        const sent = yield* typed(channelHandle(runtime, { guildId, id: here, kind: "public-thread" }).send({ content: "lab rule" }))
        return result(sent.observation, sent.raw)
      }
      case "raw-send-parent":
        return fromRaw(yield* rawCreate(yield* lab(context, "lab-text"), { content: "lab rule" }))
      // ---- text with CreatePublicThreads ----
      case "typed-thread-name-max": {
        const made = yield* typed(scenarioText.createThread({ name: `lab-${"n".repeat(Limits.name.max - 4)}` }))
        const created = made.value === undefined ? [] : [made.value.id]
        yield* admit(created)
        return result(made.observation, made.raw, created)
      }
      case "raw-thread-voice": {
        const voice = yield* lab(context, "lab-voice")
        const answer = yield* raw(threadsRoute, "POST", (subject) => subject.createThread(voice, { name: probeThreadName, type: 11 }))
        yield* admit(createdBy(answer))
        return fromRaw(answer, createdBy(answer))
      }
      case "raw-thread-name-over": {
        const answer = yield* raw(threadsRoute, "POST", (subject) => subject.createThread(here, { name: `lab-${"n".repeat(Limits.name.max - 3)}`, type: 11 }))
        yield* admit(createdBy(answer))
        return fromRaw(answer, createdBy(answer))
      }
      // ---- text, the subject's and the harness's messages ----
      case "typed-edit-own":
      case "typed-delete-own": {
        const own = messageHandle(runtime, { guildId, id: here, kind: "text" }, yield* need(context.subjectMessage, "subject message"))
        if (own.author !== "self") return yield* Effect.die(new Error("probe: the subject message is not the subject's"))
        const outcome = yield* typed(probe === "typed-edit-own" ? Effect.asVoid(own.edit({ content: "lab rule edited" })) : own.delete())
        return result(outcome.observation, outcome.raw)
      }
      case "raw-edit-foreign": {
        const foreign = yield* need(context.harnessMessage, "harness message")
        return fromRaw(yield* raw("/channels/{channel.id}/messages/{message.id}", "PATCH", (subject) => subject.updateMessage(here, foreign.id, { ...quiet, content: "lab rule edited" })))
      }
      case "raw-delete-foreign": {
        const foreign = yield* need(context.harnessMessage, "harness message")
        return fromRaw(yield* raw("/channels/{channel.id}/messages/{message.id}", "DELETE", (subject) => subject.deleteMessage(here, foreign.id)))
      }
      // ---- text with ManageMessages ----
      case "typed-bulk-delete-two": {
        const first = (yield* need(context.harnessMessage, "harness message")).id
        const second = yield* need(context.secondHarnessMessage, "second harness message")
        const deleted = yield* typed(scenarioText.bulkDelete([first, second]))
        return result(deleted.observation, deleted.raw)
      }
      case "raw-bulk-delete-one": {
        const first = (yield* need(context.harnessMessage, "harness message")).id
        return fromRaw(yield* raw("/channels/{channel.id}/messages/bulk-delete", "POST", (subject) => subject.bulkDeleteMessages(here, { messages: [first] })))
      }
      // ---- text with PinMessages ----
      case "typed-pin-text": {
        const foreign = messageHandle(runtime, { guildId, id: here, kind: "text" }, yield* need(context.harnessMessage, "harness message"))
        if (!("pin" in foreign)) return yield* Effect.die(new Error("probe: a text message without pin"))
        const pinned = yield* typed(foreign.pin())
        return result(pinned.observation, pinned.raw)
      }
      case "raw-pin-voice": {
        const voice = yield* lab(context, "lab-voice")
        const posted = yield* rawCreate(voice, { content: "lab rule" })
        if (posted._tag === "Rejected") return yield* Effect.die(new Error(`probe: the subject could not post in lab-voice: ${posted.response.status} ${posted.response.code}`))
        const message = yield* decodeOrDie(MessageRead, "the created message")(posted.body)
        return fromRaw(yield* raw("/channels/{channel.id}/messages/pins/{message.id}", "PUT", (subject) => subject.createPin(voice, message.id)))
      }
      // ---- text with ManageChannels ----
      case "typed-topic-max": {
        const edited = yield* typed(textHandle(yield* lab(context, "lab-bots-only")).edit({ topic: "t".repeat(Limits.topic.channel) }))
        return result(edited.observation, edited.raw)
      }
      case "raw-topic-voice": {
        const voice = yield* lab(context, "lab-voice")
        const topic = `lab rule topic ${context.now}`
        const answer = yield* raw(channelRoute, "PATCH", (subject) => subject.updateChannel(voice, { topic }))
        if (answer._tag === "Rejected") return fromRaw(answer)
        const channel = yield* decodeOrDie(ChannelRead, "the edited channel")(answer.body)
        return result(field(channel.topic === topic, "topic"), rawOf(answer))
      }
      case "raw-topic-over": {
        const botsOnly = yield* lab(context, "lab-bots-only")
        return fromRaw(yield* raw(channelRoute, "PATCH", (subject) => subject.updateChannel(botsOnly, { topic: "t".repeat(Limits.topic.channel + 1) })))
      }
      case "typed-slowmode-max": {
        const edited = yield* typed(scenarioText.edit({ slowmodeSeconds: Limits.slowmode.max }))
        return result(edited.observation, edited.raw)
      }
      case "raw-slowmode-over":
        return fromRaw(yield* raw(channelRoute, "PATCH", (subject) => subject.updateChannel(here, { rate_limit_per_user: Limits.slowmode.max + 1 })))
      // ---- members ----
      case "typed-nickname-max": {
        const member = memberHandle(runtime, guildId, yield* need(context.target, "target member"))
        const renamed = yield* typed(member.setNickname("n".repeat(Limits.nickname)))
        return result(renamed.observation, renamed.raw)
      }
      case "raw-nickname-over":
        return fromRaw(yield* raw("/guilds/{guild.id}/members/{user.id}", "PATCH", (subject) => subject.updateGuildMember(guildId, ids.targetUserId, { nick: "n".repeat(Limits.nickname + 1) })))
      case "typed-timeout-max": {
        const member = memberHandle(runtime, guildId, yield* need(context.target, "target member"))
        const now = yield* Clock.currentTimeMillis
        const timedOut = yield* typed(member.timeout(new Date(now + Limits.timeoutDays * day)))
        return result(timedOut.observation, timedOut.raw)
      }
      case "raw-timeout-over": {
        const until = new Date(context.now + Limits.timeoutDays * day + 3_600_000).toISOString()
        return fromRaw(yield* raw("/guilds/{guild.id}/members/{user.id}", "PATCH", (subject) => subject.updateGuildMember(guildId, ids.targetUserId, { communication_disabled_until: until })))
      }
    }
  })
