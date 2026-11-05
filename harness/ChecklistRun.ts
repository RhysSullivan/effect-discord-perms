/**
 * `harness/main.ts checklist` (DESIGN §6 M9; LOG.md "Waiting for Rhys"): runs the phase-3 checklist and the DM checks
 * for Rhys to click through in Perms Lab. It waits for a human, so no agent runs it alone; nothing in it DMs or pings
 * anyone (the subject only answers interactions, and every answer pings nobody).
 *
 * 1. Registers `/checklist` (`interactions/Checklist.ts`) as the subject's only guild command in Perms Lab, through the
 *    library's registration.
 * 2. Opens a subject session with Guilds and the three DM intents (DirectMessages, DirectMessageReactions,
 *    DirectMessageTyping) and without MessageContent, registers the checklist's handlers on it, and records the DM
 *    events Discord sends it (Q-17: a DM's content arrives without MessageContent; Q-22: each DM event arrives under its
 *    DM intent).
 * 3. Waits until every checklist item has a verdict and the three DM events arrived, or {@link waitFor} passes.
 * 4. Opens a session with Guilds and GuildMessages but no DM intent, and waits for the canary, a message in a lab
 *    channel, sent after one more DM: a DM event that arrives before the canary means the DM intents are not needed
 *    (Q-22's absence half).
 * 5. Removes `/checklist` (the subject's guild commands become none) and returns what it saw.
 */
import { Duration, Effect, Ref, Schema } from "effect"
import { BotRuntime } from "../src/bot/Bot.ts"
import { SubjectRaw } from "../src/bot/Internals.ts"
import * as Registration from "../src/commands/Registration.ts"
import * as Checklist from "../src/interactions/Checklist.ts"
import { Sessions } from "./Identities.ts"
import type { IdentityReport } from "./IdentityCheck.ts"
import { labStepDeadline } from "./Lab.ts"

/** How long the checklist waits for the human. */
export const waitFor = Duration.minutes(20)

/** How long the absence check waits for the canary. */
export const canaryWithin = Duration.minutes(5)

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
const GuildWire = Schema.Struct({ guild_id: Schema.optionalKey(Schema.String) })

/** The DM event a dispatch is, if it is one. */
export const dmEventOf = (event: string, data: unknown): DmEvent | undefined => {
  if (event !== "MESSAGE_CREATE" && event !== "MESSAGE_REACTION_ADD" && event !== "TYPING_START") return undefined
  const decoded = Schema.decodeUnknownOption(DmWire)(data)
  if (decoded._tag === "None" || decoded.value.guild_id !== undefined) return undefined
  return event === "MESSAGE_CREATE" ? { event, contentDelivered: (decoded.value.content ?? "").length > 0 } : { event }
}

/** Whether a dispatch is the canary: a message in the lab guild. */
const isCanary = (guildId: string) => (event: string, data: unknown): boolean => {
  if (event !== "MESSAGE_CREATE") return false
  const decoded = Schema.decodeUnknownOption(GuildWire)(data)
  return decoded._tag === "Some" && decoded.value.guild_id === guildId
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
  "1. In #lab-text, run /checklist: pick any choice, any member and #lab-text, and type in `search` to see a suggestion.",
  "2. Click each prompt button the bot posts, check what it does against the prompt's text, and click its verdict.",
  "3. Open a DM with Perms Subject: send any message, react to it with any emoji, and type for a few seconds.",
  "The run continues by itself when every verdict and the three DM events are in."
].join("\n")

/** Runs the checklist (see the module comment). */
export const run = (report: IdentityReport) =>
  Effect.gen(function* () {
    const subject = yield* SubjectRaw
    const sessions = yield* Sessions
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
        yield* checklist.register.pipe(Effect.provideService(BotRuntime, session.runtime))
        yield* Effect.sync(() => console.log(instructions))
        const done = Effect.gen(function* () {
          const seen = new Set((yield* Ref.get(withIntents)).map((dm) => dm.event))
          return (yield* checklist.verdicts).size === Checklist.itemList.length && seen.size === 3
        })
        yield* holdsWithin(done, waitFor)
        return yield* checklist.verdicts
      })
    )
    const withoutIntents = yield* Ref.make<ReadonlyArray<DmEvent>>([])
    const canary = yield* Effect.scoped(
      Effect.gen(function* () {
        const seen = yield* Ref.make(false)
        const canaryOf = isCanary(report.guild.id)
        yield* sessions.open(["Guilds", "GuildMessages"], (event, data) =>
          Effect.gen(function* () {
            if (canaryOf(event, data)) yield* Ref.set(seen, true)
            const dm = dmEventOf(event, data)
            // only what arrives before the canary is evidence
            if (dm !== undefined && !(yield* Ref.get(seen))) yield* Ref.update(withoutIntents, (all) => [...all, dm])
          })
        )
        yield* Effect.sync(() => console.log("4. Now without the DM intents: send Perms Subject one more DM, react to it and type; then post any message in #lab-text."))
        return yield* holdsWithin(Ref.get(seen), canaryWithin)
      })
    )
    yield* Registration.sync(subject, target, [], labStepDeadline)
    const result: Result = { verdicts, withIntents: yield* Ref.get(withIntents), withoutIntents: yield* Ref.get(withoutIntents), canary }
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
