# effect-discord-perms

A typed layer over [dfx](https://github.com/tim-smart/dfx) (Effect v4) in which the compiler catches the mistakes
Discord bots usually find at runtime: missing permissions, payload rules, intents, mixed-up IDs, and command and
component definitions. Every compile-time rule that live Discord can show is checked against it in both directions: a
valid case and an invalid case run on one setup, and each side's outcome must match its recorded expectation. That is
usually Discord accepting the valid side and, on the invalid side, refusing the request, ignoring or applying one of
its fields, or not delivering an event, with two exceptions: `R-premium-no-label`'s valid side is refused, only because
the test guild's application owns no SKU, and `R-registration-diff` counts registration writes (none for unchanged
definitions, one for a changed one). "How it is verified" says which rules cannot be checked live, and why.

## The guarantee

The types guarantee that every failure is handled. They do not guarantee that any call succeeds. Discord owns the
permission state, and it can change between a check and a request. Every operation therefore returns an `Effect` whose
error channel names each way it can fail, and a handler compiles only if every non-`transient` failure is handled,
either by tag or category or by an explicit, greppable `Effect.orDie`.

## A small bot

From the reference bot, [`examples/reference-bot/bot.ts`](examples/reference-bot/bot.ts), which turns no library
error into a defect (no `orDie`, no `die`). The quote is abridged: the `export`s and doc comments are dropped, and so
are the bot's in-memory poll store (`Polls`, a service), `pollEmbed`, and its READY and vote handlers. Every line shown
is as it is in the file. The command's options are typed from its definition: `question` is a `string`, and `where` is
an optional `TextChannel | AnnouncementChannel`.

```ts
const bot = Bot.make({ intents: ["Guilds", "GuildMessages", "MessageContent"] })

const poll = Command.chatInput({
  name: "poll",
  description: "Ask a yes/no question",
  options: [
    { type: "string", name: "question", description: "What to ask", required: true },
    { type: "channel", name: "where", description: "Channel to post in (this one if absent)", channelTypes: ["text", "announcement"] }
  ]
})
const vote = ComponentRoute.make("vote", Schema.Struct({ poll: Schema.Int, choice: Schema.Literals(["yes", "no"]) }))

const onMessage = bot.on("MESSAGE_CREATE", (event) =>
  event.message.author === "self" || event.message.authorIsBot || event.message.content !== "!ping"
    ? Effect.void
    : event.channel.send({ content: "pong" }).pipe(catchCategory(["permission", "state"], (error) => Effect.logWarning(`cannot answer !ping: ${error._tag}`)))
)

const onPoll = Interactions.command(poll, "ephemeral", (ix) =>
  Effect.gen(function* () {
    const { question, where } = ix.invocation.options
    // optional: checked up front, so a poll the bot cannot post is never opened
    const channel = yield* Permissions.require(where ?? ix.channel, ["SendMessages", "EmbedLinks"])
    const polls = yield* Polls
    const n = yield* polls.open(question)
    const yes = yield* vote.customId({ poll: n, choice: "yes" })
    const no = yield* vote.customId({ poll: n, choice: "no" })
    const sent = yield* channel.send({
      embeds: [pollEmbed({ question, votes: new Map() })],
      components: [
        row([
          { kind: "button", style: "success", label: "Yes", customId: yes },
          { kind: "button", style: "danger", label: "No", customId: no }
        ])
      ]
    })
    return yield* ix.reply({ content: `Posted poll ${n} (message ${sent.message.id}).`, ephemeral: true })
  }).pipe(
    // first: a missing flag (EmbedLinks is a permission and a payload error: the poll needs its embed) or a state
    catchCategory(["permission", "state"], (error) => ix.reply({ content: `I can't post the poll there (${error._tag}).`, ephemeral: true })),
    // then what is left of payload: a question too long for the embed's title, or a reply too long
    catchCategory("payload", () => ix.reply({ content: "That poll does not fit in a message.", ephemeral: true }))
  )
)
```

Leave a dynamic reply's limits unhandled and the program no longer compiles (snapshot text, as `tsc` prints it):

```
Property '"unhandled errors: catchCategory these categories (catchTag these tags), or use Effect.orDie"' is missing in type 'Effect<Response<never>, ContentTooLong | MessageEmpty, never>' but required in type 'UnhandledErrors<"payload">'.
```

The other rules read the same way, each in a line or two:

```
Argument of type '"GUILD_MEMBER_UPDATE"' is not assignable to parameter of type '"GUILD_MEMBER_UPDATE" & MissingIntent<"GuildMembers">'.
Property 'send' does not exist on type 'ForumChannel<never>'.
Property 'showModal' does not exist on type 'CommandInteraction<{ readonly options: { readonly user: ResolvedUser; }; }, "public">'.
Type 'true' is not assignable to type 'true & Invalid<"required option feature must come before every optional option">'.
```

## Design

The full design is [`docs/DESIGN.md`](docs/DESIGN.md); the research behind it is in [`docs/research/`](docs/research).
In brief:

- **On top of dfx, never a fork.** dfx is the REST and gateway client. The library wraps it at a few seams: the base
  `HttpClient` (coded 429s), a per-call deadline around each dfx call (`src/rest/Request.ts`, so it bounds dfx's retries
  too), a JSON codec that adds the gateway's channel-obfuscation capability, the permission endpoint, and its own
  interaction runner and command registration. Each deviation is in `LOG.md`.
- **Errors are values with categories.** Each Discord failure has its own `Schema.TaggedError` class: one generated
  `Missing<Flag>` per permission flag, and `ThreadLocked`, `ThreadArchived`, `CommunicationDisabled`,
  `TargetAboveInHierarchy`, `ContentTooLong`, `MessagesTooOld`, `InteractionExpired` and the others the live matrix
  showed are distinct. Each carries the raw Discord response (code, message, route template) as its `cause`. Errors
  belong to one or more categories (`permission`, `payload`, `access`, `state`, `transient`), applied by a mixin
  (`withCategory`, or `CategorizedError`, which is `Schema.TaggedError` with the mixin applied) and caught with
  `catchCategory`, which removes exactly that category's members from the type, as `catchTag` removes exactly its
  tag. Its categories are written as literals: a category typed as a union, or a list typed wider than a tuple (or as a
  union of tuples), is a compile error, because the type would remove categories the run time does not catch
  (`catchTag` has the same property for a tag typed as a union; `DESIGN.md` §2.2 names the one mixed form not caught).
  There are no string checks in the public API.
- **The permissions come from the types.** An operation's error union is computed from one operation table and from
  the payload's type: embeds add `MissingEmbedLinks`, files `MissingAttachFiles`, a reply
  `MissingReadMessageHistory`, a poll `MissingSendPolls`; in a thread, `SendMessagesInThreads` replaces
  `SendMessages`. A literal reply within the limit cannot be too long, so its `ContentTooLong` is absent; a dynamic one,
  or a literal over the limit (tsc counts its code points), carries it, and so for names, topics and nicknames. When
  several flags are missing the call fails with the most fundamental one: ViewChannel, then Connect in voice, then the
  timeout, then SendMessages (or SendMessagesInThreads), then the payload's flags.
- **Preflight, then the request, then the recompute.** Before a request the library resolves the bot's permissions
  from its gateway state (in an interaction, from `app_permissions`, which is exact). If a required flag is missing it
  fails without sending. If Discord still answers 50013 or 50001, it refreshes the channel and member state,
  recomputes, and fails with the specific tag, or with `PermissionDeniedUnattributed` when the recompute finds nothing
  missing. It never guesses. Some missing permissions degrade instead of failing (`@everyone` without MentionEveryone
  pings nobody; TTS without SendTTSMessages sends a plain message); those are a typed `degraded` field on the result,
  read back from Discord's own answer. A custom emoji Discord rewrote to text is reported as `UseExternalEmojis`
  whatever the cause: Discord also rewrites one the bot cannot use at all with the flag held (live: a made-up emoji
  ID).
- **Channels are a union by kind**, and operations exist only where Discord allows them: no `send` on categories or
  forums (forums have `createPost`), `crosspost` only in announcement channels, thread operations only on threads.
  Messages carry their author: `edit` exists only on the bot's own, and deleting another's adds
  `MissingManageMessages`. IDs are distinct branded snowflakes. `Permissions.require(channel, flags)` is optional: it
  narrows the calls that follow, where a checked flag lost before the request is `PermissionRevokedSinceCheck`.
- **Intents type the events.** The intents are written as a literal list of literals (`Bot.make({ intents: [...] })`;
  a list typed `ReadonlyArray<Intent>`, an element typed as a union and a conditional spread are compile errors,
  because the types read the intents off the list's type). `bot.on` accepts only events the declared intents deliver,
  and `message.content` is a `string` only where Discord delivers it (with MessageContent, and without it for the bot's
  own messages, mentions of the bot and DMs); elsewhere it is the frozen `ContentUnavailable` value until
  `contentDelivered` narrows it. Each event runs in its own fiber, scope and span, and a failing handler never stops
  later events.
- **Commands and components.** Command definitions are checked as written (lowercase names of 1 to 32 characters,
  required options first, at most 25, the subcommand nesting rules, at every level, and only the keys each option type
  takes: `choices` on a boolean option is an error, and Discord, live, accepts such a key and drops it), handler
  options are typed from the
  definition (choices as literal unions, channel options narrowed to the allowed kinds), and commands are registered
  in a guild only when their stored definitions differ. A `custom_id` is built by a schema-typed `ComponentRoute`
  (checked against the 100-character limit when built), and a handler receives its decoded data; an old control whose
  ID no longer decodes is answered "This control has expired." A command or route registered twice on one bot is a
  defect at registration, since both handlers would answer.
- **Interactions are a value-level state machine.** Discord is answered once, with the response the handler returns; a
  second response the handler made (`yield* ix.reply(a)` before `return yield* ix.reply(b)`) is never posted, and the
  runner logs it at Error. Follow-ups exist only inside the continuation that receives `Answered`; `showModal` exists
  only before answering and never after a modal submit; autocomplete can only answer with choices. The defer mode is
  fixed at registration, a reply's ephemeral state follows it (a reply that omits `ephemeral` is private in
  "ephemeral" mode), and the runner defers before Discord's 3-second limit without interrupting a slow handler.
- **The handler boundary.** Handlers registered with `bot.on` and `Interactions.*` may leave only `transient` errors
  unhandled; an error type widened to a categorised supertype (`Categorized<never>`, or `Categorized<"transient">`,
  which may stand for an error that is also `state`) counts as unhandled. The compile error names the categories that
  remain (`UnhandledErrors<"access" | "permission">`), not a wall of tags, and a handler that returns no Effect says so.

### `RequestTimedOut`: the outcome is unknown

Every REST call has a deadline (30 s by default, `DiscordApiConfig`), which also bounds dfx's unbounded retry of
uncoded 429s. When it passes, the call fails with `RequestTimedOut` (transient) and the request is interrupted, but
it may already have reached Discord. For a call that is not idempotent (a send, a post, a crosspost, a bulk delete)
Discord may have applied it, so retrying after a `RequestTimedOut` can duplicate it. The library never retries a
non-idempotent call itself; a caller that retries should first check whether the effect already happened.

## How it is verified

`bun run verify:offline` (no Discord) runs, in order: the error generator's check, `tsc`, the unit tests and the
offline replay of the truth table, the type tests, the hover snapshots, the rule registry check and the compile
budget. `bun run verify:live` runs the live matrix against a test guild and rewrites the truth table.

- **The live matrix** sets up a state through an administrator bot (channels, roles, overwrites, threads, timeouts),
  then the bot under test computes its permissions with the resolver, runs the library's preflight, makes the raw
  call with no check, and runs the library's own operation. Its outcome class is recorded (`success`, `50013`,
  `50001`, another code, or a degradation read back from Discord). 566 scenarios cover channel kinds (text,
  announcement, voice and stage chat, forum posts, public, private, archived and locked threads), permission sources
  (`@everyone`, roles, role and member overwrites allowing and denying, Administrator), timeouts, the role hierarchy,
  every operation and every payload variant Perms Lab can exercise (external emoji and stickers excepted, which need a
  second guild; the external-emoji rule has rows on the bot's own setup, which `LOG.md` records), the intents, command
  registration and `custom_id` routing. A run reports zero
  mismatches, and two runs in separate processes write byte-identical tables (`fixtures/truth-table.json`). What
  Discord did where it differs from its documentation is in `LOG.md`, "Live findings".
- **Every compile-time rule** (`test/rules.ts`, 71 rules) has a valid case that compiles and an invalid case that
  fails with a snapshotted diagnostic. A diagnostic must have the expected TS code, mention the rule, fit in 4 lines and
  800 characters, contain neither `parameter of type 'never'` nor `type 'never'.`, and truncate no message type. Every
  rule that can be checked live, 56 of the 71, also has a live pair: both sides run on one identical setup, and each
  side's outcome matches its recorded expectation. The valid side is accepted, delivered or applied (for
  `R-registration-diff`, no registration write), with one exception:
  `R-premium-no-label`'s valid side is a raw unlabelled premium button, which Discord refuses only because Perms Lab's
  application owns no SKU, with no label error. The raw invalid side shows the different outcome the rule predicts: for
  43 pairs a refusal with the expected status, code and field; for 7 a field Discord ignored or applied (TTS, the two
  mention rules, the two create-only flags, message content, and an option key on a type that does not take it, which
  Discord accepts and drops); for the 5 intent rules an event that does
  not arrive before a canary that does; and for `R-registration-diff` a registration write. The other 15 rules have no
  live pair: 5 are pure typing (such as `catchTag` removing exactly its tag), 8 are the phase-3 interaction rules,
  which need a human to click, and 2 (external emoji and stickers) need a second guild. Seven of the live pairs have a
  part that is not live: six wait for Rhys (a DM, a real command invocation, a click: Q-17, Q-18 and Q-22), and one
  would ping `@everyone`. Two checks inside live pairs are typed only: an interaction reply's at most 5 action rows (an
  interaction needs a human) and an empty name (the lab guard sends only lab-named channels and threads). For a
  slowmode that is not a whole number of seconds the library is stricter than Discord on purpose: Discord accepts 1.5 and
  stores 1, so the library refuses it before sending (`LOG.md` records each).
- **Hover snapshots** check that the editor shows named types (`CommandInteraction<{ readonly options: {...} },
  "ephemeral">`, `Effect<Sent, MissingViewChannel | ...>`), never the internal machinery.
- **The compile budget** (`bun run budget`) compiles the reference bot as a consumer of this package compiles it: by
  name, through the package's `exports`, which point at the source, so the library is checked with it (the budget
  fails if the import resolves anywhere else). The hard ceilings are 60,000 types, 250,000 instantiations and
  1,000 ms, with +2% regression gates against the committed baseline (59,620 types, 178,499 instantiations). After the
  final audit's fixes (both rounds) the bot costs 59,508 types, 178,394 instantiations and about 250 ms, of which its
  own code is about 3,700 types; the rest is the library. That is within budget, but only 492 types under the Types
  ceiling: it was 76,573 types before the library's types were rewritten to cost less without changing what a user
  sees (`docs/DESIGN.md` §2.12 rule 10). A second row holds the cost of one 25-option command with its handler (about
  2,200 instantiations; 44,047 for the probe's 20, 62 under its +2% gate), so superlinear growth cannot hide.

What is not verified live, and why, is in `LOG.md`: the phase-3 interaction checklist needs a human to click through
it (an interaction reply's row limit with it), the DM content and DM delivery exceptions need a human's DM, the external
emoji and sticker rules need a second guild (on the bot's own setup Discord rewrites a made-up emoji with or without
UseExternalEmojis and keeps an application emoji, so neither shows the flag), an empty name is never sent because the
lab guard admits only lab names, and successful kicks and bans are verified by the resolver alone (a kicked bot would
need re-inviting).

## Running it

- `bun run verify:offline`: everything that needs no Discord.
- `bun run verify:live`: the live matrix (about 45 minutes; it needs the test guild's role-edit budget and prints how
  long to wait otherwise). Live commands take a host-local lock and run one at a time.
- `bun --no-env-file examples/reference-bot/main.ts`: runs the reference bot as the test guild's subject bot, behind
  the live lock. It is an ordinary bot: its requests do not go through the harness's lab guard, so it is run only by
  hand, and `/poll` stays registered until the next harness reset. The tests drive it through the real bot build over
  a fake Discord (`test/unit/reference-bot.test.ts`).

Credentials live in `.env` and are read only through `src/config/Credentials.ts` (`ConfigProvider.fromDotEnv`, after
taking the live lock), never from `process.env`: every script runs `bun --no-env-file`. Tokens stay `Redacted` and
never reach logs, spans, errors or the truth table. Run the unit tests with `bun run test` (vitest under Node), and
install with `bun --no-env-file install`.

## Layout

- `src/`: the library (`src/index.ts` is the public API, also importable as `effect-discord-perms`).
- `harness/`: the live oracle (identities, the lab guard, reset and provisioning, the scenario runner, the truth table).
- `test/`: unit tests, the truth-table replay, type fixtures with diagnostic snapshots, hover snapshots, the rule
  registry.
- `examples/reference-bot/`: the reference bot and the compile-budget baseline; `examples/command-probe/`: the
  per-command budget probes.
- `scripts/`: the offline checks. `fixtures/`: the truth table and recorded command shapes.
- `LOG.md`: live findings, dfx deviations, design deviations, and what is waiting for a human.
