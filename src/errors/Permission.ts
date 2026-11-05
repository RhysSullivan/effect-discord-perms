/**
 * Permission errors that are not attributable to one missing flag of the current state (DESIGN §3.1).
 */
import { Schema } from "effect"
import { CategorizedError } from "./Category.ts"
import { ErrorCause } from "./Cause.ts"
import { PermissionFlags } from "./Missing.generated.ts"

/**
 * Discord refused with 50013 or 50001, and the recompute over fresh state found no missing flag, hierarchy
 * violation or other state failure. The library never guesses a flag.
 */
export class PermissionDeniedUnattributed extends CategorizedError<PermissionDeniedUnattributed>()("PermissionDeniedUnattributed", {
  cause: ErrorCause
}, ["permission"]) {
  override get message(): string {
    return "Permission denied, and the recompute found no missing permission (" + this.cause.route + ")"
  }
}

/**
 * D8: `Permissions.require` checked `flag`, and a later request on the returned handle was refused because the
 * flag has been revoked since.
 */
export class PermissionRevokedSinceCheck extends CategorizedError<PermissionRevokedSinceCheck>()("PermissionRevokedSinceCheck", {
  flag: Schema.Literals(PermissionFlags),
  cause: ErrorCause
}, ["permission"]) {
  override get message(): string {
    return "Permission " + this.flag + " was revoked after Permissions.require checked it (" + this.cause.route + ")"
  }
}

/** Every class in this module, keyed by class name. */
export const PermissionClasses = { PermissionDeniedUnattributed, PermissionRevokedSinceCheck } as const
