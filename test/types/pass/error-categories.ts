// The category table at the type level (DESIGN §2.2, §3.1): the generated ErrorCategories mirror names exactly
// the categories each permission class carries in its type, every library error is categorised, and D6 holds:
// a transient error is in no other category.
import { Effect, Schema } from "effect"
import { expectTypeOf } from "vitest"
import {
  CategorizedError,
  type AllErrors,
  type Categories,
  type CategoryMarker,
  catchCategory,
  type CustomIdTooLong,
  type DiscordUnavailable,
  ErrorCategories,
  type ExtractCategory,
  type MissingConnect,
  type MissingEmbedLinks,
  type MissingManageMessages,
  type MissingReadMessageHistoryForReaction,
  type MissingReadMessageHistoryForReply,
  type MissingSendVoiceMessages,
  type MissingViewChannel,
  type NetworkError,
  PermissionErrorClasses,
  type PermissionFlag,
  type PermissionRevokedSinceCheck,
  type RateLimited,
  type RequestTimedOut,
  type ThreadLocked,
  withCategory
} from "../../../src/errors/index.ts"
import type { DiscordResponse, NoResponse } from "../../../src/errors/Cause.ts"

type Mirror = typeof ErrorCategories
type Classes = typeof PermissionErrorClasses

// The mirror covers exactly the permission error classes, the generated ones and the D5 variants.
expectTypeOf<keyof Mirror>().toEqualTypeOf<keyof Classes>()

// For every class, the mirror's categories are exactly the categories of the class's instance type.
type MirrorMismatches = {
  readonly [K in keyof Classes & keyof Mirror]: [Mirror[K][number]] extends [Categories<InstanceType<Classes[K]>>]
    ? [Categories<InstanceType<Classes[K]>>] extends [Mirror[K][number]]
      ? never
      : K
    : K
}[keyof Classes & keyof Mirror]
expectTypeOf<MirrorMismatches>().toEqualTypeOf<never>()

// Spot checks of the category table.
expectTypeOf<Categories<MissingViewChannel>>().toEqualTypeOf<"access" | "permission">()
expectTypeOf<Categories<MissingConnect>>().toEqualTypeOf<"access" | "permission">()
expectTypeOf<Categories<MissingEmbedLinks>>().toEqualTypeOf<"payload" | "permission">()
expectTypeOf<Categories<MissingSendVoiceMessages>>().toEqualTypeOf<"payload" | "permission">()
expectTypeOf<Categories<MissingManageMessages>>().toEqualTypeOf<"permission">()
expectTypeOf<Categories<MissingReadMessageHistoryForReply>>().toEqualTypeOf<"payload" | "permission">()
expectTypeOf<Categories<MissingReadMessageHistoryForReaction>>().toEqualTypeOf<"access" | "permission">()
expectTypeOf<Categories<PermissionRevokedSinceCheck>>().toEqualTypeOf<"permission">()
expectTypeOf<Categories<ThreadLocked>>().toEqualTypeOf<"state">()
expectTypeOf<Categories<CustomIdTooLong>>().toEqualTypeOf<"payload">()
expectTypeOf<PermissionRevokedSinceCheck["flag"]>().toEqualTypeOf<PermissionFlag>()

// Every library error is categorised: none escapes CategoryMarker<string>.
expectTypeOf<Exclude<AllErrors, CategoryMarker<string>>>().toEqualTypeOf<never>()
// The library uses exactly the five categories.
expectTypeOf<Categories<AllErrors>>().toEqualTypeOf<"access" | "payload" | "permission" | "state" | "transient">()
// D6: the transient errors are exactly these four, and they are in no other category.
expectTypeOf<ExtractCategory<AllErrors, "transient">>().toEqualTypeOf<DiscordUnavailable | RequestTimedOut | NetworkError | RateLimited>()
expectTypeOf<Categories<ExtractCategory<AllErrors, "transient">>>().toEqualTypeOf<"transient">()

// The transient classes type their cause as exactly the member of ErrorCause that can produce them (§2.2, M1):
// a missing response for the timeout and the transport failure, a Discord response for 5xx and coded 429s.
expectTypeOf<RequestTimedOut["cause"]>().toEqualTypeOf<NoResponse>()
expectTypeOf<NetworkError["cause"]>().toEqualTypeOf<NoResponse>()
expectTypeOf<DiscordUnavailable["cause"]>().toEqualTypeOf<DiscordResponse>()
expectTypeOf<RateLimited["cause"]>().toEqualTypeOf<DiscordResponse>()

// CategorizedError (§2.2): the class it declares carries exactly the listed categories, as the piped mixin's does,
// and stays a schema class of itself with its fields and tag.
class Declared extends CategorizedError<Declared>()("Declared", { detail: Schema.String }, ["state", "access"]) {}
class Piped extends Schema.TaggedError<Piped>()("Piped", { detail: Schema.String }).pipe(withCategory("state", "access")) {}
expectTypeOf<Categories<Declared>>().toEqualTypeOf<"access" | "state">()
expectTypeOf<Categories<Declared>>().toEqualTypeOf<Categories<Piped>>()
expectTypeOf<Declared["_tag"]>().toEqualTypeOf<"Declared">()
expectTypeOf<Declared["detail"]>().toEqualTypeOf<string>()
expectTypeOf<Schema.Schema.Type<typeof Declared>>().toEqualTypeOf<Declared>()
expectTypeOf(Declared.make({ detail: "d" })).toEqualTypeOf<Declared>()
// The category catch removes it, and a tag catch removes exactly it.
declare const declaredOrLocked: Effect.Effect<void, Declared | ThreadLocked>
expectTypeOf<Effect.Error<ReturnType<typeof caughtAccess>>>().toEqualTypeOf<ThreadLocked>()
const caughtAccess = () => declaredOrLocked.pipe(catchCategory("access", () => Effect.void))
expectTypeOf<Effect.Error<ReturnType<typeof caughtTag>>>().toEqualTypeOf<ThreadLocked>()
const caughtTag = () => declaredOrLocked.pipe(Effect.catchTag("Declared", () => Effect.void))
