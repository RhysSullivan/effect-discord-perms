/**
 * Error causes (DESIGN §2.2). Every error that came from Discord, that preflight decided instead of Discord, or
 * that has no response at all carries one of these as `cause`. Nothing in them is `unknown`.
 *
 * - `DiscordResponse`: copied out of dfx's live request and response objects (dfx.md §3), which are never
 *   retained.
 * - `PreflightDecision`: no request was sent; the library refused locally.
 * - `NoResponse`: the request was sent (or attempted) but no Discord response exists (a transport error or the
 *   per-call deadline). For a non-idempotent call the outcome is unknown (§4.10).
 */
import { Schema } from "effect"

/** One inner 50035 field error. */
export class FieldError extends Schema.Class<FieldError>("FieldError")({
  /** The path into the request body, for example `["embeds", "0", "title"]`. */
  path: Schema.Array(Schema.String),
  /** The inner code, normalised to a string whatever Discord sends (H-084). */
  code: Schema.String,
  message: Schema.String
}) {}

/** The HTTP methods the library sends. */
export const HttpMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"])
/** The HTTP methods the library sends. */
export type HttpMethod = typeof HttpMethod.Type

/** What Discord answered, as far as error mapping needs it. */
export class DiscordResponse extends Schema.TaggedClass<DiscordResponse>()("DiscordResponse", {
  status: Schema.Int,
  /** Discord's JSON error code; 0 for bodies without one (5xx, an uncoded 429, a non-JSON body). */
  code: Schema.Int,
  message: Schema.String,
  method: HttpMethod,
  /** The route template stamped by our wrapper, never the URL: tokens live in interaction URLs. */
  route: Schema.String,
  fieldErrors: Schema.Array(FieldError),
  /** How the tag was chosen: Discord's own code, or the recompute after a permission-like code (§4.9). */
  attributedBy: Schema.Literals(["code", "recompute"])
}) {}

/** The library refused locally; nothing was sent. */
export class PreflightDecision extends Schema.TaggedClass<PreflightDecision>()("PreflightDecision", {
  /** The route template the request would have used. */
  route: Schema.String,
  /** What the decision was based on: gateway state, an interaction's `app_permissions`, or the payload alone. */
  basis: Schema.Literals(["gateway-state", "app-permissions", "payload-check"])
}) {}

/** The request was sent or attempted, but no Discord response exists. */
export class NoResponse extends Schema.TaggedClass<NoResponse>()("NoResponse", {
  route: Schema.String,
  method: HttpMethod,
  reason: Schema.Literals(["transport", "deadline"]),
  /** Milliseconds waited before giving up (deadline) or failing (transport). */
  afterMs: Schema.Int
}) {}

/** The cause every Discord-facing error carries. */
export const ErrorCause = Schema.Union([DiscordResponse, PreflightDecision, NoResponse])
/** The cause every Discord-facing error carries. */
export type ErrorCause = typeof ErrorCause.Type
