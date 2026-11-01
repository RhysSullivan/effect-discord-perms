/**
 * The library's error algebra (DESIGN §2.2, §3): causes, categories, the generated permission errors, the D5
 * variants and the permission, state, payload and transient errors.
 *
 * `ErrorClasses` lists every library error class by name and `AllErrors` is the union of their instances; the
 * D6 invariant test enumerates them.
 */
import { MissingClasses } from "./Missing.generated.ts"
import { PayloadClasses } from "./Payload.ts"
import { PermissionClasses } from "./Permission.ts"
import { StateClasses } from "./State.ts"
import { TransientClasses } from "./Transient.ts"
import { VariantClasses } from "./Variants.ts"

export * from "./Category.ts"
export * from "./Cause.ts"
export * from "./Missing.generated.ts"
export * from "./Payload.ts"
export * from "./Permission.ts"
export * from "./State.ts"
export * from "./Transient.ts"
export * from "./Variants.ts"

/** Every permission error class `errorFor` can build: the generated classes and the D5 variants, by class name. */
export const PermissionErrorClasses = { ...MissingClasses, ...VariantClasses } as const

/** Every library error class, keyed by class name. */
export const ErrorClasses = {
  ...PermissionErrorClasses,
  ...PermissionClasses,
  ...StateClasses,
  ...PayloadClasses,
  ...TransientClasses
} as const

/** The name of a library error class. */
export type ErrorClassName = keyof typeof ErrorClasses

/** Every library error: the union of the instances of `ErrorClasses`. */
export type AllErrors = { readonly [K in ErrorClassName]: InstanceType<(typeof ErrorClasses)[K]> }[ErrorClassName]
