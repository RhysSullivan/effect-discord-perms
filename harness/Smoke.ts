/**
 * The smoke command's reads (DESIGN §6 M2): one oracle read per lab channel and thread plus a positive
 * control, the judgment that fails smoke when an available oracle disagrees with the baseline, and a read-only
 * inventory of the lab guild for inspection by hand.
 */
import { BunFileSystem } from "@effect/platform-bun"
import { PermissionFlagsBits } from "discord-api-types/v10"
import { Effect, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as Oracle from "../src/rest/Oracle.ts"
import { HarnessRest } from "./Identities.ts"
import { requestDeadline } from "./IdentityCheck.ts"
import { LabCheckFailed, type LabRequestFailed, labStep } from "./Lab.ts"
import * as LabIds from "./LabIds.ts"
import type * as Reset from "./Reset.ts"
import * as Wire from "./Wire.ts"

/** The names of the permission flags set in `bits`, in discord-api-types order. */
export const flagNames = (bits: bigint): ReadonlyArray<string> =>
  Object.entries(PermissionFlagsBits)
    .filter(([, bit]) => (bits & bit) !== 0n)
    .map(([name]) => name)

/** One oracle read: the subject's permissions in a lab channel, or `undefined` when the route is unavailable. */
export interface OracleReadout {
  readonly channel: string
  readonly permissions: bigint | undefined
}

/** The oracle's availability over a set of reads. */
export type Availability = "available" | "unavailable" | "mixed"

/**
 * A positive control: the target's permissions in `lab-text`, which come only from `lab-target`'s overwrite
 * allow (`@everyone` and every lab role grant nothing at baseline). If the oracle computes what the docs
 * describe (H-240), it returns exactly that allow.
 */
export interface Control {
  readonly permissions: bigint | undefined
  readonly expected: bigint
}

/** Smoke's oracle reads: one per lab channel and thread, and the control. */
export interface OracleResult {
  /** Over the subject's reads and the control together. */
  readonly availability: Availability
  readonly reads: ReadonlyArray<OracleReadout>
  readonly control: Control
}

/** The availability of a set of reads: all answered, none answered, or some of each. */
export const availabilityOf = (answers: ReadonlyArray<bigint | undefined>): Availability => {
  const unavailable = answers.filter((answer) => answer === undefined).length
  return unavailable === 0 ? "available" : unavailable === answers.length ? "unavailable" : "mixed"
}

/**
 * What is wrong with smoke's oracle result, if anything (§5.10, H-240). An unavailable oracle is a recorded
 * outcome, not a problem. An available one must answer every read, return exactly `lab-target`'s allow for
 * the control, and give the subject no permission anywhere at baseline (an empty `@everyone` and no roles).
 */
export const oracleProblems = (result: OracleResult): ReadonlyArray<string> => {
  switch (result.availability) {
    case "unavailable":
      return []
    case "mixed":
      return [
        `the oracle answered some reads and not others: unavailable in ${[
          ...result.reads.filter((read) => read.permissions === undefined).map((read) => read.channel),
          ...(result.control.permissions === undefined ? ["the control"] : [])
        ].join(", ")}`
      ]
    case "available": {
      const control = result.control.permissions
      return [
        ...(control !== undefined && control !== result.control.expected
          ? [`the control (the target in lab-text) is ${flagNames(control).join(", ") || "no flags"}, not lab-target's allow (${flagNames(result.control.expected).join(", ")})`]
          : []),
        ...result.reads.flatMap((read) =>
          read.permissions !== undefined && read.permissions !== 0n ? [`the subject has ${flagNames(read.permissions).join(", ")} in ${read.channel} at baseline`] : []
        )
      ]
    }
  }
}

/** Fails with `LabCheckFailed` when {@link oracleProblems} finds anything. */
export const checkOracle = (result: OracleResult): Effect.Effect<void, LabCheckFailed> => {
  const problems = oracleProblems(result)
  return problems.length === 0 ? Effect.void : Effect.fail(new LabCheckFailed({ check: "oracle", detail: problems.join("; ") }))
}

/**
 * Reads the subject's permissions in every provisioned lab channel and thread through the oracle
 * (`implicit=false`), and the control, as the harness. Reads only; {@link checkOracle} judges the result.
 */
export const oracleReads = (context: Reset.Context): Effect.Effect<OracleResult, Oracle.OracleFailed | LabCheckFailed | PlatformError, HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const state = yield* LabIds.load(context.guildId).pipe(Effect.provide(BunFileSystem.layer))
    const names = [...LabIds.channelSpecs.filter((spec) => spec.type !== 4).map((spec) => spec.name), ...LabIds.threadSpecs.map((spec) => spec.name)]
    const permissionsOf = (read: Oracle.OracleRead): bigint | undefined => (read._tag === "Permissions" ? read.permissions : undefined)
    const reads: Array<OracleReadout> = []
    for (const name of names) {
      const id = state.channels[name]
      if (id === undefined) continue
      reads.push({ channel: name, permissions: permissionsOf(yield* Oracle.memberPermissions(rest, id, context.subjectUserId, requestDeadline)) })
    }
    const text = state.channels["lab-text"]
    if (text === undefined) return yield* new LabCheckFailed({ check: "oracle control", detail: "lab-text is not provisioned" })
    const control: Control = {
      permissions: permissionsOf(yield* Oracle.memberPermissions(rest, text, context.targetUserId, requestDeadline)),
      expected: LabIds.targetOverwriteAllow
    }
    return { availability: availabilityOf([...reads.map((read) => read.permissions), control.permissions]), reads, control }
  })

const typeNames: Readonly<Record<number, string>> = { 0: "text", 2: "voice", 4: "category", 5: "announcement", 13: "stage", 15: "forum", 16: "media" }

/** Prints the lab guild's channels, roles and the stored lab IDs. Reads only. */
export const inventory = (
  context: Reset.Context,
  names: (bits: bigint) => ReadonlyArray<string>
): Effect.Effect<void, LabRequestFailed | LabCheckFailed | PlatformError, HarnessRest> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const channels = yield* rest.listGuildChannels(context.guildId).pipe(labStep("inventory: channels"), Effect.flatMap(Wire.decode(Schema.Array(Wire.Channel), "listGuildChannels")))
    const roles = yield* rest.listGuildRoles(context.guildId).pipe(labStep("inventory: roles"), Effect.flatMap(Wire.decode(Schema.Array(Wire.Role), "listGuildRoles")))
    const active = yield* rest.getActiveGuildThreads(context.guildId).pipe(labStep("inventory: threads"), Effect.flatMap(Wire.decode(Wire.ThreadPage, "getActiveGuildThreads")))
    const state = yield* LabIds.load(context.guildId).pipe(Effect.provide(BunFileSystem.layer))
    console.log(`channels (${channels.length}):`)
    for (const channel of [...channels].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      console.log(`  ${channel.name} [${typeNames[channel.type] ?? channel.type}] ${channel.id} parent ${channel.parent_id ?? "-"} overwrites ${channel.permission_overwrites?.length ?? 0}`)
    }
    console.log(`active threads (${active.threads.length}):`)
    for (const thread of active.threads) console.log(`  ${thread.name} ${thread.id} parent ${thread.parent_id ?? "-"}`)
    console.log(`roles (${roles.length}), top to bottom:`)
    for (const role of [...roles].sort((a, b) => b.position - a.position)) {
      const bot = role.tags?.bot_id
      const who = bot === context.harnessUserId ? " (harness)" : bot === context.subjectUserId ? " (subject)" : bot === context.targetUserId ? " (target)" : ""
      const flags = names(BigInt(role.permissions))
      console.log(`  ${role.position} ${role.name}${role.managed ? ` managed${who}` : ""} ${role.id} perms ${flags.length === 0 ? "none" : flags.join(",")}${role.mentionable ? " mentionable" : ""}`)
    }
    console.log(`stored lab state: ${Object.keys(state.channels).length} channels and threads, ${Object.keys(state.roles).length} roles, sticker ${state.sticker ?? "none"}`)
  })
