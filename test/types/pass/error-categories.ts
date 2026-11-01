// The category table at the type level (DESIGN §2.2, §3.1): the generated ErrorCategories mirror names exactly
// the categories each permission class carries in its type, every library error is categorised, and D6 holds:
// a transient error is in no other category.
import { expectTypeOf } from "vitest"
import {
  type AllErrors,
  type Categories,
  type CategoryMarker,
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
  type ThreadLocked
} from "../../../src/errors/index.ts"

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
