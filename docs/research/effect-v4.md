# Effect v4 API surface for effect-discord-perms

Research only. Every claim below was checked against `node_modules/effect` 4.1.1
source or by compiling and running code in `.scratch/effect-v4/`. Anything
that was not checked is marked **UNVERIFIED**.

Toolchain used: effect 4.1.1, @effect/vitest 4.1.1, @effect/platform-bun 4.1.1,
dfx 1.1.1, TypeScript 7.0.2 (`node_modules/.bin/tsc`, the Go compiler), vitest
5.0.5, Bun 1.4.4, Node 24. The scratch `tsconfig.json` extends the repo's
`tsconfig.json`, which sets `strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax` and
`allowImportingTsExtensions`. All of the scratch code compiles cleanly
(`tsc -p .scratch/effect-v4` exits 0). Code that is meant to fail lives in
files excluded from that build, and each has its own `tsconfig.fail*.json`.

## 0. Effect 4.1 names differ from the v4 betas and from older skill docs

| Concept | Effect 4.1.1 name (verified) | Not present in 4.1.1 |
|---|---|---|
| Schema tagged error | `Schema.TaggedError<Self>()("Tag", fields)` | `Schema.TaggedErrorClass` (beta name; zero hits in `src/`) |
| Schema error, no tag | `Schema.Error<Self>("Id")(fields)` | |
| Data tagged error | `Data.TaggedError("Tag")<Fields>` | |
| Service tag | `Context.Service<Self, Shape>()("id")` | `ServiceMap.Service`, `Context.Tag`, `Context.GenericTag`, `Effect.Service` |
| Service with a default | `Context.Reference<T>("id", { defaultValue })` | |
| Catch all | `Effect.catch` | `Effect.catchAll` |
| Catch all causes / defects | `Effect.catchCause` / `Effect.catchDefect` | `catchAllCause`, `catchAllDefect` |
| Catch some | `Effect.catchIf`, `Effect.catchFilter` | `catchSome` |
| Either | `Effect.result` (gives `Result`) | `Effect.either` |
| Nested error groups | `Effect.catchReason`, `catchReasons`, `unwrapReason` | |
| Config | `Config.String("X")`, `Config.Redacted("X")` (a `Config` is an `Effect`) | `Config.redacted`, `Config.string` |
| Test clock | `import { TestClock } from "effect/testing"` | |

The `effect` skill in `~/.claude/skills/effect` still says
`Schema.TaggedErrorClass`, which is wrong for 4.1.1. The package's own
`node_modules/effect/AGENTS.md` and `ai-docs/` match the source and use
`Schema.TaggedError`.

## 1. Import paths that work (compiled)

```ts
import { Brand, Cause, Config, Context, Data, Effect, Exit, Fiber, Function, Layer,
  Option, Predicate, Redacted, Ref, Schema, Tracer } from "effect"
import * as Effect from "effect/Effect"         // per-module subpaths also work; dfx uses these
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientError } from "effect/http"
import { BunRuntime, BunHttpClient } from "@effect/platform-bun"
import { assert, describe, it, layer } from "@effect/vitest"
```

`effect` exports `"./*": "./dist/*.js"`, so `effect/Effect`, `effect/Schema`
and the others resolve. Subsystems sit at `effect/http`, `effect/socket`,
`effect/persistence` and so on. dfx 1.1.1 imports `effect/Effect`,
`effect/http/HttpClient`, `effect/socket/Socket` and similar paths, and has a
peer dependency on `effect ^4.0.0`. There is no `effect/unstable/*` path.
`BunHttpClient` re-exports `FetchHttpClient`, so `BunHttpClient.layer` exists.
It also adds `layerOptions`.

## 2. Tagged errors

### 2.1 `Schema.TaggedError` (use this for public errors)

Signature, from `Schema.ts:17926`:

```ts
<Self = never, Brand = {}>(identifier?: string) =>
  <Tag extends string, const Fields extends Struct.Fields>(tag: Tag, fields: Fields, annotations?) =>
    [Self] extends [never] ? MissingSelfGeneric<"Schema.TaggedError">
      : Class<Self, TaggedStruct<Tag, Fields>, Cause.YieldableError & Brand>
```

- The result is a `Schema.Class<Self, S, Inherited>`. Its `new(...)` returns
  `S["Type"] & Inherited`. Its statics are `make`, `makeOption`, `makeEffect`,
  `fields`, `identifier`, `ast`, `extend`, `annotate`, `check`, `mapFields`
  and `pipe`. Because it has `pipe`, `.pipe(mixin)` works on it.
- The second type parameter, `Brand`, is intersected into the instance type.
  It exists only at the type level.
- If you forget `<Self>`, the result is a string-literal type ("Missing
  \`Self\` generic - use \`class Self extends Schema.TaggedError<Self>(...)\`").
- `new X({...})` validates fields and throws `Error: Schema validation failed`
  when they are invalid (checked at runtime). `_tag` is filled in
  automatically.
- A `message` field becomes `Error.message`. A `cause` field is passed to
  `Error`'s `cause` option (`internal/core.ts:688`, `super(args?.message,
  args?.cause ? { cause } : undefined)`). Both were checked at runtime:
  `e instanceof Error`, `e.name === tag`, and `String(e)` gives
  `"Tag: message"`.
- `JSON.stringify(e)` and `Schema.encodeSync(X)(e)` contain only the declared
  fields.

A cause can be declared in three ways (all compiled; see `src/01-errors.ts`,
`src/02-catch.ts` and `src/14-typed-cause.ts`):

```ts
// raw Discord response, fully typed (preferred: nothing is `unknown`)
export class DiscordCause extends Schema.Class<DiscordCause>("DiscordCause")({
  code: Schema.Int, message: Schema.String, route: Schema.String
}) {}
export class MissingViewChannel extends Schema.TaggedError<MissingViewChannel>()("MissingViewChannel", {
  cause: DiscordCause                     // e.cause: DiscordCause
}) {}

// typed upstream error, e.g. the dfx/Effect HttpClientError
export class RequestFailed extends Schema.TaggedError<RequestFailed>()("RequestFailed", {
  route: Schema.String,
  cause: Schema.instanceOf(HttpClientError.HttpClientError)   // e.cause: HttpClientError
}) {}

// untyped defect payload: Schema.Defect is a FUNCTION in 4.1 and its field type is `unknown`
export class Network extends Schema.TaggedError<Network>()("Network", { cause: Schema.Defect() }) {}
```

A readable `message` can come from a getter. This compiles and works at
runtime, and `Cause.pretty` uses it:

```ts
export class MissingAttachFiles extends Schema.TaggedError<MissingAttachFiles>()("MissingAttachFiles", {
  cause: DiscordCause
}).pipe(withCategory("permission", "payload")) {
  override get message(): string { return `Missing permission AttachFiles (${this.cause.route})` }
}
```

### 2.2 `Data.TaggedError`, `Data.Error`, `Schema.Error`

```ts
// Data.ts:919
export const TaggedError: <Tag extends string>(tag: Tag) =>
  new<A extends Record<string, any> = {}>(args: VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P] }>)
    => Cause.YieldableError & { readonly _tag: Tag } & Readonly<A>
```

These are not schemas: they have no validation, no encode, and no `make`.
dfx uses `Data.Error` and `Data.TaggedError` (`DiscordRestErrorImpl`,
`WebhookParseError`, `CacheMissError`). Effect's `HttpClientError` is a
`Data.TaggedError("HttpClientError")` with a `reason` union (`TransportError`,
`EncodeError`, `InvalidUrlError`, ...), which is the "reason" pattern from
section 4.

### 2.3 Yieldable errors

`Cause.YieldableError extends Error, Pipeable, Inspectable` and carries
`[Effect.TypeId]` and `[Symbol.iterator]`. An error instance is therefore
itself an `Effect<never, Self, never>`. This compiled:
`const x: Effect.Effect<never, RestFailure> = new RestFailure({...})`.
Inside a generator, write `return yield* new X({...})`. The `return` matters
because it tells TypeScript that control does not continue past that line.

## 3. Error combinators: exact v4 signatures and verified narrowing

These are copied from `Effect.ts` with the JSDoc removed. `unassigned` is an
internal sentinel type. When `orElse` is omitted, the remainder stays in `E`.

```ts
// Effect.catch (exported as `catch_ as catch`)
<E, A2, E2, R2>(f: (e: E) => Effect<A2, E2, R2>): <A, R>(self: Effect<A, E, R>) => Effect<A2 | A, E2, R2 | R>

// Effect.catchTag
<const K extends Tags<E> | NonEmptyReadonlyArray<Tags<E>>, E, A1, E1, R1, A2 = unassigned, E2 = never, R2 = never>(
  k: K,
  f: (e: ExtractTag<NoInfer<E>, K extends NonEmptyReadonlyArray<string> ? K[number] : K>) => Effect<A1, E1, R1>,
  orElse?: ((e: ExcludeTag<E, ...>) => Effect<A2, E2, R2>) | undefined
): <A, R>(self: Effect<A, E, R>) => Effect<A | A1 | Exclude<A2, unassigned>,
     E1 | E2 | (A2 extends unassigned ? ExcludeTag<E, ...> : never), R | R1 | R2>

// Effect.catchTags
<E, Cases extends { [K in Extract<E, {_tag: string}>["_tag"]]+?: (error: Extract<E, {_tag: K}>) => Effect<any, any, any> }
                & (unknown extends E ? {} : { [K in Exclude<keyof Cases, Extract<E, {_tag: string}>["_tag"]>]: never }),
 A2 = unassigned, E2 = never, R2 = never>(cases: Cases, orElse?: (e: Exclude<E, { _tag: keyof Cases }>) => Effect<A2, E2, R2>)
  : <A, R>(self: Effect<A, E, R>) => Effect<..., E2 | (A2 extends unassigned ? Exclude<E, { _tag: keyof Cases }> : never) | <E of each case>, ...>

// Effect.catchIf: refinement overload (removes exactly EB) and predicate overload (E unchanged)
<E, EB extends E, A2, E2, R2, A3 = unassigned, E3 = never, R3 = never>(
  refinement: Predicate.Refinement<NoInfer<E>, EB>, f: (e: EB) => Effect<A2, E2, R2>, orElse?: (e: Exclude<E, EB>) => Effect<A3, E3, R3>
): <A, R>(self: Effect<A, E, R>) => Effect<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? Exclude<E, EB> : never), R | R2 | R3>
<E, A2, E2, R2, A3 = unassigned, E3 = never, R3 = never>(
  predicate: Predicate.Predicate<NoInfer<E>>, f: (e: NoInfer<E>) => Effect<A2, E2, R2>, orElse?: ...
): <A, R>(self: Effect<A, E, R>) => Effect<..., E2 | E3 | (A3 extends unassigned ? E : never), ...>

// Effect.catchFilter (Filter returns Result<Pass, Fail>; Fail is the remainder)
<E, EB, A2, E2, R2, X, A3 = unassigned, E3 = never, R3 = never>(filter: Filter.Filter<NoInfer<E>, EB, X>, f: (e: EB) => Effect<A2, E2, R2>, orElse?: (e: X) => ...)
  : <A, R>(self: Effect<A, E, R>) => Effect<..., E2 | E3 | (A3 extends unassigned ? X : never), ...>

export const orDie: <A, E, R>(self: Effect<A, E, R>) => Effect<A, never, R>
export const mapError: { <E, E2>(f: (e: E) => E2): <A, R>(self: Effect<A, E, R>) => Effect<A, E2, R>; ... }
export const tapError: { <E, X, E2, R2>(f: (e: NoInfer<E>) => Effect<X, E2, R2>): <A, R>(self: Effect<A, E, R>) => Effect<A, E | E2, R2 | R>; ... }
export const tapErrorTag: { <const K extends Tags<E> | NonEmptyReadonlyArray<Tags<E>>, E, A1, E1, R1>(k: K, f: ...) : <A, R>(self) => Effect<A, E | E1, R1 | R>; ... }
export const catchCause / catchDefect / catchCauseIf / catchCauseFilter / catchNoSuchElement   // also exist
```

Helper types (`Types.ts`): `Tags<E> = E extends { readonly _tag: string } ? E["_tag"] : never`,
`ExcludeTag<E, K> = Exclude<E, { readonly _tag: K }>`,
`ExtractTag<E, K> = E extends { readonly _tag: infer T } ? K extends T ? E : never : never`.

Narrowing assertions that passed, using an exact `Equals` check (`src/02-catch.ts`):

| Expression on `Effect<string, MVC \| MSM \| MEL \| Network>` | Resulting `E` |
|---|---|
| `catchTag("MissingEmbedLinks", ...)` | `MVC \| MSM \| Network`: exactly one tag removed |
| `catchTag(["MissingEmbedLinks","Network"], ...)` | `MVC \| MSM` |
| `catchTag("Network", f, orElse)` | `never` |
| `catchTag("Nope", ...)` | compile error (`K extends Tags<E>`) |
| `catchTags({ MissingViewChannel, Network: e => Effect.fail(e.cause) })` | `MSM \| MEL \| unknown` (the handler's E joins the remainder) |
| `catchTags({ Nope: ... })` | compile error |
| `catchIf(isPerm /* e is MVC\|MSM\|MEL */, ...)` | `Network`: exactly `Exclude<E, EB>` |
| `catchIf(Schema.is(MissingEmbedLinks), ...)` | `MVC \| MSM \| Network` |
| `catchIf((e): boolean => ..., ...)` | unchanged |
| `catchIf((e) => e._tag === "Network", ...)` | **narrows** to `MVC \| MSM \| MEL`. TS infers a type predicate from a simple arrow |
| `catchIf(Predicate.isTagged("Network"), ...)` | **unchanged**. `isTagged` refines to `{_tag: K}`, which is not a subtype of `E`, so the predicate overload is chosen |
| `Effect.catch(...)`, `Effect.orDie` | `never` |
| `mapError(e => e._tag)` | the tag literal union |
| `tapErrorTag(...)` | unchanged |
| catchTag handler parameter in a pipe, with an array of tags | exactly `MEL \| Network` |

## 4. Does Effect v4 (or dfx) already have error categories?

No. I searched `effect/src` for non-doc uses of `categor` (only a comment in
`ai/internal/mcpCore.ts`) and for `retryable` and `transient` (only
`AiError.isRetryable`, a getter on one class, and `Dns` docs). dfx has nothing
either: its only `categor` hits are Discord channel-type comments. What v4 does
have is the **reason pattern**: one parent tagged error holds a tagged
`reason` union, and `Effect.catchReason(parentTag, reasonTag, f, orElse?)`,
`Effect.catchReasons(parentTag, cases, orElse?)` and
`Effect.unwrapReason(parentTag)` act on it. Verified in `src/11-reason.ts`:

- `catchReason` without `orElse` leaves the **whole parent** in `E`
  (`PermissionError | Network`). That is coarser than `catchTag`.
- `unwrapReason("PermissionError")` lifts the reasons into `E`. After that,
  `catchTag` removes exactly one of them.

The reason pattern cannot express the brief. An error would have exactly one
parent, so it could not be in several categories, and errors would not keep
their own tag in `E`. So a category mixin is still needed. `catchReason` is
still the right way to act on dfx's or Effect's `HttpClientError` reasons
(`TransportError` and so on) when mapping them to `transient`.

## 5. Category mixin, ported to v4 (`src/03-category.ts`, compiled and run)

Sources: Arnaldi's gist (`withCategory(...cats)` plus a variadic
`catchCategory(...cats, f)`, with a string key and a record marker on the
prototype) and Niser's post (one `Symbol.for` marker per category set as a
class field, with `hasCategory` plus `catchCategory` built on
`Effect.catchIf`). Both target v3 and use `as any` and `@ts-expect-error`.
For the record, the gist's typing still compiles against v4 plus TS 7
(`src/03a-gist-direct.ts`), but it has the problems listed under the gotchas
below.

The port. Its only trust boundary is one overload signature. It uses no
`any`, no `as` and no `@ts-expect-error`:

```ts
import { Effect, Function, Predicate, type Schema } from "effect"

export const CategoryTypeId: unique symbol = Symbol.for("effect-discord-perms/ErrorCategory")
export type CategoryTypeId = typeof CategoryTypeId
export interface Categorized<K extends string> { readonly [CategoryTypeId]: { readonly [P in K]: true } }
export type Categories<E> = E extends { readonly [CategoryTypeId]: infer M } ? Extract<keyof M, string> : never
export type CategoryMarker<K extends string> = K extends string ? { readonly [CategoryTypeId]: { readonly [P in K]: true } } : never
export type ExtractCategory<E, K extends string> = Extract<E, CategoryMarker<K>>   // member of ANY of K
export type ExcludeCategory<E, K extends string> = Exclude<E, ExtractCategory<E, K>>

type AnySchemaClass = Schema.Class<unknown, Schema.Struct<Schema.Struct.Fields>, object>

export function withCategory<const K extends ReadonlyArray<string>>(...categories: K):
  <Self, S extends Schema.Struct<Schema.Struct.Fields>, Inherited>(base: Schema.Class<Self, S, Inherited>)
    => Schema.Class<Self, S, Inherited & Categorized<K[number]>>
export function withCategory(...categories: ReadonlyArray<string>) {
  return (base: AnySchemaClass): AnySchemaClass => {
    const inherited: object = Predicate.hasProperty(base.prototype, CategoryTypeId) &&
        Predicate.isObject(base.prototype[CategoryTypeId]) ? base.prototype[CategoryTypeId] : {}
    const marker: Record<string, true> = { ...inherited }
    for (const category of categories) marker[category] = true
    const Mixed = class extends base {}
    Object.defineProperty(Mixed.prototype, CategoryTypeId, {
      value: Object.freeze(marker), enumerable: false, writable: false, configurable: false
    })
    return Mixed
  }
}

export const hasCategory = <E, const K extends string>(categories: K | Readonly<[K, ...Array<K>]>) => {
  const list: ReadonlyArray<string> = typeof categories === "string" ? [categories] : categories
  return (error: E): error is ExtractCategory<E, K> => {
    if (!Predicate.hasProperty(error, CategoryTypeId)) return false
    const marker = error[CategoryTypeId]
    return Predicate.isObject(marker) && list.some((category) => marker[category] === true)
  }
}

export const catchCategory: {
  <const K extends Categories<E>, E, A2, E2, R2>(
    categories: K | Readonly<[K, ...Array<K>]>,
    f: (error: ExtractCategory<E, K>) => Effect.Effect<A2, E2, R2>   // NOT NoInfer<E>; see gotchas
  ): <A, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A | A2, E2 | ExcludeCategory<E, K>, R | R2>
  <A, E, R, const K extends Categories<E>, A2, E2, R2>(
    self: Effect.Effect<A, E, R>, categories: K | Readonly<[K, ...Array<K>]>,
    f: (error: ExtractCategory<E, K>) => Effect.Effect<A2, E2, R2>
  ): Effect.Effect<A | A2, E2 | ExcludeCategory<E, K>, R | R2>
} = Function.dual(3, <A, E, R, const K extends Categories<E>, A2, E2, R2>(
  self: Effect.Effect<A, E, R>, categories: K | Readonly<[K, ...Array<K>]>,
  f: (error: ExtractCategory<E, K>) => Effect.Effect<A2, E2, R2>
): Effect.Effect<A | A2, E2 | ExcludeCategory<E, K>, R | R2> => {
  const caught = Effect.catchIf(self, hasCategory<E, K>(categories), f)
  return caught
})
```

Usage:

```ts
export class MissingEmbedLinks extends Schema.TaggedError<MissingEmbedLinks>()("MissingEmbedLinks", {
  cause: DiscordCause
}).pipe(withCategory("permission", "payload")) {}
export class ThreadLocked extends Schema.TaggedError<ThreadLocked>()("ThreadLocked", {
  cause: DiscordCause
}).pipe(withCategory("state"), withCategory("access")) {}   // composes: marker = {state, access}
```

Verified with exact `Equals` assertions (`src/04-category-use.ts`). In the
table, MVC, MSM and MEL are permission errors (MEL is also payload), Slow is
state, TL is state plus access, Net is transient, and Unc has no category:

| Call | Handler `e` | Remaining `E` |
|---|---|---|
| `catchCategory("permission", ...)` | `MVC \| MSM \| MEL` | `Slow \| Net \| TL \| Unc` |
| `catchCategory("payload", ...)` | `MEL` | everything else, including MVC and MSM |
| `catchCategory("access", ...)` | `MVC \| MSM \| TL` | `MEL \| Slow \| Net \| Unc` |
| `catchCategory(["state","payload"], ...)` | `MEL \| Slow \| TL` | `MVC \| MSM \| Net \| Unc` |
| `catchCategory("payload")` then `catchCategory("permission")` | | `Slow \| Net \| TL \| Unc` |
| then `catchCategory("payload")` again | | compile error: the category is no longer present |
| `catchCategory("bogus", ...)` | | compile error |
| `catchCategory(self, "transient", f)` (data-first) | `Net` | all the others |
| `catchCategory("state", e => Effect.fail(e._tag))` | | remainder plus `"SlowmodeActive" \| "ThreadLocked"` |
| `Effect.catchTag("MissingEmbedLinks", ...)` on categorized errors | | exactly one tag removed |

Statics survive: `MissingEmbedLinks.make`, `.makeEffect`, `.fields`,
`Schema.decodeUnknownEffect(MissingEmbedLinks)` and
`Schema.Schema.Type<typeof MissingEmbedLinks> = MissingEmbedLinks` all
compile, and yielding the error still works.

Runtime checks (`bun src/04-run.ts`):
- The marker is on the prototype, not an own property, and it is frozen.
- `JSON.stringify` and `Schema.encodeSync` do not include it.
- `Schema.decodeUnknownSync` returns an instance with the marker. The class
  schema's decode builds `new Self(...)` from the **final** class, because
  `getClassSchema(this)` is memoized on first access to `.ast` from the
  user-facing class.
- `make` also returns an instance with the marker.
- `catchCategory(["payload","state"])` catches MEL, TL and Slow, and lets Net
  and Unc through.

Printed types are readable. `tsc --declaration` emits
`Schema.Class<MissingEmbedLinks, ..., YieldableError & Categorized<"payload" | "permission">>`
for the base, and narrowed unions print as class names
(`Effect<string, Network | SlowmodeActive | ThreadLocked | Uncategorized, never>`).

### Gotchas found while porting

1. **`NoInfer<E>` under `Extract` breaks data-last handlers.** With
   `f: (error: Extract<NoInfer<E>, ...>) => ...`, the handler's `e` became
   `never` in pipe position. Removing `NoInfer` fixed it. A minimal repro
   (`src/fail-noinfer/`) shows that `Extract<NoInfer<A | B>, X>` is `never`
   and `Exclude<NoInfer<A | B>, X>` is the whole of `NoInfer<A | B>`.
   Conditional types do not distribute over a `NoInfer`-wrapped union. This
   happens on **both TS 5.9.3 and TS 7.0.2** (checked with a TS 5.9 install
   in `.scratch/effect-v4/ts5/`), so it is not a TS 7 regression. Oddly,
   Effect's own `catchTag`, which uses `ExtractTag<NoInfer<E>, K>`, does type
   its handler correctly in a pipe. Rule: do not put `NoInfer` inside
   conditional types in our own combinators, and cover every handler
   parameter type with an `Equals` assertion.
2. **Type-parameter order matters for data-last inference.** With
   `<E, const K extends Categories<NoInfer<E>>>`, `K` inferred as `never`
   (`Argument of type 'string' is not assignable to parameter of type 'readonly [never, ...never[]]'`).
   Effect's ordering, `<const K extends Tags<E>, E, ...>`, works.
3. **`ExcludeCategory` has to be written as `Exclude<E, Extract<E, M>>`**,
   not `Exclude<E, M>`. Otherwise the generic body of `catchCategory` does not
   type-check against `Effect.catchIf`'s return type. The two forms resolve
   identically for concrete `E`.
4. **The gist mutates inherited markers.** It checks
   `categoriesKey in Mixed.prototype`, which walks the prototype chain, so
   applying `withCategory` to a subclass writes into the parent's marker
   object. The port copies the inherited marker into a fresh frozen object
   instead.
5. **The overload is an unchecked boundary.** TS accepts the public overload
   against the `(base: AnySchemaClass) => AnySchemaClass` implementation
   without proving that the marker type matches the runtime marker. This is
   the only place in the port where the types are trusted rather than
   checked. Keep it covered by the runtime test.
6. Do not put `in out` variance annotations on `Categorized<K>`. They would
   make `Categorized<"a" | "b">` unassignable to `{ [Id]: { a: true } }`
   constraints such as the handler boundary below.

### Alternatives that also compile (not chosen)

- **A class-body field instead of a mixin** (`src/13-field-alt.ts`):
  `readonly [CategoryTypeId] = PermissionPayload`, where the value has type
  `{ readonly permission: true; readonly payload: true }`. It needs no
  subclass and no overload, and `catchCategory` narrows the same way. On the
  other hand, it is an own enumerable symbol property on every instance
  (`JSON.stringify` still ignores it), the helper needs a cast, and the brief
  asks for a mixin.
- **A `Data.TaggedError` variant** (`src/12-data-mixin.ts`):
  `withCategoryClass(...)(Base)`, typed as
  `new(...args: Args) => I & Categorized<K>`. Because `Data.TaggedError("X")`
  takes its fields as a type argument at the `extends` site, you need two
  classes: `class XBase extends Data.TaggedError("X")<{...}> {}`, then
  `class X extends withCategoryClass("state")(XBase) {}`. It works at
  runtime. It is not needed if all public errors are Schema errors.

## 6. Constraining handler errors at a boundary

The goal is `Bot.on(handler)`, where the handler may leave only `transient`
errors unhandled. Seven techniques were prototyped (`src/boundary/lib.ts`),
each tested against valid handlers (`ok*.ts`) and invalid ones (`fail*.ts`).
The test errors are `MissingEmbedLinks` (permission plus payload),
`SlowmodeActive` (state) and `Network` (transient).

Accepted-handler matrix. A ✗ means a valid handler was wrongly rejected:

| Technique | `() => eff` | `(event) => ...` (context-sensitive) | `Effect.fn("h")(function*(event: T) ...)` | `Effect.orDie` opt-out | Names all unhandled tags? |
|---|---|---|---|---|---|
| A: `E extends { [Id]: { transient: true } }` | ✓ | ✓ | ✓ | ✓ | no, only the first |
| B: same, but the constraint is a named interface | ✓ | ✓ | ✓ | ✓ | no, only the first |
| C: `handler: ((ev) => Effect<void,E,R>) & HandlerCheck<E>` | ✓ | ✗ (E is fixed to `unknown`) | ✓ | ✓ | yes |
| D: conditional extra rest parameter | ✓ | ✗ | ✓ | ✓ | no ("Expected 2 arguments") |
| E: `Effect<void, E & OnlyTransient<NoInfer<E>>, R>` | ✓ | ✓ | ✓ | ✓ | **wrong**: lists `Network` too (the `NoInfer` gotcha) |
| F: the check intersected on the handler's **return** type | ✓ | ✓ | ✓ | ✓ | yes (one key per tag) |
| **F2**: F with one property whose value lists the tags | ✓ | ✓ | ✓ | ✓ | **yes** |
| G: infer the whole handler type `H` and check it | ✓ | ✗ | ✓ | ✓ | yes |

Recommended: **F2**.

```ts
type TagOf<E> = E extends { readonly _tag: infer T extends string } ? T : "<untagged>"
export type Unhandled<E> = ExcludeCategory<E, "transient">
export type HandlerCheck<E> = [Unhandled<E>] extends [never] ? unknown
  : { readonly "Unhandled errors (handle with catchTag/catchCategory, or opt out with Effect.orDie)": TagOf<Unhandled<E>> }
export declare function on<E, R>(
  handler: (event: MessageCreate) => Effect.Effect<void, E, R> & HandlerCheck<E>
): Registration
```

Actual tsc output for F2 (`tsc --pretty false`, TS 7.0.2):

```
src/boundary/failF2-context.ts(9,36): error TS2375: Type 'Effect<void, MissingEmbedLinks | Network, never>' is not assignable to type 'Effect<void, MissingEmbedLinks | Network, never> & { readonly "Unhandled errors (handle with catchTag/catchCategory, or opt out with Effect.orDie)": "MissingEmbedLinks"; }' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
  Property '"Unhandled errors (handle with catchTag/catchCategory, or opt out with Effect.orDie)"' is missing in type 'Effect<void, MissingEmbedLinks | Network, never>' but required in type '{ readonly "Unhandled errors (handle with catchTag/catchCategory, or opt out with Effect.orDie)": "MissingEmbedLinks"; }'.
src/boundary/failF2-context.ts(11,25): error TS2345: Argument of type '(event: MessageCreate) => Effect<void, MissingEmbedLinks | Network | SlowmodeActive, never>' is not assignable to parameter of type '(event: MessageCreate) => Effect<void, MissingEmbedLinks | Network | SlowmodeActive, never> & { readonly "Unhandled errors (handle with catchTag/catchCategory, or opt out with Effect.orDie)": "MissingEmbedLinks" | "SlowmodeActive"; }'.
  ...
    Property '"Unhandled errors (handle with catchTag/catchCategory, or opt out with Effect.orDie)"' is missing in type 'Effect<void, MissingEmbedLinks | Network | SlowmodeActive, never>' but required in type '{ readonly "Unhandled errors (handle with catchTag/catchCategory, or opt out with Effect.orDie)": "MissingEmbedLinks" | "SlowmodeActive"; }'.
src/boundary/failF2-extra.ts(4,33): error TS2375: Type 'Effect<never, Error, never>' is not assignable to type 'Effect<void, Error, never> & { readonly "Unhandled errors (...)": "<untagged>"; }' ...
```

For an inline lambda, the error is reported on the returned expression
(column 36). For an `Effect.fn` value or a block body, it is reported on the
argument. Transient errors such as `Network` are correctly left out of the
list. Untagged errors (`Error`, string literals) are rejected as
`"<untagged>"`.

Output for B, the best of the constraint-style techniques:

```
src/boundary/failB-context.ts(9,35): error TS2375: Type 'Effect<void, MissingEmbedLinks | Network, never>' is not assignable to type 'Effect<void, OnlyTransientErrorsMayEscapeAHandler, never>' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
  Type 'MissingEmbedLinks | Network' is not assignable to type 'OnlyTransientErrorsMayEscapeAHandler'.
    Type 'MissingEmbedLinks' is not assignable to type 'OnlyTransientErrorsMayEscapeAHandler'.
      Types of property '[CategoryTypeId]' are incompatible.
        Property 'transient' is missing in type '{ readonly payload: true; readonly permission: true; }' but required in type '{ readonly transient: true; }'.
```

With two unhandled errors, B still names only `MissingEmbedLinks`, not
`SlowmodeActive`.

Output for C, D and G with a valid context-sensitive handler (wrongly
rejected):

```
src/boundary/fail-context-CDG.ts(12,22): error TS2345: Argument of type '(event: MessageCreate) => Effect<void, Network, never>' is not assignable to parameter of type '((event: MessageCreate) => Effect<void, unknown, unknown>) & { readonly "Unhandled error \"<untagged>\": ...": never; }'.
src/boundary/fail-context-CDG.ts(17,18): error TS2554: Expected 2 arguments, but got 1.
```

All the diagnostics are in `.scratch/effect-v4/boundary-diagnostics.txt`.

Notes:
- Every TS2375 involving `Effect` ends with the noise
  `with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined'...`.
  This comes from the repo's `exactOptionalPropertyTypes`, and snapshot tests
  will include it.
- A diagnostic snapshot needs a real failing compile. `@ts-expect-error`
  hides the text. TS 7 ships no classic `ts.createProgram` JS API; its
  package exports only `typescript/unstable/{sync,async,ast,...}`. The simple
  route is to spawn `tsc -p tsconfig.<case>.json --pretty false` and snapshot
  stdout, as done here.

## 7. Branded snowflake IDs (`src/06-brand.ts`, compiled and run)

```ts
const SnowflakeString = Schema.String.check(Schema.isPattern(/^\d{17,20}$/))
export const ChannelId = SnowflakeString.pipe(Schema.brand("ChannelId"))
export type ChannelId = typeof ChannelId.Type          // = string & Brand.Brand<"ChannelId">
ChannelId.make("123456789012345678")                   // throws "Schema validation failed" when invalid
ChannelId.makeEffect(s); Schema.decodeUnknownEffect(ChannelId)(u)

// Brand module, without a schema
export type RoleId = Brand.Branded<string, "RoleId">
export const RoleId = Brand.nominal<RoleId>()          // no validation
export const MessageId = Brand.check<MessageId>(Schema.isPattern(/^\d{17,20}$/))  // throws BrandError
export const MessageIdSchema = Schema.String.pipe(Schema.fromBrand("MessageId", MessageId))
```

- `Schema.brand(id)` accepts only a single literal key (`EnsureSingleBrandKey`).
- A branded ID is still a `string`, so it can be passed straight to dfx,
  which types snowflakes as plain `string`.
- Mixing brands fails readably. The alias name is not shown, but the brand
  key is:

```
error TS2345: Argument of type 'string & Brand<"GuildId">' is not assignable to parameter of type 'string & Brand<"ChannelId">'.
  Type 'string & Brand<"GuildId">' is not assignable to type 'Brand<"ChannelId">'.
    Types of property '[TypeId]' are incompatible.
      Property 'ChannelId' is missing in type '{ readonly GuildId: "GuildId"; }' but required in type '{ readonly ChannelId: "ChannelId"; }'.
error TS2345: Argument of type 'string' is not assignable to parameter of type 'string & Brand<"ChannelId">'.
```

## 8. Services and layers (`src/08-service.ts`, `src/09-layers.ts`)

```ts
export class Messages extends Context.Service<Messages, {
  readonly send: (channel: ChannelId, content: string) => Effect.Effect<void, SendError>
}>()("effect-discord-perms/Messages") {
  static readonly layerTest = Layer.effect(Messages, Effect.gen(function*() {
    const send = Effect.fn("Messages.send")(function*(channel: ChannelId, content: string) { /* ... */ })
    return Messages.of({ send })
  }))
}
const m = yield* Messages                      // a service class is itself an Effect
Messages.use((m) => m.sent)                    // Service.use / useSync also exist
export const MaxContentLength = Context.Reference<number>("…/MaxContentLength", { defaultValue: () => 2000 })
Effect.provideService(MaxContentLength, 10)    // override
export class BotToken extends Context.Service<BotToken, Redacted.Redacted<string>>()("…/BotToken") {
  static readonly layer = Layer.effect(BotToken, Config.Redacted("DISCORD_SUBJECT_TOKEN"))  // Config is an Effect
}
Layer.succeed(S, S.of(impl)); Layer.sync(S, () => impl); Layer.effectDiscard(gen with Effect.forkScoped(...))
Layer.provide / Layer.provideMerge / Layer.mergeAll; Layer.launch(AppLayer).pipe(BunRuntime.runMain)
```

`Context.Service` signature (`Context.ts:319`):
`<Self, Shape>() => <const Identifier extends string, E, R, Args>(id, options?: { make?, fiberCached? }) => ServiceClass<Self, Identifier, Shape> & (make ? { make } : unknown)`.
The service exposes `of`, `context`, `use`, `useSync` and `key`. Use
`Messages["Service"]` to get the shape type.

## 9. `Effect.fn`, spans, and recording errors before recovery

Signatures: `Effect.fn: fn.Traced & { (name: string, options?: SpanOptionsNoTrace): fn.Traced }`,
`Effect.fn.Return<A, E = never, R = never> = Generator<Effect<any, E, R>, A, any>`, and
`Effect.withSpan(name, options?: SpanOptionsNoTrace | ((...args) => SpanOptionsNoTrace), traceOptions?)`.
The data-last form also accepts `(self, ...args)`, so it can be used as an
`Effect.fn` pipeable.

**Key source fact** (`internal/effect.ts`, `makeFn`): `Effect.fn(name)(body, ...pipeables)`
applies the pipeables to the body first and only then wraps the result in
`useSpan(name, ...)`. **The pipeables run inside the function's span.** If you
recover in a pipeable, the function's span shows success.

Verified at runtime with a recording `Tracer` installed via
`Effect.withTracer` (`bun src/07-spans.ts`):

```
error 1.span-then-catch          failing.pipe(Effect.withSpan(..), Effect.catchTag(..))
ok    2.catch-then-span          failing.pipe(Effect.catchTag(..), Effect.withSpan(..))
ok    3.fn-with-catch-pipeable   Effect.fn("..")(body, catchCategory(..))          <- failure hidden
error 4.fn-caller-catches        Effect.fn("..")(body)().pipe(catchCategory(..))
error 5.inner-call               yield* call.pipe(Effect.withSpan("inner"), catchCategory(..)) inside Effect.fn
ok    5.outer
ok    6.fn-annotate-then-catch   {"error.tag":"MissingEmbedLinks","discord.code":50013}  (tapError + annotateCurrentSpan, then catch)
ok    7.fn-event-then-catch      event "exception"  (tapError + currentSpan + span.event, then catch)
```

Rule for this project: define each REST operation as an `Effect.fn("Discord.op")`,
or wrap it in `Effect.withSpan`, and **recover outside it**, either at the call
site or in an outer function. If recovery has to live inside the same span,
record the error first with `Effect.tapError` plus `Effect.annotateCurrentSpan`
or a `span.event`. The span will still show success in that case. Other
tracing APIs that exist: `annotateSpans`, `currentSpan`, `currentParentSpan`,
`linkSpans`, `withParentSpan`, `withSpanScoped`, `makeSpan`, `useSpan`, and
`Tracer.Tracer` (a `Context.Reference`, default `nativeTracer`).

## 10. `@effect/vitest` 4.1.1 (`test/08-service.test.ts`, 6 tests pass)

```ts
import { assert, describe, it, layer } from "@effect/vitest"
it.effect("name", () => Effect.gen(function*() { ... }))      // Scope + TestClock provided
it.live("name", () => ...)                                    // real clock
it.effect.each(cases)("name %#", (c) => ...); it.effect.prop("name", [Schema.String], ([s]) => ...)
layer(Messages.layerTest)("suite", (it) => { it.effect(...) })  // one shared layer per block, torn down afterAll
// options: { concurrent?, memoMap?, timeout?, excludeTestServices?, buildPerTest? }; nested it.layer(...) exists
Effect.provide(Messages.layerTest)                            // per-test layer
yield* TestClock.adjust("10 seconds")                         // from "effect/testing"
```

- `@effect/vitest/utils` adds assertions that understand Effect values
  (`assertSome`, `assertExitFailure`, `assertSuccess`, ...).
- Both `node_modules/.bin/vitest run` (Node 24) and
  `bun --bun node_modules/.bin/vitest run` passed.
- The peer requirement is `vitest >=5 <6`.
- `@effect/vitest` re-exports all of `vitest`.

## 11. Compile cost baseline

`tsc -p .scratch/effect-v4 --extendedDiagnostics` (TS 7.0.2) over 556 files,
which include all of `effect`'s and dfx's declarations plus the code above:
37,767 types, 89,550 instantiations, check time 0.034s, total 0.088s, 164 MB.
The category and boundary types are not a measurable cost at this size.

## 12. Scratch index (`.scratch/effect-v4/`)

| File | What it shows |
|---|---|
| `src/01-errors.ts`, `01-run.ts` | Schema and Data tagged errors, `cause`, yieldable, validation at runtime |
| `src/02-catch.ts` | every combinator's narrowing, with `Equals` assertions |
| `src/03-category.ts` | the `withCategory` / `hasCategory` / `catchCategory` port |
| `src/03a-gist-direct.ts` | the gist's v3 typing compiled against v4 |
| `src/04-errors.ts`, `04-category-use.ts`, `04-run.ts` | categorized errors, narrowing assertions, runtime behaviour |
| `src/boundary/*` and `tsconfig.fail*.json` | handler-boundary techniques A to G and F2, ok and fail cases |
| `boundary-diagnostics.txt` | captured tsc output for the boundary techniques |
| `src/06-brand.ts`, `fail-brand.ts`, `06-run.ts` | branded snowflakes |
| `src/07-spans.ts` | span ordering versus recovery, with a recording tracer |
| `src/08-service.ts`, `09-layers.ts`, `test/08-service.test.ts` | Context.Service, Reference, Config, Layer, platform-bun, vitest |
| `src/10-message.ts`, `11-reason.ts`, `12-data-mixin.ts`, `13-field-alt.ts`, `14-typed-cause.ts` | message getter, reason pattern, Data mixin, class-field alternative, typed cause |
| `src/dbg-noinfer.ts`, `src/fail-noinfer/*`, `ts5/` | the `NoInfer` gotcha, reproduced on TS 7.0.2 and 5.9.3 |

## 13. Unverified

- Why Effect's own `catchTag`, with `ExtractTag<NoInfer<E>, K>`, gives its
  handler the right type in a pipe while the same-looking pattern in our code
  collapses. The behaviour is reproduced; the cause inside the TS checker was
  not traced.
- Editor hover output. Only `tsc --declaration` printing and diagnostic text
  were inspected. tsserver/LSP hover under TS 7 was not run.
- Whether `vitest --typecheck` or `expect-type` work with TS 7's `tsc` (no
  classic JS API). Not tested.
- How F2 behaves when the handler's `E` is still generic inside library code,
  as opposed to user call sites with concrete `E`. Not tested.
- How these patterns perform at the reference-bot scale (dozens of error
  classes and handlers). Only the scratch baseline was measured.
