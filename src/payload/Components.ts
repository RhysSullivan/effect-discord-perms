/**
 * Message components (DESIGN §2.3, `[sd:src/payload.ts]`): buttons, string selects, action rows, and the
 * Components V2 text display.
 *
 * Layout rules are checked per element of the array `row([...])` takes, so tsc locates each error on the
 * offending element or property, in 2-3 lines whatever the row's size (rule 3 of §2.12):
 *
 * - an action row holds 1 to 5 buttons (H-128), and a message at most 5 rows (`MessageRows`);
 * - a select menu must be alone in its row (H-128); the test is `"string-select" extends C[number]["kind"]`, so a
 *   row whose element type may be a select counts (rule 4 of §2.12);
 * - a link button has no `customId`, a premium button no `label` (H-129) and no `customId`, and only a link button has a
 *   `url` (after the final audit: the last two compiled and were dropped from the request);
 * - a row's elements are a literal list, so the checks can see them, and a row is not empty.
 *
 * An `ActionRow` can only come from `row`. A `customId` is a branded `CustomId`, which only a `ComponentRoute`
 * makes (`src/components/CustomId.ts`, §2.9).
 */
import { Schema } from "effect"

declare const InvalidId: unique symbol
/**
 * A message carried by a type error. Intersected onto an offending element or property, it does not collapse
 * like `never` would, so tsc reports the error at that element with this message (rule 2 of §2.12). Never
 * constructed at run time.
 */
export interface Invalid<Msg extends string> {
  readonly [InvalidId]: Msg
}

/** A component's `custom_id`, at most 100 characters (H-130). Only a `ComponentRoute` builds one (§2.9). */
export const CustomId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).pipe(Schema.brand("CustomId"))
/** A component's `custom_id`. */
export type CustomId = typeof CustomId.Type

/** A button that sends an interaction back (styles 1-4). */
export interface InteractiveButton {
  readonly kind: "button"
  readonly style: "primary" | "secondary" | "success" | "danger"
  readonly label: string
  readonly customId: CustomId
}
/** A button that opens a URL (style 5): no `customId`. */
export interface LinkButton {
  readonly kind: "button"
  readonly style: "link"
  readonly label: string
  readonly url: string
}
/** A button that starts a purchase (style 6): no label, no `customId`. */
export interface PremiumButton {
  readonly kind: "button"
  readonly style: "premium"
  readonly skuId: string
}
/** Any button. */
export type Button = InteractiveButton | LinkButton | PremiumButton
/** One option of a string select. */
export interface SelectOption {
  readonly label: string
  readonly value: string
}
/** A string select menu (type 3). */
export interface StringSelect {
  readonly kind: "string-select"
  readonly customId: CustomId
  readonly options: ReadonlyArray<SelectOption>
}
/** What an action row holds. */
export type RowElement = Button | StringSelect

type ElementCheck<X, I extends string, HasSelect extends boolean, Len extends number> = HasSelect extends true
  ? Len extends 1
    ? X
    : X & Invalid<"a select menu must be alone in its row">
  : I extends "5" | "6" | "7" | "8" | "9" | "10"
    ? X & Invalid<"an action row holds 1 to 5 buttons">
    : X extends { readonly style: "link"; readonly customId: unknown }
      ? { readonly [K in keyof X]: K extends "customId" ? X[K] & Invalid<"link buttons have no customId"> : X[K] }
      : X extends { readonly style: "premium"; readonly label: unknown } | { readonly style: "premium"; readonly customId: unknown }
        ? {
            readonly [K in keyof X]: K extends "label" ? X[K] & Invalid<"premium buttons have no label"> : K extends "customId" ? X[K] & Invalid<"premium buttons have no customId"> : X[K]
          }
        : X extends { readonly style: InteractiveButton["style"]; readonly url: unknown }
          ? { readonly [K in keyof X]: K extends "url" ? X[K] & Invalid<"only link buttons have a url"> : X[K] }
          : X

/**
 * The per-element checks of a row literal. A list whose type is not a tuple is an error on the list: its layout cannot
 * be checked (and when an element of a literal is malformed, tsc falls back to that type, so this keeps the select and
 * count messages off the valid elements and reports only the real problem; after the final audit). An empty row is an
 * error too (H-128).
 */
export type RowChecked<C extends ReadonlyArray<RowElement>> = number extends C["length"]
  ? Invalid<"row takes its elements as a literal list: row([...])">
  : C["length"] extends 0
    ? Invalid<"an action row holds 1 to 5 buttons, or one select menu">
    : {
        readonly [I in keyof C]: ElementCheck<C[I], I & string, "string-select" extends C[number]["kind"] ? true : false, C["length"]>
      }

/** Brands an action row: only {@link row} makes one. */
export const RowTypeId: unique symbol = Symbol.for("effect-discord-perms/ActionRow")

/** An action row (type 1). Only {@link row} makes one, so its layout was checked. */
export interface ActionRow {
  readonly [RowTypeId]: "ActionRow"
  readonly components: ReadonlyArray<RowElement>
}

/**
 * The only way to make an `ActionRow`. It takes an array, not varargs, so tsc locates each layout error on
 * the offending element (inline literals included, which varargs would not excess-check).
 */
export const row = <const C extends ReadonlyArray<RowElement>>(components: C & RowChecked<C>): ActionRow => ({ [RowTypeId]: "ActionRow", components })

/** A link button's fields: an excess `customId` is an error at the property. */
export interface LinkButtonInput {
  readonly label: string
  readonly url: string
}
/** A premium button's fields: an excess `label` is an error at the property. */
export interface PremiumButtonInput {
  readonly skuId: string
}

/** A link button, for buttons declared outside a `row` literal (excess-property checked). */
export const linkButton = (input: LinkButtonInput): LinkButton => ({ kind: "button", style: "link", label: input.label, url: input.url })

/** A premium button, for buttons declared outside a `row` literal (excess-property checked). */
export const premiumButton = (input: PremiumButtonInput): PremiumButton => ({ kind: "button", style: "premium", skuId: input.skuId })

/** Brands a Components V2 component: only the constructors below make one. */
export const V2TypeId: unique symbol = Symbol.for("effect-discord-perms/V2Component")

/** A Components V2 component (H-125). Phase 1 has the text display (type 10). */
export interface V2Component {
  readonly [V2TypeId]: "V2Component"
  readonly type: 10
  readonly content: string
}

/** A Components V2 text display (type 10). */
export const textDisplay = (content: string): V2Component => ({ [V2TypeId]: "V2Component", type: 10, content })
