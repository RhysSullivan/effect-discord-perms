/**
 * Our payloads as dfx request bodies (DESIGN §2.3 "allowed_mentions and flags at the wire").
 *
 * - `allowed_mentions` is always sent: `{ parse: [] }` plus the explicit opt-ins (`users`, `roles`,
 *   `parse: ["everyone"]` for `mentions.everyone`, `replied_user` for `mentions.repliedUser`), on edits too
 *   (H-110, H-111, H-133). Nothing pings unless the payload says so.
 * - Flags become the bitfield: SuppressEmbeds 4, SuppressNotifications 4096, IsComponentsV2 32768.
 * - Files go through `rest.withFiles` (dfx names them `files[n]` in the multipart body).
 * - A reply is `message_reference` with `fail_if_not_exists` (default `true`, H-109).
 */
import type {
  ActionRowComponentForMessageRequest,
  ButtonComponentForMessageRequest,
  MessageAllowedMentionsRequest,
  MessageCreateRequest,
  MessageEditRequestPartial,
  RichEmbed,
  StringSelectComponentForMessageRequest,
  TextDisplayComponentForMessageRequest
} from "dfx/DiscordREST/Generated"
import type { ActionRow, RowElement, V2Component } from "./Components.ts"
import { type CreateMessage, type EditMessage, type Embed, type FileUpload, isV2, type Mentions, type MessagePayload } from "./Message.ts"

/** The message flag bits the library sets. */
export const MessageFlags = { SuppressEmbeds: 4, SuppressNotifications: 4096, IsComponentsV2: 32768 } as const

/** A create request and the files dfx attaches. */
export interface WireCreate {
  readonly request: MessageCreateRequest
  readonly files: ReadonlyArray<File>
}

/** `allowed_mentions` for `mentions`: nothing pings but what is listed. */
export const allowedMentions = (mentions: Mentions | undefined): MessageAllowedMentionsRequest => ({
  parse: mentions?.everyone === true ? ["everyone"] : [],
  ...(mentions?.users === undefined ? {} : { users: mentions.users }),
  ...(mentions?.roles === undefined ? {} : { roles: mentions.roles }),
  ...(mentions?.repliedUser === true ? { replied_user: true } : {})
})

const embed = (input: Embed): RichEmbed => ({
  ...(input.title === undefined ? {} : { title: input.title }),
  ...(input.description === undefined ? {} : { description: input.description }),
  ...(input.url === undefined ? {} : { url: input.url }),
  ...(input.fields === undefined ? {} : { fields: input.fields.map((field) => ({ name: field.name, value: field.value, ...(field.inline === undefined ? {} : { inline: field.inline }) })) }),
  ...(input.footer === undefined ? {} : { footer: { text: input.footer.text } }),
  ...(input.author === undefined ? {} : { author: { name: input.author.name } })
})

const buttonStyles = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5, premium: 6 } as const

const element = (component: RowElement): ButtonComponentForMessageRequest | StringSelectComponentForMessageRequest => {
  if (component.kind === "string-select") return { type: 3, custom_id: component.customId, options: component.options.map((option) => ({ label: option.label, value: option.value })) }
  switch (component.style) {
    case "link":
      return { type: 2, style: buttonStyles.link, label: component.label, url: component.url }
    case "premium":
      return { type: 2, style: buttonStyles.premium, sku_id: component.skuId }
    case "primary":
    case "secondary":
    case "success":
    case "danger":
      return { type: 2, style: buttonStyles[component.style], label: component.label, custom_id: component.customId }
  }
}

/** An action row as Discord's component object. */
export const actionRow = (input: ActionRow): ActionRowComponentForMessageRequest => ({ type: 1, components: input.components.map(element) })

const v2 = (component: V2Component): TextDisplayComponentForMessageRequest => ({ type: 10, content: component.content })

const flagsOf = (options: { readonly suppressEmbeds?: boolean; readonly suppressNotifications?: boolean; readonly v2?: boolean }): number =>
  (options.suppressEmbeds === true ? MessageFlags.SuppressEmbeds : 0) | (options.suppressNotifications === true ? MessageFlags.SuppressNotifications : 0) | (options.v2 === true ? MessageFlags.IsComponentsV2 : 0)

const fileOf = (file: FileUpload): File => new File([file.data], file.name, { type: file.contentType ?? "application/octet-stream" })

/** A create payload as dfx's `MessageCreateRequest`, and its files. */
export const createRequest = (payload: MessagePayload): WireCreate => {
  const files = payload.files ?? []
  const shared = {
    allowed_mentions: allowedMentions(payload.mentions),
    ...(payload.reply === undefined ? {} : { message_reference: { message_id: payload.reply.messageId, fail_if_not_exists: payload.reply.failIfMissing ?? true } })
  }
  if (isV2(payload)) {
    const flags = flagsOf({ suppressEmbeds: payload.suppressEmbeds ?? false, suppressNotifications: payload.suppressNotifications ?? false, v2: true })
    return { request: { ...shared, flags, components: payload.componentsV2.map(v2) }, files: files.map(fileOf) }
  }
  const legacy: CreateMessage = payload
  const flags = flagsOf({ suppressEmbeds: legacy.suppressEmbeds ?? false, suppressNotifications: legacy.suppressNotifications ?? false })
  return {
    request: {
      ...shared,
      ...(legacy.content === undefined ? {} : { content: legacy.content }),
      ...(legacy.embeds === undefined ? {} : { embeds: legacy.embeds.map(embed) }),
      ...(legacy.stickers === undefined ? {} : { sticker_ids: legacy.stickers.map((sticker) => sticker.id) }),
      ...(legacy.poll === undefined
        ? {}
        : {
          poll: {
            question: { text: legacy.poll.question },
            answers: legacy.poll.answers.map((text) => ({ poll_media: { text } })),
            duration: legacy.poll.durationHours,
            allow_multiselect: legacy.poll.allowMultiselect ?? false
          }
        }),
      ...(legacy.components === undefined ? {} : { components: legacy.components.map(actionRow) }),
      ...(legacy.tts === undefined ? {} : { tts: legacy.tts }),
      ...(flags === 0 ? {} : { flags })
    },
    files: files.map(fileOf)
  }
}

/** An edit as dfx's `MessageEditRequestPartial`, with `allowed_mentions` always resent (H-111). */
export const editRequest = (patch: EditMessage): MessageEditRequestPartial => ({
  allowed_mentions: allowedMentions(patch.mentions),
  ...(patch.content === undefined ? {} : { content: patch.content }),
  ...(patch.embeds === undefined ? {} : { embeds: patch.embeds.map(embed) }),
  ...(patch.components === undefined ? {} : { components: patch.components.map(actionRow) }),
  ...(patch.suppressEmbeds === undefined ? {} : { flags: patch.suppressEmbeds ? MessageFlags.SuppressEmbeds : 0 })
})
