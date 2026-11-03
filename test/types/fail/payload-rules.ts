// Payload shape rules (DESIGN §2.3): a message needs a body, Components V2 excludes the legacy body fields, and
// only keys valid in the context exist; each error sits on the offending property.
import type { TextChannel } from "../../../src/channels/Channel.ts"
import type { OwnMessage } from "../../../src/channels/Message.ts"
import { textDisplay } from "../../../src/payload/Components.ts"

declare const text: TextChannel
declare const own: OwnMessage<"text">
const display = textDisplay("lab")

// @valid
export const ok = [text.send({ content: "hi" }), own.edit({ content: "hi" }), text.send({ componentsV2: [display] }), text.send({ content: "hi", suppressNotifications: true })]

// @expect-error TS2741 a message needs
text.send({})

// @expect-error TS2345 a message needs
text.send({ content: "", embeds: [] })

// @expect-error TS2322 content is not allowed in a componentsV2 message
text.send({ componentsV2: [display], content: "hi" })

// @expect-error TS2322 embeds is not allowed in a componentsV2 message
text.send({ componentsV2: [display], embeds: [{ title: "a title", description: "a fairly long description to see the size" }] })

// @expect-error TS2322 ephemeral is not valid when creating a message
text.send({ content: "hi", ephemeral: true })

// @expect-error TS2322 suppressNotifications is not valid when editing a message
own.edit({ content: "hi", suppressNotifications: true })

// @expect-error TS2322 allowed_mentions is not valid when creating a message
text.send({ content: "hi", allowed_mentions: { parse: ["everyone"] } })
