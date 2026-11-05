# effect-discord-perms: design

This is the single document implementation agents build from. Each milestone in
section 6 is meant to be implementable from this document alone. When a choice
is not written here, the binding sources decide, in this order:

1. `PROMPT.md`, the brief;
2. this document;
3. `docs/research/README.md` (decisions D1-D35, contradictions C1-C17, gaps G1-G10);
4. the individual research docs.

If a milestone hits a concrete blocker in this document, the agent stops,
records the blocker in `LOG.md`, and reports it. It does not quietly re-decide.

This is revision 2. Three reviews (types and DX, live Discord, Effect
architecture) reported 62 findings against revision 1. Every one is listed with
its disposition in the Review log at the end of this document. Revision 1 is
kept in `.scratch/design/v1-DESIGN.md` and its prototype in
`.scratch/design/v1-src/`.

**Evidence convention.** Every type-level claim below was compiled with
`node_modules/.bin/tsc` (TypeScript 7.0.2, the repo's strict tsconfig with
`exactOptionalPropertyTypes`). Citations:

- `[sd:x]` is `.scratch/design/x`, the revision-2 prototype;
- `[rt:x]` is `.scratch/design-review-types/x` and `[re:x]` is
  `.scratch/design-review-effect/x`, the reviewers' probes against revision 1;
- `[cc:x]` is `.scratch/cross-check/x`.

In the scratch:

- `tsc -p .scratch/design` exits 0.
- `bun .scratch/design/check-fail.ts` compiles every fail fixture in one run,
  applies the §5.2 gate, and prints `ok (64 diagnostics, largest gated 534c)`.
  The output is in `[sd:fail-diagnostics.txt]`.
- `[sd:probe2/]` holds focused probes. `[sd:probe2/probe-output.txt]` lists
  their compile output; the only errors are the expected ones in `ix-reg.ts`,
  `ix-reg2.ts` and `variant-table.ts`.
- LSP hovers are in `[sd:hover.txt]` and `[sd:probe2/hover-probes.txt]`,
  compile costs in `[sd:budget.txt]`, and runtime checks in
  `[sd:errors-runtime.txt]`, `[sd:truth-runtime.txt]`, `[sd:pairwise.txt]`,
  `[sd:route-codec-runtime.txt]` and `[sd:probe2/rt/refresh-generation.txt]`.

**The guarantee.** The types guarantee that every failure is handled. They do
not guarantee that any call succeeds. Discord owns the permission state, and it
can change between a check and a request. Every operation therefore returns an
`Effect` whose error channel names each way it can fail, and a handler compiles
only if every non-`transient` failure is handled, either by tag or category or
by an explicit, greppable `Effect.orDie`.

---

## 1. Architecture

### 1.1 Overview

```
 user handlers (Bot.on, Interactions.command/component/modal/autocomplete)
        |  typed: intents, payloads, channel kinds, handler boundary (T3O, by category)
        v
 Bot API ------------------------------------------------------------------+
   channels/messages/members ops ->  Operation pipeline                    |
                                      1 local checks (payload + argument limits)
                                      2 preflight (resolver over state)    |
                                      3 dfx REST call in Effect.fn span    |
                                        + per-call deadline                |
                                      4 error mapping; 50013, 50001 and    |
                                        dedicated codes -> recompute       |
                                      5 decode + brand response            |
                                      6 degradation readback               |
   Operations table (one const: flags, variant, tags) -> types AND runtime |
   GuildState (SubscriptionRef, versioned) <- DispatchHook reducer         |
   Resolver (pure)                                                          |
   Interactions runtime (fork + timed join auto-defer, value-level machine) |
   Command registration (canonicalise + diff, guild only)                  |
+--------------------------------------------------------------------------+
        |  never forks dfx; wraps it
        v
 dfx 1.1.1: DiscordREST (base HttpClient from OUTSIDE the bot build, wrapped by the
            coded-429 interceptor), DiscordGateway (our JSON codec), DispatchHook
        v
 Discord

 harness/ (live oracle): one shared paced HttpClient (outside every Layer.fresh);
 HarnessRest, TargetRest (fresh REST stacks) and the subject (the library's own
 Bot layer, plus SubjectRaw from the same build); identity assertions; Lab guard on
 every identity; lock; reset/provision by ID; scenario runner with a subject-observable
 projection; permission-endpoint oracle; truth-table writer.
```

The library is a layer over dfx (D17). We never write a REST or gateway client.
Where dfx gets in the way we wrap it at a seam and log the reason in `LOG.md`:

- the base `HttpClient` interceptor (G2);
- the re-composed `DiscordLive` with our codec (G7);
- the permission-endpoint calls through `rest.httpClient` (D16);
- our own interactions layer and command registration (D17, D18).

### 1.2 Module layout

One line per module. Paths are relative to the repo root. `.scratch/design`
holds prototypes of the starred (*) modules.

```
src/
  index.ts                       public barrel; re-exports the modules marked public below
  Snowflake.ts *                 branded IDs (ChannelId, GuildId, UserId, RoleId, MessageId, ApplicationId,
                                 CommandId, InteractionId, EmojiId, StickerId): Schema.brand, X.make
  errors/
    Category.ts *                withCategory mixin, CategorizedError (M10: TaggedError with the mixin applied, typed
                                 as one class), hasCategory, catchCategory (dual), Categories, CategoryMarker,
                                 ExtractCategory, ExcludeCategory (from [cc:src/category.ts])
    Cause.ts *                   DiscordResponse, PreflightDecision, NoResponse, FieldError, ErrorCause union
    Missing.generated.ts *       GENERATED: 52 Missing<Flag> classes, PermissionFlags, PermissionErrors, `missing`,
                                 MissingClasses, and ErrorCategories (class name -> sorted categories mirror, incl. the
                                 D5 variants)
    Variants.ts *                same-tag variants: MissingReadMessageHistoryForReply / ...ForReaction (D5; M10: classes
                                 of their own with the base class's tag, not subclasses, §2.2)
    Permission.ts *              PermissionDeniedUnattributed, PermissionRevokedSinceCheck
    State.ts *                   CommunicationDisabled, ThreadLocked, ThreadArchived, SlowmodeActive,
                                 TargetAboveInHierarchy, RoleAboveInHierarchy, TargetIsAdministrator, AlreadyCrossposted,
                                 ThreadAlreadyExists, TagRequired, Maximum*Reached, Unknown*, InteractionExpired,
                                 TwoFactorRequired, RoleIsManaged, CannotMessageUser, DailyCommandCreateLimit
    Payload.ts *                 ContentTooLong, EmbedTooLarge, MessageEmpty, NameTooLong, TopicTooLong, SlowmodeOutOfRange,
                                 NicknameTooLong, TimeoutTooLong, PollTooLarge, MessagesTooOld, TooManyMessagesToDelete,
                                 CustomIdTooLong
    Transient.ts *               DiscordUnavailable, NetworkError, RequestTimedOut, RateLimited (all carry `cause`)
    index.ts                     re-exports; `ErrorClasses` (every class by name, from each module's `*Classes`
                                 record), `PermissionErrorClasses`, and the `AllErrors` union used by the D6 test
  permissions/
    Flags.ts                     PermissionSet (bigint wrapper): fromBits, has, toSortedNames; the 2FA-starred set
    Resolver.ts                  pure resolver: base -> overwrites -> masks (obfuscated, unseen, private-thread, implicit,
                                 timeout); hierarchy (targetBelow, roleBelow); inputFromSnapshot (state -> input or refresh)
    ResolverRules.ts             data: one entry per resolver hypothesis (H-ids), flipped by live findings
    Operations.ts *              THE operation table: per op, required flags, D5 variant, non-permission tags; derived
                                 OpFlags, OpTags, OpPermissionErrors, OpErrors<G>; variantConstructors, errorFor
    Order.ts                     the "most fundamental first" order (D7, generalised in §3.2)
    Preflight.ts                 decide(op, resolution) -> Pass | ordered failure list; Preflight.Mode (internal)
    Recompute.ts                 50013/50001/dedicated-code path: refresh, resolve, attribute or Unattributed (M5:
                                 `attribute(context, Target, response, fallback)`; `Target` is §4.9's handle)
    Observed.ts *                hand-edited constants decided by the live matrix (§8); replay test enforces them
                                 (M1 adds the two the table's types read: slowmodeAppliesToBots, botsCanBeTimedOut)
    Require.ts *                 Permissions.require
  payload/
    Message.ts *                 CreateMessage, CreateMessageV2, EditMessage, Embed, FileUpload, Poll, StickerRef,
                                 Emoji, ReplyTo, Mentions; CheckCreate/CheckEdit/NonEmpty/KnownKeys; Invalid<Msg>
    PayloadRules.ts *            the single PayloadRules table and PayloadFlags / DegradableFlags / MayInclude /
                                 MayBeTooLong / MayBeEmpty / EditMayEmpty / MayExceed, plus the runtime mirror
    Components.ts *              ActionRow (only from `row([...])`), buttons, selects, V2 components, linkButton, premiumButton
    Limits.ts                    the Limits table keyed by (operation, field): content, embeds, poll, names, topic,
                                 slowmode, nickname, timeout, custom_id; length unit (H-120, H-121, H-123)
    ToDfx.ts                     our payload -> dfx MessageCreateRequest / edit request (flags bitfield,
                                 allowed_mentions always {parse: []} plus opt-ins, files via rest.withFiles)
  channels/
    Channel.ts *                 kinds, ChannelKinds<G>, the kind interfaces, DMChannel, GuildChannel, MessageChannel,
                                 SendMethod (one shared generic-`this` send), Channels.get, Channels.isMessageChannel
    Message.ts *                 OwnMessage<K>, ForeignMessage<K> (per kind), OwnMessages<K>, ForeignMessages<K> (unions)
    Direct.ts                    (M7) DM handles: the DM channel's send and a DM message's edit and delete, through
                                 `DiscordApi.executeDirect` (no guild, so no preflight and no recompute)
    Ops.ts                       implementations: each public op is an overload over a wide implementation (§4.7);
                                 the pipeline (`perform`), the handles (`channelHandle`, `messageHandle`, internal) and
                                 `Channels` (M6: the wire-to-handle decoding lives here too; no separate Decode.ts)
  members/
    Member.ts *                  GuildMember ops (addRole, removeRole, setNickname, timeout, kick, ban), Members.get
  rest/
    DiscordApi.ts                service wrapping DiscordREST: deadline, span, error mapping, decode, recompute hook
                                 (M5: `execute(Request)`; preflight stays in the operations, §4.8 step 2)
    ErrorMap.ts                  (operation, status, code, inner path) -> tag; unmapped -> defect (M5: `Codes`, the
                                 code -> statuses and meaning table; `mapResponse` checks the tag against the row and
                                 the request's `LimitFacts`; `UnmappedDiscordError`)
    Request.ts                   one bounded dfx call, its failure classified (Transient or a Discord answer) (M3);
                                 (M8) `sendJson`, the same through `rest.httpClient` for a JSON body dfx's types cannot
                                 express (a command with a GuildMedia channel option: dfx's `ChannelTypes` lacks 16)
    Coded429.ts                  base HttpClient interceptor for nonzero-coded 429s (G2)
    RouteCheck.ts                base HttpClient check: a request `send` makes must be its declared method and route
                                 template, else a defect (after the M6 verifier)
    Schemas.ts                   response schemas (Message incl. reactions, Channel, Thread, Member, Role, Guild); the
                                 reducer and the refresh decode with the same schemas (M5)
    Oracle.ts                    GET /channels/{c}/permissions/member/{u} etc. via rest.httpClient (harness only)
                                 (ErrorMap.ts's dfx failure classifier, `classify`, arrives in M2 for startup and
                                 the harness; M5 adds the table)
  state/
    Snapshot.ts                  the snapshot types, channel kinds (type 0..16), entity keys and generations (M3)
    GuildState.ts                service: SubscriptionRef<Snapshot> with per-entity generations; awaitGuild, refresh
    Reducer.ts                   pure (Snapshot, dispatch) -> Snapshot; stamps guild_id; obfuscation; bot member; idempotent
    Hook.ts                      DispatchHook layer: decode the minimum, reduce, bump generations; never fails
  gateway/
    Intents.ts *                 Intent names (equal to dfx's keys), EventIntents (supported events only), IntentCheck
    Events.ts *                  EventPayloads<I>, MessageCreate<I> (guild and DM branches), ReceivedMessage, ContentUnavailable;
                                 (M7) the runtime decoding of each supported dispatch into handles
    Codec.ts                     JSON codec that adds Identify capabilities (G7) and records the sent intents
    Dispatches.ts                (M7) the build's own dispatch stream, fed by the hook after the reducer; `bot.on` subscribes to it
  bot/
    Bot.ts *                     Bot.make, Bot.layerWith (platform open), Bot.layer (Bun), Bot.on; per-event fibers
    Runtime.ts                   (M7) BotRuntime, BotConfig and the event source, apart from Bot.ts so handles import no cycle
    Handler.ts *                 Handled<A,E,R>, UnhandledErrors<What> (T3O by category, D1/D6)
    Startup.ts                   fail-fast checks (D19) -> StartupFailed; restChecks (checks 1-3) from M2
    Internals.ts *               NOT exported: layerWith returning BotRuntime | SubjectRaw (harness only)
  commands/
    Command.ts *                 Command.chatInput / withSubcommands; CheckName; Ordered; CheckedSubs; ChatInputCommand<N, I>
                                 (M8: opaque by a phantom symbol key only `Command.*` sets; carries its `definition`)
    Canonical.ts                 definition -> Discord JSON; remote JSON -> canonical (drops server defaults)
    Registration.ts              GET guild commands, diff, PUT only on change (D18); `BotConfig.commands` runs it as check 5
  components/
    CustomId.ts *                ComponentRoute.make(name, schema): customId(data) through Schema.toCodecJson; decode;
                                 (M8) `routeNameOf`, the prefix a received custom_id routes by
  interactions/
    Interaction.ts *             CommandInteraction, ManualCommandInteraction, *ComponentInteraction, ModalSubmitInteraction,
                                 AutocompleteInteraction, Response<R>, Answered, Completed (nominal)
    Wire.ts                      (M9) INTERACTION_CREATE decoding; the invocation decoded against the command's definition
    Runner.ts                    INTERACTION_CREATE routing, auto-defer (fork + timed join), posting, continuations
    Checklist.ts                 the phase-3 `checklist` command that posts prompts for a human
  config/
    Credentials.ts *             ConfigProvider.fromDotEnv layer; Config.Redacted readers; takes the live lock (§5.6)
harness/
  main.ts                        CLI: reset | smoke | selftest | inventory | run [--repeat N] [--only glob] [--write] [--compare]
  Identities.ts *                SharedHttpClient (paced, counted) outside every fresh; HarnessRest, TargetRest; subject
  IdentityCheck.ts               app IDs, distinct users, READY user, sent intents, the guild is Perms Lab (§4.4)
  Lab.ts                         Perms Lab guard on EVERY identity's writes, incl. SubjectRaw and library member ops
  Lock.ts                        single-driver lock (atomic create, hostname + pid, stale takeover by rename)
  LabIds.ts                      lab object IDs persisted across runs (git-ignored .lab-state.json)
  Provision.ts                   idempotent lab channels, threads, roles, sticker, positions (by stored ID)
  Reset.ts                       baseline and leftover cleanup incl. archived threads; second reset makes zero writes
  Materialize.ts                 pure: symbolic Setup -> desired state, and its subject-observable projection
  Predict.ts                     pure: steps (a) and (b) from the setup alone (the replay's rebuild; flip selection) (M4)
  Fixtures.ts                    the subject's own fixtures before Converge (temporary access), the harness's after (M4)
  Drivers.ts                     step (c) per operation: the raw SubjectRaw call, its outcome, what it created (M4);
                                 `dryRequests`, the same call recorded dry (the offline request check)
  Converge.ts                    applies the minimal diff from current to desired state, in a fixed order
  Wait.ts                        consistency waits: read-back, projected subject GuildState, stable oracle
  DryRun.ts                      Context.References read by the shared client: `DryRun` records (method, path, body) and
                                 answers canned, never sending; `Capture` records and sends (steps (c) and (d));
                                 `requestDifferences` for the request check (after the M6 verifier)
  Library.ts                     steps (b) and (d) through the library's public operations, on handles built from the lab (M6);
                                 `bypassedRequests`, step (d)'s request recorded dry (fallback and offline check)
  Probes.ts                      the rule rows' probes: a typed library call or a raw call the types forbid, and its observation (M6)
  Outcome.ts                     raw outcome classifier, degradation readback (D35)
  Agreement.ts                   pure: row -> agree | mismatch kind (shared with offline replay)
  Pacing.ts                      global token bucket, invalid-request counter and cap, write counter per route
  Wire.ts                        schemas for the Discord objects the harness reads (dfx casts 2xx bodies); raw
                                 requests through rest.httpClient for routes dfx lacks (GuildMedia create)
  Sessions.ts                    (M7) the intent sessions: a fresh subject session per row (`Identities.Sessions`), READY and
                                 the sent intents checked, the trigger, the canary, the observation and the library's check
  CommandProbes.ts               (M8) the registration rows' probes: typed syncs through the library, raw POSTs, the writes
  CommandBudget.ts               (M8) the command-create budget in the shared client: a rolling 24-hour ledger in /tmp, abort at 150
  RecordCommands.ts              (M8) `record-commands`: how Discord stores commands, into fixtures/commands-canonical.json
  Smoke.ts                       harness:smoke's oracle reads (with a target positive control) and `inventory`
  SelfTest.ts                    harness:selftest: dirt, a spec-based read-back that must see it, reset, read-back,
                                 a second reset with zero writes (§5.7)
  TruthTable.ts *                schema + canonicalJson; write / compare; the step (a) record and level (shared with replay)
  Runner.ts                      `run`: reset, provision, Safety, the catalog in setup groups, one scenario's steps, summary
  scenario/
    Dsl.ts *                     Setup, Operation, Observation, Scenario
    Pairwise.ts *                deterministic greedy pairwise selection with per-family validity predicates
    Facts.ts                     pure: a scenario's operation-table row per channel kind, scope (channel or guild) and
                                 preflight arguments (payload, reaction, creator, hierarchy) (M4)
    catalog/common.ts            the catalogs' shared helpers (channel values, grants without the missing flag) (M4)
    catalog/index.ts             the whole catalog: every family and the flip controls (M4)
    catalog/send.ts              send family (pairwise) + targeted send hypotheses
    catalog/messages.ts          edit/delete/crosspost/bulkDelete family
    catalog/reactions.ts         react family
    catalog/pins.ts              pin/unpin/list family
    catalog/threads.ts           createThread and thread families
    catalog/channelEdit.ts       slowmode family + targeted rename/topic rows (one per channel per run)
    catalog/members.ts           hierarchy family (kick/ban only where the docs model says failure)
    catalog/flips.ts             flip-control siblings (§5.9)
    catalog/rules.ts             live valid/invalid pairs for every rule in test/rules.ts: the named setups and one scenario per side
    catalog/coverage.ts          (M6) one row per (operation row, flag) the families leave without a first-failure row
    Probes.ts                    (M6) the probe names and what each touches, renames and mentions (pure; Facts and Safety read it)
    catalog/intents.ts           gateway sessions with and without intents, each with a canary (M7: pure descriptions; the
                                 sessions are rule probes on `catalog/rules.ts`'s `text-messages` setup, run by
                                 `harness/Sessions.ts`)
    catalog/commands.ts          registration rule pairs, readback and the diff check (M8: the definitions and raw bodies; the
                                 rows are rule probes on `catalog/rules.ts`'s `commands` setup)
    Safety.ts                    static checks every scenario must pass (no human pings, kick/ban must fail, edit budget)
test/
  rules.ts *                     the rule registry (G10): rule -> pass fixture, fail fixture, live pair or allowed reason
  unit/**.test.ts                vitest + @effect/vitest unit tests (incl. op-errors.test.ts, §4.7)
  support/                       helpers shared by unit tests (reading category markers)
  replay/truth-table.test.ts     offline replay of fixtures/truth-table.json (§5.13)
  types/tsconfig.json            extends root, include src + pass + fail, exclude []
  types/pass/*.ts                expectTypeOf / Equals assertions; must compile (incl. op-errors.ts, one per operation)
  types/fail/*.ts                // @expect-error TS<code> <mention> fixtures, // @valid twins, <name>.diagnostics.txt
  hover/*.ts                     //  ^? markers + <name>.hover.txt snapshots
  env/                           empty directory; vitest envDir, so vitest never reads .env
scripts/
  gen-errors.ts *                writes src/errors/Missing.generated.ts; --check fails if stale
  type-tests.ts                  type-test runner (§5.2)
  hover.ts                       LSP hover snapshots via `tsc --lsp --stdio` (§5.3)
  budget.ts                      compile budget (§5.4)
  rules-check.ts                 registry completeness (§5.5)
  verify-offline.ts              runs the offline steps in order (§5.1)
  lib/                           the scripts' modules: tsc (pinned binary), typeTests (the §5.2 gate),
                                 hover + lsp (§5.3), budget (§5.4), rules (§5.5), genErrors (§2.2); unit-tested in
                                 test/unit
examples/
  reference-bot/main.ts          the reference bot: no orDie or die on library errors (D-done criteria) (M10: the entry
                                 point, which reads the subject's token through config/Credentials.ts, behind the lock)
  reference-bot/bot.ts           (M10) the bot itself, a user's code importing only the package `effect-discord-perms`
  reference-bot/tsconfig.json    budget project (M10: the bot as a consumer of the package compiles it, through the
                                 package's exports, so with the library's source, §5.4)
  reference-bot/budget.json      committed baseline, with a per-command row (M8: the per-command row first)
  command-probe/                 (M8) the per-command row's two projects: none.ts and commands.ts (20 x 25 options)
fixtures/
  truth-table.json               written only by verify:live; committed
  commands-canonical.json        recorded GET shapes of registered commands (canonicaliser tests)
  canned/*.json                  canned 2xx bodies per route for the dry-run stub (§5.10 step b)
README.md, LOG.md                design and guarantee; live findings, dfx deviations, escalations, phase-3 checklist
```

---

## 2. Public API

Signatures below are copied from the compiled prototypes. Import paths in
`src/` follow §1.2.

### 2.1 IDs (`[sd:src/Snowflake.ts]`)

```ts
const SnowflakeString = Schema.String.check(Schema.isPattern(/^\d{17,20}$/))
export const ChannelId = SnowflakeString.pipe(Schema.brand("ChannelId"))
export type ChannelId = typeof ChannelId.Type   // string & Brand<"ChannelId">
// likewise GuildId, UserId, RoleId, MessageId, ApplicationId, CommandId, InteractionId, EmojiId, StickerId
```

- IDs are branded only, at decode (D23), including every event payload
  (`MESSAGE_DELETE`, `MESSAGE_REACTION_ADD` carry `MessageId`, `ChannelId`).
  `X.make(s)` is the trusted constructor for tests and literals, and it throws
  on a malformed snowflake.
- A branded ID is still a `string`, so it is passed to dfx without a cast.
- Mixing IDs fails in 2 to 4 lines and names both brands
  (`[sd:fail-diagnostics.txt]`, `src/fail/ids.ts`):

```
Argument of type 'string & Brand<"UserId">' is not assignable to parameter of type 'string & Brand<"ChannelId">'.
```

### 2.2 Errors and categories (`[sd:src/Category.ts]`, `[sd:src/Cause.ts]`, `[sd:gen-errors.ts]`, `[sd:src/errors/Other.ts]`)

**Causes.** Every error that came from Discord, that preflight decided instead
of Discord, or that has no response at all carries `cause: ErrorCause`. Nothing
in it is `unknown`.

```ts
export class FieldError extends Schema.Class<FieldError>("FieldError")({
  path: Schema.Array(Schema.String), code: Schema.String /* normalised, H-084 */, message: Schema.String }) {}
export class DiscordResponse extends Schema.TaggedClass<DiscordResponse>()("DiscordResponse", {
  status: Schema.Int, code: Schema.Int /* 0 for bodies without one */, message: Schema.String, method: HttpMethod,
  route: Schema.String,            // route TEMPLATE stamped by our wrapper, never a URL (tokens live in URLs)
  fieldErrors: Schema.Array(FieldError),
  attributedBy: Schema.Literals(["code", "recompute"]) }) {}
export class PreflightDecision extends Schema.TaggedClass<PreflightDecision>()("PreflightDecision", {
  route: Schema.String, basis: Schema.Literals(["gateway-state", "app-permissions", "payload-check"]) }) {}
export class NoResponse extends Schema.TaggedClass<NoResponse>()("NoResponse", {
  route: Schema.String, method: HttpMethod, reason: Schema.Literals(["transport", "deadline"]), afterMs: Schema.Int }) {}
export const ErrorCause = Schema.Union([DiscordResponse, PreflightDecision, NoResponse])
```

The transient tags carry a cause too: `DiscordUnavailable` keeps the 5xx or
non-JSON response, `RateLimited` the coded-429 body, and `RequestTimedOut` and
`NetworkError` a `NoResponse` (`[sd:errors-runtime.txt]`, `transientCause`).
Their `cause` fields are typed as exactly that member of `ErrorCause`
(`DiscordResponse` or `NoResponse`), since nothing else can produce them (M1).

**Generated permission errors.** `scripts/gen-errors.ts` reads the flag names
from discord-api-types `PermissionFlagsBits`, drops the deprecated alias
`ManageEmojisAndStickers` (H-059), and writes 52 classes. The output has no
`any` and no casts (`[sd:gen-errors.ts]`, `[sd:src/errors/Missing.generated.ts]`):

```ts
export class MissingEmbedLinks extends CategorizedError<MissingEmbedLinks>()("MissingEmbedLinks", { cause: ErrorCause }, [
  "permission", "payload"]) {   // M10; M1-M9: Schema.TaggedError<...>()(...).pipe(withCategory("permission", "payload"))
  get flag(): "EmbedLinks" { return "EmbedLinks" }
  override get message(): string { return "Missing permission EmbedLinks (" + this.cause.route + ")" }
}
export interface PermissionErrors { readonly AddReactions: MissingAddReactions; /* ...52 entries... */ }
export const missing: { readonly [F in PermissionFlag]: (cause: ErrorCause) => PermissionErrors[F] } = { /* generated */ }
```

The category table lives in the generator:

- `access`: ViewChannel, SendMessages, SendMessagesInThreads, Connect.
- `payload`: EmbedLinks, AttachFiles, SendTTSMessages, SendPolls,
  UseExternalEmojis, UseExternalStickers, MentionEveryone, SendVoiceMessages.
- Every flag is `permission`.

The generator also writes `ErrorCategories`, a runtime record from every
generated class and every D5 variant (the classes `errorFor` can build), keyed
by class name, to its sorted categories. Tests use it to compare what the
runtime builds with what the types promise (§4.7), and a pass fixture checks
that each entry equals `Categories<>` of its class. The other classes'
categories are read from their markers by the D6 test over `AllErrors`.

**Library code never calls `missing[flag]` directly.** It builds permission
errors through `errorFor(op, flag, cause)` from the operation table (§4.7),
whose constructor table is type-checked against each operation's D5 variant.
Forgetting the `...ForReply` override is a compile error
(`[sd:probe2/variant-table.ts]`, TS2322 in `[sd:probe2/probe-output.txt]`), and at
run time `errorFor("channel.send", "ReadMessageHistory")` is a
`MissingReadMessageHistoryForReply` with categories `payload, permission` that
`catchCategory("payload")` catches, while the react row builds the `access`
variant (`[sd:errors-runtime.txt]`).

At runtime (`[sd:errors-runtime.txt]`):

- the tag, `flag` and `message` are correct;
- both Discord and preflight causes work, and transient errors carry `NoResponse`;
- the marker sits on the prototype and is not encoded;
- the same-tag variants are told apart by their categories.

**Categories.** The mixin and combinator are the effect-v4 port (D3, D4),
copied verbatim from `[cc:src/category.ts]`:

```ts
export function withCategory<const K extends ReadonlyArray<string>>(...categories: K):
  <Self, S extends Schema.Struct<Schema.Struct.Fields>, Inherited>(base: Schema.Class<Self, S, Inherited>)
    => Schema.Class<Self, S, Inherited & Categorized<K[number]>>
export const catchCategory: {
  <const K extends Categories<E>, E, A2, E2, R2>(categories: K | Readonly<[K, ...Array<K>]>,
    f: (error: ExtractCategory<E, K>) => Effect.Effect<A2, E2, R2>)
    : <A, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A | A2, E2 | ExcludeCategory<E, K>, R | R2>
  <A, E, R, const K extends Categories<E>, A2, E2, R2>(self: Effect.Effect<A, E, R>, categories: K | Readonly<[K, ...Array<K>]>,
    f: (error: ExtractCategory<E, K>) => Effect.Effect<A2, E2, R2>): Effect.Effect<A | A2, E2 | ExcludeCategory<E, K>, R | R2>
}
```

(M10, after the M10 verifier) **The library declares its error classes with
`CategorizedError`**, which is `Schema.TaggedError` with the mixin applied:

```ts
export function CategorizedError<Self = never>(): <const Tag extends string, const Fields extends Schema.Struct.Fields,
  const K extends ReadonlyArray<string>>(tag: Tag, fields: Fields, categories: K)
    => [Self] extends [never] ? MissingSelf : Schema.Class<Self, Schema.TaggedStruct<Tag, Fields>, Cause.YieldableError & Categorized<K[number]>>
```

At run time it is exactly `Schema.TaggedError<Self>()(tag, fields).pipe(withCategory(...categories))` (the same
subclass and frozen prototype marker; `mixCategories` is their shared run time). Its type is the one `Schema.Class`
that `Schema.TaggedError` gives, with the marker in its `Inherited` slot, where the piped mixin re-types the class as
a second `Schema.Class` (about 90 more types for each of the 93 classes; measured per class, 187 against 95). The
categories are written once, so type and marker cannot disagree; the trust boundary is the same kind as
`withCategory`'s, an overload over a wider implementation. `withCategory` stays the public mixin, for adding
categories to an existing class; its implementation signature returns `(base: never) => ...` so the overload
check does not instantiate `Schema.Class` generically (that check alone cost every consumer about 1,900 types).
**The D5 variants are same-tag classes of their own** (`CategorizedError` with the tag `"MissingReadMessageHistory"`
and the base class's fields, `flag` and `message`), not subclasses: piping the mixin onto a subclass matches its
class type against `Schema.Class` member by member, which cost every consumer about 2,800 types for the two. They
keep everything D5 relies on (the tag, so `catchTag` catches all three; their categories; the mirror and the
constructor table); `instanceof MissingReadMessageHistory` no longer holds for them, and nothing used it.

Neither Effect 4.1.1 nor dfx ships an equivalent; `catchReason` is a different
model (effect-v4 §4). Exactness of the narrowing (`[sd:src/errors-types.ts]` §3):

- `catchCategory("payload")` removes exactly the payload members;
- `catchCategory(["access", "state"])` removes exactly the members of either;
- `catchTag` removes exactly one tag.

Every listed category must be present in `E`, like `catchTag` with an absent
tag. Catching a category the effect cannot fail with is a compile error (a dead
handler), and M1 has a fail fixture for it; when `E` has no categorised member at
all, the argument's type is `Invalid<"this effect cannot fail with any category:
remove the catch">`. The handler-boundary message lists exactly the categories
present (§2.7), so a list copied from it is always valid.

**The categories are literals (after the final audit).** The type removes every
category the argument's type names, while the run time catches only those its
value holds, so an argument typed as a union (`category: "permission" | "state"`)
or as a list wider than a tuple (`readonly [Cat, ...Cat[]]`) would remove
categories that can still fail, and the error would escape a handler whose type
said nothing could. `catchCategory` therefore infers the whole argument (`const C
extends CategoryArg<Categories<E>>`) and intersects it with
`LiteralCategories<C>`: a single category typed as a union, a list whose type is
not a tuple, and a list element typed as a union are each a located error that
says so. `hasCategory` takes the same check. `Effect.catchTag` has the same
property for a tag typed as a union (`catchTag(tag as "A" | "B", ...)` removes
both); the library does not wrap it, so that remains the caller's to avoid.

Categories are `permission | payload | access | state | transient`. Invariant
D6: an error in `transient` has no other category. A runtime test over
`AllErrors` enforces it for library errors, and the handler boundary enforces it
for user errors (§2.7).

### 2.3 Message payloads and the payload-to-permissions computation (`[sd:src/payload.ts]`)

```ts
export interface CreateMessage {
  readonly content?: string; readonly embeds?: ReadonlyArray<Embed>; readonly files?: ReadonlyArray<FileUpload>
  readonly stickers?: ReadonlyArray<StickerRef>; readonly poll?: Poll; readonly components?: ReadonlyArray<ActionRow>
  readonly reply?: ReplyTo; readonly tts?: boolean; readonly mentions?: Mentions
  readonly suppressEmbeds?: boolean; readonly suppressNotifications?: boolean
}
export interface CreateMessageV2 {   // content, embeds, stickers, poll are not representable
  readonly componentsV2: ReadonlyArray<V2Component>; readonly files?: ReadonlyArray<FileUpload>; readonly reply?: ReplyTo
  readonly mentions?: Mentions; readonly suppressEmbeds?: boolean; readonly suppressNotifications?: boolean
}
export type MessagePayload = CreateMessage | CreateMessageV2
export interface EditMessage { readonly content?: string; readonly embeds?: ReadonlyArray<Embed>
  readonly components?: ReadonlyArray<ActionRow>; readonly mentions?: Mentions; readonly suppressEmbeds?: boolean }
export type StickerRef = { readonly origin: "guild"; readonly id: StickerId } | { readonly origin: "external"; readonly id: StickerId }
export type Emoji = { readonly origin: "unicode"; readonly name: string } | { readonly origin: "guild" | "external"; readonly id: EmojiId; readonly name: string }
export interface Mentions { readonly users?: ReadonlyArray<UserId>; readonly roles?: ReadonlyArray<RoleId>; readonly everyone?: true; readonly repliedUser?: true }
```

**One rule table drives both types and runtime.** The live matrix decides each
`mode` (open question 4). Only this table changes; the types and the preflight
follow it.

```ts
export const PayloadRules = {
  embeds: { flag: "EmbedLinks", mode: "error" },           files: { flag: "AttachFiles", mode: "error" },
  reply: { flag: "ReadMessageHistory", mode: "error" },    tts: { flag: "SendTTSMessages", mode: "error" },
  poll: { flag: "SendPolls", mode: "error" },              externalSticker: { flag: "UseExternalStickers", mode: "error" },
  externalEmojiInContent: { flag: "UseExternalEmojis", mode: "degrade" },
  mentionsEveryone: { flag: "MentionEveryone", mode: "degrade" },
  unmentionableRole: { flag: "MentionEveryone", mode: "degrade" }
} as const satisfies Record<string, { readonly flag: string; readonly mode: "error" | "degrade" }>
type MayHave<P, K extends PropertyKey, Empty> = P extends unknown                 // distributes over unions of payloads
  ? (K extends keyof P ? ([Exclude<P[K], undefined | Empty>] extends [never] ? false : true) : false) : never
export type MayInclude<P, K extends keyof Rules> = true extends Present<P>[K] ? true : false   // presence; mode-independent
export type PayloadFlags<P> = FlagsWith<P, "error">        // flags whose absence fails the request
export type DegradableFlags<P> = FlagsWith<P, "degrade">   // flags whose absence silently drops a feature
```

"May have" distributes over `P` and is tested as `true extends ...`, so a
payload typed as the union `MessagePayload` (say, a render helper's return
type) is judged member by member. Revision 1 indexed `keyof` of the union,
which keeps only common keys, and silently dropped six error members
(`[rt:holes/h1-payload-union.ts]`).

Verified (`[sd:src/channels-use.ts]` §1-§6, exact `Equals`):

- `{ embeds: [{...}] }` adds `MissingEmbedLinks` and `EmbedTooLarge`.
- `{ embeds: [], tts: false }` adds nothing.
- A payload typed as `CreateMessage` **or** `MessagePayload` adds every
  error-mode flag, plus `EmbedTooLarge`, `PollTooLarge`, `ContentTooLong` and
  `MessageEmpty`. This is the sound over-approximation (G4).
- A guild sticker adds nothing, and an external one adds
  `MissingUseExternalStickers`.
- `mentions: { everyone: true }` changes the success type to
  `SentDegradable<K, "MentionEveryone">`. Its `degraded` field is
  `ReadonlyArray<"MentionEveryone">`, a typed field and not an error.
- Content that may carry custom-emoji markup (any non-literal string, or a
  literal containing `<:name:id>`) has `degraded: ReadonlyArray<"UseExternalEmojis">`.
  Discord rewrites an external emoji without the permission to text (H-104);
  the runtime detects it from the create response (§4.12).

**Presence is independent of mode.** Limit tags and the reply variant are keyed
on `MayInclude`, not on whether the flag is in `PayloadFlags`. With
`embeds.mode` flipped to `"degrade"` in a copy of the table, `EmbedTooLarge`
stays in the union and `degraded` becomes `ReadonlyArray<"EmbedLinks">`
(`[sd:probe2/q4/use.ts]` compiles). Flipping a mode therefore moves only the
flag between the error union and `degraded` (open question 4).

The runtime mirror is `requiredFlags(payload)`, computed from the same table
(`[sd:src/impl-boundary.ts]`).

**Content length and emptiness without branding strings:**

- `ContentTooLong` is in the union unless `content` is a finite literal within
  the limit. The literal test is `` `{} extends Record<S, 1>` ``: true for
  `string` and template patterns, false for literals. A finite literal is then
  measured: `LongerThan<S, Max>` peels ten characters at a time from the literal
  and from a string of the limit's length, so a short literal costs one step and
  2000 characters 200; tsc splits a literal by code point, as Discord counts
  (`Limits.unit`). `send({ content: "pong" })` carries no `ContentTooLong`, while
  `content: dynamic`, `` content: `hello ${x}` `` and a 2001-character literal
  do. (After the final audit. Before it, every finite literal omitted the tag; the
  run time cannot tell a literal from a computed string of the same value, so the
  local check failed with `ContentTooLong` for an over-limit literal whose type did
  not declare it, and the tag reached the handler undeclared.) The same rule,
  `MayExceed<V, Max, Min>`, decides `NameTooLong` (1 to 100: an empty literal
  carries it), `TopicTooLong` (1024, the smaller limit, a sound
  over-approximation for forum topics), `NicknameTooLong` (32) and
  `SlowmodeOutOfRange` (a number literal keeps the tag unless it is a natural of
  at most four digits); `TimeoutTooLong` is always present for a date. The
  limits are strings, not tuple counters, because every tuple length tsc builds
  costs a type per element (§5.4).
- `MessageEmpty` (50006) is in the union unless every member of the payload has
  a body field that is *definitely* non-empty: a required key whose type
  excludes the empty value (`"" extends string` may be empty, `"" extends "pong"`
  cannot) (`[sd:src/channels-use.ts]` §2).
- Edits: `EditMayEmpty<P>` adds `MessageEmpty` when `content` may be `""` or
  `embeds` may be `[]`, and an edit with non-empty embeds adds `EmbedTooLarge`
  (`[sd:src/channels-use.ts]` §14).

**Payload-shape rules** are intersected onto the argument (`CheckCreate<P>`,
`CheckEdit<P>`). (M6: the argument is written through the aliases
`CreateArg<P> = P & CheckCreate<P>` and `EditArg<P>`, and likewise `PatchArg` and
`ThreadArg`: comparing two generic signatures that carry the bare intersection,
tsc infers `P` as the whole intersection and fails, so an implementation could
not carry the public signature as its overload; the alias makes it match the
argument. The diagnostics are the same.) Diagnostics, all within the gate (`[sd:fail-diagnostics.txt]`,
`src/fail/payload-rules.ts`):

| Rule | Diagnostic (verbatim head) |
|---|---|
| at least one of content, embeds, files, stickers, poll, components | `Property '"a message needs content, embeds, files, stickers, a poll or components"' is missing in type '{}' ...` |
| CV2 excludes content/embeds/stickers/poll | `Type '"hi"' is not assignable to type '"hi" & Invalid<"content is not allowed in a componentsV2 message">'.` |
| Ephemeral only on interaction responses | `Type 'true' is not assignable to type 'true & Invalid<"ephemeral is not valid when creating a message">'.` |
| SuppressNotifications not on edit | `... Invalid<"suppressNotifications is not valid when editing a message">'.` |
| allowed_mentions is not settable (pinging nobody is the default) | `... Invalid<"allowed_mentions is not valid when creating a message">'.` |

The located `Invalid<Msg>` form matters. A whole-argument intersection printed
the payload three times (1,005 characters for a realistic payload). The
property-located form is 2 lines and about 210 characters, whatever the payload
size.

**Components** (`[sd:src/payload.ts]`, `src/fail/components.ts`):

- `ActionRow` can only be produced by `row([...])`, which takes an **array** so
  tsc locates each error on an element. Revision 1's varargs form had no
  excess-property check for inline literals, so a link button with a
  `customId`, a premium button with a label and an inline select next to a
  button all compiled (`[rt:holes/h4-row-inline.ts]`).
- Per element, located on the offending element or property:
  - a sixth button: `... & Invalid<"an action row holds 1 to 5 buttons">'`;
  - a select with anything else marks every element:
    `... & Invalid<"a select menu must be alone in its row">'` (the select test
    is `"string-select" extends C[number]["kind"]`, rule 4 of §2.12);
  - `Type 'CustomId' is not assignable to type '... & Invalid<"link buttons have no customId">'.`
  - `Type '"Buy"' is not assignable to type '"Buy" & Invalid<"premium buttons have no label">'.`
- (After the final audit) also: a premium button's `customId` (`premium buttons
  have no customId`) and an interactive button's `url` (`only link buttons have a
  url`), which compiled and were dropped from the request; an empty row (`row([])`:
  `an action row holds 1 to 5 buttons, or one select menu`); and a list whose type
  is not a tuple (`row takes its elements as a literal list`). That last check
  also means a malformed element of a literal, for which tsc falls back to the
  constraint, reports only its own missing property, not a select message on
  every element. A message's `components` (create, edit, reply) hold at most 5
  rows when written as a literal list (`MessageRows`); a computed list of more
  is refused by Discord with a 50035 on `components`, an unmapped defect. These
  checks are typed only: no live probe sends them yet (LOG.md).
- The largest of these diagnostics is 534 characters (an inline select with
  options) and all are 2-3 lines.
- `linkButton(input)` and `premiumButton(input)` still give excess-property
  errors for pre-declared buttons (`'customId' does not exist in type 'LinkButtonInput'`).
- A `customId` is a branded `CustomId`, produced only by a `ComponentRoute`
  (§2.9). (After the M6 verifier) The public barrel exports `CustomId` as a type
  only, so its schema's `make` is not public API.

**`allowed_mentions` and flags at the wire.** `ToDfx` always sends
`allowed_mentions: { parse: [] }`, plus the explicit opt-ins:

- `users` and `roles` lists;
- `parse: ["everyone"]` only for `mentions.everyone`;
- `replied_user` only for `mentions.repliedUser`.

It does this on edits too (H-111). Flags become the bitfield: SuppressEmbeds 4,
SuppressNotifications 4096, IsComponentsV2 32768.

### 2.4 Channel kinds and operations (`[sd:src/channels.ts]`, `[sd:src/ops.ts]`)

**Every error union comes from one table.** `permissions/Operations.ts` is a
`const` table with one row per operation: its required flags, its D5 variant,
and its non-permission tags. The public signatures index that same table, so
the declared unions cannot drift from the runtime data. Revision 1 wrote each
union by hand and had already drifted in five places (`[rt:holes/h13-taxonomy-drift.ts]`).

```ts
export const Operations = {
  "channel.send": { flags: ["ViewChannel", "SendMessages"], variant: "reply",
    tags: ["PermissionDeniedUnattributed", "CommunicationDisabled", "SlowmodeActive", "RateLimited", "UnknownChannel"] },
  "thread.send":  { flags: ["ViewChannel", "SendMessagesInThreads"], variant: "reply", tags: [/* ... */ "ThreadLocked", "UnknownChannel"] },
  "voice.send":   { flags: ["ViewChannel", "Connect", "SendMessages"], variant: "reply", tags: [/* as channel.send */] },
  "message.pin.thread": { flags: ["ViewChannel", "PinMessages"], variant: "default",
    tags: ["PermissionDeniedUnattributed", "CommunicationDisabled", "MaximumPinsReached", "ThreadArchived", "UnknownChannel",
           "UnknownMessage"] },  // M6: every message row lists UnknownChannel (the message's channel may be deleted)
  // ... 47 rows in total (40 in [sd:src/ops.ts]; M4 added thread.delete, thread.unarchive and the
  //     .thread/.voice variants of edit, delete and bulk delete from live findings, and removed
  //     message.pin.voice and message.unpin.voice: voice text chat has no pins)
} as const satisfies Record<string, OpSpec>
export type OpFlags = { readonly [Op in OpName]: Ops[Op]["flags"][number] }
export type OpTags = { readonly [Op in OpName]: TagClasses[Ops[Op]["tags"][number]] }      // tag name -> class
export type OpPermissionErrors = { readonly [Op in OpName]: VariantErrors[Ops[Op]["variant"]] }
export type OpErrors<G extends PermissionFlag> = { readonly [Op in OpName]:
  OpPermissionErrors[Op][Exclude<OpFlags[Op], G>] | Revoked<OpFlags[Op], G> | OpTags[Op] | Transient }
```

`TagClasses` maps each tag name to its class; Observed-gated tags map to the
gated type (`CommunicationDisabled: MaybeTimedOut`, `SlowmodeActive:
MaybeSlowmode`, §8). Mapped-type lookups resolve to plain unions, so
`OpErrors<never>["message.pin.thread"]` hovers as class names, while a generic
alias such as `Tags<"x">` would hover as the alias (`[sd:probe2/hover-ops.ts]`,
`[sd:probe2/hover-probes.txt]`). `[sd:src/channels-use.ts]` §9b asserts, for
several operations, `Equals<Effect.Error<op(...)>, OpErrors<never>[Op]>`; the
real `test/types/pass/op-errors.ts` has one such assertion per table row.

```ts
export type GuildChannelKind = "text" | "announcement" | "voice" | "stage" | "category" | "forum" | "media"
  | "public-thread" | "private-thread" | "announcement-thread"
export type MessageKind = "text" | "announcement" | "voice" | "stage" | ThreadKind | "dm"
interface ChannelBase<K extends GuildChannelKind, G extends PermissionFlag> {
  readonly kind: K; readonly id: ChannelId; readonly guildId: GuildId
  readonly granted: ReadonlyArray<G>                       // flags checked by Permissions.require; a real runtime field
  readonly basis: "gateway-state" | "app-permissions"      // where preflight reads permissions (§4.7)
}
export interface TextChannel<G extends PermissionFlag = never> extends ChannelBase<"text", G>, Sendable,
  Editable<"channel.edit", G, "name" | "topic" | "slowmodeSeconds">, StartsThreads<boolean, G>, Pins<G>, BulkDeletes<G> {}
export interface AnnouncementChannel<G>   // edit fields: name, topic (no slowmode, H-054); StartsThreads<false, G> (H-154)
export interface VoiceChannel<G>, StageChannel<G>   // Editable<"voice.edit", ...>, Pins<G, "voice.pins">: Connect required
export interface CategoryChannel<G> extends ChannelBase<"category", G>, Editable<"channel.edit", G, "name"> {}   // no send
export interface ForumChannel<G>, MediaChannel<G>  // createPost (PostsMessages<G>), no send
export interface PublicThread<G>, PrivateThread<G>, AnnouncementThread<G>   // Sendable, Editable<"thread.edit", ...>, ThreadOps<G>
export interface DMChannel { readonly kind: "dm"; readonly id: ChannelId; readonly recipientId: UserId
  readonly granted: ReadonlyArray<never>; readonly send: SendMethod }   // no guild, overwrites or require
export type GuildChannel = ChannelKinds<never>[GuildChannelKind]
export type MessageChannel = ChannelKinds<never>["text" | "announcement" | "voice" | "stage" | ThreadKind]
export declare const Channels: {
  readonly get: (id: ChannelId) => Effect.Effect<GuildChannel, PermissionErrors["ViewChannel"] | OpTags["permissions.require"] | Transient>
  readonly isMessageChannel: (channel: GuildChannel) => channel is MessageChannel }
```

**`send` is one shared method type with a generic `this`.** Every message kind
has `readonly send: SendMethod`. Because all union members share the same
property type, calling `send` on a union gets one signature, and `this`
carries the kind and the granted flags into the lookups:

```ts
export interface SendReceiver { readonly kind: MessageKind; readonly granted: ReadonlyArray<PermissionFlag> }
export interface SendMethod {
  <C extends SendReceiver, const P extends MessagePayload>(this: C, payload: P & CheckCreate<P>): Effect.Effect<
    [DegradableFlags<P>] extends [never] ? Sent<C["kind"]> : SentDegradable<C["kind"], Extract<PermissionFlag, DegradableFlags<P>>>,
    | OpPermissionErrors[SendOpByKind[C["kind"]]][Exclude<SendFlags<C, P>, GrantedOf<C>>]
    | Revoked<SendFlags<C, P>, GrantedOf<C>>
    | (true extends MayBeTooLong<P> ? ContentTooLong : never)
    | (true extends MayBeEmpty<P> ? MessageEmpty : never)
    | (MayInclude<P, "embeds"> extends true ? EmbedTooLarge : never)
    | (MayInclude<P, "poll"> extends true ? PollTooLarge : never)
    | OpTags[SendOpByKind[C["kind"]]] | Transient>
}
```

- `SendOpByKind` maps text and announcement to `channel.send`, voice and stage
  to `voice.send`, threads to `thread.send`, and `dm` to `dm.send` (no flags).
  `SendFlags` adds the payload flags only for guild kinds.
- The send variant is `"reply"`, so a missing `ReadMessageHistory` is the
  `...ForReply` class (`payload`), with no separate term.
- The success type uses `Extract<PermissionFlag, DegradableFlags<P>>`, which
  hovers as a literal union; `DegradableFlags<P>` directly would hover as the
  alias with the whole payload (`[sd:probe2/hover-degraded.ts]`).
- The union is inline (rule 1, §2.12). Hovers print class names
  (`[sd:hover.txt]`):

```
const b: Effect.Effect<Sent<"text">, CommunicationDisabled | EmbedTooLarge | MissingEmbedLinks | MissingSendMessages | MissingViewChannel | PermissionDeniedUnattributed | RateLimited | UnknownChannel | Transient, never>
const u: Effect.Effect<Sent<"announcement" | "announcement-thread" | "private-thread" | "public-thread" | "stage" | "text" | "voice">, CommunicationDisabled | MissingConnect | MissingSendMessages | MissingSendMessagesInThreads | MissingViewChannel | PermissionDeniedUnattributed | RateLimited | ThreadLocked | UnknownChannel | Transient, never>
```

`u` is `anyChannel.send(...)` on a `MessageChannel` union: **one** Effect. There
is no separate data-first `Channel.send`; revision 1 needed one because the
method on a union returned seven Effects, and the obvious method spelling then
failed `catchCategory` with a 2,612-character diagnostic carrying the
`exactOptionalPropertyTypes` header (`[rt:bot/friction-probe.ts]` F2). The same
method accepts what `Permissions.require` returns for a union
(`[sd:src/channels-use.ts]` §8b), which revision 1 rejected with 2,864
characters (`[rt:bot/friction-probe.ts]` F4). **Until the final audit only `send`
had this shape:** a message handle's `delete`, `edit`, `react`, `pin`, `unpin`,
`createThread` and `crosspost` were each kind's own function type, so a call on a
received message of a union kind returned a union of Effects and piping
`catchCategory` (or `Effect.catch`) onto it failed in the same way. They are now
shared method types with a generic `this` too (§2.5).

`this` is trusted, not checked: the implementations close over their handle and
ignore `this`, so a value deliberately re-typed around a handle's method (an
object literal claiming `kind: "dm"` holding a guild channel's `send`) gets the
error type of the kind it claims. No cast is needed to write one, but nothing in
the library or an ordinary bot does; branding the receivers was not done, as it
would cost every handle a property and the compile budget a type per kind.

**Other channel operations** (signatures in `[sd:src/channels.ts]`; every union
is `OpErrors<G>[op]` plus argument-derived limit tags):

- `edit(patch)`: the patch type admits only the fields the kind has
  (text, announcement, forum, media: name, topic, slowmode; voice: name,
  slowmode; stage: name, topic, slowmode; threads: name, slowmode; category:
  name). (M6 live: revision 2 gave announcement no slowmode (H-054) and stage no
  topic; Discord applied both, `rule/text-manage-channels/raw-slowmode-announcement`
  in the first rule run and `raw-topic-stage`, so the kinds have them, and the
  rule's live pair is a voice channel's topic.) Another field fails on the property:
  `Type '"…"' is not assignable to type '"…" & Invalid<"topic cannot be edited on this channel kind">'.`
  A non-literal `name` adds `NameTooLong`, `topic` adds `TopicTooLong`, and a
  non-literal `slowmodeSeconds` adds `SlowmodeOutOfRange`.
- `createThread({ name, private? })`: the flag follows the literal
  `private: true`; a non-literal name adds `NameTooLong`. On announcement
  channels `private: true` fails with
  `... Invalid<"announcement channels only have public threads">'.` (M6: the
  result is the thread's kind, an announcement thread from an announcement
  channel; text and announcement messages have `createThread({ name })` too,
  on the same row.)
- `createPost({ name, message })` on forum and media: the full send-style
  union for the message (including `MessageEmpty` and `...ForReply`), plus
  `NameTooLong` and the row's `TagRequired` and `MaximumActiveThreads`
  (`[sd:src/channels-use.ts]` §12).
- `pins()`: returns `{ messages, degraded: ReadonlyArray<"ReadMessageHistory"> }`
  (H-107).
- `bulkDelete(ids: readonly [MessageId, MessageId, ...MessageId[]])`: the row adds
  `TwoFactorRequired`, `MessagesTooOld`, `TooManyMessagesToDelete` and
  `CommunicationDisabled`.
- Thread operations exist only on thread kinds: `join`, `leave`,
  `addMember`, `setArchived`, `setLocked`, and (M6) `delete`; `setArchived(false)`
  uses the `thread.unarchive` row, a non-literal boolean both rows.
- `ThreadArchived` appears on edit, react, pin and unpin, but not on send
  (C16, H-035). (M4 live: deletes and bulk deletes in an archived thread
  answer 50083 too, so their thread rows list it; joining, leaving and adding
  a member succeed, so those rows do not.)
- **CommunicationDisabled** is in every row whose required flags the timeout
  mask removes (everything except View and ReadMessageHistory, H-020), gated by
  `Observed.botsCanBeTimedOut`. Rows needing only those two flags
  (`channel.pins`, `join`, `leave`, own `delete`) do not list it; `voice.pins`
  needs Connect, which the mask removes, so it does (M1). (M4 live: a timed-out
  subject that sees the channel deletes its own message, in a text channel and
  in a thread, `message/targeted/delete-own-timed-out{,-thread}`.)
- **PermissionDeniedUnattributed** is in every row that sends a guild request,
  including `channel.pins`, `voice.pins`, `join` and `leave`: a 50001 there
  goes through the recompute, which may find nothing (§3.1, §4.9). Only
  `dm.send` and `permissions.require` omit it (M1).
- Reaction removal and overwrite editing (H-144, H-070) are **out of phase-1
  scope**; they are not in the API and not in the matrix (§8, item 19).

Operations that do not exist give one-line `TS2339` diagnostics
(`src/fail/channel-kinds.ts`):

```
Property 'send' does not exist on type 'CategoryChannel<never>'.
Property 'send' does not exist on type 'ForumChannel<never>'.
Property 'crosspost' does not exist on type 'OwnMessage<"text">'.
Property 'join' does not exist on type 'TextChannel<never>'.
Property 'edit' does not exist on type 'ForeignMessage<"text">'.
```

### 2.5 Messages carry their author (`[sd:src/channels.ts]`)

```ts
export interface DeleteMethod {
  <M extends MessageReceiver>(this: M): Effect.Effect<void, OpErrors<never>[DeleteOp<M>]>   // DeleteOp distributes over M
}
export interface EditOwnMethod {
  <M extends OwnReceiver, const P extends EditMessage>(this: M, patch: EditArg<P>): Effect.Effect<OwnMessages<KindOf<M>>,
    OpErrors<never>[EditOp<KindOf<M>>] | ContentTooLongIn<P> | EditEmbedTooLargeIn<P> | EditMessageEmptyIn<P>>
}
export type OwnMessage<K extends MessageKind> = MessageBase<K> & GuildOps<K> & Crosspost<K> & {
  readonly author: "self"; readonly edit: EditOwnMethod; readonly delete: DeleteMethod
}
export type ForeignMessage<K extends MessageKind> = MessageBase<K> & GuildOps<K> & Crosspost<K> & {
  readonly author: "other"; readonly authorId: UserId; readonly authorIsBot: boolean; readonly delete: DeleteMethod
}
export type OwnMessages<K extends MessageKind> = K extends MessageKind ? OwnMessage<K> : never      // distributive
export type ForeignMessages<K extends MessageKind> = K extends MessageKind ? ForeignMessage<K> : never
```

(After the final audit.) Every message method is one shared method type with a
generic `this` that carries the kind and the author (`MessageReceiver`), as
`send` is (§2.4): every handle of every kind has the same property type, so a
call on a union of handles (an event's message, a send's result on a union of
channels) has one signature and gives one Effect, whose error union is the
kinds' rows, distributed over the handles. The per-kind function types before it
gave a union of Effects, and `.pipe(catchCategory(...))` on one failed with a
2,400-character diagnostic. The change also cut the reference bot's compile by
about 1,200 types.

- `OwnMessage<K>` is one kind. `OwnMessages<K>` and `ForeignMessages<K>` turn a
  union of kinds into a union of handles. Received messages and `Sent<K>` use
  them, so `m.channelKind === "announcement"` narrows to a handle that has
  `crosspost` (`[sd:src/bot-use.ts]` §6). In revision 1 a received message was
  `OwnMessage<union>`, `Crosspost` distributed to `unknown`, and an
  auto-publish bot could not be written (`[rt:holes/h6-received-message.ts]`).
- `crosspost` exists only when `K` is `"announcement"`. On someone else's
  message its row adds `MissingManageMessages` and `TwoFactorRequired`.
- `react(emoji)` uses the `reaction` variant (`access`, D5). It adds
  `MissingUseExternalEmojis` only when `"external"` may be the emoji's origin
  (`[sd:src/channels-use.ts]` §9, §11). `MissingAddReactions` stays in the
  type; the runtime checks it only when it is required (§4.7).
- `GuildOps<K>` is absent for `"dm"`: DM messages have no react, pin or crosspost.
- `authorIsBot` lets a bot ignore other bots.
- The library decides authorship at decode by comparing `author.id` with the
  bot's user ID. `send` and `edit` return own messages.
- **TwoFactorRequired** is in every row whose flags include a 2FA-starred
  permission (ManageMessages, ManageThreads, ManageChannels, ManageRoles,
  KickMembers, BanMembers, Administrator; H-072). The table makes this
  checkable: a unit test asserts it for every row.

### 2.6 `Permissions.require` and members (`[sd:src/channels.ts]`, `[sd:src/members.ts]`)

```ts
export type WithGranted<C extends GuildChannel, F extends PermissionFlag> =
  C extends GuildChannel ? ChannelKinds<GrantedOf<C> | F>[C["kind"]] : never
readonly require: <C extends GuildChannel, const F extends ReadonlyArray<PermissionFlag>>(channel: C, flags: F) =>
  Effect.Effect<WithGranted<C, F[number]>, PermissionErrors["ViewChannel" | F[number]] | OpTags["permissions.require"] | Transient>
```

`require` is optional and reads gateway state. When the guild is stale it
refreshes over REST first, so it can fail with `Transient` and `UnknownChannel`.
(After the M6 verifier) When even the refresh leaves the state unable to resolve
the channel (the guild or the channel left the state meanwhile: the bot was
removed, the channel deleted), nothing can be checked, and `require` fails with
`UnknownChannel` (a `PreflightDecision` cause, logged at Warning with the
reason). M6 had returned the handle with the flags granted, unchecked, so their
later refusals would have been `PermissionRevokedSinceCheck`.
It fails with the most fundamental problem (§3.2), including
`CommunicationDisabled` when a timeout masks a checked flag. On the returned
handle, `Missing<F>` for the checked flags becomes one
`PermissionRevokedSinceCheck` (D8). The type never promises success. Hovers
(`[sd:hover.txt]`):

```
const req: Effect.Effect<TextChannel<"EmbedLinks" | "SendMessages">, CommunicationDisabled | MissingEmbedLinks | MissingSendMessages | MissingViewChannel | UnknownChannel | Transient, never>
const rs:  Effect.Effect<Sent<"text">, CommunicationDisabled | EmbedTooLarge | MissingViewChannel | PermissionDeniedUnattributed | PermissionRevokedSinceCheck | RateLimited | UnknownChannel | Transient, never>
```

Members (`[sd:src/members.ts]`, exact `Equals`):

- `Members.get(guildId, userId)` returns a `GuildMember` with `addRole`,
  `removeRole`, `setNickname`, `timeout`, `kick` and `ban`; each union is its
  table row.
- `addRole`/`removeRole` fail with `RoleAboveInHierarchy` when the **role**
  is not below the bot's highest role (H-060). The target's rank does not
  matter (H-061), so they do not list `TargetAboveInHierarchy`. They also list
  `RoleIsManaged` and `UnknownRole`.
- `setNickname`, `timeout`, `kick` and `ban` list `TargetAboveInHierarchy`.
  `timeout` also lists `TargetIsAdministrator` (H-021, H-067).
- `setNickname(nick)` with a non-literal string adds `NicknameTooLong`;
  `setNickname(null)` does not. `timeout(date)` adds `TimeoutTooLong` (more than
  28 days ahead, H-025); `timeout(null)` does not.
- Every member operation lists `CommunicationDisabled`.

### 2.7 Bot, intents, events, `message.content`, handler boundary (`[sd:src/bot.ts]`, `[sd:src/bot-use.ts]`)

```ts
export const Intents = ["Guilds", "GuildMembers", /* the 21 dfx key names */ "DirectMessagePolls"] as const
export type Intent = typeof Intents[number]           // equal to dfx's keys ([sd:src/identities.ts])
export interface EventIntents { readonly READY: never; readonly MESSAGE_CREATE: "GuildMessages" | "DirectMessages";
  readonly GUILD_MEMBER_ADD: "GuildMembers"; /* ... only events with a live intent pair (§5.5) */ }
type IntentCheck<K extends EventName, I extends Intent> = [EventIntents[K]] extends [never] ? unknown
  : [Extract<EventIntents[K], I>] extends [never] ? { readonly "missing intent, add one of": EventIntents[K] } : unknown

export interface ContentUnavailable { readonly _tag: "ContentUnavailable"; readonly reason: "needs the MessageContent intent, or check message.contentDelivered first" }
export type ReceivedMessage<WithIntent extends boolean> =
  | (OwnMessages<GuildMessageKind> & Delivered)
  | (ForeignMessages<GuildMessageKind> & (WithIntent extends true ? Delivered : Delivered | Undelivered))
export type DirectMessage = (OwnMessages<"dm"> | ForeignMessages<"dm">) & Delivered
export interface GuildMessageCreate<WithIntent extends boolean> { readonly guildId: GuildId; readonly channel: MessageChannel; readonly message: ReceivedMessage<WithIntent> }
export interface DirectMessageCreate { readonly guildId: undefined; readonly channel: DMChannel; readonly message: DirectMessage }
export type MessageCreate<I extends Intent> =
  | ("GuildMessages" extends I ? GuildMessageCreate<"MessageContent" extends I ? true : false> : never)
  | ("DirectMessages" extends I ? DirectMessageCreate : never)
export interface ReactionAdd { readonly guildId: GuildId | undefined; readonly channelId: ChannelId
  readonly messageId: MessageId; readonly userId: UserId; readonly emoji: Emoji }

type NonTransient = "permission" | "payload" | "access" | "state"
type Unhandled<E> = Exclude<E, CategoryMarker<"transient">> | Extract<E, CategoryMarker<NonTransient>>   // D6 (final audit)
type TagOf<E> = unknown extends E ? "unknown (fix the errors above first)" : E extends { readonly _tag: infer T extends string } ? T
  : E extends { readonly [CategoryTypeId]: unknown } ? "a widened categorised type (keep each error's own class)" : "<untagged>"
export interface UnhandledErrors<What extends string> {
  readonly "unhandled errors: catchCategory these categories (catchTag these tags), or use Effect.orDie": What }
export type Handled<A, E, R> = [Unhandled<E>] extends [never] ? Effect.Effect<A, E, R>
  : unknown extends E ? (unknown extends A ? (unknown extends R ? MustReturnEffect : UnhandledErrors<"unknown (fix the errors above first)">) : UnhandledErrors<"unknown (fix the errors above first)">)
  : UnhandledErrors<Extract<Categories<Unhandled<E>>, NonTransient> | TagOf<Exclude<Unhandled<E>, CategoryMarker<NonTransient>>>>

export interface Bot<I extends Intent> {
  readonly intents: ReadonlyArray<I>
  readonly on: <K extends EventName, A, E, R>(event: K & IntentCheck<K, NoInfer<I>>,
    handler: (event: EventPayloads<I>[K]) => Handled<A, E, R>) => Effect.Effect<void, never, Exclude<R, Scope.Scope> | BotRuntime | Scope.Scope>
}
export declare const Bot: {
  readonly make: <const I extends ReadonlyArray<Intent>>(config: { readonly intents: I & LiteralIntents<I> }) => Bot<I[number]>   // a tuple (final audit)
  readonly layerWith: <I extends Intent>(bot: Bot<I>, config: BotConfig) =>
    Layer.Layer<BotRuntime, StartupFailed | Config.ConfigError, HttpClient.HttpClient | Socket.WebSocketConstructor>
  readonly layer: <I extends Intent>(bot: Bot<I>, config: BotConfig) => Layer.Layer<BotRuntime, StartupFailed | Config.ConfigError>
}
```

(M7, as built in `src/gateway/{Intents,Events}.ts` and `src/bot/{Bot,Handler}.ts`.) `EventIntents` is a runtime
table the type derives from and rules-check's events check reads: `READY` (no intent), `MESSAGE_CREATE`
(GuildMessages or DirectMessages), `MESSAGE_REACTION_ADD` (GuildMessageReactions or DirectMessageReactions),
`TYPING_START` (GuildMessageTyping or DirectMessageTyping), `GUILD_MEMBER_UPDATE` (GuildMembers) and
`CHANNEL_UPDATE` (Guilds), each with its live intent pair (`R-intent-*`, §5.5). `GUILD_MEMBER_ADD` is not
supported: no member can join Perms Lab without a human (or a kicked bot re-invited), so it can have no live pair.
The intent check's message is a named interface, so the diagnostic reads
`'"GUILD_MEMBER_UPDATE" & MissingIntent<"GuildMembers">'`. A reaction's emoji is `ReactionEmoji`, `unicode` by name
or `custom` by ID (a dispatch does not say whether a custom emoji is the guild's, so the send-side
`guild`/`external` split cannot be decoded). `CHANNEL_UPDATE` hands `{ channel: GuildChannel, obfuscated }` (any
guild channel kind; one the bot cannot view arrives obfuscated, H-160), not a `MessageChannel`. `READY` already
received when a handler registers (the build waits for the guild, so the first one always is) runs it once, then on
each new session. A dispatch the library cannot decode (malformed, or a channel it cannot resolve even after a
refresh) is logged and dropped, never handed on half-typed.

(After the M7 verifier) `bot.on`'s types follow the intents of the `Bot` value whose `on` is called, while content
and event delivery follow the build in `BotRuntime`, which is not parameterised by intents. A program that calls
`on` on a `Bot` declaring `MessageContent` but is provided `Bot.layer` of a `Bot` without it would compile with
`content: string` and receive `ContentUnavailable`. So `on` dies at registration when the running build lacks any
intent its `Bot` declares, naming them (a wiring defect, `test/unit/bot-events.test.ts`); a build with more intents
than the `Bot` only makes the types conservative.

(After the final audit) That registration check compares the `Bot`'s run-time list with the build's, so it never
fires when both come from one list whose *type* is wider than its value: `Bot.make({ intents: fromConfig })` with
`fromConfig: ReadonlyArray<Intent>` typed every event as delivered and `content` as `string`, while the bot identified
with fewer intents. `Bot.make` therefore requires the list's type to be a tuple (`LiteralIntents<I>`: otherwise
`Invalid<"intents must be written as a literal list ...">`). An element typed as a union (`[cond ? "GuildMessages" :
"GuildMembers"]`) still passes, and the types then assume every member is declared: checking each element cost the
reference bot about 90 types, for a form nobody writes by accident. The harness's intent sessions, whose intents are
a run-time value, use the internal `botWithRuntimeIntents` (not in the barrel), whose types follow every intent and
which the sessions read as the widest payload.

**The handler boundary names categories, not tags (D1 with a change).** The
message lists the non-transient categories that remain (at most four names) and
the tags of uncategorised errors. Revision 1 listed every tag, so with default
truncation a union of more than about 14 tags printed `... 6 more ...`, and the
common first draft (forwarding a built payload) never named six of its leaked
tags (`[rt:diag/d6-truncated-tags.ts]`). The handler's own hover still lists every
tag. `Unhandled` follows D6 as researched: an error that is transient **and**
state is unhandled. Revision 1 used `ExcludeCategory<E, "transient">`, which let
such a user error escape (`[re:src/d6-escape.ts]`, `[rt:holes/h8-transient-plus.ts]`). (After the final audit)
`Unhandled` is defined from `transient`, not by subtracting "some category": subtracting `CategoryMarker<string>` let
an error type widened to `Categorized<never>` or `Categorized<string>` through, because `{}` and an index-signature
marker are assignable to it, so a handler whose send can fail with `MissingSendMessages` compiled once its error type
was annotated that way. Such a type is now unhandled, and its message names it as a widened categorised type. A
handler that returns no Effect at all (a number, a Promise: tsc infers `unknown` for all three of `A`, `E` and `R`)
is `MustReturnEffect`, not the "fix the errors above" message.

**DMs.** `"dm"` is a message kind. `MESSAGE_CREATE` is a union of a guild
branch and a DM branch, and each branch exists only when its intent is
declared. The DM branch has `guildId: undefined`, a `DMChannel`, and `content:
string` (`[sd:src/bot-use.ts]` §7, §8).

**`message.content` (D25, adopted with a change).**

- `ContentUnavailable` is a real runtime value. The library puts a frozen
  singleton in `content` when Discord did not deliver content, so the type never
  lies about the runtime value.
- `contentDelivered` is computed by the library: own message, a mention of the
  bot user, or the intent declared. A ping-on reply mentions the replied-to
  author, so it falls under the mention case (H-172). DMs are their own branch.
- `if (m.contentDelivered)` narrows `content` to `string`
  (`[sd:src/bot-use.ts]` §2).
- Context-menu targets come through interactions, not this event.

**What compiles** (`[sd:src/bot-use.ts]`, exact `Equals` on the registration
type):

- a context-sensitive lambda that calls `event.channel.send` and catches
  `["permission", "state"]`;
- `Effect.fn("onMessage")(function* (event) {...})` with a service requirement,
  where `R` is inferred exactly as `Store | BotRuntime | Scope`;
- an explicit `Effect.orDie`;
- READY without any intent;
- an auto-publish handler that narrows `channelKind` and calls `crosspost`;
- a DM handler.

**What fails** (`src/fail/bot.ts`; sizes in `[sd:fail-diagnostics.txt]`):

```
Argument of type '"GUILD_MEMBER_ADD"' is not assignable to parameter of type '"GUILD_MEMBER_ADD" & { readonly "missing intent, add one of": "GuildMembers"; }'.
Property 'toUpperCase' does not exist on type 'string | ContentUnavailable'.
Property '"unhandled errors: catchCategory these categories (catchTag these tags), or use Effect.orDie"' is missing in type 'Effect<void | Sent<...>, MissingConnect | MissingSendMessages | ... 4 more ... | Transient, never>' but required in type 'UnhandledErrors<"access" | "permission">'.
Property '"unhandled errors: ..."' is missing in type 'Effect<never, Oops, never>' but required in type 'UnhandledErrors<"Oops">'.
Property '"unhandled errors: ..."' is missing in type 'Effect<never, Flaky, never>' but required in type 'UnhandledErrors<"state">'.
Property '"unhandled errors: ..."' is missing in type 'Effect<SentDegradable<...>, CommunicationDisabled | ... 17 more ... | Transient, never>' but required in type 'UnhandledErrors<"access" | "payload" | "permission" | "state">'.
```

The last one is the revision-1 truncation case; it now names all four
categories in 257 gated characters. Uncategorised user errors (`Oops`) must be
handled too. Library code that forwards a handler must take the already checked
type, `(event) => Handled<A, E, R>`; a generic `E` is rejected
(`[cc:src/fail/generic-forward.ts]`, `[cc:src/boundary/generic-forward-ok.ts]`).

`Bot.layerWith` leaves the base `HttpClient` and `WebSocketConstructor` open,
so tests and the harness can wrap or replace them; `Bot.layer` provides the Bun
platform (`[sd:src/identities.ts]`, which asserts `Bot.layer`'s requirement is
`never`). See §4.2.

### 2.8 Commands (`[sd:src/commands.ts]`, `[sd:src/commands-use.ts]`, `src/fail/commands.ts`)

```ts
export type ValueOption = StringOption | IntegerOption | NumberOption | BooleanOption | UserOption | RoleOption | ChannelOption
export interface SubcommandDef { readonly type: "subcommand"; readonly name: string; readonly description: string; readonly options?: ReadonlyArray<ValueOption> }
export interface GroupDef { readonly type: "group"; readonly name: string; readonly description: string; readonly subcommands: ReadonlyArray<SubcommandDef> }
export type CheckName<N extends string> = IsFiniteLiteral<N> extends false ? N : N extends Lowercase<N>
  ? (N extends `${string} ${string}` ? `names cannot contain spaces: ${N}` : Len<N> extends 0 | 33 ? `names are 1 to 32 characters` : N)
  : Lowercase<N>
export type Ordered<O extends ReadonlyArray<OptionLike>> = { readonly [I in keyof O]: I extends `${number}` ? CheckOption<O, I, O[I]> : O[I] }
export type CheckedSubs<S extends ReadonlyArray<SubcommandDef | GroupDef>> = { readonly [I in keyof S]: I extends `${number}` ? CheckSub<S[I], I> : S[I] }
export interface ChatInputCommand<N extends string, Invocation> { readonly kind: "chat-input"; readonly name: N; readonly [InvocationType]: Invocation }
export declare const Command: {
  readonly chatInput: <const N extends string, const O extends ReadonlyArray<OptionLike> = readonly []>(def: {
    readonly name: CheckName<N>; readonly description: string; readonly options?: O & Ordered<O> }) => ChatInputCommand<N, { readonly options: OptionsOf<O> }>
  readonly withSubcommands: <const N extends string, const S extends ReadonlyArray<SubcommandDef | GroupDef>>(def: {
    readonly name: CheckName<N>; readonly description: string; readonly subcommands: S & CheckedSubs<S> }) => ChatInputCommand<N, SubsInvocation<S>>
}
```

- **Nesting is enforced by construction.** A subcommand holds only value
  options, a group holds only subcommands, and a top level with subcommands
  cannot also hold value options (H-196, H-197).
- **Every rule applies at every level.** `CheckedSubs` applies `Ordered` to each
  subcommand's options and recurses into groups; count and names are checked
  for subcommands and groups too. Revision 1 checked only the top level
  (`[rt:holes/h5-subcommand-rules.ts]`).
- **The checks are mapped tuples, not recursion.** "Required after optional"
  is the adjacent pair (optional at I-1, required at I), found through a
  `Prev` index lookup, and "more than 25" is an index test. Revision 1's
  recursive `Ordered` re-spread a growing index and cost about 6.2k
  instantiations per 25-option command; this costs about 2.2k (§5.4).
- **Names** are checked only on finite literals, reusing `IsFiniteLiteral`.
  A template-pattern name such as `` `slot${number}` `` passes; revision 1
  rejected it as "not lowercase" (`[rt:diag/d0-pattern-name.ts]`).
- **Each option type takes only its own keys** (after the final audit): every
  option interface declares the keys it does not take as optional message
  types (`choices?: Invalid<"only string, integer and number options take
  choices">`, likewise `autocomplete`, `minLength`, `maxLength`, `minValue`,
  `maxValue`, `channelTypes`), so such a key is an error at that property. Before
  it, `choices` on a boolean option compiled and typed the handler's value as the
  choices' union, registration dropped the choices, and every invocation was
  dropped as malformed. One shared message per key keeps the cost at about 130
  types for the reference bot and nothing measurable per command.
- **A non-literal `required` may be true** (after the final audit), so an
  option with `required: someBoolean` after an optional one is the order error too.
  Duplicate option names are not checked by the types (it would cost about 25
  conditionals per option); Discord refuses them at registration, which is
  `StartupFailed("command-rejected")` naming the field.
- **The command type is opaque.** `ChatInputCommand<N, Invocation>` carries
  the computed invocation, not the option tuple, so the command and `ix` hover
  as the invocation object (§5.3).
- **Option values** are looked up by option type (dressed-style), choices
  become their literal union, and channel options narrow to the allowed kinds'
  handles. The hover of `ban`'s options (`[sd:hover.txt]`):

  ```
  type BanOptions = { readonly days?: number; readonly log?: AnnouncementChannel<never> | TextChannel<never>; readonly reason?: "abuse" | "spam"; readonly user: ResolvedUser; }
  ```

- **Diagnostics.** All are located on a property of the offending element and
  fit the gate (`[sd:fail-diagnostics.txt]`):
  - `Type '"Ban"' is not assignable to type '"ban"'.` (the expected type is the
    fix)
  - `Type '"ban user"' is not assignable to type '"names cannot contain spaces: ban user"'.`
  - `Type '"abcdefghijklmnopqrstuvwxyzabcdefg"' is not assignable to type '"names are 1 to 32 characters"'.`
  - `Type 'true' is not assignable to type 'true & Invalid<"required option feature must come before every optional option">'.`
    (on the `required` property: 241 characters for an option with a long
    description and four choices, which printed 851 in revision 1,
    `[rt:diag/d5-option-order.ts]`)
  - `Type '"a26"' is not assignable to type '"a26" & Invalid<"at most 25 options per level">'.`
  - `Type '"s26"' is not assignable to type '"s26" & Invalid<"at most 25 subcommands per level">'.`
  - `Type '"Reason"' is not assignable to type '"Reason" & Invalid<"names must be lowercase: reason">'.`
    (also inside subcommands: `"User"`, and inside groups: `"Add"`)
  - `Type '"subcommand"' is not assignable to type '"subcommand" & Invalid<"subcommands and groups go in Command.withSubcommands">'.`
  - `Type '"group"' is not assignable to type '"subcommand"'.`
- Context-menu (USER and MESSAGE) commands have their own constructor without
  name-case rules (H-192). It reuses the same machinery and is not separately
  prototyped. (M8: not built yet. M9 did not build it either: §6's M9 scope does not
  list it, its registration is a live row (types 2 and 3) that offline M9 cannot run,
  and a rule on its names needs its own live pair; it waits for a bot that needs it.)

(M8, as built in `src/commands/`.) A command carries its `definition` (name,
description, options as written), which registration sends. The phantom
invocation key is a symbol `Command.ts` does not export, so only `Command.*` makes a
`ChatInputCommand`: a forged object literal fails with `Property '[InvocationType]' is
missing` (`R-registration-diff`'s fail directive), and every command a bot registers
passed the definition checks. The constructors are overloads over a wide
implementation (rule 7 of §2.12): the name is `N` whenever the program compiles, and the
phantom's value is `undefined`, never read. Number options take `minValue`/`maxValue`
too. Empty `choices` or `channelTypes` restrict nothing (before M9: Discord drops them, recorded), so the option's
value is its type's (it was `unknown` for empty choices and `never` for empty kinds). `BotConfig` is a union: `commands` (an array of built commands) exists only with
`guildId`, because commands are registered in a guild only (check 5 of §4.4,
`Registration.sync` after GUILD_CREATE); absent, the guild's commands are left alone,
and `[]` removes them.

### 2.9 `custom_id` routes (`[sd:src/interactions.ts]`)

```ts
export interface ComponentRoute<Name extends string, A> {
  readonly name: Name
  readonly customId: (data: A) => Effect.Effect<CustomId, CustomIdTooLong>   // checked against 100 chars when built
}
export declare const ComponentRoute: {
  readonly make: <const Name extends string, S extends Schema.Codec<unknown, unknown, never, never>>(name: Name & CheckRouteName<Name>, schema: S) => ComponentRoute<Name, S["Type"]>
}
```

- A route name containing `:` fails with `Invalid<"route names cannot contain ':'">`,
  and (after the final audit) a name that is not a finite literal with
  `Invalid<"route names must be literals">`: a `string` could hold a `:` the type
  cannot see, and its IDs would then never route.
- A route, or a command, registered twice on one bot is a defect at the second
  registration (after the final audit): both handlers would answer one
  interaction, and Discord refuses the second answer (40060). The build's
  `BotRuntime` keeps the registered names for each registration's scope.
- **The wire format always goes through the canonical JSON codec:**
  `name + ":" + encode(Schema.fromJsonString(Schema.toCodecJson(schema)))(data)`,
  decoded with the same codec. Revision 1 used `JSON.stringify(encode(schema)(data))`:
  a `Schema.Date` route then failed every decode, `Schema.BigInt` threw while
  building the ID, and a `ReadonlySet` encoded to `{}` (`[rt:holes/h7-route-codec-runtime.ts]`).
  Through `toCodecJson`, all three round-trip (`[sd:route-codec-runtime.txt]`).
- The schema must need no services (`Codec<unknown, unknown, never, never>`).
  A declaration without a JSON annotation that cannot encode is a defect, and
  every route has a runtime round-trip unit test.
- On receipt, the runner routes by the prefix before the first `:`. A decode
  failure is external input (an old button), not a defect. The runner replies
  with an ephemeral "This control has expired" and logs it.
- `CustomIdTooLong` is `payload`. Ignoring it fails the handler boundary with
  `UnhandledErrors<"payload">` (`src/fail/example-leak.ts`).

### 2.10 Interactions (phase 3, `[sd:src/interactions.ts]`, `[sd:src/interactions-use.ts]`, `src/fail/interactions.ts`)

The state machine is **value-level**:

- A handler returns one initial `Response<R>` descriptor, and Discord is answered
  exactly once, with that one.
- Follow-ups exist only inside the continuation that receives `Answered`, so
  following up before answering cannot be written.
- Making a second response can be written (`yield* ix.reply(a); return yield*
  ix.reply(b)`, or a reply inside a reply's continuation). (After the final audit;
  revision 3 said it could not, and the first was dropped with no log.) Each
  interaction's session records every response its methods made (when the
  method's Effect runs, so a response built and never run does not count); the
  runner posts the returned one and logs, at Error, every other response the
  handler made and every response a continuation made, which are never posted.

**Responses are validated locally.** `ix.reply(...)`, `ix.update(...)`,
`ix.defer(...)` and `ix.showModal(...)` return `Effect<Response<R>, E>`, where
`E` holds the payload's limit errors. A too-long or empty reply is therefore a
typed error the handler must catch, and the reply can be returned directly
(`(ix) => ix.reply({ content: "pong" })`) with no `Effect.succeed` wrapping.
Revision 1 returned a bare descriptor that the runner posted later, so these
could never be typed (`[rt:holes/h10-interaction-payloads.ts]`).

**The defer mode is fixed at registration by a string argument.**

| Mode | Commands | Components | Auto-defer posts | `ix` offers |
|---|---|---|---|---|
| `"public"` | default | yes | DEFERRED_CHANNEL_MESSAGE (5) | reply, defer |
| `"ephemeral"` | yes | yes | 5 with EPHEMERAL | reply, defer |
| `"update"` | no | default | DEFERRED_UPDATE_MESSAGE (6) | update, deferUpdate |
| `"manual"` | yes | yes | nothing (3 s limit applies) | reply, defer, (update), showModal |

```ts
export interface ReplyPayload { readonly content?: string; readonly embeds?: ReadonlyArray<Embed>
  readonly components?: ReadonlyArray<ActionRow>; readonly ephemeral?: boolean; readonly suppressNotifications?: boolean }
type CheckReply<P, M> = NonEmpty<P> & KnownKeys<P, keyof ReplyPayload, "replying to an interaction"> & EphemeralCheck<P, M>
declare const CompletedBrand: unique symbol
export interface Completed { readonly [CompletedBrand]: "Completed" }          // nominal: not forgeable
export interface Answered {
  readonly followUp: <const P extends ReplyPayload>(payload: P & CheckReply<P, "manual">) =>
    Effect.Effect<void, PermissionErrors["SendMessages"] | InteractionExpired | Transient | /* ContentTooLong, MessageEmpty, EmbedTooLarge as for P */>
  readonly editOriginal: <const P extends EditMessage>(patch: P & CheckEdit<P>) => Effect.Effect<Completed, InteractionExpired | Transient | /* edit limits */>
  readonly deleteOriginal: () => Effect.Effect<void, InteractionExpired | Transient>
  readonly giveUp: (expired: InteractionExpired) => Effect.Effect<Completed>   // logs; the honest end of an expired token
}
interface Replies<M> {
  readonly reply: <const P extends ReplyPayload, A2 = unknown, E2 = never, R2 = never>(payload: P & CheckReply<P, M>,
    then?: (answered: Answered) => Handled<A2, E2, R2>) => Effect.Effect<Response<R2>, /* ContentTooLong | MessageEmpty | EmbedTooLarge as for P */>
  readonly defer: <const X extends boolean, A2, E2, R2>(options: { readonly ephemeral: X & EphemeralMatches<X, M> },
    then: (deferred: Answered) => HandledCompletion<A2, E2, R2>) => Effect.Effect<Response<R2>>   // (M9 verifier)
}
export interface InteractionContext { readonly guildId: GuildId; readonly user: { readonly id: UserId }; readonly channel: MessageChannel }
export interface CommandInteraction<I, M extends "public" | "ephemeral"> extends InteractionContext, Replies<M> { readonly invocation: I }
export interface ManualCommandInteraction<I> extends InteractionContext, Replies<"manual">, OpensModal { readonly invocation: I }
export interface UpdateComponentInteraction<A> extends InteractionContext, Updates { readonly data: A }
export interface ModalSubmitInteraction<A, M extends "public" | "ephemeral"> extends InteractionContext, Replies<M> { readonly data: A; readonly fields: ReadonlyMap<string, string> }
export interface AutocompleteInteraction<V extends string | number> { readonly focused: {...}; readonly choices: (choices: ReadonlyArray<{ name; value: V }>) => Effect.Effect<Response<never>> }
export interface Interactions {
  readonly command: {
    <I, A, E, R>(command: ChatInputCommand<string, I>, handler: (ix: CommandInteraction<I, "public">) => HandledIx<A, E, R>): Effect.Effect<void, never, R | RequirementOf<A> | BotRuntime | Scope.Scope>
    <I, const M extends CommandMode, A, E, R>(command: ChatInputCommand<string, I>, mode: M, handler: (ix: CommandIx<I, M>) => HandledIx<A, E, R>): Effect.Effect<...>
  }
  // component(route[, mode], handler), modal(route[, mode], handler), autocomplete(command, handler): same shape
}
```

Notes:

- **Why a string argument and arity overloads.** Revision 1 inferred `const
  AutoDefer extends boolean = true` from an options object; with an
  `Effect.fn` handler that made `ix` silently `any`, so unknown members,
  `showModal` under auto-defer and untyped options all compiled
  (`[rt:holes/h12-effect-fn-ix-any.ts]`). A mode inferred from a string argument
  keeps `ix` typed (`[sd:probe2/ix-reg2.ts]`). Overloads that differ only by
  arity keep diagnostics clean, because each call has one candidate. Overloads
  that share an arity print "No overload matches this call" with the **wrong**
  overload's error (`Type 'string' is not assignable to type 'false'`,
  `[sd:probe2/ix-reg.ts]` L45), which is why the reviewer's object-literal
  overloads were not adopted.
- `ix` is typed under `Effect.fn` for every entry, and `x1` in
  `src/fail/interactions.ts` proves it:
  `Property 'thisDoesNotExist' does not exist on type 'CommandInteraction<..., "public">'.`
- **A reply that omits `ephemeral` follows the mode** (after the final audit: the
  runner took the flag from the payload only, so a fast reply in "ephemeral" mode
  without the key was posted publicly, while a slow one went out after the mode's
  ephemeral deferral). The runner sets EPHEMERAL from the registration mode on
  the fast path too: always in "ephemeral", never in "public", and as the payload
  says in "manual". `test/unit/interactions-runner.test.ts` holds it.
- **Ephemeral must match the mode** (H-227: the ephemeral state cannot change
  after a deferral): `Type 'true' is not assignable to type 'true & Invalid<"ephemeral must match the registration mode public">'.`
- **Context.** `ix.guildId`, `ix.user` and `ix.channel` (built from the
  interaction's `app_permissions`, basis `"app-permissions"` for preflight).
- **Deferrals.** A deferred continuation must succeed with the nominal
  `Completed`, which only `editOriginal` and `giveUp` produce. The honest
  handling of an expired token is
  `editOriginal(...).pipe(Effect.catchTag("InteractionExpired", deferred.giveUp))`,
  with no `Effect.die` (`[sd:src/interactions-use.ts]` c2). Revision 1's
  structural `Completed` could be forged with `{ _tag: "Completed" }`, and the
  only honest handler was `Effect.die` (`[rt:holes/h11-defer-expired.ts]`).

Rules and their one-line diagnostics (`[sd:fail-diagnostics.txt]`):

| Rule | Diagnostic |
|---|---|
| `showModal` only before answering or deferring; auto-defer removes it | `Property 'showModal' does not exist on type 'CommandInteraction<{ readonly options: {...}; }, "public">'.` |
| no modal from a modal submit | `Property 'showModal' does not exist on type 'ModalSubmitInteraction<..., "public">'.` |
| follow-ups only after answering | `Property 'followUp' does not exist on type 'CommandInteraction<...>'.` |
| autocomplete answers only with choices | `Property 'reply' does not exist on type 'AutocompleteInteraction<string>'.` |
| handlers must return a response | `Property '"interaction handlers must return ix.reply, ix.defer, ix.update or ix.showModal"' is missing in type 'Effect<void, never, never>' but required in type 'MustRespond'.` |
| a deferral must be completed | `Property '"a deferred interaction must finish with deferred.editOriginal(...) or deferred.giveUp(...)"' is missing in type 'Effect<void, never, never>' but required in type 'MustComplete'.` |
| a reply or follow-up needs a body | `Property '"a message needs content, embeds, files, stickers, a poll or components"' is missing in type '{}' ...` |
| a dynamic reply may be too long or empty | `... 'Effect<Response<never>, ContentTooLong \| MessageEmpty, never>' but required in type 'UnhandledErrors<"payload">'.` |
| ephemeral matches the mode | `... Invalid<"ephemeral must match the registration mode public">'.` |

`InteractionExpired` is `state` and appears in every continuation call, so the
handler must deal with it, by `giveUp` in a deferral or by catching it
elsewhere. This is the honest consequence of Discord's 15-minute token.

(M9, as built in `src/interactions/`: `Interaction.ts` the types, `Runner.ts` the entry points and the runner,
`Wire.ts` the INTERACTION_CREATE decoding, `Checklist.ts` the checklist.) Every diagnostic in the table above is the
snapshot's (`test/types/fail/interactions.diagnostics.txt`), and the `ephemeral` one prints `Type 'true' is not
assignable to type 'true & Invalid<"ephemeral must match the registration mode public">'`. Where the build differs:

- **`Response<R>` is nominal.** Its phantom key is a symbol `Interaction.ts` does not export (as `ChatInputCommand`'s
  is), so an object literal is no `Response` (`MustRespond` names it), and the runner posts only a value `makeResponse`
  registered (a `WeakMap` of plans, so a forged object is no response at run time either). `Completed` is the same: a
  non-exported symbol and one frozen value, made only by `editOriginal` and `giveUp`.
- **A modal has inputs**: `Modal` is `{ customId, title, inputs: [TextInput, ...TextInput[]] }` (Discord requires one
  to five text inputs); a title or label over 45 characters is a defect (literals in the code), and the submit's
  `fields` map their values by `custom_id`.
- **Modes per entry**: `modal(route[, mode])` takes `"public"` (default) or `"ephemeral"` (`ModalMode`: a submit cannot
  open a modal, so no "manual"); `autocomplete(command, handler)` has no mode and no deferral (Discord has none for it);
  its `ix` is `AutocompleteInteraction<string | number>`, whose `focused` is `{ name, value }`.
- **`followUp`'s union adds `PermissionDeniedUnattributed`**: a 50013 on a follow-up is `MissingSendMessages` only when
  the interaction's `app_permissions` is present and lacks SendMessages; held or absent, it is unattributed (never a
  guess, §3; the M9 verifier found the absent case attributed).
- **`defer`'s `ephemeral` names the rule** (M9 verifier): it is `X & EphemeralMatches<X, M>`, as a reply's is, so a
  deferral against the mode prints `Type 'true' is not assignable to type 'true & Invalid<"ephemeral must match the
  registration mode public">'` (it printed `Type 'true' is not assignable to type 'false'`, naming neither the rule nor
  the mode).
- **The interaction's channel** is a handle with basis `"app-permissions"`, whose preflight reads the interaction's
  `app_permissions` (§4.7, as built there); a channel option's handle reads its resolved channel's `permissions`.
- **Interactions outside a guild are dropped** with a log (commands are guild commands, D18; a button on a DM message
  is out of scope).

### 2.11 End-to-end example (`[sd:src/example.ts]`, compiled with exact registration types)

```ts
const bot = Bot.make({ intents: ["Guilds", "GuildMessages", "MessageContent"] })
const poll = Command.chatInput({ name: "poll", description: "Ask a yes/no question", options: [
  { type: "string", name: "question", description: "What to ask", required: true },
  { type: "channel", name: "where", description: "Channel to post in", channelTypes: ["text", "announcement"] }] })
const vote = ComponentRoute.make("vote", Schema.Struct({ choice: Schema.Literals(["yes", "no"]) }))

const onMessage = bot.on("MESSAGE_CREATE", (event) =>
  event.message.content !== "!ping" ? Effect.void : event.channel.send({ content: "pong" }).pipe(
    catchCategory(["permission", "state"], (error) => Effect.logWarning(`cannot reply: ${error._tag}`))))

const onPoll = Interactions.command(poll, "ephemeral", (ix) => Effect.gen(function* () {
  const { question, where } = ix.invocation.options
  if (where === undefined) return yield* ix.reply({ content: "Pick a channel." })
  const yes = yield* vote.customId({ choice: "yes" })
  const no = yield* vote.customId({ choice: "no" })
  const channel = yield* Permissions.require(where, ["SendMessages", "EmbedLinks"])
  const sent = yield* channel.send({ embeds: [{ title: question }], components: [row([
    { kind: "button", style: "success", label: "Yes", customId: yes },
    { kind: "button", style: "danger", label: "No", customId: no }])] })
  return yield* ix.reply({ content: `Posted ${sent.message.id}` })
}).pipe(
  catchCategory("payload", () => ix.reply({ content: "That poll is too long." })),
  catchCategory(["permission", "state"], (error) => ix.reply({ content: `I can't post there (${error._tag}).` }))))

const onVote = Interactions.component(vote, "ephemeral", (ix) => ix.reply({ content: `You voted ${ix.data.choice}.` }))
export const Handlers = Layer.effectDiscard(Effect.all([onMessage, onPoll, onVote], { discard: true }))
export const Main = Handlers.pipe(Layer.provide(Bot.layer(bot, { token: Config.Redacted("DISCORD_SUBJECT_TOKEN") })))
// Main: Layer.Layer<never, StartupFailed | ConfigError, never>   (asserted)
```

Dropping the `payload` catch is rejected with `UnhandledErrors<"payload">`
(`src/fail/example-leak.ts`). The real reference bot is
`examples/reference-bot/main.ts`. It must not use `orDie`, `die` or
`dieMessage` on library errors. (M10, as built: the bot is `examples/reference-bot/bot.ts`, a poll bot importing only
the package, and `main.ts` its entry point through `config/Credentials.ts`. Its `/poll` catches `["permission",
"state"]` before `"payload"`: `MissingEmbedLinks` is in both, and the first catch that matches answers it, so the order
decides which answer the user gets; `test/unit/reference-bot.test.ts` found the reverse order telling the user the
question was too long.)

### 2.12 Type-design rules for implementers

Each rule below came from a failure seen while compiling.

1. **Error unions are inline unions of interface or mapped-type lookups.**
   Never use a generic alias whose arguments include the payload or an
   argument (`SendError<P>`, `ReplyLimits<P>`, `Registered<A, R>`,
   `DegradableFlags<P>` in a success type): the hover prints the alias with the
   whole argument (C11; `[sd:probe2/hover-ops.ts]`, `[sd:probe2/hover-degraded.ts]`).
   `OpErrors<G>[Op]` is fine because it resolves through a mapped type.
   (M10) A per-term conditional alias that resolves to one class or `never`
   (`ContentTooLongIn<P>`, `PatchTopicTooLongIn<P>`, `SendSuccess<C, P>` in
   `payload/PayloadRules.ts` and `channels/Channel.ts`) is fine too: for a
   concrete argument it resolves to the class, which is what the hover prints
   (the hover snapshots did not change). See rule 10.
2. **Never intersect a user literal with a conflicting literal.**
   `"Reason" & "reason"` collapses to `never`. Carry messages on the branded
   `Invalid<Msg>` marker (`[sd:src/payload.ts]`).
3. **Locate errors on a property or element**, never on the whole argument or
   the whole tuple: `{ [K in Bad]: Invalid<...> }`, `Mark<H, "required", Msg>`,
   array parameters instead of varargs.
4. **Sound "may be X" tests compare the literal against the union**, as in
   `"external" extends OriginOf<E>` and `"string-select" extends C[number]["kind"]`,
   never `E extends { origin: "external" }`. Distribute over payload unions
   (`P extends unknown ? ...`) and test `true extends ...`.
5. **Fail on a message-carrying type, never Effect against Effect.** Otherwise
   `exactOptionalPropertyTypes` adds its misleading header (type-testing §8.1).
6. **No `NoInfer` inside conditional types in our combinators** (effect-v4
   gotcha 1). `NoInfer` is used only on the intent check's `I`.
7. **Overloads, not casts, attach precise unions to wide implementations**
   (§4.7). Public overload sets differ by arity only.
8. **Never infer a type parameter from an options object next to a
   context-sensitive handler.** Use a string argument (§2.10).
9. **Every positive type claim has an `Equals` assertion**, and every negative
   claim has a fail fixture with a code, a mention, a snapshot and a `@valid` twin.
10. (M10, compile budget, §5.4) **Write a signature so that tsc can relate it
    to its twin by identity.** Together with §2.2's `CategorizedError`, these
    cut the reference bot from 76,573 types to 59,620 (LOG.md). In parentheses,
    the types that undoing each alone adds back to 59,620. None changes a type
    a user sees:
    - an overload that restates an interface's method (the handles in
      `channels/Ops.ts`, `Direct.ts`, `members/Member.ts`, the runner's
      answers) uses the same named aliases as the interface for its
      payload-derived terms, never inline conditionals: two inline
      conditionals are two types, compared structurally member by member
      (about 1,000 types over the handles, measured as they were added);
    - a signature implemented twice is attached once: the guild and DM sends
      share `sendMethodOf` (about 300, measured as it was added);
    - an implementation whose overload indexes the operation table with a type
      parameter (`OpErrors<G>[Op]`) has the error type `Wide<OpErrors<G>[Op]>`
      (`WideError` plus that term), so the overload check relates the term to
      itself instead of resolving its constraint over every row (2,319 types,
      26,417 instantiations); only where the index is a type parameter: a
      literal row (`OpErrors<G>["thread.join"]`) gains nothing;
    - a generic call returned into a large union passes its type arguments
      (`textChannel<PermissionFlag>(...)` in `buildHandle`,
      `reactMethod<"text">(typed)` in the message handles): otherwise tsc infers
      them from the contextual return type, walking every member (2,840 and
      637);
    - `Extract<DegradableFlags<P>, PermissionFlag>`, not
      `Extract<PermissionFlag, DegradableFlags<P>>`, which distributes over the
      52 flags into 52 deferred conditionals (1,257);
    - error classes are declared with `CategorizedError`, not by piping
      `withCategory` (§2.2; 8,078 types and 50,064 instantiations, with the
      variants and `withCategory`'s implementation signature).

---

## 3. Error taxonomy

### 3.1 Table

Codes and statuses marked (H) are hypotheses from discord-semantics. The live
matrix records the real (status, code) pair in the truth table, and `ErrorMap`
is updated from it. An operation's error union is exactly its row in the
operation table plus its payload- and argument-derived members (§2.3-§2.6). A
code not in `ErrorMap` for that operation is a defect (`UnmappedDiscordError`),
so the matrix has to find it.

| Tag | Categories | Raised by (operations) | Discord code(s) (status) | Notes |
|---|---|---|---|---|
| `Missing<Flag>` (52, generated) | permission (+access for View, Send, SMIT, Connect; +payload for the 8 payload flags) | any op whose row or payload includes the flag | 50013 (403), 50001 (403) after recompute; never from the body alone (H-081) | built only by `errorFor` |
| `MissingReadMessageHistoryForReply` | permission, payload | send, createPost with `reply` (variant `reply`) | 160002 (H) through recompute, or 50013 + recompute | tag `MissingReadMessageHistory` |
| `MissingReadMessageHistoryForReaction` | permission, access | react (variant `reaction`) | 50013 + recompute | same tag |
| `PermissionDeniedUnattributed` | permission | every op that can return 50013/50001 | 50013/50001 where recompute finds nothing | never guess |
| `PermissionRevokedSinceCheck {flag}` | permission | ops on a handle from `require` | 50013 where recompute finds a flag in `granted` | D8 |
| `CommunicationDisabled {until}` | state | every row whose flags the timeout mask removes; `require` | preflight (member timeout) or 50013 + recompute | only if `Observed.botsCanBeTimedOut` |
| `ThreadLocked` | state | thread send, thread edit, setArchived, unarchive (M4: not an own edit, which a locked thread allows) | 160005 (403) through recompute; a locked thread's send answers 50001 (M4) | |
| `ThreadArchived` | state | own edit, deletes and bulk delete in threads, react, pin, unpin (M4: not join, leave or addMember, which succeed) | 50083 (400) through recompute | not on send (H-035) |
| `SlowmodeActive {retryAfterMs}` | state | send | 20016 (429 coded or 400) | only if `Observed.slowmodeAppliesToBots` (D11); default false (H-053) |
| `TargetAboveInHierarchy` | state | setNickname, timeout, kick, ban | 50013 where recompute finds the target not below; also preflight | H-062..H-066 |
| `RoleAboveInHierarchy` | state | addRole, removeRole | 50013 where recompute finds the role not below the bot's top role; also preflight | H-060; H-061 decides whether target rank also matters |
| `TargetIsAdministrator` | state | timeout | 50013 (H 403) with an admin or owner target | H-021, H-067 |
| `RoleIsManaged` | state | addRole, removeRole | (H 50013 or other) | H-068 |
| `TwoFactorRequired` | state | every row with a 2FA-starred flag | 60003 (H 403) | live only if `mfaLevel=1` |
| `AlreadyCrossposted` | state | crosspost | 40033 | H-141 |
| `ThreadAlreadyExists` | state | createThread from a message | 160004 | |
| `TagRequired` | state | createPost | 40067 | H-044 |
| `MaximumPinsReached`, `MaximumReactionsReached`, `MaximumActiveThreads` | state | pin; react; createThread, createPost | 30003; 30010; 160006 | resolver-only for 30003 (cost) |
| `UnknownChannel`, `UnknownMessage`, `UnknownMember`, `UnknownRole`, `UnknownEmoji` | state | ops on that object (M6: a message's operations also list `UnknownChannel`) | 10003, 10008, 10007, 10011, 10014 (H 404) | |
| `CannotMessageUser` | state | DM send | 50007 | |
| `InteractionExpired` | state | interaction continuation calls | 10062, 10015, 50027 (H) | phase 3 |
| `DailyCommandCreateLimit` | state | command registration | 30034 (429 coded or 400) | surfaces as `StartupFailed` |
| `ContentTooLong {length, limit}` | payload | send, createPost, edit, reply, followUp, editOriginal, update with non-literal content | preflight; 50035 inner `BASE_TYPE_MAX_LENGTH` on `content` | unit per `Limits` (H-121) |
| `EmbedTooLarge {limit}` | payload | any op whose payload may include embeds | preflight; 50035 inner on `embeds.*` | keyed on presence, not mode |
| `MessageEmpty` | payload | send, createPost, edit, reply, followUp when emptiness is possible | preflight; 50006 | |
| `PollTooLarge {limit}` | payload | send, createPost with a poll | preflight; 50035 inner on `poll.*` | |
| `NameTooLong {length, limit}` | payload | createThread, createPost, channel/thread edit with a non-literal name | preflight; 50035 inner on `name` | 1..100 |
| `TopicTooLong {length, limit}` | payload | channel edit with a non-literal topic (M6: stage channels have one, on the `voice.edit` row) | preflight; 50035 inner on `topic` | 1024 (4096 forum/media) |
| `SlowmodeOutOfRange {seconds}` | payload | channel/thread edit with a non-literal slowmode | preflight; 50035 inner on `rate_limit_per_user` | 0..21600 |
| `NicknameTooLong {length, limit}` | payload | setNickname with a non-literal string | preflight; 50035 inner on `nick` | 32 |
| `TimeoutTooLong` | payload | timeout with a Date | preflight; 50035 inner on `communication_disabled_until` | 28 days (H-025) |
| `MessagesTooOld` | payload | bulkDelete | preflight (snowflake age > 14 days); 50034 (400) | |
| `TooManyMessagesToDelete {count}` | payload | bulkDelete with more than 100 IDs | preflight; 50016 | at least 2 is a type rule |
| `CustomIdTooLong {route, length}` | payload | `ComponentRoute.customId` | local only | |
| `DiscordUnavailable {cause}` | transient | every REST op | 5xx; 4xx with non-JSON body (Cloudflare) | |
| `NetworkError {cause: NoResponse}` | transient | every REST op | `TransportError` | |
| `RequestTimedOut {cause: NoResponse}` | transient | every REST op | per-call deadline (D9), including dfx's unbounded 429 loop | outcome unknown (§4.10) |
| `RateLimited {retryAfterMs, cause}` | transient | send, edit, crosspost, createPost | coded 429s 20028, 20022, 30046 | via the interceptor (G2) |
| `StartupFailed {reason, cause?}` | layer error, not a handler error | `Bot.layer` | 401 (getMyUser), 5xx/network (`discord-unavailable`), app flags, guild membership, registration 50035/30034 | D19 |

**Defects** (never in `E`):

- a 2xx body that fails our schema;
- `RatelimitedResponse` (D10);
- a Discord code not mapped for the operation (`UnmappedDiscordError`, with the
  full `DiscordResponse` attached);
- `HttpClientError` `EncodeError` or `InvalidUrlError`;
- a resolver invariant violation that no Discord state can explain. A 50001 or
  10003 from `getChannel` during a refresh is **not** a defect: it is evidence of
  missing View, and a thread whose parent cannot be fetched is treated as
  having no View;
- 40060 (a second acknowledgement, impossible by construction);
- a finite-literal value over a limit;
- a route schema that cannot encode to JSON.

### 3.2 Ordering rule for several failures (D7, generalised)

When preflight (or the recompute) finds several problems, it returns the
**ordered list** of all of them (`preflightSet`), and the operation fails with
the first, in this order (`src/permissions/Order.ts`):

1. `ViewChannel`. This includes obfuscated channels, private threads the bot
   cannot see (§4.6), and in voice and stage channels `Connect` (H-015,
   H-152; the `voice.*` rows), then a row's `viewLevel` flags: M4 live,
   pinning and crossposting a message without ReadMessageHistory answer 50001
   even under a timeout, so Discord checks it as access to the message.
2. `CommunicationDisabled`, when the timeout mask applies (H-020), or always for
   a row the timeout blocks itself (`blockedByTimeout`: an own edit).
3. Access flags of the action: `SendMessages`/`SendMessagesInThreads` for send.
   (Revision 2 put `ReadMessageHistory` (ForReaction) here for react; M4 live
   showed a reaction needs no ReadMessageHistory, so the react rows dropped it.)
4. The action's own flags in table order, for example `ManageMessages`,
   `PinMessages`, `AddReactions`, `ManageThreads`, `CreatePublicThreads`,
   `ManageRoles`.
5. Hierarchy (`TargetAboveInHierarchy`, `RoleAboveInHierarchy`,
   `TargetIsAdministrator`), then other state (`ThreadArchived`,
   `RoleIsManaged`, `TagRequired`).
6. Payload flags in `PayloadRules` order: `ReadMessageHistory` (ForReply),
   `EmbedLinks`, `AttachFiles`, `SendTTSMessages`, `SendPolls`,
   `UseExternalStickers`; then `ThreadLocked`. (M4 live, the verifier's
   ordering row: a locked thread whose send also lacks EmbedLinks answered
   403 50013, the payload flag's code, where the lock alone answers 50001
   (H-036), so Discord checks the payload's flags before the lock; revision 2
   ranked the lock in tier 5. Whether `ThreadArchived` and `TagRequired` also
   come after the payload is untested; no operation has both yet in M4.)
7. Local limits (`MessageEmpty`, `ContentTooLong`, `EmbedTooLarge`,
   `PollTooLarge`, `NameTooLong`, ...). These are checked first in time because
   they need no state, but they rank last.

**When Discord's own code ranks differently.** Discord sometimes answers with a
dedicated code where our order puts another failure first, for example 160005
(locked) on a thread where `SendMessagesInThreads` is also missing, or 160002
(reply needs RMH) when `SendMessages` is also missing. The design decides this
here, not in M4:

- **Library.** On the REST path the dedicated permission-like codes 160002,
  160005 and 50083 go through the recompute, like 50013 and 50001 (§4.9). If
  the recompute finds failures, our order decides the public tag. If it finds
  none (the state was stale), the code's own tag is returned.
- **Agreement.** A raw code-mapped tag agrees when it is a member of the row's
  `preflightSet`; the truth table records Discord's tag in `raw.mappedTag`
  (§5.10). The order is never loosened row by row.
- **Matrix.** The ordering family covers every adjacent pair of §3.2 **and**
  the non-adjacent pairs where Discord has a dedicated code: Send plus reply
  RMH, SMIT plus locked, View plus archived (§5.9).

---

## 4. Runtime architecture

### 4.1 Services

| Service (Context.Service) | Provided by | Holds |
|---|---|---|
| `BotRuntime` | `Bot.layerWith(bot, {token})` (platform open) or `Bot.layer` | `DiscordApi`, `GuildState`, `InteractionsRunner`, identity (bot user ID, application ID), intents |
| `DiscordApi` | inside `BotRuntime` (`runtime.api`, M5) | wrapped dfx `DiscordREST` (§4.7-§4.10) |
| `DiscordApiConfig` (`Context.Reference<{ requestDeadline }>`, default 30 s) | read when a bot is built (M5) | the request deadline of every call: operations, startup checks, refreshes and the recompute's reads |
| `GuildState` | inside `BotRuntime` | `SubscriptionRef<Snapshot>` with per-entity generations; `awaitGuild`, `refresh`, `snapshot` |
| `Preflight.Mode` (`Context.Reference<"enforce" \| "bypass">`, default `"enforce"`) | internal; only the harness sets `"bypass"` | |
| `HarnessRest`, `TargetRest` | `harness/Identities.ts` | raw dfx REST per identity |
| `SubjectRaw` | `bot/Internals.ts` (not exported) | the raw dfx REST of the **same** subject build, for step (c) |
| `Pacing`, `DryRun` | `harness/` | the global token bucket and counters; the dry-run switch read by the shared client |

Handles (channels, messages, members, interactions) close over `BotRuntime`
when they are built, so their methods have `R = never`.

### 4.2 Identities, `Layer.fresh` and seams (G1, D13; `[sd:src/identities.ts]`)

- **Each identity's dfx stack is wrapped in `Layer.fresh`.** Without it, Effect
  memoises `DiscordRESTLive` by reference and every identity sends the first
  token (`naive: auth=["Bot HARNESS","Bot HARNESS"]`, `[cc:src/identities-runtime.ts]`).
- **`Layer.fresh` duplicates everything provided inside it.** It builds with a
  new memo map, so a shared service provided inside each identity's stack
  becomes one instance per identity (`[re:layer-seams-runtime.txt]` Q2:
  `instances=3`). Rule: services that must be shared across identities (the
  paced base `HttpClient`, the 401/403/429 counter, the per-route write counter)
  are provided **outside** every fresh boundary and reach each identity as a
  requirement. Within one bot build, `GuildState` and the `DispatchHook` are in
  the same fresh build, so the hook writes the state the operations read.
- **Harness and target** are REST-only fresh stacks with their `HttpClient`
  requirement left open (`restIdentity` in `[sd:src/identities.ts]`).
- **The subject is the library's real composition.** The harness builds the
  subject with the internal `BotInternals.layerWith`, which returns
  `BotRuntime | SubjectRaw` from one build, with `HttpClient |
  WebSocketConstructor` open. `SubjectRaw` is the raw `DiscordREST` of that
  build, so step (c) shares the subject's client, token and rate-limit store
  with the library. Revision 1 baked the platform into `Bot.layer`, so a test
  fake provided from outside saw nothing, and `SubjectRaw` could not come from
  the same stack (`[re:layer-seams-runtime.txt]` Q1).
- `[sd:src/identities.ts]` asserts that the composed `Harness` provides exactly
  `HarnessRest | TargetRest | BotRuntime | SubjectRaw` with no remaining
  requirement, and that the public `Bot.layer` needs nothing.
- **Identity test.** A unit test builds exactly `Harness` from the exported
  `harness/Identities.ts` and `Bot` layers, with only the base `HttpClient`
  swapped for a recording fake (`HarnessUnderTest` in `[sd:src/identities.ts]`),
  and asserts three distinct `Authorization` headers using fake tokens. It runs
  in M2 against the REST identities and again in M7 once the subject is the
  real bot layer.

### 4.3 Credentials (G3, D14)

- Every package script runs `bun --no-env-file ...`, so Bun never copies
  `.env` into `process.env`.
- `config/Credentials.ts` provides
  `ConfigProvider.layer(ConfigProvider.fromDotEnv({ path: ".env" }))` over
  `BunFileSystem.layer`, and takes the live lock (§5.6) whenever a Perms Lab
  token is read, for any identity and any entry point. It exports only the
  layers (`layer`, and `layerFrom` with the `.env` and lock paths for tests);
  the config recipe and the `.env` path stay private, so nothing reads the
  tokens without taking the lock first (M2).
- Tokens are read only as `Config.Redacted("DISCORD_<ID>_TOKEN")`. They are
  never logged, printed, put in spans or errors, or written to the truth table.
- `vitest.config.ts` sets `envDir: "test/env"`, an empty directory, so vitest
  never reads `.env`, and refuses to run under the Bun runtime, whose
  workers would load `.env` themselves (unit tests run under Node, M2).
- `DISCORD_TEST_GUILD_ID` is a `Config.String` decoded to `GuildId`, and
  `DISCORD_<ID>_APP_ID` decode to `ApplicationId`.

### 4.4 Startup checks (D19, C6)

`Bot.layer` runs these before the gateway starts. Each failure is a
`StartupFailed {reason, cause?}`:

1. `getMyUser()`; a 401 gives `invalid-token`; a 5xx, transport error or
   deadline gives `discord-unavailable` with the cause.
2. `getMyApplication().flags` must contain the bit for each declared privileged
   intent: GuildMembers needs `GatewayGuildMembers` 16384 or `...Limited` 32768,
   and MessageContent needs `GatewayMessageContent` 262144 or `...Limited`
   524288. Otherwise `privileged-intent-not-enabled`.
3. If a guild is configured, `getGuildMember(guild, botUser)` (not
   `getMyGuildMember`, C6); a 404 gives `not-in-guild`.
4. After the gateway starts, `GuildState.awaitGuild(guild)` must see
   GUILD_CREATE within 30 s, else `guild-not-ready`.
5. Command registration (§4.14); 50035 or 30034 gives
   `command-rejected`/`daily-command-limit`. (M8: only when `BotConfig.commands`
   is given; absent leaves the guild's commands alone, and `[]` removes them.)

**Harness identity checks** (`harness/IdentityCheck.ts`), run by
`harness:smoke` and `verify:live` before any write; any difference aborts:

- for each identity, `getMyApplication().id` equals its `DISCORD_<ID>_APP_ID`,
  and the three `getMyUser().id` values are distinct;
- the subject gateway's READY `user.id` equals the subject's `getMyUser().id`
  (from M3, when the subject is the library's bot layer with its gateway; M2's
  subject is REST-only and the check is printed as not checked yet);
- the intents bitfield the codec actually sent in op 2 (recorded by
  `gateway/Codec.ts`) equals the declared intents (from M7, with the codec);
- `getGuild(DISCORD_TEST_GUILD_ID)` is named "Perms Lab" and contains
  `#rules` and `#mod-updates`;
- the harness's highest role is the highest role in the guild.

Checks 1-3 of `Bot.layer` live in `bot/Startup.ts` as `restChecks` (M2), which
the harness runs for each identity with its privileged intents (harness:
GuildMembers; subject: GuildMembers and MessageContent).

The harness also reads its own application flags to learn whether its REST
reads see content (D35).

### 4.5 GuildState and the DispatchHook reducer (D15, C5)

```
Snapshot   = { botUserId: UserId | undefined, guilds: ReadonlyMap<GuildId, GuildSnap> }
GuildSnap  = { id, ownerId: UserId, stale: boolean,
               roles: ReadonlyMap<RoleId, { permissions: PermissionSet, position: number, managed: boolean }>,
               channels: ReadonlyMap<ChannelId, ChannelSnap>,
               unseen: ReadonlySet<ChannelId>,                       // a refresh got 50001/10003: no View
               threadMembership: ReadonlyMap<ChannelId, boolean>,    // the bot's, apart from the thread entries
               botMember: { roleIds: ReadonlyArray<RoleId>, timedOutUntil: string | null } | undefined,
               generations: ReadonlyMap<"guild" | "member" | `role:${id}` | `channel:${id}`, number> }
ChannelSnap = { id, kind: ChannelKind, parentId: ChannelId | undefined, obfuscated: boolean,
               overwrites: ReadonlyArray<{ id, type: "role" | "member", allow: PermissionSet, deny: PermissionSet }>,
               thread: { archived: boolean, locked: boolean, ownerId: UserId | undefined } | undefined }
```

(M3: the generations live in one per-guild map keyed by entity, which also keeps the generation of a deleted
entity, so a refresh that read a channel before a CHANNEL_DELETE and a CHANNEL_CREATE cannot commit it. The
bot's thread membership is a map of its own, because THREAD_MEMBERS_UPDATE can arrive before the thread.
`timedOutUntil` is Discord's ISO string, which `CommunicationDisabled.until` carries.)

- `state/Hook.ts` is a `DispatchHook` layer over `GuildState.apply`, provided below
  dfx's gateway in the same build. It runs serially per shard **before**
  subscribers, so it cannot miss GUILD_CREATE.
- The reducer handles: READY (bot user ID), GUILD_CREATE (roles, channels and
  threads with `guild_id` **stamped from the dispatch**, owner, the bot member
  from `members` filtered to the bot), GUILD_UPDATE/DELETE, GUILD_ROLE_*,
  CHANNEL_*, THREAD_CREATE/UPDATE/DELETE/LIST_SYNC, THREAD_MEMBERS_UPDATE (bot
  membership), THREAD_MEMBER_UPDATE, and GUILD_MEMBER_UPDATE for the bot (it
  arrives without GuildMembers, H-175).
- A private thread the bot is removed from is dropped: Discord sends no further
  events for it (threads.mdx), and a refresh brings it back if the bot can still
  see it. A thread without `thread_metadata` is a malformed payload.
- A channel carrying flag `1 << 17` is stored with `obfuscated: true`, and its
  fake overwrite is dropped.
- **Versioning.** Every dispatch that touches an entity bumps its
  `generation`. The reducer's value is a function of the dispatch, so a replay
  after RESUME (dfx delivers at least once) leaves the value unchanged.
- The hook must be fast and must **never fail**. A failing hook makes dfx
  reconnect. Payloads are decoded with minimal schemas; a decode failure logs
  at Error with the event name and sets `stale: true` on that guild.
- `refresh(guildId, channelId)` captures the generations of the entities it
  will fetch, issues `getChannel` (and the parent for threads),
  `getGuildMember(guild, botUser)` and `getGuild` (which carries the roles, so
  M3 does not also call `listGuildRoles`), and
  commits **only entities whose generation is unchanged**. An entity a newer
  gateway event touched keeps the newer value. Revision 1 fed REST results
  through the reducer unconditionally, and a CHANNEL_UPDATE reduced while the
  GET was in flight was lost for good (`[re:runtime-races.txt]` 1). The
  generation rule is checked deterministically in
  `[sd:probe2/rt/refresh-generation.txt]` (`refreshCommitted: false`, the
  CHANNEL_UPDATE value survives, a replay changes nothing). `stale` is cleared
  by a non-racing refresh or a gateway event.
- (M5) `refreshGuild(guild)` makes the same reads without a channel: what a
  guild-level operation (role assignment, nicknames, timeouts, kick and ban)
  is resolved over, for the recompute.
- `getChannel` answering 50001 or 10003 during a refresh records the channel as
  not visible (`unseen`, no View); it is not a defect (§3.1). A REST thread
  carries the bot's thread member object exactly when it is a member, so a
  refresh sets membership from it.
- (M6) An `unseen` mark is evidence about the bot's permissions when the
  refresh read it. A role created, updated or deleted, a guild update and the
  bot's member update retire every mark (Discord sends no channel event when a
  role grants View, M6 live); a channel or thread event, THREAD_LIST_SYNC
  included, retires its channel's. A refresh that finds a guild channel unseen
  keeps the gateway's copy, which GUILD_CREATE and CHANNEL_* keep current
  whether or not the bot can see it, so the resolver has it once the mark is
  retired; a thread's copy is dropped (the gateway sends nothing for a thread
  the bot cannot see) and the next use refreshes it. A 50001 for a voice or
  stage channel the state holds records nothing: Discord answers it without
  Connect as well as without View (M6 live, H-152), and the resolver's Connect
  mask decides from the gateway's copy. (M7) Nor does a 50001 for a guild channel
  the state holds obfuscated: the obfuscated copy already says no View, and Discord
  replaces it with the real data when View returns (H-161), where an `unseen` mark
  would have kept the channel blind under another name until an event retired it.

### 4.6 Resolver (D22; H-001..H-029, H-033, H-047)

`resolve({ guild, channel, member, now }): Resolution` is pure; `channel` is
`Known { channel, parent, threadMember }` or `Unseen`:

```
Resolution = { base: PermissionSet, afterOverwrites: PermissionSet, beforeTimeout: PermissionSet, effective: PermissionSet,
               masks: ReadonlyArray<"obfuscated" | "unseen" | "private-thread" | "implicit-view" | "implicit-send"
                                    | "implicit-connect" | "timeout">,
               timeout: { until: string } | undefined, thread: { archived, locked, creatorIsMember, memberIsInThread } | undefined,
               voice: boolean }
```

`inputFromSnapshot(snapshot, guild, channel, now)` builds the input from the
guild state, or says a refresh is needed first (M4: `guildInputFromSnapshot`
builds the guild-level input of the member operations, `ChannelInput` `Guild`,
which applies no overwrites and no implicit masks, only the timeout mask) (a channel, a thread's parent or
the bot member the state does not hold). `unseen` (M3) is the mask for a channel
a refresh could not fetch, or a thread whose parent is unknown (§3.1): the bot
knows nothing of its overwrites.

The stages run in this order:

1. **base**: owner gives ALL; `@everyone` is found by `id === guild.id`; OR in
   the member's roles; Administrator gives ALL.
2. **overwrites**: computed on the parent for threads. Apply the `@everyone`
   overwrite, then all role overwrites aggregated (deny, then allow), then the
   member overwrite. Array order and role positions are ignored.
3. **masks** (each recorded when its condition holds, stopping once nothing is
   left; an Administrator in the base holds every flag, so no implicit mask's
   condition holds for it, and an Administrator bit from an overwrite exempts
   nothing, H-004):
   - obfuscated (or unseen) means no View;
   - a private thread is visible only to members and to holders of
     ManageThreads (threads.mdx; H-033, H-047): otherwise no View. (M6 live,
     `timeoutHidesPrivateThreads`: the timeout counts first, so a timed-out
     member's ManageThreads shows it no private thread it is not in.);
   - no View means nothing (H-012);
   - on non-thread channels, no Send masks MentionEveryone, SendTTSMessages,
     AttachFiles and EmbedLinks (H-013, docs version, D22);
   - in voice and stage channels, no Connect masks ManageChannels (H-015);
   - the timeout mask keeps only View and ReadMessageHistory, unless the member
     is owner or admin (H-020, H-021). It is applied after overwrites (H-029).

Every stage switch is a named entry in `ResolverRules.ts`, with its H-id and
the "docs" default. A live finding flips one entry and adds a `LOG.md` line. The
resolver is never forked per scenario.

**Hierarchy** is two functions (H-060..H-073):

- `targetBelow(guild, botMember, targetMember)`: highest-role positions with ID
  tie-break; used by setNickname, timeout, kick and ban;
- `roleBelow(guild, botMember, role)`: the role's position against the bot's
  highest role; used by addRole and removeRole. The target's rank is not
  consulted (H-061); if the matrix shows it matters, `ResolverRules` adds it and
  the table adds `TargetAboveInHierarchy` to those rows.

Both bots' managed roles count in their hierarchy (H-073).

### 4.7 The operation table, preflight and how an operation is implemented

`permissions/Operations.ts` is the one table (§2.4). Each row's flags are the
hypotheses the matrix confirms:

| Operation rows | Kinds | Required flags | State checks |
|---|---|---|---|
| `channel.send`, `voice.send`, `thread.send` | text/announcement; voice/stage; threads | View; Connect (voice); Send or SMIT; `requiredFlags(payload)` | timeout; locked thread |
| `dm.send` | dm | none | |
| `forum.createPost` | forum, media | View, Send (H-031); payload | timeout; tag required |
| `message.edit.channel` / `.thread` / `.voice` (own) | message kinds | View, (Connect in voice, M4) | timeout (`blockedByTimeout`); archived thread (a locked one allows it, M4) |
| `message.deleteOwn`, `deleteForeign` (each with `.thread` and `.voice`, M4) | message kinds | View, (Connect) / View, (Connect), ManageMessages | 2FA (foreign); archived thread (M4) |
| `message.crosspostOwn` / `Foreign` | announcement | View, ReadMessageHistory (`viewLevel`, M4), Send / + ManageMessages | already crossposted |
| `message.react.*` | message kinds | View, (Connect), AddReactions **conditional**, + UseExternalEmojis if external (no ReadMessageHistory, M4) | timeout; archived thread |
| `message.pin.channel` / `.thread` | text/announcement; threads (not voice or stage text chat, which has no pins: M4, H-159 refuted) | View, ReadMessageHistory (`viewLevel`, M4), PinMessages (H-050) | timeout; archived thread |
| `message.unpin.channel` / `.thread` | as pin | View, ReadMessageHistory (`viewLevel`, M4), PinMessages | timeout; archived thread |
| `channel.pins`, `voice.pins` | message kinds | View, (Connect) (RMH missing means degraded: the row's `degrades`) | |
| `channel.bulkDelete`, `voice.bulkDelete` (M4) | message kinds | View, (Connect), ManageMessages | 2FA; age; count |
| `channel.createThread.public` / `.private` | text (both), announcement (public) | View, CreatePublicThreads / CreatePrivateThreads | timeout; already exists |
| `thread.join` / `thread.leave` | threads | View / nothing (M4: leaving needs no View) | archived (leave only; joining an archived thread succeeds, M4) |
| `thread.addMember` | threads | View, SMIT | (an archived thread accepts it, M4) |
| `thread.setArchived`, `thread.setLocked`, `thread.edit` | threads | View, SMIT (M4), ManageThreads (creator exemption for archive, H-045) | locked |
| `thread.unarchive` (M4) | threads | View, SMIT | locked |
| `thread.delete` (M4) | threads | View, ManageThreads (creator exemption, M4) | 2FA |
| `channel.edit`, `voice.edit` | non-threads | View, (Connect), ManageChannels | 2FA |
| `member.*` | n/a | ManageRoles / ManageNicknames / ModerateMembers / KickMembers / BanMembers | role or target hierarchy; managed role; 2FA; target admin (timeout) |
| `permissions.require` | guild channels | View + the checked flags | timeout |

**Conditional AddReactions.** Discord needs AddReactions only when nobody has
reacted with that emoji yet (message.mdx; H-144). `MissingAddReactions` stays
in the type (a sound over-approximation). Preflight requires it only when the
handle's decoded `reactions` prove the emoji is not on the message. When that
is unknown (for example a gateway MESSAGE_CREATE without reactions), preflight
skips AddReactions; a 50013 then goes to the recompute, which fetches the
message and attributes the tag.

**Preflight** (`Preflight.decide(op, resolution, args) -> Pass | Fail(list)`)
takes the row's flags and state checks plus the payload flags and returns the
ordered failure list of §3.2. The basis is GuildState for gateway-obtained
handles, or the interaction's `app_permissions` (and resolved channels'
`app_permissions`) for handles from an interaction (`basis: "app-permissions"`).
(M9, as built: the handle's core carries the parsed `app_permissions`, and so does the operation's `Recompute.Target`;
preflight then resolves with `Resolver.fromAppPermissions`: Discord's own computation stands for every stage up to the
timeout, no blind mask applies, and the guild state's resolution of the channel, when it holds one, still gives the
timeout, the thread's state, voice and the required tag. A 50013 after it goes to the recompute over the refreshed
guild state as for any handle. Open question 8 decides whether `app_permissions` already reflects a timeout.)
`Preflight.decide` is pure and shared by the library and the offline replay.
What counts as a problem (M3):

- a blind channel (obfuscated, unseen, or a private thread the bot neither
  belongs to nor moderates) is `ViewChannel` and nothing else, since nothing
  else about it is known;
- a required flag (the row's and the payload's error-mode flags) missing
  **after overwrites**: a flag an implicit mask removes only as a consequence of
  another problem (no View, no Send, no Connect) is not listed, because granting
  the first problem's flag brings it back (so a flip control's next-ranked
  failure is real);
- `CommunicationDisabled` when the timeout mask applies and the request needs a
  flag it does not keep, whether or not the bot holds that flag otherwise;
- `ThreadLocked` (a locked thread without ManageThreads, H-036) and
  `ThreadArchived`, only where the row lists the tag.

**A state that cannot decide** (after the M6 verifier). Preflight refreshes
first when the state lacks what the resolver needs or is stale. When even the
refresh leaves it short (the guild or the channel left the state meanwhile:
the bot was removed, the channel deleted, or a gateway event moved it while the
refresh read), `decisionOf` is `Undecidable` with the reason, and:

- an operation (`perform`) sends the request unchecked, logged at Warning:
  Discord decides, and a refusal goes through the error map (a 50013 or 50001
  to the recompute, which finds the state as short and gives the code's own
  tag, `PermissionDeniedUnattributed`, §4.9), so no error is guessed;
- `Permissions.require` fails with `UnknownChannel` (§2.6): it exists to check,
  and it never returns flags it did not check;
- the pins readback (§4.12) cannot tell, and reports nothing degraded, logged at
  Warning.

Degrade-mode payload flags missing from the effective set are reported as
`degraded`, never as failures. (M6: `DecideArgs.extraFlags` carries the
error-mode flags a request needs beyond its row and payload: UseExternalEmojis for
a reaction with another guild's emoji, and the flags `Permissions.require` checks,
which it orders itself: View, Connect in voice, the timeout, Send or SMIT, the
other flags in the order given, then payload flags.) The payload's features are the `PayloadRules`
names it carries (`src/payload/PayloadRules.ts`, whose table and flag lookups
arrive in M3; the payload types and the type-level computations arrive in M6).

**Implementation pattern** (`[sd:src/impl-boundary.ts]`):

- Each public operation is an **overload** whose signature carries the precise
  union, over an implementation typed with the wide union. TS accepts this
  without a cast because the narrow Effect is assignable to the wide one. That
  is the one trusted boundary per operation; three tests guard it.
- **Errors are built only through `errorFor(op, flag, cause)`**
  (`[sd:src/ops.ts]`), an overload whose signature returns
  `OpPermissionErrors[Op][F]` over a wide implementation (rule 7 of §2.12).
  Its constructor table `variantConstructors` is typed
  `{ [V in Variant]: { [F in PermissionFlag]: (cause) => VariantErrors[V][F] } }`,
  so building the base class where the type promises the `...ForReply` variant
  is a compile error (`[sd:probe2/variant-table.ts]`). Revision 1 built the base
  class through `missing[flag]`, the overload accepted it, and at run time the
  error escaped `catchCategory("payload")` while the types said it was caught
  (`[re:variant-runtime.txt]`).
- **`test/unit/op-errors.test.ts`** enumerates every row of `ErrorMap` and
  every outcome `Preflight.decide`/`Recompute` can produce for each operation
  (driven by the replay fixtures), and asserts that the tag is in the row's
  tags, or is `Missing<F>` for F in the row's flags or payload flags, or is a
  payload-derived tag of §2.3. It also asserts, for every (op, flag), that the
  instance `errorFor` builds has the runtime categories (`ErrorCategories`)
  of the class the op's variant promises.
- **`test/types/pass/op-errors.ts`** has one `Equals` per row:
  `Equals<Effect.Error<op(sample)>, OpErrors<never>[Op] | payload/argument terms>`
  (pattern in `[sd:src/channels-use.ts]` §9b).
- The payload half stays honest because `requiredFlags(payload)` comes from
  the same `PayloadRules`. A unit test enumerates every `PayloadRules` key and
  asserts that `requiredFlags(sample)` equals the type-level `PayloadFlags` for
  the same literal sample (`test/types/pass/payload-flags.ts`).

### 4.8 Operation pipeline

Inside `Effect.fn("discord.<area>.<op>")` (§4.13):

1. **Local checks** (basis `payload-check`): `MessageEmpty`,
   `ContentTooLong`, `EmbedTooLarge`, `PollTooLarge`, `NameTooLong`,
   `TopicTooLong`, `SlowmodeOutOfRange`, `NicknameTooLong`, `TimeoutTooLong`,
   `TooManyMessagesToDelete`, `MessagesTooOld` (snowflake age). The values
   come from `Limits.ts`, keyed by (operation, field).
2. **Preflight** (§4.7) unless `Preflight.Mode` is `"bypass"`.
3. **REST call** through `DiscordApi`, with the per-call deadline (§4.10). Files
   go through `rest.withFiles`.
4. **Error mapping** (§4.9). For 50013, 50001, 160002, 160005 and 50083:
   recompute.
5. **Decode and brand** the response (§4.11).
6. **Degradation readback** (§4.12), giving `Sent` or `SentDegradable`.

Recovery happens outside the span: at the call site, or in the handler.

(M5) Steps 3 to 5 are `DiscordApi.execute(request)`. A `Request` carries the
request's `Recompute.Target` (operation row, guild, channel or guild scope,
the handle's granted flags, the static `DecideArgs`, and what the recompute
must read to complete them), the route template and method, the dfx call, the
response schema and the request's `LimitFacts` (§4.9). Steps 1, 2 and 6 stay
in the operations (M6), which share the `Target` with their preflight.

(After the M6 verifier) **The declared route is checked.** A `Request` names its
route (method and template) apart from its dfx `call`, and the span, the causes
and the error map all use the declared route, so a `call` that sends something
else (a `createPin` where an unpin is declared) would pass every check that reads
the declaration. `Request.send` (the one bounded call under `execute`, `read`, the
refresh, the recompute's reads and the harness's raw calls) provides the
declaration as `RouteCheck.DeclaredRoute` around the dfx call, and the bot
build's base `HttpClient` (`RouteCheck.checked`, next to the coded-429
interceptor) requires the request dfx builds to have that method and a path the
template matches, each `{placeholder}` one non-empty segment; anything else is a
defect naming the declared route and the path's shape (segments that are not
lowercase words are shown as `{…}`, since a path segment can be an interaction
token). A request made outside `send` declares nothing and is not checked.
`test/unit/route-check.test.ts`; `test/unit/operations-runtime.test.ts` runs every
operation through a checked client and asserts its method, path (with the query)
and body.

### 4.9 Error mapping and the recompute (D16)

`rest/ErrorMap.ts` is a table keyed by `(operation, status, code)` whose values
are tags. Inner 50035 codes are decoded with the `FieldError` normaliser and
refined by path through `Limits.ts`: `content` → `ContentTooLong`, `embeds.*` →
`EmbedTooLarge`, `poll.*` → `PollTooLarge`, `name` → `NameTooLong`, `topic` →
`TopicTooLong`, `rate_limit_per_user` → `SlowmodeOutOfRange`, `nick` →
`NicknameTooLong`, `communication_disabled_until` → `TimeoutTooLong`. Only paths
listed for the operation map; any other 50035 is a defect. dfx failure shapes
(dfx.md §3):

- `DiscordRestError("ErrorResponse")`: read `e.data.code` (never `e.code`),
  `e.response.status` and `e.data.errors`. Copy `{status, code, message,
  method, route template, fieldErrors}` into `DiscordResponse`. Live
  request/response objects are never retained.
- `HttpClientError`, handled with `Effect.catchReason`:
  - `TransportError` → `NetworkError` with a `NoResponse` cause;
  - `StatusCodeError` with status ≥ 500 → `DiscordUnavailable` with the response;
  - `StatusCodeError` from our coded-429 interceptor → by code (§4.10);
  - `DecodeError` on a 4xx (HTML body) → `DiscordUnavailable`;
  - `DecodeError` on a 2xx, `EncodeError` and `InvalidUrlError` → defect.
- `RatelimitedResponse` → defect (D10).
- **Recompute** (50013, 50001 and the dedicated codes 160002, 160005, 50083):
  `Recompute.attribute(op, handle)` calls `GuildState.refresh`, resolves, and
  runs `Preflight.decide` with the fresh state:
  - a missing flag F that is in the handle's `granted` gives
    `PermissionRevokedSinceCheck { flag: F }`;
  - another missing flag F in the op's requirements gives `errorFor(op, F)`;
  - a timeout gives `CommunicationDisabled`;
  - a hierarchy violation gives the matching hierarchy tag;
  - a state failure gives its tag;
  - nothing found gives the dedicated code's own tag, or for 50013/50001
    `PermissionDeniedUnattributed`.

  The cause is the real `DiscordResponse` with `attributedBy: "recompute"`. A
  missing flag outside the op's requirement list is not attributed (the result
  is Unattributed) and is logged (the recompute logs, at Warning, every flag the
  bot lacks outside the requirements when it finds nothing); the matrix should
  never produce one.

**As built (M5).**

- **The table is `ErrorMap.Codes`: code -> the statuses it comes with and its
  meaning** (recompute with a fallback tag, a state tag, a coded rate limit, an
  empty message, a bulk-delete count, or 50035's fields). Statuses observed by
  the M4 matrix are exact (50013, 50001, 160002 and 160005 with 403; 50083 and
  40067 with 400); the others are the hypotheses of discord-semantics §8.1 and
  §3.1 (20016: a coded 429, or 400 from §3.1; 10014: 404 only). A status outside
  the list is unmapped (H-082).
- **A code maps for a request only to a tag the request declares:** a tag of
  the operation's row, a missing flag of the request's own requirements (160002
  needs ReadMessageHistory among them, so only a reply maps it), or a
  payload- or argument-derived tag the request declares in its `LimitFacts`
  (`empty`, `content` with its length and limit, `embeds`, `poll`, `name`,
  `topic`, `slowmode`, `nick`, `timeout`, `messageCount`; which an operation may
  declare is `ErrorMap.limitFields`, the runtime mirror of §2.3-§2.6). The
  runtime therefore cannot produce a tag the type does not name; anything else
  is `UnmappedDiscordError`, a defect carrying the answer. (Revision 2 described a
  literal `(operation, status, code)` table; deriving the operation part from
  the operation table and the request keeps one source.)
- **50035** maps each inner path: `content` (`message.content` for a forum
  post), `embeds[.i[.title|.description|.fields[.j.name|.j.value]|.footer.text|
  .author.name]]` (the embed limit named by the path; the paths are hypotheses
  until M6's limit rows), `poll.question.text`, `poll.answers[.i.poll_media.text]`,
  `poll.duration`, `name`, `topic`, `rate_limit_per_user`, `nick` and
  `communication_disabled_until`. Every inner error must map; the operation
  fails with the first in tier 7's order.
- **Coded rate limits** need status 429 and `retry_after`; `RateLimited` only
  where the row lists it, and 20016 is unmapped while
  `Observed.slowmodeAppliesToBots` is false. 30034 (command registration) and
  the interaction codes are mapped by their own modules (M8, M9).
- **The recompute's handle is `Recompute.Target`.** Its `completion` says what
  to read beyond the refresh: nothing; for a member operation the target member
  again (10007 adds no hierarchy) and the role from the refreshed roles; for a
  reaction whose emoji state was unknown, the message's reactions. A
  channel-scoped target refreshes with `GuildState.refresh`, a guild-scoped one
  with `GuildState.refreshGuild`. The fallback (nothing found) is built by the
  error map with `attributedBy: "code"`, so a cause says which of the two
  decided the tag. The state-derived arguments (`Preflight.stateArgs`: the
  thread's creator, the hierarchy) are shared with the harness's step (a).

### 4.10 Deadlines and 429s (D9, C9, C10, G2)

- **Deadline.** Every `DiscordApi` call is wrapped in
  `Effect.timeoutOrElse({ duration: requestDeadline, orElse: () =>
  RequestTimedOut })`. `requestDeadline` defaults to 30 s and comes from
  `DiscordApiConfig`. This bounds dfx's unbounded 429 retry loop and slow
  networks.
- **Outcome unknown.** The deadline interrupts an in-flight request. For a
  non-idempotent operation (create, crosspost, bulk delete) Discord may already
  have applied it. `RequestTimedOut`'s documentation and the README say so:
  retrying can duplicate. The library never retries a non-idempotent call.
- **Coded 429 interceptor** (`rest/Coded429.ts`) wraps the **base**
  `HttpClient` handed to dfx (`[cc:src/coded-429-runtime.ts]`).
  - A 429 whose JSON body has a nonzero numeric `code` fails with
    `HttpClientError(StatusCodeError)`. The cause carries the body decoded with
    Schema `{ code: Int, retry_after: Number, global: Boolean }`, so dfx never
    retries it.
  - A 429 without a code, or with code 0, passes through to dfx unchanged. dfx
    reads only the headers of a 429, so consuming the body is safe.
  - Mapping: 20016 gives `SlowmodeActive` if observed, otherwise a defect
    (unmapped); 20028, 20022 and 30046 give `RateLimited` (transient); 30034
    gives `DailyCommandCreateLimit`.
  - `LOG.md` records the interceptor as a dfx deviation, and records that dfx's
    bucket update is skipped for coded 429s.
  - (M5) `BotInternals.layerWith` provides it to the whole bot build, over the
    base client it leaves open, so `SubjectRaw` (the matrix's step (c)) sees a
    coded 429 as a 429 answer with its code instead of a dfx retry.

### 4.11 Response decoding and ID branding (D12)

- `rest/Schemas.ts` decodes every response we expose: Message (including
  `reactions`, for conditional AddReactions), Channel/Thread (`type` 0..16,
  including GuildMedia 16, which dfx lacks), Member, Role and Guild. Only the
  fields we expose are listed; excess fields are ignored. Snowflakes decode
  through the branded schemas, which is the only place IDs are branded.
- A decode failure on a 2xx is a defect annotated with the route template.
- Gateway payloads used by the reducer and the event decoders use the same
  schemas, including `author.bot` (`authorIsBot`) and reaction emoji.
- Interaction payloads (discord-api-types universe) and REST payloads (dfx
  generated universe) both become our types at this boundary (dfx.md §4).

### 4.12 Degradation readback (D35)

**Send.** Compare the request with the **subject's own create response**:

- `mentions.everyone` requested but `mention_everyone: false` gives
  `MentionEveryone`;
- a mentioned role missing from `mention_roles` gives `MentionEveryone` (a
  non-mentionable role without the permission, H-101);
- a custom-emoji token `<:name:id>` from the request that the response content
  no longer contains gives `UseExternalEmojis` (H-104). The live failing case
  needs a second guild, so this rule is resolver-only live (§5.5);
- any other `mode: "degrade"` rule whose effect is absent from the response is
  listed.

**Reads.** A list operation that returns empty while ReadMessageHistory is
missing reports `degraded: ["ReadMessageHistory"]` (H-107). (After the M6
verifier) The readback resolves the channel as preflight does; a `Transient`
from its refresh fails the list (M6 had dropped it and reported nothing
degraded), and a state that cannot decide reports nothing degraded (§4.7).

Harness REST reads are used only for fields not gated by the content toggle,
unless startup confirmed the harness has the Message Content flag. The
orchestrator sets that flag, and §4.4 reads it back.

### 4.13 Spans (D28, C13)

- Every public operation is an `Effect.fn("discord.<area>.<op>")`, for example
  `discord.channel.send`, with attributes: `discord.route` (template),
  `discord.channel_kind`, `discord.guild_id`, and `discord.required_flags`
  (sorted names).
- No pipeable recovery is passed to `Effect.fn`, because those run inside the
  span (effect-v4 §9). Callers recover outside.
- Event handlers run in `discord.event.<NAME>` spans, and interactions in
  `discord.interaction.<kind>.<name>` spans.
- Tokens never reach spans: the route is a template, and interaction tokens
  stay out of attributes.
- A recording-tracer unit test asserts that an operation span is marked failed
  even when the caller catches the error.
- (M5) `DiscordApi.execute` runs in a child span `discord.rest` with
  `discord.route`, `discord.method`, `discord.operation`, `discord.guild_id`
  and `discord.channel_id`; the operation's span (M6) carries §4.13's
  attributes. Effect's HTTP client opens its own span below (`POST`), with
  `url.full` and the Authorization header redacted. Bot routes carry only IDs,
  but an interaction webhook URL carries the interaction token in its path, so
  M9 must keep those requests out of the HTTP client's span attributes (for
  example with `HttpClient.TracerDisabledWhen`). (As built after the M9
  verifier, which found the token in `url.full` and `url.path`: `DiscordApi.sendJson`,
  through which every interaction call goes, provides `HttpClient.TracerDisabledWhen`
  for its requests, so the client opens no span for them, and raises the minimum
  log level to Info for them, because dfx logs a 403's or 429's URL, and a route
  key holding the token, at Debug. `interactions-runner.test.ts` records every span
  and every Debug line of a callback, a `PATCH @original` and a refused follow-up
  and asserts none holds the token.)

### 4.14 Per-event fibers (D29) and interactions runtime

**Events.**

- `Bot.on(name, handler)` registers via dfx `handleDispatch(name, wrapped)`.
  (M7: on the build's own dispatch stream instead, `gateway/Dispatches.ts`: the
  `DispatchHook` publishes every dispatch to it after the reducer, so a handler
  sees a state that includes its event, and `subscribe` takes its subscription in
  the caller's fiber before it returns. dfx's `handleDispatch` subscribes inside a
  forked fiber, so a dispatch right after `bot.on(...)` returned was lost: the
  first unit test of `bot.on` dropped its first event.)
- `wrapped` decodes the event, builds handles, and runs
  `handler(event).pipe(Effect.scoped, Effect.withSpan(...), Effect.catchCause(report))`.
  `Effect.scoped` gives each event its own scope, so a handler's finalizers run
  when that event finishes, not at bot shutdown (`[re:runtime-races.txt]` 3).
  It can never fail, so `handleDispatch` never stops (dfx.md §4). (M7: each
  matching dispatch is forked in the subscriber's scope.)
- `report` logs unhandled transient errors at Warning with the tag, and defects
  at Error. The span records the failure.
- Handlers run concurrently and unordered (dfx semantics, documented in the
  README).
- A unit test asserts finalizers run per event, and another that a failing
  handler does not stop later events.

**Interactions** (`interactions/Runner.ts`, phase 3):

- **Routing.** INTERACTION_CREATE is routed by kind:
  - commands by `(type, name)`;
  - components and modals by the route prefix of `custom_id`;
  - autocomplete by command name.
- **Auto-defer never interrupts the handler.** The runner forks the handler
  and waits with `Fiber.join(fiber).pipe(Effect.timeoutOption("2500 millis"))`
  through `Clock`, so `TestClock` controls it. If the handler finishes first, its
  response is the initial response. Otherwise the runner posts the mode's
  deferral and joins the fiber again. Revision 1 raced the handler against a
  sleep, which interrupted the handler, so its reply never happened
  (`[re:runtime-races.txt]` 2).
- **Delivery after a deferral** follows the mode:
  - `"public"`/`"ephemeral"` posted DEFERRED_CHANNEL_MESSAGE (5) with the
    mode's flag; a later `reply` is delivered as `PATCH .../messages/@original`
    (the deferred message), with the same ephemeral state (H-227, H-228);
  - `"update"` posted DEFERRED_UPDATE_MESSAGE (6); only `update` is offered, and
    it is delivered as `PATCH .../messages/@original`, which edits the message
    that carries the component, which is what an update means;
  - `"manual"` posts nothing; a handler slower than 3 s fails with
    `InteractionExpired`, logged by the runner.
- **Posting** uses `createInteractionResponse`, then runs the continuation with
  a 14-minute deadline. A continuation ending in `giveUp` is logged at Info.
- **Interaction preflight** uses `app_permissions`.
- **Registration** (D18): canonicalise local definitions to Discord JSON, `GET`
  the guild's commands, canonicalise them by dropping and normalising the server
  defaults listed in `Canonical.ts` (from `fixtures/commands-canonical.json`),
  and compare. A `PUT` is sent only when they differ. After any write, `GET`
  again and require the canonical remote set to equal the local set. Guild
  scope only (Perms Lab), never global. (M8, as built: both requests go through
  `rest.httpClient`, `Request.sendJson`, because dfx's `ChannelTypes` lacks GuildMedia 16;
  the canonical form drops the server-assigned `id`, `application_id`, `guild_id` and
  `version`, drops `default_member_permissions: null`, `nsfw: false` and an option's
  `required: false` only at exactly those values (the recording's defaults; before M9 the
  recording's fourth sample added an option's `autocomplete: false`, `choices: []` and
  `channel_types: []`, which Discord drops too), sorts
  `channel_types` (a set: Discord stored `[5, 0, 11]` as `[0, 11, 5]`), and keeps any
  other field, so a field Discord stores that the tables do not name forces a write and
  then fails the check after it, a defect naming the field. 50035 and 30032 are
  `command-rejected`, 30034 `daily-command-limit` (400 or a coded 429), a transient
  failure `discord-unavailable`, 401 `invalid-token`; anything else is an unmapped
  defect.)
- The `checklist` command posts the phase-3 prompts. It is registered and
  tested offline only. (After the M9 verifier, which found that a sitting could
  never finish: every one of its twelve items has a verdict pair, under its answer
  or, for autocomplete and the expired control, whose answers carry no buttons, on
  its own prompt's message; the update and slow-update prompts each have a message
  of their own, because an update replaces its message's components; and
  `harness/main.ts checklist` converges the lab to the rule rows' `text-messages`
  setup first and resets it after (also when the sitting fails or is
  interrupted), so the subject sees #lab-text and the DM absence check's canary,
  a message there, can reach it. `checklist.test.ts` drives a whole simulated
  sitting, clicking every button a human would see, to `ChecklistRun.isDone`.)
- (M9, as built in `interactions/Runner.ts`.) Each registration subscribes to INTERACTION_CREATE on the build's own
  dispatch stream (`Dispatches.DispatchName` adds INTERACTION_CREATE, which needs no intent, beside `bot.on`'s events),
  as `bot.on` does, so a command or route is registered once; each interaction runs in its own fiber and scope, in a
  `discord.interaction.<kind>` span applied before any recovery. The runner waits with `Fiber.await(fiber).pipe(
  Effect.timeoutOption(2500 millis))` (an await, so the timeout never interrupts the handler) and logs a handler's
  transient failure, a defect, an invocation that does not fit the command's definition (`Wire.Malformed`: every
  required option, each value of its option's type, the choices and channel kinds checked) and a refused post; none
  escapes. The callback and the webhook calls go through `DiscordApi.sendJson` (bounded, under the declared route, in a
  `discord.rest` span whose route template hides the token, with no HTTP client span and no Debug line of dfx's, §4.13); 10062, 10015 and 50027 are `InteractionExpired`, 50006
  `MessageEmpty`, anything else an unmapped defect. `harness/main.ts checklist` runs the checklist for Rhys (LOG.md).

### 4.15 Obfuscation codec (D20, G7)

- `gateway/Codec.ts` replaces `DiscordWSCodec` with a JSON codec that adds
  `capabilities: 32768` to Identify (op 2) and leaves other opcodes unchanged
  (`[cc:src/capabilities-codec.ts]`). It also records the intents bitfield it
  encoded, for the identity check (§4.4). (After the M7 verifier: the record, intents
  and capabilities, is read back from the encoded text the socket receives,
  `Codec.identifiedIn`.)
- `DiscordLiveWithCapabilities` is dfx's 8-line `DiscordLive` composition with
  this codec (compiled in cross-check). `LOG.md` records the deviation.
- The truth-table header records `obfuscation: "codec"`.
- Live check: a scenario denies View on `lab-text`, and the subject's state
  must show `obfuscated: true` (H-160). If it does not, the run fails with "the
  gateway ignored capabilities". (After the M7 verifier: the wait is the check. Under
  the codec it requires every hidden lab channel but the category to be obfuscated,
  and resends one still shown with its real overwrites (§5.10 step 3); a resent channel
  Discord then sends again, its generation moved, and still unobfuscated fails the run
  with `Wait.CapabilitiesIgnored`, whose message is "the gateway ignored capabilities".
  One Discord sends nothing for is a late or lost event, a `setup-timeout`. M7's
  `Runner.obfuscationProblem` ran after the wait had already required obfuscation, so it
  could never fire.)
- (M7) The replay rebuilds the subject's state as the codec makes it
  (`Predict.snapshotOf`): a lab channel the subject cannot view is obfuscated with no
  overwrites. Its consequence for the catalog: a timed-out row that hides View is
  now blind (the obfuscated channel hides the timeout from preflight), so its
  ViewChannel flip is no longer clean, and those keys take a derived coverage row
  instead (§5.9).

---

## 5. Verification architecture

### 5.1 Commands

Milestone 0 adds these scripts to `package.json`. All `bun` scripts use
`--no-env-file`.

| Script | Command | Discord? |
|---|---|---|
| `typecheck` | `tsc -p . --pretty false` | no |
| `test` | `vitest run` (Node; `envDir: test/env`) | no |
| `test:types` | `bun --no-env-file scripts/type-tests.ts` (`-- --update` rewrites snapshots) | no |
| `hover` | `bun --no-env-file scripts/hover.ts` (`-- --update`) | no |
| `budget` | `bun --no-env-file scripts/budget.ts` (`-- --update`) | no |
| `rules` | `bun --no-env-file scripts/rules-check.ts` | no |
| `gen:errors` | `bun --no-env-file scripts/gen-errors.ts` (`-- --check`) | no |
| `verify:offline` | `bun --no-env-file scripts/verify-offline.ts` | no |
| `harness:reset` | `bun --no-env-file harness/main.ts reset` | yes |
| `harness:smoke` | `bun --no-env-file harness/main.ts smoke` | yes |
| `harness:selftest` | `bun --no-env-file harness/main.ts selftest` (the reset self-test, §5.7) | yes |
| `verify:live` | `bun --no-env-file harness/main.ts run --write --compare` | yes |

`verify:offline` runs, in order, failing on the first failure and never passing
`--update`:

1. `gen:errors -- --check`
2. `typecheck`
3. `test` (unit tests, offline truth-table replay, D6 invariant, span test,
   identity test, op-errors test, per-event scope test)
4. `test:types`
5. `hover`
6. `rules`
7. `budget`

A step whose script a later milestone writes (only `gen:errors`, before M1) is
printed as "not built yet" by name in the summary; every other step must run
and pass.

`verify:live`:

1. acquires the lock;
2. runs the startup checks and the identity checks (§4.4) for all identities;
3. runs reset, then provision;
4. runs the full catalog serially;
5. writes `fixtures/truth-table.json` canonically;
6. prints scenarios, mismatches, invalid requests, duration, escalated rules,
   and whether the result is identical to the committed file.

It exits 0 only with zero mismatches. With `--compare` it also exits non-zero
when the new table differs from the committed one, which a **previous process**
wrote; that is the determinism gate (§5.12), and a missing previous table fails
it too. `--repeat 2` runs the matrix twice in one process with a reset between,
a quick in-process check only. `--only <glob>` runs a subset and never writes
`fixtures/truth-table.json`: with `--write` it writes the subset's table to
`/tmp/effect-discord-perms-truth-table.only-<glob slug>.json`, and with
`--compare` it compares with that file, which a previous `--only` process with
the same glob wrote (M3's exit runs `--only 'send/**'` twice this way).

### 5.2 Type-test runner and diagnostic snapshots (D30, D2 with changes)

The runner is `[type-testing scripts/type-tests.ts]`, adapted; its gate is
prototyped in `[sd:check-fail.ts]`:

- One `tsc -p test/types/tsconfig.json --pretty false --listFiles` per run. Every pass and fail fixture must
  be in the program it lists, so a fixture the tsconfig drops fails instead of passing silently.
- The root tsconfig excludes `test/types/fail`, and `test/types/tsconfig.json`
  sets `"exclude": []`.
- Pass fixtures use `expectTypeOf` or `Equals` and must have no diagnostics.
- Fail fixtures use `// @expect-error TS<code> <mention>` directives. A
  directive owns the diagnostics up to the next directive or `// @valid`.
  Consecutive directive lines form one block and match that many diagnostics in
  order (a select next to a button marks both elements).
- Every fail fixture has at least one `// @valid` block that must produce no
  diagnostic: the **pass twin**, in the same program and with the same imports,
  which proves the fixture's setup is sound. A `@valid` block with no code line before the next
  directive is rejected.
- Snapshots live in a sibling `<fixture>.diagnostics.txt`:

  ```
  L<line>:<col> TS<code>
  <head line>
    <chain lines, indentation as printed>

  ```

- Snapshots are exactly as tsc printed them: default truncation, no
  `--noErrorTruncation`, no `--locale`.

**Readability gate.** A fixture fails unless every one of its diagnostics:

1. has the directive's TS code;
2. has at most **4 lines**;
3. has at most **800 characters after collapsing unions**. Every run of two or
   more plain names or string literals joined by ` | ` counts as one token; the
   regex is in `[sd:check-fail.ts]`. The raw text is still snapshotted
   verbatim;
4. contains its directive's mention;
5. contains none of: `exactOptionalPropertyTypes`, `parameter of type
   'never'`, `type 'never'.`, `/Expected \d+(-\d+)? arguments/`, and a
   truncation marker `... N more ...` **inside a message-carrying type**
   (`UnhandledErrors<...>`, `Invalid<...>`);
6. does not have a "wrong reason" code: TS2304, TS2305, TS2307, TS2552,
   TS2614, TS2724 (unresolved names and imports) are rejected whatever the
   directive says. A fixture that forgot an import used to pass on
   `Cannot find name 'UserId'` (`[re:gate-output.txt]`); the prototype gate now
   rejects it (`FAIL wrong-reason code TS2304`).

The runner's other failure modes are type-testing §6's nine, unchanged.

On the design fixtures: 64 diagnostics, all pass; the largest gated size is
534 characters (`[sd:fail-diagnostics.txt]`).

### 5.3 Hover snapshots (D31)

- `scripts/hover.ts` generalises `[cc:lsp-hover.ts]`. It spawns
  `node_modules/@typescript/typescript-<platform>-<arch>/lib/tsc --lsp --stdio`
  (`typescript-linux-x64` on minisforum; resolved as `typescript/lib/getExePath.js`
  does), opens
  each `test/hover/*.ts`, and sends `textDocument/hover` at every `//  ^?`
  marker.
- It writes `<file>.hover.txt`: one block per marker, holding the source line
  and the plaintext `value`, with the `const x: ` prefix kept.
- Checks: the snapshot matches, and each marker's expectation comment holds.
  The comment has the form `//  ^? names: A, B; no-object` and requires that
  each name is present and that no `{` appears in the **error** type argument.
- Hover is read for: send results (literal, dynamic, widened), the union
  receiver, `require`, a pin, the options of a command with choices and a
  channel option, **the command value**, **`ix`**, `event.message`,
  `event.channel`, and a registration. Design values (`[sd:hover.txt]`):

```
const banCommand: ChatInputCommand<"ban", { readonly options: { readonly days?: number; readonly log?: AnnouncementChannel<never> | TextChannel<never>; readonly reason?: "abuse" | "spam"; readonly user: ResolvedUser; }; }>
const i: CommandInteraction<{ readonly options: { ...the same four keys... }; }, "public">
const reg: Effect.Effect<void, never, BotRuntime | Scope.Scope>
const ch: MessageChannel
```

  (Objects are printed over several lines in the snapshot.) Revision 1
  hovered `ix` and the command as the full option tuple, 26 lines for a
  3-option command (`[rt:hover-output.txt]`).

### 5.4 Compile budget (D33)

- `scripts/budget.ts` follows type-testing §7. It runs `tsc -p
  examples/reference-bot/tsconfig.json --extendedDiagnostics --checkers 1
  --pretty false` five times, requires identical Types and Instantiations,
  takes the median check time, and compares with `budget.json`.
- Hard ceilings, never raised: Instantiations 250,000, Types 60,000, check
  1,000 ms.
- Regression gates against the baseline: Types and Instantiations +2%; check
  time at most 1.5 × baseline + 25 ms.
- **Per-command row.** `budget.json` also records the cost of one
  25-option command with a handler, measured as the difference between two
  fixed probe projects (20 such commands and none). A regression of more than
  2% fails, so the reference bot's headroom cannot hide superlinear growth.
  The probes are `examples/command-probe/tsconfig.none.json` and
  `examples/command-probe/tsconfig.commands.json` (written in M8 with the
  command API); the baseline stores their difference as totals.
- The baseline is `examples/reference-bot/budget.json`, with one optional entry
  per row. A row whose projects exist without a baseline entry, or the reverse,
  fails. Before either row exists (M0-M7) the script prints "nothing to measure
  yet" and passes.
- The baseline must name TypeScript 7.0.2.
- Design measurements (`[sd:budget.txt]`, identical across runs):

| Project | Types | Instantiations | Check |
|---|---|---|---|
| the example bot (`tsconfig.example.json`) | 34,652 | 127,463 | about 0.13 s |
| the error module alone | 25,994 | 106,218 | about 0.09 s |
| the whole design scratch | 44,977 | 169,714 | about 0.18 s |
| commands probe base (no commands) | 31,622 | 117,714 | about 0.12 s |
| 20 commands × 10 options | 35,950 | 140,814 | about 0.15 s |
| 20 commands × 25 options | 39,350 | 160,749 | about 0.17 s |

  One 10-option command costs about 1.2k instantiations and one 25-option
  command about 2.2k, close to linear. Revision 1's 20 × 25 probe cost 227,674
  (`[rt:budget/results.txt]`).
- M10 records the reference-bot baseline once that bot exists.
- (M10, after the M10 verifier) **The reference bot is measured as a consumer of this package compiles it.** The bot
  imports the package by name (`effect-discord-perms`), which the package's own `exports` (`"."` is `src/index.ts`)
  resolve to the source, so its project checks the library's implementation with the bot, as the design's
  example-bot measurement above did with the prototype's. `scripts/budget.ts` fails unless every import of the
  package resolves to that entry point (`tsc --traceResolution`; after the second M10 verifier, in place of a check
  that the program merely contained it), so a private `paths` mapping cannot change what is measured. Measured first
  at **76,573 types and 275,255 instantiations**, above the Types and Instantiations ceilings; the ceilings stayed.
- (M10, after the second M10 verifier) **The library's compile cost was cut, without changing a type a user sees,
  to 59,620 types, 178,499 instantiations and about 245 ms**, within all three ceilings (60,000; 250,000; 1,000 ms),
  so `bun run budget` passes against the re-baselined row. The cuts are §2.12 rule 10 and §2.2's `CategorizedError`:
  the error classes typed as one schema class each (8,078 types), the operation implementations' `Wide` error types
  (2,319), explicit type arguments where a generic call returns into a large union (3,477), `Extract`'s operands
  swapped (1,257), shared aliases for the payload-derived terms (about 1,000) and one shared send overload (about
  300). The hover snapshots and the fail fixtures' diagnostics are unchanged. The margin under the Types ceiling is
  thin (380 types): the next growth of the library's types will meet it, and the regression gates (+2%) are looser
  than that margin. (Final cleanup, measured, LOG.md: a sixth one-option command with a handler, one new four-option
  command with a button route, or four more error classes in the library cross it; the sixth command also crosses
  the +2% Instantiations gate, which binds before the 250,000 ceiling.) (After the final audit, measured on the
  committed baseline, which was not re-written: the message methods' shared `this`-generic types saved about 1,200
  types, and the audit's new checks spent most of it, so the bot is at 59,455 types and 178,553 instantiations, 545
  types under the ceiling; the per-command probe is at 44,086 instantiations, 23 under its +2% gate of 44,109.)
- (M10, reverted) M10 first compiled the bot against declarations emitted into a git-ignored directory, mapped with
  `paths` (12,541 types, 28,926 instantiations), and gated the library's own check by regression only. No consumer
  of this package gets those declarations (nothing builds or ships them), so that measured less than any user pays,
  and it loosened the budget. Shipping declarations stays a possible later change for the package; the budget does
  not need it. The per-command row's baseline is unchanged (M9's 7,624 and 43,245; M9's verifier moved the measured
  cost to 7,636 and 43,296, and M10's cuts to 7,636 and 43,302, within it).
- (M8) The per-command row's baseline is committed: 20 commands of 25 options cost 7,245 types and
  42,102 instantiations over the probe without commands (362.3 types and 2,105.1 instantiations a
  command, against the design's estimate of about 2.2k). Until M9 a probe command's handler is a
  function of its invocation that reads its options; M9 re-baselines it with `Interactions.command`.
- (M9) Re-baselined deliberately with each command's handler registered by `Interactions.command` (and both probes
  importing `Interactions`): 7,624 types and 43,245 instantiations for the 20 commands, 381.2 types and 2,162.3
  instantiations a command. Importing the runtime modules raises the probes' base from about 31.5k types to 64.8k;
  importing `Bot` alone gives 66.9k, above the reference bot's 60,000-type ceiling, which M10 must face (LOG.md).

### 5.5 Rule registry (G10; `[sd:src/verify.ts]`)

```ts
interface LivePair {
  readonly kind: "pair"
  readonly setup: string                                     // both sides run on this byte-identical Setup
  readonly valid: { readonly scenario: string; readonly expect: Observation }
  readonly invalid: { readonly scenario: string; readonly expect: Observation }
}
type NotLive =
  | { readonly kind: "not-live"; readonly reason: "phase-3-offline" | "needs-second-guild" | "forbidden-action" | "pure-typing" }
  | { readonly kind: "escalated"; readonly question: `Q-${number}` }
export interface Rule { readonly id: `R-${string}`; readonly statement: string
  readonly pass: `test/types/pass/${string}.ts`; readonly fail: `test/types/fail/${string}.ts`
  readonly claims: readonly [string, ...Array<string>]       // directive mentions in `fail` this rule claims (M0)
  readonly live: LivePair | NotLive; readonly remainder?: NotLive }
// Observation = Rejected{status, code, inner: [{path, code}]} | Ignored{field} | Applied{field} | Writes{count}
//             | EventAbsent{event, canary} | EventDelivered{event} | Succeeded
```

An expectation is a **full** observation: status, code, and the sorted inner
50035 codes **with their paths**. A rejection for a different reason (a 50013
from a wrong permission setup, a 10003 from a materialisation bug, a 50035 on
another field) does not satisfy it. Both sides of a pair run on a
byte-identical Setup, which rules-check asserts.

`scripts/rules-check.ts` fails if any of these does not hold:

- a rule's pass or fail file is missing, or one of its `claims` is not the
  mention of a directive in its fail file, or does not appear in that file's
  snapshot;
- **a fail-fixture directive is not claimed by any rule** (a rule claims a
  directive when the directive is in the rule's `fail` file and its mention is
  in the rule's `claims`; several rules share one fixture file), so every type
  restriction (operation absence, announcement threads public only, bulk delete
  needs 2) needs a registry entry;
- a `pair` scenario ID is missing from `harness/scenario/catalog/rules.ts`;
- a `pair` row is missing from `fixtures/truth-table.json`, or its recorded
  `observation` differs from the expectation in any field, or the two sides'
  setups differ;
- a `not-live` entry is not in the fixed allowlist of (rule id, reason) pairs:
  `phase-3-offline` only for interaction rules (the orchestrator's decision),
  `needs-second-guild` only for the external emoji and external sticker rules
  (the orchestrator's decision), `forbidden-action` only for the @everyone
  valid side and successful kick or ban (PROMPT forbids both), `pure-typing`
  only for catch narrowing, the handler boundary, require narrowing and
  transient-only escape;
- an `escalated` entry's question is not in §8 or has no `LOG.md` "Waiting for
  Rhys" line. `verify:live` prints escalated rules as **unmet Done criteria**,
  never as passes;
- **flag coverage**: for each (operation row, flag), and each payload rule's
  flag, there is a live row where the flag is granted and one where it is the
  first missing flag, and a flip-control sibling (§5.9). Kick and ban flips are
  `forbidden-action`; (M6, as built in `scripts/lib/rules.ts`: "first missing"
  means preflight's first failure on a row Discord refused; a degrade-mode
  payload flag instead needs a row that holds it with the feature kept and one
  where Discord dropped the feature, since a dropped feature is no failure to
  flip; the fixed exemptions are `permissions.require` (it sends no request),
  `dm.send` (no flag, and no DM row is possible), the external sticker and emoji
  rules (`needs-second-guild`), and the granted side of `@everyone`
  (`forbidden-action`). The families leave some pairs without a first-failure
  row; `catalog/coverage.ts` derives one for each, §5.9;)
- **events**: every event in `EventIntents` has a live intent pair; (M7, as built in
  `scripts/lib/rules.ts` `eventProblems`: for each event that needs an intent, a rule whose valid side
  expects `EventDelivered { event }` from a session that declared one of its intents, and whose invalid side
  expects `EventAbsent { event, canary }`, with a canary, from a session that declared none of them; the
  pair's rows are the live-pair checks')
- a non-`pure-typing` rule lacks a `LOG.md` line.

(M7) A `pair` may list `also`: further sides on the same setup that the rule's valid case covers, each with its
own full expectation, checked like the two (catalog, table row, observation, one setup).
`R-message-content` uses it for the mention, ping-on reply and own-message exceptions. (M8: any further side of the
rule, valid or invalid: the command rules' nested registrations and nested raw sides, and the registration diff's
further mutations.)

Staging: M0's rules-check implements every check whose inputs exist. A `pair`
rule fails closed ("cannot verify yet") until the catalog and truth-table
checks are added (M6 adds them, with the flag-coverage check); M7 adds the
events check. Until then rules-check prints those checks as "not checked yet".

The registry (`test/rules.ts`). IDs use the `R-` prefix; "raw" means through
`SubjectRaw` with dfx's loose types.

(M6: the table below is revision 2's plan; the registry holds what the live pairs
observed, each side's full expectation. Every pair runs on one named setup of
`harness/scenario/catalog/rules.ts`, `rule/<setup>/<probe>`. Where a row says
"with flag / without", the pair keeps the flag absent on both sides and varies
what is sent, because both sides must share a byte-identical setup: the plain
send succeeds, the payload carrying the feature is refused; deleting one's own
message succeeds where another's is refused. Observed codes that differ from the
plan: a forum refuses a message with 400 50008 (not 40058), a crosspost in a text
channel 403 50001, a bulk delete of one ID 400 50035 on `messages`, a select next
to a button `COMPONENT_LAYOUT_WIDTH_EXCEEDED` on the second element. The voice
and forum halves of no-threads-on-voice-forum are two rules,
`R-no-threads-on-voice` and `R-forum-threads-need-a-message`, and the edit-field
restriction is `R-no-topic-on-voice`.)

| Rule | Live pair (valid / invalid, full expectation), or reason |
|---|---|
| ids-distinct | send with ChannelId: Succeeded / raw send with a UserId as channel: Rejected 404 10003 |
| no-send-category, no-send-forum | send in text / raw POST to category: Rejected (H-151); createPost / raw POST messages to forum: Rejected 40058 |
| crosspost-announcement-only | crosspost in announcement / raw crosspost in text: Rejected (H-085) |
| thread-ops-threads-only | join thread / raw join on text: Rejected |
| no-threads-on-voice-forum | createThread on text / raw POST threads on voice: Rejected |
| announcement-public-threads-only | public thread in announcement / raw private thread in announcement: Rejected (H-041) |
| bulk-delete-at-least-2 | bulkDelete of 2 / raw bulk delete of 1: Rejected 50016 |
| edit-own-only | edit own / raw edit of target's message: Rejected 50005 |
| delete-foreign-manage | delete foreign with ManageMessages / without: Rejected 50013 |
| payload-embeds, -files, -tts, -poll, -reply-rmh, -thread-smit | with flag / without: Rejected 50013 (or Ignored `<field>`, if `PayloadRules.mode` turns out `degrade`) |
| payload-guild-sticker | guild sticker: Succeeded / raw send with a nonexistent sticker ID: Rejected 50081 |
| payload-external-sticker, payload-external-emoji | needs-second-guild |
| mention-everyone-degrades | positive control on `lab-unmentionable` (not mentionable, held only by the target): with MentionEveryone, `mention_roles` contains it (Applied) / without, it is absent (Ignored, H-101); remainder: the @everyone valid side is forbidden-action (it would ping Rhys) |
| nonempty | content / raw `{}`: Rejected 50006 |
| cv2-excludes | CV2 with text display / raw CV2 + content: Rejected 50035 with the `content` path |
| row-5-buttons, select-alone, link-no-custom-id | 5 buttons / raw 6; select alone / raw select + button; link / raw link + custom_id: Rejected 50035 with the component path |
| premium-no-label | differential: raw premium button with fake SKU, with and without label; the invalid case's field errors include a `label` path and the valid case's do not (open question 6) |
| allowed-mentions-none | typed send `<@target>`: `mentions` empty / raw send without allowed_mentions: Applied `mentions` |
| create-flags-only | create with SuppressNotifications: flag set / raw create with EPHEMERAL: Ignored `flags` |
| suppress-notifications-create-only | create with it / raw edit with it: Ignored `flags` |
| content-length, embed-limits, poll-limits, name-length, topic-length, slowmode-range, nickname-length, timeout-28-days | exactly the limit from `Limits` / raw one over: Rejected 50035 with the field's path |
| custom-id-routing | send a component whose custom_id a route built at 100 characters, read `custom_id` back from the create response, and decode it with the route: Succeeded / raw component with 101 characters: Rejected 50035 with the `custom_id` path; remainder: handler delivery escalated (Q-18) |
| intent-guilds, -guild-messages, -guild-members, -reactions, -typing | session with intent: EventDelivered / without: EventAbsent with a canary (§5.10) |
| message-content | with the intent: content filled / without: a target's plain message has empty content (Ignored); the mention, ping-on reply and own exceptions are filled; remainder: the DM exception is escalated (Q-17) |

(M7, as built: the five intent rules are `R-intent-guilds` (CHANNEL_UPDATE, canary GUILD_MEMBER_UPDATE about the
subject), `R-intent-guild-messages` (MESSAGE_CREATE), `R-intent-guild-members` (GUILD_MEMBER_UPDATE about the
target), `R-intent-reactions` (MESSAGE_REACTION_ADD) and `R-intent-typing` (TYPING_START), the last four with the
canary CHANNEL_UPDATE; `R-message-content` is `Applied`/`Ignored` `content`, with the three exceptions as `also`
sides; all sixteen sides are `rule/text-messages/session-*` rows. `R-handler-boundary` and
`R-transient-only-escapes` are pure-typing, on `test/types/fail/bot.ts`.)
| command-name-lowercase, -name-length, -name-spaces, option-order, option-count, option-name-lowercase, subcommand-nesting, subcommand-mixing (each at top level and nested) | typed registration / raw registration: Rejected 50035 with the field path (single command name, H-205) |
| options-typed | register a command with choices, a required option and channel_types; GET it back and compare the stored JSON with the definition as written (before M9: choices, required flags and channel types as a set, never through the canonicaliser, whose equality the sync's check after writing already requires): Applied / raw registration with a choice value of the wrong type: Rejected 50035; remainder: delivered option values escalated (Q-18) |
| registration-diff | sync identical: Writes 0 / after each mutated definition: Writes 1, counted at the base HttpClient (§5.10). (Before M9, the M8 verifier: live, each mutation row syncs over the previous row's definition, which differs from it in one or more fields, so the live rows show one write per changed definition; that each single canonical field is detected is held offline, `test/unit/registration.test.ts`'s eleven mutations and `test/unit/canonical.test.ts`'s every leaf of the recording.) |

(M8, as built: eleven rules on `catalog/rules.ts`'s `commands` setup (`text-send`'s role state, so no role edit), all
sides `rule/commands/<probe>` run by `harness/CommandProbes.ts` and, for the two route probes, `harness/Probes.ts`. The
name, option and nesting rules are `R-command-name-lowercase`, `R-command-name-spaces`, `R-command-name-length`,
`R-option-name-lowercase`, `R-option-order`, `R-option-count`, `R-subcommand-nesting` and `R-subcommand-mixing`: the
valid side is the library's sync of a top-level command at the limits (32-character name, 25 options, required first),
the nested level an `also` side (24 subcommands and a group of 25, one with a 32-character name and 25 options), and the
raw sides POST the forbidden definition at the top level and nested, as further `also` sides (§5.5's `also` now holds
any further side of the rule). Discord refused every raw side with 400 50035; the codes it gave are the registry's
expectations: `APPLICATION_COMMAND_INVALID_NAME` for uppercase, `STRING_TYPE_REGEX` for a space,
`BASE_TYPE_BAD_LENGTH` for 33 characters, `APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID` on the required option after
an optional one, `BASE_TYPE_MAX_LENGTH` on `options` past 25, `UNION_TYPE_CHOICES` for a group in a group or a
subcommand and for a value option in a group, `APPLICATION_COMMAND_OPTIONS_TYPE_INVALID` for a subcommand after a value
option at the top level (H-197 confirmed). `R-options-typed` is `Applied options` (the stored choices, required options
and channel types equal the definition's; before M9 compared field by field with the definition as written,
`CommandProbes.storedAsDefined`, not canonically; after the M9 verifier its channel numbers are discord-api-types'
`ChannelType`, not the library's `Snapshot.channelTypes` that the definition is written with) against a string choice with a number value
(`STRING_TYPE_CONVERT`); `R-registration-diff` is `Writes 0` for the identical sync against `Writes 1` for six mutations
(description, then as `also` the name, channel types, choices, an option's name and an option's required), counted at
the base client less its 429s; `R-custom-id-routing` is an ID built at 100 characters, stored and read back through the
harness and decoded to the same data, against 101 (`BASE_TYPE_BAD_LENGTH` on the button's `custom_id`). The last two
rules' handler side is escalated (Q-18). Only `R-registration-diff`'s fail directive is a type rule of its own: a
forged command literal is no `ChatInputCommand`, so only built, checked definitions are registered. Before M9 (the M8
verifier): the name rules' live sides are the command's and a subcommand's name; a group's own name (uppercase, a space,
33 characters) has its own fail directives, which the rules claim, and `R-registration-diff` also claims the fail
directive of `commands` without a `guildId`.)
| must-respond, modal-before-answer, followup-after-answer, autocomplete-choices, no-modal-from-modal, deferred-must-complete, ephemeral-matches-mode, reply-nonempty | phase-3-offline |

(M9, as built: the eight are `R-<name>` in `test/rules.ts`, on `test/types/{pass,fail}/interactions.ts`. Each fail
directive is claimed by one: `R-modal-before-answer` also claims that `ix` stays typed under `Effect.fn` (an unknown
member), `R-must-respond` a forged response literal, `R-deferred-must-complete` a forged completion,
`R-ephemeral-matches-mode` a deferral's ephemeral state and "update" offering only `update` and `deferUpdate`, and
`R-reply-nonempty` an unhandled dynamic reply's limits.)
| handler-boundary, catch-tag-exact, catch-category-exact, require-narrows, transient-only-escapes | pure-typing |

### 5.6 Live harness: identities, safety and the lock

- **Identities** (§4.2): `HarnessRest` (Administrator, top role), `TargetRest`,
  and the subject (the library's `BotRuntime` plus `SubjectRaw` from the same
  build). All share one paced `HttpClient` (§5.11). The identity checks of
  §4.4 run first.
- **Lab guard** (`harness/Lab.ts`) wraps **every** identity's writes: the
  harness's narrow `Lab` interface, `TargetRest`, `SubjectRaw`, and the
  library's member operations when the subject runs them in steps (b) and (d).
  It runs in the shared base `HttpClient`, below every identity's dfx stack
  (M2), so no identity can bypass it; the "narrow interface" is a route
  allowlist: a write is sent only if its route is one the lab needs and its
  target is an admitted lab object. Nothing is written before the identity
  checks arm it. Each write asserts the following, and any violation is a
  defect that aborts the run before the request is sent:
  - (M9) an interaction's callback and the subject application's interaction webhook (a follow-up, or the original
    response's edit or delete) are admitted once the identity checks arm the guard with the subject's application ID:
    they answer only interactions the subject received, which come from the lab, where its commands and buttons are
    (the checklist Rhys runs, `harness/main.ts checklist`); any other webhook stays refused. (After the M9 verifier:
    those URLs name no channel, and a guild command can be invoked in any channel, `#rules` included, so the guard
    alone cannot keep an answer out of a protected channel. The checklist registers its handlers on a runtime whose
    INTERACTION_CREATE dispatches pass only from channels the guard admitted, `LabGuard.isLabChannel`, through
    `ChecklistRun.labInteractionsOnly`; any other interaction is dropped with a warning and never answered.)
  - the guild is `DISCORD_TEST_GUILD_ID` (reads too, for guild routes);
  - the channel or role is in the provisioned lab set (by stored ID, admitted
    after the harness read or created it and checked its `lab`/`lab-*` name)
    and is never `#rules` or `#mod-updates`; the harness's own top role may
    appear only in a role-position PATCH (§5.7);
  - a new channel, thread (forum posts included) or role has a
    `lab`/`lab-*` name, and a new channel's parent is a lab channel; a new
    guild sticker has a `lab-*` name (read from its multipart form), and
    stickers are never edited or deleted; the guild's channel-list PATCH
    (positions and parents of any channel) is refused; a channel PATCH sets
    overwrites only for lab roles, `@everyone` and the two bots (the
    per-overwrite route's rule) and a parent only from the lab;
  - member edits target only the subject or the target bot, and change only
    `nick` and `communication_disabled_until` (roles change through the
    per-role routes, with lab roles only; `channel_id`, `mute`, `deaf` and
    `flags` are never sent);
  - thread membership changes only for `@me`, the subject and the target
    (adding a human posts a notice that can ping them);
  - AutoMod writes only delete `lab-*` rules the harness listed;
  - **kick and ban** run only when the docs model predicts failure from
    **harness-side reads taken just before the call**: the subject lacks the
    flag (harness's own computation from the role and overwrite reads), or the
    target's highest role, including both bots' managed roles, is not below the
    subject's. Otherwise the guard refuses. "Expected to fail" never comes from
    the resolver under test. (M4: the runner passes the harness's reads of the
    roles and both members to `LabGuard.permitKickOrBan`, which checks
    `kickBanPredictedToFail` itself and issues a one-shot permit for exactly the
    target's kick or ban route; any other kick or ban, a second use of a permit,
    or a bulk ban is refused. After the M6 verifier: a request the dry-run stub
    answers instead of sending is judged by `LabGuard.checkDry`, the same verdict
    with the target's kick or ban treated as permitted; nothing is sent, so it
    needs no permit and uses none, and the live call still needs its own);
  - (M4) a channel PATCH that renames a channel keeps a `lab`/`lab-*` name, and
    a new guild emoji has a `lab_` name (emoji are never edited or deleted);
  - (M6) one write outside the admitted channels: a message create aimed at a
    bot's user ID (`R-ids-distinct`'s invalid side), which names no channel,
    since snowflakes are unique (Discord answers 404 10003);
  - nothing is ever sent to a DM channel with a human, and nothing leaves the
    guild, edits the guild itself, global commands, webhooks or invites.
- **Safety** (`scenario/Safety.ts`) is a pure check that runs offline over the
  whole catalog (a unit test) and again at run start, against the
  **materialized** desired state, for steps (c) **and** (d):
  - every row whose payload has `@everyone`/`@here` has MentionEveryone never
    granted (no administrator source, no allow anywhere), whatever its missing
    dimension; Rhys is the owner and sees every channel;
  - every kick or ban row satisfies the docs-model failure rule above
    (`kickBanMustFail` in `[sd:pairwise.ts]`);
  - user mentions only of bot IDs; role mentions only of `lab-*` roles Rhys
    does not hold; `repliedUser` only when replying to bot messages;
  - no row's removals affect the target (§5.7);
  - at most one name or topic edit per lab channel per run (H-162); (M6) an
    edit preflight predicts Discord refuses changes nothing and is not counted
    (`channelEdit/targeted/rename-voice-without-connect` lacks Connect), and a
    rule probe counts for the channels it may rename;
  - (M6) a rule probe or `mention-role` payload mentions only the target bot and
    `lab-mentionable`/`lab-unmentionable`; the runner reads the owner's roles at
    run start and aborts if Rhys holds one.
- **Lock** (`harness/Lock.ts`), taken by `config/Credentials.ts` for **any**
  identity and any entry point that reads a Perms Lab token, including the
  examples and dev runs. It creates `/tmp/effect-discord-perms-live.lock`
  atomically with the hostname, pid and command. A lock whose pid is dead on
  this host is taken over by an atomic rename. The lock is released in a
  finalizer. It is host-local: live commands run only on `minisforum`, the
  host whose checkout holds `.env`, and `LOG.md` records that limit (§8 item 20).

### 5.7 Reset and provisioning

**Lab IDs** are persisted per run in `.lab-state.json` (git-ignored), written
by Provision and read by Reset. Objects are tracked by ID, so a rename never
orphans or duplicates them. Every scenario-created thread is named `lab-*`
(the guard refuses any other name, §5.6).

**Reset** (`harness:reset`) is idempotent. A second reset must make **zero**
writes, and that is M2's exit check.

1. Set `@everyone` permissions to the baseline, which is empty (0). Rhys is
   owner and unaffected.
2. Delete `lab-*` channels and roles that are not in the provision spec.
3. Restore member state: remove non-baseline `lab-*` roles from the subject and
   the target (the target keeps `lab-target` and `lab-unmentionable`), clear
   their member overwrites, timeouts and nicknames, and set both managed roles'
   permissions to none where the bots have managed roles (in Perms Lab they do
   not, M2). A subject or target holding a role outside the lab fails the reset.
   Lab roles get their spec's permissions and mentionability back.
4. Restore channel settings: name variant `a`, parent `lab`, slowmode 0,
   overwrites exactly `lab-target`'s allow (which clears every scenario's role
   and member overwrites), forum `REQUIRE_TAG` off and tags reset to `lab-tag`.
   On the provisioned threads, the settings a thread has: name, slowmode 0
   (the §5.8 `channelSettings.slowmode` can target a thread) and auto-archive
   10080 minutes; threads have no overwrites or parent to restore, and
   `requireTag` belongs to the parent forum.
5. Threads: enumerate active **and** archived threads (public archived, private
   archived and joined private archived, threads.mdx) in lab channels; delete
   scenario threads; unarchive and unlock the provisioned threads; restore the
   subject's membership of every provisioned thread to its baseline (not a
   member), and the target's (a member of all four, so it can post fixtures in
   `lab-private-thread`).
6. Remove pins (every pinned message this step does not delete is unpinned),
   and bulk-delete messages younger than 14 days in lab channels,
   listed by author (harness, subject, target), so untracked messages from a
   timed-out request are removed too; older ones are deleted singly. A forum
   post's starter message is kept, and system messages Discord never lets
   anyone delete (types 1-5 and 21, for example the "added to the thread"
   notice adding the target posts) are left (deleting one is 403 50021, M2).
7. Reset the subject's guild commands to an empty list.
8. Delete AutoMod rules named `lab-*`.

Reset never touches `#rules`, `#mod-updates`, or anything not in the lab set.

**Reset self-test** (`harness:selftest`, `harness/SelfTest.ts`). The smoke and
reset exit checks run on a lab that is already clean, where a reset that wrote
nothing would pass too, so reset's write paths have their own live check, to
re-run whenever `Reset.ts` changes: reset, then a read-back that must find the
lab at baseline; dirt of every kind reset restores, applied through the
guarded identities; the read-back again, which must report each dirt step's
expected problem (so a blind read-back fails); reset; the read-back, which must
find nothing; and a second reset with zero writes. The read-back judges the
lab from the spec in `LabIds.ts`, not from reset's patch functions, so a field
reset forgets shows up (M2: thread slowmode). It leaves out renames (H-162:
two per channel per ten minutes), AutoMod rules (the guard refuses to create
them), messages older than 14 days, managed-role permissions (no bot has a
managed role in Perms Lab) and stage pins (400 50019, M2).

**Provisioning** is idempotent by stored ID.

- Category: `lab`.
- Channels: `lab-text`, `lab-announcement`, `lab-voice`, `lab-stage`,
  `lab-forum`, `lab-media`, and `lab-bots-only` (for content-intent tests).
  A channel of a kind the guild may not offer (GuildMedia only) that Discord
  refuses to create (400 50024) is recorded in `.lab-state.json` as
  `unavailable` and not retried; its scenarios record `setup-unsupported:
  kind-not-available` (§5.10). In Perms Lab that is `lab-media` (M2). The
  same answer for any other kind fails provisioning.
- Threads: `lab-public-thread` and `lab-private-thread` under `lab-text`,
  `lab-announcement-thread`, and `lab-forum-post`, all with auto-archive 10080.
- Roles, top to bottom: harness-managed, `lab-high`, `lab-mid`, `lab-low`,
  `lab-grant`, `lab-allow`, `lab-deny`, `lab-admin`, `lab-target`,
  `lab-mentionable`, `lab-unmentionable` (not mentionable; members: the target
  only). `lab-admin` holds Administrator (the `administrator` grant source);
  every other lab role has no permissions at baseline. Both bots' managed
  roles, where they exist, are placed directly below `lab-low` (the subject's
  above the target's) and recorded (H-073); in Perms Lab neither bot has one
  (M2), so ranks come only from the lab roles a scenario assigns. Positions
  are set once, as one block at the bottom of the hierarchy with distinct
  positions, and read back. Discord gives every role created through the API
  position 1 without renumbering the others, so the block is written whenever
  positions tie; the position PATCH must also move the harness's own top role
  above the block, or Discord answers 400 50013 (M2).
- `lab-target` gets a channel **role-overwrite allow** (View, Send, SMIT, RMH,
  AddReactions) on every lab channel, so `@everyone` overwrite denies never
  remove the target's ability to post fixtures (H-007). An offline check asserts
  that no row's removals affect the target.
- A guild sticker, and (M4) a guild emoji `lab_emoji` for reactions with a
  guild emoji (`.lab-state.json` `emoji`).

### 5.8 Scenario DSL (`[sd:src/verify.ts]`)

```ts
export class Setup extends Schema.Class<Setup>("Setup")({
  channel: LabChannel,                               // text | announcement | voice | stage | forum | media | forum-post | 3 thread kinds
  threadState: Schema.optionalKey(ThreadState),      // active | archived | locked | archived-locked
  subjectThreadMember: Schema.optionalKey(Schema.Boolean),
  grants: Schema.Array(Schema.Struct({ flags: Schema.Array(Flag), via: GrantSource })),
  removals: Schema.Array(Schema.Struct({ flags: Schema.Array(Flag), via: Removal })),
  memberState: Schema.Literals(["normal", "timed-out"]),
  targetRank: Schema.optionalKey(Rank), roleRank: Schema.optionalKey(Rank), targetAdmin: Schema.optionalKey(Schema.Boolean),
  channelSettings: Schema.optionalKey(Schema.Struct({ nameVariant: Schema.Literals(["a", "b"]), slowmode: Schema.Int, requireTag: Schema.Boolean })),
  fixtures: Schema.Array(Schema.Literals(["subject-message", "harness-message", "second-harness-message", "existing-reaction",
    "pinned-harness-message", "guild-sticker", "subject-thread", "target-role", "subject-prior-send"]))
}) {}
// M4: the fixtures the catalogs use. A foreign message, a reaction and a pin are the harness's (it can post,
// react and pin in voice text chat, where the target cannot without Connect); `subject-thread` makes the
// scenario thread one the subject created (`lab-subject-<kind>`); `target-role` gives the target the role a
// removal takes away. M3's "target-message" and "crossposted-subject-message" had no row and were dropped.
// `subject-prior-send` (M4 verifier, H-053) is a plain message the subject sends after Converge, under the
// setup's own permissions and slowmode, so the send that follows is its second in a row.
// M6: `harness-thread` makes the scenario thread a throwaway public thread the harness creates in lab-text
// (`lab-harness-public-thread`), which the subject may delete only with ManageThreads; the operation union gains
// `rule{probe}` (`scenario/Probes.ts`, executed by `harness/Probes.ts`), and the send payloads `mention-role`
// (a mention of `lab-unmentionable`, targeted rows only, H-101).
interface Scenario {
  readonly id: string                         // "<family>/<channel>/<dims...>", stable, unique
  readonly hypotheses: ReadonlyArray<`H-${number}`>
  readonly setup: Setup
  readonly operation: Operation               // tagged union per family: send{payload}, react{emoji}, ..., raw{probe}, session{intents, trigger, canary}, register{definition}
  readonly expect?: Observation               // rule rows only; matrix rows have no expectation (agreement decides)
}
```

`Materialize.ts` turns a `Setup` plus the lab ID map into a desired state:
`@everyone` permissions, `lab-grant` permissions, subject roles, overwrites per
channel, thread state and subject membership, channel settings, the target's
roles, nickname and timeout, and the subject's timeout. It is pure, and offline
replay uses it with fake IDs.

`harness-message` (M3) is a plain message the harness posts, the target of a
reply: the harness can post in every lab channel, including voice text chat,
which the target cannot without Connect.

The desired state covers every lab object the matrix controls, so converging to
it also undoes the previous scenario: `@everyone`'s and every lab role's
permissions, the subject's lab roles and timeout, every available lab channel's
overwrites (baseline: `lab-target`'s allow), and the scenario thread's state and
the subject's membership of it. Grants and removals go on the scenario channel,
or a thread's parent. Within one overwrite a removal wins (the flag leaves the
`allow`); two roles' overwrites aggregate instead (H-006), which some rows test
on purpose. The other threads stay at baseline, because cleanup restores the
one a scenario touched.

**Subject-observable projection.** `Materialize.project(desired)` computes what
the subject's gateway state can show for that desired state, under the codec
and Discord's thread-sync rules (threads.mdx):

- a channel whose desired state denies the subject View is expected either as
  `obfuscated: true` (with the codec, or after Discord's switch) or with its real
  overwrites: before the switch, without the codec, the gateway gives a bot every
  channel with its real overwrites, including ones it cannot view (M3 live);
- threads under a hidden parent, and private threads the subject is not a
  member of and cannot moderate, are expected to be absent or unchanged
  (Discord sends no further events for them);
- an observable thread may be absent too: GUILD_CREATE carries only the threads
  the bot can view, and Discord does not always sync a channel's threads when it
  becomes visible; when present, its state and the subject's membership are
  compared;
- everything else is compared in full.

The wait (§5.10) compares the subject's GuildState with this projection, and the
replay uses the projection to rebuild the subject's view. Revision 1 compared
the raw desired state, which the subject cannot see when View is denied, so
every View-removed row and every private-thread row would have timed out.

**Converge order** is fixed: remove the subject's admin role and lift timeouts,
then set roles and overwrites, then apply timeouts, then grant admin. A timeout
of an admin returns 403 (H-021), so admin with timeout is a targeted row with
its own order (§5.9). The scenario thread's subject membership changes before
the overwrites, with View granted to the subject on the parent through a
temporary member overwrite that the overwrite step then replaces: Discord
refuses to add a member who cannot view the parent (403 50001, M3 live), and
cleanup removes the subject the same way. The thread's archived and locked
state is set after the fixtures are posted (posting would unarchive it).

### 5.9 Dimensions and selection

**Pairwise families.** These use `[sd:pairwise.ts]`, a deterministic greedy
algorithm. Each family has a **validity predicate**, and the run checks every
selected row against it, plus coverage of every valid pair and every value of
every dimension, before any write (`Pairwise.selectionProblems`, which the
catalog test also runs offline). Counts
were measured (`[sd:pairwise.txt]`, `problems: []`):

| Family | Dimensions | Full product | Pairwise rows |
|---|---|---|---|
| send | channel 10 (text, announcement, voice, stage, forum-post, public, private, announcement, archived, locked threads) × payload 8 × grantSource 5 × missing 5 (none, view, base, payload, connect) × removal 4 × memberState 2 | 16,000 | 89 (M3) |
| react | channel 5 × emoji 3 (unicode-new, unicode-existing, guild) × missing 5 (incl. connect) × removal 3 × memberState 2 | 450 | 25 |
| pins | channel 5 × op 3 × missing 5 (incl. connect) × removal 3 × memberState 2 | 450 | 25 |
| createThread | parent 2 × visibility 2 × missing 3 × memberState 2 | 24 | 8 |
| threads | thread 4 × op 6 (join, leave, add-member, archive, lock, delete) × creator 2 × missing 3 × memberState 2 × membership 2 | 576 | 24 |
| channelEdit | channel 6 × missing 4 (incl. connect) × removal 3 × memberState 2 (slowmode edits) | 144 | 21 |
| messages | op 6 (edit-own, delete-own, delete-foreign, crosspost-own, crosspost-foreign, bulk-delete) × channel 4 × missing 3 × memberState 2 | 144 | 22 |
| members | op 6 × targetRank 3 × roleRank 4 (incl. n/a) × missing 2 × targetAdmin 2 × memberState 2 | 576 | 21 |

Validity predicates (in `[sd:pairwise.ts]`):

- **send**: `missing=payload` needs a payload with a flag (not plain,
  mention-everyone or a guild sticker: a guild sticker needs no flag, H-138; the
  prototype let it through, and the M3 fix adds one row, 89 in all); administrator only
  with `missing=none`, `memberState=normal` and no @everyone payload;
  `missing=none` means `removal=absent`; `connect` only for voice and stage.
  MentionEveryone is never granted in an @everyone row (Safety).
- **react, pins, channelEdit**: `missing=none` means `removal=absent`;
  `connect` only for voice (and stage). In M2 the harness (Administrator)
  pinning its own message in `lab-stage`'s chat got 400 50019 "This message
  cannot be pinned in this channel", so stage stays out of the pins channel
  dimension (it already was: text, announcement, voice and two threads), and a
  harness pin Discord refuses records `rejected-by-discord` (M4). The react row
  `unicode-existing × add-reactions missing` is kept: it tests the conditional
  AddReactions rule and is expected to succeed.
- **createThread**: private only under text; private under announcement is a
  targeted invalid row (H-041).
- **threads**: join and leave have no op flag; delete only on a
  scenario-created thread (`creator=subject`); leave only as a member, join only
  as a non-member.
- **channelEdit**: slowmode only, on kinds that have it. Name and topic edits
  are targeted rows, at most one per lab channel per run, toggling between two
  `lab-` names so no restore is needed (H-162).
- **messages**: crosspost only in announcement; own edit and delete have no op
  flag.
- **members**: `roleRank` only for add/remove role. (M4) The lab has one role per
  position, so a rank and a role of the same rank are the same role: an
  add-role row never gives the target a role it already holds for its rank
  (`roleRank = targetRank` above `below`), and a remove-role row's target ranks
  at least as high as the role it holds to lose (22 rows, one more than the
  design's 21). Kick and ban rows are
  valid only where the docs model predicts failure (`kickBanMustFail`: flag
  missing, or the target not below), never with `missing=none` and the target
  below. A timeout is not used as a reason, since whether timeouts bind bots is
  itself open (H-022). `targetAdmin` is not a safeguard (H-067).
- **Every family** excludes administrator together with `timed-out`; that
  combination is the targeted H-021 row with a fixed setup order.

**Targeted families** are hand-written rows, each citing H-ids:

- overwrite algebra H-003..H-011: Administrator bypass, both array orders and
  both role orders, a role allow beating a role deny, the member overwrite last,
  and an overwrite for a role not held; (M4) the Setup has one role per grant
  source and one array order, so the rows cover H-003, H-005 (an `@everyone`
  overwrite allow as the grant, and its deny as a removal), H-006, H-007 (a role
  deny beating the `@everyone` allow), H-008 and H-011's allow side (every lab
  channel carries `lab-target`'s allow, for a role the subject does not hold);
  H-004, H-009 and H-010 are offline only (LOG.md);
- implicit H-012..H-017, voice and stage Connect H-152, H-153, H-159;
- timeout H-020..H-029, including H-021 (admin and timeout, fixed order);
- threads H-031..H-048, including private-thread visibility H-033, H-047 and
  auto-join H-034;
- createPost on forum and media, with and without `REQUIRE_TAG` (H-031, H-044);
- pins H-050, H-052; slowmode H-053, H-054 (M4: H-053 is a send right after the
  subject's own `subject-prior-send` in `lab-text` with a 60 s slowmode, without
  and with BypassSlowmode; the slowmode outlasts the raw call's 30 s deadline,
  so a slowmode 429, which dfx retries, aborts the run instead of passing as a
  late success);
- hierarchy H-060..H-073: role below/equal/above with the target above (H-060,
  H-061), both managed roles placed (H-073);
- messages H-141, H-143, H-146, H-147;
- error codes H-080..H-092; degradation H-100..H-112; limits H-120..H-131
  (probes at exactly `Limits.contentMax` and one over, never a hard-coded 2001);
- rename and topic rows, one per lab channel;
- ordering: two failures at once for each adjacent pair in §3.2, and the
  non-adjacent pairs with dedicated codes (Send + reply RMH, SMIT + locked,
  View + archived); (M4) a locked thread with a missing EmbedLinks
  (`send/targeted/order-locked-embed`, which moved `ThreadLocked` after the
  payload flags, and its flip control, which grants EmbedLinks and meets the
  lock), and `TargetIsAdministrator` on its own
  (`member/targeted/timeout-admin-below`: `lab-admin` sits below the subject's
  `lab-mid`); tier 7 (local limits) arrives with M6's limit rows;
- obfuscation H-160..H-161.

**Flip controls** (`catalog/flips.ts`). For every row where exactly one flag F
is the first missing flag and raw fails, a sibling row has the identical setup
plus only F granted; it must succeed, or fail with the next-ranked failure of
the row's `preflightSet`. A 50013 never names a flag, so this is the only
check that the blamed flag is the right one when the oracle is unavailable.
Kick and ban flips are not run (they could succeed): `forbidden-action`.
(M4) One sibling per (operation row, first missing flag): the first family row
in ID order whose prediction from the setup alone (`harness/Predict.ts`, which
the replay holds to the live records) has F first and is not blind. The
sibling drops F from every removal and adds it to the original's first grant
that is not an administrator source (or a new `lab-grant` grant), and is
judged after the run against its original's live row (`Agreement.flipAgreement`).

**Coverage rows** (M6, `catalog/coverage.ts`). For each (operation row, flag)
the families leave without a first-failure row a flip control can be made of,
one row is derived from the first family row of that operation in ID order (not
timed out, no administrator grant): every flag the request needs granted, then
that flag taken away, kept only when the prediction's failures are exactly that
flag and its flip passes. 24 rows (for example ViewChannel in voice pins, thread
unarchive and thread message edits; ManageMessages for foreign deletes and bulk
deletes; PinMessages for unpinning; ModerateMembers for a timeout). A key whose
family rows are all blind (a thread under a parent that hides View resolves
`unseen`, which hides its other problems) takes its flip from the first blind row
whose flip the prediction shows clean (M6: thread sends, joins, reactions and pins
had no ViewChannel flip control).

The expected total is 234 pairwise rows, about 110 targeted rows, about 45
flip rows, about 95 rule rows and about 16 intent sessions, roughly **500
scenarios**. (M6: 486 scenarios in the phase-1 catalog: 304 family rows, 24
coverage rows, 94 flip controls and 64 rule rows; the intent sessions come in
M7.) (M7: 510: the codec's obfuscation blinds the timed-out rows that hide View, so
11 flip controls are replaced (9 by the flips of 9 new coverage rows, §4.15), and the
catalog is 304 family rows, 33 coverage rows, 94 flip controls, 64 rule rows and 15
intent sessions; a full run makes 80 role edits. After the first full codec run,
`message/targeted/crosspost-foreign-timed-out` and `createThread/targeted/private-timed-out`
join the targeted rows, 512 in all: they witness `Observed.viewCodeFailures`' foreign
crosspost and private thread under a timeout, which flip controls witnessed before the
codec blinded their originals.) (M8: 542, with the 30 registration and route rule rows of §5.5's
`commands` setup, whose role state is `text-send`'s, so the run's role edits do not change.) (M4 has 229
pairwise rows, 72 targeted rows and 62 flip controls, 363 scenarios in all; the rule rows and intent sessions
come in M6-M8.)

### 5.10 Executing one scenario

Scenarios are grouped by setup signature, and groups are ordered to minimise
writes. Within a group, order is by ID. The order is fixed, so runs are
reproducible. (M4: the groups are sorted by the role permissions their setups
need first, then by the canonical setup, because role edits are the scarcest
write; a run makes one role edit per distinct role state, 67, where sorting by
setup alone made 216.)

1. **Converge** the setup in the fixed order of §5.8: harness reads, then the
   minimal writes. The harness reads the roles, the subject, the scenario
   thread, and with `getChannel` only the lab channels whose overwrites may be
   off baseline (the scenario's, and the previous scenario's); every other lab
   channel has been at baseline since the opening reset, because only Converge
   and cleanup write overwrites. (M3 live: the guild channel list route answered
   429 several times a run when read twice per scenario.) (After the M6 verifier,
   for §5.11's run time: the roles and both members are read only when the
   previous scenario's settled read-back does not hold them current,
   `Converge.KnownView`: role permissions change only through Converge and reset,
   the subject only through Converge and its own fixtures, the target also through
   a member operation or a rule probe, so the runner forgets each part when one of
   those may have written it. A stale part would make Converge skip a write, which
   the wait's projection check below turns into a `setup-timeout`, never a row.)
2. **Fixtures.** (M4) The subject's own objects (`subject-message`, a
   `subject-thread`) are made before Converge, with temporary access: the
   harness lifts a leftover timeout and gives the subject a member overwrite on
   the overwrite channel, and Converge then replaces it with the desired state.
   After Converge the harness posts its messages, reacts and pins (a pin Discord
   refuses makes the row `rejected-by-discord`), the subject sends its
   `subject-prior-send` under the setup (refused: `rejected-by-discord` with the
   code), and then the harness sets the thread's archived and locked state
   (`harness/Fixtures.ts`). (Before M5, the M4 verifier: only
   `Fixtures.subjectPriorSend` can make the `PriorSend` value, `NotRequested`,
   `Sent` with the message ID or `Refused`, through a module-private key, and
   step (c)'s raw call takes it and dies unless it is `Sent` exactly when the
   setup has the fixture, so the runner cannot skip the prior send; the run log
   records the prior message's ID.)
3. **Consistency wait** (`Wait.ts`, G9). All of these must hold, with a 15 s
   cap. On timeout the run aborts with `setup-timeout`, an infrastructure
   failure that is never recorded as a mismatch.
   - Harness read-back equals the desired state (the same reads as step 1).
     (After the M6 verifier: the first read-back reads again only what Converge,
     the fixtures and the thread's state wrote since Converge's read, nothing
     when Converge found the setup in place; one that differs is retried with all
     of step 1's reads.)
   - The subject's GuildState equals the **projection** of the desired state
     (§5.8). (M7, with the codec: a lab channel the subject cannot view, the
     category aside, must be obfuscated there. M7 live: when the subject loses
     Administrator, Discord sends no update for the channels it stops seeing, and
     its state keeps their real overwrites; so a channel still shown that way after
     2 s is resent, its own overwrites written again unchanged, and Discord then
     sends it obfuscated. The run log names the channels resent.)
   - Two oracle reads 100 ms apart are identical (revision 2: 300 ms; with the
     pacing's 200 ms between request starts they started at least 300 ms apart;
     at 10/s, before M9, the second starts 100 ms after the first's answer).
   - A further 100 ms settle has passed (revision 2: 250 ms).
4. **(a) Resolver** over the subject's GuildState (M3: a scenario thread is
   refreshed first through `GuildState.refresh`, so the subject's view of it is a
   function of the setup, fetched when it can see it and unseen when it cannot,
   not of which events earlier scenarios delivered; the offline replay can then
   rebuild it from the setup). A member operation (M4) resolves at guild level
   (`ChannelInput` `Guild`: the base permissions and the timeout mask), and the
   subject reads the target member through `SubjectRaw`, as the library's
   `Members.get` will, for the hierarchy. Record `required`,
   `missing`, `missingBeforeMasks`, `masks` and `level` (`view` if the bot cannot
   see the channel or the target: a blind mask, or no View, no Connect or no
   `viewLevel` flag on a row that requires it; `action` if it can and preflight
   found any failure, the timeout, the hierarchy and a thread's state included
   (M4: M3 counted only missing error-mode flags, so a locked thread was
   `none`); `none` otherwise). Which code a level answers is
   `Observed.expectedCode` (§5.13).
5. **(b) The real public operation** (`channel.send(payload)` and so on) in
   `"enforce"` mode on the live subject GuildState, with `DryRun` set: the
   shared `HttpClient` records the request and answers a canned 2xx body from
   `fixtures/canned/` without sending. Record `pass` if the stub was called,
   otherwise the error as `{tag, categories}`, which must have a
   `PreflightDecision` cause. Also record `preflightSet` from
   `Preflight.decide`. If (b) and `decide` disagree, the row is
   `preflight-wiring`. This exercises the user-facing path (handle →
   operation row for the kind → GuildState → order → `errorFor`) without an extra
   Discord request. Until M6 (b) is `decide` alone. (M6, `harness/Library.ts`: the
   row's `preflight` is the operation's record, and the runner also requires its
   tag and categories to equal `decide`'s error, else `preflight-wiring`. The
   handles are built from what the lab knows, as a bot holds handles it got
   earlier: the scenario channel by its kind (`Channels.get` would refuse an
   unseen thread, which `thread.leave` needs no View for), the fixtures' messages
   from the harness's read of them (author and reactions), the target member from
   the subject's read. Every library route has a canned body, `DryRun.cannedFiles`.)
   **The request check** (after the M6 verifier). Nothing above compares the
   request the library sends with the one the matrix measured: (b) only needed
   the stub to be reached, a success row's live call is (c)'s alone, and a
   wrong request on a refused row is usually refused for the same reason, so
   five wrong requests (an unpin sent as a pin, a role removal as an addition,
   a lock as an archive, an unarchive as an archive, a private thread as a
   public one) passed every test and the live matrix. So steps (c) and (d) run
   under `DryRun.Capture`, which the shared client reads: a request that passes
   the guard is recorded, then sent. A record is the method, the path under the
   API base with the IDs and the sorted query, and the body as canonical JSON (a
   multipart body as its parts, `payload_json` as JSON and each file by name,
   type and size); a step's own request is its first (a 429 dfx retries repeats
   it, and the recompute's reads follow it). The library's request, step (d)'s
   as sent and (b)'s when (b) reached the stub, must each equal step (c)'s;
   otherwise the row is `request-wiring` and the run log names the difference.
   Every row of the M6 table has (b) passing or a (d); a row with neither would
   have the operation run in bypass mode over the stub instead
   (`Library.bypassedRequests`). The table records none of it (it holds no IDs).
   The check sends nothing extra, on purpose: the first live run after the
   verifier ran (c) and (d) a second time over the stub instead, and dfx's own
   per-route limiter, which sits above the stub, counted those requests too and
   delayed a live thread creation past the 30 s deadline (LOG.md). Offline,
   `test/unit/request-check.test.ts` runs the comparison over one scenario of
   every (operation, lab channel) of the catalog (158 pairs) with both sides over
   the stub (`Library.bypassedRequests`, `Drivers.dryRequests`; the guard judges
   a dry request as the live one, `LabGuard.checkDry`, §5.6), and fails on each
   of the five wrong requests; it also runs (c) and (d) under the capture.
   (After the M6 verifier) Which sides are compared and how a difference makes the
   row `request-wiring` is pure (`DryRun.librarySides`, `DryRun.requestCheck`,
   `Agreement.matrixRowAgreement`) and unit-tested. **A limit of the check:** the
   raw call's message bodies (send, createPost, edit) are built by the library's
   own `ToDfx` with the same field choices (`harness/Drivers.ts`), so for those
   bodies the comparison checks the operations' routing and arguments, not ToDfx's
   wire mapping. That mapping is held to hand-written wire bodies offline
   (`test/unit/payload.test.ts`: `allowed_mentions`, the flags, `tts`, embeds,
   polls, stickers, replies, components and files) and live to the harness's own
   reads: the degradation readback of the created message (`Outcome.ts`) and the
   rule probes that read the message back through the harness.
6. **(c) Raw call** through `SubjectRaw`, with no check. Classify it with
   `Outcome.ts`: `success`, `degraded` (with the list), `50013`, `50001`,
   `other-error` (status, code, sorted inner codes with paths), `ignored`,
   `event-delivered`/`event-absent`, or `setup-unsupported` with a reason code
   (`bot-not-timeoutable`, `admin-exempt`, `kind-not-available`,
   `rejected-by-discord`). Record `mappedTag`, the tag ErrorMap gives the code.
7. **(d) Recompute.** For rows whose (c) was 50013, 50001 or a dedicated code,
   run the library operation with `Preflight.Mode = "bypass"` and record
   `{tag, categories}`. The Lab guard and Safety apply to (d) as to (c). (After
   the M6 verifier: a `Transient` in (d) is the infrastructure abort below; M6
   had recorded it as the row's recompute.) (M6: a
   kick or ban gets a fresh guard permit from new harness-side reads; a (d) that
   Discord lets through records `(succeeded)`, which never equals (b), and what it
   created is deleted. A rule row runs its probe instead of steps (a) to (d), and
   records an empty resolver, `preflight: n/a` and its observation.)
8. **Oracle**: `GET /channels/{c}/permissions/member/{subject}?implicit=false`
   through `rest.httpClient` (`rest/Oracle.ts`), restricted to the required
   flags. If the route returns 404 or 405 at the first use, the table header
   records `oracle: "unavailable"`, which `verify:live` prints as a run-level
   condition; flip controls are mandatory either way.
9. **Cleanup.** The harness deletes what the scenario created (messages,
   threads, reactions, pins) and lists lab-channel messages by author to catch
   untracked ones, and restores channel settings and the target's member state
   when the scenario changed them. Deletes are idempotent: a listed message that
   is already gone (404 10008) is skipped, and a bulk delete refused with 10008
   falls back to single deletes (M4 verifier: right after the subject's bulk
   delete, the listing still returned a deleted message, and the run aborted).
10. **Record** the row, with the `agreement` from `Agreement.ts`.

A timeout of the (c) or (d) call is an **infrastructure abort**, never a row
outcome: the request may have been applied (§4.10).

**Lab-step retries** (after the M6 verifier). A harness lab step (reset,
provision, Converge, the fixtures, the wait's reads, the oracle's, cleanup)
Discord answers with a 5xx is sent again, up to three times, 1, 2 and 4 s apart,
when every request it sent is a read or one of the harness's PUT, PATCH or DELETE
requests, which set absolute values and leave the same state when repeated
(`Lab.withLabRetries`; the shared client records the methods a step sends,
`Lab.CurrentLabStep`). A POST (a message, thread, channel, role, sticker or bulk
delete) is never sent again, nor a step answered 4xx or with no response. Steps
(c) and (d), and the subject's fixtures, are never retried: their outcome is the
measurement, and they do not go through the retry (the subject's fixtures are
POSTs). Each retry is printed on stderr as it happens and counted per step in the
run's summary. (Three of the M6 verifier's five live attempts died on one 500,
502 or 503 in a lab step.)

**Agreement** is pure and shared with the replay. It is `"agree"` unless:

- `preflight-wiring`: (b), the real operation, differs from `Preflight.decide`;
- `request-wiring` (after the M6 verifier): the library's request (step (d)'s
  as sent, and (b)'s when it reached the stub) differs from step (c)'s as sent,
  in method, path or body (the request check of step 5; the runner decides it,
  since the table keeps no URL);
- `preflight-vs-raw`: preflight `pass` while raw is neither success nor
  degraded, or preflight failed while raw succeeded, or raw has a `mappedTag`
  that is not in `preflightSet` (§3.2);
- `level-vs-raw` (H-080 as a checked correspondence): raw 50001 while the
  resolver's `level` is not `view`, or raw 50013 while it is not `action`. If
  the matrix refutes H-080, `Observed.codeForLevel` records the observed mapping
  and the check uses it (M3, M4: it did, per operation; `Observed.viewCodeFailures`
  lists the first failures Discord answers with 50001 at the `action` level,
  for example a missing SendMessagesInThreads or a locked thread on a thread
  send, and `Observed.expectedCode` combines the two);
- `resolver-vs-raw`: the resolver's `missing` is empty for error-mode flags
  while raw failed with 50013/50001 and preflight found no state failure (the
  timeout, the hierarchy, a thread's state) to explain it, or a degraded list
  differs from the resolver's missing degrade-mode flags;
- `recompute-vs-preflight`: (d) is not equal to (b), **tag and categories**;
- `resolver-vs-oracle`: the oracle's `missing` is not equal to
  `missingBeforeMasks` (with the timeout mask applied, because the oracle
  applies it, H-241, `Observed.oracleAppliesTimeout`) when the oracle is
  available. On rows where the subject
  sees the channel as obfuscated or unseen, only ViewChannel is compared (the
  subject knows none of its overwrites); an unseen private thread the subject
  does not belong to is not compared at all, because the oracle's
  `implicit=false` does not model thread membership and reads View there
  (before M4: nothing was compared on any unseen row);
- `flip-control`: a flip sibling did not succeed and did not fail with the
  next-ranked failure;
- `rule-observation`: a rule row's observation differs from the registry's
  full expectation.

The run never retries a scenario to get a pass. A disagreement is recorded as
observed, and a second-chance read is logged to the run log only, for
diagnosing flakiness.

**Intent sessions.** Every session row records READY with the expected
`user.id` and the intents bitfield sent, then the trigger, then a **canary**
event that the session must receive after the trigger: a harness edit of a lab
channel topic (CHANNEL_UPDATE, Guilds), or for a session without Guilds, a
GUILD_MEMBER_UPDATE about the subject itself (H-175, which becomes an asserted
observation). `EventAbsent` counts only if the canary arrived. The trigger for
member events targets the **target**, not the subject, because events about the
subject arrive without the intent.

(M7, as built: `catalog/intents.ts` describes fifteen sessions and `harness/Sessions.ts` runs them as rule probes
on `catalog/rules.ts`'s `text-messages` setup, so they share the rule rows' safety, cleanup and agreement. Each
opens a fresh subject session, the library's own build with the codec, over the shared client
(`Identities.Sessions`, opens at least 6 s apart for Identify's limit), records every dispatch from the first
through the hook (`DispatchTap`), and subscribes the library's `bot.on` to the event. READY must name the subject
and the codec's Identify must carry exactly the declared intents, or the run aborts. The triggers are the
target's message, mention of the subject, ping-on reply to the subject's message, reaction and typing, the
subject's own message, a harness nickname edit of the target, and a harness slowmode edit of `lab-bots-only`; the
canary is a harness slowmode edit of `lab-bots-only` (CHANNEL_UPDATE), or for the Guilds pair a nickname edit of
the subject. The session waits up to 10 s for the canary, then up to 2 s more for the trigger's own dispatch, which
must also have reached `bot.on` decoded, with `contentDelivered` saying what Discord delivered; a disagreement is an
observation no expectation accepts.)

**Registration writes** are counted at the shared base `HttpClient` (PUT, POST
and PATCH to the commands routes), never by the library itself. A property
test mutates each canonical field (name, description, required, choices,
channel_types, ...) and expects one write. (M8, as built: the count is the base
client's writes to those routes less the 429s it saw there, because dfx sends a 429's
request again and Discord applied nothing for it; one PUT answered 429 then 200 was
counted twice in the first run. The offline property is `test/unit/registration.test.ts`
over a fake store that stores as the recording showed, eleven mutations, and
`test/unit/canonical.test.ts` over every leaf of the recording, 80. Live, Discord's
bucket for the bulk overwrite allows about one PUT every 30 s (429s with
`retry-after` 56 to 58 s, scope user), so each mutation row syncs its definition over
whatever the row before registered, every mutation differing from every other
registered definition (`test/unit/command-catalog.test.ts`), and only the identical row
re-registers the base first; the probes' requests take the lab steps' 90 s deadline,
since dfx waits the bucket out.)

### 5.11 Pacing and invalid-request budget

- `Pacing.ts` keeps a global token bucket in the shared `HttpClient`, across
  identities: 10 requests/s by default (5 until M9), configurable lower, a fifth
  of one bot's global limit of 50/s and still shared by all three identities.
  dfx's per-route buckets still apply. Because the client is outside every
  `Layer.fresh` (§4.2), the bucket and counters see all three identities.
  (Before M9, **the orchestrator's decision** on the question M6 and M7 left
  open: the bucket, not Discord's latency, set the run's pace, since about 9,270
  requests at 5/s cost at least 31 minutes before any wait. The cap rose to 10/s,
  and Converge's read and the wait's read-back make their independent reads
  together (`Converge.readView`, `Converge.rereadWritten`), so the cap is used.
  dfx's route buckets, the role-budget check, the invalid-request abort at 1,500
  and the 60-minute abort are unchanged, and no row was dropped. LOG.md has the
  timings before and after: 2,904 to 2,989 s before, 2,570 s after, 600 invalid
  requests, 0 mismatches and an identical table. The 30-minute target is still
  missed: at 10/s the floor is 927 s, and Discord's latency on the requests that
  must follow one another, and the waits for gateway events, now set the pace.)
- Name and topic edits: at most one per lab channel per run (H-162), enforced
  by Safety.
- 401, 403 and 429 responses are counted per run. The run aborts at **1,500**,
  15% of Discord's 10,000 per 10 minutes (H-094). The expected count is about
  500. (M4: about 220 per full run; each 429 is printed as it arrives, with its
  `retry-after`.)
- (M4 live) Discord allows **1,000 role edits per guild per day**
  (`PATCH /guilds/{id}/roles/{id}`: `x-ratelimit-limit: 1000`, refilled about one
  per 86 s). A run checks the bucket before any scenario write and fails with
  the wait when it holds fewer than the run needs (about 75); dfx would
  otherwise stall in its own limiter, which takes the bucket's first
  `remaining` as its limit for the whole reset window. Every lab step has a
  90 s deadline, so a stall aborts naming the step.
- (Before M5, the M4 verifier) Reset's message listing pages through each
  provisioned thread's undeletable "added to the thread" notices (types 1 and 2,
  hundreds after a few runs), and the per-channel `GET /channels/{id}/messages`
  bucket answered the sixth page in a row with a 429 (`limit 5`, `remaining 0`,
  `reset-after` about 4.2 s): dfx took the first page's `remaining 4` as the
  bucket's limit for its one-second window. Each page now waits for the
  `x-ratelimit-reset-after` its predecessor's answer reported when that answer
  left the bucket empty (`Wire.bucketWait`, `Reset.listAllMessages`).
- (M4 live) Announcement publishing (crosspost) is limited to about 10 per
  channel per hour; a run makes 4.
- Target duration is **at most 30 minutes**, at roughly 2 to 3.5 s per
  scenario for about 500 scenarios. The runner prints a running ETA and aborts
  at 60 minutes as an infrastructure failure. (After the M6 verifier: M6's full
  runs took 52 to 54 minutes, about 6.5 s per scenario: some 23 requests a
  scenario, each taking at least the bucket's 200 ms, and 0.55 s of fixed waits.
  The narrowed read-back and the kept roles and members of §5.10 steps 1 and 3,
  and the shorter oracle gap and settle, cut both; the run log records each step's
  milliseconds and requests, and LOG.md the timings before and after.)
- A lab step answered with a 5xx is retried as §5.10's "Lab-step retries"
  describes; the summary prints the retries per step.
- (M8) The 542-scenario run takes 2,905 to 2,989 s, of which the 30 registration
  and route rows take about 300 s, nearly all of it dfx waiting out Discord's
  command buckets (about one bulk overwrite every 30 s, §5.10 "Registration
  writes"). The 30-minute target is still missed (the orchestrator's decision,
  LOG.md); the 60-minute abort has about 10 minutes of headroom.

### 5.12 Truth table (G9, compiled: `[sd:src/verify.ts]`, `[sd:truth-runtime.txt]`)

```ts
export const Row = Schema.Struct({ setup: Setup, operation: Schema.String,
  resolver: Schema.Struct({ required, missing, missingBeforeMasks, masks /* the resolver's masks, incl. "unseen" */,
    level: Schema.Literals(["none", "view", "action"]) }),
  preflight: Schema.Union([Schema.Literal("pass"), Schema.Literal("n/a"), RecordedError]),   // RecordedError = { tag, categories }
  preflightSet: Schema.Array(Schema.String),
  raw: RawOutcome,                    // class, status, code, inner [{path, code}], degraded, mappedTag, unsupported?
  recompute: Schema.Union([Schema.Literal("n/a"), RecordedError]),
  oracle: Schema.Union([Schema.Struct({ missing: Schema.Array(Flag) }), Schema.Literal("unavailable"), Schema.Literal("not-applicable")]),
  observation: Schema.optionalKey(Observation),
  agreement: Schema.Literals(["agree", "preflight-wiring", "preflight-vs-raw", "resolver-vs-raw", "level-vs-raw",
    "resolver-vs-oracle", "recompute-vs-preflight", "flip-control", "rule-observation"]) })
export const TruthTable = Schema.Struct({ schema: Schema.Literal(2),
  env: Schema.Struct({ mfaLevel: Schema.Int, obfuscation: Schema.Literals(["codec", "portal", "default"]),
    oracle: Schema.Literals(["available", "unavailable"]), typescript: Schema.String, dfx: Schema.String,
    discordApiTypes: Schema.String, everyoneBaseline: Schema.Array(Flag) }),
  scenarios: Schema.Record(Schema.String, Row) })
```

- **Canonical form.** `canonicalJson(Schema.encodeSync(Schema.toCodecJson(TruthTable))(table))`
  sorts keys at every level, uses a 2-space indent and a trailing newline. All
  flag arrays are sorted when the row is built.
- The runtime check confirmed identical bytes for different insertion orders,
  and a decode/encode round trip (`[sd:truth-runtime.txt]`).
- **Nothing varies per run.** Rows contain no snowflakes, timestamps, messages,
  durations or retry counts. Those go to the run log
  (`/tmp/effect-discord-perms-live-<n>.log`), never to the table.
- **Determinism.** The gate is `verify:live --compare` in a fresh process
  against the table a previous process committed: byte-identical or exit 1. If
  it differs, the agent explains the flake in `LOG.md` and fixes its cause
  (usually a missing wait condition). It never removes a row.

### 5.13 Offline replay (`test/replay/truth-table.test.ts`)

For every row:

1. Rebuild a synthetic `Snapshot` from the symbolic `setup`, through
   `Materialize` and its **projection** (§5.8), with fake IDs.
2. Run the resolver and `Preflight.decide`. They must reproduce `resolver` and
   `preflightSet` exactly, and the first element must equal `preflight`'s tag.
   This is a regression check of the resolver against itself; the evidence
   that the resolver is right comes from Agreement against Discord, the flip
   controls and the oracle.
3. Run `Agreement` on the row. It must give `"agree"`.

The replay also asserts:

- every `Observed.ts` constant equals what the table shows, using only rows
  with the matching reason: `botsCanBeTimedOut` against
  `setup-unsupported: bot-not-timeoutable`, never `admin-exempt`;
  `slowmodeAppliesToBots` against witness rows (M4 verifier), which must exist: a
  send after the subject's `subject-prior-send` under slowmode, without
  BypassSlowmode or Administrator, answers 20016 exactly when the constant is
  true (and succeeds when it is false), and no other row answers 20016 unless it
  is true;
- no 50013 or 50001 row carries inner errors (H-081: Discord's refusal never
  names the permission);
- `PayloadRules.mode` against the degraded rows;
- the `Limits` values against the limit rows (from M6, when the limit probes
  arrive as rule rows; M4 has none);
- `Observed.codeForLevel` against the `level-vs-raw` data;
- `ErrorMap` covers every `(operation, status, code, inner path)` in the table;
- every recorded `{tag, categories}` equals `ErrorCategories` for that class.

---

## 6. Milestones

Order: tooling, then errors, then the **live oracle (harness, resolver,
matrix)**, then library operations built against the oracle, then phase 2, then
phase 3, then the reference bot.

Every milestone ends with:

- `bun run verify:offline` green, for whatever exists so far;
- its `LOG.md` entries;
- no `--update` snapshots that were not reviewed.

Live milestones run serially, under the lock.

| # | Title | Discord? |
|---|---|---|
| M0 | Tooling skeleton | no |
| M1 | Errors, categories, IDs, operation table | no |
| M2 | Harness foundation, identities and oracle | yes |
| M3 | State store, resolver, preflight, matrix runner | yes |
| M4 | Matrix to zero mismatches | yes |
| M5 | REST wrapper | no (fake client) |
| M6 | Payloads, channel and message ops, require, phase-1 rules live | yes |
| M7 | Gateway, Bot, intents, content | yes |
| M8 | Commands, registration, routes live | yes |
| M9 | Interactions (phase 3) | no |
| M10 | Reference bot, budget, README, final fresh-process run | yes |

**M0 Tooling skeleton** (offline)

- Scope:
  - pin `typescript` to exactly `7.0.2` (D32);
  - add the §5.1 scripts;
  - root tsconfig gets `"exclude": ["test/types/fail"]`;
  - `test/types/tsconfig.json` (`exclude: []`);
  - `vitest.config.ts` (`envDir: "test/env"`);
  - `scripts/type-tests.ts` with the §5.2 gate (codes, `@valid` twins,
    wrong-reason codes, scoped truncation ban);
  - `scripts/hover.ts`, `scripts/budget.ts` (with the per-command row),
    `scripts/rules-check.ts` (empty registry allowed),
    `scripts/verify-offline.ts`;
  - a `LOG.md` skeleton with a "Waiting for Rhys" section.
- The trivial fixtures are `R-catch-tag-exact`'s (pure-typing), because every
  fail directive must be claimed by a registry rule (§5.5); this needs
  `test/rules.ts` and the `Observation` schema in `harness/scenario/Dsl.ts`.
- Files: `package.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/*`,
  `test/types/**`, `test/hover/`, `test/env/.gitkeep`, `test/unit/*`,
  `test/rules.ts`, `harness/scenario/Dsl.ts`, `LOG.md`.
- Exit:
  - `bun run verify:offline` exits 0 with one trivial pass fixture, one fail
    fixture with its `@valid` twin, and one hover marker;
  - temporary fixtures with a wrong mention, a wrong TS code, and a missing
    import each make `bun run test:types` exit 1, and are removed after.

**M1 Errors, categories, IDs, operation table** (offline)

- Scope: `src/Snowflake.ts`, `src/errors/*` (generator with `ErrorCategories`,
  Cause with `NoResponse`, Category, Variants, Permission, State, Payload,
  Transient), `src/permissions/Operations.ts` (table, derived types,
  `variantConstructors`, `errorFor`), `src/permissions/Observed.ts` (the two
  constants the table's types read), `AllErrors`.
- Tests:
  - runtime marker test: prototype, frozen, not encoded, inherited correctly;
  - `errorFor` builds the promised variant for every (op, flag), checked
    against `ErrorCategories`;
  - D6 invariant;
  - generator `--check`;
  - the table invariants of §2.4-§2.5 (TwoFactorRequired, CommunicationDisabled,
    PermissionDeniedUnattributed per row);
  - pass fixtures for catchTag/catchCategory exactness, for `OpErrors` rows and
    for ID distinctness (no brand assignable to another);
  - a fail fixture for catching an absent category. The ID-mixing fail
    fixture moves to M6 with its rule: `R-ids-distinct` has a live pair, every
    fail directive must be claimed by a registry rule, and a `pair` rule fails
    rules-check closed until M6 adds the live-pair checks (§5.5), so in M1 it
    would make `verify:offline` red for M1-M5.
- Exit: `bun run gen:errors -- --check && bun run verify:offline`.

**M2 Harness foundation, identities and oracle** (live)

- Scope:
  - `config/Credentials.ts` (with the lock);
  - `harness/Identities.ts`: the shared paced `HttpClient` outside every
    `Layer.fresh`, `HarnessRest`, `TargetRest`, plus the fake-client auth test
    built from the exported layers;
  - `harness/IdentityCheck.ts` and the startup checks (§4.4) for three
    identities: `bot/Startup.ts`'s REST checks 1-3 (with `rest/ErrorMap.ts`'s
    `classify`), the app IDs, distinct users and the guild; the subject is a
    REST-only identity here (`SubjectRaw`, tag in `bot/Internals.ts`), so the
    READY and sent-intents checks wait for M3 and M7;
  - `Lab.ts` (guard on every identity), `Lock.ts`, `LabIds.ts`, `Provision.ts`,
    `Reset.ts`, `Pacing.ts`;
  - `rest/Oracle.ts`;
  - `harness/main.ts` with `reset`, `smoke` and `selftest` (the reset
    self-test, §5.7);
  - `smoke` runs the identity checks, reset, provision and one oracle read per
    lab channel, plus a positive control (the target in `lab-text`, which must
    read exactly `lab-target`'s allow), and prints counts. An unavailable
    oracle is recorded; an available one fails smoke if the control differs,
    the subject holds any flag at baseline, or only some reads answer.
- `LOG.md`:
  - the oracle's availability;
  - `mfaLevel`;
  - both managed roles' positions;
  - whether the harness has the Message Content flag.
- Exit: `bun run harness:selftest` exits 0; `bun run harness:smoke` exits 0
  twice in a row, and the second `bun run harness:reset` reports `writes: 0`.
  Then `bun run verify:offline`.

**M3 State store, resolver, preflight, matrix runner** (live)

- Scope:
  - `src/permissions/{Flags,Resolver,ResolverRules,Order,Preflight}.ts`;
  - `src/state/*` (versioned reducer, hook, refresh with generations), and the
    subject built from `BotInternals.layerWith` with the gateway;
  - `harness/{Materialize (with projection),Converge,Wait,DryRun,Outcome,Agreement,TruthTable}.ts`;
  - `scenario/{Dsl,Pairwise,Safety}.ts`;
  - the **send** catalog only;
  - `run --write`.
- Steps (a), (b) as `Preflight.decide`, (c) and the oracle are implemented.
  Step (d) is `"n/a"` until M5.
- Unit tests: the reducer over recorded-shape fixtures (including a replayed
  dispatch and the refresh/hook race), the resolver against the documented
  algorithm, Safety over the catalog, and the pairwise validity and coverage
  checks.
- Exit:
  - `bun run verify:live -- --only 'send/**'` finishes and prints a summary;
  - two consecutive processes running `--only 'send/**' --write` produce
    identical tables (the second with `--compare`).
  - Mismatches may remain; they are listed in `LOG.md`.

**M4 Matrix to zero mismatches** (live)

- Scope:
  - the remaining catalogs: messages, reactions, pins, createThread, threads,
    channelEdit, members, flips, plus the targeted families;
  - fix the resolver, `ResolverRules`, `Operations`, `PayloadRules.mode`,
    `Observed.ts` and `Limits` from findings, each with a `LOG.md` line citing
    the H-id;
  - `test/replay/truth-table.test.ts`.
- Exit:
  - `bun run verify:live` exits 0 with zero mismatches, and a second fresh
    process with `--compare` exits 0;
  - `bun run verify:offline` is green, including the replay;
  - `fixtures/truth-table.json` is committed by the orchestrator. (M4: by the
    implementer, whose task requires a clean tree; LOG.md.)

**M5 REST wrapper** (offline; fake HttpClient)

- Scope: `rest/{DiscordApi,ErrorMap,Coded429,Schemas}.ts`,
  `permissions/Recompute.ts`, and the deadline.
- Unit tests:
  - every `(operation, status, code, inner path)` in the truth table maps to
    the declared tag **and categories** (`ErrorCategories`);
  - `test/unit/op-errors.test.ts` (§4.7);
  - dedicated codes go through the recompute and our order decides;
  - unmapped codes are defects;
  - coded 429s surface, uncoded ones retry;
  - the deadline produces `RequestTimedOut` with a `NoResponse` cause under
    `TestClock`;
  - a 2xx decode failure is a defect;
  - the recording-tracer span test.
- Exit: `bun run verify:offline`.
- (M5) The matrix's step (d) stays `n/a` until M6, which "enables" it (§6 M6);
  M3's "until M5" meant the recompute's code. M5 holds the recompute to every
  refusal of the committed truth table offline instead
  (`test/unit/recompute.test.ts`: each gives exactly the row's step (b) error).

**M6 Payloads, channel and message ops, require, phase-1 rules live** (live)

- Scope:
  - `src/payload/*`, `src/channels/*`, `src/members/*`,
    `src/permissions/Require.ts`;
  - matrix step (b) switched to the real operation over `DryRun`, and step (d)
    enabled;
  - `catalog/rules.ts` for every phase-1 rule;
  - rules-check's live-pair checks (catalog scenario IDs, truth-table rows and
    observations, identical setups) and its flag-coverage check (§5.5);
  - type fixtures and hover markers for §2.1-§2.6, `op-errors.ts`, and the
    registry entries, including the ID-mixing fail fixture
    (`test/types/fail/ids.ts`, from `[sd:src/fail/ids.ts]`) with
    `R-ids-distinct`, moved here from M1.
- Exit:
  - `bun run verify:live` exits 0 with zero `preflight-wiring` and
    `recompute-vs-preflight` rows, then a fresh `--compare` run exits 0;
  - `bun run rules` reports every phase-1 rule complete or allowlisted;
  - `bun run verify:offline`.
- (M6) Beyond the listed scope, for the checks to pass: the flag-coverage rows
  and the blind-flip rule (§5.9), the `harness-thread` fixture and the
  `mention-role` payload (§5.8), `DiscordApi.read`, `ComponentRoute.make`, and
  the guild state's `unseen` rules the live step (d) exposed (§4.5).

**M7 Gateway, Bot, intents, content** (live)

- Scope:
  - `src/gateway/*` (Intents, Events with the DM branch, Codec that records
    the sent intents);
  - `src/bot/*` (make, layerWith, layer, on with `Effect.scoped`, startup,
    Internals);
  - the identity auth test re-run with the subject as the real bot layer;
  - `catalog/intents.ts`: serial subject sessions with and without each
    intent, each with READY and a canary, the target triggering the events;
  - the message-content exceptions (mention, ping-on reply, own); the DM
    exception is escalated (Q-17);
  - the obfuscation check;
  - rules-check's events check (§5.5);
  - fail fixtures for intents and the boundary.
- Exit:
  - `bun run verify:live` exits 0 including intent rows, then a fresh
    `--compare` run exits 0;
  - unit tests show a failing handler does not stop later events, and that
    finalizers run per event;
  - `bun run verify:offline`.

- (M7) Beyond the listed scope: `gateway/Dispatches.ts` (`bot.on`'s own dispatch stream, §4.14),
  `channels/Direct.ts` and `DiscordApi.executeDirect` (the DM branch's handles), `bot/Runtime.ts`, the replay's
  model of the codec (`Predict.snapshotOf`, §4.15) and the catalog change it brings (§5.9), `LivePair.also`
  (§5.5), and the M6 verifier's minor findings (the run time and lab-step retries of §5.10 and §5.11).

**M8 Commands, registration, routes live** (live)

- Scope: `src/commands/*` (definitions, option typing, canonicaliser,
  registration diff with GET-after-write), `src/components/CustomId.ts`,
  `fixtures/commands-canonical.json` (recorded from GET), and
  `catalog/commands.ts` (rule pairs at top level and nested, options-typed
  readback, the custom-id round trip, registration-diff with per-field
  mutations). All negative registrations reuse one command name and a per-day
  create counter stored in `/tmp`, which aborts at 150.
- Exit:
  - `bun run verify:live` exits 0 including the registration and route rows,
    then a fresh `--compare` run exits 0;
  - `bun run verify:offline`.

- (M9, as built) Beyond the listed scope: `Wire.ts` (the INTERACTION_CREATE decoding and the invocation against the
  definition), `DiscordApi.sendJson`, the app-permissions preflight (§4.7), `harness/main.ts checklist` with the DM checks
  of open questions 17 and 22 and the lab guard's admission of the subject's interaction answers (§5.6), the
  per-command budget row re-baselined with `Interactions.command` (§5.4), and the M7 and M8 verifiers' minor findings
  (§5.11's pacing at 10/s, the orchestrator's decision).

- (M8) Beyond the listed scope: `Request.sendJson` (registration through `rest.httpClient`, a dfx
  deviation: `ChannelTypes` lacks GuildMedia), `BotConfig.commands` and startup check 5, the per-day
  create counter as `harness/CommandBudget.ts` in the shared client (a rolling 24-hour ledger in
  `/tmp`, counting every name a POST or PUT may create that no answer showed registered), the
  `record-commands` harness command that recorded `fixtures/commands-canonical.json`,
  `ComponentRoute`'s `routeNameOf` and round-trip unit test, the per-command budget row's probes
  (`examples/command-probe/`, §5.4; until M9 a handler is a function of the invocation), and the M7
  verifier's minor findings (§4.15, §2.7, §8 item 22).

**M9 Interactions** (offline; phase 3)

- Scope:
  - `src/interactions/*`: the state machine with modes, local validation of
    responses, the runner with fork + timed join auto-defer under `TestClock`,
    posting through a fake REST, and `Checklist.ts`;
  - pass fixtures with `Effect.fn` handlers for every `Interactions.*` entry,
    and fail fixtures for every interaction rule;
  - `LOG.md`: the human checklist, marked "waiting for Rhys". It is never run.
- Exit:
  - unit tests prove: a slow handler is not interrupted and its reply is
    delivered; the deferral posted is type 5 (with the mode's EPHEMERAL flag) or
    type 6, asserting the HTTP route and flags of each delivered request; a
    reply after a type-5 deferral is a `PATCH .../@original`; an update after a
    type-6 deferral edits the component's message; continuations run after
    posting; `giveUp` completes and logs; a custom_id decode failure leads to an
    expired-control reply;
  - `bun run verify:offline`.

**M10 Reference bot, budget, README, final fresh-process run** (live once)

- Scope:
  - `examples/reference-bot/` (no `orDie` or `die` on library errors; uses
    send on `event.channel`, require, commands, components, Bot.on), taking
    the lock through `Credentials`;
  - the budget baseline with the per-command row;
  - final hover snapshots;
  - `README.md` with the design and the guarantee sentence verbatim from "The
    guarantee" at the top of this document, and the outcome-unknown note for
    `RequestTimedOut`;
  - `LOG.md` complete, including escalated rules.
- Exit:
  - `grep -nE "Effect\.(die|dieMessage|orDie|orDieWith)" examples/reference-bot`
    shows none on library errors;
  - `bun run budget` is green against the committed baseline;
  - `bun run verify:offline`, then `bun run verify:live` in a fresh process
    whose table equals the committed one (`--compare`), both exit 0.

- (M10, as built) Beyond the listed scope: the bot split into `bot.ts` (the bot, importing only the package) and
  `main.ts` (the entry point through `Credentials`); the package's `exports` (`"."` is `src/index.ts`), so the bot
  imports `effect-discord-perms` by name, and the budget checks that every import of it resolves to that entry point
  (§5.4); `test/unit/reference-bot.test.ts` (the bot over the real bot build, a fake Discord and a
  fake gateway), `test/types/pass/reference-bot.ts` and `test/hover/reference-bot.ts`; and the M9 verifier's four
  leftover minor findings (LOG.md).
- (M10, exit, after the second M10 verifier) `bun run budget` passes (§5.4: 59,620 types, 178,499 instantiations),
  and so does `bun run verify:offline`; the fresh-process `bun run verify:live` on the same code is recorded in
  LOG.md. The escalation after the first M10 verifier (the budget over two ceilings, a decision for Rhys) is
  withdrawn: the library's compile cost was cut instead (§2.2, §2.12 rule 10).

---

## 7. Research decisions D1-D35

"Adopted" means as written in `docs/research/README.md` §5.

| D | Decision | Status | Reason for change |
|---|---|---|---|
| D1 | Handler boundary T3O | adopted with change | the named interface lists the remaining **categories** (at most four) plus uncategorised tags, so it never truncates (§2.7) |
| D2 | Readability gate | adopted with change | 4 lines and 800 characters **after collapsing unions of plain names**; directives carry the TS code; wrong-reason codes rejected; `@valid` twin per fixture; truncation banned inside message types (§5.2) |
| D3 | Category mixin (effect-v4) | adopted | |
| D4 | `catchCategory(K \| [K, ...K[]])`, dual | adopted | every listed category must be present |
| D5 | Same-tag subclasses where needed | adopted with change | built only through `errorFor` and the typed constructor table; recorded as tag plus categories; M10: same-tag classes of their own rather than subclasses (compile budget, §2.2) |
| D6 | Unhandled = any non-transient; transient never combined | adopted | now implemented in `Handled` itself, plus the runtime invariant over `AllErrors` |
| D7 | Most-fundamental ordering | adopted with change | generalised to every operation (§3.2); preflight returns the full ordered list; dedicated codes go through the recompute |
| D8 | `PermissionRevokedSinceCheck` | adopted | `granted` is a real runtime field on handles |
| D9 | Deadline plus coded-429 interceptor | adopted | default deadline 30 s; outcome unknown documented |
| D10 | `RatelimitedResponse` is a defect | adopted | |
| D11 | `SlowmodeActive` only if observed | adopted with change | generalised into `Observed.ts`, which also governs `CommunicationDisabled` (H-022) and `codeForLevel` (H-080) |
| D12 | Decode every exposed response | adopted | |
| D13 | `Layer.fresh` per identity | adopted with change | shared services outside every fresh boundary; the subject is the library's own layer and `SubjectRaw` comes from the same build |
| D14 | `--no-env-file` plus `fromDotEnv` | adopted | plus vitest `envDir`; the lock is taken where credentials are read |
| D15 | Own store fed by DispatchHook | adopted with change | per-entity generations; refresh commits only unchanged entities |
| D16 | Own resolver; endpoint as the harness's oracle | adopted | oracle optional; flip controls make blame checkable without it |
| D17 | Own interactions layer on `DiscordLive` | adopted | |
| D18 | Own registration diff, guild only | adopted | writes counted at the base client; GET after write |
| D19 | Fail-fast startup | adopted | typed `StartupFailed`, including `discord-unavailable` |
| D20 | G7 codec for the subject | adopted | fixed by the orchestrator |
| D21 | `MayHave` plus a `PermissionErrors` lookup | adopted with change | one `PayloadRules` table with error/degrade modes; `MayHave` distributes over payload unions; presence separate from mode |
| D22 | Docs implicit masking as the starting hypothesis | adopted | plus the private-thread visibility mask |
| D23 | Branded IDs only | adopted | event payloads included |
| D24 | Intent message intersection | adopted | |
| D25 | Named object for unavailable content | adopted with change | the object exists at run time; one `contentDelivered` discriminant; DMs are a separate branch |
| D26 | Const-tuple options | adopted with change | nesting by construction; rules at every level; mapped tuples; opaque `ChatInputCommand<N, Invocation>` |
| D27 | Keep `exactOptionalPropertyTypes` | adopted | |
| D28 | `Effect.fn` per op, recovery outside | adopted | |
| D29 | Own fiber and span per event | adopted | plus `Effect.scoped` per event |
| D30 | CLI type-test runner | adopted | with the D2 gate |
| D31 | LSP hover snapshots | adopted | keep the `const x: ` prefix; add expectation comments; `ix` and commands snapshotted |
| D32 | Exact TypeScript 7.0.2 | adopted | M0 |
| D33 | Budget with `--checkers 1` | adopted | design numbers in §5.4; ceilings 250k/60k/1000 ms; per-command row |
| D34 | G9 table plus G10 registry | adopted | table schema 2 (level, preflightSet, categories, observation); full expectations; flip controls |
| D35 | Read degradation from the subject's create response | adopted | |

None is overridden. None of the orchestrator's fixed decisions is overridden.

---

## 8. Open questions only live runs (or Rhys) can answer

For each question: who decides it, and how the design stays correct whichever
way it resolves. "Constant" means one of `Observed.ts`, `ResolverRules.ts`,
`PayloadRules.mode`, `Limits`, `Operations` or `ErrorMap`. The replay test
fails if a constant disagrees with the table.

1. **Can bots be timed out, and what code follows (H-022, H-023)?**
   - Yes: `CommunicationDisabled` stays in the unions, and is attributed from
     state during preflight or recompute. (M3: yes; a timed-out bot's send
     answers 403 50013, H-023. Giving a timed-out member Administrator ends the
     timeout, so "administrator and timed out" is `admin-exempt`.)
   - No: the harness's timeout PATCH fails, the rows record
     `setup-unsupported: bot-not-timeoutable`, `Observed.botsCanBeTimedOut =
     false` removes the tag from every union, and the timed-out dimension
     becomes resolver-only in `LOG.md`.
2. **50001 vs 50013 for a missing View (H-080).** `level-vs-raw` checks the
   correspondence. If refuted, `Observed.codeForLevel` records the observed
   mapping; the recompute and our order still decide the tag. (M3: View and
   voice Connect answer 50001 and SendMessages 50013 as expected, but in a
   thread a missing SendMessagesInThreads, and a locked thread, answer 50001.
   M4: the code depends on the route, so `Observed.viewCodeFailures` lists, per
   operation, the first failures that answer 50001 at the action level: thread
   sends and edits, thread creation, forum posts, crossposts and role
   assignment; `Observed.expectedCode` applies it.)
3. **20016 for bots (H-053, C9).** `Observed.slowmodeAppliesToBots` defaults to
   false. If a slowmode row shows 20016, set it true; the interceptor already
   surfaces it. (M4: no. The subject without BypassSlowmode sent twice in a row,
   under three seconds apart, in `lab-text` under a 60 s slowmode, both 200 with
   no 429 (`send/targeted/slowmode-second-send`), so the constant stays false and
   `SlowmodeActive` stays out of the unions.)
4. **Embeds without EmbedLinks and TTS without SendTTS: error or silent drop
   (H-102, H-103)?** This decides `PayloadRules.mode`. (M3: embeds are refused
   with 50013; TTS is dropped, the message sent with `tts: false`, so M4 sets
   `tts` to `degrade`. M4: TTS degrades in text and voice text chat too, and
   SendPolls and a reply's ReadMessageHistory missing alone are refused, 50013
   and 160002, so `poll` and `reply` stay `error`.) The types move the flag
   between the error union and `degraded`, with no other change: limit tags
   key on presence (`[sd:probe2/q4/use.ts]`).
5. **Inner 50035 codes: strings or numbers (H-084)?** `FieldError.code`
   decodes both and normalises to a string.
6. **Premium buttons without a SKU.** Can the "no label" rule be observed
   differentially, by whether the `label` path appears in the field errors? If
   Discord rejects the unknown SKU first and never reports `label`, the agent
   stops and reports. Rhys decides, either by providing a SKU or by accepting
   resolver-only coverage. (M6 live: yes. With a SKU the application does not
   own, both buttons are refused for `BUTTON_COMPONENT_INVALID_SKU_UNAVAILABLE`,
   and only the labelled one also gets
   `BUTTON_COMPONENT_SKU_ID_LABEL_MUTUALLY_EXCLUSIVE` on its `label` path.)
7. **Content-length unit and limit (H-120, H-121; 2000 vs 4000).** These are
   `Limits.contentMax` and `Limits.unit`, set from the rows and checked by the
   replay. The probes are derived from them. (M6 live: 2000 non-BMP emoji,
   4000 UTF-16 units, were accepted, and 2001 refused with
   `BASE_TYPE_MAX_LENGTH` on `content`. `Limits.content` is 2000 and
   `Limits.unit` `code-point`. The M6 verifier: that pair did not settle the
   question, because a limit of 4000 UTF-16 units, the OpenAPI spec's, also
   accepts 2000 emoji and refuses 2001. The invalid side is now 2001 ASCII
   characters, 2001 units in every count, which a 4000-unit limit accepts and
   only a 2000 limit refuses; with the valid side, which a UTF-16 count of 2000
   refuses, only 2000 code points fits both answers. The probe sides follow
   `Limits`: `unitString` for the valid side, ASCII for the invalid one. Live,
   Discord refused the 2001 ASCII characters with `BASE_TYPE_MAX_LENGTH` on
   `content`, so the question is decided: 2000 code points.)
8. **Is `app_permissions` exact, including timeouts (H-026)?** Interaction
   preflight uses it. If it is not exact, the recompute still attributes the
   right tag; only the preflight is less early. Verifying this needs a human, so
   it goes on the phase-3 checklist. (M9: item `app-permissions` of
   `harness/main.ts checklist`, LOG.md "Waiting for Rhys".)
9. **Does the permission endpoint exist, and does it apply timeouts or masks
   for bots (H-240, H-241)?** It is compared with `missingBeforeMasks`
   (implicit=false). If it reflects timeouts, `OracleScope.includesTimeout` adds
   the timeout mask to the comparison. If it is unavailable, the header says so
   and flip controls carry the blame check. M2: the route exists; it answered
   for every lab channel and thread, and a positive control (the target in
   `lab-text`) returned exactly `lab-target`'s overwrite allow. M3: it **does**
   apply the timeout mask (H-241: a timed-out subject reads only View and
   ReadMessageHistory of what it is granted), so M4 adds
   `Observed.oracleAppliesTimeout` (the constant the text above calls
   `OracleScope.includesTimeout`), and agreement compares the oracle after the
   timeout mask; the ten M3 rows agree.
10. **Do rejected command creates count toward 200 per day (H-205)?** Negative
    tests use one command name, a local daily counter aborts at 150, and
    `LOG.md` records the before/after GET counts.
11. **Which server defaults appear on stored commands?** These are recorded in
    `fixtures/commands-canonical.json` on M8's first run, and `Canonical.ts`
    drops or normalises exactly those.
12. **Components-only messages; SuppressNotifications on interaction
    responses; ping-on-reply content (PROMPT vs docs, §17 items 9-11).** The
    rows decide; if a components-only message is rejected, components are
    removed from `NonEmpty` and the fixture snapshot changes deliberately.
13. **Thread and voice rules: voice text chat needing Connect (H-152, H-153,
    H-159), unarchive permission conflicts (H-038, H-039), sending in archived
    threads (H-035), private-thread visibility (H-033, H-047).** These are
    `Operations` and `ResolverRules` entries. If archived sends fail,
    `ThreadArchived` is added to the `thread.send` row. (M4: everything in
    voice text chat needs Connect, and it has no pins at all (50019); an
    archived thread refuses edits, deletes, reactions and pins but accepts
    joining, leaving and adding a member; unarchiving needs
    SendMessagesInThreads and no ManageThreads; a thread's creator may archive,
    lock and delete it without ManageThreads; LOG.md has the rows.)
14. **Does the gateway honour `capabilities` from the G7 codec (H-160)?** The
    obfuscation scenario checks it. If not, the run fails, and the fallback is
    the portal toggle (D20's alternative), which is Rhys's decision.
15. **AutoMod on bot messages.** No lab AutoMod rule exists, so it is not in
    the unions. An observed 200000 or 200001 is an unmapped defect until it is
    added to the table through `Observed.ts`.
16. **2FA (`mfaLevel`).** If Perms Lab is `mfaLevel = 0`, `TwoFactorRequired`
    stays in the unions as a documented, resolver-only tag. M2: Perms Lab is
    `mfaLevel = 0`.
17. **The DM content exception (PROMPT: "Verify these exceptions live").** A
    bot cannot open a DM with another bot, and the harness must never DM Rhys.
    Verifying it needs a human DM. Escalated to Rhys through `LOG.md` and the
    orchestrator; the rule's remainder is `escalated` (§5.5), shown as an unmet
    Done criterion until Rhys decides (a human DM, or accepting resolver-only
    coverage). (M9: step 4 of the checklist, `harness/main.ts checklist`, LOG.md
    "Waiting for Rhys".)
18. **Handler-side delivery of option values and component clicks (phase 2).**
    The bot-only halves are live (registration readback with a rejected
    mistyped choice; the custom_id round trip through a create response). A
    handler receiving a real invocation or click needs a human. Offline tests
    decode recorded interaction payloads. Escalated like 17. (M9: items
    `option-values` and `click-data` of the checklist; offline,
    `test/unit/interactions-wire.test.ts` and `interactions-runner.test.ts`.)
19. **Reaction removal and overwrite editing.** Out of phase-1 scope in this
    design (§2.4). If Rhys wants them in phase 1, they are new table rows with
    their own families (H-144, H-070).
20. **Cross-host fencing.** The lock is host-local, and the workspace also
    exists on the MacBook. Live commands are run only on `minisforum`. If Rhys
    wants a fence across hosts, it would need a Discord-side lease (for example
    a `lab-lock` channel topic), which this design does not add.
21. **Role assignment and the target's rank (H-061).** The table assumes it
    does not matter. If the matrix shows it does, `TargetAboveInHierarchy` is
    added to the role rows and the resolver rule flips.
22. **DM delivery under the DM intents (after the M7 verifier).** `EventIntents`
    lets `bot.on("MESSAGE_CREATE")` compile with DirectMessages,
    `MESSAGE_REACTION_ADD` with DirectMessageReactions and `TYPING_START` with
    DirectMessageTyping, but the live intent pairs verify only the guild intents:
    a bot cannot DM another bot (H-158) and the harness never DMs Rhys. Verifying
    the DM half needs a human to message, react and type in a DM with the subject.
    Escalated like 17: the remainder of `R-intent-guild-messages`,
    `R-intent-reactions` and `R-intent-typing` is `escalated` (§5.5), an unmet Done
    criterion until Rhys decides (a human DM session, or accepting the DM branch as
    typed and unit-tested through the fake gateway). The alternative, dropping the
    DM intents from `EventIntents` until they are verified, would make a DM bot
    impossible to write. (M9: steps 4 and 5 of the checklist, with the DM intents and
    without them before a canary.)

---

## Appendix A. Evidence index (`.scratch/design/`)

| File | Proves |
|---|---|
| `src/Snowflake.ts`, `src/fail/ids.ts` | brands; mixing diagnostics |
| `gen-errors.ts`, `src/errors/Missing.generated.ts`, `src/errors/Other.ts`, `src/Cause.ts` | generated classes, causes (incl. `NoResponse`), taxonomy classes |
| `src/ops.ts` | the operation table, derived lookups, typed variant constructors, `errorFor` |
| `src/errors-types.ts`, `errors-runtime.ts` (`errors-runtime.txt`) | categories and narrowing; runtime markers, causes, `errorFor` variants |
| `src/payload.ts`, `src/channels.ts`, `src/channels-use.ts` | payload rules (incl. unions), components, channel kinds, SendMethod, require, authorship, limits, DMs |
| `src/members.ts` | member ops, role vs target hierarchy, limits |
| `src/bot.ts`, `src/bot-use.ts`, `src/fail/bot.ts` | intents, content typing, DM branch, received-message unions, the category boundary |
| `src/commands.ts`, `src/commands-use.ts`, `src/fail/commands.ts` | command rules at every level, option typing, opaque command type |
| `src/interactions.ts`, `src/interactions-use.ts`, `src/fail/interactions.ts` | routes, modes, validated responses, nominal Completed, giveUp, context |
| `src/example.ts`, `src/fail/example-leak.ts` | the end-to-end bot and its boundary |
| `src/impl-boundary.ts` | overload trust boundary, runtime flag mirror, `errorFor` |
| `src/identities.ts` | identity wiring: shared client outside fresh, subject from the bot layer, `Bot.layer` needs nothing |
| `src/observed.ts` | observed-tag mechanism |
| `src/verify.ts`, `pairwise.ts` (`pairwise.txt`), `truth-runtime.ts` (`truth-runtime.txt`) | DSL, registry, truth table v2, validity predicates, determinism |
| `check-fail.ts` (`fail-diagnostics.txt`) | the §5.2 gate over all 64 diagnostics |
| `lsp-hover.ts` (`hover.txt`) | editor hovers |
| `tsconfig.example.json`, `tsconfig.errors.json`, `budget/` (`budget.txt`) | compile costs, per-command cost |
| `probe2/this-send.ts`, `probe2/hover-ops.ts`, `probe2/hover-degraded.ts` (`probe2/hover-probes.txt`) | generic-`this` send on unions; hover of lookups vs aliases |
| `probe2/ix-reg.ts`, `probe2/ix-reg2.ts` (`probe2/probe-output.txt`) | registration shapes: arity overloads vs same-arity overloads; string mode keeps `ix` typed |
| `probe2/variant-table.ts` | a missing D5 override is a compile error |
| `probe2/q4/` | limit tags independent of PayloadRules mode |
| `probe2/rt/route-codec-json.ts` (`route-codec-runtime.txt`) | route round trips through `toCodecJson` |
| `probe2/rt/refresh-generation.ts` (`probe2/rt/refresh-generation.txt`) | refresh does not overwrite a newer gateway update |
| `v1-src/`, `v1-DESIGN.md` | revision 1, for the review log |

---

## Appendix B. Review log

Every finding from the three reviews of revision 1, with its disposition.
"Fixed" means the change is in this document and, for type-level changes,
compiled in the cited scratch file. Reviewer evidence was re-run before the
change: the hole files compile (`tsc` over `[rt:holes/]` exits 0 apart from the
two files with expected errors), and the runtime probes reproduce
(`[re:runtime-races.txt]`, `[re:variant-runtime.txt]`,
`[re:layer-seams-runtime.txt]`, `[rt:holes/h7-route-codec-runtime.ts]`,
`[sd:review/pairwise-rows.ts]`).

### Types and DX (23)

| # | Sev. | Finding | Disposition |
|---|---|---|---|
| T1 | major | Payload union loses error members (`keyof` of a union) | **Fixed.** `MayHave`, `MayBeTooLong`, `MayBeEmpty` distribute; `true extends` tests; `MessagePayload` pass assertion (§2.3; `[sd:src/channels-use.ts]` §3) |
| T2 | major | Signatures drift from the taxonomy; overloads hide it | **Fixed.** One operation table drives every union (`OpErrors<G>[Op]`); the five omissions fixed; per-op `Equals` type test; `op-errors.test.ts` (§2.4, §4.7; `[sd:src/ops.ts]`) |
| T3 | major | Limits only for content/embeds/custom_id/bulk count | **Fixed.** Name, topic, slowmode, nickname, timeout and poll limit tags by the same literal rule; own edit gets `EmbedTooLarge` and `MessageEmpty`; 50035 paths mapped; live limit rows (§2.4, §2.6, §3.1, §4.9) |
| T4 | major | Interaction payloads skip payload rules and limits | **Fixed.** Responses validated locally and returned as Effects; `ReplyPayload` checked (`NonEmpty`, keys, ephemeral); limits on followUp and editOriginal (§2.10) |
| T5 | major | `ix` silently `any` under `Effect.fn` | **Fixed** with a different spelling: mode as a string argument and arity-only overloads. The reviewer's object-literal overloads were not adopted because same-arity overloads report the wrong overload's error (`[sd:probe2/ix-reg.ts]` L45). Effect.fn pass and fail fixtures (§2.10) |
| T6 | major | Deferral forces `Effect.die` or a forged Completed; M10 grep misses `die` | **Fixed.** Nominal `Completed`; `deferred.giveUp(expired)`; M10 grep covers `die`, `dieMessage`, `orDie`, `orDieWith` (§2.10, §6 M10) |
| T7 | major | Inline `row(...)` literals bypass three rules; 998-character diagnostic | **Fixed.** `row([...])` with per-element checks and the rule-4 select test; largest diagnostic 534 characters (§2.3) |
| T8 | major | Command rules only at top level | **Fixed.** `Ordered` and names at every level; 25-limit on subcommands; nested fail fixtures (§2.8) |
| T9 | major | Union receiver traps: method spelling and require + `Channel.send` | **Fixed.** One shared generic-`this` `SendMethod`; `Channel.send` removed; require on a union composes (§2.4; `[sd:probe2/this-send.ts]`) |
| T10 | major | Boundary message truncates leaked tags | **Fixed.** The message names categories plus uncategorised tags. A global ban of `... N more ...` was not adopted, because the user's own Effect type in the same diagnostic legitimately truncates; the ban applies inside message-carrying types (§2.7, §5.2) |
| T11 | major | `ix` and commands hover as the option tuple | **Fixed.** Opaque `ChatInputCommand<N, Invocation>`; `ix` and the command in hover snapshots (§2.8, §5.3) |
| T12 | major | No `crosspost` on received messages | **Fixed.** `OwnMessages<K>`/`ForeignMessages<K>` distribute; narrowing reaches `crosspost` (§2.5; `[sd:src/bot-use.ts]` §6) |
| T13 | major | No DM kind; DM events cannot be described | **Fixed.** `"dm"` kind, `DMChannel`, guild/DM branches by intent, DM content typed `string` (§2.4, §2.7) |
| T14 | major | Route encoding breaks Date, BigInt, Set | **Fixed.** Always through `Schema.toCodecJson`; schemas without services; round-trip test (§2.9; `[sd:route-codec-runtime.txt]`) |
| T15 | minor | Interactions lack guild, user and channel | **Fixed.** `InteractionContext` with basis `app-permissions` (§2.10, §4.7) |
| T16 | minor | `Handled` does not implement D6 | **Fixed.** `Unhandled` per D6; `Flaky` fail fixture (§2.7) |
| T17 | minor | `EmbedTooLarge` follows the mode, not presence | **Fixed.** `MayInclude` presence; compiled under a flipped mode (§2.3; `[sd:probe2/q4/use.ts]`) |
| T18 | minor | Content-emoji degradation untyped | **Fixed.** `externalEmojiInContent` degrade rule; readback compares emoji tokens; resolver-only live (§2.3, §4.12) |
| T19 | minor | Option-order diagnostic 851 characters | **Fixed.** Message on the `required` property: 241 characters (§2.8) |
| T20 | minor | `catchCategory` strictness and cascades | **Rejected.** Catching an absent category is a deliberate compile error, like `catchTag`, and the boundary message lists exactly the present categories; the cascade appears only after a primary error, and fixtures isolate one violation with a `@valid` twin |
| T21 | minor | Command cost superlinear | **Fixed.** Mapped-tuple checks; about 2.2k instantiations per 25-option command (was about 6.2k); per-command budget row (§2.8, §5.4) |
| T22 | minor | Template-pattern names falsely rejected | **Fixed.** `IsFiniteLiteral` in `CheckName` (§2.8) |
| T23 | minor | DX friction in a realistic bot | **Fixed** except one item: branded event IDs, reaction emoji and guildId, `authorIsBot`, no mandatory options argument, replies are Effects (no `Effect.succeed`), `Channels.isMessageChannel`. **Rejected:** `ix.recover(...)`, because `catchCategory(..., () => ix.reply(...))` is now direct |

### Live Discord (20)

| # | Sev. | Finding | Disposition |
|---|---|---|---|
| L1 | blocker | Members generator emits kick/ban rows that would succeed; guard on the wrong identity | **Fixed.** Validity predicate from the docs model (never `missing=none` with the target below; timeouts not relied on); guard on every identity with harness-side reads; offline Safety test (§5.6, §5.9; `[sd:pairwise.txt]`) |
| L2 | blocker | Wait, replay and oracle assume the subject can mirror hidden state | **Fixed.** Subject-observable projection for wait, Materialize and replay; obfuscated rows compare only View with the oracle; 50001/10003 in refresh is evidence, not a defect (§3.1, §4.5, §5.8, §5.10) |
| L3 | major | @everyone rows with MentionEveryone granted | **Fixed.** MentionEveryone never granted in any @everyone row; Safety on the materialized state for (c) and (d) (§5.6, §5.9) |
| L4 | major | Order vs Agreement vs dedicated codes | **Fixed.** `preflightSet`; agreement accepts a mapped tag in the set; dedicated codes through the recompute; non-adjacent ordering pairs (§3.2, §5.10) |
| L5 | major | Both fail for different reasons and agree | **Fixed.** `level-vs-raw` makes H-080 a checked correspondence, with `Observed.codeForLevel` if refuted (§5.10) |
| L6 | major | `CommunicationDisabled` missing from many ops; no timed-out dimension | **Fixed.** In every row the timeout mask affects; `memberState` in every family except administrator (§2.4, §5.9) |
| L7 | major | AddReactions needed only for a new emoji | **Fixed.** Type keeps it; preflight conditional on decoded reactions; recompute fetches the message (§4.7) |
| L8 | major | Role assignment compares the wrong ranks | **Fixed.** `RoleAboveInHierarchy` by role position; `roleRank` dimension; both managed roles placed (§2.6, §4.6, §5.7, §5.9) |
| L9 | major | Connect never required or removed | **Fixed.** `voice.*` rows require Connect; `connect` missing value; H-152/153/159 rows; per-(op, flag) coverage in rules-check (§2.4, §4.7, §5.5, §5.9) |
| L10 | major | Thread membership uncontrolled | **Fixed.** Private-thread visibility mask; `subjectThreadMember` in Setup; reset restores it (§4.6, §5.7, §5.8) |
| L11 | major | Messages family has no rows | **Fixed.** Messages family (22 rows) plus H-141, H-143, H-146, H-147 targeted rows (§5.9) |
| L12 | major | State not restored between rows and runs | **Fixed.** Channel settings and target state in Setup and cleanup; IDs persisted; archived threads enumerated; scenario threads named `lab-*` (§5.7, §5.8, §5.10) |
| L13 | major | Invalid non-send rows; rename rate limit | **Fixed.** Validity predicates per family; slowmode-only pairwise edits; one name/topic edit per channel per run; raw deadline is an infrastructure abort (§5.9, §5.10, §5.11) |
| L14 | major | Not-live exemptions nobody granted | **Fixed.** Bot-only observations for routing, options and MentionEveryone; DM and handler delivery escalated (Q-17, Q-18), shown as unmet Done criteria; allowlist by rule id (§5.5, §8) |
| L15 | major | rules-check checks only registered rules | **Fixed.** Every fail directive must be claimed; kind-absence pairs; guild-sticker pair redefined (50081); events limited to those with live pairs (§5.5) |
| L16 | minor | Administrator × timed-out rows depend on order | **Fixed.** Excluded from pairwise; targeted with a fixed order; `setup-unsupported` reason codes (§5.8, §5.9, §5.12) |
| L17 | minor | Target loses permissions to @everyone denies | **Fixed.** `lab-target` role-overwrite allow on every lab channel; offline check (§5.7) |
| L18 | minor | Lock and guard only in the harness | **Fixed.** Lock in `Credentials` for any identity and entry point; guild check on `SubjectRaw` and `TargetRest` (§4.3, §5.6) |
| L19 | minor | Auto-archive, timeout length, hard-coded 2001 | **Fixed.** Auto-archive 10080; probes derived from `Limits`. The fixed timeout length is set by Converge to 10 minutes and lifted explicitly in cleanup and reset (§5.7, §5.9) |
| L20 | minor | Kinds and ops without rows; missing ops | **Fixed.** `lab-media` and createPost rows; announcement-thread in send; reaction removal and overwrite editing recorded as out of phase-1 scope (§2.4, §5.7, §8 item 19) |

### Effect architecture (19)

| # | Sev. | Finding | Disposition |
|---|---|---|---|
| E1 | major | Production subject composition unreachable; `Layer.fresh` duplicates shared services | **Fixed.** `Bot.layerWith` with the platform open; internal `SubjectRaw` from the same build; shared client outside fresh; identity test from exported layers, re-run in M7 (§2.7, §4.2; `[sd:src/identities.ts]`) |
| E2 | major | No check that identities are who they claim | **Fixed.** App IDs, distinct users, READY user, sent intents, Perms Lab name and channels (§4.4) |
| E3 | major | The user-facing operation never runs in enforce mode live | **Fixed.** Step (b) runs the real operation over the `DryRun` stub; `preflight-wiring` class (§5.10) |
| E4 | major | Same-tag variants: runtime builds the base class | **Fixed.** Typed `variantConstructors` and `errorFor`; categories recorded; generated runtime mirror (§2.2, §4.7; `[sd:errors-runtime.txt]`, `[sd:probe2/variant-table.ts]`) |
| E5 | major | Nothing checks which flag is blamed; replay circular | **Fixed.** Flip controls mandatory; rules-check flag coverage; oracle unavailability is a run-level header value; the replay is described as a regression check (§5.5, §5.9, §5.13) |
| E6 | major | Ordering contradiction | **Fixed** (same as L4), decided in §3.2 |
| E7 | major | Registry expectations too weak | **Fixed.** Full observations per side; `observation` column; shared Setup asserted (§5.5, §5.12) |
| E8 | major | MentionEveryone degrade rests on absence only | **Fixed.** `lab-unmentionable` positive control; `unmentionableRole` rule in `PayloadRules` (§2.3, §5.5, §5.7) |
| E9 | major | `EventAbsent` without a positive control | **Fixed.** READY and a canary per session; sent intents recorded; target as the trigger (§5.10) |
| E10 | major | Auto-defer interrupts or misdelivers | **Fixed.** Fork + timed join; modes fix the deferral type and ephemeral state; M9 asserts routes and flags (§2.10, §4.14) |
| E11 | major | Refresh overwrites newer gateway state | **Fixed.** Per-entity generations; idempotent reducer; deterministic test (§4.5; `[sd:probe2/rt/refresh-generation.txt]`) |
| E12 | major | Fail fixtures pass for the wrong reason | **Fixed.** TS code in directives; wrong-reason codes rejected; `@valid` twins (§5.2; `[sd:check-fail.ts]`) |
| E13 | major | Phase-2 rules mislabelled phase 3 | **Fixed** (same as L14) |
| E14 | minor | D6 not implemented in `Handled` | **Fixed** (same as T16) |
| E15 | minor | No per-event scope | **Fixed.** `Effect.scoped` per event and a unit test (§4.14) |
| E16 | minor | Transient tags lack causes; startup transient reason | **Fixed.** `cause` on every transient tag, `NoResponse`; `discord-unavailable` (§2.2, §4.4) |
| E17 | minor | Deadline interrupts a POST that may have landed | **Fixed.** Outcome-unknown documented; no retries of non-idempotent calls; harness abort and cleanup by author (§4.10, §5.10) |
| E18 | minor | Lock and determinism weaker than stated | **Fixed** in part: the fresh-process `--compare` gate; the lock in every entry point; stale takeover by rename. **Not fixed:** cross-host fencing; live runs are confined to `minisforum` and the limit is open question 20 |
| E19 | minor | Registration-diff evidence circular and narrow | **Fixed.** Writes counted at the base client; per-field mutation property test; GET after write (§4.14, §5.10) |
