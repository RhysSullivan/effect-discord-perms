/**
 * The handler boundary (DESIGN §2.7, D1 with a change, D6; `[sd:src/bot.ts]`). A handler registered with
 * `Bot.on` compiles only if every error it can still fail with is purely `transient`. Anything else, an error in
 * a non-transient category (even if it is also transient) or an uncategorised user error, turns the handler's
 * result type into {@link UnhandledErrors}, whose one property names what is left: the non-transient
 * categories (at most four, so the message never truncates) and the tags of the uncategorised errors. The
 * handler's own hover still lists every tag.
 *
 * Opting out is explicit and greppable: `catchCategory`, `catchTag`, or `Effect.orDie`.
 */
import { Effect } from "effect"
import type { Categories, CategoryMarker, CategoryTypeId } from "../errors/Category.ts"

/** The categories a handler must not leave unhandled. */
export type NonTransient = "permission" | "payload" | "access" | "state"

/**
 * D6: everything that is not in `transient`, plus anything in a non-transient category (an error in both is not
 * purely transient). It is defined from `transient`, not by subtracting "some category", so an error type widened to
 * a categorised supertype (`Categorized<never>`, `Categorized<string>`), which carries no category the boundary can
 * read, stays unhandled (after the final audit: subtracting `CategoryMarker<string>` let both through).
 */
export type Unhandled<E> = Exclude<E, CategoryMarker<"transient">> | Extract<E, CategoryMarker<NonTransient>>

/** The tag of an error the boundary cannot place in a non-transient category, for its message. */
export type TagOf<E> = unknown extends E
  ? "unknown (fix the errors above first)"
  : E extends { readonly _tag: infer T extends string }
    ? T
    : E extends { readonly [CategoryTypeId]: unknown }
      ? "a widened categorised type (keep each error's own class)"
      : "<untagged>"

/**
 * Shown instead of the handler's Effect when errors other than purely transient ones escape it: what to handle,
 * as the non-transient categories and the uncategorised tags.
 */
export interface UnhandledErrors<What extends string> {
  readonly "unhandled errors: catchCategory these categories (catchTag these tags), or use Effect.orDie": What
}

/** Shown instead of a handler's result when it is not an Effect at all (a plain value, a Promise). */
export interface MustReturnEffect {
  readonly "a handler must return an Effect": true
}

/**
 * A handler's result: its Effect when only transient errors remain, else the {@link UnhandledErrors} message. A result
 * tsc infers nothing from (every parameter `unknown`: a number, a Promise) is {@link MustReturnEffect}.
 */
export type Handled<A, E, R> = [Unhandled<E>] extends [never]
  ? Effect.Effect<A, E, R>
  : unknown extends E
    ? unknown extends A
      ? unknown extends R
        ? MustReturnEffect
        : UnhandledErrors<"unknown (fix the errors above first)">
      : UnhandledErrors<"unknown (fix the errors above first)">
    : UnhandledErrors<Extract<Categories<Unhandled<E>>, NonTransient> | TagOf<Exclude<Unhandled<E>, CategoryMarker<NonTransient>>>>

/**
 * A handler's checked result as the Effect it is at run time (internal: `bot.on` and the interaction runner).
 * `Handled<A, E, R>` is the Effect itself whenever the program compiles (the boundary's message type has no runtime
 * value), so the overload attaches the precise type to the wide implementation (rule 7 of §2.12); anything else is a
 * defect naming `what`.
 */
export function handledEffect<A, E, R>(value: Handled<A, E, R>, what: string): Effect.Effect<A, E, R>
// SAFETY: the wide implementation only passes the value through. `Handled<A, E, R>` resolves to `Effect<A, E, R>`
// in every program that compiles, and `UnhandledErrors` is a type with no runtime value, so the value is that Effect.
export function handledEffect(value: Effect.Effect<unknown, unknown, unknown> | UnhandledErrors<string> | MustReturnEffect, what: string): Effect.Effect<unknown, unknown, unknown> {
  return Effect.isEffect(value) ? value : Effect.die(new Error(`${what}: a handler returned no Effect`))
}
