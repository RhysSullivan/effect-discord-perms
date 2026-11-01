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
