// Component layout rules (DESIGN §2.3): at most 5 buttons in a row, a select alone in its row, no customId on a
// link button, no label on a premium button; each error is located on the offending element. After the final audit:
// no customId on a premium button, a url only on a link button, a row not empty and written as a literal list (a
// malformed element names only its own problem), and at most 5 rows in a message.
import type { TextChannel } from "../../../src/channels/Channel.ts"
import { type ActionRow, type CustomId, type InteractiveButton, linkButton, premiumButton, row, type StringSelect } from "../../../src/payload/Components.ts"

declare const b: InteractiveButton
declare const select: StringSelect
declare const a: CustomId
declare const buttons: ReadonlyArray<InteractiveButton>
declare const r: ActionRow
declare const text: TextChannel

// @valid
export const ok = [
  row([b, b, b, b, b]),
  row([select]),
  row([{ kind: "button", style: "link", label: "Docs", url: "https://example.com" }]),
  row([premiumButton({ skuId: "1" })]),
  text.send({ content: "five rows", components: [r, r, r, r, r] })
]

// @expect-error TS2322 1 to 5 buttons
export const six = row([b, b, b, b, b, b])

// @expect-error TS2322 1 to 5 buttons
export const sixInline = row([
  { kind: "button", style: "primary", label: "One", customId: a },
  { kind: "button", style: "secondary", label: "Two", customId: a },
  { kind: "button", style: "success", label: "Three", customId: a },
  { kind: "button", style: "danger", label: "Four", customId: a },
  { kind: "button", style: "primary", label: "Five", customId: a },
  { kind: "button", style: "link", label: "Docs", url: "https://example.com/docs" }
])

// @expect-error TS2322 must be alone in its row
// @expect-error TS2322 must be alone in its row
export const mixed = row([select, b])

// @expect-error TS2322 link buttons have no customId
export const linkInline = row([{ kind: "button", style: "link", label: "Docs", url: "https://example.com", customId: a }])

// @expect-error TS2322 premium buttons have no label
export const premiumInline = row([{ kind: "button", style: "premium", skuId: "123", label: "Buy" }])

// @expect-error TS2353 customId
export const link = linkButton({ label: "docs", url: "https://example.com", customId: "x" })

// @expect-error TS2353 label
export const premium = premiumButton({ skuId: "1", label: "buy" })

// @expect-error TS2322 premium buttons have no customId
export const premiumCustomId = row([{ kind: "button", style: "premium", skuId: "123", customId: a }])

// @expect-error TS2322 only link buttons have a url
export const interactiveUrl = row([{ kind: "button", style: "primary", label: "One", customId: a, url: "https://example.com" }])

// @expect-error TS2345 an action row holds 1 to 5 buttons
export const empty = row([])

// @expect-error TS2345 row takes its elements as a literal list
export const computed = row(buttons)

// only the malformed element is reported, with what it lacks, not a select message on every element
// @expect-error TS2322 customId
export const missingCustomId = row([b, { kind: "button", style: "primary", label: "Two" }])

// @expect-error TS2322 a message holds at most 5 action rows
export const sixRows = text.send({ content: "six rows", components: [r, r, r, r, r, r] })
