/**
 * Safety (DESIGN §5.6): pure checks every scenario must pass. They run offline over the whole catalog (a unit
 * test) and again at run start against each scenario's **materialized** desired state, before any write; a
 * violation aborts the run. The runner adds one live check of its own before a mention-everyone call: the
 * oracle, read by the harness, must show the subject without MentionEveryone and without Administrator.
 *
 * - A payload that mentions `@everyone` never runs with MentionEveryone granted anywhere: no administrator
 *   source, no grant of it, and in the materialized state no `@everyone` permission, held role or overwrite
 *   that gives it to the subject (Rhys is the owner and sees every channel; L3).
 * - Mentions: users only the three bots, roles only `lab-mentionable`/`lab-unmentionable`, which only the
 *   target holds; a reply's `repliedUser` only towards a bot's message. The send payloads mention nobody else.
 * - No row's removals affect the target: in the scenario channel it keeps the flags it posts fixtures with.
 * - At most one name or topic edit per lab channel per run (H-162): a `channelEdit` name or topic operation that
 *   preflight predicts to succeed (a refused edit changes nothing), a renamed setup (`nameVariant: "b"`), or a
 *   rule probe that may change a channel's name or topic.
 * - Every kick or ban row is one the docs model predicts to fail (`kickBanMustFail`, L1): the subject is not
 *   granted the flag (nor any administrator source), or the target does not rank below it. The Lab guard
 *   checks the same rule again from harness-side reads just before the call (§5.6).
 */
import type { PermissionFlag } from "../../src/errors/Missing.generated.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import { resolve } from "../../src/permissions/Resolver.ts"
import * as LabIds from "../LabIds.ts"
import * as Materialize from "../Materialize.ts"
import * as Predict from "../Predict.ts"
import type { Scenario } from "./Dsl.ts"
import { kickBanMustFail } from "./Pairwise.ts"
import { probes } from "./Probes.ts"

/** One violation. */
export interface Violation {
  readonly scenario: string
  readonly rule: string
  readonly detail: string
}

/** The flags that would let the subject ping everyone. */
const pingFlags: ReadonlyArray<PermissionFlag> = ["MentionEveryone", "Administrator"]

const mentionsEveryone = (scenario: Scenario): boolean => scenario.operation._tag === "send" && scenario.operation.payload === "mention-everyone"

/** The checks that need only the symbolic scenario. */
export const checkScenario = (scenario: Scenario): ReadonlyArray<Violation> => {
  const out: Array<Violation> = []
  const add = (rule: string, detail: string) => out.push({ scenario: scenario.id, rule, detail })
  if (mentionsEveryone(scenario)) {
    for (const grant of scenario.setup.grants) {
      if (grant.via === "administrator") add("no-everyone-ping", "an @everyone payload with an administrator grant")
      for (const flag of grant.flags) if (pingFlags.includes(flag)) add("no-everyone-ping", `an @everyone payload granting ${flag}`)
    }
  }
  if (scenario.operation._tag === "send" && scenario.operation.payload === "reply" && !scenario.setup.fixtures.some((fixture) => fixture === "harness-message" || fixture === "subject-message")) {
    add("reply-to-bots", "a reply without a bot message to reply to")
  }
  const operation = scenario.operation
  if (operation._tag === "rule") {
    // a probe mentions only the target bot and lab roles (which the runner checks Rhys does not hold)
    for (const role of probes[operation.probe].mentions.roles) {
      if (role !== "lab-mentionable" && role !== "lab-unmentionable") add("mention-lab-roles", `a probe mentions ${role}`)
    }
  }
  if (operation._tag === "member" && (operation.action === "kick" || operation.action === "ban")) {
    const flag = operation.action === "kick" ? "KickMembers" : "BanMembers"
    const granted = scenario.setup.grants.some((grant) => grant.via === "administrator" || grant.flags.includes(flag) || grant.flags.includes("Administrator"))
    if (!kickBanMustFail({ missing: granted ? "none" : "op-flag", targetRank: scenario.setup.targetRank ?? "below" })) {
      add("kick-ban-must-fail", `a ${operation.action} with ${flag} granted and the target below the subject could succeed`)
    }
  }
  return out
}

/** A fixed instant for the predictions: only a timeout's being in the future matters. */
const predictedAt = Date.parse("2026-11-01T12:00:00Z")

/**
 * The lab channels whose name or topic a scenario may change (H-162 counts both): its own channel, or a probe's.
 * A name or topic edit preflight predicts to fail changes nothing (M6: `rename-voice-without-connect` lacks
 * Connect, and Discord refuses it with 50001; the replay holds the prediction to that live answer), so it is not
 * counted.
 */
const renamed = (scenario: Scenario): ReadonlyArray<string> => {
  const operation = scenario.operation
  if (operation._tag === "rule") return probes[operation.probe].renames
  if (scenario.setup.channelSettings?.nameVariant === "b") return [Materialize.labNameOf(scenario.setup)]
  if (operation._tag !== "channelEdit" || operation.field === "slowmode") return []
  const refused = Predict.predict(scenario, Predict.symbolicIds, predictedAt).records.decision.failures.length > 0
  return refused ? [] : [Materialize.labNameOf(scenario.setup)]
}

/** The checks over the whole catalog: every scenario's, unique IDs, and at most one renamed setup per channel. */
export const checkCatalog = (scenarios: ReadonlyArray<Scenario>): ReadonlyArray<Violation> => {
  const out: Array<Violation> = scenarios.flatMap(checkScenario)
  const seen = new Set<string>()
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) out.push({ scenario: scenario.id, rule: "unique-ids", detail: "duplicate scenario ID" })
    seen.add(scenario.id)
  }
  const edits = new Map<string, Array<string>>()
  for (const scenario of scenarios) {
    for (const channel of renamed(scenario)) edits.set(channel, [...(edits.get(channel) ?? []), scenario.id])
  }
  for (const [channel, ids] of edits) {
    if (ids.length > 1) out.push({ scenario: channel, rule: "one-rename-per-channel", detail: `${ids.length} name or topic edits of ${channel} in one run: ${ids.join(", ")} (H-162)` })
  }
  return out
}

/** The flags the target posts fixtures with; its `lab-target` overwrite allows them on every lab channel (§5.7). */
export const targetFixtureFlags: ReadonlyArray<PermissionFlag> = Flags.toSortedNames(Flags.fromBits(LabIds.targetOverwriteAllow))

/**
 * The checks over a scenario's materialized desired state (`now` places a desired timeout in the future). A
 * scenario in a channel the lab does not have sends nothing, so it has nothing to check.
 */
export const checkMaterialized = (scenario: Scenario, state: Materialize.Desired, ids: Materialize.Ids, now: number): ReadonlyArray<Violation> => {
  // a channel the guild does not have: the row records kind-not-available and sends nothing
  if (ids.unavailable.has(state.channel) || ids.unavailable.has(state.overwriteChannel)) return []
  const out: Array<Violation> = []
  const add = (rule: string, detail: string) => out.push({ scenario: scenario.id, rule, detail })
  if (mentionsEveryone(scenario)) {
    const pings = Flags.fromFlags(pingFlags)
    if ((state.everyone & pings) !== 0n) add("no-everyone-ping", "@everyone holds MentionEveryone or Administrator")
    for (const role of state.subjectRoles) {
      if ((Materialize.rolePermissionsOf(state, role) & pings) !== 0n) add("no-everyone-ping", `the subject holds ${role}, which has MentionEveryone or Administrator`)
    }
    const subjectTargets = new Set<string>([ids.guildId, ids.subjectUserId, ...state.subjectRoles.map((role) => Materialize.roleIdOf(ids, role))])
    for (const [channel, overwrites] of state.overwrites) {
      for (const overwrite of overwrites) {
        if (subjectTargets.has(overwrite.id) && (overwrite.allow & pings) !== 0n) add("no-everyone-ping", `an overwrite on ${channel} allows MentionEveryone to the subject`)
      }
    }
  }
  // threads use their parent's overwrites (H-030), so the overwrite channel decides; a thread the subject
  // creates during the scenario has no ID yet
  const resolution = resolve({
    guild: Materialize.guildOf(state, ids),
    channel: Materialize.channelInputOf(state, ids, state.overwriteChannel, "target"),
    member: Materialize.memberOf(state, ids, "target", new Date(now).toISOString()),
    now
  })
  const lost = targetFixtureFlags.filter((flag) => !Flags.has(resolution.afterOverwrites, flag))
  if (lost.length > 0) add("target-unaffected", `the target loses ${lost.join(", ")} in ${state.overwriteChannel}`)
  return out
}
