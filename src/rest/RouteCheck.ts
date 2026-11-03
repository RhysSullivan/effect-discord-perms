/**
 * The declared-route check (DESIGN §4.8; the M6 verifier): every request `send` makes carries the route its caller
 * declares, the method and template that the span, the cause and the error map name, and the bot's HTTP client
 * holds the request dfx builds to it. A request whose method or path does not match the declaration is a defect:
 * the operation's dfx call and its declared route disagree, so its span, its errors' causes and its error mapping
 * would describe a request that was never sent.
 *
 * - `send` (`Request.ts`) provides {@link DeclaredRoute} around the dfx call, and nothing else does;
 * - {@link checked} wraps the base `HttpClient` of a bot build (`BotInternals.layerWith`, so the library's operations,
 *   its lookups and refreshes, and the harness's raw calls through `SubjectRaw` are all checked): a request made
 *   while a route is declared must have that method and a path, under the API's `/api/v<n>` base, that the template
 *   matches, each `{placeholder}` standing for one non-empty segment. A request made outside `send` (dfx's own
 *   gateway lookup) declares nothing and is not checked.
 *
 * The defect names the declared route and the shape of the path sent, never the path itself: a path segment can be
 * a secret (an interaction token, phase 3), so every segment that is not a lowercase word is shown as `{…}`.
 */
import { Context, Effect, Layer, Option } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import type { HttpMethod } from "../errors/Cause.ts"

/** A route as its caller declares it: the method and the template, for example `/channels/{channel.id}/messages`. */
export interface Declared {
  readonly method: HttpMethod
  readonly template: string
}

/** The route of the request being made, while `send` makes one (`None` otherwise). */
export const DeclaredRoute = Context.Reference<Option.Option<Declared>>("rest/DeclaredRoute", { defaultValue: () => Option.none() })

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The path pattern a template stands for: the template under an optional `/api/v<n>`, a placeholder for one segment. */
export const templatePattern = (template: string): RegExp => new RegExp(`^(?:/api/v\\d+)?${template.split(/\{[^}/]+\}/).map(escape).join("[^/]+")}$`)

/** A path with every segment that is not a lowercase word (an ID, an emoji, a token) shown as `{…}`. */
export const pathShape = (path: string): string =>
  path
    .split("/")
    .map((segment) => (segment === "" || /^(?:@me|[a-z][a-z-]*)$/.test(segment) ? segment : "{…}"))
    .join("/")

/** Why a request (`method`, `url`) is not the `declared` route, or `undefined` when it is. */
export const mismatch = (declared: Declared, method: string, url: string): string | undefined => {
  const path = URL.canParse(url) ? new URL(url).pathname : url
  if (method.toUpperCase() === declared.method && templatePattern(declared.template).test(path)) return undefined
  return `declared ${declared.method} ${declared.template}, but the request is ${method.toUpperCase()} ${pathShape(path.replace(/^\/api\/v\d+/, ""))}`
}

/** `client`, with every request made under a declared route held to it (see the module comment). */
export const checked = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  client.pipe(
    HttpClient.tapRequest((request) =>
      Effect.flatMap(DeclaredRoute, (declared) => {
        if (Option.isNone(declared)) return Effect.void
        const problem = mismatch(declared.value, request.method, request.url)
        return problem === undefined ? Effect.void : Effect.die(new Error(`route check: ${problem}`))
      })
    )
  )

/** The check as a layer: the `HttpClient` it needs, wrapped by {@link checked}. */
export const layer: Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient> = Layer.effect(HttpClient.HttpClient, Effect.map(Effect.service(HttpClient.HttpClient), checked))
