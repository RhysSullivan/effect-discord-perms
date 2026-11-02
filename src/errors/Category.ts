/**
 * Error categories (DESIGN §2.2, D3, D4): the Effect v4 port of Mike Arnaldi's gist and Ethan Niser's post.
 * Neither Effect 4.1.1 nor dfx ships an equivalent; `Effect.catchReason` is a different model (effect-v4 §4).
 *
 * - `withCategory(...)` is a pipeable mixin for `Schema.TaggedError` classes. It subclasses the schema class
 *   and puts a frozen marker object on the subclass prototype. The marker is not an own field, so it is never
 *   encoded or serialised, and an error keeps its tag while belonging to several categories.
 * - `catchCategory(...)` removes exactly the members of the caught categories from the error channel.
 *
 * The categories in use are `permission | payload | access | state | transient`. Invariant D6: an error in
 * `transient` has no other category.
 */
import { Effect, Function, Predicate, type Schema } from "effect"

/** The prototype key that holds an error class's category marker. */
export const CategoryTypeId: unique symbol = Symbol.for("effect-discord-perms/ErrorCategory")
/** The prototype key that holds an error class's category marker. */
export type CategoryTypeId = typeof CategoryTypeId

/** The type-level marker carried by every categorised error instance: one `true` key per category. */
export interface Categorized<K extends string> {
  readonly [CategoryTypeId]: { readonly [P in K]: true }
}

/** Every category name present in an error union. */
export type Categories<E> = E extends { readonly [CategoryTypeId]: infer M } ? Extract<keyof M, string> : never

/**
 * A union of single-category markers, so `Extract<E, CategoryMarker<"a" | "b">>` is the members of `E` that are
 * in `a` or in `b`.
 */
export type CategoryMarker<K extends string> = K extends string ? { readonly [CategoryTypeId]: { readonly [P in K]: true } } : never

/** The members of `E` that belong to at least one of the categories `K`. */
export type ExtractCategory<E, K extends string> = Extract<E, CategoryMarker<K>>
/** The members of `E` that belong to none of the categories `K`. */
export type ExcludeCategory<E, K extends string> = Exclude<E, ExtractCategory<E, K>>

type AnySchemaClass = Schema.Class<unknown, Schema.Struct<Schema.Struct.Fields>, object>

/**
 * A pipeable mixin that adds categories to a schema error class:
 *
 * ```ts
 * class MissingEmbedLinks extends Schema.TaggedError<MissingEmbedLinks>()("MissingEmbedLinks", { cause: ErrorCause })
 *   .pipe(withCategory("permission", "payload")) {}
 * ```
 *
 * It is typed against `Schema.Class`, so every static (`make`, `fields`, `ast`, `extend`, ...) is preserved and
 * the marker is intersected into the instance type through the class's `Inherited` slot. Applied to a class
 * that already has categories (the D5 variants), the new class carries the union of both, and the base class's
 * marker is left unchanged.
 */
export function withCategory<const K extends ReadonlyArray<string>>(
  ...categories: K
): <Self, S extends Schema.Struct<Schema.Struct.Fields>, Inherited>(
  base: Schema.Class<Self, S, Inherited>
) => Schema.Class<Self, S, Inherited & Categorized<K[number]>>
// SAFETY: the one trust boundary of this module. The implementation signature is wider than the public one;
// the runtime invariant is that the returned class is a subclass of `base` whose prototype carries a marker
// with a `true` key for every inherited and every listed category, which is exactly `Categorized<K[number]>`.
export function withCategory(...categories: ReadonlyArray<string>) {
  return (base: AnySchemaClass): AnySchemaClass => {
    const inherited: object =
      Predicate.hasProperty(base.prototype, CategoryTypeId) && Predicate.isObject(base.prototype[CategoryTypeId])
        ? base.prototype[CategoryTypeId]
        : {}
    const marker: Record<string, true> = { ...inherited }
    for (const category of categories) marker[category] = true
    const Mixed = class extends base {}
    // A fresh frozen object per class: an inherited marker is copied, never mutated (the gist mutates it).
    Object.defineProperty(Mixed.prototype, CategoryTypeId, {
      value: Object.freeze(marker),
      enumerable: false,
      writable: false,
      configurable: false
    })
    return Mixed
  }
}

/**
 * A refinement that is true for errors in at least one of `categories`. Accepts one category or a non-empty
 * array (any-of).
 */
export const hasCategory = <E, const K extends string>(categories: K | Readonly<[K, ...Array<K>]>) => {
  const list: ReadonlyArray<string> = typeof categories === "string" ? [categories] : categories
  return (error: E): error is ExtractCategory<E, K> => {
    if (!Predicate.hasProperty(error, CategoryTypeId)) return false
    const marker = error[CategoryTypeId]
    return Predicate.isObject(marker) && list.some((category) => marker[category] === true)
  }
}

/**
 * Like `Effect.catchTag`, but by category: one category or a non-empty array (any-of). Dual: data-first and
 * data-last.
 *
 * Every listed category must be present in `E`, as with `catchTag` and an absent tag: catching a category the
 * effect cannot fail with is a compile error (a dead handler). The remaining error type is exactly the members
 * of `E` in none of the categories, plus the handler's own errors.
 */
export const catchCategory: {
  <const K extends Categories<E>, E, A2, E2, R2>(
    categories: K | Readonly<[K, ...Array<K>]>,
    // No NoInfer<E> here: with `Extract<NoInfer<E>, ...>` the handler parameter collapses to `never` in
    // data-last (pipe) position (effect-v4 gotcha 1; rule 6 of DESIGN §2.12).
    f: (error: ExtractCategory<E, K>) => Effect.Effect<A2, E2, R2>
  ): <A, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A | A2, E2 | ExcludeCategory<E, K>, R | R2>
  <A, E, R, const K extends Categories<E>, A2, E2, R2>(
    self: Effect.Effect<A, E, R>,
    categories: K | Readonly<[K, ...Array<K>]>,
    f: (error: ExtractCategory<E, K>) => Effect.Effect<A2, E2, R2>
  ): Effect.Effect<A | A2, E2 | ExcludeCategory<E, K>, R | R2>
} = Function.dual(
  3,
  <A, E, R, const K extends Categories<E>, A2, E2, R2>(
    self: Effect.Effect<A, E, R>,
    categories: K | Readonly<[K, ...Array<K>]>,
    f: (error: ExtractCategory<E, K>) => Effect.Effect<A2, E2, R2>
  ): Effect.Effect<A | A2, E2 | ExcludeCategory<E, K>, R | R2> => {
    // Bound to a const first: as the arrow's expression body, contextually typed by the declared return type,
    // `catchIf` infers a wider success type and tsc rejects the body (TS2375).
    const caught = Effect.catchIf(self, hasCategory<E, K>(categories), f)
    return caught
  }
)

/**
 * The sorted category names an error carries at run time, read from its marker (inherited through the
 * prototype chain); none for a value without one. The matrix records these next to each tag, so same-tag D5
 * variants are told apart (§5.12).
 */
export const categoriesOf = (value: object): ReadonlyArray<string> => {
  const marker = Predicate.hasProperty(value, CategoryTypeId) ? value[CategoryTypeId] : undefined
  return Predicate.isObject(marker) ? Object.keys(marker).sort() : []
}
