/**
 * Message payloads (DESIGN §2.3, `[sd:src/payload.ts]`): what a create, a Components V2 create and an edit may
 * carry, and the shape rules checked on the argument itself.
 *
 * Shape rules are intersected onto the argument (`CheckCreate<P>`, `CheckEdit<P>`), and each error sits on the
 * offending property (rule 3 of §2.12):
 *
 * - a message needs content, embeds, files, stickers, a poll or components (`NonEmpty`, H-122);
 * - Components V2 excludes content, embeds, stickers, a poll, TTS and legacy components (H-125);
 * - only known keys: `ephemeral` exists only on interaction responses, `suppressNotifications` only on create
 *   (H-105, H-106, H-132), and `allowed_mentions` is not settable, because the library always pings nobody
 *   unless `mentions` opts in (H-133).
 *
 * The permission and limit computations over these types are in `PayloadRules.ts`.
 */
import type { EmojiId, MessageId, RoleId, StickerId, UserId } from "../Snowflake.ts"
import type { ActionRow, Invalid, V2Component } from "./Components.ts"

/** An embed (the fields phase 1 sends; limits in `Limits.ts`, H-123). */
export interface Embed {
  readonly title?: string
  readonly description?: string
  readonly url?: string
  readonly fields?: ReadonlyArray<{ readonly name: string; readonly value: string; readonly inline?: boolean }>
  readonly footer?: { readonly text: string }
  readonly author?: { readonly name: string }
}

/** A file to attach. */
export interface FileUpload {
  readonly name: string
  readonly data: Uint8Array
  /** The MIME type; `application/octet-stream` when absent. */
  readonly contentType?: string
}

/** A poll (H-139; limits in `Limits.ts`). */
export interface Poll {
  readonly question: string
  readonly answers: ReadonlyArray<string>
  /** 1 to 768 hours. */
  readonly durationHours: number
  readonly allowMultiselect?: boolean
}

/** A sticker: one of the guild's own, or an external one (needs UseExternalStickers, H-138). */
export type StickerRef = { readonly origin: "guild"; readonly id: StickerId } | { readonly origin: "external"; readonly id: StickerId }

/** An emoji: unicode, or a custom one of this guild or another (`external` needs UseExternalEmojis). */
export type Emoji = { readonly origin: "unicode"; readonly name: string } | { readonly origin: "guild" | "external"; readonly id: EmojiId; readonly name: string }

/** A reply: the message replied to. `failIfMissing` defaults to `true` (H-109). */
export interface ReplyTo {
  readonly messageId: MessageId
  readonly failIfMissing?: boolean
}

/**
 * Who the message may ping. The library always sends `allowed_mentions` with `parse: []` plus these opt-ins, on
 * edits too (H-110, H-111, H-133): pinging is never a default.
 */
export interface Mentions {
  readonly users?: ReadonlyArray<UserId>
  readonly roles?: ReadonlyArray<RoleId>
  readonly everyone?: true
  readonly repliedUser?: true
}

/** Fields valid when creating a message (`POST /channels/{channel.id}/messages`). */
export interface CreateMessage {
  readonly content?: string
  readonly embeds?: ReadonlyArray<Embed>
  readonly files?: ReadonlyArray<FileUpload>
  readonly stickers?: ReadonlyArray<StickerRef>
  readonly poll?: Poll
  readonly components?: ReadonlyArray<ActionRow>
  readonly reply?: ReplyTo
  readonly tts?: boolean
  readonly mentions?: Mentions
  readonly suppressEmbeds?: boolean
  readonly suppressNotifications?: boolean
}

/** A Components V2 message (flag `IS_COMPONENTS_V2`): content, embeds, stickers and a poll are not representable. */
export interface CreateMessageV2 {
  readonly componentsV2: ReadonlyArray<V2Component>
  readonly files?: ReadonlyArray<FileUpload>
  readonly reply?: ReplyTo
  readonly mentions?: Mentions
  readonly suppressEmbeds?: boolean
  readonly suppressNotifications?: boolean
}

/** Any create payload. */
export type MessagePayload = CreateMessage | CreateMessageV2

/** Fields valid when editing the bot's own message: no `suppressNotifications` (H-105), TTS, reply, poll or files. */
export interface EditMessage {
  readonly content?: string
  readonly embeds?: ReadonlyArray<Embed>
  readonly components?: ReadonlyArray<ActionRow>
  readonly mentions?: Mentions
  readonly suppressEmbeds?: boolean
}

// ---- shape rules -------------------------------------------------------------------------------------

type Holds<P, K extends PropertyKey, Empty> = K extends keyof P ? ([P[K]] extends [undefined | Empty] ? false : true) : false

/**
 * A message needs a body (H-122): `unknown` (no constraint) unless no body field can be non-empty, in which case
 * the argument must carry the message-named property, which it cannot.
 */
export type NonEmpty<P> =
  true extends
    | Holds<P, "content", "" | undefined>
    | Holds<P, "embeds", readonly []>
    | Holds<P, "files", readonly []>
    | Holds<P, "stickers", readonly []>
    | Holds<P, "poll", never>
    | Holds<P, "components", readonly []>
    | Holds<P, "componentsV2", readonly []>
    ? unknown
    : { readonly "a message needs content, embeds, files, stickers, a poll or components": never }

type V2Only = "content" | "embeds" | "stickers" | "poll" | "tts" | "components"

/** With `componentsV2`, each legacy body field is an error at that property (H-125). */
export type V2Excludes<P> = P extends { readonly componentsV2: unknown }
  ? [Extract<keyof P, V2Only>] extends [never]
    ? unknown
    : { readonly [K in Extract<keyof P, V2Only>]: P[K] & Invalid<`${K} is not allowed in a componentsV2 message`> }
  : unknown

/** Each key outside `Allowed` is an error at that property, naming the context. */
export type KnownKeys<P, Allowed extends PropertyKey, Context extends string> = [Exclude<keyof P, Allowed>] extends [never]
  ? unknown
  : { readonly [K in Exclude<keyof P, Allowed>]: P[K] & Invalid<`${K & string} is not valid when ${Context}`> }

/**
 * A message holds at most 5 action rows (H-128): a literal list of more is an error at `components` (after the final
 * audit). A list whose type is not a tuple is not checked here; Discord refuses more than 5 with a 50035 on its
 * `components` path, which is an unmapped defect.
 */
export type MessageRows<P> = P extends { readonly components: infer C extends ReadonlyArray<unknown> }
  ? number extends C["length"]
    ? unknown
    : C["length"] extends 0 | 1 | 2 | 3 | 4 | 5
      ? unknown
      : { readonly components: C & Invalid<"a message holds at most 5 action rows"> }
  : unknown

/** Everything checked on a create payload. */
export type CheckCreate<P> = NonEmpty<P> & V2Excludes<P> & KnownKeys<P, keyof CreateMessage | keyof CreateMessageV2, "creating a message"> & MessageRows<P>

/** Everything checked on an edit. */
export type CheckEdit<P> = KnownKeys<P, keyof EditMessage, "editing a message"> & MessageRows<P>

/**
 * A create payload argument: the payload with its checks. Signatures take `CreateArg<P>`, not the bare
 * intersection, so a generic signature relates to an identical one by matching the alias's argument (the bare
 * `P & CheckCreate<P>` makes tsc infer `P` as the whole intersection and fail), which lets an implementation carry
 * the public signature as an overload (§4.7). Diagnostics are unchanged: they name the offending property.
 */
export type CreateArg<P> = P & CheckCreate<P>

/** An edit argument: the patch with its checks (an alias, like {@link CreateArg}). */
export type EditArg<P> = P & CheckEdit<P>

/** Whether a payload is a Components V2 one. */
export const isV2 = (payload: MessagePayload): payload is CreateMessageV2 => "componentsV2" in payload
