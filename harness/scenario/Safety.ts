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
 * - At most one renamed setup (`nameVariant: "b"`) per lab channel per run (H-162).
 * - Kick and ban rows must satisfy `kickBanMustFail`; the members family brings them (M4), and this module's
 *   check for them arrives with it.
 */
import type { PermissionFlag } from "../../src/errors/Missing.generated.ts"
import * as Flags from "../../src/permissions/Flags.ts"
import { resolve } from "../../src/permissions/Resolver.ts"
import * as LabIds from "../LabIds.ts"
import * as Materialize from "../Materialize.ts"
import type { Scenario } from "./Dsl.ts"

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
  if (scenario.operation._tag === "send" && scenario.operation.payload === "reply" && !scenario.setup.fixtures.some((fixture) => fixture === "harness-message" || fixture === "subject-message" || fixture === "target-message")) {
    add("reply-to-bots", "a reply without a bot message to reply to")
  }
  return out
}

/** The checks over the whole catalog: every scenario's, unique IDs, and at most one renamed setup per channel. */
export const checkCatalog = (scenarios: ReadonlyArray<Scenario>): ReadonlyArray<Violation> => {
  const out: Array<Violation> = scenarios.flatMap(checkScenario)
  const seen = new Set<string>()
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) out.push({ scenario: scenario.id, rule: "unique-ids", detail: "duplicate scenario ID" })
    seen.add(scenario.id)
  }
  const renamed = new Map<string, Set<string>>()
  for (const scenario of scenarios) {
    if (scenario.setup.channelSettings?.nameVariant !== "b") continue
    const setups = renamed.get(scenario.setup.channel) ?? new Set()
    setups.add(JSON.stringify(scenario.setup))
    renamed.set(scenario.setup.channel, setups)
  }
  for (const [channel, setups] of renamed) {
    if (setups.size > 1) out.push({ scenario: channel, rule: "one-rename-per-channel", detail: `${setups.size} renamed setups for ${channel} (H-162)` })
  }
  return out
}

/** The flags the target posts fixtures with; its `lab-target` overwrite allows them on every lab channel (§5.7). */
export const targetFixtureFlags: ReadonlyArray<PermissionFlag> = Flags.toSortedNames(Flags.fromBits(LabIds.targetOverwriteAllow))

/** The checks over a scenario's materialized desired state (`now` places a desired timeout in the future). */
export const checkMaterialized = (scenario: Scenario, state: Materialize.Desired, ids: Materialize.Ids, now: number): ReadonlyArray<Violation> => {
  const out: Array<Violation> = []
  const add = (rule: string, detail: string) => out.push({ scenario: scenario.id, rule, detail })
  if (mentionsEveryone(scenario)) {
    const pings = Flags.fromFlags(pingFlags)
    if ((state.everyone & pings) !== 0n) add("no-everyone-ping", "@everyone holds MentionEveryone or Administrator")
    for (const role of state.subjectRoles) {
      if (((state.rolePermissions.get(role) ?? 0n) & pings) !== 0n) add("no-everyone-ping", `the subject holds ${role}, which has MentionEveryone or Administrator`)
    }
    const subjectTargets = new Set<string>([ids.guildId, ids.subjectUserId, ...state.subjectRoles.map((role) => ids.roles.get(role) ?? "")])
    for (const [channel, overwrites] of state.overwrites) {
      for (const overwrite of overwrites) {
        if (subjectTargets.has(overwrite.id) && (overwrite.allow & pings) !== 0n) add("no-everyone-ping", `an overwrite on ${channel} allows MentionEveryone to the subject`)
      }
    }
  }
  const resolution = resolve({
    guild: Materialize.guildOf(state, ids),
    channel: Materialize.channelInputOf(state, ids, state.channel, "target"),
    member: Materialize.memberOf(state, ids, "target", new Date(now).toISOString()),
    now
  })
  const lost = targetFixtureFlags.filter((flag) => !Flags.has(resolution.afterOverwrites, flag))
  if (lost.length > 0) add("target-unaffected", `the target loses ${lost.join(", ")} in ${state.channel}`)
  return out
}
