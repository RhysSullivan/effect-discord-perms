/**
 * The rule rows (DESIGN §5.5): the live valid and invalid sides of every phase-1 compile-time rule in the
 * registry (`test/rules.ts`). Each pair runs on one named setup here, so both sides share a byte-identical Setup
 * (rules-check asserts it on the truth table); a scenario ID is `rule/<setup>/<probe>`, and the probe
 * (`harness/Probes.ts`) is what the side does. A side several rules share (the plain typed send) is one scenario;
 * the registry's expectations for it must agree.
 */
import { Schema } from "effect"
import { rules } from "../../../test/rules.ts"
import { type Observation, type Scenario, Setup } from "../Dsl.ts"
import { ProbeName } from "../Probes.ts"
import { byId } from "./common.ts"

/** The setups the rule pairs run on. */
export const ruleSetups = {
  /** A text channel with View and SendMessages (nothing else, so a payload's own flag is missing). */
  "text-send": new Setup({
    channel: "text",
    grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }],
    removals: [],
    memberState: "normal",
    fixtures: ["subject-message", "harness-message", "guild-sticker"]
  }),
  /** A text channel with the flags an embed and a poll need, for the limit rows. */
  "text-rich": new Setup({ channel: "text", grants: [{ flags: ["ViewChannel", "SendMessages", "EmbedLinks", "SendPolls"], via: "role" }], removals: [], memberState: "normal", fixtures: [] }),
  /** The lab forum, with what a post needs (H-031). */
  forum: new Setup({ channel: "forum", grants: [{ flags: ["ViewChannel", "SendMessages"], via: "role" }], removals: [], memberState: "normal", fixtures: [] }),
  /** The announcement channel, with what a crosspost and either thread creation need. */
  announcement: new Setup({
    channel: "announcement",
    grants: [{ flags: ["ViewChannel", "SendMessages", "ReadMessageHistory", "CreatePublicThreads", "CreatePrivateThreads"], via: "role" }],
    removals: [],
    memberState: "normal",
    fixtures: []
  }),
  /** The provisioned public thread, with View and SendMessagesInThreads but no SendMessages. */
  thread: new Setup({ channel: "public-thread", grants: [{ flags: ["ViewChannel", "SendMessagesInThreads"], via: "role" }], removals: [], memberState: "normal", fixtures: [] }),
  /** A text channel with CreatePublicThreads (and Connect, so voice answers about its kind, not its access). */
  "text-threads": new Setup({
    channel: "text",
    grants: [{ flags: ["ViewChannel", "SendMessages", "CreatePublicThreads", "Connect"], via: "role" }],
    removals: [],
    memberState: "normal",
    fixtures: []
  }),
  /** A text channel with the subject's and the harness's messages, without ManageMessages. */
  "text-messages": new Setup({
    channel: "text",
    grants: [{ flags: ["ViewChannel", "SendMessages", "ReadMessageHistory"], via: "role" }],
    removals: [],
    memberState: "normal",
    fixtures: ["subject-message", "harness-message"]
  }),
  /** A text channel with ManageMessages and two of the harness's messages. */
  "text-manage": new Setup({
    channel: "text",
    grants: [{ flags: ["ViewChannel", "SendMessages", "ReadMessageHistory", "ManageMessages"], via: "role" }],
    removals: [],
    memberState: "normal",
    fixtures: ["harness-message", "second-harness-message"]
  }),
  /** A text channel with PinMessages (and Connect, so voice answers about its pins, not its access). */
  "text-pins": new Setup({
    channel: "text",
    grants: [{ flags: ["ViewChannel", "SendMessages", "ReadMessageHistory", "PinMessages", "Connect"], via: "role" }],
    removals: [],
    memberState: "normal",
    fixtures: ["harness-message"]
  }),
  /** A text channel with ManageChannels (and Connect, which a stage channel's edits need). */
  "text-manage-channels": new Setup({ channel: "text", grants: [{ flags: ["ViewChannel", "ManageChannels", "Connect"], via: "role" }], removals: [], memberState: "normal", fixtures: [] }),
  /** The subject above the target, with ManageNicknames and ModerateMembers. */
  members: new Setup({ channel: "text", grants: [{ flags: ["ManageNicknames", "ModerateMembers"], via: "role" }], removals: [], memberState: "normal", targetRank: "below", targetAdmin: false, fixtures: [] })
} as const

/** A setup name. */
export type RuleSetupName = keyof typeof ruleSetups

const isSetupName = (name: string): name is RuleSetupName => name in ruleSetups
const decodeProbe = Schema.decodeUnknownOption(ProbeName)

/** The setup and probe a rule scenario ID names, or why it names none. */
export const parseRuleScenario = (id: string): { readonly setup: RuleSetupName; readonly probe: ProbeName } | string => {
  const [family, setup, probe, ...rest] = id.split("/")
  if (family !== "rule" || setup === undefined || probe === undefined || rest.length > 0) return `${id} is not rule/<setup>/<probe>`
  if (!isSetupName(setup)) return `${id}: no setup ${setup} in harness/scenario/catalog/rules.ts`
  const decoded = decodeProbe(probe)
  return decoded._tag === "Some" ? { setup, probe: decoded.value } : `${id}: no probe ${probe} in harness/scenario/Probes.ts`
}

/** Every rule side of the registry: its scenario ID and expectation, with the rule it belongs to. */
const sides = rules.flatMap((rule) => (rule.live.kind === "pair" ? [{ rule: rule.id, ...rule.live.valid }, { rule: rule.id, ...rule.live.invalid }] : []))

const sameObservation = (a: Observation, b: Observation): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The rule rows, one per distinct scenario ID of the registry's pairs, sorted by ID. A malformed or contradictory registry throws at load. */
export const scenarios: ReadonlyArray<Scenario> = byId(
  [...new Set(sides.map((side) => side.scenario))].map((id): Scenario => {
    const parsed = parseRuleScenario(id)
    if (typeof parsed === "string") throw new Error(`rule catalog: ${parsed}`)
    const mine = sides.filter((side) => side.scenario === id)
    const [first] = mine
    if (first === undefined) throw new Error(`rule catalog: ${id} has no side`)
    for (const other of mine) {
      if (!sameObservation(other.expect, first.expect)) throw new Error(`rule catalog: ${other.rule} and ${first.rule} expect different observations of ${id}`)
    }
    return { id, hypotheses: [], setup: ruleSetups[parsed.setup], operation: { _tag: "rule", probe: parsed.probe }, expect: first.expect }
  })
)
