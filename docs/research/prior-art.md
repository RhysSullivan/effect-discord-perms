# Prior art and design patterns

Research only. Every snippet marked **compiled** was type-checked with the repo's
TypeScript 7.0.2 and the repo's strict settings (including
`exactOptionalPropertyTypes`). The checks ran against effect 4.1.1 and dfx 1.1.1
from `node_modules`, in `.scratch/prior-art/exp/`. Snippets marked **ran** were
also executed with Bun 1.4.4. Excerpts from other libraries were copied from the
published `.d.ts` or source files of the version named. I unpacked those files
with `npm pack` into `.scratch/prior-art/pkgs/`. Anything I could not check is
marked **UNVERIFIED**.

Versions read: discord.js 14.28.0 and 15.0.0-dev.1793491372; @discordjs/core
2.7.0; @discordjs/rest (latest); @discordjs/structures 1.0.0-dev; @discordeno/bot
21.0.0 (Dec 2024) and 22.0.0-beta.2; seyfert 5.2.1; dressed 2.0.0;
@buape/carbon 0.17.0; discord-hono 0.23.0; @harmonyland/harmony 2.9.0 (last
published 2023); lilybird 0.9.0-beta.4; @sapphire/discord.js-utilities (latest);
Kord (main branch, read with `gh api`).

---

## 0. Summary

1. **Nobody we found computes required permissions from the payload type, and
   nobody gates events by intents at compile time.** I searched npm, GitHub and
   the web. Both features would be new. The closest relatives are discordeno's
   `desiredProperties`, which change field types based on config, and Kord's
   `enableEvent<T>()`, which derives intents from events at runtime.
2. **The error-category pattern ports to Effect v4 unchanged.** Arnaldi's gist
   compiles verbatim against effect 4.1.1 with TS 7, and `catchCategory` removes
   exactly the caught members (compiled + ran). Effect v4 has no category
   combinator of its own. Its nearest feature, `catchReason`, is a different
   model, and it keeps the parent error in the type unless you pass an `orElse`.
   dfx has nothing similar either.
3. **The handler boundary should not rely on plain assignability alone if the
   diagnostics must name the problem.** With a plain `Effect<_, Transient, _>`
   constraint, tsc 7 reports the first structural mismatch, such as "Property
   'status' is missing in type 'MissingEmbedLinks'". It does not list the leaked
   tags. It also appends a misleading `exactOptionalPropertyTypes` hint. An
   intersected "message object" lists every leaked tag by name (compiled).
4. **Effect's HttpApi and Rpc are the closest prior art for our handler
   boundary, and both show the same diagnostic weakness.** HttpApi also uses a
   template-literal message for missing handlers
   (`"Endpoint not handled: list"`, which reads well) and `never` for duplicate
   handlers (which does not). I compiled all three cases.
5. **dfx findings that affect the design.** I verified each of these by running
   it:
   - A single failing `handleDispatch` handler stops the whole listener, so later
     events are never handled.
   - `Helpers/permissions.applyOverwrites` gives different answers depending on
     the order of the role overwrites.
   - The resolver ignores timeouts.
   - Command sync is a blind bulk overwrite on every start and on every
     `GUILD_CREATE`.
6. **Runtime permission getters in mature libraries are wrong in many
   state-dependent ways**: timeouts, archived threads, pins in voice channels.
   discord.js issues #9730 and #11192 are still open. This supports making the
   live oracle, not the docs, the source of truth.

---

## 1. Required reading

### 1.1 Xetera, "Building a robust permissions system in TypeScript" (2021)

What it argues:

- A boolean `hasPermission` check gives the type checker no information. The
  bug it shows is `if (!can) { sendError() } /* forgot return */ submit()`.
- The fix is a **phantom type**: `AuthorizedUser<T> = User & { [phantom]: T }`,
  keyed by a non-exported `unique symbol` so the field cannot be read. Functions
  that need a permission take `AuthorizedUser<WriteComment>`, so callers must
  narrow first. It is structural typing, so the phantom has to be an actual
  property.
- Narrowing can come from a result union, where `authorize()` returns
  `{type:"ok", user} | {type:"fail", reason}`. It can also come from a type guard
  (`user is AuthorizedUser<T>`). With the guard, the missing `return` becomes a
  compile error.
- It rejects enums for permission sets because `1 & 2` is `never`. It uses
  object types so permission sets can be both unioned and intersected.
- Gotchas it admits: casts bypass the check, so keep the unsafe code in a few
  well-tested functions.

What it means for us:

- `Permissions.require(channel, [...])` is exactly Xetera's `authorize`. It
  returns a channel handle whose phantom parameter records the permissions the
  preflight saw.
- **The difference from Xetera's model:** Xetera's server owns the permission
  state. Discord owns ours, and it can revoke a permission between preflight
  and request. The narrowed type therefore must not *drop* the permission
  failure. It should swap the specific `Missing*` errors for one coarse,
  still-`permission` error. The brief already asks for
  `PermissionDeniedUnattributed` on a 50013 when the recompute finds nothing
  missing. This also answers monbrey's objection to `Client<true>` in discord.js
  [#6073](https://github.com/discordjs/discord.js/pull/6073): "These are forced
  types, not inferred ones… If there exists cases where it is wrong, then it is
  wrong".
- Enums are a non-issue for us. `discord-api-types` widens every
  `PermissionFlagsBits` member to plain `bigint`, which I checked in
  `payloads/common.d.ts`. Type-level permission sets therefore have to be
  **unions of flag names**. "Requires all of" becomes an `Exclude<Required,
  Granted>` subset test, so no intersection is needed.

**Compiled** (`require-narrow.ts`). `require` narrows the error union, and the
stale-permission case keeps a single coarse tag:

```ts
type Flag = "ViewChannel" | "SendMessages" | "EmbedLinks" | "AttachFiles"
declare const Granted: unique symbol
interface TextChannel<G extends Flag = never> { readonly id: string; readonly [Granted]?: G }
class PermissionChangedSinceCheck extends Schema.TaggedError<PermissionChangedSinceCheck>()(
  "PermissionChangedSinceCheck", { flag: Schema.String }) {}

type Required<P> = "ViewChannel" | "SendMessages" | (P extends { readonly embeds: ReadonlyArray<unknown> } ? "EmbedLinks" : never)
type SendError<P, G extends Flag> =
  | (Exclude<Required<P>, G> extends infer F extends Flag ? F extends Flag ? MissingPermission<F> : never : never)
  | ([Extract<Required<P>, G>] extends [never] ? never : PermissionChangedSinceCheck)

const unchecked = send(ch, { embeds: [{}] })
// error tags: "MissingViewChannel" | "MissingSendMessages" | "MissingEmbedLinks"
const ok = yield* require(ch, ["ViewChannel", "SendMessages"])
const r = send(ok, { embeds: [{}] })
// error tags: "MissingEmbedLinks" | "PermissionChangedSinceCheck"
```

### 1.2 Ethan Niser, "Effect Best Practices" (living document, updated Aug 2025)

These points apply to us. Names were checked against effect 4.1.1, because the
post targets v3:

| Niser (v3) | Effect 4.1.1 equivalent (verified in `node_modules/effect/src`) |
|---|---|
| Fallible synchronous work should be an `Effect`, not an `Either` | same; `Either` is now `Result` (`Effect.result`) |
| No `unknown` in the error channel; use `Cause.UnknownException` | `Cause.UnknownError` (`Cause.ts:1881`) |
| `Cause.failureOrCause` | `Cause.findError` returns `Result<E, Cause<never>>` (`Cause.ts:971`) |
| Give errors a `cause` | still right. The brief requires a schema-typed `cause` (code, message, route) |
| **Don't use `Schema.Unknown`** in schema errors that cross a boundary; map internal `Data.TaggedError` to strict `Schema.TaggedError` | matches the brief ("Nothing in the error channel is `unknown`") |
| Be careful with `catchAll` / `retry` swallowing errors | `Effect.catch` is the v4 name |
| **`withSpan` just outside `Effect.either` never marks the span failed** | still true in v4; see below |
| RPC transport errors are defects by default | relevant if we ever expose an Rpc; not for phase 1 |
| Use `Clock`, not `Date.now()` | matters for the 3-second auto-defer and for timeout checks in tests |

**Ran** (`span-order.ts`, custom `Tracer.make` that records each span's exit):

```ts
const outside = failing.pipe(Effect.catch(() => Effect.void), Effect.withSpan("span-outside-recovery"))
const inside  = failing.pipe(Effect.withSpan("span-inside-recovery"), Effect.catch(() => Effect.void))
const outsideResult = failing.pipe(Effect.result, Effect.withSpan("span-outside-result"))
// => ["span-outside-recovery: ok","span-inside-recovery: failed","span-outside-result: ok"]
```

The brief's rule, "Apply spans before recovery", therefore needs a test. A
`catchCategory` applied inside a span silently turns the span green.

### 1.3 Ethan Niser, "Error Categories in Effect" (Jun 2025), and Mike Arnaldi's gist

Niser's post:

- Inheritance cannot express categories, because `TaggedError` already takes
  the single base class.
- He uses **mixins** instead. A mixin is a function from class to class,
  composable with `pipe`, and each category is an interface keyed by a
  `Symbol.for(...)`.
- `hasCategory` is a type guard built on `Extract<A, Record<Category, any>>`.
- `catchCategory` is `Effect.catchIf(effect, hasCategory(sym), f)`. Its output
  type is `Exclude<E, Record<Category, any>>`.
- Tim Smart wrote the `catchCategory` function.

Arnaldi's gist (created 2025-06-05, last updated 2026-01-09) refines this:

- Categories are **string literals** stored on the prototype under
  `"@effect/error/categories"`, as `{ [cat]: true }`.
- One error can be in several categories:
  `.pipe(withCategory("system", "domain"))`.
- `catchCategory("system", "domain", f)` catches several categories at once
  through a variadic `[...Categories, f]` rest tuple.
- Unknown categories are rejected, because the categories are constrained to
  `AllKeys<E>`.

**Port to Effect v4 (compiled + ran).** The gist compiles **verbatim** against
effect 4.1.1 and TS 7.0.2. `Schema.TaggedError<Self>()(tag, fields)` has the
same shape in v4, and `.pipe(mixin)` works on the class. I added assertions in
`arnaldi-gist-v4.ts`. All of them pass:

```ts
assertType<Equals<Effect.Error<typeof program>,  FooError>>(true)   // caught "system"
assertType<Equals<Effect.Error<typeof program2>, BazError>>(true)   // caught "domain"
assertType<Equals<Effect.Error<typeof program3>, never>>(true)      // caught both
// @ts-expect-error -- unknown category is rejected
baz(1).pipe(catchCategory("nope", (_) => Effect.void))
const made = BarError.make({})                                      // statics survive the mixin
// runtime: ["BazError",["system"],true]  (tag, categories, instanceof Error)
```

The gist leans on `any` and `@ts-expect-error`, which our hard constraints ban.
That includes the mixin's `new (...args: any[])` signature. TS requires that
signature for `class extends Base` mixins, and my first mixin attempt without
it failed with `TS2510 Base constructors must all have the same return type`.

**An alternative without `any` (compiled + ran, `categories-getter.ts`).** Drop
the mixin. Each error class declares a prototype getter that returns a frozen
marks object. The getter is the single source of truth for both the type and
the runtime check. It is not an own property, so it does not affect encoding:
`Object.keys(e)` is `["_tag"]`, and `Schema.encodeSync` emits only the fields.
This suits the brief well, because the `Missing*` classes are code-generated
anyway:

```ts
export class MissingEmbedLinks extends Schema.TaggedError<MissingEmbedLinks>()("MissingEmbedLinks", { cause: DiscordCause }) {
  get [CategoriesKey]() { return PermissionPayload }   // marks("permission", "payload")
}
const isInCategories = <E, C extends Category>(cats: ReadonlyArray<C>) =>
  (e: E): e is InCategories<E, C> => { /* hasProperty checks, no cast */ }
export const catchCategory = <E, const C extends ReadonlyArray<CategoriesOf<E>>, A2, E2, R2>(
  ...args: [...C, (e: InCategories<E, C[number]>) => Effect.Effect<A2, E2, R2>]
) => <A, R>(self: Effect.Effect<A, E, R>) => Effect.catchIf(self, isInCategories<E, C[number]>(cats), f)
```

These assertions pass: catching `"payload"` leaves
`MissingViewChannel | ThreadArchived | DiscordUnavailable`; catching
`"permission"` removes both `Missing*`; catching `"access", "state"` removes
exactly those members; `catchTag("MissingEmbedLinks")` removes exactly that tag;
and the handler parameter is exactly `MissingEmbedLinks`. Two `as` casts remain,
only where the variadic `[...C, f]` tuple is split. A non-variadic signature,
such as `catchCategory(["payload"], f)` or a record form, would remove them.

**Does Effect v4 already provide this?** It does not. Effect 4.1.1 has:

- `Effect.catchIf(refinement, f, orElse?)`. Its output is `Exclude<E, EB>`, and
  categories build on it.
- `Effect.catchTag`, `catchTags` and `catchFilter`.
- `Effect.catchReason`, `catchReasons` and `unwrapReason`
  (`Effect.ts:5144`). These handle **one wrapper error with a `reason` field**,
  for example `AiError { reason: RateLimit | Quota }`. This is a different
  model, with one parent tag and nested reasons, and no tag belongs to more than
  one group.

From its signature, `catchReason` without `orElse` **keeps the parent tag in
`E`** (`… | (A3 extends unassigned ? ExtractTag<E, K> : never)`). It therefore
cannot shrink the error union the way the boundary needs. The `effect-tsgo`
issue tracker even has a proposed lint rule for stacked `catchReason` calls
(Effect-TS/tsgo#622).

dfx has no category concept. A grep for "categor" finds only Discord's channel
category in generated docs.

### 1.4 discord.js #9300 and JMTK's experiment

[discord.js#9300](https://github.com/discordjs/discord.js/issues/9300) is a
roadmap issue from 2023-03-30, still open. It proposes that `Client#ready`
should mirror Discord's `READY` event instead of waiting for every
`GUILD_CREATE`. It also argues that with optional caches, user code should be
runtime-safe "no matter what cache/intent options they pass". The author warns
against encouraging users to assert `cached!`, because a config change would
make those assertions invalid with no compile-time help.

JMTK's comment
([1490507040](https://github.com/discordjs/discord.js/issues/9300#issuecomment-1490507040))
reads: "Could the Client be a different type based on the intents being passed
in, so the emitted events could 'know'…". Its screenshot is transcribed here:

```ts
interface UncachedMessage { guild?: { someproperty: string } }
interface CachedMessage   { guild:  { someproperty: string } }
interface Client       { on(event: 'message', listener: (message: UncachedMessage) => void): this }
interface CachedClient { on(event: 'message', listener: (message: CachedMessage) => void): this }
class Client extends EventEmitter {
  static create(cache: false): Client
  static create(cache: true): CachedClient
  static create(cache: boolean = false): Client | CachedClient { /* ... */ }
}
Client.create(false).on('message', m => m.guild.someproperty) // error: guild possibly undefined
Client.create(true).on('message', m => m.guild.someproperty)  // ok
```

That is the idea of **typing the client by its config, through overloads on the
factory**. It is the same idea discordeno later shipped as `desiredProperties`
(section 2.3). Our intent-typed events would be a generic version of it: a
`const` tuple of intents goes into `Bot.make`, and `on(...)` checks against
that tuple.

**Compiled** (`intents.ts`). These are three ways to reject an event whose intent
is missing, with the diagnostics tsc 7 gives:

```ts
// (1) restrict the key union
on1<K extends { [E in keyof EventIntents]: [Extract<EventIntents[E], I>] extends [never] ? never : E }[keyof EventIntents]>(event: K): void
// error: Argument of type '"GUILD_MEMBER_ADD"' is not assignable to parameter of type '"MESSAGE_CREATE"'.

// (2) intersect with a message object when the intent is missing
on2<K extends keyof EventIntents>(event: K & ([Extract<EventIntents[K], I>] extends [never]
  ? { readonly "missing intent, add one of": EventIntents[K] } : unknown)): void
// error: Argument of type '"GUILD_MEMBER_ADD"' is not assignable to parameter of type
//        '"GUILD_MEMBER_ADD" & { readonly "missing intent, add one of": "GuildMembers"; }'.

// (3) HttpApi-style: intersect with never
// error: Argument of type '"GUILD_MEMBER_ADD"' is not assignable to parameter of type 'never'.
```

Only (2) names the missing intent. (1) gives better autocompletion, because only
the allowed events are offered, but its error lists what *is* allowed rather
than what is missing.

The 2023 thread the brief describes, which asked whether `channel.send` could
fail to compile until permissions were checked, is **UNVERIFIED**. A GitHub
issue and discussion search of discordjs/discord.js did not find it. It was
probably on Discord.

---

## 2. Typed Discord libraries: techniques worth stealing or avoiding

| Library | Compile-time trick | Steal / avoid |
|---|---|---|
| discord.js | `Client<Ready>`, `CacheType` generic plus `inGuild()`/`inCachedGuild()` guards, private phantom field, `Extract<Channel, {send}>`, `getChannel(name, required, channelTypes)` | steal the phantom-field guard and the method-presence union; avoid the 3-state cache generic |
| @discordjs/structures (v15) | `Omitted` generic; omitted fields become `unknown` | avoid (`unknown` is opaque) |
| discordeno | `desiredProperties` rewrite each object type; `ChangeType` puts a named error object in place of an undesired field | steal the named-error-object field for `message.content`; avoid the deep recursive rewrite of every type |
| seyfert | options as a record; `ContextOptions<T>` (required, choices as a literal union, `channel_types` narrowing); `LowercaseDeclareName` | steal all of these; avoid global module-augmentation registries |
| dressed | key-remapped `MapOptions`, tuple-indexed option values, per-interaction `Omit` of methods | steal the tuple index; the `Omit` sets are the starting point for typestate |
| Carbon | `BrandedId` / `BrandedIdLike`; field-name-driven deep branding | steal the ids (decision needed on `Like`); avoid the deep branding |
| discord-hono | `NoSemicolon<C>` returns `never`; `UnionToIntersection` over nested options | avoid both |
| harmony | decorators; intent requirements only in doc comments | baseline we are replacing |
| Sapphire utilities | `canSendEmbeds(channel): boolean` and similar | runtime boolean; Xetera's anti-pattern |
| discordeno permissions-plugin (archived) | monkey-patched helpers that `throw new Error("Missing Permissions: A & B")` | the string-check anti-pattern the brief bans |
| Kord (Kotlin) | `Intents.Builder.enableEvent<T>()` derives intents from event types | alternative direction for intents (decision) |
| dfx (our base) | `const A` command inference; `optionValue` typed by `required` | reuse; see the gaps below |

### 2.1 discord.js (14.28.0; v15 dev unchanged on these points)

**The ready and cache generics, with a phantom field to make narrowing work:**

```ts
// typings/index.d.ts
export class Client<Ready extends boolean = boolean> extends BaseClient {
  // This a technique used to brand the ready state. Or else we'll get `never` errors on typeguard checks.
  private readonly _ready: Ready;
  public user: If<Ready, ClientUser>;
  public isReady(): this is Client<true>;
}
export type CacheType = 'cached' | 'raw' | undefined;
export type CacheTypeReducer<State extends CacheType, CachedType, RawType = CachedType,
  PresentType = CachedType | RawType, Fallback = PresentType | null> =
  [State] extends ['cached'] ? CachedType : [State] extends ['raw'] ? RawType
  : [State] extends ['raw' | 'cached'] ? PresentType : Fallback;
export class BaseInteraction<Cached extends CacheType = CacheType> extends Base {
  private readonly _cacheType: Cached;            // same branding trick
  public guildId: CacheTypeReducer<Cached, Snowflake>;
  public inGuild(): this is BaseInteraction<'raw' | 'cached'>;
  public inCachedGuild(): this is BaseInteraction<'cached'>;
}
export class Message<InGuild extends boolean = boolean> extends Base {
  public inGuild(): this is Message<true>;
}
export type SendableChannels = Extract<Channel, { send: (...args: any[]) => any }>;
```

Technique: a generic parameter recorded by a **private phantom field**, with
`this is X<…>` guards to narrow it. Without the phantom field, TS's structural
comparison turns the guards into `never`. That is issue
[#7160](https://github.com/discordjs/discord.js/issues/7160): after
`inGuild()`, both `inRawGuild()` and `inCachedGuild()` produced `never`. It was
fixed by wrapping the conditional in tuples (`[State] extends [...]`) and by
adding the brand.

Channel option narrowing (`getChannel(name, true, [ChannelType.GuildText])`)
uses `<const Type extends ChannelType>` and an `Extract` on `type`. It needs a
special case because `PublicThreadChannel['type']` is itself a union:

```ts
public getChannel<const Type extends ChannelType = ChannelType>(name: string, required: true, channelTypes?: readonly Type[]):
  Extract<NonNullable<CommandInteractionOption<Cached>['channel']>,
    { type: Type extends ChannelType.PublicThread | ChannelType.AnnouncementThread
        ? ChannelType.PublicThread | ChannelType.AnnouncementThread : Type }>;
```

Option getters are **not** typed by the command definition. `getString(name:
string, required: true): string` relies on the caller repeating `required:
true`, and any option name is accepted.

Interaction response state is **runtime only**: `deferred: boolean`,
`replied: boolean`, and the runtime errors `InteractionAlreadyReplied` and
`InteractionNotReplied` (`src/errors/ErrorCodes.js`). There is no typestate.

REST errors: `DiscordAPIError { code: number | string; status; method; url;
rawError }`, from @discordjs/rest. Users compare `code` against
`RESTJSONErrorCodes`, which is the integer form of a string check.

DX complaints found:

- **#7160**: guard narrowing collapsed to `never` (fixed as described above).
- **#7924** (13 comments): errors that are a wall of conditional types in
  non-strict mode, for example `Type 'MappedInteractionTypes<Cached>[T]' does
  not satisfy the constraint ...`, nested many levels deep. The maintainers'
  answer was "We don't support running TS without strict mode". The lesson:
  generic-heavy typings break under user configs you do not control. Our
  diagnostic snapshots should run under the repo's strict config.
- **#8563**: `isRepliable()` did not narrow as users expected; the result was an
  intersection type.
- **#8652**: `RepliableInteraction` did not respect the `Cached` generic.
- **#6073**: the `Client<Ready>` PR debate between "forced" and "inferred"
  types, discussed in 1.1.

Runtime permission getters are incomplete on state.
[#9730](https://github.com/discordjs/discord.js/issues/9730), open since 2023,
reports that `permissionsFor()` ignores timeouts.
[#11192](https://github.com/discordjs/discord.js/issues/11192), open, reports
that `editable`, `pinnable`, `kickable`, `bannable` and `crosspostable` skip the
timeout check. It also lists: `pinnable` missing ReadMessageHistory and wrongly
true in voice channels; `ThreadChannel.editable` and `joinable` missing
ViewChannel or SendMessagesInThreads; and `crosspostable` not checking the guild
feature. A maintainer notes that "an interaction's `appPermissions` will change
its bit field if timed out", which supports the brief's choice to use
`app_permissions` in interactions. That claim is **UNVERIFIED live**. discord.js
models thread sendability as:

```js
// src/structures/ThreadChannel.js  get sendable()
if (permissions.has(PermissionFlagsBits.Administrator, false)) return true; // "allows sending even if timed out"
return !(this.archived && this.locked && !this.manageable) &&
  (this.type !== ChannelType.PrivateThread || this.joined || this.manageable) &&
  permissions.has(PermissionFlagsBits.SendMessagesInThreads, false) &&
  this.guild.members.me.communicationDisabledUntilTimestamp < Date.now();
```

Each clause is a hypothesis for the live matrix: Administrator bypasses the
timeout; archived plus locked plus not manageable blocks sending; private
threads need membership or ManageThreads.

### 2.2 @discordjs/core and @discordjs/structures

- `@discordjs/core` 2.7.0 provides `MappedEvents` keyed by
  `GatewayDispatchEvents`, with `ToEventProps<Data>` that adds `{ api,
  shardId }`. It uses raw `discord-api-types` payloads with no intent gating.
- `@discordjs/structures` (v15 dev) has `Structure<DataType, Omitted extends
  keyof DataType | ''>`. Omitted keys stay present but are typed `unknown`
  (`ReplaceOmittedWithUnknown`). Getters use `"type" extends Omitted ? unknown :
  API["type"]`. **Avoid**: `unknown` neither explains itself nor stops a user from
  passing it on.

### 2.3 discordeno (21.0.0; main and 22.0.0-beta.2)

`createBot({ desiredProperties })` rewrites every transformed object type
according to which fields the bot asked for. There are two behaviors:

```ts
// @discordeno/bot 22.0.0-beta.2 dist/desiredProperties.d.ts (main has the same)
declare const TypeErrorSymbol: unique symbol
export interface DesiredPropertiesError<T extends string> { [TypeErrorSymbol]: T }
type IsKeyDesired<TKey, TDependencies, TProps> = TKey extends keyof TProps
  ? TProps[TKey] extends true ? true
    : DesiredPropertiesError<`This property is not set as desired in desiredProperties option in createBot(), so you can't use it. More info here: https://discordeno.js.org/desired-props`>
  : /* dependency check producing a similar message listing the deps */ ...
export type SetupDesiredProps<T, TProps, TBehavior = DesiredPropertiesBehavior.RemoveKey> = {
  [Key in keyof T as TBehavior extends DesiredPropertiesBehavior.RemoveKey ? RemoveKeyIfUndesired<Key, T, TProps> : Key]:
    TBehavior extends DesiredPropertiesBehavior.ChangeType ? GetErrorWhenUndesired<Key, T, TProps, TBehavior> : TransformProperty<T[Key], TProps, TBehavior>
}
```

With **`RemoveKey`**, the default, an undesired field disappears. The docs list
the caveats: "You don't know all the properties available" and "If a property
requires other properties… you won't know them".

With **`ChangeType`**, an undesired field is typed as a named error. In v21 the
error was a template-literal **string**. PR
[#4208](https://github.com/discordeno/discordeno/pull/4208), merged 2025-06-01,
switched it to an object keyed by a `unique symbol`. The reason given: with a
string, "Typescript may not always error… e.g. channel.name is always a string
so typescript won't error", for example on `.endsWith(...)`. The object form
still lets `if (message.poll)` compile.

That is directly useful for "`message.content` is available only where Discord
delivers it". **Compiled** (`techniques.ts`):

```ts
declare const DesiredError: unique symbol
interface IntentRequired<Msg extends string> { readonly [DesiredError]: Msg }
interface MessageWithoutContentIntent {
  readonly content: IntentRequired<"message.content needs the MessageContent intent (or a DM / mention / own message)">
}
m.content.toUpperCase()
// error TS2339: Property 'toUpperCase' does not exist on type 'IntentRequired<"message.content needs the MessageContent intent (or a DM / mention / own message)">'.
const s: string = m.content
// error TS2322: Type 'IntentRequired<"message.content needs ...">' is not assignable to type 'string'.
```

DX complaints:

- **Hover clutter.** PR #4050 and the docs section "Removing TypeScript
  Clutter" show hovers like `Promise<SetupDesiredProps<User,
  CompleteDesiredProperties<{ message: {...}; user: {...} }>,
  DesiredPropertiesBehavior.RemoveKey>>`. The documented workaround: `interface
  BotDesiredProperties extends Required<typeof desiredProperties> {}` and pass
  `desiredProperties as BotDesiredProperties`. Hovers then show the interface
  name. Takeaway: **give named interfaces to computed config types** so hovers
  stay short, which the brief requires.
- `strictNullChecks` is required, as the docs say.
- `desiredProperties` was made required (PR #4381) because users did not know
  they needed it. Issue #4157 is a user confused by `undefined` message fields.
- Exported inferred types live under `bot.transformers.$inferredTypes`, a
  type-only property that is `undefined` at runtime.

The archived **discordeno/permissions-plugin** was the classic runtime preflight.
It monkey-patched `bot.helpers.sendMessage` and checked the cache:

```ts
if (content.tts) requiredPerms.push("SEND_TTS_MESSAGES");
if (content.messageReference) requiredPerms.push("READ_MESSAGE_HISTORY");
requireBotChannelPermissions(bot, channel, requiredPerms);
// … throw new Error(`Missing Permissions: ${missing.join(" & ")}`);
```

Its README: "should not be done for big bot developers as it requires the cache
plugin". It shows the failure modes the brief bans: string errors, a combined
"A & B" message where the brief wants the most fundamental tag, untyped throws,
and decisions made only from the cache.

### 2.4 seyfert (5.2.1)

Options are a **record keyed by name**, and the handler context is computed from
it:

```ts
// lib/commands/applications/chat.d.ts
type KeysWithoutRequired<T extends OptionsRecord> = { [K in keyof T]-?: NonNullable<T[K]['required']> extends true ? never : K }[keyof T];
type ContextOptionsAux<T extends OptionsRecord> =
  { [K in Exclude<keyof T, KeysWithoutRequired<T>>]: ContextOptionsAuxInternal<T[K]> } &
  { [K in KeysWithoutRequired<T>]?: ContextOptionsAuxInternal<T[K]> };
// ContextOptionsAuxInternal: a custom `value` parser's output, else channel_types → CommandOptionChannel<C[number]>,
// else choices → C[number]['value'], else ReturnOptionsTypes[T['type']]
export declare function createStringOption<R extends boolean, C extends readonly SeyfertChoice<string>[] = ..., VC = never>(data: SeyfertStringOption<C, R, VC>): {...}
```

That covers what the brief asks for: required versus optional, choices as a
literal union, and channel options narrowed by `channel_types`. Using a record
instead of an array also removes the array-order issue from the types. The
"required before optional" rule is then enforced when the record is serialized,
not by the types.

Lowercase names give readable diagnostics:

```ts
// lib/commands/decorators.d.ts
type LowercaseDeclareName<T extends CommandDeclareOptions> = { [K in keyof T]: K extends 'name'
  ? T extends { type: ApplicationCommandType.User | ApplicationCommandType.Message } ? T[K]
  : string extends T[K] ? T[K] : T[K] extends Lowercase<T[K] & string> ? T[K] : Lowercase<T[K] & string> : T[K] };
export declare function Declare<const T extends CommandDeclareOptions>(input: LowercaseDeclareName<T>): ...
```

**Compiled** minimal version: `command({ name: "Ping", ... })` gives `error
TS2322: Type '"Ping"' is not assignable to type '"ping"'`. That is about as
readable as a diagnostic gets: the expected type *is* the fix. Context-menu
commands are exempt, which matches Discord: User and Message commands allow
uppercase and spaces. Non-literal `string` passes through, consistent with the
brief's "checked when written as literals".

Bot permissions: `@Declare({ botPermissions: [...] })` is checked at handler
entry against `interaction.appPermissions` (`commands/handle.js:47`). The
failure is routed to `onBotPermissionsFail(context, permissions:
PermissionStrings)`, which receives a string array. The declared list is not
tied to what the handler actually does.

DX complaint: seyfert uses global **module augmentation registries**
(`declare module 'seyfert' { interface SeyfertRegistry { middlewares: typeof
middlewares } }`). PR [#438](https://github.com/tiramisulabs/seyfert/pull/438)
fixed `TS2502`/`TS7022` circularity: a middleware typed with `CommandContext`
depended on the registry that was being inferred from that middleware. **Avoid
global registries**; pass types through values instead (`Bot.make({ intents,
commands })`).

### 2.5 dressed (2.0.0)

```ts
// dist/types/interaction.d.ts
type OptionValue<P extends APIApplicationCommandOption, R = true> = [never, {/*subcommand*/}, {/*group*/},
  string, number, boolean, APIUser, APIInteractionDataResolvedChannel, APIRole, APIUser | APIRole, number, APIAttachment][P["type"]];
export type MapOptions<T extends APIApplicationCommandOption[], R = true> = {
  [P in T[number] as P["name"]]: Requirable<P["required"] extends R ? true : false, OptionValue<P, R>>;
};
export type ModalInteraction = APIModalSubmitInteraction & Omit<BaseInteractionMethods, "showModal" | "sendChoices"> & {...}
```

There are two techniques here:

- **A tuple indexed by the numeric option type** instead of a chain of
  conditional types. This is a cheap, non-distributive lookup.
- **Key remapping** (`as P["name"]`) to turn an array of options into a record.

Usage is `export const config = {...} satisfies CommandConfig` with
`CommandInteraction<typeof config>`.

Per-interaction-kind method sets drop `showModal` from `ModalInteraction`, which
covers the brief's "a modal cannot be opened from a modal submit". This is not
typestate, though. Answered and deferred state is a runtime `history` array.

`ActionRow` documents "Up to 5 buttons or a single SelectMenu" only in a comment.
The types do not enforce it. **Compiled** (`techniques.ts`, simplified): the
tuple-indexed map with required/optional split gives `opts.count: number`, and
`opts.reason: string | undefined`.

### 2.6 Carbon (@buape/carbon 0.17.0)

```ts
// dist/src/types/index.d.ts
type BrandedId<Brand extends string> = string & { readonly __brand: Brand };
type BrandedIdLike<Brand extends string> = string & { readonly __brand?: Brand };
export type ChannelId = BrandedId<"ChannelId">;      export type ChannelIdLike = BrandedIdLike<"ChannelId">;
type BrandDiscordIdField<Key extends string, Value, Id extends string> = Key extends "id" ? BrandStringValue<Value, Id>
  : Key extends "guild_id" ? BrandStringValue<Value, GuildId> : /* ~30 more field names */ ...;
export type BrandedDiscordIds<T, Id extends string = string> = /* recursive over every object/array field */
```

**Compiled** (`techniques.ts`). The optional brand on the input type accepts a
plain string but rejects a different brand, with a clear message:

```text
error TS2345: Argument of type 'UserId' is not assignable to parameter of type 'BrandedIdLike<"ChannelId">'.
  Types of property '__brand' are incompatible.
    Type '"UserId"' is not assignable to type '"ChannelId"'.
```

The brief says IDs "cannot be mixed". A `Like` input still accepts an unbranded
string, so a user could pass a role ID they hold as a raw string. That is a
**decision** (section 5). The field-name-driven deep branding is a long
conditional chain applied recursively to every payload. **Avoid** it: it costs
compile time and is fragile. Branding should happen once, where values are
decoded.

custom_id parsing is at runtime: `key:arg1=true;arg2=2`, with numbers and
booleans coerced and data typed `Record<string, string | number | boolean>`. It
is not schema-typed.

### 2.7 discord-hono (0.23.0)

- `type NoSemicolon<S extends string> = S extends `${string};${string}` ? never :
  S` produces "not assignable to parameter of type 'never'". **Avoid** it.
- `ExtractCommandVars` flattens **all nested subcommand options into one bag**
  with `UnionToIntersection` + `Simplify`, so the handler does not know which
  subcommand it is in. It is also an expensive type pattern. **Avoid** it.
- `ExcludeMethods<Context, 'resModal' | …>` per context kind. This is the same
  idea as dressed.

### 2.8 harmony, lilybird, Sapphire

- **harmony** (last published 2023): decorator-based (`@slash`, `@event`).
  Intent requirements appear only in doc comments ("`GUILD_VOICE_STATES` needs
  to be set").
- **lilybird**: intents are a `number`; there is nothing type-level.
- **@sapphire/discord.js-utilities**: `canSendMessages`, `canSendEmbeds`,
  `canSendAttachments`, `canReact` and similar, each returning `boolean`. These
  are runtime payload-to-permission tables:
  `canSendEmbedsPermissions = [ViewChannel, SendMessages, EmbedLinks]`. They
  return `true` for any DM and for non-guild channels, and they check
  `SendMessages` rather than `SendMessagesInThreads` (relying on discord.js
  `thread.sendable` for threads). They are a good **checklist of cases** for the
  live matrix, but the API is exactly the boolean Xetera argues against.

### 2.9 Kord (Kotlin): deriving intents from events

```kotlin
// core/src/commonMain/kotlin/Util.kt
/** E.g. [MessageCreateEvent] will add the [GuildMessages], [DirectMessages] and [MessageContent] intents … */
public inline fun <reified T : Event> Intents.Builder.enableEvent(): Unit = enableEvent(T::class)
public fun Intents.Builder.enableEvent(event: KClass<out Event>): Unit = when (event) { GuildCreateEvent::class, … -> … }
```

This runs in the opposite direction to the brief: it computes intents from the
handlers instead of checking handlers against declared intents. Whether Kord
applies it by default when no intents are given is **UNVERIFIED**. I read only
`Util.kt` and the changelog line "Intents are now lazily evaluated (#409)".

### 2.10 dfx 1.1.1 (our base): prior art and gaps relevant to this design

- **Command option typing exists.** `Ix.global(const A, (ix) => ...)` infers the
  definition, and `ix.optionValue(name)` accepts only required option names
  (`AllRequiredCommandOptions<A>["name"]`). Values map only BOOLEAN to
  `boolean`, INTEGER and NUMBER to `number`, and everything else to `string`.
  Choices are not narrowed to their literals, and channel options are not
  narrowed by kind (`Interactions/commandHelper.ts`).
- **Component routing is a predicate on the string**:
  `messageComponent(pred: (customId: string) => boolean, handle)`. It is not
  schema-typed.
- **The interaction error boundary is at `run(postHandler)`.** The postHandler
  receives `TE | DiscordRESTError | DefinitionNotFound`.
  `InteractionBuilder<R, E, TE>` also has `catchTagRespond` and similar
  methods (`Interactions/builder.ts`).
- **Gateway handler failures stop the listener.** `handleDispatch` is built on
  `subscribeForEachPar`, which completes a `Deferred` with the first failing
  exit and races the loop against it. **Ran** (`dfx-dispatch.ts`): I published
  four `MESSAGE_CREATE` events and the handler failed on the second. The result
  was `{"seen":["1","2"],"listenerExit":"Failure"}`, so events 3 and 4 were
  never handled. "Transient errors may stay unhandled" at our boundary must
  therefore mean *report and continue per event*. It must not mean "propagate
  into dfx".
- **The overwrite resolution depends on array order.** `applyOverwrites`
  applies `(current & ~deny) | allow` for each overwrite in API array order,
  after filtering @everyone, role and member overwrites into one list. **Ran**
  (`dfx-overwrites.ts`), with @everyone granting SendMessages, role A allowing
  it and role B denying it: `[allowA, denyB]` gives no SendMessages and
  `[denyB, allowA]` gives SendMessages. Discord's documented algorithm
  aggregates all role denies, then all role allows, so allow should win. That
  is a docs hypothesis for the live matrix to confirm.
- `@everyone` is found by `role.name === "@everyone"` rather than `id ===
  guild_id`, in `Helpers/members.ts` and `permissions.ts`. Whether a custom
  role can be *named* `@everyone` is **UNVERIFIED**.
- There is no timeout handling and no implicit-permission logic. For example,
  without ViewChannel nothing else applies, but the resolver does not model
  that.
- **Command sync is not diffed.** `run` calls `bulkSetApplicationCommands` at
  start and `bulkSetGuildApplicationCommands` for every guild, then again on
  every `GUILD_CREATE` (`Interactions/gateway.ts`). The brief's "re-register
  only when definitions change" has to be built.
- REST errors are `DiscordRestError<"ErrorResponse", ErrorResponse> |
  DiscordRestError<"RatelimitedResponse", …> | HttpClientError`. These are
  generic per endpoint in `DiscordREST/Generated.ts` and not specific to a code,
  so mapping a 50013 code to our tags requires reading `data.code`. That is fine internally; the brief bans string checks only in
  the public API.

### 2.11 Permissions computed from payload types: no prior art, one trap

There is no library precedent. I searched npm, GitHub and the web. The closest
are Sapphire's runtime tables and the discordeno plugin's `if (content.tts)
push(...)`.

Prototype (**compiled**, `payload-perms.ts`). The trap is optional fields. A
payload typed through a wider annotation (`const p: Payload = ...`) has
`embeds?:`, so a naive `P extends { embeds: … }` **under-approximates**: it
returns `never` while the runtime value has embeds.

```ts
type NaivePerms<P> = (P extends { readonly embeds: ReadonlyArray<Embed> } ? "EmbedLinks" : never) | ...
type MayHave<P, K extends PropertyKey, Empty> = K extends keyof P ? (Exclude<P[K & keyof P], undefined | Empty> extends never ? false : true) : false
type SoundPerms<P> = (MayHave<P, "embeds", readonly []> extends true ? "EmbedLinks" : never)
                   | (MayHave<P, "tts", false> extends true ? "SendTTSMessages" : never)

send({ content: "hi", embeds: [{ title: "x" }] })   // naive: EmbedLinks, sound: EmbedLinks
const built: Payload = { content: "hi", embeds: [] }
send(built)                                          // naive: never (WRONG), sound: EmbedLinks | SendTTSMessages
send({ content: "hi", embeds: [] })                  // sound: never
```

The rule is to over-approximate whenever the type cannot prove the field absent.
The error union must be a superset of what can happen at runtime. Whether an
empty `embeds: []` really needs no EmbedLinks is **UNVERIFIED live**.

### 2.12 Intent-typed events: no TS prior art

No TypeScript library I found gates `on(event)` by declared intents. discord.js
(`ClientEvents`), @discordjs/core (`MappedEvents`), harmony, lilybird and dfx
(`handleDispatch<K extends \`${GatewayDispatchEvents}\`>`) all accept every
event regardless of intents. discordeno gates *fields* by config, not events by
intents. Section 1.4 has the compiled diagnostics for the formulations I tried.

---

## 3. Effect-ecosystem prior art for typed boundaries

### 3.1 HttpApi (`effect/http-api`)

```ts
// HttpApiEndpoint.ts:758 — the handler's error type is fixed by the declaration
export type Handler<Endpoint extends Constraint, E, R> = (request: Simplify<Endpoint["~Request"]>) =>
  Effect<SuccessType<Endpoint["~Success"]> | HttpServerResponse, Endpoint["~Error"]["Type"] | PayloadError<Payload<Endpoint>> | E, R>
// HttpApiBuilder.ts — typestate over handled identifiers + template-literal messages
export interface Handlers<R, EndpointsByIdentifier, HandledIdentifiers extends keyof EndpointsByIdentifier = never> {
  handle<Identifier extends keyof EndpointsByIdentifier, R1>(
    identifier: Identifier & NotHandledIdentifier<Identifier, HandledIdentifiers>, handler: …
  ): Handlers<R | …, EndpointsByIdentifier, HandledIdentifiers | Identifier>
}
type ValidateHandlersReturn<A, H = …, Missing = …> = … [Missing] extends [never] ? A : `Endpoint not handled: ${Missing & string}`
```

Here `E` is `MiddlewareError<Endpoint>`, so a handler may fail only with
declared errors. Errors also carry HTTP mapping as schema annotations, for
example `HttpApiError.BadRequest` with `httpApiStatus: 400`. Our analog would be
an optional "default interaction reply" annotation on error classes, so that an
unhandled `MissingEmbedLinks` in a slash command can map to an ephemeral "I need
Embed Links here" reply.

**Compiled** (`httpapi.ts`). These are the actual diagnostics:

```text
// handler leaks an undeclared error
error TS2375: Type 'Effect<string, NotFound | Undeclared, never>' is not assignable to type
  'Effect<string | HttpServerResponse, NotFound, never>' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' …
  Type 'NotFound | Undeclared' is not assignable to type 'NotFound' with 'exactOptionalPropertyTypes: true'. …
    Property 'id' is missing in type 'Undeclared' but required in type 'NotFound'.
// same endpoint handled twice
error TS2345: Argument of type '"get"' is not assignable to parameter of type 'never'.
// endpoint forgotten
error TS2322: Type 'Handlers<never, EndpointMap<…>, "get">' is not assignable to type '"Endpoint not handled: list"'.
```

The template-literal return check reads well. The `never` intersection does
not. The leaked-error message names the offending type only indirectly, through
a structural detail.

### 3.2 Rpc (`effect/rpc`)

`RpcGroup.toLayer({ Tag: handler })`, where each handler is
`ToHandlerFn<Rpc>` returning `ResultFrom<Rpc, R>`, which in turn is
`Effect<Success | Deferred<…>, Error["Type"], R>`. The approach matches
HttpApi. **Compiled** (`rpc.ts`) diagnostic: `Type 'Effect<string, NotFound |
Undeclared, never>' is not assignable to type 'WrapperOr<Effect<string |
Deferred<string, NotFound>, NotFound, any>>'` … `Property 'id' is missing in
type 'Undeclared' but required in type 'NotFound'.`

### 3.3 Handler-boundary formulations, measured (**compiled**, `boundary.ts`, `boundary2.ts`)

Setup: `send: Effect<"sent", MissingEmbedLinks | ThreadArchived |
DiscordUnavailable>`, where only `DiscordUnavailable` is `transient`. These are
the diagnostics for registering it unhandled:

| Formulation | Diagnostic | Verdict |
|---|---|---|
| A. plain `handler: () => Effect<void, Transient, R>` | reports **`Type 'string' is not assignable to type 'void'`** (the success mismatch comes first; the leaked error is not mentioned) | the success type must be `unknown` or the error is hidden |
| A'. same with success `unknown` | `… is not assignable to type 'Effect<unknown, DiscordUnavailable, never>' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined'…` then `Property 'status' is missing in type 'MissingEmbedLinks' but required in type 'DiscordUnavailable'.` | names the first leak only, plus a misleading hint |
| B. infer `E`; intersect the handler with `{ readonly "Unhandled errors (handle them, or use Effect.orDie)": <leaked tags> }` | `… is not assignable to type '{ readonly "Unhandled errors (handle them, or use Effect.orDie)": "MissingEmbedLinks" \| "ThreadArchived"; }'` | names every leaked tag and the fix |
| C. rest-tuple check parameter carrying a template-literal message | `Expected 3 arguments, but got 2.` with related info `Arguments for the rest parameter 'check' were not provided.` The message text never appears | avoid |
| D. `Effect<unknown, E & Allowed<E>, R>` with per-member `MustHandle<Tag>` | a cross-product union of intersections, 6 levels deep | avoid |
| E. validate in the return type | fires only if the caller annotates the result | not viable for statements |

The `exactOptionalPropertyTypes` hint in A' disappears with the flag off (TS2322
instead of TS2375). The repo enables the flag, so every assignability-based
diagnostic involving `Effect` will carry the misleading hint. Snapshot tests
should prefer formulations like B, where the failing assignment is to an object
with a message key rather than between two `Effect`s.

Option B kept `E` inference intact. `onB("MESSAGE_CREATE", () =>
Effect.orDie(send))` and the fully handled case compile. A handler that catches
only `MissingEmbedLinks` is rejected with a message naming just the remaining
tag: `… is not assignable to type '{ readonly "Unhandled errors (handle them, or
use Effect.orDie)": "ThreadArchived"; }'`.

### 3.4 Effect language service (`@effect/tsgo`)

The Effect-patched tsc has a `missingEffectError` rule, `TS377003`, severity
error. Its documented output is "Missing errors Boom in the expected Effect
type", which is exactly the readable boundary message. It ships as a drop-in
`effect-tsgo tsc -p tsconfig.json` and can fail the tsc exit code. I did not
install it, so whether it applies to our boundary signatures and how it fits the
compile budget are **UNVERIFIED**. It would also make readable diagnostics
depend on a patched compiler (a decision).

---

## 4. Recommendations for our API

1. **Categories: getter marks plus `catchCategory` built on `Effect.catchIf`
   with a user-defined type guard.** This avoids `any`, mixins and
   `@ts-expect-error` (compiled). Generate one class per permission flag, with a
   getter that returns a shared frozen marks object. Keep `catchTag` working
   unchanged. Consider a non-variadic signature, `catchCategory(["payload"], f)`
   or `catchCategories({ payload: f })`, to drop the two tuple-splitting casts.
   Do not adopt `catchReason` for categories; see 1.3.
2. **Handler boundary: infer `E`, then intersect with a message object that
   names the leaked tags** (formulation B). Accept any success type
   (`unknown`). Make the opt-outs greppable: `Effect.orDie`, `catchCategory`.
3. **Per-event isolation at the boundary.** Each handler invocation runs in its
   own fiber with its own span. Unhandled `transient` errors are recorded on the
   span and logged; they are never propagated to dfx's `handleDispatch`, which
   would stop the listener (verified). Wrap dfx's handler so it can never fail.
4. **`Permissions.require` narrows to a coarse error, not to success.** It
   replaces `Missing<X>` for the checked flags with one `permission`-category
   tag that covers revocation after the check
   (`PermissionDeniedUnattributed` or a dedicated `PermissionChangedSinceCheck`).
   The type then never promises success (compiled).
5. **Type-level permissions are unions of flag names.** `discord-api-types`
   gives no literal bit values. Derive "requires all" as `Exclude<Required,
   Granted>`.
6. **Payload-to-permission computation must over-approximate.** Include a
   permission unless the type proves the field absent, empty or `false`. Test a
   widened, annotated payload explicitly (compiled trap in 2.11).
7. **Intents: the factory carries a `const` tuple, and `on(event)` intersects
   the key with `{ "missing intent, add one of": … }`** (formulation 2 in 1.4).
   `message.content` without the intent becomes a named error object, in
   discordeno's `ChangeType` style (compiled), rather than an absent key or a
   string. The DM, mention and own-message exceptions narrow it back to
   `string`, pending live verification.
8. **Command definitions: a record of options as in seyfert, with
   `Lowercase<>`-mapped "expected" types** for name rules. These give
   diagnostics like `'"Ping"' is not assignable to '"ping"'` (compiled). Map
   option values with a dressed-style tuple indexed by the numeric type, instead
   of conditional chains. Narrow choices to their literals and channel options
   to `channel_types`, which are dfx's two gaps.
9. **IDs: brand once, at decode.** Use `Schema` brands on snowflakes in decoded
   payloads, with no deep, field-name-driven re-branding of payload types (the
   Carbon anti-pattern). The input policy for raw strings is a decision.
10. **Readable hovers: name the computed types.** Expose interfaces such as
    `interface MyBot extends Bot<...> {}`, or have `Bot.make` return a named
    interface, so hovers show names instead of expanded generics. This follows
    the discordeno clutter workaround.
11. **Keep spans inside recovery** and test it with a recording tracer, as in
    1.2. The `withSpan`/`catch` order bug is silent.
12. **Use phantom fields for narrowing state.** Any `Interaction<State>`
    typestate (phase 3) should carry a private or symbol-keyed phantom field for
    each type parameter, as discord.js does, so `this is` guards do not collapse
    to `never`.

## 5. Anti-patterns to avoid

- **A `never` parameter as the error signal** (`NoSemicolon<C>` returning
  `never`, HttpApi's `NotHandledIdentifier`, `K & never`). The diagnostic reads
  "not assignable to parameter of type 'never'" and names nothing.
- **A rest-tuple "check" argument**: tsc 7 shows "Expected N arguments", not the
  message.
- **Conditional types in the inference site** (`Effect<unknown, E &
  Allowed<E>, R>`): this produces a wall of intersections (measured).
- **Removing keys to signal unavailability** (discordeno `RemoveKey`). Users
  cannot discover why the field is missing.
- **Typing unavailable fields as a template-literal string** (discordeno v21
  `ChangeType`). String methods still type-check. Use a branded object.
- **`unknown` for omitted data** (@discordjs/structures).
- **Global module-augmentation registries** (seyfert): circular inference,
  TS2502/TS7022.
- **Deep recursive type rewrites of every payload** (Carbon's
  `BrandedDiscordIds`, discordeno's `TransformProperty`): compile cost and hover
  clutter.
- **`UnionToIntersection` to merge nested option bags** (discord-hono): it loses
  subcommand structure and is expensive.
- **Boolean preflights** (`canSendEmbeds(): boolean`, Sapphire), and **string
  errors** such as `throw new Error("Missing Permissions: A & B")` (discordeno
  plugin).
- **Permission getters that ignore state**: timeouts, archived or locked
  threads, channel-kind support (discord.js #9730, #11192). Model these as
  separate `state` tags, verified live.
- **Order-dependent overwrite folding** (dfx `applyOverwrites`, verified).
- **Bulk re-registering commands on every start and every `GUILD_CREATE`**
  (dfx).
- **"Forced" types** (#6073): a type parameter that claims a state the runtime
  cannot guarantee.

## 6. Decisions this research raises

1. **Boundary diagnostics.** Should we use formulation B (intersection message,
   runs on stock tsc), or plain assignability plus the `@effect/tsgo`
   `missingEffectError` rule (a patched compiler and an extra dependency)?
2. **What `Permissions.require` narrows to.** Should a narrowed call keep
   `PermissionDeniedUnattributed`, or get a dedicated
   `PermissionChangedSinceCheck` tag? Either way it stays in the `permission`
   category.
3. **ID inputs.** Should the public API accept only branded IDs (strict "cannot
   be mixed"), or also unbranded string literals through a Carbon-style
   `IdLike` that still rejects other brands?
4. **Intent gating style.** Should `on()` restrict the key union (better
   autocompletion, but the error lists allowed events) or use the message
   intersection (the error names the missing intent)? Should we also offer
   Kord-style derivation of intents from registered handlers?
5. **`catchCategory` signature.** Variadic, as in the gist (two internal casts),
   or array/record form (no casts)?
6. **`exactOptionalPropertyTypes`.** Keep it, and accept the misleading hint in
   every `Effect` assignability diagnostic snapshot? Or design every must-fail
   case around message objects so the hint never appears?
7. **Whether to wrap or fork dfx's permission resolver and command sync.** Both
   are needed for correctness (overwrite order, timeouts, diffing). The reason
   would go in `LOG.md`.

## 7. Unverified

- The original 2023 discord.js thread about `channel.send` and permissions was
  not found on GitHub.
- "An interaction's `appPermissions` reflects timeouts" (a discord.js maintainer
  comment in #9730) has not been checked live.
- Discord's documented overwrite algorithm (all role denies, then all role
  allows) still needs to be confirmed by the live matrix.
- Whether a custom role can be named `@everyone`, which matters to dfx's
  name-based lookup.
- Whether `embeds: []` or a `tts: false` payload needs no EmbedLinks or
  SendTTSMessages.
- Whether Kord derives intents from listeners by default.
- How `@effect/tsgo`'s `missingEffectError` behaves on our signatures, and what
  it costs at compile time (not installed).
- I made no compile-time or instantiation measurements of these patterns at
  realistic scale, for example around 60 `Missing*` classes in a union.

## Appendix: scratch files (git-ignored)

`.scratch/prior-art/exp/`:

| File | What it shows |
|---|---|
| `arnaldi-gist-v4.ts` | the gist, verbatim, plus v4 assertions |
| `categories-getter.ts` | categories without `any` |
| `boundary.ts`, `boundary2.ts` | handler-boundary formulations |
| `httpapi.ts`, `rpc.ts` | Effect boundary diagnostics |
| `techniques.ts` | seyfert, Carbon, discordeno and dressed tricks |
| `intents.ts` | intent-gating diagnostics |
| `payload-perms.ts` | the optional-field trap |
| `require-narrow.ts` | Xetera-style narrowing |
| `span-order.ts` | span placement relative to recovery |
| `dfx-overwrites.ts` | overwrite order dependence |
| `dfx-dispatch.ts` | listener stops after a handler failure |

`.scratch/prior-art/raw/` holds article text and the gist.
`.scratch/prior-art/pkgs/` holds the unpacked libraries.
