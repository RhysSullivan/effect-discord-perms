/**
 * DM handles (DESIGN §2.4 `DMChannel`, §2.5; M7): what a DM `MESSAGE_CREATE` delivers (§2.7's DM branch).
 *
 * A DM has no guild, no overwrites and no permission state, so these operations run no preflight and no
 * recompute: each goes through `DiscordApi.executeDirect`, which maps Discord's answer against the operation's
 * row (`dm.send`: `CannotMessageUser` 50007, `RateLimited`, `UnknownChannel`; a DM message's edit and delete use
 * the channel rows, `MsgOp<"dm", ...>`) and gives a permission-like refusal the code's own tag, never a guess.
 * The local checks (limits, emptiness) run first, as in a guild. Nothing here is live-tested: a bot cannot DM
 * another bot and the harness never DMs Rhys (Q-17); the unit tests drive it through a fake gateway.
 */
import { Effect, Schema } from "effect"
import { PreflightDecision } from "../errors/Cause.ts"
import type { OpErrors } from "../permissions/Operations.ts"
import * as Limits from "../payload/Limits.ts"
import type { EditArg, EditMessage } from "../payload/Message.ts"
import { type ContentTooLongIn, type EditEmbedTooLargeIn, type EditMessageEmptyIn, features } from "../payload/PayloadRules.ts"
import * as ToDfx from "../payload/ToDfx.ts"
import * as Schemas from "../rest/Schemas.ts"
import type { ChannelId, UserId } from "../Snowflake.ts"
import type { DMChannel, SendMethod } from "./Channel.ts"
import type { AnyMessage, EditOwnMethod, ForeignMessage, OwnMessage } from "./Message.ts"
import { createLimits, degradedOf, type Runtime, sendMethodOf, type Wide, type WideError } from "./Ops.ts"

/** What a DM handle's methods close over. */
interface DirectCore {
  readonly runtime: Runtime
  readonly channelId: ChannelId
}

const messagesRoute = "/channels/{channel.id}/messages"
const messageRoute = "/channels/{channel.id}/messages/{message.id}"

const localCause = (route: string): PreflightDecision => new PreflightDecision({ route, basis: "payload-check" })

const dmSend = (core: DirectCore): SendMethod =>
  sendMethodOf((payload) => {
    const [local] = Limits.checkCreate(payload, localCause(messagesRoute))
    if (local !== undefined) return Effect.fail(local)
    const wire = ToDfx.createRequest(payload)
    return core.runtime.api
      .executeDirect({
        op: "dm.send",
        args: { payload: features(payload) },
        channelId: core.channelId,
        route: { method: "POST", template: messagesRoute },
        call: (rest) => (wire.files.length > 0 ? rest.withFiles(wire.files)(rest.createMessage(core.channelId, wire.request)) : rest.createMessage(core.channelId, wire.request)),
        response: Schemas.Message,
        limits: createLimits(payload)
      })
      .pipe(Effect.map((message) => ({ message: ownDirect(core, message), degraded: degradedOf(payload, message) })))
  })

const dmEdit = (core: DirectCore, id: Schemas.Message["id"]): EditOwnMethod<"dm"> => {
  function edit<const P extends EditMessage>(
    patch: EditArg<P>
  ): Effect.Effect<
    OwnMessage<"dm">,
    | OpErrors<never>["message.edit.channel"]
    | ContentTooLongIn<P>
    | EditEmbedTooLargeIn<P>
    | EditMessageEmptyIn<P>
  >
  function edit(patch: EditMessage): Effect.Effect<OwnMessage<"dm">, WideError> {
    const [local] = Limits.checkEdit(patch, localCause(messageRoute))
    if (local !== undefined) return Effect.fail(local)
    return core.runtime.api
      .executeDirect({
        op: "message.edit.channel",
        args: { payload: [] },
        channelId: core.channelId,
        route: { method: "PATCH", template: messageRoute },
        call: (rest) => rest.updateMessage(core.channelId, id, ToDfx.editRequest(patch)),
        response: Schemas.Message,
        limits: {
          empty: true,
          ...(patch.content === undefined ? {} : { content: { length: Limits.lengthOf(patch.content), limit: Limits.Limits.content } }),
          ...(patch.embeds !== undefined && patch.embeds.length > 0 ? { embeds: true } : {})
        }
      })
      .pipe(Effect.map((message) => ownDirect(core, message)))
  }
  return edit
}

const dmDelete = <Op extends "message.deleteOwn" | "message.deleteForeign">(core: DirectCore, id: Schemas.Message["id"], op: Op) => {
  function deleteMessage(): Effect.Effect<void, OpErrors<never>[Op]>
  function deleteMessage(): Effect.Effect<void, Wide<OpErrors<never>[Op]>> {
    return core.runtime.api.executeDirect({
      op,
      args: { payload: [] },
      channelId: core.channelId,
      route: { method: "DELETE", template: messageRoute },
      call: (rest) => rest.deleteMessage(core.channelId, id),
      response: Schema.Void,
      limits: {}
    })
  }
  return deleteMessage
}

const ownDirect = (core: DirectCore, message: Schemas.Message): OwnMessage<"dm"> => ({
  id: message.id,
  channelId: core.channelId,
  channelKind: "dm",
  guildId: undefined,
  author: "self",
  edit: dmEdit(core, message.id),
  delete: dmDelete(core, message.id, "message.deleteOwn")
})

const foreignDirect = (core: DirectCore, message: Schemas.Message): ForeignMessage<"dm"> => ({
  id: message.id,
  channelId: core.channelId,
  channelKind: "dm",
  guildId: undefined,
  author: "other",
  authorId: message.author.id,
  authorIsBot: message.author.bot === true,
  delete: dmDelete(core, message.id, "message.deleteForeign")
})

/** The handle of a DM channel with `recipientId` (internal: a DM `MESSAGE_CREATE` builds it). */
export const dmChannelHandle = (runtime: Runtime, info: { readonly id: ChannelId; readonly recipientId: UserId }): DMChannel => ({
  kind: "dm",
  id: info.id,
  recipientId: info.recipientId,
  granted: [],
  send: dmSend({ runtime, channelId: info.id })
})

/** A DM message object as a handle: own when its author is the bot (§2.5). */
export const dmMessageHandle = (runtime: Runtime, channelId: ChannelId, message: Schemas.Message): AnyMessage<"dm"> =>
  message.author.id === runtime.identity.userId ? ownDirect({ runtime, channelId }, message) : foreignDirect({ runtime, channelId }, message)
