# LOG

The running record of the build: what Rhys needs to do, what live Discord showed where it differed from the
docs, where we wrapped or adapted dfx, and where the implementation deviated from `docs/DESIGN.md`. Each
milestone appends its entries.

`bun run rules` reads two things from this file: every escalated rule's `Q-<n>` must have a line under
"Waiting for Rhys", and every rule that is not pure-typing must be mentioned by its `R-` id somewhere here.

## Waiting for Rhys

- **GuildMedia channels (decision, not blocking).** Perms Lab cannot have a media channel: creating one
  (`POST /guilds/{guild.id}/channels`, type 16) answers 400 50024 "Cannot execute action on this channel type",
  even with a minimal body `{name, type}` (M2). Provisioning records `lab-media` as unavailable in
  `.lab-state.json` and every media scenario will record `setup-unsupported: kind-not-available` (§5.10).
  If Rhys wants the media kind verified live, the server would need media channels enabled by Discord (they are
  not offered to this guild today); otherwise the media rows stay resolver-only. Everything else proceeds.

## Live findings

Where live Discord differed from the docs, each citing its H-id.

- **M2, H-240 (oracle): available.** `GET /channels/{c}/permissions/member/{u}?implicit=false` answered 200 for
  all ten lab channels and threads (the subject: no flags, as expected with an empty `@everyone` and no roles).
  A positive control, the target in `lab-text`, returned exactly `lab-target`'s overwrite allow (AddReactions,
  ViewChannel, SendMessages, ReadMessageHistory, SendMessagesInThreads). H-241 (timeouts) is still open.
- **M2, H-072: Perms Lab is `mfa_level = 0`.** `TwoFactorRequired` stays a documented, resolver-only tag (§8 item 16).
- **M2, D35: the harness application has the Message Content flag** (`GatewayMessageContent` or its
  `...Limited` flag in `getMyApplication().flags`), so the harness's REST reads see message content.
- **M2, H-073 refuted for Perms Lab: neither the subject nor the target has a managed role.** The guild's only
  managed role is the harness's (`Perms Harness`, Administrator). The two bots joined with no permissions, and
  Discord created no managed role for either (consistent with invites that request no permissions). "Both managed roles' positions": none
  exist; the subject's rank comes only from the lab roles a scenario assigns, and by default the target
  (`lab-target`, position 3) outranks the subject (no roles). Provisioning would place them directly below
  `lab-low` if they ever appear.
- **M2: roles created through the API all get position 1, and nothing is renumbered.** After creating the ten lab
  roles, every role but `@everyone` (including `Perms Harness`) was at position 1, ordered only by the ID
  tie-break. Provisioning therefore requires distinct positions, not just the right tie-broken order.
- **M2: a role-position PATCH that moves lab roles above the harness's numeric position fails with 400 50013**
  (status 400, where 50013 usually comes with 403), even though the harness ranked highest by tie-break. The same PATCH
  that also moves the harness's own top role above the block succeeds, and Discord applies the positions as
  sent: `Perms Harness` 11, then `lab-high` 10 down to `lab-unmentionable` 1.
- **M2: GuildMedia (16) cannot be created in Perms Lab** (400 50024, see "Waiting for Rhys").
- **M2: adding the target to a thread posts a system message nobody can delete.** Reset's first single delete of a
  harness message in `lab-public-thread` answered 403 50021 "Cannot execute action on a system message": the
  RECIPIENT_ADD (type 1) notice the harness's `PUT .../thread-members/{target}` posted. message.mdx lists types
  1-5 and 21 as not deletable; reset now leaves exactly those.
- **M2: `@everyone` had Discord's default permissions** (CreateInstantInvite, AddReactions, View, Send, ...) before the
  first reset, as the brief said; the first reset's only write set them to none.
- **M2 (observation for H-022 and H-241, recorded properly by the M3/M4 timeout rows): a bot member can be given a
  timeout.** The harness's `PATCH /guilds/{g}/members/{target}` with `communication_disabled_until` about ten
  minutes ahead was accepted (in the M2 verifier's reset self-test and again in the one below), the verifier's
  member read-back showed it, and reset cleared it. Not checked yet: that the timed-out bot's own sends fail (the H-022 test
  in discord-semantics.md), and whether the oracle masks a timed-out member (H-241). `Observed.botsCanBeTimedOut`
  stays `true`.
- **M2: a forum post's starter message can be pinned**, and reset unpins it (it keeps the message), as
  §5.7 step 6 requires.
- **M2 (for M4's pins catalog, H-050/H-052): a message in a stage channel's chat cannot be pinned.** In the M2
  verifier's dirt run, the harness (Administrator) pinning its own message in `lab-stage`
  (`PUT /channels/{lab-stage}/pins/{msg}`, same channel) got 400 50019 "This message cannot be pinned in this
  channel". discord-semantics.md H-052 expects 50019 only for a message from another channel. Not re-run in
  M2 (the reset self-test leaves stage pins out because of it). M4 decides whether stage pin rows expect 50019
  or stage leaves the pins channel dimension, with the reason here (DESIGN §5.9 notes it).
- **M2: a thread's slowmode can be set, and restored in the same PATCH that unarchives and unlocks it.** The
  reset self-test set `rate_limit_per_user: 5` on `lab-public-thread` before archiving and locking it; reset's
  single `PATCH /channels/{thread}` with `rate_limit_per_user: 0, archived: false, locked: false` was accepted,
  and the read-back showed slowmode 0, unarchived and unlocked.

## dfx deviations

Where dfx got in the way and we wrapped or adapted it, and why.

- **M2: the base `HttpClient` handed to every dfx stack is ours** (`harness/Identities.ts`): the Lab guard, the
  global pacing bucket and the request, write and invalid-response counters run there, below dfx's own limiter,
  so they see every identity and every retry dfx makes after a 429 (dfx re-executes through the base client).
  dfx is unchanged; it just receives a wrapped client.
- **M2: GuildMedia channels are created through `rest.httpClient`.** dfx's generated `CreateGuildChannelRequest`
  has no type 16 (dfx.md §0), so provisioning sends all channel creates as raw JSON through the identity's
  authenticated, rate-limited `rest.httpClient` and decodes the response itself (`harness/Wire.ts`).
- **M2: the permission oracle goes through `rest.httpClient`** (`src/rest/Oracle.ts`): neither dfx 1.1.1 nor
  discord-api-types knows `GET /channels/{c}/permissions/member/{u}` (published 2026-10-30).
- **M2: dfx's 2xx bodies are re-decoded.** dfx casts every response to its generated type without validation, so
  the harness decodes each body it acts on with its own schemas (`harness/Wire.ts`), and startup decodes the
  user, application and member it reads; a mismatch is a defect.
- **M2: dfx's `DiscordRestError.code` is never read** (it is `undefined` at run time, dfx.md §3);
  `src/rest/ErrorMap.ts`'s `classify` reads `e.data.code` and decodes the body with Schema.

## Design deviations

Where an implementation changed a decision in `docs/DESIGN.md`, with the evidence. The design is updated in
the same commit.

- **M0: rules claim directives by mention (`Rule.claims`, §5.5).** The design's `Rule` linked a rule to a
  fail fixture file only, but §5.5 (review finding L15) requires that *every directive* be claimed by a rule.
  Fixture files hold several rules' directives (`[sd:src/fail/channel-kinds.ts]` covers no-send-category,
  no-send-forum, crosspost and thread-op absence), so with file-level claiming any one rule pointing at the
  file would "claim" all of them and L15 would not be enforced. Smallest fix: `claims`, the non-empty list of
  directive mentions in `fail` that the rule owns. A claim must be a directive mention in that file and appear
  in its snapshot; a directive whose (file, mention) no rule claims fails rules-check.
- **M0: the trivial fixtures are a real rule.** With an empty registry, any fail fixture's directive would be
  unclaimed and rules-check would fail, so "empty registry allowed" and "one fail fixture" cannot both hold.
  The M0 fixtures are therefore `R-catch-tag-exact`'s (pure-typing, in the §5.5 allowlist), built on
  fixture-local `Schema.TaggedError` classes; M1 adds library-error assertions. This brought `test/rules.ts`
  and the `Observation` schema (`harness/scenario/Dsl.ts`, copied from `[sd:src/verify.ts]`) into M0.
- **M0: staged checks are reported, never silently passed.**
  - `verify:offline` prints `gen:errors` as "not built yet" until `scripts/gen-errors.ts` exists (M1; M1's
    exit also runs `gen:errors -- --check` on its own).
  - `budget` prints "nothing to measure yet" until the reference bot (M10) or the command probes (M8) exist.
    Each row then needs its baseline entry, and a baseline entry without its projects fails. The probe paths
    were unspecified; they are `examples/command-probe/tsconfig.{none,commands}.json` (§5.4).
  - `rules` fails closed on any `pair` rule until M6 adds the catalog and truth-table checks, and prints the
    flag-coverage (M6) and events (M7) checks as "not checked yet" (§5.5, §6 M6/M7).
- **M0: the native compiler is resolved per platform** (`@typescript/typescript-<platform>-<arch>`, as
  `typescript/lib/getExePath.js` does) instead of the hard-coded `typescript-linux-x64` path in §5.3, so the
  offline checks also run on the MacBook. On minisforum it is the same binary.
- **M1: the ID-mixing fail fixture moves to M6, with `R-ids-distinct`.** §6 M1 listed "fail fixtures for ID
  mixing", but the rule that must claim the directive, `R-ids-distinct`, has a live pair (§5.5), and a `pair`
  rule fails rules-check closed until M6 adds the live-pair checks. Evidence, with a temporary
  `test/types/fail/ids.ts` copied from `[sd:src/fail/ids.ts]` (removed after): its diagnostic passes the gate
  (`Argument of type 'string & Brand<"UserId">' is not assignable to parameter of type 'string &
  Brand<"ChannelId">'.`, 4 lines, 386 gated characters), but `bun run rules` exits 1 with
  `directive mention "ChannelId" is not claimed by any rule`, and with the rule registered as its §5.5 pair it
  exits 1 with `has a live pair, which this rules-check cannot verify yet`. Either way `verify:offline` would be
  red for M1-M5. Weakening the fail-closed staging, or listing the rule as pure-typing, would loosen a gate, so
  the fixture moves to M6, whose scope already has "type fixtures ... for §2.1" and "the registry entries". M1
  keeps the type-level proof as a pass fixture: `test/types/pass/ids.ts` asserts that no brand is assignable to
  any other (all 90 ordered pairs), that a plain `string` is none of them, and that `make` returns the brand.
- **M1: `voice.pins` lists `CommunicationDisabled`.** The prototype row (`[sd:src/ops.ts]`) omitted it, but §2.4
  puts the tag in every row whose flags the timeout mask removes (everything but ViewChannel and
  ReadMessageHistory, H-020), and `voice.pins` needs Connect. The new table-invariant test
  (`test/unit/operations.test.ts`) failed on exactly this row (`listsCommunicationDisabled: false` for
  `voice.pins`). §2.4's "pins" exception now reads `channel.pins`.
- **M1: `channel.pins`, `voice.pins`, `thread.join` and `thread.leave` list `PermissionDeniedUnattributed`.** The
  prototype rows omitted it, but §3.1 raises it from "every op that can return 50013/50001", and §4.9 sends a
  50001 through the recompute, which returns `PermissionDeniedUnattributed` when the fresh state shows nothing
  missing. All four are guild requests that return 50001 without View (H-080), so the recompute can produce
  the tag; without it in the row the type would not name a failure the runtime produces (M5's op-errors test
  would also have caught it). Only `dm.send` and `permissions.require` omit it; a unit test asserts exactly
  that.
- **M1: the transient classes type their cause as one member of `ErrorCause`.** `RequestTimedOut` and
  `NetworkError` take `NoResponse`, `DiscordUnavailable` and `RateLimited` take `DiscordResponse`, as §2.2 and
  §3.1 describe them, instead of the prototype's `ErrorCause`. Nothing else can produce them, so a transient
  error with a preflight cause is no longer representable.
- **M1: `ErrorCategories` covers the classes `errorFor` can build** (the 52 generated classes and the 2 D5
  variants, keyed by class name). §2.2 said "every class"; the generator knows only the permission flags and
  the variants, and duplicating the hand-written classes' categories in it would add a second source.
  `test/types/pass/error-categories.ts` checks each entry against `Categories<>` of its class, and
  `test/unit/d6-invariant.test.ts` reads every other class's marker. §2.2 is clarified.
- **M1: `errorFor` is an overload.** As an arrow function typed `OpPermissionErrors[Op][F]`, tsc rejected the
  body (TS2375, then TS2719 when spelled through `VariantErrors`), because the property read
  `Operations[op].variant` widens to every row's variant for a generic `Op`. Rule 7 of §2.12 is the pattern
  for this: the public signature returns `OpPermissionErrors[Op][F]` over a wide implementation, and
  `test/unit/error-for.test.ts` checks every (operation, flag) at run time. `test/types/pass/operations-table.ts`
  asserts the precise return (`errorFor("channel.send", "ReadMessageHistory", cause)` is
  `MissingReadMessageHistoryForReply`). §4.7 says so.
- **M1: `src/permissions/Observed.ts` arrives in M1** with only `slowmodeAppliesToBots: false` and
  `botsCanBeTimedOut: true`, because `TagClasses` maps the gated tags through them (§2.4). M3/M4 add the
  other constants (`codeForLevel`).

- **M2: the Lab guard runs in the shared base `HttpClient`, as a route allowlist** (§5.6 clarified). §5.6 asked for
  a guard on every identity's writes and a "narrow `Lab` interface" for the harness. One guard below every dfx
  stack covers all identities, `SubjectRaw` and (from M6) the library's own operations at once, and cannot be
  bypassed; the narrow interface is its allowlist of the routes the lab needs. `test/unit/lab-guard.test.ts`
  checks each refusal. Kick and ban are refused outright until M4 adds the harness-side failure prediction.
- **M2: the subject is a REST-only identity, and the READY and sent-intents identity checks are staged** (§4.4 and
  §6 M2 updated). M2 has no gateway (the library's bot layer arrives in M3, the codec in M7), so `SubjectRaw`
  is a fresh REST stack like `HarnessRest` and `TargetRest` (its tag lives in `src/bot/Internals.ts`, where
  M3 builds it from `BotInternals.layerWith`), and `harness:smoke` prints the two gateway checks as "not
  checked yet".
- **M2: `src/bot/Startup.ts` (`restChecks`, checks 1-3 of §4.4) and `src/rest/ErrorMap.ts` (`classify`, the dfx
  failure shapes of §4.9) arrive early**, because "the startup checks for three identities" is M2 scope. M7
  calls `restChecks` from `Bot.layer`; M5 adds the error table on top of `classify`. A member read answering
  403 50001 is also mapped to `not-in-guild` (unverified live: Perms Lab is the only guild the bots may touch).
- **M2: `harness/Wire.ts` and `harness/Smoke.ts` are new modules** (§1.2 updated): the harness's response schemas
  and raw-request helper, and smoke's oracle reads and the read-only `inventory` command.
- **M2: thread membership baseline covers every provisioned thread** (§5.7 step 5 updated). §5.7 named only the
  subject's membership of `lab-private-thread`. The subject now starts as a member of no provisioned thread
  (sending auto-joins it, H-034, so a public-thread row would otherwise leak into the next), and the target as a
  member of all four, so it can post fixtures in the private thread (it has no ManageThreads).
- **M2: role positions require distinct positions, and the position PATCH carries the harness's role** (§5.7
  updated, with the guard's positions-only admission of that role). Evidence in "Live findings".
- **M2: `lab-media` is recorded as unavailable instead of failing provisioning** (§5.7 updated). `.lab-state.json`
  gained `unavailable` (name to the status and code Discord gave), and §5.10's `kind-not-available` covers the
  scenarios.
- **M2: reset leaves undeletable system messages, deletes old bot messages singly, and restores parents, overwrites
  and lab-role permissions** (§5.7 updated). Evidence for the first in "Live findings"; the rest makes "a second
  reset makes zero writes" hold after scenarios that edit those settings. A subject or target holding a non-lab
  role fails the reset with `LabCheckFailed` instead of being edited (the guard would refuse it, and such a role
  would grant permissions the matrix does not control).
- **M2: `lab-admin` holds Administrator at baseline** (§5.7 updated): it is the `administrator` grant source and is
  only ever assigned by a scenario; every other lab role has no permissions at baseline.
- **M2 (verifier fixes): the Lab guard checks request bodies where a route alone admits writes outside the lab**
  (§5.6 updated). The M2 verifier probed `verdict` with an armed state and got `Allow` for
  `PATCH /guilds/{g}/channels` with `[{id: rules, position: 0, parent_id: lab}]`, for
  `PUT /channels/{lab}/thread-members/{rhys}`, and for `PATCH /guilds/{g}/members/{target}` with
  `{roles: [foreign role]}`. Now the channel-list PATCH is refused outright (nothing needs it); a channel create
  needs a `lab`/`lab-*` name and a lab parent; thread membership changes only for `@me`, the subject and the
  target; member edits may carry only `nick` and `communication_disabled_until` (roles go through the per-role
  routes, which check each role); a role create needs a `lab-*` name; AutoMod deletes need a rule named `lab-*`
  that reset listed and admitted. A body these routes cannot read is refused. Each case is in
  `test/unit/lab-guard.test.ts`, including one through real `HttpClientRequest.bodyJson` requests, and each
  check was mutated away once to see its test fail.
- **M2 (verifier fixes): smoke fails on a bad oracle result** (§6 M2 updated). It used to print `DIFFERS` and exit
  0. Now an available oracle fails smoke with `LabCheckFailed` when the control is not exactly `lab-target`'s
  allow, when the subject holds any flag at baseline, or when only some reads (the control included) answer.
  An unavailable oracle is still a recorded, non-failing outcome (§5.10).
- **M2 (verifier fixes): `Credentials` exports only layers** (§4.3 updated). `config` and `dotEnvPath` were
  exported, so code could read `.env` through `fromDotEnv` without the lock. Now `layer` (the repository's
  `.env`, the host's lock) and `layerFrom({dotEnvPath, lockPath})` are the only ways in, and
  `test/unit/credentials.test.ts` builds `layerFrom` with temporary files: a held lock gives `LockHeld` both
  with a valid `.env` and with none at all (where a free lock gets a `PlatformError` from reading it), so the
  lock is taken first.
- **M2 (verifier fixes): only GuildMedia's 400 50024 is recorded as unavailable** (§5.7 updated).
  `LabIds.optionalChannelTypes` holds the kinds a guild may lack (16); a 50024 on any other kind fails
  provisioning with `LabRequestFailed`.
- **M2 (verifier fixes): reset unpins every pinned message it does not delete** (§5.7 step 6 clarified), not only
  messages by humans, so a pinned forum-post starter or undeletable system message is unpinned too
  (`planUnpins`).
- **M2 (verifier fixes): vitest refuses to run under the Bun runtime** (§4.3 updated). The verifier found that
  `bun --no-env-file node_modules/.bin/vitest run` starts Bun workers without `--no-env-file`, which load `.env`
  (`env-isolation.test.ts` failed there). `vitest.config.ts` now throws under Bun before any worker starts;
  `bun run test` runs vitest under Node, as before.

- **M2 (verifier fixes, round 2): reset restores thread slowmode** (§5.7 step 4 clarified). The M2 verifier set
  `rate_limit_per_user: 5` on `lab-public-thread`; reset left it, and the next reset reported `writes: 0` with
  the lab off baseline, because `threadPatch` covered only name, archived, locked and auto-archive. Now
  `threadPatch` also sets slowmode 0 (`test/unit/reset-plan.test.ts`). Of the §5.8 `channelSettings` fields, a
  thread has `nameVariant` (restored) and `slowmode` (now restored); `requireTag` is the parent forum's flag,
  which `channelPatch` restores. Threads have no overwrites or parent to restore.
- **M2 (verifier fixes, round 2): the reset self-test is a committed command and part of M2's exit**
  (§5.1, §5.7, §6 M2 updated). `bun run harness:selftest` (`harness/SelfTest.ts`) replaces the git-ignored
  `.scratch/m2/dirty-lab.ts` (deleted). It resets, reads the lab back (must be at baseline), applies 13 dirt
  steps through the guarded identities, reads back (each step's expected problem must be reported, so a blind
  read-back fails), resets, reads back (no problem may remain) and resets again (zero writes). The read-back
  (`baselineProblems`) judges from the spec in `LabIds.ts`, not from reset's patch functions; it is unit-tested
  in `test/unit/selftest.test.ts`. Live evidence in the M2 milestone notes below: with the slowmode fix
  removed, the self-test failed with exactly `lab-public-thread slowmode (5)`.
- **M2 (verifier fixes, round 2): the guard reads thread and sticker bodies** (§5.6 updated). A thread create
  (`POST /channels/{lab}/threads`, `POST /channels/{lab}/messages/{id}/threads`) needs a `lab`/`lab-*` name, so
  reset can always tell a scenario thread; a sticker create needs a `lab-*` name, read from its multipart form,
  and sticker edits and deletes are refused. `verdict` now takes a `RequestBody` (`None`, `Text`, or a form's
  string fields) instead of the JSON text; a thread create sent as a form (a forum post with files) is refused,
  since its JSON is in a `payload_json` blob the guard cannot read synchronously. New verdict cases cover these,
  the overwrite sub-route (`/permissions/{id}/x`) and a real `bodyFormData` request.
- **M2 (verifier fixes, round 2): smoke fails when it would skip a lab channel** (§6 M2). `oracleTargets` fails
  with `LabCheckFailed` when a channel or thread in the spec has no stored ID and is not recorded as
  unavailable; `oracleReads` takes the loaded state, so `test/unit/oracle.test.ts` checks that it reads every
  channel and thread but the category and `lab-media`, the subject in each, and the target in `lab-text` for the
  control.
- **M2 (verifier fixes, round 2): `IdentityCheck.run` and the invalid-response count have offline tests.**
  `test/unit/identity-check.test.ts` runs the real wiring (`compose`) over a fake that answers per token: the
  success case (protected channels include the guild's rules channel even when it has a lab name, so it cannot
  be admitted) and six failures (another application's token, two tokens of one bot, another guild name, no
  `#rules`, no `#mod-updates`, a role above the harness's), each a `LabCheckFailed` that leaves the guard
  unarmed, so the next write is refused unsent. `test/unit/identities.test.ts` answers a 403 and a 429 (which
  dfx retries) through `compose` and sees `invalid: 2`.

## Escalated rules

Rules with an escalated remainder, shown by `verify:live` as unmet Done criteria. None yet.

## Notes for every milestone

- Run the unit tests only with `bun run test` (or `bun run verify:offline`), which runs vitest under Node.
  `vitest.config.ts` refuses the Bun runtime, whose workers would load `.env`.

- Run `bun --no-env-file install`, not `bun install`: plain `bun install` loads `.env` into its own process
  (it printed `[0.26ms] ".env"` when M0 re-locked TypeScript), where dependency lifecycle scripts could read
  the tokens. Checked in M0: `bun run <script>` does not pass `.env` to the scripts it starts, and
  `bun --no-env-file` keeps it out of the process (probed with a throwaway `.env` in `/tmp`, counting names
  only).

- **Live commands** (minisforum only, one at a time; each takes the live lock through `Credentials`):
  `bun run harness:reset` prints `writes: N`; `bun run harness:smoke` runs the identity checks, reset,
  provision and the oracle reads; `bun run harness:selftest` is the reset self-test (below);
  `bun --no-env-file harness/main.ts inventory` lists the lab guild read-only.
  The lab's object IDs are in `.lab-state.json` (git-ignored). Deleting it makes the next reset delete every
  `lab-*` object and the next provision recreate them.
- **Reset self-test: re-run `bun run harness:selftest` whenever `Reset.ts` (or `LabIds.ts`'s baseline) changes.**
  The smoke and reset exit checks run on a clean lab, where a reset that wrote nothing would pass too. The
  self-test dirties the lab (role permissions and mentionability, a leftover role the target holds and the
  target without `lab-unmentionable`, the subject with lab roles, a nickname and a timeout, a leftover channel,
  bot messages in text, a thread, voice, stage and announcement, pins including the forum post's starter,
  `lab-text` slowmode and four kinds of overwrite, `lab-bots-only` out of the category, forum REQUIRE_TAG and
  tags, thread slowmode, archive, lock and auto-archive, the subject in the private thread and the target out
  of the forum post, archived public and private scenario threads, a subject guild command, and the target's
  nickname and timeout), checks the read-back sees all of it, resets, checks the lab is at baseline, and resets
  again expecting zero writes. When adding a field to reset, add its dirt step and its read-back check. It takes
  about 80 s and some 300 requests.

## Milestones

### M0 Tooling skeleton

- `typescript` is pinned to exactly `7.0.2` (D32); every script checks that the installed compiler is the pin.
- `package.json` has all the §5.1 scripts. `harness:*`, `verify:live` and `gen:errors` point at files later
  milestones write.
- `scripts/type-tests.ts` (§5.2): one `tsc -p test/types/tsconfig.json --pretty false`; the nine failure
  modes of type-testing §6; directives with TS codes, consecutive-directive blocks and `@valid` twins; the
  gate (4 lines, 800 characters after collapsing unions, the mention, banned texts, wrong-reason codes,
  truncation inside `UnhandledErrors<...>`/`Invalid<...>` found by bracket matching). Beyond the design, it
  also rejects `@ts-expect-error`/`@ts-ignore`/`@ts-nocheck` in fixtures, pass fixtures without an
  `expectTypeOf` or `Equals` assertion, malformed directives, `declare global`, and snapshots without a
  fixture.
- `scripts/hover.ts` (§5.3): the real `tsc --lsp --stdio` hover at every `//  ^?` marker, `<file>.hover.txt`
  snapshots, and `names: ...; no-object` expectations (`names` is required on every marker). Found while
  building it: the TS 7.0.2 language server rejects `shutdown` with `params: null` (`InvalidParams: expected
  no params, got null`), so requests without parameters omit the key.
- `scripts/budget.ts` (§5.4): five `--checkers 1` runs per project, identical counts required, median check
  time, ceilings 250k/60k/1000 ms, +2% and 1.5 x + 25 ms gates, the per-command row from the two probes, and
  the baseline's TypeScript version. Exercised with temporary projects (removed): baseline write, pass
  against it, +275.8% instantiations rejected, a lone probe rejected, a baseline row without its projects
  rejected, a project that does not compile rejected.
- `scripts/rules-check.ts` (§5.5) and `test/rules.ts` with `R-catch-tag-exact`.
- `scripts/verify-offline.ts` (§5.1) takes no arguments, so it can never pass `--update`.
- The scripts' logic is in `scripts/lib/*` and covered by `test/unit/*` (62 tests in all, including
  `test/unit/env-isolation.test.ts`, which asserts no `DISCORD_` variable is visible to unit tests).
- Exit evidence: `bun run verify:offline` exits 0 (1 pass fixture, 1 fail fixture with its `@valid` twin,
  1 hover marker). Temporary fail fixtures with a wrong mention, a wrong TS code and a missing import
  (`Cannot find name 'UserId'`, TS2304) each made `bun run test:types` exit 1 with exactly that gate reason,
  with their snapshots written first so the snapshot check could not be the cause. They were removed after.

### M1 Errors, categories, IDs, operation table

- `src/Snowflake.ts`: the ten branded IDs; `X.make` throws on a malformed snowflake (unit-tested).
- `src/errors/`: `Category.ts` (the `[cc:src/category.ts]` port: `withCategory`, `hasCategory`,
  `catchCategory`), `Cause.ts`, `Missing.generated.ts` (52 classes, `PermissionFlags`, `PermissionErrors`,
  `missing`, `MissingClasses`, `ErrorCategories` with 54 entries), `Variants.ts`, `Permission.ts`, `State.ts`,
  `Payload.ts`, `Transient.ts` (with the `Transient` union), and `index.ts` (`ErrorClasses`,
  `PermissionErrorClasses`, `AllErrors`). Each hand-written module exports a `*Classes` record so the D6 test
  enumerates every class; a unit test checks the record matches every error class the barrel exports.
- `scripts/gen-errors.ts` with the pure `scripts/lib/genErrors.ts`. It reads `PermissionFlagsBits`, drops
  `ManageEmojisAndStickers` (H-059), and refuses an unlisted alias (two names on one bit), a listed alias that
  aliases nothing, and a category-table flag that does not exist. `--check` exits 1 on a missing or stale
  module, naming the first different line (checked by hand-editing a doc comment: `stale from line 99`, exit 1).
  Never edit `src/errors/Missing.generated.ts`; run `bun run gen:errors`.
- `src/permissions/Operations.ts`: the 40-row table, `TagClasses`, `VariantErrors`, `OpFlags`, `OpTags`,
  `OpPermissionErrors`, `Revoked`, `OpErrors<G>`, `variantConstructors` and `errorFor`.
- Unit tests: `category.test.ts` (marker on the prototype, non-enumerable, frozen and non-configurable, not
  encoded, survives a decode, inherited without mutating the base; runtime catchCategory), `error-for.test.ts`
  (every one of 40 x 52 (operation, flag) builds the exact promised class, tag, flag and `ErrorCategories`
  categories), `d6-invariant.test.ts`, `operations.test.ts` (TwoFactorRequired exactly on 2FA-starred rows,
  CommunicationDisabled on every timeout-masked row, PermissionDeniedUnattributed on every guild request, View
  first and Connect second, variants, ThreadArchived never on send), `gen-errors.test.ts`, `snowflake.test.ts`.
- Type fixtures: pass `catch-tag-exact.ts` (now with library errors and the same-tag variants),
  `catch-category-exact.ts`, `operations-table.ts` (one exact union per row of `OpErrors<never>`, D8, D5,
  Observed gating, `errorFor`'s precise return), `error-categories.ts` (the mirror equals the type-level
  categories; D6 at the type level), `ids.ts`; fail `catch-category-exact.ts` (an absent category, alone, in a
  list, and data-first; each names the category, largest 325 gated characters). Registry: `R-catch-category-exact`
  (pure-typing). Hover: `test/hover/op-errors.ts` shows an `OpErrors` lookup as class names, with `Transient`
  kept as its alias name.
- Mutation checks (each reverted): dropping `ThreadArchived` from `message.pin.thread`, giving the reaction
  variant `state` instead of `access`, branding `StickerId` as `EmojiId`, and making `RateLimited` also `state`
  each made `bun run test:types` exit 1 in the fixture meant to catch it.
- Compile cost of `src/` alone (`--checkers 1`, two identical runs): 27,933 types, 112,607 instantiations,
  about 0.1 s check time (design measurement for the error module: 25,994 and 106,218).

### M2 Harness foundation, identities and oracle

- `src/config/Credentials.ts`: the `Credentials` service. `layer` takes the live lock first, then reads `.env`
  (resolved from the module, not the working directory) through `ConfigProvider.fromDotEnv`; tokens are only
  `Config.Redacted`, IDs decode through the branded schemas. Tests use fake credentials and take no lock.
- `harness/Lock.ts`: `/tmp/effect-discord-perms-live.lock`, created with `wx`; a dead pid on this host is taken
  over by renaming a temporary file over it and reading it back; another host's or an unreadable lock is never
  taken; released by its owner only.
- `harness/Pacing.ts`: one spacing bucket (5 per second, at most), the request and per-route write counters, and
  the 1,500 invalid-response abort.
- `harness/Identities.ts`: `SharedHttpClient` (guard, then pacing, then status counting) outside every
  `Layer.fresh`; `HarnessRest`, `TargetRest` and `SubjectRaw` as fresh REST stacks; `compose(base, credentials,
  pacing)` is the one wiring and `live` passes Bun's client and the real credentials.
  `test/unit/identities.test.ts` builds `compose` with a recording client and fake tokens and sees
  `Bot fake-harness-token`, `Bot fake-target-token`, `Bot fake-subject-token`, three distinct clients and one
  shared counter (3 requests). Mutations (each reverted): removing `Layer.fresh` failed it (one shared
  instance), and building pacing inside a fresh layer failed it (`expected +0 to be 3`).
- `harness/Lab.ts`: the guard (see "Design deviations"), `LabRequestFailed`, `LabCheckFailed`, `labStep`.
  `test/unit/lab-guard.test.ts` covers every refusal class, including kick, ban, member edits of a human, DMs,
  leaving the guild, global commands, protected channels and foreign roles, and (after the verifier fixes) the
  channel-list PATCH, channel and role creation, thread membership of a human, member edit bodies and AutoMod.
- `src/bot/Startup.ts` (`StartupFailed`, `restChecks`), `src/bot/Internals.ts` (`SubjectRaw`), `src/rest/ErrorMap.ts`
  (`classify`, `flattenFieldErrors`), `harness/IdentityCheck.ts`. `test/unit/startup.test.ts` drives the real
  dfx client over a scripted fake: success, 401, missing intent flags, 404 member, 502, transport, the 30 s
  deadline under `TestClock` (a `NoResponse` with reason `deadline`), and an unexpected answer as a defect; and
  `classify` on a 50035 body (`e.data.code`, field paths, numeric inner codes as strings), 5xx, a Cloudflare HTML
  403, transport, and a malformed body (defect).
- `src/rest/Oracle.ts` (`memberPermissions`): `Permissions`, `Unavailable` (404 code 0, 405) or `OracleFailed`;
  `test/unit/oracle.test.ts` (the request must carry `implicit=false`) also covers the lab-state file and smoke's
  judgment of the oracle; `test/unit/credentials.test.ts` covers the credentials layer and its lock.
- `harness/LabIds.ts` (spec and `.lab-state.json`), `harness/Wire.ts`, `harness/Reset.ts`, `harness/Provision.ts`,
  `harness/Smoke.ts`, `harness/main.ts` (`reset`, `smoke`, `inventory`, and from the second verifier round
  `selftest` with `harness/SelfTest.ts`; `run` prints "not built yet (M3)" and exits 1). Pure decisions are in `test/unit/reset-plan.test.ts` (channel and thread patches, member roles,
  delete plans with the undeletable types and the 14-day split, unpins, leftovers, role order with ties (a tie
  alone, with the harness above, fails), overwrites that differ only in `deny`, GuildMedia-only
  `kindNotAvailable`, the sticker PNG, write deltas).
- Live record for `LOG.md`'s M2 items: the oracle is **available**; `mfaLevel` is **0**; both managed roles'
  positions: **neither bot has a managed role** (`Perms Harness` 11, then `lab-high` 10 ... `lab-unmentionable`
  1, `@everyone` 0); the harness **has** the Message Content flag.
- The lab as provisioned: category `lab` with `lab-text`, `lab-announcement`, `lab-voice`, `lab-stage`,
  `lab-forum` (tag `lab-tag`), `lab-bots-only`; threads `lab-public-thread`, `lab-private-thread`,
  `lab-announcement-thread`, `lab-forum-post`; ten roles; sticker `lab-sticker`; `lab-media` unavailable.
- Provisioning from scratch was run twice (once with the first lab, once after forgetting every stored ID to
  check the final code): the second created 21 objects and made 31 writes, including the one role-position
  PATCH and the closing reset. That run found a bug, fixed in the same milestone: the first attempt failed with
  `404 10011 Unknown Role` because reset deleted a leftover role and then tried to remove it from the target;
  reset now drops deleted leftovers from its view (`withoutLeftovers`, unit-tested).
- Exit evidence (final code): `bun run harness:smoke` exited 0 twice in a row (each `reset: writes 0`,
  `provision: created 0; writes 0`, 75 requests, 0 invalid), then `bun run harness:reset` reported `writes: 0`
  twice; `bun run verify:offline` is green.
- Verifier fixes (see "Design deviations"): the guard's body checks, smoke's oracle judgment, the credentials
  layer's exports, GuildMedia-only `kindNotAvailable`, unpinning every kept pin, vitest refusing Bun. Mutation
  checks (each reverted, each failed its test): dropping `implicit=false`, `orderHolds` accepting ties,
  `overwritesMatch` ignoring `deny`, and each new guard, smoke, credentials, unpin and kind check. Exit evidence
  after the fixes: the reset self-test (14 writes, then 0), two `harness:smoke` runs exiting 0 (`oracle:
  available, 10 reads and the control`, the control matching, 75 requests, 0 writes, 0 invalid), two
  `harness:reset` runs with `writes: 0`, and `bun run verify:offline` green with 253 unit tests.
- Verifier fixes, round 2 (see "Design deviations"): reset restores thread slowmode; `harness:selftest` is
  committed and part of the exit; the guard checks thread and sticker names; smoke fails on a lab channel it
  would skip; offline tests for `IdentityCheck.run` and the invalid-response count. Live runs, in order, each
  alone under the lock:
  - `harness:selftest` with the final code: initial reset 0 writes; 13 dirt steps, 37 writes; the read-back saw
    34 problems, every step's among them; reset 28 writes (including 3 channel deletes, 1 unpin, 1 bulk delete,
    5 channel PATCHes, 2 member PATCHes); read-back at baseline; second reset 0 writes; 299 requests, 0 invalid.
  - The same with the thread-slowmode restore removed (reverted after): `selftest FAILED: LabCheckFailed
    ... reset (28 writes) left the lab off baseline: lab-public-thread slowmode (5)`. The reset after it, with the
    fix back, made 1 write (`PATCH /channels/{id}`).
  - The same with reset's `@everyone` step and timeout clearing removed (reverted after): `reset (27 writes) left
    the lab off baseline: @everyone permissions (1024, not 0); subject timeout (...); target timeout (...)`. The
    reset after it made 3 writes (one role PATCH, two member PATCHes). These two mutations still pass
    `bun run test`; they are effectful reset steps, and the self-test is their check.
  - Offline mutation checks (each reverted, each failed `bun run test`): every `IdentityCheck` check removed in
    turn (application ID, distinct bots, guild name, `#rules`, top role), an empty or name-only protected set,
    arming before the checks; no status counting in `SharedHttpClient`; smoke skipping a missing ID, dropping
    the thread reads, the control reading the subject; sticker writes allowed, sticker names ignored, form
    fields not read; the overwrite sub-route length check; thread names ignored, thread-from-message creates
    unchecked, the thread-create method check; the thread slowmode restore; and the read-back ignoring thread
    slowmode, `@everyone`, timeouts or system message types, and `unseen` going blind.

