/**
 * `custom_id` routes (DESIGN §2.9): a route names a kind of component and the schema of the data its
 * `custom_id` carries, so a component's handler receives decoded data, and the 100-character limit (H-130) is
 * checked when the ID is built.
 *
 * The wire format always goes through the canonical JSON codec: `name + ":" +
 * encode(Schema.fromJsonString(Schema.toCodecJson(schema)))(data)`, decoded with the same codec, so dates,
 * bigints and sets round-trip. The schema needs no services. M6 brings the route and its ID builder, which the
 * component payloads need (`Components.ts`); M8 adds `routeNameOf`, the prefix a received `custom_id` is routed by
 * (the runner that routes interactions is M9's), and the live round-trip rule (`R-custom-id-routing`: an ID built at
 * exactly 100 characters is accepted, read back from the message and decoded to the same data; one of 101 is refused).
 */
import { Effect, Option, Schema } from "effect"
import { CustomIdTooLong } from "../errors/Payload.ts"
import { CustomId, type Invalid } from "../payload/Components.ts"
import { Limits, lengthOf } from "../payload/Limits.ts"
import type { IsFiniteLiteral } from "../payload/PayloadRules.ts"

/**
 * A route name is a literal without the separator: a name typed `string` could hold a `:` the type cannot see, and
 * its IDs would then never route (after the final audit).
 */
export type CheckRouteName<N extends string> =
  IsFiniteLiteral<N> extends false ? Invalid<"route names must be literals"> : N extends `${string}:${string}` ? Invalid<"route names cannot contain ':'"> : unknown

/** A component route: its name, and the `custom_id`s it builds and reads. */
export interface ComponentRoute<Name extends string, A> {
  readonly name: Name
  /** `name:json`, or `CustomIdTooLong` when that is over 100 characters. A value the schema cannot encode is a defect. */
  readonly customId: (data: A) => Effect.Effect<CustomId, CustomIdTooLong>
  /** The data of a `custom_id` this route built; `None` for another route's ID or one that does not decode (an old control). */
  readonly decode: (customId: string) => Option.Option<A>
}

/** Builds component routes. */
export const ComponentRoute = {
  /** A route named `name` whose IDs carry a value of `schema`. */
  make: <const Name extends string, S extends Schema.Codec<unknown, unknown, never, never>>(name: Name & CheckRouteName<Name>, schema: S): ComponentRoute<Name, S["Type"]> => {
    const codec = Schema.fromJsonString(Schema.toCodecJson(schema))
    const encode = Schema.encodeEffect(codec)
    const decodeJson = Schema.decodeUnknownOption(codec)
    const prefix = `${name}:`
    return {
      name,
      customId: (data) =>
        encode(data).pipe(
          Effect.mapError((error) => new Error(`ComponentRoute ${name}: the data does not encode: ${error.message}`)),
          Effect.orDie,
          Effect.flatMap((json) => {
            const id = `${prefix}${json}`
            return lengthOf(id) > Limits.customId ? Effect.fail(new CustomIdTooLong({ route: name, length: lengthOf(id) })) : Effect.succeed(CustomId.make(id))
          })
        ),
      decode: (customId) => (customId.startsWith(prefix) ? decodeJson(customId.slice(prefix.length)) : Option.none())
    }
  }
}

/**
 * The route name a received `custom_id` is routed by: its prefix before the first `:` (route names contain none).
 * `undefined` for an ID with no `:`, which no route built.
 */
export const routeNameOf = (customId: string): string | undefined => {
  const at = customId.indexOf(":")
  return at < 0 ? undefined : customId.slice(0, at)
}
