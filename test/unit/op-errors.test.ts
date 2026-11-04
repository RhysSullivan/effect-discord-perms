import * as fs from "node:fs"
import { Predicate, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Predict from "../../harness/Predict.ts"
import { scenarios } from "../../harness/scenario/catalog/index.ts"
import * as TruthTable from "../../harness/TruthTable.ts"
import { DiscordResponse, FieldError, PreflightDecision } from "../../src/errors/Cause.ts"
import { ErrorClasses } from "../../src/errors/index.ts"
import { ErrorCategories, PermissionFlags } from "../../src/errors/Missing.generated.ts"
import { errorFor, type OpName, Operations } from "../../src/permissions/Operations.ts"
import { type DecideArgs, toHandleError } from "../../src/permissions/Preflight.ts"
import { payloadRuleNames } from "../../src/payload/PayloadRules.ts"
import { Codes, codes, type LimitFacts, limitFields, mapResponse } from "../../src/rest/ErrorMap.ts"
import { categoriesOf } from "../support/categories.ts"
import { declaredTags, promisedClass } from "../support/declared.ts"

/**
 * Every error an operation can produce at run time is one its type declares (DESIGN §4.7): the tag is in the
 * row's tags, or is `Missing<F>` for F in the row's flags or the payload's flags, or is a payload- or
 * argument-derived tag of §2.3-§2.6; and every instance has its class's runtime categories. It enumerates every
 * row of the error map for every operation, and every outcome `Preflight.decide` and the recompute (which
 * decides with the same function, `Recompute.ts`) give the truth table's rows (the replay's fixtures).
 */
const operations: ReadonlyArray<OpName> = Object.keys(Operations).filter((name): name is OpName => Object.hasOwn(Operations, name))
const classes: Readonly<Record<string, object>> = ErrorClasses

/** The runtime categories `error`'s class promises: `ErrorCategories` for a permission class, else its marker. */
const promisedCategories = (op: OpName, error: { readonly _tag: string }): ReadonlyArray<string> => {
  if (error._tag.startsWith("Missing") && Predicate.hasProperty(error, "flag") && typeof error.flag === "string") {
    const flag = PermissionFlags.find((candidate) => candidate === error.flag)
    if (flag !== undefined) return ErrorCategories[promisedClass(op, flag)]
  }
  const Class = classes[error._tag]
  return Class !== undefined && "prototype" in Class && Predicate.isObject(Class.prototype) ? categoriesOf(Class.prototype) : ["(no class)"]
}

const length = { length: 9999, limit: 2000 }

/** The widest request an operation can make: every payload feature (send and post rows) and every limit field it may declare. */
const widest = (op: OpName): { readonly args: DecideArgs; readonly limits: LimitFacts } => {
  const takesPayload = Operations[op].variant === "reply"
  const fields = limitFields[op] ?? []
  const limits: LimitFacts = {
    ...(fields.includes("empty") ? { empty: true } : {}),
    ...(fields.includes("content") ? { content: length } : {}),
    ...(fields.includes("embeds") ? { embeds: true } : {}),
    ...(fields.includes("poll") ? { poll: true } : {}),
    ...(fields.includes("name") ? { name: length } : {}),
    ...(fields.includes("topic") ? { topic: length } : {}),
    ...(fields.includes("slowmode") ? { slowmode: { seconds: 99999 } } : {}),
    ...(fields.includes("nick") ? { nick: length } : {}),
    ...(fields.includes("timeout") ? { timeout: true } : {}),
    ...(fields.includes("messageCount") ? { messageCount: 101 } : {})
  }
  // a reaction with another guild's emoji also needs UseExternalEmojis (`extraFlags`, M6)
  const reacts = Operations[op].variant === "reaction"
  return { args: { payload: takesPayload ? payloadRuleNames : [], ...(reacts ? { extraFlags: ["UseExternalEmojis"] } : {}) }, limits }
}

/** One inner 50035 error per field the request declares, at the path Discord reports it (§4.9). */
const fieldErrorsFor = (op: OpName, limits: LimitFacts): ReadonlyArray<FieldError> => {
  const message = op === "forum.createPost" ? ["message"] : []
  const at = (path: ReadonlyArray<string>) => new FieldError({ path, code: "BASE_TYPE_MAX_LENGTH", message: "too long" })
  return [
    ...(limits.content === undefined ? [] : [at([...message, "content"])]),
    ...(limits.embeds === undefined ? [] : [at([...message, "embeds", "0", "title"])]),
    ...(limits.poll === undefined ? [] : [at([...message, "poll", "question", "text"])]),
    ...(limits.name === undefined ? [] : [at(["name"])]),
    ...(limits.topic === undefined ? [] : [at(["topic"])]),
    ...(limits.slowmode === undefined ? [] : [at(["rate_limit_per_user"])]),
    ...(limits.nick === undefined ? [] : [at(["nick"])]),
    ...(limits.timeout === undefined ? [] : [at(["communication_disabled_until"])])
  ]
}

describe("every row of the error map, for every operation", () => {
  it("maps only to errors the operation declares, each with its class's categories", () => {
    let mapped = 0
    for (const op of operations) {
      const { args, limits } = widest(op)
      const declared = declaredTags(op, args)
      for (const code of codes) {
        const entry = Codes[code]
        if (entry === undefined) continue
        for (const status of entry.statuses) {
          const response = new DiscordResponse({ status, code, message: "x", method: "POST", route: "/test", fieldErrors: code === 50035 ? fieldErrorsFor(op, limits) : [], attributedBy: "code" })
          const result = mapResponse({ op, args, limits }, response, 1500)
          if (result._tag === "Unmapped") continue
          const error = result._tag === "Fail" ? result.error : result.fallback
          const where = `${op} ${status} ${code}`
          expect({ where, declared: declared.has(error._tag) }).toEqual({ where, declared: true })
          expect({ where, categories: categoriesOf(error) }).toEqual({ where, categories: promisedCategories(op, error) })
          mapped++
        }
      }
    }
    expect(mapped).toBeGreaterThan(operations.length * 3)
  })

  it("maps the permission-like codes for every operation that sends a guild request", () => {
    for (const op of operations) {
      const response = new DiscordResponse({ status: 403, code: 50013, message: "Missing Permissions", method: "POST", route: "/test", fieldErrors: [], attributedBy: "code" })
      const expected = op === "dm.send" || op === "permissions.require" ? "Unmapped" : "Recompute"
      expect({ op, result: mapResponse({ op, ...widest(op) }, response, undefined)._tag }).toEqual({ op, result: expected })
    }
  })
})

// ---- the outcomes of decide and the recompute over the replay's fixtures ----------------------------------

const tablePath = new URL("../../fixtures/truth-table.json", import.meta.url).pathname
const table = Schema.decodeUnknownSync(Schema.fromJsonString(TruthTable.TruthTable))(fs.readFileSync(tablePath, "utf8"))
const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
const now = Date.parse("2026-11-01T12:00:00Z")

describe("every outcome Preflight.decide and the recompute give the truth table's rows", () => {
  const rows = Object.entries(table.scenarios).filter(([, row]) => row.raw.class !== "setup-unsupported")

  it("is declared by the row's operation, with and without granted flags, with its class's categories", () => {
    const cause = new PreflightDecision({ route: "/test", basis: "gateway-state" })
    let outcomes = 0
    for (const [id, row] of rows) {
      const scenario = byId.get(id)
      if (scenario === undefined) throw new Error(`${id} is not in the catalog`)
      const prediction = Predict.predict(scenario, Predict.symbolicIds, now)
      const { op, args, required } = prediction.facts
      for (const granted of [[], required]) {
        const declared = declaredTags(op, args, granted)
        for (const failure of prediction.records.decision.failures) {
          const error = toHandleError(op, failure, granted, cause)
          expect({ id, tag: error._tag, declared: declared.has(error._tag) }).toEqual({ id, tag: error._tag, declared: true })
          expect({ id, categories: categoriesOf(error) }).toEqual({ id, categories: promisedCategories(op, error) })
          outcomes++
        }
      }
    }
    // more outcomes than matrix rows: a rule row runs a probe (M6) and its setup seldom predicts a failure, so counting
    // the rule rows in the bound made it fail by count alone once they grew (M8: 540 outcomes, 540 rows, 109 of them rule rows)
    expect(outcomes).toBeGreaterThan(rows.filter(([id]) => byId.get(id)?.operation._tag !== "rule").length)
  })
})

describe("errorFor", () => {
  it("builds, for every (operation, flag), an instance with the categories of the class the variant promises", () => {
    const cause = new PreflightDecision({ route: "/test", basis: "gateway-state" })
    for (const op of operations) {
      for (const flag of PermissionFlags) {
        expect({ op, flag, categories: categoriesOf(errorFor(op, flag, cause)) }).toEqual({ op, flag, categories: ErrorCategories[promisedClass(op, flag)] })
      }
    }
  })
})
