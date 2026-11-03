/**
 * The lab's specification and its persisted object IDs (DESIGN §5.7).
 *
 * The spec (names, kinds, baseline settings) is what Provision creates and what Reset restores. The IDs of the
 * objects Provision created are persisted in `.lab-state.json` (git-ignored) after each creation, so objects
 * are tracked by ID across runs: a rename never orphans or duplicates them, and a crash during provisioning
 * leaves no untracked object behind.
 */
import { PermissionFlagsBits } from "discord-api-types/v10"
import { Effect, FileSystem, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChannelId, EmojiId, GuildId, RoleId, StickerId } from "../src/Snowflake.ts"
import { LabCheckFailed } from "./Lab.ts"

// ---- spec ---------------------------------------------------------------------------------------------

/** The lab's channels (the category first). Each is created under the `lab` category. */
export const channelSpecs = [
  { name: "lab", type: 4 },
  { name: "lab-text", type: 0 },
  { name: "lab-announcement", type: 5 },
  { name: "lab-voice", type: 2 },
  { name: "lab-stage", type: 13 },
  { name: "lab-forum", type: 15 },
  { name: "lab-media", type: 16 },
  { name: "lab-bots-only", type: 0 }
] as const satisfies ReadonlyArray<{ readonly name: string; readonly type: number }>

/**
 * Channel kinds a guild may not offer. Creating one there answers 400 50024; provisioning records the channel
 * as unavailable instead of failing (GuildMedia in Perms Lab, M2). Every other kind must be created.
 */
export const optionalChannelTypes: ReadonlySet<number> = new Set([16])

/** A lab channel name. */
export type ChannelName = (typeof channelSpecs)[number]["name"]

/** The lab's threads: two in `lab-text`, one announcement thread, one forum post. */
export const threadSpecs = [
  { name: "lab-public-thread", parent: "lab-text", type: 11 },
  { name: "lab-private-thread", parent: "lab-text", type: 12 },
  { name: "lab-announcement-thread", parent: "lab-announcement", type: 10 },
  { name: "lab-forum-post", parent: "lab-forum", type: 11 }
] as const satisfies ReadonlyArray<{ readonly name: string; readonly parent: ChannelName; readonly type: number }>

/** A lab thread name. */
export type ThreadName = (typeof threadSpecs)[number]["name"]

/**
 * The threads a scenario creates (never provisioned or stored; cleanup deletes them, and reset deletes any it
 * finds as scenario threads): the subject's (the `subject-thread` fixture), one name per kind, and a throwaway
 * public thread the harness creates (`harness-thread`, M6), which the subject may delete only with ManageThreads.
 */
export const scenarioThreadSpecs = [
  { name: "lab-subject-public-thread", parent: "lab-text", type: 11, creator: "subject" },
  { name: "lab-subject-private-thread", parent: "lab-text", type: 12, creator: "subject" },
  { name: "lab-subject-announcement-thread", parent: "lab-announcement", type: 10, creator: "subject" },
  { name: "lab-subject-forum-post", parent: "lab-forum", type: 11, creator: "subject" },
  { name: "lab-harness-public-thread", parent: "lab-text", type: 11, creator: "harness" }
] as const satisfies ReadonlyArray<{ readonly name: string; readonly parent: ChannelName; readonly type: number; readonly creator: "subject" | "harness" }>

/** A scenario thread name. */
export type ScenarioThreadName = (typeof scenarioThreadSpecs)[number]["name"]

/** The names of the threads and posts the subject creates as an operation (createThread, createPost); cleanup deletes them. */
export const createdThreadName = "lab-created-thread"

/**
 * The lab's roles, top to bottom. `lab-admin` holds Administrator; it is the "administrator" grant source and
 * is only ever assigned to the subject by a scenario. Every other role has no permissions at baseline.
 * `lab-mentionable` is the only mentionable role. The target holds `lab-target` and `lab-unmentionable`.
 */
export const roleSpecs = [
  { name: "lab-high", permissions: 0n, mentionable: false },
  { name: "lab-mid", permissions: 0n, mentionable: false },
  { name: "lab-low", permissions: 0n, mentionable: false },
  { name: "lab-grant", permissions: 0n, mentionable: false },
  { name: "lab-allow", permissions: 0n, mentionable: false },
  { name: "lab-deny", permissions: 0n, mentionable: false },
  { name: "lab-admin", permissions: PermissionFlagsBits.Administrator, mentionable: false },
  { name: "lab-target", permissions: 0n, mentionable: false },
  { name: "lab-mentionable", permissions: 0n, mentionable: true },
  { name: "lab-unmentionable", permissions: 0n, mentionable: false }
] as const satisfies ReadonlyArray<{ readonly name: string; readonly permissions: bigint; readonly mentionable: boolean }>

/** A lab role name. */
export type RoleName = (typeof roleSpecs)[number]["name"]

/**
 * A bot's managed role, where it has one, sits directly below this lab role, the subject's above the
 * target's (H-073), so `lab-high`, `lab-mid` and `lab-low` rank above both. In Perms Lab neither the subject
 * nor the target has a managed role (they joined with no permissions; M2 live finding), so their ranks come
 * only from the lab roles a scenario assigns: by default the target (`lab-target`) outranks the subject
 * (no roles), and a scenario sets any other rank with `lab-high`, `lab-mid` or `lab-low`.
 */
export const managedRolesBelow: RoleName = "lab-low"

/** The target's roles at baseline (it never loses them; §5.7). */
export const targetBaselineRoles: ReadonlyArray<RoleName> = ["lab-target", "lab-unmentionable"]

/**
 * What `lab-target`'s role overwrite allows on every lab channel, so `@everyone` overwrite denies never stop
 * the target posting fixtures (H-007, §5.7).
 */
export const targetOverwriteAllow: bigint =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AddReactions

/** Every lab thread's auto-archive duration, in minutes (L19). */
export const threadAutoArchiveMinutes = 10080

/** The forum and media channels' baseline tags; `REQUIRE_TAG` is off at baseline. */
export const baselineTags: ReadonlyArray<{ readonly name: string; readonly moderated: boolean }> = [{ name: "lab-tag", moderated: false }]

/** The channel flag that makes forum and media posts require a tag (H-044). */
export const requireTagFlag = 1 << 4

/** The guild sticker the lab provisions. */
export const stickerSpec = { name: "lab-sticker", tags: "lab", description: "Perms Lab sticker" } as const

/** The guild emoji the lab provisions (reactions with a guild emoji). Emoji names allow only letters, digits and `_`. */
export const emojiSpec = { name: "lab_emoji" } as const

/**
 * The roles that set ranks in the members family (H-060..H-067): the subject holds `lab-mid`; the target holds
 * nothing more (below), `lab-mid` (equal) or `lab-high` (above); a role assigned or removed is `lab-low`
 * (below the subject's highest role), `lab-mid` (its own highest role) or `lab-high` (above it).
 */
export const rankRoles = {
  subject: "lab-mid",
  target: { below: undefined, equal: "lab-mid", above: "lab-high" },
  assigned: { below: "lab-low", equal: "lab-mid", above: "lab-high" }
} as const satisfies {
  readonly subject: RoleName
  readonly target: { readonly [K in "below" | "equal" | "above"]: RoleName | undefined }
  readonly assigned: { readonly [K in "below" | "equal" | "above"]: RoleName }
}

// ---- persisted IDs ------------------------------------------------------------------------------------

/** The persisted IDs, keyed by lab name. Channels and threads share one map (threads are channels). */
export const LabState = Schema.Struct({
  guildId: GuildId,
  channels: Schema.Record(Schema.String, ChannelId),
  roles: Schema.Record(Schema.String, RoleId),
  sticker: Schema.optionalKey(StickerId),
  emoji: Schema.optionalKey(EmojiId),
  /**
   * Lab channels Discord refused to create because the kind is not available in this guild (50024 on create,
   * observed for GuildMedia in M2). Provision does not retry them; scenarios on them record
   * `setup-unsupported: kind-not-available` (§5.10). Delete the entry to retry.
   */
  unavailable: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ status: Schema.Int, code: Schema.Int })))
})
/** The persisted IDs. */
export type LabState = typeof LabState.Type

const LabStateJson = Schema.fromJsonString(LabState)

/** The state file, git-ignored, next to the repository's `.env`. */
export const statePath = new URL("../.lab-state.json", import.meta.url).pathname

/** An empty state for `guildId`: nothing provisioned yet. */
export const empty = (guildId: GuildId): LabState => ({ guildId, channels: {}, roles: {} })

/**
 * Reads the state file for `guildId`. A missing file is an empty state; a file for another guild, or one that
 * does not decode, fails with `LabCheckFailed` (it would make the harness act on objects it does not own).
 */
export const load = (guildId: GuildId, path: string = statePath): Effect.Effect<LabState, LabCheckFailed | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(path))) return empty(guildId)
    const text = yield* fs.readFileString(path)
    const state = yield* Schema.decodeUnknownEffect(LabStateJson)(text).pipe(
      Effect.mapError((error) => new LabCheckFailed({ check: "lab state", detail: `${path} does not decode: ${error.message}` }))
    )
    if (state.guildId !== guildId) {
      return yield* new LabCheckFailed({ check: "lab state", detail: `${path} belongs to guild ${state.guildId}, not the lab guild` })
    }
    return state
  })

/** Writes the state file atomically (a temporary file renamed over it), with sorted keys. */
export const save = (state: LabState, path: string = statePath): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const sorted = <V extends string>(record: Readonly<Record<string, V>>): Record<string, V> =>
      Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)))
    const encoded = Schema.encodeSync(LabState)({ ...state, channels: sorted(state.channels), roles: sorted(state.roles) })
    const temporary = `${path}.tmp`
    yield* fs.writeFileString(temporary, `${JSON.stringify(encoded, null, 2)}\n`)
    yield* fs.rename(temporary, path)
  })
