# Research index and cross-check

This is the entry point to the phase-0 research for effect-discord-perms. It
indexes the five research docs, resolves where they disagree, fills the gaps
that blocked design, and lists the design decisions with a recommendation for
each.

Everything new here was checked by reading source or by compiling and running
code in `.scratch/cross-check/` (effect 4.1.1, dfx 1.1.1, discord-api-types
0.38.57, TypeScript 7.0.2, Bun 1.4.4). The local copies of Discord's docs repo
(`9d2128bb`, 2026-10-30) and OpenAPI spec (`4e75626a`, 2026-10-29) are in
`.scratch/discord-semantics/apidocs` and `apispec`. Nothing touched
discord.com. Anything not checked is marked **UNVERIFIED**.

## 1. The docs

| Doc | Authoritative for | Read it when |
|---|---|---|
| [dfx.md](dfx.md) | What dfx 1.1.1 does at runtime: REST error shapes, 429 loop, gateway dispatch semantics, cache prelude, `Perms`, `Ix`, escape hatches (`rest.httpClient`, `Discord.make`, `DispatchHook`) | wrapping any dfx call |
| [effect-v4.md](effect-v4.md) | Effect 4.1.1 API names, combinator narrowing (exact `Equals` tables), the `withCategory`/`catchCategory` port, span placement versus recovery, `@effect/vitest` | writing errors, services, combinators |
| [type-testing.md](type-testing.md) | TS 7.0.2 tooling: `tsc` flags, the fixture runner and snapshot format, the compile budget (`--checkers 1`), diagnostic techniques and what they print | building `verify:offline` |
| [discord-semantics.md](discord-semantics.md) | Discord behaviour as numbered hypotheses H-001 to H-245, each with a live test, plus the 2026 platform changes (obfuscation on Nov 16, the new permission endpoints, PIN_MESSAGES) | designing the matrix and the resolver |
| [prior-art.md](prior-art.md) | What other libraries do (discord.js, discordeno, seyfert, dressed, Carbon, Kord, HttpApi/Rpc) and which techniques to take or avoid | API shape for intents, options, IDs, typestate |
| README.md (this file) | Contradictions resolved, gaps filled, open questions, decisions | first |

Cross-check scratch (`.scratch/cross-check/`; all files type-check with
`tsc -p .`, and the `*-runtime.ts` files run with `bun run`):

| File | Shows |
|---|---|
| `src/identities-runtime.ts` | **Two bot identities in one layer graph share one DiscordREST (both send the first token)**; `Layer.fresh` fixes it |
| `src/boundary/`, `src/fail/{F2,B,T3R,T3S,T3O}-*.ts`, `fail-diagnostics.txt` | Head-to-head of all handler-boundary techniques on the same fixtures |
| `src/boundary/t3o-generic.ts`, `generic-forward-ok.ts`, `src/fail/generic-forward.ts` | T3O infers `R` and a generic event key; generic forwarders must take the checked type |
| `src/bot-on.ts`, `src/fail/bot-on-intent.ts` | One `Bot.on` signature with both the intent check and the handler check |
| `src/payload/perms.ts`, `use.ts`, `hover.ts`, `lsp-hover.ts` | Payload type to required permissions to error union. The union is sound, swaps in SendMessagesInThreads for threads, and hovers as class names |
| `src/q2-classes.ts`, `q2-types.ts`, `q2-runtime.ts` | Operation-dependent categories through same-tag subclasses |
| `src/commands.ts`, `src/fail/commands.ts` | Command order, name and count rules on a const tuple |
| `src/slowmode-429-runtime.ts`, `src/coded-429-runtime.ts` | dfx swallows a 429 carrying code 20016; a base-client interceptor surfaces it |
| `src/env-runtime.ts`, `envtest/` | `bun --no-env-file` plus `ConfigProvider.fromDotEnv` |
| `src/capabilities-codec.ts`, `codec-runtime.ts` | Opting in to channel obfuscation through a replacement gateway codec |

## 2. Contradictions, resolved

### C1. Handler boundary technique: three docs recommend three different things

- effect-v4 recommends **F2**: a message object intersected on the handler's
  return type.
- type-testing recommends **technique 3**: a parameter that collapses to a
  template-literal message. It was tested only on a bare `Effect` argument,
  never on a handler function.
- prior-art recommends **B**: a message object intersected on the whole
  handler. It was tested only with zero-argument thunks.

I ran all of them, plus two variants of technique 3 applied to the handler's
**return** type, on the same fixtures. The errors were `MissingEmbedLinks`
(permission and payload), `ThreadLocked` (state), `MissingViewChannel`
(permission and access) and `DiscordUnavailable` (transient).

Valid handlers (each should compile):

| Handler shape | F2 | B | T3R / T3S / T3O |
|---|---|---|---|
| `() => transientOnly` | ok | ok | ok |
| `(event) => cond ? Effect.void : transientOnly` | ok | **rejected** | ok |
| `Effect.fn("h")(function* (event: T) {...})` | ok | ok | ok |
| `(event) => Effect.orDie(leaky)` | ok | **rejected** | ok |
| `(event) => Effect.gen(...)` with `catchCategory` | ok | **rejected** | ok |
| block body with two `return`s | ok | **rejected** | ok |
| `(event) => leaky.pipe(catchTag([...]))` | ok | **rejected** | ok |

B rejects every context-sensitive handler, `orDie` included. E is fixed to
`unknown` before the lambda is checked. This is the same failure effect-v4
recorded for its technique C, which is B under another name.

Invalid handlers. Sizes are the full diagnostic; the gate is type-testing's
4 lines / 600 characters:

| Case | F2 | B | T3R | T3S | **T3O** |
|---|---|---|---|---|---|
| ctx, 1 leaked tag | 2L/753c, noise | 2L/602c, names `"<untagged>"` | 1L/213c | 1L/197c | 1L/244c |
| ctx, 3 leaked tags | 2L/795c, noise | 2L/678c, `"<untagged>"` | 1L/403c | 1L/355c | 1L/322c |
| `Effect.fn`, 3 tags | 3L/1118c, noise | 2L/683c | 2L/843c | 2L/747c | 2L/608c |
| thunk, 1 tag | 2L/755c, noise | 2L/618c | 1L/215c | 1L/199c | 1L/246c |
| block, 1 tag | 3L/1115c, noise | 2L/604c, `"<untagged>"` | 2L/466c | 2L/434c | 2L/455c |

"noise" means the misleading `with 'exactOptionalPropertyTypes: true'.
Consider adding 'undefined'...` header. F2 always carries it because it
intersects with `Effect`. B's check misfires for context-sensitive handlers,
so the message says `"<untagged>"` instead of naming the tag.

**Resolution: T3O.** The handler's return type collapses to a *named
interface* when non-transient errors remain:

```ts
// .scratch/cross-check/src/bot-on.ts (compiled)
type TagOf<E> = E extends { readonly _tag: infer T extends string } ? T : "<untagged>"
interface UnhandledErrors<Tags extends string> { readonly "catch these, or use Effect.orDie": Tags }
type Handled<A, E, R> = [ExcludeCategory<E, "transient">] extends [never] ? Effect.Effect<A, E, R>
  : UnhandledErrors<TagOf<ExcludeCategory<E, "transient">>>

export interface Bot<I extends Intent> {
  readonly on: <K extends keyof Events, A, E, R>(
    event: K & IntentCheck<K, NoInfer<I>>,
    handler: (event: Events[K]) => Handled<A, E, R>
  ) => Effect.Effect<void, never, R>
}
```

Actual output for three leaked tags:

```
src/fail/T3O-ctx3.ts(5,53): error TS2741: Property '"unhandled errors (catch them, or use Effect.orDie)"' is missing in type 'Effect<string, DiscordUnavailable | MissingEmbedLinks | MissingViewChannel | ThreadLocked, never>' but required in type 'CatchOrOrDie<"MissingEmbedLinks" | "MissingViewChannel" | "ThreadLocked">'.
```

(The fixture's interface was named `CatchOrOrDie` with a longer key; the
recommended `UnhandledErrors` name is the one compiled in `bot-on.ts`.)

What T3O gives:

- It accepts all seven valid shapes.
- It names every leaked tag once, in a single union, rather than once per tag
  as T3R and T3S do.
- It carries no `exactOptionalPropertyTypes` noise.
- It infers `R` and a generic event key `K` exactly (`t3o-generic.ts`,
  `Equals` assertions).
- It combines with the intent check on the event key (`bot-on.ts`). A missing
  intent prints `Argument of type '"GUILD_MEMBER_ADD"' is not assignable to
  parameter of type '"GUILD_MEMBER_ADD" & { readonly "missing intent, add one
  of": "GuildMembers"; }'`.

Two caveats:

- The `Effect.fn` case is 608 characters. The size is dominated by the user's
  own error union, printed twice, so a fixed character cap on user-sized
  unions will eventually break. See decision D2.
- Every technique, F2 included, rejects library code that forwards a handler
  whose `E` is still generic (`src/fail/generic-forward.ts`). Internal
  forwarders must take the already-checked type, `(event) => Handled<A, E, R>`
  (`generic-forward-ok.ts` compiles). This settles effect-v4's UNVERIFIED item
  on generic E.

### C2. Does a category mixin need `any`?

prior-art says TS requires `new (...args: any[])` for `class extends Base`
mixins (it hit TS2510), so it moved to a prototype getter. effect-v4 says its
mixin has no `any`, `as` or `@ts-expect-error`.

**Resolution: effect-v4 is right.** I copied its port to
`.scratch/cross-check/src/category.ts`. It compiles, and the grep for `any`
or ` as ` hits only comments. TS2510 applies to *generic* mixins
(`<T extends Constructor>(Base: T) => class extends Base`). The port types
`base` as the concrete `Schema.Class<unknown, Struct<Fields>, object>` and
puts the precise type on a separate overload signature. That overload is the
one unchecked trust boundary, as effect-v4 says. prior-art's getter is a valid
alternative, but it needs a getter in every class body, and the brief asks for
a mixin.

### C3. A third marker mechanism in dfx.md

dfx.md §8 suggests using `Schema.TaggedError`'s `Brand` generic as the
category marker. That generic is type-level only (effect-v4 §2.1), so
`catchIf` would still need a runtime marker. It is not an alternative to the
mixin; it is just another way to spell the type. Use the effect-v4 mixin
(D3).

### C4. "The effect skill says `Schema.TaggedErrorClass` and `ServiceMap`"

**Half true.** `~/.claude/skills/effect` uses `Schema.TaggedErrorClass` on
six lines across three files: SKILL.md lines 44, 60 and 93,
references/SCHEMA.md lines 112 and 115, and references/SERVICES_LAYERS.md
line 31. effect 4.1.1 has zero occurrences of that name; use
`Schema.TaggedError<Self>()(tag, fields)`. The skill already uses
`Context.Service` and never mentions `ServiceMap`. The `coding-standards`
skill mentions neither.

### C5. Do GUILD_CREATE channels lack `guild_id`?

dfx.md's verdict table states it as fact, while its §5 and §11 mark it
UNVERIFIED. **The docs support it.** The channel object table in
`developers/resources/channel.mdx` line 20 says `guild_id?`: "may be missing
for some channel objects received over gateway guild dispatches". Our state
store must stamp `guild_id` from the enclosing dispatch. Whether live payloads
actually omit it is still UNVERIFIED, but the design must not depend on the
answer.

### C6. Does `rest.getMyGuildMember` work with a bot token?

dfx.md left this UNVERIFIED. **No, per the spec.** OAS `get_my_guild_member`
(`/users/@me/guilds/{guild_id}/member`) has `security: [{OAuth2:
["guilds.members.read"]}]`. `get_guild_member` (`/guilds/{g}/members/{u}`) is
`BotToken`. Use `rest.getGuildMember(guildId, botUserId)`.

### C7. Do identical command re-PUTs count toward the daily create limit?

dfx.md left this open. discord-semantics H-205 cites AC: "a bulk overwrite
counts only commands that are new". That settles it at the docs level. Live
confirmation is still useful, and H-205's open question about *rejected*
creates remains.

### C8. Does the bot see its own member without GUILD_PRESENCES or GuildMembers?

dfx.md left this UNVERIFIED. **The docs say yes on both counts.**
gateway-events.mdx says "members and presences returned in this event will
only contain your bot and users in voice channels", and GW "Caveats" says a
GUILD_MEMBER_UPDATE about the bot arrives without GUILD_MEMBERS (H-175). Live
confirmation is still pending.

### C9. `SlowmodeActive` cannot fire through dfx, for two independent reasons

discord-semantics (H-053) says bots ignore slowmode. dfx.md says 429s never
surface. Putting the two together:

- `DiscordREST.ts` line 147 retries **every** 429, whatever its JSON body.
- The rate-limit docs say a 429 body has `code?` "for some limits".
- `src/slowmode-429-runtime.ts`: a fake 429 `{code: 20016}` followed by a 200
  made `createMessage` **succeed** after 2 calls.

So even if Discord sent 20016 to a bot, dfx would sleep through it, possibly
for hours, since `retry_after` is the remaining slowmode. The same applies to
any other coded 429 (20028, 30034 if sent as 429). Whether 20016 is HTTP 429
or 400 is UNVERIFIED. See D9 and D11.

### C10. "dfx hammers 429s: 152 calls in 3 s"

This was an artifact of dfx.md's fake, which sent `retry-after: 0.01`, and
dfx honoured it. The real issue is that dfx has **no attempt cap and no
deadline**. The same fake sent `code: 0`, so a coded-429 interceptor must
treat a zero or absent `code` as uncoded.

### C11. `typeToString` versus editor hover

type-testing proposed hover snapshots through `typescript/unstable/async`
`typeToString`. Both type-testing and effect-v4 left "does it match the
editor?" UNVERIFIED. **It does not match.** TS 7's binary has
`tsc --lsp --stdio`. `lsp-hover.ts` sends real `textDocument/hover` requests:

| | `typeToString` | LSP hover |
|---|---|---|
| prefix | none | `const a: ` |
| qualification | `Effect<...>` | `Effect.Effect<...>` |
| long unions | `... 5 more ...` | every member |

The LSP is a stable protocol, while `unstable/*` import paths move in TS 7.1.
LSP hover confirms type-testing's finding: an alias-based `SendError<P>`
hovers as the whole payload (`SendError<{\n readonly content: "hi"; ...}>`).
See G4 for the fix.

### C12. Do `expect-type` and vitest typecheck work with TS 7?

effect-v4 left this UNVERIFIED; type-testing §4 settles it. `expectTypeOf`
works as plain types. Vitest typecheck mode works but strips every `:` from
messages and writes into `node_modules`, so it is not usable for snapshots.

### C13. "Spans before recovery" versus "keep spans inside recovery"

These are the same rule in different words. The failing effect must be inside
`withSpan`/`Effect.fn` and the `catch` outside it. effect-v4 adds the trap:
`Effect.fn(name)(body, ...pipeables)` runs the pipeables **inside** the span,
so a `catchCategory` pipeable turns the span green.

### C14. type-testing's stand-in `send` is not a design

Its `lib/perms.ts` puts `SlowmodeActive` on every send (see C9), uses an
alias-based `SendError<P>` (the bad hover), and uses the naive
`P extends { embeds }` check that prior-art showed under-approximates. Do not
copy it. G4 is the compiled replacement.

### C15. The budget numbers are not comparable

effect-v4's baseline (89,550 instantiations) used the default 4 checkers.
type-testing showed those totals depend on how files are split, and gates on
`--checkers 1`. My scratch with `--checkers 1`: 659 files, 16,452 types,
40,691 instantiations, check 0.050 s.

### C16. ThreadArchived on `send`

PROMPT lists `ThreadArchived` among the errors. discord-semantics H-035 says
sending in an archived, unlocked thread **unarchives** it, and 50083 applies
to edits, reactions and joins (H-037). If H-035 holds live, `send` in a
thread can fail with `ThreadLocked` (160005) but not `ThreadArchived`, while
`edit` and `react` can fail with `ThreadArchived`. Per-operation error unions
must reflect that.

### C17. Implicit masking: two Discord sources disagree

This is not a contradiction between our docs. dfx.md §6 and discord-semantics
§3 both quote P: no SEND_MESSAGES masks MENTION_EVERYONE, TTS, ATTACH and
EMBED. Discord's own permission endpoint masks only VIEW and CONNECT, and
never masks for bot targets (H-017). The matrix decides (D22).

## 3. Gaps filled

### G1. Three bot identities in one process silently share a token (critical)

No doc covered running the harness, subject and target together. Effect
memoizes layers **by reference** within one build, and `DiscordRESTLive` is a
single exported constant. `src/identities-runtime.ts` builds two identities
the obvious way:

```ts
const restFor = (token: string) =>
  DiscordRESTMemoryLive.pipe(Layer.provide(DiscordConfig.layer({ token: Redacted.make(token) })))
const naive = Layer.mergeAll(
  Layer.effect(HarnessRest, Effect.gen(function* () { return yield* DiscordREST })).pipe(Layer.provide(restFor("HARNESS"))),
  Layer.effect(SubjectRest, Effect.gen(function* () { return yield* DiscordREST })).pipe(Layer.provide(restFor("SUBJECT"))),
)
```

Output:

```
naive: sameInstance=true auth=["Bot HARNESS","Bot HARNESS"]
fresh: sameInstance=false auth=["Bot HARNESS","Bot SUBJECT"]
```

Every "subject" request would go out with the harness's Administrator token,
and the whole matrix would pass for the wrong reason. Wrapping each
identity's dfx stack in `Layer.fresh` (effect `Layer.ts` line 3972) gives
each identity its own client and its own rate-limit store. The same applies
to `DiscordLive` (gateway) per identity; only REST was run. See D13.

### G2. Surfacing coded 429s without forking dfx

`src/coded-429-runtime.ts` wraps the **base** `HttpClient` handed to dfx. A
429 whose JSON `code` is a nonzero number fails with
`HttpClientError(StatusCodeError)`, so dfx's retry loop never sees it. Plain
429s pass through to dfx. Output: `calls: 1, value: "caught 429
discord-code:20016"`.

Production code should put the decoded body in `StatusCodeError.cause` and
decode it with Schema rather than parse a description string. The
interceptor skips dfx's bucket update for that response, which is fine for
per-resource coded limits. The interaction with `x-ratelimit-scope: shared`
is UNVERIFIED.

### G3. Binding credentials explicitly

Bun auto-loads `.env` into `process.env` (dfx.md). `src/env-runtime.ts` run
with `bun --no-env-file`:

```ts
const DotEnv = ConfigProvider.layer(ConfigProvider.fromDotEnv({ path: ".env" })).pipe(Layer.provide(BunFileSystem.layer))
// => { inProcessEnv: false, tokenLength: 18, printed: "<redacted>", guild: "111111111111111111" }
```

The token is read from the file by code, never enters the process
environment, and prints as `<redacted>`. Each identity's `DiscordConfig` is
then built from `Config.Redacted("DISCORD_<ID>_TOKEN")`.

### G4. Payload type to required permissions, sound and readable

No doc had a design that is both sound (prior-art's over-approximation) and
readable (type-testing's hover complaint). `src/payload/perms.ts` does both,
compiled with exact `Equals` assertions in `use.ts`:

```ts
export interface PermissionErrors {
  readonly ViewChannel: MissingViewChannel; readonly SendMessages: MissingSendMessages
  readonly SendMessagesInThreads: MissingSendMessagesInThreads; readonly EmbedLinks: MissingEmbedLinks
  readonly AttachFiles: MissingAttachFiles; readonly ReadMessageHistory: MissingReadMessageHistory
  readonly SendTTSMessages: MissingSendTTSMessages; readonly SendPolls: MissingSendPolls
}
type MayHave<P, K extends PropertyKey, Empty> =
  K extends keyof P ? ([Exclude<P[K], undefined | Empty>] extends [never] ? false : true) : false
export type PayloadFlags<P> =
  | (MayHave<P, "embeds", readonly []> extends true ? "EmbedLinks" : never)
  | (MayHave<P, "files", readonly []> extends true ? "AttachFiles" : never)
  | (MayHave<P, "reply", never> extends true ? "ReadMessageHistory" : never)
  | (MayHave<P, "tts", false> extends true ? "SendTTSMessages" : never)
  | (MayHave<P, "poll", never> extends true ? "SendPolls" : never)
interface Sendable<Base extends Flag, State> {
  readonly send: <const P extends MessagePayload>(payload: P) => Effect.Effect<Message,
    PermissionErrors["ViewChannel" | Base | PayloadFlags<P>] | PermissionDeniedUnattributed
    | CommunicationDisabled | State | DiscordUnavailable>
}
export interface TextChannel extends Sendable<"SendMessages", never> { readonly kind: "text"; ... }
export interface PublicThread extends Sendable<"SendMessagesInThreads", ThreadLocked> { readonly kind: "public-thread"; ... }
export interface CategoryChannel { readonly kind: "category"; ... }   // no send: TS2339 names the kind
```

Verified behaviour:

- `{ embeds: [...] }` adds exactly `MissingEmbedLinks`.
- `{ embeds: [], tts: false }` adds nothing.
- A payload widened through an annotation adds all five payload errors, which
  is the sound over-approximation.
- In a thread, `MissingSendMessagesInThreads` replaces `MissingSendMessages`
  and `ThreadLocked` appears.

LSP hover output:

```
const a: Effect.Effect<Message, CommunicationDisabled | DiscordUnavailable | MissingEmbedLinks | MissingSendMessages | MissingViewChannel | PermissionDeniedUnattributed, never>
const d: Effect.Effect<Message, CommunicationDisabled | DiscordUnavailable | MissingReadMessageHistory | MissingSendMessagesInThreads | MissingViewChannel | PermissionDeniedUnattributed | ThreadLocked, never>
```

The trick is that indexing an interface by a union of flag names yields a
plain union with no alias attached.

Payload fields the types cannot decide:

- **External emoji inside `content`.** It is a degradation candidate (H-104)
  and goes in `degraded`, not the error union.
- **External stickers.** Guild versus external cannot be told from an ID, so
  the sticker input should be a typed value that records its origin.

### G5. Operation-dependent categories

No doc noticed that one permission can belong to different categories
depending on the operation. Missing ReadMessageHistory is `payload` for a
reply (drop the reply and it works) but not for reactions, where every
reaction needs it (H-144).

Same-tag subclasses solve this (`q2-*.ts`):

- A base `MissingReadMessageHistory` has only `permission`.
- `...ForReply` adds `payload`, and `...ForReaction` adds `access`.
- Both keep `_tag: "MissingReadMessageHistory"`.

Verified:

- `catchTag("MissingReadMessageHistory")` removes both.
- `catchCategory("payload")` removes only the reply variant.
- `catchCategory("payload")` on an effect with only the reaction variant is a
  compile error, because that category is absent.
- At runtime the reaction variant is not caught as payload, and both are
  `instanceof` the base.

This depends on the effect-v4 port copying inherited markers (its gotcha 4);
the gist's mutating version would break it. See D5.

### G6. Command rules on a const tuple

prior-art recommends a seyfert-style record of options, which makes order
unrepresentable. But PROMPT lists "required options before optional ones" as
a compile-time rule that needs a failing fixture with a snapshot.

On a const tuple, `src/commands.ts` gives:

```
src/fail/commands.ts(3,109): error TS2322: Type '{ name: "user"; type: "string"; required: true; }' is not assignable to type '{ ... } & "Required option \"user\" must come before every optional option"'.
  Type '{ name: "user"; type: "string"; required: true; }' is not assignable to type '"Required option \"user\" must come before every optional option"'.
src/fail/commands.ts(5,32): error TS2322: Type '"Ban"' is not assignable to type '"ban"'.
```

Both are reported at the offending element. The 25-option check written as a
whole-array intersection prints the entire tuple (about 980 characters), so
the count check should mark elements past index 24, like the order check
does. Avoid `"` inside messages; tsc escapes it.

### G7. Opting in to obfuscation early, in code

discord-semantics says the portal toggle is the only way, because dfx's
Identify has no `capabilities` (confirmed: `Shard/identify.ts`, and dfx's
copied `GatewayIdentifyData` type does not even have the field). However,
`DiscordWSCodec` is a service. `src/capabilities-codec.ts` replaces it so
op 2 carries `capabilities: 32768`. The encode check printed
`{"op":2,"d":{...,"capabilities":32768}}`, with other opcodes unchanged.

`DiscordLive` provides its JSON codec internally, so this means re-composing
dfx's 8-line `DiscordLive` with our codec (compiled), which needs a LOG.md
entry. It was not run against the live gateway (UNVERIFIED).

### G8. Proving each compile-time rule live in both directions

No doc said how to send the *invalid* payload live without `any` or casts.
dfx's loose generated types are exactly the tool. These all compile against
dfx as-is (dfx.md `ix-rules-probe.ts` and `types-probe.ts`):

- an empty `{}` message;
- CV2 plus content;
- six buttons and a select in one row;
- a link button with a `custom_id`;
- a 500-character `custom_id`;
- an uppercase command name;
- a `UserId` passed as a channel id;
- any event subscribed without its intent.

So each rule's live pair is: the valid case through our typed API, and the
invalid case through raw dfx. Some invalid cases are **ignored** rather than
rejected (H-105 edit flags, H-106 create flags, and the intent cases, where
the event simply never arrives). The rule registry must therefore record an
expected *observation*: a rejection code, a readback difference, or an event
that does not arrive. It cannot always expect an HTTP error.

### G9. Truth-table format (proposal, not compiled)

Two runs must produce byte-identical tables, so the file must not contain
anything that varies per run:

```jsonc
{
  "schema": 1,
  "env": { "mfaLevel": 0, "obfuscation": "on", "typescript": "7.0.2", "dfx": "1.1.1" },  // H-072, D20
  "scenarios": {                      // object keyed by stable scenario id, keys sorted
    "send/text/role-overwrite-allow-vs-deny/embed": {
      "setup": { "channel": "text", "subjectRoles": ["R_allow_send", "R_deny_send"], "overwrites": ["..."] },  // symbolic names, no snowflakes
      "resolver": { "has": ["SendMessages", "ViewChannel"], "missing": ["EmbedLinks"] },                    // flag names, sorted
      "preflight": "MissingEmbedLinks",
      "raw": { "class": "50013", "status": 403, "code": 50013, "inner": [] , "degraded": [] },
      "oracle": { "channelMemberPermissions": ["SendMessages", "ViewChannel"] }   // H-240, flag names
    }
  }
}
```

Rules:

- Use symbolic names instead of IDs.
- Use sorted flag-name arrays instead of bitfields.
- Record `(status, code)` pairs and inner 50035 codes (H-082, H-084).
- Leave out messages, timestamps and timing.
- After each harness change, wait until the oracle endpoint reflects the new
  state before running steps (b) and (c). This is the eventual-consistency
  guard from discord-semantics §15.

### G10. Linking rules to their evidence (proposal)

`verify:offline` should fail if a compile-time rule lacks any of its four
artifacts. A single `rules.ts` table keyed by rule id would list:

- the pass fixture;
- the fail fixture and its `.diagnostics.txt`;
- the live valid scenario id;
- the live invalid scenario id and its expected observation (G8).

The truth table proves the live half, and the type-test runner proves the
compile half.

## 4. Open questions (need live Discord or Rhys)

These are the unknowns that change the design. Ids refer to
discord-semantics.

1. Can bots be timed out, and does a timed-out bot get a plain 50013
   (H-022, H-023)? `CommunicationDisabled` and the "timed out" matrix
   dimension depend on it.
2. 50001 versus 50013 for missing VIEW versus a missing action permission
   (H-080). "Most fundamental first" relies on it.
3. Is 20016 sent to bots at all, and as 429 or 400 (H-053, C9)?
4. Rich embeds without EMBED_LINKS, and `tts` without SEND_TTS: error or
   silent drop (H-102, H-103)? This decides which side of `degraded` versus
   error union they land on.
5. Are inner 50035 codes strings or numbers (H-084)?
6. Do limits count code points or UTF-16 units (H-121)?
7. Is `app_permissions` "exact": implicit permissions, timeouts (H-026)?
   PROMPT asserts it is; the docs say the resolved-channel field excludes
   implicit permissions.
8. Does Discord's permission endpoint reflect timeouts, and does it ever mask
   for a bot (H-241)?
9. Do rejected command creates count toward 200 per day (H-205)?
10. Which defaults does Discord fill in on stored commands (`nsfw`,
    `contexts`, `integration_types`, `default_member_permissions`,
    `version`)? Registration diffing must canonicalise them. UNVERIFIED; no
    doc covered it.
11. Do GUILD_CREATE channels omit `guild_id` live (C5)? This no longer
    changes the design.
12. Close codes 4004 and 4014 under dfx: confirm the silent reconnect loop
    live, or just fail fast before the gateway starts (D19).
13. PROMPT versus docs (discord-semantics §17 items 9 to 12). These are for
    Rhys to confirm, or for the live tests to settle:
    - a components-only message is valid;
    - SuppressNotifications is valid on any request that creates a message;
    - message content arrives for context-menu targets and ping-on replies;
    - content limit 2000 versus 4000.
14. External emoji and sticker failing cases need a second guild, which is
    forbidden. Accept resolver-only coverage, or ask Rhys.
15. Rhys's portal settings: does the harness have the Message Content toggle
    (H-173, H-243)? Should the subject's obfuscation toggle be turned on, if
    G7's codec is not used?

## 5. Design decisions

Each decision lists the options, a recommendation, and the evidence behind
it.

### Errors and categories

| # | Decision | Options | Recommendation | Evidence |
|---|---|---|---|---|
| D1 | Handler-boundary technique for `Bot.on`, commands and components | F2; B; T3R/T3S (template literal); T3O (named interface); `@effect/tsgo` `missingEffectError` | **T3O.** Internal forwarders take the checked type. | C1 tables; `t3o-generic.ts`; `generic-forward-ok.ts` |
| D2 | Readability gate for fail-fixture diagnostics | type-testing's fixed 4 lines / 600 chars; lines only; lines plus required substrings plus banned substrings | **At most 4 lines and at most 800 chars.** The diagnostic must contain the fixture's mention. Ban `exactOptionalPropertyTypes`, `parameter of type 'never'` and `Expected N arguments`. Fix these values before the first snapshot and never raise them. | T3O's worst case is 608c for a 4-error union; the noise and `never` patterns are the real walls (type-testing §8) |
| D3 | Category mechanism | effect-v4 prototype mixin (`.pipe(withCategory(...))`); prior-art getter; class field; `Brand` generic (type-only) | **effect-v4 mixin**, with a runtime test covering the overload boundary | C2, C3 |
| D4 | `catchCategory` signature | variadic `(...cats, f)` (two casts); `K \| [K, ...K[]]` (no casts); record form | **`K \| [K, ...K[]]`**, dual | effect-v4 §5 |
| D5 | Permissions whose category depends on the operation (ReadMessageHistory; any others the matrix shows) | one fixed category set per flag; same-tag subclasses per operation | **Same-tag subclasses, only where needed.** Base class: `permission`; variants add `payload` or `access`. | G5 |
| D6 | May an error in `transient` *and* another category escape a handler? | yes (T3O as written uses `ExcludeCategory<E, "transient">`); no | **No.** Define `Unhandled<E>` as members with any non-transient category, plus uncategorized members, and never put an error in transient plus something else. | effect-v4 decision 2 |
| D7 | Ordering among several failures | PROMPT's order only; extended with state | **ViewChannel (incl. obfuscated) → CommunicationDisabled → SendMessages / SendMessagesInThreads → state (ThreadLocked) → payload flags.** The matrix confirms. | PROMPT; H-020 (timeout leaves only View and RMH); H-036 |
| D8 | What `Permissions.require` narrows a later 50013 to | `PermissionDeniedUnattributed`; dedicated `PermissionRevokedSinceCheck { flag }` | **Dedicated tag in the `permission` category.** The recompute *can* name the revoked flag; collapsing it into "unattributed" would discard that. | prior-art §1.1 (compiled) |
| D9 | 429 handling | `Effect.timeout` only (all 429s become one transient error); plus the base-client interceptor for coded 429s | **Both.** A per-call deadline maps to a transient `RequestTimedOut`, and nonzero-coded 429s map to specific tags (decoded body in `cause`). | C9, C10, G2 |
| D10 | dfx's typed but unreachable `RatelimitedResponse` | map to transient; defect | **Defect** (`orDie` in the mapper, with a comment). It is unreachable by construction. | dfx.md §3 |
| D11 | `SlowmodeActive` | keep in `send`'s union; keep the class but add it only if the live run shows 20016 for bots; drop | **Keep the class; add it to unions only if the matrix observes it** (this requires D9's interceptor). Record in LOG.md. | C9, H-053 |
| D12 | Response validation | Schema-decode every exposed response (2xx `DecodeError` and mismatches become defects); trust dfx casts | **Decode at the boundary for every type we expose.** That is also where IDs get branded. | dfx.md §3; effect-v4 §7 |

### dfx integration

| # | Decision | Options | Recommendation | Evidence |
|---|---|---|---|---|
| D13 | Running three identities | one graph (broken); `Layer.fresh` per identity with distinct services; separate processes | **`Layer.fresh` per identity's dfx stack, exposed as `HarnessRest`, `SubjectRest` and `TargetRest`**, plus a fake-client test asserting distinct `Authorization` headers | G1 |
| D14 | Credentials | Bun auto `.env` plus `Config`; `--no-env-file` plus `ConfigProvider.fromDotEnv` | **`bun --no-env-file` everywhere (package scripts) plus `ConfigProvider.fromDotEnv({ path })`** | G3; PROMPT "bound explicitly, not inherited" |
| D15 | Permission state for preflight | dfx `CachePrelude` plus a member cache; one store fed by `DispatchHook` | **Own store fed by `DispatchHook`.** It stamps `guild_id`, tracks the bot member and its timeout, and stores obfuscated channels as "no View". | dfx.md §4–5; C5 |
| D16 | Recompute after 50013 | refresh state (`getChannel` (+ parent), `getGuildMember(guild, bot)`, `listGuildRoles`, `getGuild`) and run our resolver; ask Discord's new `GET /channels/{c}/permissions/member/{u}` | **Our resolver for the library**, as PROMPT specifies. **The endpoint is the harness's second oracle**, called through `rest.httpClient` (it is not in dfx). Revisit after the matrix. | discord-semantics §1.2, H-240; dfx.md escape hatches |
| D17 | Interactions | wrap `Ix`/`InteractionsRegistry`; own layer | **Own layer on `DiscordLive`; never `DiscordIxLive`** | dfx.md §7 (unsound subcommand typing, 5 s gap, bulk PUT) |
| D18 | Command registration | dfx sync; own diff | **Own diff against `GET` guild commands, Perms Lab only.** Canonicalise Discord defaults (open question 10), and run negative tests against one command name. | dfx.md §7; H-205, H-206 |
| D19 | Fail-fast startup | trust dfx; preflight checks | **Check `getMyUser`, the application flags for privileged intents, and Perms Lab membership before the gateway starts** | dfx.md §2 (4004/4014 loop) |
| D20 | Obfuscation before 2026-11-16 | portal toggle (Rhys); G7 codec; run ViewChannel-denied scenarios only after the 16th; two tables | **G7 codec for the subject**, so tables are recorded post-switch from day one and are reproducible from code. The resolver treats flag `1<<17` as missing View and ignores its overwrites. Use the portal toggle if Rhys prefers not to re-compose `DiscordLive`. | discord-semantics §1.1; G7 |

### Types and API shape

| # | Decision | Options | Recommendation | Evidence |
|---|---|---|---|---|
| D21 | Payload to permissions | naive `extends` check; `MayHave` over-approximation; alias `SendError<P>` | **`MayHave` plus a `PermissionErrors` interface indexed by flag names.** Never an alias over the payload. | G4 |
| D22 | Implicit masking in the resolver | docs (no SEND masks four bits); Discord endpoint (View and Connect only) | **Docs version as the starting hypothesis.** The matrix decides, and the result goes in LOG.md. | C17; H-013, H-017 |
| D23 | ID inputs | branded only; Carbon `IdLike` (accepts plain strings, rejects other brands) | **Branded only**, via `Schema.brand` at decode, with `X.make` for tests and literals. PROMPT says IDs "cannot be mixed". | effect-v4 §7; prior-art §2.6 |
| D24 | Intent gating | restrict the key union (better autocomplete); intersect the key with a message (names the intent) | **Message intersection.** Compiled together with T3O, it names `GuildMembers`. | `bot-on.ts`; prior-art §1.4 |
| D25 | `message.content` without the intent | absent key; `unknown`; template-literal string; named error object | **Named error object** (discordeno `ChangeType` style), narrowed by helpers for each exception (own, mention, DM, plus context-menu target and ping-on reply if live confirms). Gateway intent and REST portal toggle are separate dimensions (H-173). | prior-art §2.3; discord-semantics H-172 |
| D26 | Command options representation | record (order unrepresentable); const tuple | **Const tuple** with per-element checks (order, count past 25), `Lowercase` names, and a dressed-style tuple index for value types | G6; prior-art §2.5 |
| D27 | `exactOptionalPropertyTypes` | keep; turn off | **Keep** (PROMPT requires strict). Design every rule to fail against a message type, never Effect-to-Effect. | type-testing §8.1; C1 |
| D28 | Span policy | `Effect.fn` per REST op with recovery outside; in-span recovery with `tapError` plus `annotateCurrentSpan` | **`Effect.fn` per op, recovery outside**, with a recording-tracer test | effect-v4 §9; C13 |
| D29 | Per-event isolation | let failures reach `handleDispatch`; own fiber per event | **Own fiber and span per event.** Transient errors are logged and recorded; `handleDispatch` must never see a failure. | dfx.md §4; prior-art §2.10 |

### Verification tooling

| # | Decision | Options | Recommendation | Evidence |
|---|---|---|---|---|
| D30 | Type-test runner | vitest typecheck; tstyche; CLI runner | **CLI runner:** one `tsc -p test/types --pretty false` per run, sibling `.diagnostics.txt`, `// @expect-error <mention>`, positives via `expectTypeOf` | type-testing §6 |
| D31 | Hover snapshots | `typescript/unstable/async` `typeToString`; `tsc --lsp --stdio` hover; none | **LSP hover** (stable protocol, matches the editor) | C11; `lsp-hover.ts` |
| D32 | TypeScript version | `^7.0.2` (current package.json); exact `7.0.2` | **Exact `7.0.2`.** Upgrades re-snapshot deliberately. | type-testing §9 |
| D33 | Compile budget | default checkers; `--checkers 1` | **`--checkers 1`.** Gate on Types and Instantiations (+2%) plus a loose check-time gate. Set ceilings once the reference bot exists. | type-testing §1.1, §7; C15 |
| D34 | Truth table and rule registry | ad hoc; G9 format plus G10 registry | **G9 and G10.** `verify:offline` fails on any rule missing an artifact. | G8–G10 |
| D35 | Reading back degradation | harness REST reads; subject's own create response | **The subject's create response** (H-244). The harness reads only fields not gated by the content toggle, or the toggle is confirmed on. | discord-semantics §9, H-243 |

## 6. Still unverified after this cross-check

- `Layer.fresh` per identity was run for REST only. The gateway stacks
  (`DiscordLive`) per identity were not built.
- The coded-429 interceptor ran against a fake. Its behaviour with real
  `x-ratelimit-scope: shared` 429s, and the effect of skipping dfx's bucket
  update for those responses, are unknown.
- The G7 obfuscation codec was compiled and its encode checked, but it was
  not run against the gateway.
- LSP hover was probed on Linux only, with plaintext hover content. Snapshot
  normalisation for the `const x: ` prefix is still to be decided.
- T3O's compile-time cost at reference-bot scale was not measured. The whole
  scratch costs 40,691 instantiations (`--checkers 1`). type-testing measured
  technique 3 as cheaper than the intersection form on its reference.
- The G9 and G10 formats are proposals; nothing was compiled for them.
