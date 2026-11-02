/**
 * Fixtures (DESIGN §5.10 step 2): the objects a scenario acts on, created in two phases around Converge.
 *
 * **The subject's own objects, before Converge.** A `subject-message` or a `subject-thread` must be the
 * subject's, but the setup may hide the channel from it or time it out. So they are made first, with temporary
 * access: the harness lifts a leftover timeout and gives the subject a member overwrite on the scenario's
 * overwrite channel that allows what posting and thread creation need (a member overwrite beats role and
 * `@everyone` denies, H-008), the subject creates them through `SubjectRaw`, and Converge, which reads the lab
 * afterwards, replaces that overwrite with the desired ones (and puts the timeout back if the setup has one).
 * A thread the subject creates is admitted to the guard as it is created, and joins the scenario's IDs.
 *
 * **The harness's objects, after Converge and before the thread's state.** The harness's plain messages, its
 * reaction with the scenario's emoji, and its pin. Posting in an archived thread would unarchive it, so the
 * runner sets the thread's archived and locked state after these. Discord refusing the harness's pin (400 50019
 * in a stage channel's chat, M2) makes the setup `rejected-by-discord`.
 */
import { Clock, Effect, Option, Schema } from "effect"
import { SubjectRaw } from "../src/bot/Internals.ts"
import * as Flags from "../src/permissions/Flags.ts"
import type { ChannelId, MessageId } from "../src/Snowflake.ts"
import { ChannelId as ChannelIdSchema, MessageId as MessageIdSchema } from "../src/Snowflake.ts"
import { HarnessRest } from "./Identities.ts"
import { LabGuard, type LabRequestFailed, labStep, labStepUnless } from "./Lab.ts"
import * as LabIds from "./LabIds.ts"
import type * as Materialize from "./Materialize.ts"
import type { Setup } from "./scenario/Dsl.ts"
import * as Wire from "./Wire.ts"

/** The unicode emoji a scenario reacts with: one the harness has already used (`existing-reaction`), and a new one. */
export const emoji = { existing: "✅", fresh: "👍" } as const

/** What the subject made before Converge. */
export interface SubjectObjects {
  /** The subject's own plain message in the scenario channel. */
  readonly subjectMessage: MessageId | undefined
  /** The thread the subject created (`subject-thread`), by its scenario name. */
  readonly thread: { readonly name: LabIds.ScenarioThreadName; readonly id: ChannelId } | undefined
}

/** What the harness made after Converge. */
export type HarnessObjects =
  | { readonly _tag: "Ready"; readonly harnessMessage: MessageId | undefined; readonly secondHarnessMessage: MessageId | undefined }
  /** Discord refused a fixture: the setup cannot be built. */
  | { readonly _tag: "Refused"; readonly status: number; readonly code: number }

/** Every flag the subject's fixtures need, allowed through its temporary member overwrite. */
const accessBits: bigint = Flags.fromFlags(["ViewChannel", "SendMessages", "SendMessagesInThreads", "Connect", "ReadMessageHistory", "CreatePublicThreads", "CreatePrivateThreads"])

const Created = Schema.Struct({ id: MessageIdSchema })
const CreatedThread = Schema.Struct({ id: ChannelIdSchema, name: Schema.String })

const lookup = <K, V>(map: ReadonlyMap<K, V>, key: K, what: string): Effect.Effect<V> => {
  const value = map.get(key)
  return value === undefined ? Effect.die(new Error(`fixtures: no ID for ${what}`)) : Effect.succeed(value)
}

/** Whether a setup needs the subject's own objects. */
export const needsSubject = (setup: Setup): boolean => setup.fixtures.includes("subject-message") || setup.fixtures.includes("subject-thread")

/**
 * Makes the subject's own objects (see the module comment). `scenarioThread` is the thread a `subject-thread`
 * setup acts in (`Materialize.labNameOf`), with its spec; `channel` is where a `subject-message` goes when the
 * scenario does not act in that thread.
 */
export const subjectObjects = (input: {
  readonly setup: Setup
  readonly ids: Materialize.Ids
  readonly overwriteChannel: LabIds.ChannelName
  readonly channel: Materialize.LabName
  readonly scenarioThread: { readonly name: LabIds.ScenarioThreadName; readonly parent: LabIds.ChannelName; readonly type: number } | undefined
}): Effect.Effect<SubjectObjects, LabRequestFailed, HarnessRest | SubjectRaw | LabGuard> =>
  Effect.gen(function* () {
    const { setup, ids } = input
    if (!needsSubject(setup)) return { subjectMessage: undefined, thread: undefined }
    const rest = yield* HarnessRest
    const subject = yield* SubjectRaw
    const guard = yield* LabGuard

    // temporary access: no timeout, and a member overwrite allowing what the fixtures need
    const member = yield* rest.getGuildMember(ids.guildId, ids.subjectUserId).pipe(labStep("fixtures: get the subject"), Effect.flatMap(Wire.decode(Wire.Member, "getGuildMember")))
    const until = member.communication_disabled_until
    if (until !== undefined && until !== null && Date.parse(until) > (yield* Clock.currentTimeMillis)) {
      yield* rest.updateGuildMember(ids.guildId, ids.subjectUserId, { communication_disabled_until: null }).pipe(labStep("fixtures: lift the subject's timeout"))
    }
    const parentId = yield* lookup(ids.channels, input.overwriteChannel, input.overwriteChannel)
    const parent = yield* rest.getChannel(parentId).pipe(labStep(`fixtures: get ${input.overwriteChannel}`), Effect.flatMap(Wire.decode(Wire.Channel, "getChannel")))
    const others = (parent.permission_overwrites ?? []).filter((overwrite) => !(overwrite.type === 1 && overwrite.id === ids.subjectUserId))
    yield* rest
      .updateChannel(parentId, {
        permission_overwrites: [
          ...others.map((overwrite) => ({ id: overwrite.id, type: overwrite.type, allow: Number(overwrite.allow), deny: Number(overwrite.deny) })),
          { id: ids.subjectUserId, type: 1, allow: Number(accessBits), deny: 0 }
        ]
      })
      .pipe(labStep(`fixtures: give the subject access to ${input.overwriteChannel}`))

    let thread: SubjectObjects["thread"]
    const spec = input.scenarioThread
    if (setup.fixtures.includes("subject-thread")) {
      if (spec === undefined) return yield* Effect.die(new Error("fixtures: a subject-thread setup without a scenario thread"))
      const parentOfThread = yield* lookup(ids.channels, spec.parent, spec.parent)
      const created =
        spec.type === 11 && spec.parent === "lab-forum"
          ? subject.createThread(parentOfThread, { name: spec.name, auto_archive_duration: LabIds.threadAutoArchiveMinutes, message: { content: "lab post", allowed_mentions: { parse: [] } } })
          : subject.createThread(parentOfThread, { name: spec.name, type: spec.type === 10 ? 10 : spec.type === 12 ? 12 : 11, auto_archive_duration: LabIds.threadAutoArchiveMinutes })
      const body = yield* created.pipe(labStep(`fixtures: the subject creates ${spec.name}`), Effect.flatMap(Wire.decode(CreatedThread, "createThread")))
      yield* guard.admitChannel(body)
      thread = { name: spec.name, id: body.id }
    }

    let subjectMessage: MessageId | undefined
    if (setup.fixtures.includes("subject-message")) {
      const where = thread !== undefined && thread.name === input.channel ? thread.id : yield* lookup(ids.channels, input.channel, input.channel)
      subjectMessage = (yield* subject
        .createMessage(where, { content: "lab subject message", allowed_mentions: { parse: [] } })
        .pipe(labStep("fixtures: the subject's message"), Effect.flatMap(Wire.decode(Created, "createMessage")))).id
    }
    return { subjectMessage, thread }
  })

/** Makes the harness's objects in `channel` (see the module comment); `existing-reaction` uses `emoji.existing`. */
export const harnessObjects = (setup: Setup, channel: ChannelId): Effect.Effect<HarnessObjects, LabRequestFailed, HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const post = (what: string) =>
      rest.createMessage(channel, { content: `lab ${what}`, allowed_mentions: { parse: [] } }).pipe(labStep(`fixtures: ${what}`), Effect.flatMap(Wire.decode(Created, "createMessage")))
    const has = (fixture: Setup["fixtures"][number]) => setup.fixtures.includes(fixture)
    const harnessMessage = has("harness-message") || has("existing-reaction") || has("pinned-harness-message") ? (yield* post("harness message")).id : undefined
    const secondHarnessMessage = has("second-harness-message") ? (yield* post("second harness message")).id : undefined
    if (has("existing-reaction")) {
      if (harnessMessage === undefined) return yield* Effect.die(new Error("fixtures: a reaction without its message"))
      yield* rest.addMyMessageReaction(channel, harnessMessage, encodeURIComponent(emoji.existing)).pipe(labStep("fixtures: the harness's reaction"))
    }
    if (has("pinned-harness-message")) {
      if (harnessMessage === undefined) return yield* Effect.die(new Error("fixtures: a pin without its message"))
      const pinned = yield* rest.createPin(channel, harnessMessage).pipe(labStepUnless("fixtures: the harness's pin", [50019]))
      if (Option.isNone(pinned)) return { _tag: "Refused", status: 400, code: 50019 }
    }
    return { _tag: "Ready", harnessMessage, secondHarnessMessage }
  })
