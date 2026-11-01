# effect-discord-perms

Build a fully typesafe, Effect-native Discord bot layer in which the compiler
catches the mistakes Discord bots usually find at runtime: missing permissions,
payload rules, intents, wrong IDs, and command and component definitions.
Every compile-time rule must be proven against live Discord in both
directions before it counts.

## Background

The idea comes from a 2023 discord.js thread that asked whether
`channel.send` could fail to compile until permissions were checked. The
maintainers' objections are design constraints:

- Discord owns the permissions, so a check can be stale by the time the
  request lands. The types must not promise success; they must make each
  failure explicit.
- Payloads determine permissions (embeds need EmbedLinks, files need
  AttachFiles, and so on). The required permissions must be computed from the
  payload type.
- The types must not make ordinary code painful. Type complexity, compile
  time and error readability are part of the verification.
- Xetera, the author of the article, suggested building it as a separate
  layer on top of a client. That is what this project does.

## Required reading

- Xetera, "Building a robust permissions system in TypeScript":
  https://xetera.dev/article/typescript-permissions
- Ethan Niser, Effect best practices: https://ethanniser.com/blog/effect-best-practices/
- Ethan Niser, error categories in Effect: https://ethanniser.com/blog/error-categories-in-effect
- Mike Arnaldi, error categories gist:
  https://gist.github.com/mikearnaldi/4e5c0be9c52fa16a119da95a32c62b89
  (both category sources target Effect v3; port the idea to v4)
- The `effect` skill (Effect v4 conventions) and the `coding-standards` skill.
- `dfx` (npm `dfx@^1`, Effect v4). It is an Effect-native Discord REST and
  gateway client with generated REST types, rate limiting and basic
  permission helpers (`Helpers/permissions`). Read its source before
  designing anything.
- Discord docs on permissions: computing them, implicit permissions,
  permission hierarchy, timeouts and threads. Treat the docs as hypotheses.
  Live Discord is the source of truth.

## Base

Build on dfx and do not write a new REST or gateway client. Add the typed layer
on top. If dfx gets in the way (for example its types cannot carry the
information we need), wrap or adapt it, and record the reason in `LOG.md`.
Before writing `withCategory` or `catchCategory`, check whether Effect v4 or
dfx already provides an equivalent.

## Design requirements

### Errors

- Each failure cause has its own tagged error class, generated from Discord's
  permission flags (`MissingViewChannel`, `MissingSendMessages`,
  `MissingEmbedLinks`, ...). The public API has no string checks anywhere
  (`missing.includes(...)` is banned).
- Causes that are not permissions get their own tags as well:
  - `TargetAboveInHierarchy`
  - `CommunicationDisabled` (the bot is timed out)
  - `ThreadLocked` and `ThreadArchived`
  - `SlowmodeActive`
  - `ContentTooLong`, `EmbedTooLarge` and similar limits
  - `MessagesTooOld` (bulk delete)
  - `InteractionExpired`
  - and any others the live matrix shows are distinct.
- Errors belong to categories, applied with a mixin and caught with
  `catchCategory`. Each error keeps its tag and may be in several categories:
  - `permission`: every `Missing*`, plus `PermissionDeniedUnattributed`
  - `payload`: fixable by removing part of the payload (EmbedLinks,
    AttachFiles, SendTTSMessages, SendPolls, UseExternalEmojis, ...)
  - `access`: the action cannot happen in this channel at all (ViewChannel,
    SendMessages, SendMessagesInThreads)
  - `state`: the bot has the permission, but the current state blocks it
  - `transient`: network errors, 5xx responses, and retries that were given up
- When several permissions are missing, fail with the most fundamental one:
  ViewChannel, then SendMessages or SendMessagesInThreads, then the
  payload-specific permissions.
- Before sending, check the bot's permissions against the gateway cache. In
  interactions, use `app_permissions` instead, because it is exact. If no
  required permission is missing, send the request. If Discord still returns
  50013, refresh the channel and member state, recompute, and fail with the
  specific tag. If the recompute finds nothing missing, fail with
  `PermissionDeniedUnattributed`. Never guess.
- Every error carries a `cause` holding the raw Discord response (code,
  message, route). Public errors are Schema tagged errors with declared fields.
  Nothing in the error channel is `unknown`. Real bugs, such as a resolver
  contradiction or a malformed response, are defects.
- Apply spans before recovery, so that a caught failure still shows as failed
  in traces.
- Some missing permissions degrade silently instead of erroring (for example,
  without MentionEveryone the message sends but does not ping). Report those
  as a typed field on the result, such as `degraded`, not as errors. The live
  matrix decides which permissions behave this way.

### Enforcement

- Handlers registered with the bot (`Bot.on(...)`, command and component
  handlers) may leave only `transient` errors unhandled. An unhandled
  `permission`, `payload`, `access` or `state` error is a compile error.
- Opting out must be explicit and easy to grep for (`Effect.orDie`,
  `catchCategory`).
- `Permissions.require(channel, [...])` is optional. It narrows the error
  types of the calls that follow; it is never required.

### Compile-time rules (each needs both a passing and a failing live test)

**IDs and channels**
- `ChannelId`, `GuildId`, `UserId`, `RoleId`, `MessageId` and so on are
  distinct branded snowflake types that cannot be mixed.
- Channels are a union keyed on channel type. Operations exist only where
  Discord allows them:
  - no `send` on categories or forums (forums have `createPost`);
  - `crosspost` only on announcement channels;
  - thread operations only on threads.
- Messages carry their author: `edit` exists only on the bot's own messages,
  and deleting another user's message adds `MissingManageMessages`.

**Message payloads**
- Each payload's required permissions are computed from its type (embeds,
  files, reply, tts, poll, external emoji or sticker). Inside threads,
  SendMessagesInThreads replaces SendMessages.
- A message must contain at least one of content, embeds, files, sticker or
  poll.
- The Components V2 flag excludes `content` and `embeds`.
- Component layout rules:
  - at most 5 buttons per row;
  - a select menu must be alone in its row;
  - link buttons have no `custom_id`;
  - premium buttons have no label.
- `allowed_mentions` defaults to pinging nobody. Pinging is an explicit opt-in.
- Message flags are valid only in their contexts: `Ephemeral` only on
  interaction responses, `SuppressNotifications` only on create.
- Length limits are checked when sending and produce typed errors; users must
  not have to brand every string.

**Intents**
- Events and fields depend on the declared intents. Subscribing to an event
  without its intent is a compile error.
- `message.content` is typed as available only where Discord delivers it.
  Without MessageContent, the exceptions are DMs, messages that mention the
  bot, and the bot's own messages. Verify these exceptions live.

**Commands and components**
- Command definitions:
  - names lowercase and 1–32 characters (checked when written as literals);
  - required options before optional ones;
  - at most 25 options;
  - subcommand nesting rules.
  
  Verify each rule live: the registration API rejects invalid definitions,
  and this needs no human.
- Handler options are typed from the definition: required versus optional,
  choices as a union of their literal values, and channel options narrowed
  to the allowed channel kinds.
- `custom_id` routing is schema-typed: a component's handler receives decoded
  data, and the 100-character limit is checked when the ID is built.
- Commands are re-registered only when their definitions change.

**Interactions (phase 3)**
- Handlers must return a response, and the library auto-defers before
  Discord's 3-second limit.
- The response follows a state machine:
  - `showModal` exists only before the interaction is answered or deferred;
  - follow-ups exist only after it is;
  - autocomplete handlers can only respond with choices;
  - a modal cannot be opened from a modal submit.

### Keeping the types bearable

- Compile errors must name the problem. Each must-fail type test saves a
  snapshot of the tsc diagnostic text, which must name the missing permission
  or the violated rule. A wall of conditional types fails the test.
- Compile-time budget: measure `tsc --extendedDiagnostics` (check time,
  instantiations) on a reference bot in `examples/`. Treat regressions as
  failures.
- Hovering a type in the editor must show readable named types.

## Environment

- The checkout is `~/agent-workspace/effect-discord-perms` on `minisforum`.
  The folder already contains `.env` and `.gitignore`. Run `git init`, keep
  `.env` ignored, and add the project to `~/agent-workspace/registry.toml`
  (verify command, aliases such as "effect discord", "discord perms").
- Use Bun and TypeScript with strict settings.
- `.env` holds the credentials below. Read it from code and never print,
  log, commit or copy the tokens. Credentials are bound to the process
  explicitly, not inherited.
  - `DISCORD_HARNESS_TOKEN` / `_APP_ID`
  - `DISCORD_SUBJECT_TOKEN` / `_APP_ID`
  - `DISCORD_TARGET_TOKEN` / `_APP_ID`
  - `DISCORD_TEST_GUILD_ID`
- The test server is "Perms Lab". It is owned by Rhys, Community is on, and
  it contains `#rules` and `#mod-updates`, which Community requires; do not
  delete those.
- **Perms Harness:** Administrator, its role is the highest. It creates and
  changes all state: channels, roles, overwrites, threads, timeouts and
  messages. It has the Server Members intent.
- **Perms Subject:** the bot under test. It joined with no permissions, so
  every permission it has comes from roles the harness assigns. It has the
  Server Members and Message Content intents, and slash commands are allowed.
- **Perms Target:** a member for the subject bot to act on: role assignment,
  nicknames, timeouts where Discord allows them, and hierarchy cases.
- @everyone still has Discord's default permissions. At the start of each run
  the harness must reset @everyone and remove all leftover test state, so
  every run starts clean.
- The human member `rhyssul` (Rhys) is also in the server. Never ping or DM him.

## Verification loop

The live oracle comes first; build the library against it.

1. **Harness and matrix runner (build first).** A scenario sets up state
   through the harness, then the subject bot does three things:
   - (a) computes its permissions with our resolver;
   - (b) runs our preflight check;
   - (c) makes the raw REST call with no check.
   
   Record the outcome class of each scenario: `success`, `50013`, `50001`,
   another error code, or silent degradation. Detect degradation by reading
   back the created message or resource. A mismatch is when (b) disagrees
   with (c), or when (a) contradicts what Discord did.
2. **Matrix coverage.** Choose dimensions with pairwise or targeted
   coverage, not a full cartesian product:
   - channel kind: text, announcement, voice text, stage, forum post, public,
     private, archived and locked threads;
   - permission source: @everyone, role, role overwrite allow and deny,
     member overwrite allow and deny, Administrator;
   - member state: normal, timed out;
   - role hierarchy;
   - the operation and payload variant.
   
   Cover every permission the phase-1 operations touch.
3. **Recorded truth table.** A live run writes `fixtures/truth-table.json`,
   which is committed. Offline tests replay it against the resolver and
   preflight, with no Discord access. Two consecutive live runs must produce
   identical tables, or the flakiness must be explained and fixed.
4. **Type tests.** Every matrix scenario and every compile-time rule has a
   type-level assertion: a valid case that compiles, and an invalid case that
   fails with a snapshotted, readable diagnostic. Each `catchTag` must remove
   exactly its tag, and each `catchCategory` exactly its category's members.
   The handler boundary must reject unhandled `permission` and `state` errors
   and accept unhandled `transient` ones.
5. **Commands.** `bun run verify:offline` runs typecheck, unit tests, type
   tests, truth-table replay and the compile budget. `bun run verify:live`
   runs the live matrix and rewrites the truth table.

Rate limits: pace live runs so they stay under Discord's limits. Reuse
channels and roles rather than creating new ones per scenario. Respect 429s
through dfx and never hammer. A full live run should take minutes, not hours.

## Phases

1. Harness, matrix runner and permission resolver; message, reaction, pin,
   thread and channel-edit operations; tagged errors with categories; IDs and
   channel kinds; payload rules.
2. Intent-typed events and fields, slash command definitions and typed
   options, `custom_id` routing, command registration diffing. All of it is
   bot-only and verified live.
3. The interaction lifecycle. Build the typed state machine and a
   `checklist` command that posts prompts for a human to click through.
   Verify everything that can be verified without a human (types and offline
   tests). Do not run the human checklist; record it in `LOG.md` as
   waiting for Rhys.

## Hard constraints

- Never automate a user account. Bots only.
- Never kick or ban the target bot or the harness bot. Test kick and ban only
  in cases where they are expected to fail. Successful kicks and bans are
  verified by the resolver alone, because they would need Rhys to re-invite.
- Act only in Perms Lab, never in any other guild.
- Never weaken assertions, add skips, or loosen the budget to get a pass.
  Report failures honestly.
- Write plain Effect v4 code: no `any`, no `unknown` in error channels, no
  string-based error checks.
- Local only. Do not publish to npm, push to a remote, or open PRs.

## Done when

- `verify:offline` is green.
- `verify:live` reports zero mismatches across the phase 1–2 matrix, and two
  consecutive runs produce identical truth tables.
- Every compile-time rule has a live test for both its valid and invalid
  cases, and a snapshotted readable diagnostic.
- `examples/` contains a reference bot with no `orDie` that compiles within
  budget.
- `README.md` explains the design and the guarantee. It states plainly that
  the types guarantee every failure is handled, not that every call succeeds.
- `LOG.md` records what the live matrix found where it differed from the docs,
  and the phase-3 checklist waiting for Rhys.
