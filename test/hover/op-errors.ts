// Hover markers for the operation table (DESIGN §2.4, rule 1 of §2.12): an `OpErrors<G>[Op]` lookup resolves
// through mapped types to a plain union, so the hover prints class names, not the alias or an object type.
import type { Effect } from "effect"
import type { OpErrors } from "../../src/permissions/Operations.ts"

declare const pin: Effect.Effect<void, OpErrors<never>["message.pin.thread"]>
export const pinned = pin
//           ^? names: Effect.Effect, MissingViewChannel, MissingPinMessages, PermissionDeniedUnattributed, CommunicationDisabled, MaximumPinsReached, ThreadArchived, UnknownMessage, Transient; no-object

declare const react: Effect.Effect<void, OpErrors<"AddReactions">["message.react.channel"]>
export const reacted = react
//           ^? names: Effect.Effect, MissingReadMessageHistoryForReaction, PermissionRevokedSinceCheck, MaximumReactionsReached; no-object
