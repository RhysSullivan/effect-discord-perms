import { describe, expect, it } from "vitest"
import {
  ErrorCategories,
  PermissionErrorClasses,
  PermissionFlags,
  type PermissionFlag,
  PreflightDecision
} from "../../src/errors/index.ts"
import { errorFor, type OpName, Operations, type Variant } from "../../src/permissions/Operations.ts"
import { categoriesOf } from "../support/categories.ts"

/**
 * `errorFor` builds, for every (operation, flag), exactly the class the operation's D5 variant promises, and
 * that class's runtime categories are the ones `ErrorCategories` (generated from the category table) lists
 * (DESIGN §2.2, §4.7, M1).
 */

const cause = new PreflightDecision({ route: "POST /channels/{channel_id}/messages", basis: "gateway-state" })
const isPermissionErrorClassName = (name: string): name is keyof typeof PermissionErrorClasses => Object.hasOwn(PermissionErrorClasses, name)
const operations: ReadonlyArray<OpName> = Object.keys(Operations).filter((name): name is OpName => Object.hasOwn(Operations, name))

/**
 * The test's own oracle for the class a variant promises, written from the variant definitions of §2.2 and
 * §3.1 rather than read from the implementation: only ReadMessageHistory differs, as `...ForReply` for
 * operations that may reply and `...ForReaction` for reactions.
 */
const promisedClass: { readonly [V in Variant]: (flag: PermissionFlag) => keyof typeof ErrorCategories } = {
  default: (flag) => `Missing${flag}`,
  reply: (flag) => (flag === "ReadMessageHistory" ? "MissingReadMessageHistoryForReply" : `Missing${flag}`),
  reaction: (flag) => (flag === "ReadMessageHistory" ? "MissingReadMessageHistoryForReaction" : `Missing${flag}`)
}

describe("ErrorCategories", () => {
  it("lists every permission error class and nothing else", () => {
    expect(Object.keys(ErrorCategories).sort()).toEqual(Object.keys(PermissionErrorClasses).sort())
    expect(Object.keys(ErrorCategories)).toHaveLength(PermissionFlags.length + 2)
  })

  it("matches the categories each class carries at run time", () => {
    for (const name of Object.keys(PermissionErrorClasses).filter(isPermissionErrorClassName)) {
      const Class = PermissionErrorClasses[name]
      expect({ name, categories: categoriesOf(Class.prototype) }).toEqual({ name, categories: ErrorCategories[name] })
    }
  })
})

describe("errorFor", () => {
  it("covers every operation of the table", () => {
    expect(operations).toHaveLength(40)
  })

  it("builds the promised class, tag, flag and categories for every (operation, flag)", () => {
    let checked = 0
    for (const op of operations) {
      for (const flag of PermissionFlags) {
        const error = errorFor(op, flag, cause)
        const name = promisedClass[Operations[op].variant](flag)
        const Promised = PermissionErrorClasses[name]
        const where = `${op} ${flag}`
        expect({ where, exactClass: Object.getPrototypeOf(error) === Promised.prototype }).toEqual({ where, exactClass: true })
        expect({ where, tag: error._tag, flag: error.flag }).toEqual({ where, tag: `Missing${flag}`, flag })
        expect({ where, categories: categoriesOf(error) }).toEqual({ where, categories: ErrorCategories[name] })
        expect(error.cause).toBe(cause)
        checked++
      }
    }
    expect(checked).toBe(40 * PermissionFlags.length)
  })

  it("builds the payload variant for a reply, the access variant for a reaction and the base class otherwise", () => {
    expect(categoriesOf(errorFor("channel.send", "ReadMessageHistory", cause))).toEqual(["payload", "permission"])
    expect(categoriesOf(errorFor("message.react.channel", "ReadMessageHistory", cause))).toEqual(["access", "permission"])
    expect(categoriesOf(errorFor("message.pin.channel", "ReadMessageHistory", cause))).toEqual(["permission"])
  })
})
