# LOG

The running record of the build: what Rhys needs to do, what live Discord showed where it differed from the
docs, where we wrapped or adapted dfx, and where the implementation deviated from `docs/DESIGN.md`. Each
milestone appends its entries.

`bun run rules` reads two things from this file: every escalated rule's `Q-<n>` must have a line under
"Waiting for Rhys", and every rule that is not pure-typing must be mentioned by its `R-` id somewhere here.

## Waiting for Rhys

Nothing yet.

## Live findings

Where live Discord differed from the docs, each citing its H-id. No live run has happened yet.

## dfx deviations

Where dfx got in the way and we wrapped or adapted it, and why. None yet.

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

## Escalated rules

Rules with an escalated remainder, shown by `verify:live` as unmet Done criteria. None yet.

## Notes for every milestone

- Run `bun --no-env-file install`, not `bun install`: plain `bun install` loads `.env` into its own process
  (it printed `[0.26ms] ".env"` when M0 re-locked TypeScript), where dependency lifecycle scripts could read
  the tokens. Checked in M0: `bun run <script>` does not pass `.env` to the scripts it starts, and
  `bun --no-env-file` keeps it out of the process (probed with a throwaway `.env` in `/tmp`, counting names
  only).

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
