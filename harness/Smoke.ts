/**
 * The smoke command's reads (DESIGN §6 M2): one oracle read per lab channel and thread, and a read-only
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

/** One oracle read: the subject's flags in a lab channel, or `undefined` when the route is unavailable. */
export interface OracleReadout {
  readonly channel: string
  readonly flags: ReadonlyArray<string> | undefined
}

/** The oracle's availability over a set of reads. */
export type Availability = "available" | "unavailable" | "mixed"

/**
 * A positive control: the target's permissions in `lab-text`, which come only from `lab-target`'s overwrite
 * allow (`@everyone` and every lab role grant nothing at baseline). If the oracle computes what the docs
 * describe (H-240), it returns exactly that allow.
 */
export interface Control {
  readonly flags: ReadonlyArray<string> | undefined
  readonly expected: ReadonlyArray<string>
}

/**
 * Reads the subject's permissions in every provisioned lab channel and thread through the oracle
 * (`implicit=false`), as the harness. Reads only.
 */
export const oracleReads = (
  context: Reset.Context
): Effect.Effect<
  { readonly availability: Availability; readonly reads: ReadonlyArray<OracleReadout>; readonly control: Control },
  Oracle.OracleFailed | LabCheckFailed | PlatformError,
  HarnessRest
> =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const state = yield* LabIds.load(context.guildId).pipe(Effect.provide(BunFileSystem.layer))
    const names = [...LabIds.channelSpecs.filter((spec) => spec.type !== 4).map((spec) => spec.name), ...LabIds.threadSpecs.map((spec) => spec.name)]
    const reads: Array<OracleReadout> = []
    for (const name of names) {
      const id = state.channels[name]
      if (id === undefined) continue
      const read = yield* Oracle.memberPermissions(rest, id, context.subjectUserId, requestDeadline)
      reads.push({ channel: name, flags: read._tag === "Permissions" ? flagNames(read.permissions) : undefined })
    }
    const unavailable = reads.filter((read) => read.flags === undefined).length
    const availability: Availability = unavailable === 0 ? "available" : unavailable === reads.length ? "unavailable" : "mixed"
    const text = state.channels["lab-text"]
    const expected = flagNames(LabIds.targetOverwriteAllow)
    if (text === undefined) return yield* new LabCheckFailed({ check: "oracle control", detail: "lab-text is not provisioned" })
    const read = yield* Oracle.memberPermissions(rest, text, context.targetUserId, requestDeadline)
    return { availability, reads, control: { flags: read._tag === "Permissions" ? flagNames(read.permissions) : undefined, expected } }
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
