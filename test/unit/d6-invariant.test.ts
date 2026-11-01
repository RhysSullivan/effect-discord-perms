import { describe, expect, it } from "vitest"
import * as Errors from "../../src/errors/index.ts"
import { categoriesOf } from "../support/categories.ts"

/**
 * Invariant D6 over every library error (`AllErrors`, enumerated through `ErrorClasses`; DESIGN §2.2): every
 * error has at least one of the five categories and no other, and an error in `transient` has no other
 * category. The handler boundary lets `transient` errors escape, so a transient error that was also `state`
 * would let a state failure through unhandled.
 */

const libraryCategories: ReadonlySet<string> = new Set(["permission", "payload", "access", "state", "transient"])

/** Whether an exported value is an error class: a constructor with `Error` in its static prototype chain. */
const isErrorClass = (value: unknown): boolean => typeof value === "function" && Object.prototype.isPrototypeOf.call(Error, value)

/** The names of every error class the barrel exports. */
const exportedErrorClasses = Object.entries(Errors)
  .filter(([, value]) => isErrorClass(value))
  .map(([name]) => name)

describe("ErrorClasses", () => {
  it("enumerates every error class the barrel exports, under its own name", () => {
    const listed = Object.entries(Errors.ErrorClasses).map(([name, Class]) => [name, Class.name])
    expect(listed.every(([name, className]) => name === className)).toBe(true)
    expect(Object.keys(Errors.ErrorClasses).sort()).toEqual([...exportedErrorClasses].sort())
  })
})

describe("D6", () => {
  for (const [name, Class] of Object.entries(Errors.ErrorClasses)) {
    it(`${name} has library categories only, and transient alone`, () => {
      const categories = categoriesOf(Class.prototype)
      expect(categories.length).toBeGreaterThan(0)
      expect(categories.filter((category) => !libraryCategories.has(category))).toEqual([])
      if (categories.includes("transient")) expect(categories).toEqual(["transient"])
    })
  }

  it("the transient errors are exactly DiscordUnavailable, NetworkError, RateLimited and RequestTimedOut", () => {
    const transient = Object.entries(Errors.ErrorClasses)
      .filter(([, Class]) => categoriesOf(Class.prototype).includes("transient"))
      .map(([name]) => name)
      .sort()
    expect(transient).toEqual(["DiscordUnavailable", "NetworkError", "RateLimited", "RequestTimedOut"])
  })
})
