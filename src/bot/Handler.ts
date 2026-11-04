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
import type { Effect } from "effect"
import type { Categories, CategoryMarker } from "../errors/Category.ts"

/** The categories a handler must not leave unhandled. */
export type NonTransient = "permission" | "payload" | "access" | "state"

/** D6 as researched: the members with any non-transient category, and those with no category at all. */
export type Unhandled<E> = Extract<E, CategoryMarker<NonTransient>> | Exclude<E, CategoryMarker<string>>

/** An uncategorised error's tag, for the boundary's message. */
export type TagOf<E> = unknown extends E ? "unknown (fix the errors above first)" : E extends { readonly _tag: infer T extends string } ? T : "<untagged>"

/**
 * Shown instead of the handler's Effect when errors other than purely transient ones escape it: what to handle,
 * as the non-transient categories and the uncategorised tags.
 */
export interface UnhandledErrors<What extends string> {
  readonly "unhandled errors: catchCategory these categories (catchTag these tags), or use Effect.orDie": What
}

/** A handler's result: its Effect when only transient errors remain, else the {@link UnhandledErrors} message. */
export type Handled<A, E, R> = [Unhandled<E>] extends [never]
  ? Effect.Effect<A, E, R>
  : UnhandledErrors<Extract<Categories<Unhandled<E>>, NonTransient> | TagOf<Exclude<E, CategoryMarker<string>>>>
