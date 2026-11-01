/**
 * Error mapping (DESIGN §4.9). This module holds the first half of §4.9: copying dfx's failure shapes
 * (dfx.md §3) into our serialisable causes. The `(operation, status, code, inner path) -> tag` table and the
 * recompute arrive in M5 on top of `classify`.
 *
 * - `DiscordRestError("ErrorResponse")`: a 4xx with a JSON body. The code is read from `e.data.code`, never
 *   `e.code` (dfx's type claims a `code` that is `undefined` at run time). The inner 50035 tree is flattened
 *   into `FieldError`s with codes normalised to strings (H-084).
 * - `HttpClientError`:
 *   - `TransportError` -> no response (`NoResponse`, reason `transport`);
 *   - `StatusCodeError` with status >= 500 -> Discord unavailable, with the response;
 *   - `DecodeError` on a 4xx or 5xx (an HTML page from Cloudflare) -> Discord unavailable;
 *   - `DecodeError` on a 2xx, `EmptyBodyError`, `EncodeError`, `InvalidUrlError`, and a `StatusCodeError`
 *     below 500 (dfx's "unexpected status"; M5's coded-429 interceptor adds its own case) -> defects.
 * - `DiscordRestError("RatelimitedResponse")`: dfx retries every 429 itself, so this is a defect (D10).
 *
 * Live request and response objects are never retained: only status, code, message, method, route template
 * and field errors are copied.
 */
import type { DiscordRESTError } from "dfx/DiscordREST"
import { Effect, Schema } from "effect"
import { DiscordResponse, FieldError, HttpMethod, NoResponse } from "../errors/Cause.ts"

/** A dfx failure, classified. */
export type DfxFailure =
  /** Discord answered with a JSON error body (a 4xx). */
  | { readonly _tag: "Response"; readonly response: DiscordResponse }
  /** Discord answered 5xx, or a 4xx without a JSON body. */
  | { readonly _tag: "Unavailable"; readonly response: DiscordResponse }
  /** No response at all (a transport error). */
  | { readonly _tag: "NoResponse"; readonly cause: NoResponse }

interface ErrorLeaf {
  readonly code: string | number
  readonly message: string
}
interface ErrorTree {
  readonly [key: string]: ErrorTree | ReadonlyArray<ErrorLeaf>
}

const ErrorLeafSchema = Schema.Struct({ code: Schema.Union([Schema.String, Schema.Number]), message: Schema.String })
const ErrorTreeSchema: Schema.Codec<ErrorTree> = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Array(ErrorLeafSchema), Schema.suspend((): Schema.Codec<ErrorTree> => ErrorTreeSchema)])
)

/** Discord's JSON error body (REF "Error Messages"). `errors` is present only on 50035 and a few others. */
export const DiscordErrorBody = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  errors: Schema.optionalKey(ErrorTreeSchema)
})

const decodeBody = Schema.decodeUnknownEffect(DiscordErrorBody)
const decodeMethod = Schema.decodeUnknownEffect(HttpMethod)

const isLeafList = (value: ErrorTree | ReadonlyArray<ErrorLeaf>): value is ReadonlyArray<ErrorLeaf> => Array.isArray(value)

/**
 * Flattens the nested 50035 `errors` tree into field errors, in document order. `_errors` lists sit under the
 * path of their parent keys; inner codes become strings.
 */
export const flattenFieldErrors = (tree: ErrorTree, path: ReadonlyArray<string> = []): ReadonlyArray<FieldError> =>
  Object.entries(tree).flatMap(([key, value]) =>
    isLeafList(value)
      ? key === "_errors"
        ? value.map((leaf) => new FieldError({ path, code: String(leaf.code), message: leaf.message }))
        : []
      : flattenFieldErrors(value, [...path, key])
  )

const defect = (route: string, what: string) => Effect.die(new Error(`${route}: ${what}`))

/**
 * Classifies a dfx failure for the request made on `route` (a template, never a URL). Never fails: anything
 * that is not a Discord answer or a missing answer is a defect.
 */
export const classify = (error: DiscordRESTError, route: string, afterMs: number): Effect.Effect<DfxFailure> =>
  Effect.gen(function* () {
    const method = yield* decodeMethod(error.request.method).pipe(Effect.orDie)
    const fromStatus = (status: number, message: string) =>
      new DiscordResponse({ status, code: 0, message, method, route, fieldErrors: [], attributedBy: "code" })
    switch (error._tag) {
      case "ErrorResponse": {
        const body = yield* decodeBody(error.data).pipe(Effect.catch(() => defect(route, `malformed Discord error body (status ${error.response.status})`)))
        const fieldErrors = body.errors === undefined ? [] : flattenFieldErrors(body.errors)
        return {
          _tag: "Response",
          response: new DiscordResponse({ status: error.response.status, code: body.code, message: body.message, method, route, fieldErrors, attributedBy: "code" })
        }
      }
      case "RatelimitedResponse":
        return yield* defect(route, "a rate-limited response escaped dfx's retry loop (D10)")
      case "HttpClientError": {
        const reason = error.reason
        switch (reason._tag) {
          case "TransportError":
            return { _tag: "NoResponse", cause: new NoResponse({ route, method, reason: "transport", afterMs }) }
          case "StatusCodeError":
            return reason.response.status >= 500
              ? { _tag: "Unavailable", response: fromStatus(reason.response.status, "Discord unavailable") }
              : yield* defect(route, `unexpected status ${reason.response.status}`)
          case "DecodeError":
            return reason.response.status >= 400
              ? { _tag: "Unavailable", response: fromStatus(reason.response.status, "non-JSON error body") }
              : yield* defect(route, `malformed ${reason.response.status} body`)
          case "EmptyBodyError":
          case "EncodeError":
          case "InvalidUrlError":
            return yield* defect(route, reason._tag)
        }
      }
    }
  })
