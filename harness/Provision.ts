/**
 * Provisioning (DESIGN §5.7): creates the lab objects that do not exist yet, idempotently by stored ID.
 *
 * - Roles (created first, because every channel's baseline overwrite names `lab-target`), then the `lab`
 *   category, the seven channels under it, and the four threads; each new ID is admitted to the guard and
 *   persisted in `.lab-state.json` before anything else is created.
 * - Role positions are set once: the lab roles form one block at the bottom of the hierarchy, top to bottom
 *   `lab-high`, `lab-mid`, `lab-low`, the subject's managed role, the target's managed role, `lab-grant`,
 *   ..., `lab-unmentionable` (H-073). They are written only when the observed order differs, and read back.
 * - A guild sticker and a guild emoji (`lab_emoji`, for reactions with a guild emoji).
 *
 * If provisioning wrote anything, it ends with a full reset, which brings the new objects to the same
 * baseline (the target's roles, thread memberships, the system messages thread creation posts), so a reset
 * right after provisioning makes zero writes.
 */
import { BunFileSystem } from "@effect/platform-bun"
import type { CreateThreadRequest } from "dfx/DiscordREST/Generated"
import { Effect, Option, Ref, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { deflateSync } from "node:zlib"
import type { SubjectRaw } from "../src/bot/Internals.ts"
import type { GuildId, UserId } from "../src/Snowflake.ts"
import { HarnessRest } from "./Identities.ts"
import { LabCheckFailed, LabGuard, LabRequestFailed, labStep, labStepUnless } from "./Lab.ts"
import * as LabIds from "./LabIds.ts"
import { Pacing } from "./Pacing.ts"
import * as Reset from "./Reset.ts"
import * as Wire from "./Wire.ts"

/** What provisioning did. */
export interface Result {
  /** The lab objects created in this run, by name. */
  readonly created: ReadonlyArray<string>
  /** Writes counted at the base client, including the closing reset when there was one. */
  readonly writes: number
  readonly writesByRoute: ReadonlyArray<readonly [route: string, count: number]>
  /** The lab block's role positions after provisioning, top to bottom. */
  readonly positions: ReadonlyArray<{ readonly name: string; readonly position: number }>
  readonly notes: ReadonlyArray<string>
}

/** A one-line summary. */
export const summary = (result: Result): string =>
  [
    `created ${result.created.length}${result.created.length > 0 ? ` (${result.created.join(", ")})` : ""}`,
    `writes ${result.writes}`,
    ...result.writesByRoute.map(([route, count]) => `${route} x${count}`),
    `positions ${result.positions.map((entry) => `${entry.name}=${entry.position}`).join(" ")}`,
    ...result.notes.map((note) => `note: ${note}`)
  ].join("; ")

// ---- the sticker image --------------------------------------------------------------------------------

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** A `size` x `size` single-colour RGB PNG: Discord stickers must be 320 x 320 PNG (or APNG, GIF, Lottie). */
export const solidPng = (size: number, rgb: readonly [number, number, number]): Uint8Array => {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, size)
  view.setUint32(4, size)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit depth, truecolour, deflate, no filter method, no interlace
  const rows = new Uint8Array(size * (1 + size * 3))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3)
    rows[row] = 0 // filter type None
    for (let x = 0; x < size; x++) rows.set(rgb, row + 1 + x * 3)
  }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    png.set(part, offset)
    offset += part.length
  }
  return png
}

// ---- provisioning -------------------------------------------------------------------------------------

/** The role order of the lab block, top to bottom, as role IDs (managed roles where the bots have one). */
export const desiredRoleOrder = (
  roles: Readonly<Record<string, string>>,
  managed: { readonly subject: string | undefined; readonly target: string | undefined }
): ReadonlyArray<string> =>
  LabIds.roleSpecs.flatMap((spec) => {
    const id = roles[spec.name]
    const own = id === undefined ? [] : [id]
    if (spec.name !== LabIds.managedRolesBelow) return own
    return [...own, ...(managed.subject === undefined ? [] : [managed.subject]), ...(managed.target === undefined ? [] : [managed.target])]
  })

/** Roles sorted top to bottom (highest position first; equal positions by ID). */
export const byRank = (roles: ReadonlyArray<Wire.Role>): ReadonlyArray<Wire.Role> =>
  [...roles].sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/**
 * Whether the lab block holds by **position** alone: the `desired` roles have distinct, strictly decreasing
 * positions, and every other role except `@everyone` is strictly above the block. Equal positions do not
 * count, even where the ID tie-break happens to give the right order: Discord gives every role created through
 * the API position 1 without renumbering the others (seen live in M2), so ties are the default, not a choice.
 */
export const orderHolds = (roles: ReadonlyArray<Wire.Role>, guildId: string, desired: ReadonlyArray<string>): boolean => {
  const positions = desired.map((id) => roles.find((role) => role.id === id)?.position)
  if (positions.some((position) => position === undefined)) return false
  const defined = positions.filter((position): position is number => position !== undefined)
  const decreasing = defined.every((position, index) => index === 0 || position < (defined[index - 1] ?? Number.NEGATIVE_INFINITY))
  const top = defined[0] ?? Number.POSITIVE_INFINITY
  const others = roles.filter((role) => role.id !== guildId && !desired.includes(role.id))
  return decreasing && others.every((role) => role.position > top)
}

/** "Cannot execute action on this channel type": the guild cannot have a channel of this kind (GuildMedia, M2). */
export const kindNotAvailableCode = 50024

/**
 * Whether a failed channel create means "this guild does not offer the kind", which provisioning records as
 * unavailable instead of failing. Only for the kinds a guild may lack (`LabIds.optionalChannelTypes`): a 50024
 * on any other kind is a real failure.
 */
export const kindNotAvailable = (type: number, failure: { readonly status: number; readonly code: number }): boolean =>
  LabIds.optionalChannelTypes.has(type) && failure.status === 400 && failure.code === kindNotAvailableCode

interface Provisioning {
  readonly context: Reset.Context
  /** The persisted IDs so far; written to `.lab-state.json` after every creation. */
  readonly state: Ref.Ref<LabIds.LabState>
  /** The names created in this run. */
  readonly created: Ref.Ref<ReadonlyArray<string>>
  /** What provisioning noticed (a kind Discord refused, a bot without a managed role). */
  readonly notes: Ref.Ref<ReadonlyArray<string>>
}

/** Persists a change to the state file first, then records `created` (a name) or `note` in the run. */
const record = (run: Provisioning, entry: { readonly created: string } | { readonly note: string }, update: (state: LabIds.LabState) => LabIds.LabState) =>
  Effect.gen(function* () {
    const next = update(yield* Ref.get(run.state))
    yield* LabIds.save(next).pipe(Effect.provide(BunFileSystem.layer))
    yield* Ref.set(run.state, next)
    if ("created" in entry) yield* Ref.update(run.created, (created) => [...created, entry.created])
    else yield* Ref.update(run.notes, (notes) => [...notes, entry.note])
  })

const ensureRoles = (run: Provisioning, view: Reset.View) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const guard = yield* LabGuard
    for (const spec of LabIds.roleSpecs) {
      const id = (yield* Ref.get(run.state)).roles[spec.name]
      if (id !== undefined && view.roles.some((role) => role.id === id)) continue
      const role = yield* rest
        .createGuildRole(run.context.guildId, { name: spec.name, permissions: Number(spec.permissions), mentionable: spec.mentionable, hoist: false })
        .pipe(labStep(`provision: create role ${spec.name}`), Effect.flatMap(Wire.decode(Wire.Role, "createGuildRole")))
      yield* guard.admitRole({ id: role.id, name: role.name, botId: undefined })
      yield* record(run, { created: spec.name }, (state) => ({ ...state, roles: { ...state.roles, [spec.name]: role.id } }))
    }
  })

const ensureChannels = (run: Provisioning, view: Reset.View) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const guard = yield* LabGuard
    const labTarget = (yield* Ref.get(run.state)).roles["lab-target"]
    if (labTarget === undefined) return yield* new LabCheckFailed({ check: "provision", detail: "lab-target was not created" })
    const overwrites = Reset.baselineOverwrites(labTarget).map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.toString(),
      deny: overwrite.deny.toString()
    }))
    for (const spec of LabIds.channelSpecs) {
      const state = yield* Ref.get(run.state)
      const id = state.channels[spec.name]
      if (id !== undefined && view.channels.some((channel) => channel.id === id && channel.type === spec.type)) continue
      if (state.unavailable?.[spec.name] !== undefined) continue
      const category = state.channels["lab"]
      const body = {
        name: spec.name,
        type: spec.type,
        permission_overwrites: overwrites,
        ...(spec.type === 4 || category === undefined ? {} : { parent_id: category }),
        ...(spec.type === 15 || spec.type === 16 ? { available_tags: LabIds.baselineTags } : {})
      }
      const step = `provision: create channel ${spec.name}`
      const response = yield* Wire.raw(rest, step, "POST", `/guilds/${run.context.guildId}/channels`, { body })
      const refused = yield* Wire.ensureOk(step, response).pipe(
        Effect.as(Option.none<LabRequestFailed>()),
        Effect.catchIf((error) => kindNotAvailable(spec.type, error), (error) => Effect.succeedSome(error))
      )
      if (Option.isSome(refused)) {
        const failure = refused.value
        yield* record(run, { note: `${spec.name} not created: Discord answered ${failure.status} ${failure.code} (${failure.message}); recorded as unavailable` }, (current) => ({
          ...current,
          unavailable: { ...current.unavailable, [spec.name]: { status: failure.status, code: failure.code } }
        }))
        continue
      }
      const json = yield* Wire.ensureOk(step, response)
      const channel = yield* Wire.decode(Wire.Channel, "createGuildChannel")(Option.getOrUndefined(json))
      yield* guard.admitChannel(channel)
      yield* record(run, { created: spec.name }, (current) => ({ ...current, channels: { ...current.channels, [spec.name]: channel.id } }))
    }
  })

const ensureThreads = (run: Provisioning, view: Reset.View) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const guard = yield* LabGuard
    for (const spec of LabIds.threadSpecs) {
      const state = yield* Ref.get(run.state)
      const id = state.channels[spec.name]
      if (id !== undefined && view.threads.some((thread) => thread.id === id)) continue
      const parent = state.channels[spec.parent]
      if (parent === undefined) return yield* new LabCheckFailed({ check: "provision", detail: `${spec.parent} was not created` })
      const request: CreateThreadRequest =
        spec.name === "lab-forum-post"
          ? { name: spec.name, auto_archive_duration: LabIds.threadAutoArchiveMinutes, message: { content: "Perms Lab forum post" } }
          : { name: spec.name, type: spec.type, auto_archive_duration: LabIds.threadAutoArchiveMinutes }
      const thread = yield* rest
        .createThread(parent, request)
        .pipe(labStep(`provision: create thread ${spec.name}`), Effect.flatMap(Wire.decode(Wire.Channel, "createThread")))
      yield* guard.admitChannel(thread)
      yield* record(run, { created: spec.name }, (current) => ({ ...current, channels: { ...current.channels, [spec.name]: thread.id } }))
    }
  })

const ensurePositions = (run: Provisioning) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const guildId: GuildId = run.context.guildId
    const listRoles = rest.listGuildRoles(guildId).pipe(labStep("provision: list roles"), Effect.flatMap(Wire.decode(Schema.Array(Wire.Role), "listGuildRoles")))
    const roles = yield* listRoles
    const managedOf = (user: UserId) => roles.find((role) => role.tags?.bot_id === user)?.id
    const managed = { subject: managedOf(run.context.subjectUserId), target: managedOf(run.context.targetUserId) }
    const notes = [
      ...(managed.subject === undefined ? ["the subject has no managed role"] : []),
      ...(managed.target === undefined ? ["the target has no managed role"] : [])
    ]
    const desired = desiredRoleOrder((yield* Ref.get(run.state)).roles, managed)
    if (!orderHolds(roles, guildId, desired)) {
      const harnessRole = roles.find((role) => role.tags?.bot_id === run.context.harnessUserId)
      if (harnessRole !== undefined) yield* (yield* LabGuard).admitHarnessRoleForPositions({ id: harnessRole.id, botId: harnessRole.tags?.bot_id })
      yield* rest
        .bulkUpdateGuildRoles(guildId, [...(harnessRole === undefined ? [] : [{ id: harnessRole.id, position: desired.length + 1 }]), ...desired.map((id, index) => ({ id, position: desired.length - index }))])
        .pipe(labStep("provision: set lab role positions"))
      const after = yield* listRoles
      if (!orderHolds(after, guildId, desired)) {
        return yield* new LabCheckFailed({
          check: "role positions",
          detail: `after setting positions the bottom of the hierarchy is ${byRank(after).map((role) => `${role.name}=${role.position}`).join(", ")}`
        })
      }
      return { roles: after, notes }
    }
    return { roles, notes }
  })

const ensureSticker = (run: Provisioning) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const id = (yield* Ref.get(run.state)).sticker
    if (id !== undefined) {
      const found = yield* rest.getGuildSticker(run.context.guildId, id).pipe(labStepUnless("provision: get sticker", [10060]))
      if (found._tag === "Some") return
    }
    const file = new File([solidPng(320, [88, 101, 242])], "lab-sticker.png", { type: "image/png" })
    const sticker = yield* rest
      .createGuildSticker(run.context.guildId, { ...LabIds.stickerSpec, file })
      .pipe(labStep("provision: create sticker"), Effect.flatMap(Wire.decode(Wire.Sticker, "createGuildSticker")))
    yield* record(run, { created: LabIds.stickerSpec.name }, (state) => ({ ...state, sticker: sticker.id }))
  })

/** The lab's guild emoji: a 128 x 128 PNG, sent as a data URI (createGuildEmoji takes JSON). Unknown Emoji is 10014. */
const ensureEmoji = (run: Provisioning) =>
  Effect.gen(function* () {
    const rest = yield* HarnessRest
    const id = (yield* Ref.get(run.state)).emoji
    if (id !== undefined) {
      const found = yield* rest.getGuildEmoji(run.context.guildId, id).pipe(labStepUnless("provision: get emoji", [10014]))
      if (found._tag === "Some") return
    }
    const image = `data:image/png;base64,${Buffer.from(solidPng(128, [237, 66, 69])).toString("base64")}`
    const emoji = yield* rest
      .createGuildEmoji(run.context.guildId, { name: LabIds.emojiSpec.name, image, roles: [] })
      .pipe(labStep("provision: create emoji"), Effect.flatMap(Wire.decode(Wire.Emoji, "createGuildEmoji")))
    yield* record(run, { created: LabIds.emojiSpec.name }, (state) => ({ ...state, emoji: emoji.id }))
  })

/** Creates what is missing, sets role positions, ensures the sticker and the emoji, then resets if anything was written. */
export const run = (context: Reset.Context): Effect.Effect<Result, LabRequestFailed | LabCheckFailed | PlatformError, HarnessRest | SubjectRaw | LabGuard | Pacing> =>
  Effect.gen(function* () {
    const pacing = yield* Pacing
    const before = yield* pacing.stats
    const view = yield* Reset.read(context)
    const provisioning: Provisioning = {
      context,
      state: yield* Ref.make(view.state),
      created: yield* Ref.make<ReadonlyArray<string>>([]),
      notes: yield* Ref.make<ReadonlyArray<string>>([])
    }
    yield* ensureRoles(provisioning, view)
    yield* ensureChannels(provisioning, view)
    yield* ensureThreads(provisioning, view)
    const positions = yield* ensurePositions(provisioning)
    yield* ensureSticker(provisioning)
    yield* ensureEmoji(provisioning)
    const written = Reset.writesBetween(before, yield* pacing.stats)
    const notes: Array<string> = [...(yield* Ref.get(provisioning.notes)), ...positions.notes]
    if (written.writes > 0) notes.push(...(yield* Reset.run(context)).notes)
    const after = Reset.writesBetween(before, yield* pacing.stats)
    const desired = desiredRoleOrder((yield* Ref.get(provisioning.state)).roles, {
      subject: positions.roles.find((role) => role.tags?.bot_id === context.subjectUserId)?.id,
      target: positions.roles.find((role) => role.tags?.bot_id === context.targetUserId)?.id
    })
    return {
      created: yield* Ref.get(provisioning.created),
      ...after,
      positions: desired.flatMap((id) => {
        const role = positions.roles.find((candidate) => candidate.id === id)
        return role === undefined ? [] : [{ name: role.name, position: role.position }]
      }),
      notes
    }
  })
