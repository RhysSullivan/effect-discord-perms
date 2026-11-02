/**
 * The Perms Lab guard (DESIGN §5.6) and the harness's request boundary.
 *
 * **Where the guard sits.** In the shared base `HttpClient` (`harness/Identities.ts`), below every identity's
 * dfx stack. Every request any identity sends passes it: the harness's provisioning and reset, `TargetRest`,
 * `SubjectRaw`, and (from M6) the library's own operations when the subject runs them, because the subject's
 * build receives the same base client. It cannot be bypassed by calling dfx directly. The "narrow `Lab`
 * interface" of §5.6 is this route allowlist: a write is sent only if its route is one the lab needs and
 * its target is a lab object.
 *
 * **What it asserts.** Any violation is a defect that aborts the run before the request is sent:
 * - the host is discord.com, and every guild route (read or write) names `DISCORD_TEST_GUILD_ID`;
 * - nothing is written before `arm` (the identity checks have run and found the lab's protected channels);
 * - a channel write targets an admitted lab channel: named `lab` or `lab-*`, in the lab guild, and never
 *   `#rules`, `#mod-updates` or the guild's rules or public-updates channel; a new channel or thread has a lab
 *   name, and a new channel no parent outside the lab; a channel PATCH sets overwrites only for lab roles,
 *   `@everyone` and the two bots (as the per-overwrite route does) and moves the channel only under a lab
 *   parent; the guild's channel-list PATCH (positions and parents of any channel) is refused;
 * - thread membership changes only for `@me`, the subject and the target (adding a human posts a notice that
 *   can ping them);
 * - a role write targets an admitted lab role (`lab-*`), the subject's or target's managed role, or (PATCH
 *   only) `@everyone`; a new role has a lab name; a role-position PATCH may name only those roles and the
 *   harness's own top role, which Discord requires in the same request when lab roles move above its numeric
 *   position;
 * - member edits target only the subject or the target bot (or `@me`), and change only `nick` and
 *   `communication_disabled_until`; roles change only through the per-role routes, with lab roles;
 * - AutoMod writes only delete rules named `lab-*` that the harness listed; a new sticker has a `lab-*` name,
 *   and stickers are never edited or deleted;
 * - **kick and ban** of the target only, and only with a one-shot permit for that exact route, which the guard
 *   issues itself (`permitKickOrBan`) when the docs model predicts failure from harness-side reads taken just
 *   before the call: the subject holds neither the flag nor Administrator, or the target's highest role is not
 *   below the subject's (`kickBanPredictedToFail`). The resolver under test is never consulted. Any other kick
 *   or ban, and a second use of a permit, is refused;
 * - a channel PATCH that renames a channel gives it a lab name; a new guild emoji has a `lab_` name, and emoji
 *   are never edited or deleted;
 * - nothing creates or writes to a DM channel, leaves the guild, edits global commands, webhooks or invites.
 *
 * A lab object is admitted after the harness has read it from Discord (or created it) and checked its name and
 * guild, so the stored IDs in `.lab-state.json` are never trusted on their own.
 */
import type { DiscordRESTError } from "dfx/DiscordREST"
import { Clock, Context, Duration, Effect, Layer, Option, Ref, Schema } from "effect"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import { classify } from "../src/rest/ErrorMap.ts"
import type { ChannelId, GuildId, RoleId, UserId } from "../src/Snowflake.ts"

/** What the guard needs once the identity checks have run. */
export interface Armed {
  readonly harnessUserId: UserId
  readonly subjectUserId: UserId
  readonly targetUserId: UserId
  /** `#rules`, `#mod-updates` and the guild's rules and public-updates channels: never admitted. */
  readonly protectedChannels: ReadonlySet<string>
}

/** The guard's state: the lab guild, whether it is armed, and the admitted lab objects. */
export interface GuardState {
  readonly guildId: GuildId
  readonly armed: Option.Option<Armed>
  readonly channels: ReadonlySet<string>
  readonly roles: ReadonlySet<string>
  /**
   * Roles that may appear in a role-position PATCH and nowhere else: the harness's own top role. Discord
   * refuses to move lab roles above the harness's numeric position unless the same request moves the
   * harness's role above them (M2 live finding).
   */
  readonly positionRoles: ReadonlySet<string>
  /** AutoMod rules named `lab-*` that the harness listed: the only rules it may delete. */
  readonly autoModRules: ReadonlySet<string>
  /**
   * One-shot permits for a kick or ban of the target (`DELETE /guilds/{g}/members/{t}` or `PUT /guilds/{g}/bans/{t}`),
   * issued by `permitKickOrBan` only when failure is predicted; `check` consumes a permit when it admits it.
   */
  readonly kickBanPermits: ReadonlySet<string>
}

/** The guard's decision on one request. */
export type Verdict = { readonly _tag: "Allow" } | { readonly _tag: "Refuse"; readonly reason: string }

const allow: Verdict = { _tag: "Allow" }
const refuse = (reason: string): Verdict => ({ _tag: "Refuse", reason })

/** A channel name the lab owns. */
export const isLabChannelName = (name: string): boolean => name === "lab" || name.startsWith("lab-")
/** A role name the lab owns. */
export const isLabRoleName = (name: string): boolean => name.startsWith("lab-")
/** An AutoMod rule name the lab owns. */
export const isLabRuleName = (name: string): boolean => name.startsWith("lab-")
/** A guild sticker name the lab owns. */
export const isLabStickerName = (name: string): boolean => name.startsWith("lab-")
/** A guild emoji name the lab owns (emoji names allow only letters, digits and `_`). */
export const isLabEmojiName = (name: string): boolean => name.startsWith("lab_")

/**
 * What the guard can read of a request body: JSON (or any bytes) as text, the string fields of a multipart
 * form (dfx sends stickers, and messages with files, as `FormData`), or nothing readable.
 */
export type RequestBody =
  | { readonly _tag: "None" }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Form"; readonly fields: ReadonlyMap<string, string> }

/** A request without a readable body. */
export const noBody: RequestBody = { _tag: "None" }
/** A request whose body is `text` (JSON as dfx and the raw helper send it). */
export const textBody = (text: string): RequestBody => ({ _tag: "Text", text })
/** A multipart request with these string fields (file parts are not fields). */
export const formBody = (fields: ReadonlyMap<string, string>): RequestBody => ({ _tag: "Form", fields })

const textOf = (body: RequestBody): Option.Option<string> => (body._tag === "Text" ? Option.some(body.text) : Option.none())

const RolePositions = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String })))
const decodeRolePositions = Schema.decodeUnknownOption(RolePositions)
const NewChannel = Schema.fromJsonString(Schema.Struct({ name: Schema.String, parent_id: Schema.optionalKey(Schema.NullOr(Schema.String)) }))
const decodeNewChannel = Schema.decodeUnknownOption(NewChannel)
const Named = Schema.fromJsonString(Schema.Struct({ name: Schema.String }))
const decodeNamed = Schema.decodeUnknownOption(Named)
const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeJsonObject = Schema.decodeUnknownOption(JsonObject)
/** The fields of a channel PATCH the guard reads: the overwrites it sets and the parent it moves the channel to. */
const ChannelEdit = Schema.fromJsonString(
  Schema.Struct({
    permission_overwrites: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
    parent_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
    name: Schema.optionalKey(Schema.String)
  })
)
const decodeChannelEdit = Schema.decodeUnknownOption(ChannelEdit)

/**
 * The member fields the lab edits: a nickname and a timeout (reset, and the library's `member.setNickname` and
 * `member.timeout`). Roles change only through the per-role routes, which check each role; `channel_id`
 * (moving a member between voice channels), `mute`, `deaf` and `flags` are never needed.
 */
const memberFields: ReadonlySet<string> = new Set(["nick", "communication_disabled_until"])

const guildWrite = (state: GuardState, armed: Armed, method: string, route: string, rest: ReadonlyArray<string>, body: RequestBody): Verdict => {
  const [area, target, sub, subTarget] = rest
  const bodyText = textOf(body)
  const isBot = (user: string | undefined): boolean => user === armed.subjectUserId || user === armed.targetUserId
  const isLabRole = (role: string | undefined): boolean => role !== undefined && state.roles.has(role)
  const memberEdit = (): Verdict => {
    const fields = Option.map(Option.flatMap(bodyText, decodeJsonObject), Object.keys)
    if (Option.isNone(fields)) return refuse(`${route}: member edit body could not be read`)
    const outside = fields.value.filter((field) => !memberFields.has(field))
    return outside.length === 0 ? allow : refuse(`${route}: member edits change only the nickname and timeout, not ${outside.join(", ")}`)
  }
  switch (area) {
    case "channels": {
      // Only channel creation. `PATCH /guilds/{g}/channels` reorders and re-parents any channel, `#rules` included.
      if (rest.length !== 1 || method !== "POST") return refuse(`${route}: not a lab channel creation`)
      const created = Option.flatMap(bodyText, decodeNewChannel)
      if (Option.isNone(created)) return refuse(`${route}: channel body could not be read`)
      if (!isLabChannelName(created.value.name)) return refuse(`${route}: a new channel must have a lab name, not "${created.value.name}"`)
      const parent = created.value.parent_id
      return parent === undefined || parent === null || (state.channels.has(parent) && !armed.protectedChannels.has(parent))
        ? allow
        : refuse(`${route}: a new channel's parent must be a lab channel`)
    }
    case "roles": {
      if (rest.length === 1 && method === "POST") {
        const created = Option.flatMap(bodyText, decodeNamed)
        return Option.isSome(created) && isLabRoleName(created.value.name) ? allow : refuse(`${route}: a new role must have a lab name`)
      }
      if (rest.length === 1 && method === "PATCH") {
        const ids = Option.flatMap(bodyText, (text) => decodeRolePositions(text))
        if (Option.isNone(ids)) return refuse(`${route}: role-position body could not be read`)
        const outside = ids.value.filter((entry) => !isLabRole(entry.id) && !state.positionRoles.has(entry.id))
        return outside.length === 0 ? allow : refuse(`${route}: moves roles outside the lab: ${outside.map((entry) => entry.id).join(", ")}`)
      }
      if (rest.length === 2 && method === "PATCH") return isLabRole(target) || target === state.guildId ? allow : refuse(`${route}: not a lab role`)
      if (rest.length === 2 && method === "DELETE") return isLabRole(target) ? allow : refuse(`${route}: not a lab role`)
      return refuse(`${route}: role write not allowed`)
    }
    case "members": {
      if (rest.length === 2 && method === "DELETE") {
        return target === armed.targetUserId && state.kickBanPermits.has(route) ? allow : refuse(`${route}: a kick needs a permit from a harness-side failure prediction`)
      }
      if (rest.length === 2 && method === "PATCH") return target === "@me" || isBot(target) ? memberEdit() : refuse(`${route}: member edits target only the subject or the target`)
      if (rest.length === 4 && sub === "roles" && (method === "PUT" || method === "DELETE")) {
        return isBot(target) && isLabRole(subTarget) ? allow : refuse(`${route}: role changes only on the subject or target, with lab roles`)
      }
      return refuse(`${route}: member write not allowed`)
    }
    case "bans":
      return rest.length === 2 && method === "PUT" && target === armed.targetUserId && state.kickBanPermits.has(route)
        ? allow
        : refuse(`${route}: a ban needs a permit from a harness-side failure prediction`)
    case "bulk-ban":
      return refuse(`${route}: bulk bans are never allowed`)
    case "emojis": {
      if (rest.length !== 1 || method !== "POST") return refuse(`${route}: emoji write not allowed`)
      const created = Option.flatMap(bodyText, decodeNamed)
      return Option.isSome(created) && isLabEmojiName(created.value.name) ? allow : refuse(`${route}: a new emoji must have a lab_ name`)
    }
    case "stickers": {
      if (rest.length !== 1 || method !== "POST") return refuse(`${route}: sticker write not allowed`)
      const name = body._tag === "Form" ? Option.fromUndefinedOr(body.fields.get("name")) : Option.none()
      return Option.isSome(name) && isLabStickerName(name.value) ? allow : refuse(`${route}: a new sticker must have a lab name`)
    }
    case "auto-moderation":
      return rest.length === 3 && target === "rules" && method === "DELETE" && sub !== undefined && state.autoModRules.has(sub)
        ? allow
        : refuse(`${route}: AutoMod writes only delete admitted lab rules`)
    default:
      return refuse(`${route}: guild write not allowed`)
  }
}

const channelWrite = (state: GuardState, armed: Armed, method: string, route: string, channel: string | undefined, rest: ReadonlyArray<string>, body: RequestBody): Verdict => {
  if (channel === undefined || !state.channels.has(channel)) return refuse(`${route}: not a lab channel`)
  if (armed.protectedChannels.has(channel)) return refuse(`${route}: a protected channel`)
  const [area, target, sub] = rest
  if (area === "webhooks" || area === "invites" || area === "followers" || area === "recipients") return refuse(`${route}: not allowed in the lab`)
  /** The overwrite targets the lab sets: lab roles, `@everyone` and the two bots (never a human or a foreign role). */
  const overwriteTarget = (id: string): boolean => state.roles.has(id) || id === state.guildId || id === armed.subjectUserId || id === armed.targetUserId
  // A channel PATCH sets the same overwrites as the per-overwrite route, so it gets the same rule; and a lab
  // channel moves only under a lab parent (or to none), as a new channel's parent must be.
  if (rest.length === 0 && method === "PATCH") {
    const edit = Option.flatMap(textOf(body), decodeChannelEdit)
    if (Option.isNone(edit)) return refuse(`${route}: channel edit body could not be read`)
    const outside = (edit.value.permission_overwrites ?? []).filter((overwrite) => !overwriteTarget(overwrite.id))
    if (outside.length > 0) return refuse(`${route}: overwrite target outside the lab: ${outside.map((overwrite) => overwrite.id).join(", ")}`)
    const parent = edit.value.parent_id
    if (parent !== undefined && parent !== null && (!state.channels.has(parent) || armed.protectedChannels.has(parent))) {
      return refuse(`${route}: a lab channel's parent must be a lab channel`)
    }
    const name = edit.value.name
    if (name !== undefined && !isLabChannelName(name)) return refuse(`${route}: a lab channel keeps a lab name, not "${name}"`)
    return allow
  }
  // A thread (or forum post) is created by `POST threads` or `POST messages/{id}/threads`; it must have a lab
  // name, so reset can tell scenario threads from anything else (§5.7).
  const threadCreate = (rest.length === 1 && area === "threads") || (rest.length === 3 && area === "messages" && sub === "threads")
  if (threadCreate) {
    if (method !== "POST") return refuse(`${route}: thread write not allowed`)
    const created = Option.flatMap(textOf(body), decodeNamed)
    if (Option.isNone(created)) return refuse(`${route}: thread body could not be read`)
    return isLabChannelName(created.value.name) ? allow : refuse(`${route}: a new thread must have a lab name, not "${created.value.name}"`)
  }
  if (area === "permissions") {
    return rest.length === 2 && target !== undefined && overwriteTarget(target) ? allow : refuse(`${route}: overwrite target outside the lab`)
  }
  if (area === "thread-members") {
    // Adding a human posts a RECIPIENT_ADD notice that can ping them; only the bots join or leave threads.
    const allowed = target === "@me" || target === armed.subjectUserId || target === armed.targetUserId
    return rest.length === 2 && allowed ? allow : refuse(`${route}: thread membership changes only for the bots`)
  }
  return allow
}

/** A request's route as the guard names it (`METHOD /path` without the API prefix), or `undefined` for a non-Discord URL. */
export const routeOf = (method: string, url: string): string | undefined => {
  const parsed = URL.canParse(url) ? new URL(url) : undefined
  if (parsed === undefined || parsed.hostname !== "discord.com") return undefined
  const segments = parsed.pathname.replace(/^\/api\/v\d+/, "").split("/").filter((segment) => segment.length > 0)
  return `${method.toUpperCase()} /${segments.join("/")}`
}

/**
 * The guard's decision for a request, as a pure function of the state, the method, the full URL and the body.
 * The body is read for channel, thread, role and sticker creation, channel edits, role-position PATCHes and
 * member edits; a body those routes cannot read is refused.
 */
export const verdict = (state: GuardState, method: string, url: string, body: RequestBody): Verdict => {
  const parsed = URL.canParse(url) ? new URL(url) : undefined
  if (parsed === undefined || parsed.hostname !== "discord.com") return refuse(`not a Discord API URL: ${method} ${url}`)
  const segments = parsed.pathname.replace(/^\/api\/v\d+/, "").split("/").filter((segment) => segment.length > 0)
  const upper = method.toUpperCase()
  const route = `${upper} /${segments.join("/")}`
  const [head, id, ...rest] = segments
  const guildRoute = head === "guilds" ? id : head === "applications" && rest[0] === "guilds" ? rest[1] : undefined
  if (guildRoute !== undefined && guildRoute !== state.guildId) return refuse(`${route}: not the lab guild`)
  if (upper === "GET" || upper === "HEAD") return allow
  if (Option.isNone(state.armed)) return refuse(`${route}: no writes before the identity checks arm the guard`)
  const armed = state.armed.value
  switch (head) {
    case "guilds":
      return guildWrite(state, armed, upper, route, rest, body)
    case "channels":
      return channelWrite(state, armed, upper, route, id, rest, body)
    case "applications":
      return rest[0] === "guilds" ? allow : refuse(`${route}: only guild commands in the lab guild`)
    default:
      return refuse(`${route}: write not allowed`)
  }
}

/** What the harness read just before a kick or ban, for the docs model's prediction (§5.6). */
export interface KickBanReads {
  readonly guildId: GuildId
  /** The guild's roles, `@everyone` included (its ID is the guild ID). */
  readonly roles: ReadonlyArray<{ readonly id: string; readonly permissions: string; readonly position: number }>
  readonly subject: { readonly roles: ReadonlyArray<string> }
  readonly target: { readonly roles: ReadonlyArray<string> }
}

const administratorBit = 1n << 3n
const kickBit = 1n << 1n
const banBit = 1n << 2n

/**
 * The docs model's own prediction that a kick or ban of the target fails (P "Permission Hierarchy"; H-064):
 * the subject's guild permissions (`@everyone` OR its roles) hold neither the flag nor Administrator, or the
 * target's highest role is not strictly below the subject's (position, then the lower ID ranks higher; a member
 * with no role ranks as `@everyone`). Independent of the resolver under test. A timeout is not a reason
 * (H-022 was open when this rule was written).
 */
export const kickBanPredictedToFail = (action: "kick" | "ban", reads: KickBanReads): boolean => {
  const byId = new Map(reads.roles.map((role) => [role.id, role]))
  const everyone = byId.get(reads.guildId)
  let permissions = everyone === undefined ? 0n : BigInt(everyone.permissions)
  for (const id of reads.subject.roles) permissions |= BigInt(byId.get(id)?.permissions ?? "0")
  const flag = action === "kick" ? kickBit : banBit
  if ((permissions & (flag | administratorBit)) === 0n) return true
  const top = (roles: ReadonlyArray<string>) => {
    let best: { readonly id: string; readonly position: number } = { id: reads.guildId, position: 0 }
    for (const id of roles) {
      const role = byId.get(id)
      if (role !== undefined && (role.position > best.position || (role.position === best.position && BigInt(role.id) < BigInt(best.id)))) best = role
    }
    return best
  }
  const subjectTop = top(reads.subject.roles)
  const targetTop = top(reads.target.roles)
  const subjectAbove = subjectTop.position > targetTop.position || (subjectTop.position === targetTop.position && BigInt(subjectTop.id) < BigInt(targetTop.id))
  return !subjectAbove
}

/** The route a kick or ban of `user` takes, as the guard names routes. */
export const kickBanRoute = (action: "kick" | "ban", guildId: GuildId, user: UserId): string =>
  action === "kick" ? `DELETE /guilds/${guildId}/members/${user}` : `PUT /guilds/${guildId}/bans/${user}`

/** The guard service. */
export interface Interface {
  /** Checks one outgoing request. Dies (aborting the run) if the guard refuses it. */
  readonly check: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<void>
  /** Allows writes, once the identity checks have found the bots and the protected channels. */
  readonly arm: (armed: Armed) => Effect.Effect<void>
  /** Admits a channel the harness read or created. Dies if it is not a lab channel. */
  readonly admitChannel: (channel: { readonly id: ChannelId; readonly name: string }) => Effect.Effect<void>
  /** Admits a role the harness read or created. Dies if it is neither a lab role nor a bot's managed role. */
  readonly admitRole: (role: { readonly id: RoleId; readonly name: string; readonly botId: UserId | undefined }) => Effect.Effect<void>
  /** Admits the harness's own managed role to role-position PATCHes only. Dies for any other role. */
  readonly admitHarnessRoleForPositions: (role: { readonly id: RoleId; readonly botId: UserId | undefined }) => Effect.Effect<void>
  /** Admits an AutoMod rule the harness listed, so reset may delete it. Dies if it is not named `lab-*`. */
  readonly admitAutoModRule: (rule: { readonly id: string; readonly name: string }) => Effect.Effect<void>
  /**
   * Issues a one-shot permit for one kick or ban of the target, after checking `kickBanPredictedToFail` over the
   * harness's reads. Dies (aborting the run) if the docs model does not predict failure.
   */
  readonly permitKickOrBan: (action: "kick" | "ban", reads: KickBanReads) => Effect.Effect<void>
}

/** The process-wide Perms Lab guard. */
export class LabGuard extends Context.Service<LabGuard, Interface>()("harness/LabGuard") {}

/** What the guard reads of an outgoing request's body (see {@link RequestBody}). */
export const requestBody = (request: HttpClientRequest.HttpClientRequest): RequestBody => {
  switch (request.body._tag) {
    case "Uint8Array":
      return textBody(new TextDecoder().decode(request.body.body))
    case "FormData": {
      const fields = new Map<string, string>()
      for (const [key, value] of request.body.formData.entries()) if (typeof value === "string") fields.set(key, value)
      return formBody(fields)
    }
    case "Empty":
    case "Raw":
    case "Stream":
      return noBody
  }
}

/** Builds the guard for the lab guild. It starts unarmed: only reads are allowed. */
export const make = (guildId: GuildId): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<GuardState>({
      guildId,
      armed: Option.none(),
      channels: new Set(),
      roles: new Set(),
      positionRoles: new Set(),
      autoModRules: new Set(),
      kickBanPermits: new Set()
    })

    /** `@everyone`'s role ID is the guild ID. */
    const isEveryone = (role: string): boolean => role === guildId
    const armedState = Ref.get(state).pipe(
      Effect.flatMap((current) =>
        Option.isSome(current.armed) ? Effect.succeed(current.armed.value) : Effect.die(new Error("lab guard: admission before the identity checks"))
      )
    )

    return LabGuard.of({
      check: (request) =>
        Ref.modify(state, (current): readonly [Verdict, GuardState] => {
          const decision = verdict(current, request.method, request.url, requestBody(request))
          const route = routeOf(request.method, request.url)
          // a permit is consumed by the request it admits
          return decision._tag === "Allow" && route !== undefined && current.kickBanPermits.has(route)
            ? [decision, { ...current, kickBanPermits: new Set([...current.kickBanPermits].filter((permit) => permit !== route)) }]
            : [decision, current]
        }).pipe(Effect.flatMap((decision) => (decision._tag === "Allow" ? Effect.void : Effect.die(new Error(`lab guard refused ${decision.reason}`))))),
      arm: (armed) => Ref.update(state, (current) => ({ ...current, armed: Option.some(armed) })),
      admitChannel: (channel) =>
        Effect.gen(function* () {
          const armed = yield* armedState
          if (!isLabChannelName(channel.name) || armed.protectedChannels.has(channel.id)) {
            return yield* Effect.die(new Error(`lab guard: channel ${channel.id} (${channel.name}) is not a lab channel`))
          }
          yield* Ref.update(state, (current) => ({ ...current, channels: new Set([...current.channels, channel.id]) }))
        }),
      admitRole: (role) =>
        Effect.gen(function* () {
          const armed = yield* armedState
          const managed = role.botId !== undefined && (role.botId === armed.subjectUserId || role.botId === armed.targetUserId)
          if (isEveryone(role.id) || !(isLabRoleName(role.name) || managed)) {
            return yield* Effect.die(new Error(`lab guard: role ${role.id} (${role.name}) is not a lab role`))
          }
          yield* Ref.update(state, (current) => ({ ...current, roles: new Set([...current.roles, role.id]) }))
        }),
      admitHarnessRoleForPositions: (role) =>
        Effect.gen(function* () {
          const armed = yield* armedState
          if (role.botId === undefined || role.botId !== armed.harnessUserId) {
            return yield* Effect.die(new Error(`lab guard: role ${role.id} is not the harness's managed role`))
          }
          yield* Ref.update(state, (current) => ({ ...current, positionRoles: new Set([...current.positionRoles, role.id]) }))
        }),
      permitKickOrBan: (action, reads) =>
        Effect.gen(function* () {
          const armed = yield* armedState
          if (reads.guildId !== guildId) return yield* Effect.die(new Error("lab guard: a kick or ban prediction for another guild"))
          if (!kickBanPredictedToFail(action, reads)) {
            return yield* Effect.die(new Error(`lab guard: the docs model does not predict the ${action} of the target to fail; refused`))
          }
          const route = kickBanRoute(action, guildId, armed.targetUserId)
          yield* Ref.update(state, (current) => ({ ...current, kickBanPermits: new Set([...current.kickBanPermits, route]) }))
        }),
      admitAutoModRule: (rule) =>
        Effect.gen(function* () {
          yield* armedState
          if (!isLabRuleName(rule.name)) return yield* Effect.die(new Error(`lab guard: AutoMod rule ${rule.id} (${rule.name}) is not a lab rule`))
          yield* Ref.update(state, (current) => ({ ...current, autoModRules: new Set([...current.autoModRules, rule.id]) }))
        })
    })
  })

/** The guard layer for the lab guild. */
export const layer = (guildId: GuildId): Layer.Layer<LabGuard> => Layer.effect(LabGuard, make(guildId))

// ---- the harness's request boundary ------------------------------------------------------------------

/** A lab step's Discord request failed. The harness aborts the command; nothing here is a library error. */
export class LabRequestFailed extends Schema.TaggedError<LabRequestFailed>()("LabRequestFailed", {
  /** What the harness was doing, for example `reset: delete leftover channel`. */
  step: Schema.String,
  /** The HTTP status, or 0 when there was no response. */
  status: Schema.Int,
  /** Discord's JSON code, or 0. */
  code: Schema.Int,
  message: Schema.String
}) {}

/** A lab precondition or identity check failed; the command aborts before (or instead of) writing. */
export class LabCheckFailed extends Schema.TaggedError<LabCheckFailed>()("LabCheckFailed", {
  check: Schema.String,
  detail: Schema.String
}) {}

/**
 * How long one lab step may take, dfx's waits after 429s included. A step past it fails with status 0 (no
 * response), which aborts the command naming the step: M4 live, a run sat idle for 15 minutes inside one
 * harness call, which is what an unbounded dfx 429 wait looks like from outside.
 */
export const labStepDeadline = Duration.seconds(90)

/**
 * Runs one dfx call as a named lab step, within {@link labStepDeadline}. A Discord failure becomes
 * `LabRequestFailed` with only the status, code and message copied out (never the live request or response). A
 * rate-limited response that escaped dfx, and malformed or unencodable requests, are defects (§3.1).
 */
export const labStep =
  (step: string) =>
  <A, R>(effect: Effect.Effect<A, DiscordRESTError, R>): Effect.Effect<A, LabRequestFailed, R> =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      return yield* effect.pipe(
        Effect.catch((error) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => classify(error, step, now - started)),
            Effect.flatMap((failure) =>
              failure._tag === "NoResponse"
                ? Effect.fail(new LabRequestFailed({ step, status: 0, code: 0, message: `no response (${failure.cause.reason} after ${failure.cause.afterMs} ms)` }))
                : Effect.fail(new LabRequestFailed({ step, status: failure.response.status, code: failure.response.code, message: failure.response.message }))
            )
          )
        ),
        Effect.timeoutOrElse({
          duration: labStepDeadline,
          orElse: () => Effect.fail(new LabRequestFailed({ step, status: 0, code: 0, message: `no response within ${Duration.format(labStepDeadline)}` }))
        })
      )
    })

/** Like {@link labStep}, but a Discord response with one of `codes` (for example 10003 Unknown Channel) is `None`. */
export const labStepUnless =
  (step: string, codes: ReadonlyArray<number>) =>
  <A, R>(effect: Effect.Effect<A, DiscordRESTError, R>): Effect.Effect<Option.Option<A>, LabRequestFailed, R> =>
    effect.pipe(
      Effect.map(Option.some),
      labStep(step),
      Effect.catchIf(
        (error) => error.status !== 0 && codes.includes(error.code),
        () => Effect.succeedNone
      )
    )
