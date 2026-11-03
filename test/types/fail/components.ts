// Component layout rules (DESIGN §2.3): at most 5 buttons in a row, a select alone in its row, no customId on a
// link button, no label on a premium button; each error is located on the offending element.
import { type CustomId, type InteractiveButton, linkButton, premiumButton, row, type StringSelect } from "../../../src/payload/Components.ts"

declare const b: InteractiveButton
declare const select: StringSelect
declare const a: CustomId

// @valid
export const ok = [row([b, b, b, b, b]), row([select]), row([{ kind: "button", style: "link", label: "Docs", url: "https://example.com" }]), row([premiumButton({ skuId: "1" })])]

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
