# effect-discord-perms

A typed layer over [dfx](https://github.com/tim-smart/dfx) (Effect v4) in which the compiler catches the mistakes
Discord bots usually find at runtime: missing permissions, payload rules, intents, mixed-up IDs, and command and
component definitions. Every compile-time rule is checked against live Discord in both directions (a valid case
Discord accepts and an invalid case it refuses) before it counts.

## The guarantee

The types guarantee that every failure is handled. They do not guarantee that any call succeeds. Discord owns the
permission state, and it can change between a check and a request. Every operation therefore returns an `Effect` whose
error channel names each way it can fail, and a handler compiles only if every non-`transient` failure is handled,
either by tag or category or by an explicit, greppable `Effect.orDie`.

## A small bot

From the reference bot, [`examples/reference-bot/bot.ts`](examples/reference-bot/bot.ts), which uses no `orDie` and
no `die`:

```ts
const bot = Bot.make({ intents: ["Guilds", "GuildMessages", "MessageContent"] })

const poll = Command.chatInput({
  name: "poll",
  description: "Ask a yes/no question",
  options: [
    { type: "string", name: "question", description: "What to ask", required: true },
    { type: "channel", name: "where", description: "Channel to post in", channelTypes: ["text", "announcement"] }
  ]
})
const vote = ComponentRoute.make("vote", Schema.Struct({ poll: Schema.Int, choice: Schema.Literals(["yes", "no"]) }))

const onMessage = bot.on("MESSAGE_CREATE", (event) =>
  event.message.content !== "!ping"
    ? Effect.void
    : event.channel.send({ content: "pong" }).pipe(catchCategory(["permission", "state"], (error) => Effect.logWarning(error._tag))))

const onPoll = Interactions.command(poll, "ephemeral", (ix) =>
  Effect.gen(function* () {
    const { question, where } = ix.invocation.options          // question: string; where?: TextChannel | AnnouncementChannel
    const channel = yield* Permissions.require(where ?? ix.channel, ["SendMessages", "EmbedLinks"])
    // ... build the buttons' custom_ids with vote.customId(...), then channel.send({ embeds, components })
    return yield* ix.reply({ content: "Posted.", ephemeral: true })
  }).pipe(
    catchCategory(["permission", "state"], (error) => ix.reply({ content: `I can't post there (${error._tag}).`, ephemeral: true })),
    catchCategory("payload", () => ix.reply({ content: "That poll does not fit in a message.", ephemeral: true }))
  ))
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
  `HttpClient` (a per-call deadline, coded 429s), a JSON codec that adds the gateway's channel-obfuscation capability,
  the permission endpoint, and its own interaction runner and command registration. Each deviation is in `LOG.md`.
- **Errors are values with categories.** Each Discord failure has its own `Schema.TaggedError` class: one generated
  `Missing<Flag>` per permission flag, and `ThreadLocked`, `ThreadArchived`, `CommunicationDisabled`,
  `TargetAboveInHierarchy`, `ContentTooLong`, `MessagesTooOld`, `InteractionExpired` and the others the live matrix
  showed are distinct. Each carries the raw Discord response (code, message, route template) as its `cause`. Errors
  belong to one or more categories (`permission`, `payload`, `access`, `state`, `transient`), applied by a mixin and
  caught with `catchCategory`, which removes exactly that category's members from the type, as `catchTag` removes
  exactly its tag. There are no string checks in the public API.
- **The permissions come from the types.** An operation's error union is computed from one operation table and from
  the payload's type: embeds add `MissingEmbedLinks`, files `MissingAttachFiles`, a reply
  `MissingReadMessageHistory`, a poll `MissingSendPolls`; in a thread, `SendMessagesInThreads` replaces
  `SendMessages`. A literal reply cannot be too long, so its `ContentTooLong` is absent; a dynamic one carries it. When
  several flags are missing the call fails with the most fundamental one: ViewChannel, then Connect in voice, then the
  timeout, then SendMessages (or SendMessagesInThreads), then the payload's flags.
- **Preflight, then the request, then the recompute.** Before a request the library resolves the bot's permissions
  from its gateway state (in an interaction, from `app_permissions`, which is exact). If a required flag is missing it
  fails without sending. If Discord still answers 50013 or 50001, it refreshes the channel and member state,
  recomputes, and fails with the specific tag, or with `PermissionDeniedUnattributed` when the recompute finds nothing
  missing. It never guesses. Some missing permissions degrade instead of failing (`@everyone` without MentionEveryone
  pings nobody; TTS without SendTTSMessages sends a plain message); those are a typed `degraded` field on the result,
  read back from Discord's own answer.
- **Channels are a union by kind**, and operations exist only where Discord allows them: no `send` on categories or
  forums (forums have `createPost`), `crosspost` only in announcement channels, thread operations only on threads.
  Messages carry their author: `edit` exists only on the bot's own, and deleting another's adds
  `MissingManageMessages`. IDs are distinct branded snowflakes. `Permissions.require(channel, flags)` is optional: it
  narrows the calls that follow, where a checked flag lost before the request is `PermissionRevokedSinceCheck`.
- **Intents type the events.** `bot.on` accepts only events the declared intents deliver, and `message.content` is a
  `string` only where Discord delivers it (with MessageContent, and without it for the bot's own messages, mentions of
  the bot and DMs); elsewhere it is the frozen `ContentUnavailable` value until `contentDelivered` narrows it. Each
  event runs in its own fiber, scope and span, and a failing handler never stops later events.
- **Commands and components.** Command definitions are checked as written (lowercase names of 1 to 32 characters,
  required options first, at most 25, the subcommand nesting rules, at every level), handler options are typed from the
  definition (choices as literal unions, channel options narrowed to the allowed kinds), and commands are registered
  in a guild only when their stored definitions differ. A `custom_id` is built by a schema-typed `ComponentRoute`
  (checked against the 100-character limit when built), and a handler receives its decoded data; an old control whose
  ID no longer decodes is answered "This control has expired."
- **Interactions are a value-level state machine.** A handler returns exactly one initial response; follow-ups exist
  only inside the continuation that receives `Answered`; `showModal` exists only before answering and never after a
  modal submit; autocomplete can only answer with choices. The defer mode is fixed at registration, and the runner
  defers before Discord's 3-second limit without interrupting a slow handler.
- **The handler boundary.** Handlers registered with `bot.on` and `Interactions.*` may leave only `transient` errors
  unhandled. The compile error names the categories that remain (`UnhandledErrors<"access" | "permission">`), not a
  wall of tags.

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
  `50001`, another code, or a degradation read back from Discord). 542 scenarios cover channel kinds (text,
  announcement, voice and stage chat, forum posts, public, private, archived and locked threads), permission sources
  (`@everyone`, roles, role and member overwrites allowing and denying, Administrator), timeouts, the role hierarchy,
  every operation and payload variant, the intents, command registration and `custom_id` routing. A run reports zero
  mismatches, and two runs in separate processes write byte-identical tables (`fixtures/truth-table.json`). What
  Discord did where it differs from its documentation is in `LOG.md`, "Live findings".
- **Every compile-time rule** (`test/rules.ts`) has a valid case that compiles, an invalid case that fails with a
  snapshotted diagnostic, and a live pair on one identical setup: Discord accepts the valid side and refuses the raw
  invalid side with the expected status, code and field. A diagnostic must have the expected TS code, mention the rule,
  and fit in 4 lines and 800 characters; no `never`, no truncated message types.
- **Hover snapshots** check that the editor shows named types (`CommandInteraction<{ readonly options: {...} },
  "ephemeral">`, `Effect<Sent, MissingViewChannel | ...>`), never the internal machinery.
- **The compile budget** (`bun run budget`) compiles the reference bot as a user compiles it, against the library's
  declarations: 12,541 types, 28,926 instantiations, about 35 ms (ceilings 60,000, 250,000 and 1,000 ms; +2%
  regression gates). The library's own check is a second row with the same regression gates, and a third row holds the
  cost of one 25-option command with its handler (about 2,200 instantiations) so superlinear growth cannot hide.

What is not verified live, and why, is in `LOG.md`: the phase-3 interaction checklist needs a human to click through
it, the DM content and DM delivery exceptions need a human's DM, the external emoji and sticker rules need a second
guild, and successful kicks and bans are verified by the resolver alone (a kicked bot would need re-inviting).

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
