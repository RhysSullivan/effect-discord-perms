/**
 * The scenario DSL (DESIGN §5.8). Milestone 0 needs only `Observation`, the full expectation a rule's live
 * pair is compared with (§5.5); M3 adds `Setup`, `Operation` and `Scenario` here, from `[sd:src/verify.ts]`.
 */
import { Schema } from "effect"

/**
 * What a rule side must produce, in full, so a rejection for the wrong reason does not count: status, code,
 * the sorted inner 50035 codes with their paths, field names, counts.
 */
export const Observation = Schema.Union([
  Schema.TaggedStruct("Rejected", {
    status: Schema.Int,
    code: Schema.Int,
    inner: Schema.Array(Schema.Struct({ path: Schema.String, code: Schema.String }))
  }),
  Schema.TaggedStruct("Ignored", { field: Schema.String }),
  Schema.TaggedStruct("Applied", { field: Schema.String }),
  Schema.TaggedStruct("Writes", { count: Schema.Int }),
  /** Only counts when the same session saw READY (with the expected user id) and a canary event after the trigger. */
  Schema.TaggedStruct("EventAbsent", { event: Schema.String, canary: Schema.String }),
  Schema.TaggedStruct("EventDelivered", { event: Schema.String }),
  Schema.TaggedStruct("Succeeded", {})
])

/** A full observation of one rule side (see {@link Observation}). */
export type Observation = typeof Observation.Type
