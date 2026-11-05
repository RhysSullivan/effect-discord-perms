/**
 * `harness/main.ts checklist` (DESIGN §6 M9; LOG.md "Waiting for Rhys"): runs the phase-3 checklist and the DM checks
 * for Rhys to click through in Perms Lab. It waits for a human, so no agent runs it alone; nothing in it DMs or pings
 * anyone (the subject only answers interactions, and every answer pings nobody).
 *
 * 1. Resets and provisions the lab, as a run does, then converges it to {@link checklistSetup}, the rule rows'
 *    `text-messages` setup (Safety-checked): the subject holds `lab-grant` with View, SendMessages and
 *    ReadMessageHistory, so it sees #lab-text. At baseline it holds no permission anywhere, and Discord sends no
 *    MESSAGE_CREATE for a channel the bot cannot view, so step 5's canary could never arrive (the M9 verifier).
 * 2. Registers `/checklist` (`interactions/Checklist.ts`) as the subject's only guild command in Perms Lab, through the
 *    library's registration.
 * 3. Opens a subject session with Guilds and the three DM intents (DirectMessages, DirectMessageReactions,
 *    DirectMessageTyping) and without MessageContent, registers the checklist's handlers on it, limited to the lab's
 *    admitted channels ({@link labInteractionsOnly}), and records the DM events Discord sends it (Q-17: a DM's content
 *    arrives without MessageContent; Q-22: each DM event arrives under its DM intent).
 * 4. Waits until {@link isDone} (every checklist item has a verdict and the three DM events arrived), or {@link waitFor}
 *    passes.
 * 5. Opens a session with Guilds and GuildMessages but no DM intent, and waits for the canary, a message in #lab-text
 *    ({@link isCanary}), sent after one more DM: a DM event that arrives before the canary means the DM intents are not
 *    needed (Q-22's absence half).
 * 6. Resets the lab, which also removes `/checklist` (the subject's guild commands become none), whatever happened
 *    before: a failed or interrupted sitting still ends with the closing reset.
 */
import { BunFileSystem } from "@effect/platform-bun"
import { Clock, Context, Duration, Effect, Exit, Layer, Option, Ref, Schema, type Scope } from "effect"
import { BotRuntime } from "../src/bot/Bot.ts"
import { SubjectRaw } from "../src/bot/Internals.ts"
import type { Runtime } from "../src/bot/Runtime.ts"
import * as Registration from "../src/commands/Registration.ts"
import * as Dispatches from "../src/gateway/Dispatches.ts"
import * as Checklist from "../src/interactions/Checklist.ts"
import * as Converge from "./Converge.ts"
import { Sessions } from "./Identities.ts"
import type { IdentityReport } from "./IdentityCheck.ts"
import { LabGuard, labStepDeadline } from "./Lab.ts"
import * as LabIds from "./LabIds.ts"
import * as Materialize from "./Materialize.ts"
import * as Provision from "./Provision.ts"
import * as Reset from "./Reset.ts"
import * as Runner from "./Runner.ts"
import { ruleSetups } from "./scenario/catalog/rules.ts"
import * as Safety from "./scenario/Safety.ts"

/** How long the checklist waits for the human. */
export const waitFor = Duration.minutes(20)

/** How long the absence check waits for the canary. */
export const canaryWithin = Duration.minutes(5)

/**
 * The lab's state during the checklist: the rule rows' `text-messages` setup, whose `lab-grant` lets the subject view and
 * post in #lab-text (the matrix runs it every run, so its Safety and its cleanup by reset are the run's).
 */
export const checklistSetup = ruleSetups["text-messages"]

/** The role edits the checklist makes: the budget check's own, `lab-grant`'s grant, the closing reset's revert, and one spare. */
const checklistRoleEdits = 4

/** A DM event the sessions record: its name, and for a message whether Discord delivered its content. */
export interface DmEvent {
  readonly event: "MESSAGE_CREATE" | "MESSAGE_REACTION_ADD" | "TYPING_START"
  readonly contentDelivered?: boolean
}

/** What the checklist run saw. */
export interface Result {
  readonly verdicts: ReadonlyMap<Checklist.Item, boolean>
  /** DM events with the DM intents (each should arrive; a message's content should be delivered, Q-17). */
  readonly withIntents: ReadonlyArray<DmEvent>
  /** DM events without them, before the canary (none should). */
  readonly withoutIntents: ReadonlyArray<DmEvent>
  /** Whether the canary arrived (without it the absence is no evidence). */
  readonly canary: boolean
}

const DmWire = Schema.Struct({ guild_id: Schema.optionalKey(Schema.String), content: Schema.optionalKey(Schema.String) })
const GuildMessageWire = Schema.Struct({ guild_id: Schema.optionalKey(Schema.String), channel_id: Schema.String })
const InteractionChannelWire = Schema.Struct({ channel_id: Schema.optionalKey(Schema.String), channel: Schema.optionalKey(Schema.Struct({ id: Schema.String })) })

/** The DM event a dispatch is, if it is one. */
export const dmEventOf = (event: string, data: unknown): DmEvent | undefined => {
  if (event !== "MESSAGE_CREATE" && event !== "MESSAGE_REACTION_ADD" && event !== "TYPING_START") return undefined
  const decoded = Schema.decodeUnknownOption(DmWire)(data)
  if (decoded._tag === "None" || decoded.value.guild_id !== undefined) return undefined
  return event === "MESSAGE_CREATE" ? { event, contentDelivered: (decoded.value.content ?? "").length > 0 } : { event }
}

/** Whether the sitting is over: every checklist item has a verdict, and the three DM events arrived with the DM intents. */
export const isDone = (verdicts: ReadonlyMap<Checklist.Item, boolean>, withIntents: ReadonlyArray<DmEvent>): boolean =>
  Checklist.itemList.every((item) => verdicts.has(item)) && new Set(withIntents.map((dm) => dm.event)).size === 3

/** The channel an INTERACTION_CREATE names (its `channel`, else its `channel_id`), if any. */
export const interactionChannelOf = (data: unknown): string | undefined =>
  Option.match(Schema.decodeUnknownOption(InteractionChannelWire)(data), { onNone: () => undefined, onSome: (wire) => wire.channel?.id ?? wire.channel_id })

/**
 * `runtime` with its INTERACTION_CREATE dispatches limited to the channels `isLabChannel` admits, for the caller's
 * scope: one subscription to `runtime`'s interactions forwards each admitted one to a dispatch stream of its own
 * (a fresh `Dispatches.layer`, the library's), which the returned runtime's registrations subscribe to; any other interaction
 * is dropped with one warning before a handler sees it, so nothing answers it. The lab guard cannot check where an
 * interaction's answer goes (its URL names no channel), and a guild command can be invoked anywhere, `#rules` included.
 */
export const labInteractionsOnly = (runtime: Runtime, isLabChannel: (channelId: string) => Effect.Effect<boolean>): Effect.Effect<Runtime, never, Scope.Scope> =>
  Effect.gen(function* () {
    // fresh: a build inside a provided context reuses the layers its memo map already holds, here the bot's own stream
    const admitted = Context.get(yield* Layer.build(Layer.fresh(Dispatches.layer)), Dispatches.Dispatches)
    yield* runtime.events.subscribe("INTERACTION_CREATE", (data) =>
      Effect.gen(function* () {
        const channel = interactionChannelOf(data)
        if (channel !== undefined && (yield* isLabChannel(channel))) return yield* admitted.publish({ event: "INTERACTION_CREATE", data })
        yield* Effect.logWarning(`checklist: ignored an interaction outside the lab's channels (channel ${channel ?? "absent"})`)
      })
    )
    const subscribe: Runtime["events"]["subscribe"] = (name, handle) => (name === "INTERACTION_CREATE" ? admitted.subscribe(name, handle) : runtime.events.subscribe(name, handle))
    return { ...runtime, events: { subscribe } }
  })

/**
 * Whether a dispatch is the canary: a message in #lab-text (`labText`) of the lab guild. Under the checklist's setup the
 * subject sees every channel `lab-grant` lets it, so a message anywhere else in the guild is no canary.
 */
export const isCanary = (guildId: string, labText: string) => (event: string, data: unknown): boolean => {
  if (event !== "MESSAGE_CREATE") return false
  const decoded = Schema.decodeUnknownOption(GuildMessageWire)(data)
  return decoded._tag === "Some" && decoded.value.guild_id === guildId && decoded.value.channel_id === labText
}

/** Waits until `check` holds, polling every 2 s, for at most `within`; whether it held. */
const holdsWithin = (check: Effect.Effect<boolean>, within: Duration.Duration): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (;;) {
      if (yield* check) return true
      yield* Effect.sleep("2 seconds")
    }
  }).pipe(
    Effect.timeoutOption(within),
    Effect.map((held) => held._tag === "Some")
  )

/** What Rhys sees in the terminal, step by step. */
export const instructions = [
  "Phase-3 checklist (LOG.md \"Waiting for Rhys\"). In Perms Lab:",
  "1. In #lab-text, start typing /checklist and type a few letters in its `search` option: a suggestion `search: <your letters>` should appear. Run it with any choice, any member and #lab-text.",
  "2. The bot replies, then posts five messages of prompts. Click each prompt button, check what it does against its line, and click a verdict for each item (12 in all).",
  "3. Open a DM with Perms Subject: send any message, react to it with any emoji, and type for a few seconds.",
  "The run continues by itself when every verdict and the three DM events are in."
].join("\n")

/**
 * The lab at baseline, then at {@link checklistSetup}, with the run's checks before any scenario write (§5.6, §5.11);
 * #lab-text's ID.
 */
const prepare = (report: IdentityReport, context: Reset.Context) =>
  Effect.gen(function* () {
    const reset = yield* Reset.run(context)
    yield* Effect.sync(() => console.log(`reset: ${Reset.summary(reset)}`))
    const provision = yield* Provision.run(context)
    yield* Effect.sync(() => console.log(`provision: ${Provision.summary(provision)}`))
    const state = yield* LabIds.load(context.guildId).pipe(Effect.provide(BunFileSystem.layer))
    const ids = yield* Runner.idsOf(state, report)
    yield* Runner.checkRoleBudget(ids, checklistRoleEdits)
    const desired = Materialize.desired(checklistSetup, ids)
    const scenario = Runner.catalog.find((candidate) => candidate.setup === checklistSetup)
    if (scenario === undefined) return yield* Effect.die(new Error("checklist: no catalog row runs the text-messages setup, so Safety has nothing to check it against"))
    const violations = Safety.checkMaterialized(scenario, desired, ids, yield* Clock.currentTimeMillis)
    if (violations.length > 0) return yield* Effect.die(new Error(`Safety: ${violations.map((violation) => `${violation.rule}: ${violation.detail}`).join("; ")}`))
    const converged = yield* Converge.converge(desired, ids, new Set([desired.overwriteChannel]))
    if (converged._tag !== "Converged") return yield* Effect.die(new Error(`checklist: the text-messages setup did not converge (${converged._tag})`))
    const labText = ids.channels.get("lab-text")
    if (labText === undefined) return yield* Effect.die(new Error("checklist: no lab-text"))
    yield* Effect.sync(() => console.log(`lab: the subject holds lab-grant (${checklistSetup.grants.flatMap((grant) => grant.flags).join(", ")}) and sees #lab-text`))
    return labText
  })

/** The sitting itself: steps 2 to 5 of the module comment, with #lab-text's ID for the canary. */
const sitting = (report: IdentityReport, labText: string) =>
  Effect.gen(function* () {
    const subject = yield* SubjectRaw
    const sessions = yield* Sessions
    const guard = yield* LabGuard
    const target = { applicationId: report.subject.applicationId, guildId: report.guild.id }
    yield* Registration.sync(subject, target, [Checklist.command], labStepDeadline)
    const withIntents = yield* Ref.make<ReadonlyArray<DmEvent>>([])
    const verdicts = yield* Effect.scoped(
      Effect.gen(function* () {
        const record = (event: string, data: unknown) => {
          const dm = dmEventOf(event, data)
          return dm === undefined ? Effect.void : Ref.update(withIntents, (all) => [...all, dm])
        }
        const session = yield* sessions.open(["Guilds", "DirectMessages", "DirectMessageReactions", "DirectMessageTyping"], record)
        const checklist = yield* Checklist.make
        yield* checklist.register.pipe(Effect.provideService(BotRuntime, yield* labInteractionsOnly(session.runtime, guard.isLabChannel)))
        yield* Effect.sync(() => console.log(instructions))
        const done = Effect.gen(function* () {
          return isDone(yield* checklist.verdicts, yield* Ref.get(withIntents))
        })
        yield* holdsWithin(done, waitFor)
        return yield* checklist.verdicts
      })
    )
    const withoutIntents = yield* Ref.make<ReadonlyArray<DmEvent>>([])
    const canary = yield* Effect.scoped(
      Effect.gen(function* () {
        const seen = yield* Ref.make(false)
        const canaryOf = isCanary(report.guild.id, labText)
        yield* sessions.open(["Guilds", "GuildMessages"], (event, data) =>
          Effect.gen(function* () {
            if (canaryOf(event, data)) yield* Ref.set(seen, true)
            const dm = dmEventOf(event, data)
            // only what arrives before the canary is evidence
            if (dm !== undefined && !(yield* Ref.get(seen))) yield* Ref.update(withoutIntents, (all) => [...all, dm])
          })
        )
        yield* Effect.sync(() =>
          console.log("4. Now without the DM intents: send Perms Subject one more DM, react to it and type; then post any message in #lab-text (delete it afterwards if you like: the reset leaves your own messages alone).")
        )
        return yield* holdsWithin(Ref.get(seen), canaryWithin)
      })
    )
    const result: Result = { verdicts, withIntents: yield* Ref.get(withIntents), withoutIntents: yield* Ref.get(withoutIntents), canary }
    return result
  })

/** Runs the checklist (see the module comment). The closing reset runs whatever the sitting did; its failure fails the command. */
export const run = (report: IdentityReport) =>
  Effect.gen(function* () {
    const context = Reset.contextFrom(report)
    const closing = yield* Ref.make<Option.Option<Exit.Exit<Reset.Result, Effect.Error<ReturnType<typeof Reset.run>>>>>(Option.none())
    const closingReset = Effect.exit(Reset.run(context)).pipe(
      Effect.tap((exit) => Effect.sync(() => console.log(Exit.isSuccess(exit) ? `closing reset: ${Reset.summary(exit.value)}` : "closing reset FAILED: run `bun run harness:reset` before anything else"))),
      Effect.flatMap((exit) => Ref.set(closing, Option.some(exit)))
    )
    const result = yield* Effect.flatMap(prepare(report, context), (labText) => sitting(report, labText)).pipe(Effect.ensuring(closingReset))
    const reset = yield* Ref.get(closing)
    if (Option.isNone(reset)) return yield* Effect.die(new Error("checklist: the closing reset did not run"))
    yield* reset.value
    return result
  })

/** The result as lines for the terminal (and for Rhys to paste back). */
export const summary = (result: Result): ReadonlyArray<string> => [
  ...Checklist.itemList.map((item) => {
    const verdict = result.verdicts.get(item)
    return `  ${item}: ${verdict === undefined ? "no verdict" : verdict ? "as expected" : "NOT as expected"}`
  }),
  `  DM events with the DM intents: ${result.withIntents.map((dm) => (dm.contentDelivered === undefined ? dm.event : `${dm.event} (content ${dm.contentDelivered ? "delivered" : "empty"})`)).join(", ") || "none"}`,
  `  DM events without them, before the canary: ${result.withoutIntents.map((dm) => dm.event).join(", ") || "none"}; canary ${result.canary ? "arrived" : "never arrived (no evidence)"}`
]
