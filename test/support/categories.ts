/**
 * Test helpers that read the category marker the way an observer would: through the prototype chain, with
 * `Predicate` guards instead of untyped reflection.
 */
import { Predicate } from "effect"
import { CategoryTypeId } from "../../src/errors/Category.ts"

/** The sorted category names on `value`'s marker (inherited or own), or none. */
export const categoriesOf = (value: object): ReadonlyArray<string> => {
  const marker = Predicate.hasProperty(value, CategoryTypeId) ? value[CategoryTypeId] : undefined
  return Predicate.isObject(marker) ? Object.keys(marker).sort() : []
}

/** The marker object itself, or `undefined` when `value` has none. */
export const markerOf = (value: object): object | undefined => {
  const marker = Predicate.hasProperty(value, CategoryTypeId) ? value[CategoryTypeId] : undefined
  return Predicate.isObject(marker) ? marker : undefined
}

/** The object in `value`'s prototype chain that owns the marker, or `null`. */
export const markerOwner = (value: object): object | null => {
  let current: object | null = Object.getPrototypeOf(value)
  while (current !== null && !Object.hasOwn(current, CategoryTypeId)) current = Object.getPrototypeOf(current)
  return current
}
