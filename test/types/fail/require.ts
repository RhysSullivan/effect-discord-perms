// R-require-narrows (fail side): on a handle Permissions.require returned, the checked flag's Missing* is gone
// (it became PermissionRevokedSinceCheck, D8), so catching it is a compile error (DESIGN §2.6).
import { Effect } from "effect"
import type { TextChannel } from "../../../src/channels/Channel.ts"
import { Permissions } from "../../../src/permissions/Require.ts"

declare const text: TextChannel
const handled = () => Effect.void

// @valid
export const ok = Permissions.require(text, ["SendMessages"]).pipe(Effect.flatMap((checked) => checked.send({ content: "hi" }).pipe(Effect.catchTag("PermissionRevokedSinceCheck", handled))))

// @expect-error TS2345 MissingSendMessages
export const narrowed = Permissions.require(text, ["SendMessages"]).pipe(Effect.flatMap((checked) => checked.send({ content: "hi" }).pipe(Effect.catchTag("MissingSendMessages", handled))))
