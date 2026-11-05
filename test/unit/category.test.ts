import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import {
  catchCategory,
  CategorizedError,
  CategoryTypeId,
  DiscordResponse,
  hasCategory,
  MissingEmbedLinks,
  MissingReadMessageHistory,
  MissingReadMessageHistoryForReaction,
  MissingReadMessageHistoryForReply,
  NoResponse,
  PreflightDecision,
  RequestTimedOut,
  ThreadLocked,
  withCategory
} from "../../src/errors/index.ts"
import { categoriesOf, markerOf, markerOwner } from "../support/categories.ts"

/**
 * The category marker at run time (DESIGN §2.2, M1): it lives on the prototype, is frozen, is never encoded, and
 * is inherited without mutating the base class's marker.
 */

const route = "POST /channels/{channel_id}/messages"
const response = new DiscordResponse({
  status: 403,
  code: 50013,
  message: "Missing Permissions",
  method: "POST",
  route,
  fieldErrors: [],
  attributedBy: "recompute"
})
const preflight = new PreflightDecision({ route, basis: "gateway-state" })

describe("the category marker", () => {
  it("is on the prototype, not an own property of the instance", () => {
    const error = new MissingEmbedLinks({ cause: preflight })
    expect(Object.hasOwn(error, CategoryTypeId)).toBe(false)
    expect(Object.getOwnPropertySymbols(error)).not.toContain(CategoryTypeId)
    expect(CategoryTypeId in error).toBe(true)
    expect(categoriesOf(error)).toEqual(["payload", "permission"])
    const owner = markerOwner(error)
    expect(owner).not.toBeNull()
    if (owner !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, CategoryTypeId)
      expect(descriptor?.enumerable).toBe(false)
      expect(descriptor?.writable).toBe(false)
      expect(descriptor?.configurable).toBe(false)
    }
  })

  it("is frozen and fixed, so no category can be added, removed or replaced at run time", () => {
    const error = new ThreadLocked({ cause: preflight })
    const marker = markerOf(error)
    expect(Object.isFrozen(marker)).toBe(true)
    if (marker !== undefined) {
      expect(Reflect.set(marker, "transient", true)).toBe(false)
      expect(Reflect.deleteProperty(marker, "state")).toBe(false)
    }
    const owner = markerOwner(error)
    expect(owner).not.toBeNull()
    if (owner !== null) {
      expect(Reflect.defineProperty(owner, CategoryTypeId, { value: {} })).toBe(false)
      expect(Reflect.deleteProperty(owner, CategoryTypeId)).toBe(false)
    }
    expect(categoriesOf(new ThreadLocked({ cause: preflight }))).toEqual(["state"])
  })

  it("is not encoded and not serialised", () => {
    const error = new MissingEmbedLinks({ cause: preflight })
    const encoded = Schema.encodeSync(MissingEmbedLinks)(error)
    expect(encoded).toEqual({ _tag: "MissingEmbedLinks", cause: { _tag: "PreflightDecision", route, basis: "gateway-state" } })
    expect(JSON.stringify(encoded)).not.toContain("permission")
    const decoded = Schema.decodeUnknownSync(MissingEmbedLinks)(JSON.parse(JSON.stringify(encoded)))
    expect(decoded).toBeInstanceOf(MissingEmbedLinks)
    expect(categoriesOf(decoded)).toEqual(["payload", "permission"])
  })

  it("gives the D5 variants the base class's tag, flag and message with their own categories, without changing the base class", () => {
    const base = new MissingReadMessageHistory({ cause: preflight })
    const reply = new MissingReadMessageHistoryForReply({ cause: preflight })
    const reaction = new MissingReadMessageHistoryForReaction({ cause: preflight })
    expect(categoriesOf(base)).toEqual(["permission"])
    expect(categoriesOf(reply)).toEqual(["payload", "permission"])
    expect(categoriesOf(reaction)).toEqual(["access", "permission"])
    expect([base._tag, reply._tag, reaction._tag]).toEqual(["MissingReadMessageHistory", "MissingReadMessageHistory", "MissingReadMessageHistory"])
    expect([base.flag, reply.flag, reaction.flag]).toEqual(["ReadMessageHistory", "ReadMessageHistory", "ReadMessageHistory"])
    expect([reply.message, reaction.message]).toEqual([base.message, base.message])
    // Same-tag classes of their own (DESIGN §2.2, D5 after M10): not subclasses of the base class or of each other.
    expect(reply).not.toBeInstanceOf(MissingReadMessageHistory)
    expect(reply).not.toBeInstanceOf(MissingReadMessageHistoryForReaction)
    expect(reaction).not.toBeInstanceOf(MissingReadMessageHistoryForReply)
    // Each class owns a distinct frozen object, and the base's marker is unchanged.
    expect(markerOf(reply)).not.toBe(markerOf(base))
    expect(markerOf(reply)).not.toBe(markerOf(reaction))
    const replyMarker = markerOf(reply)
    expect(replyMarker !== undefined && Object.isFrozen(replyMarker)).toBe(true)
  })

  it("encodes and decodes a D5 variant as its own class, under the base class's tag", () => {
    const reply = new MissingReadMessageHistoryForReply({ cause: preflight })
    const encoded = Schema.encodeSync(MissingReadMessageHistoryForReply)(reply)
    expect(encoded).toEqual(Schema.encodeSync(MissingReadMessageHistory)(new MissingReadMessageHistory({ cause: preflight })))
    const decoded = Schema.decodeUnknownSync(MissingReadMessageHistoryForReply)(encoded)
    expect(decoded).toBeInstanceOf(MissingReadMessageHistoryForReply)
    expect(categoriesOf(decoded)).toEqual(["payload", "permission"])
  })

  it("CategorizedError is Schema.TaggedError with the mixin applied: a fresh subclass with a frozen marker of exactly its categories", () => {
    class Declared extends CategorizedError<Declared>()("Declared", { detail: Schema.String }, ["state", "access"]) {}
    class Piped extends Schema.TaggedError<Piped>()("Piped", { detail: Schema.String }).pipe(withCategory("state", "access")) {}
    const declared = new Declared({ detail: "d" })
    expect(declared._tag).toBe("Declared")
    expect(categoriesOf(declared)).toEqual(categoriesOf(new Piped({ detail: "d" })))
    expect(categoriesOf(declared)).toEqual(["access", "state"])
    expect(Object.hasOwn(declared, CategoryTypeId)).toBe(false)
    const marker = markerOf(declared)
    expect(marker !== undefined && Object.isFrozen(marker)).toBe(true)
    expect(Schema.encodeSync(Declared)(declared)).toEqual({ _tag: "Declared", detail: "d" })
    expect(Schema.decodeUnknownSync(Declared)({ _tag: "Declared", detail: "e" })).toBeInstanceOf(Declared)
  })

  it("gives a fresh class per application, so piping the same base twice never shares a marker", () => {
    class Base extends Schema.TaggedError<Base>()("Base", {}).pipe(withCategory("state")) {}
    class A extends Base.pipe(withCategory("payload")) {}
    class B extends Base.pipe(withCategory("access")) {}
    expect(categoriesOf(new A())).toEqual(["payload", "state"])
    expect(categoriesOf(new B())).toEqual(["access", "state"])
    expect(categoriesOf(new Base())).toEqual(["state"])
  })
})

describe("generated permission errors", () => {
  it("carry their tag, flag, message and either kind of cause", () => {
    const fromDiscord = new MissingEmbedLinks({ cause: response })
    const fromPreflight = new MissingEmbedLinks({ cause: preflight })
    expect(fromDiscord._tag).toBe("MissingEmbedLinks")
    expect(fromDiscord.flag).toBe("EmbedLinks")
    expect(fromDiscord.message).toBe(`Missing permission EmbedLinks (${route})`)
    expect([fromDiscord.cause._tag, fromPreflight.cause._tag]).toEqual(["DiscordResponse", "PreflightDecision"])
    expect(fromDiscord).toBeInstanceOf(Error)
  })

  it("transient errors carry a NoResponse when Discord never answered", () => {
    const timedOut = new RequestTimedOut({ cause: new NoResponse({ route, method: "POST", reason: "deadline", afterMs: 30_000 }) })
    expect(timedOut.cause._tag).toBe("NoResponse")
    expect(categoriesOf(timedOut)).toEqual(["transient"])
  })
})

describe("hasCategory and catchCategory at run time", () => {
  it("hasCategory is any-of and false for uncategorised values", () => {
    const reply = new MissingReadMessageHistoryForReply({ cause: preflight })
    expect(hasCategory("payload")(reply)).toBe(true)
    expect(hasCategory(["access", "state"])(reply)).toBe(false)
    expect(hasCategory(["access", "permission"])(reply)).toBe(true)
    expect(hasCategory("payload")(new Error("plain"))).toBe(false)
    expect(hasCategory("payload")("MissingEmbedLinks")).toBe(false)
  })

  it.effect("catchCategory catches by category and lets the others through, data-last and data-first", () =>
    Effect.gen(function* () {
      const reply = new MissingReadMessageHistoryForReply({ cause: preflight })
      const reaction = new MissingReadMessageHistoryForReaction({ cause: preflight })
      const locked = new ThreadLocked({ cause: preflight })
      /** Fails with `error`, typed with all three classes so every category below is present in the type. */
      const failWith = (
        error: MissingReadMessageHistoryForReply | MissingReadMessageHistoryForReaction | ThreadLocked
      ): Effect.Effect<string, MissingReadMessageHistoryForReply | MissingReadMessageHistoryForReaction | ThreadLocked> => Effect.fail(error)

      const caughtReply = yield* failWith(reply).pipe(catchCategory("payload", (error) => Effect.succeed(error.flag)), Effect.exit)
      expect(caughtReply).toEqual(Exit.succeed("ReadMessageHistory"))
      const passedReaction = yield* failWith(reaction).pipe(catchCategory("payload", () => Effect.succeed("caught")), Effect.exit)
      expect(passedReaction).toEqual(Exit.fail(reaction))
      const dataFirst = yield* catchCategory(failWith(reaction), ["payload", "access"], (error) => Effect.succeed(error._tag)).pipe(Effect.exit)
      expect(dataFirst).toEqual(Exit.succeed("MissingReadMessageHistory"))
      const stateCaught = yield* failWith(locked).pipe(catchCategory("state", (error) => Effect.succeed(error._tag)), Effect.exit)
      expect(stateCaught).toEqual(Exit.succeed("ThreadLocked"))
      const lockedPassed = yield* failWith(locked).pipe(catchCategory(["access", "payload"], () => Effect.succeed("caught")), Effect.exit)
      expect(lockedPassed).toEqual(Exit.fail(locked))
    })
  )
})
