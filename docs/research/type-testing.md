# Type tests, diagnostic snapshots and compile budget under TypeScript 7.0.2

Research only. Every output below comes from a real run in
`.scratch/type-testing/` on minisforum (16 cores, Node 24.22.1, Bun 1.4.4,
`typescript@7.0.2`, `effect@4.1.1`, `vitest@5.0.5`, `expect-type@1.4.0`). Claims I
could not check are marked **UNVERIFIED**.

## Recommendation

Use the TypeScript 7 `tsc` CLI for everything, and use only one compiler.

| Need | Tool | Command |
|---|---|---|
| Positive type tests | `expectTypeOf` from `vitest` (plain types) in `test/types/pass/*.ts`, compiled by the runner | `bun scripts/type-tests.ts` |
| Negative tests + diagnostic snapshots | `test/types/fail/*.ts` with `// @expect-error <mention>` directives, snapshot `<name>.diagnostics.txt` next to each fixture | same run; `--update` rewrites snapshots |
| Both, under the hood | **one** `tsc -p test/types/tsconfig.json --pretty false` for every fixture (~100 ms) | |
| Compile budget | `tsc -p examples/tsconfig.json --extendedDiagnostics --checkers 1 --pretty false`, 5 runs; gate on Instantiations/Types (deterministic), check time loosely; committed `budget.json` | `bun scripts/budget.ts` |
| Budget forensics (ad hoc) | `tsc ... --generateTrace <dir> --checkers 1` + `@typescript/analyze-trace` | not part of verify |
| Hover readability (optional) | `typescript/unstable/async` `checker.typeToString` at `^?` markers | separate script, pinned TS version |

Do not use vitest typecheck mode for the snapshots. Do not add TypeScript 6 or
tstyche. Reasons are in sections 4–5.

The biggest design finding is not about tooling. Under the project's
`exactOptionalPropertyTypes: true`, **any** assignability failure between two
`Effect` types prints a misleading header: `... with
'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of
the target's properties.` (section 8.1). Compile-time rules must therefore fail
on a *message-carrying* type, not on an `Effect`-to-`Effect` mismatch.

---

## 1. What `tsc` 7.0.2 supports (verified)

`node_modules/.bin/tsc` is a small Node launcher (`typescript/bin/tsc` →
`lib/tsc.js`). It `process.execve`s the Go binary from
`@typescript/typescript-linux-x64/lib/tsc`. `tsc --help --all` lists:

| Flag | Present | Notes from real runs |
|---|---|---|
| `--pretty false` | yes | Format `file(line,col): error TSnnnn: head` plus chain lines indented two spaces per level. Same shape as TS 5/6. |
| default `--pretty` | `true` in help | In practice, pretty output appears only when stdout is a TTY (checked with `script`). Piped output was already plain. Always pass `--pretty false` explicitly. |
| related information | — | **Dropped by `--pretty false`.** For example, "Arguments for the rest parameter 'unhandled' were not provided." and "The last overload is declared here." appear only in pretty output or through the API. |
| `--extendedDiagnostics`, `--diagnostics` | yes | Both print the **same** fields in TS 7 (TS 6 prints many more). Stats go to stdout after the diagnostics and are printed even when there are errors. |
| `--generateTrace <dir>` | yes | Writes `legend.json`, `trace.json` (Chrome trace events) and **one `types_N.json` per checker**. |
| `--listFiles`, `--listFilesOnly`, `--explainFiles`, `--traceResolution` | yes | `--listFiles` prints absolute paths after the diagnostics. |
| `--noErrorTruncation` | yes | Removes `... 2 more ...` elisions. |
| `--checkers N`, `--singleThreaded` | yes (new) | The default is **4 checkers whatever the core count** (`GOMAXPROCS=1/2/16` and `taskset -c 0` all gave identical counts). |
| `--stableTypeOrdering` | yes, **default true** | Union members print in a stable order, e.g. `DiscordUnavailable \| MissingEmbedLinks`, whatever the declaration or check order. |
| `--locale` | yes | `LANG`/`LC_ALL` (de, fr, ja) did **not** change the text; only `--locale de` did. Snapshots are locale-safe if you never pass `--locale`. |
| `--incremental` | yes | vitest uses it. |
| `--pprofDir`, `--generateCpuProfile` | yes | Not needed. |
| files on the command line next to a tsconfig | error | `error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline. Use '--ignoreConfig' to skip this error.` |
| exit code with errors | `1` | TS 6.0.3 exits `2` for the same input. Do not depend on exit codes; parse the output. |

`--extendedDiagnostics` output (TS 7.0.2):

```
Files:              395
Lines:           ...
Identifiers:     ...
Symbols:         ...
Types:            27628
Instantiations:  133758
Memory used:    150636K
Memory allocs:   ...
Config time:     0.000s
Parse time:      0.033s
Bind time:       0.014s
Check time:      0.171s
Emit time:       0.000s
Total time:      0.225s
```

If the program has syntax errors, the `Check time` line is missing. The budget
script treats that as a failure.

### 1.1 The checker count changes the numbers

The same 300-handler reference was checked as one file and as four files:

| Config | Types | Instantiations | Check time (wall) |
|---|---|---|---|
| 1 file, default (4 checkers) | 29 605 | 143 060 | 0.18 s |
| 4 files, default (4 checkers) | 37 780 | 154 769 | 0.054 s |
| 1 file, `--checkers 1` | 28 396 | 140 855 | 0.17 s |
| 4 files, `--checkers 1` | 28 396 | 140 855 | 0.16 s |
| 4 files, `--singleThreaded` | 28 396 | 140 855 | 0.16 s (total 0.34 s) |

- With several checkers, the counts are sums across checkers. Each checker
  re-creates shared types, so the totals depend on how files are distributed.
  Adding an unrelated file can move the numbers.
- `Check time` is wall-clock, so parallel checkers shrink it.
- With `--checkers 1`, counts do not depend on file splitting or core count and
  are identical run to run (10/10). Parsing stays parallel, so `--checkers 1`
  costs nothing compared with `--singleThreaded`.
- Over 8 runs, check-time noise was about ±6% (164–194 ms).

**Use `--checkers 1` for the budget.** Gate on Instantiations and Types
(deterministic). Gate check time loosely.

### 1.2 `--generateTrace`

`trace.json` contains `parse:createSourceFile`, `bind:bindSourceFile`,
`check:checkSourceFile`, `checkTypes:getVariancesWorker` and similar events.
`@typescript/analyze-trace@0.11.1` (installed only in scratch) worked on a
`--checkers 1` trace ("Hot Spots └─ Check file …/reference.ts (215ms)"). On a
default 4-checker trace it reported "Found nothing in 1 project(s)". **Use
`--checkers 1` for traces as well.**

## 2. Programmatic API in TS 7.0.2

`typescript@7.0.2` `package.json` exports:

```
".": "./lib/version.cjs"            // only { version, versionMajorMinor }
"./unstable/sync", "./unstable/async", "./unstable/ast", ".../ast/is", ".../ast/factory", ...
```

There is no `ts.createProgram`, `formatDiagnostics` or
`flattenDiagnosticMessageText`. The unstable API spawns `tsc --api --cwd …` and
talks to it over msgpack/JSON-RPC:

- `new API({ cwd })` → `api.updateSnapshot({ openProjects: [tsconfigPath] })`
  → `snapshot.getProjects()[0]` → `project.program.getSemanticDiagnostics(file)`
  and `project.checker.getTypeAtPosition(file, pos)` / `typeToString(type)`.
- `Diagnostic` = `{ fileName, pos, end, code, category, text, messageChain?,
  relatedInformation? }`. It has character offsets but no line/column, and no
  formatter. You would rebuild the CLI text yourself.
- **`unstable/sync` does not work under Bun 1.4.4.** Its `SyncRpcChannel`
  reads `child.stdout._handle.fd` and fails with `TypeError: undefined is not
  an object (evaluating 'stdout._handle.fd')`. It works under Node 24.
- **`unstable/async` works under both Bun and Node.**
- Timing, 2 fixtures: spawn 3 ms, `updateSnapshot` 55 ms, diagnostics 7 ms.
  Timing, 200 fail fixtures: about 85–90 ms in total, close to one CLI run.
- **The import path is not stable.** `npm view typescript@7.1.0-beta exports`
  shows `./sync`, `./async`, `./ast` with no `unstable/` prefix, so code
  importing `typescript/unstable/*` will break on the 7.1 upgrade.

What the API adds: structured `relatedInformation`, and `typeToString` at a
position, which allows hover-style snapshots. Compiled and run with
(`scripts/hover-probe.ts`):

```ts
import { API } from "typescript/unstable/async"
// ...
const api = new API({ cwd: dir })
const snapshot = await api.updateSnapshot({ openProjects: [path.join(dir, "tsconfig.json")] })
const project = snapshot.getProjects()[0]!
const type = await project.checker.getTypeAtPosition(file, pos) // pos of the identifier above a `//  ^?` line
const shown = type ? await project.checker.typeToString(type) : "<none>"
```

Output:

```
export const sent = send(channel, { content: "hi", embeds: [{ title: "t" }] })
  => Effect<Message, SendError<{ readonly content: "hi"; readonly embeds: readonly [{ readonly title: "t"; }]; }>, never>
export const caught = sent.pipe(Effect.catchTag("MissingEmbedLinks", () => Effect.void))
  => Effect<void | Message, DiscordUnavailable | MissingSendMessages | MissingViewChannel | SlowmodeActive, never>
```

The first line is exactly the kind of hover the brief forbids. It names a type
alias around the whole payload instead of the error union, so a hover snapshot
test is worth having. **UNVERIFIED:** whether `typeToString` matches the LSP
hover (quick info) text exactly. The API has no quick-info call.

## 3. Spawn cost and strategy timings

Spawning `tsc -p tsconfig.fail.json` (effect + bun types, 2 fixtures), averaged
over 10 runs:

| Launcher | ms/run |
|---|---|
| `node node_modules/typescript/bin/tsc` | 90 |
| `bun node_modules/typescript/bin/tsc` | 76 |
| Go binary directly | 68 |
| `tsc --version` through the node launcher | 27 |

Strategies for N fail fixtures (`scripts/bench.ts`, Bun):

| Strategy | 40 fixtures | 200 fixtures |
|---|---|---|
| One `tsc` for the directory | 99–101 ms | 116–156 ms |
| One `tsc` per fixture, sequential | 2 940–3 660 ms | (≈18 s extrapolated) |
| One `tsc` per fixture, 8 in parallel | 1 100–1 590 ms | — |
| `unstable/async` API, one snapshot | 82–91 ms | — |
| TS 6.0.3 compiler API (`createProgram`) | — | 993–1 034 ms |

The per-directory diagnostics were byte-identical to the per-fixture
diagnostics (40/40). Ten repeated runs, and runs with `--checkers 8`, all
produced the same md5. Because TS 7 orders types stably, one shared program
does not change the text. Conclusion: **one `tsc` per directory is fast enough.
The API buys nothing for diagnostics.**

Gotcha: a per-fixture tsconfig generated under `/tmp` broke `types: ["bun"]`
(`TS2688: Cannot find type definition file for 'bun'`), because type roots
resolve relative to the config. Generated configs must live inside the repo.

## 4. Vitest 5 typecheck mode with TS 7

It works. `vitest run --typecheck.only`, or `typecheck: { enabled, only,
include: ["*.test-d.ts"], tsconfig }`, ran 3 `expectTypeOf` tests in 158 ms
and correctly failed the deliberately wrong one.

How it picks the checker (read from
`node_modules/vitest/dist/chunks/index.*.js`):

- `typecheck.checker` defaults to `"tsc"`. It also accepts `"vue-tsc"` or a
  path to an executable.
- Vitest spawns it through `tinyexec`, which prepends `node_modules/.bin` from
  the cwd upward. It therefore runs the repo's TS 7 launcher.
- Arguments: `--pretty false --noEmit --incremental --tsBuildInfoFile
  <vitest dist dir>/tsconfig.tmp.tsbuildinfo -p <tsconfig>`, or `--build` when
  `typecheck.build` is set.

Why it is not suitable for diagnostic snapshots:

- **Mangled text.** Its parser does `errInfo.split(":")` and re-joins with
  `""`, which removes every colon. `"Expected: literal string: X"` was reported
  as `"Expected literal string X"`. It also keeps only part of the chain.
- **Writes into `node_modules`.** The tsbuildinfo goes to
  `node_modules/vitest/dist/tsconfig.tmp.tsbuildinfo`. I deleted the copies my
  runs created.
- It only attributes errors to tests. A fail fixture needs the full text.
- It prints "Testing types with tsc and vue-tsc is an experimental feature."

`expectTypeOf` itself, as plain types imported from `vitest`, works well under
TS 7. Mutating an expected union made compilation fail with TS2344 and a
`{ _tag: "Expected: literal string: …" }` message. Use it inside pass fixtures
that the runner compiles.

## 5. TypeScript 6 as a second devDependency, and tstyche

Installed in scratch as `"typescript6": "npm:typescript@6.0.3"`. The npm
releases are `6.0.2`, `6.0.3`, `7.0.2` (latest), `7.1.0-beta`, plus nightly
`7.1.0-dev.*`. The TS 6 JS API works from Bun.

TS 6.0.3 compared with TS 7.0.2 on the same fixtures (`--pretty false`):

| Difference | TS 6.0.3 | TS 7.0.2 |
|---|---|---|
| Union order | `MissingEmbedLinks \| DiscordUnavailable` (creation order) | `DiscordUnavailable \| MissingEmbedLinks` (stable). TS 6 has a hidden `--stableTypeOrdering`, default false; with it, TS 6 matches. |
| Overload failure | Lists every overload: "Overload 1 of 3, '(…)', gave the following error." | Only "The last overload gave the following error." + related "The last overload is declared here.". Reported at the failing argument, not at the call start. |
| Elaboration | `t10`: TS2345 head + TS2741 chain | `t10`: a single TS2741 line |
| Elaboration | `UserId`→`ChannelId`: 2 lines | 3 lines (an extra intermediate step) |
| `--extendedDiagnostics` | ~25 fields, `I/O Read time` etc. | 14 fields |
| Counts (same pass fixtures) | Types 3 443, Instantiations 6 320 | Types 5 049 / 8 692 (default checkers) or 3 458 / 6 334 (`--checkers 1`) |
| Time (pass fixtures) | 0.69 s total | 0.06 s total |

Verdict: a TS 6 snapshot does **not** show what TS 7 users see, especially for
overloads. TS 6 is also 6–10× slower, and the counts cannot be compared across
versions. Having two compilers means two diagnostic dialects. Rejected.

tstyche, which has `expect(x).type.toRaiseError("text")`:

- `tstyche@7.2.5` explicitly skips TS ≥ 7.0. In `ManifestService`,
  `!Version.isSatisfiedWith(tag, "7.0")`, and "latest" resolves to the newest
  6.x. It resolves `typescript` only if the path ends in `lib/typescript.js`,
  so it ignores the installed TS 7 and would download TS 6 into
  `~/.local/share/TSTyche`. With `TSTYCHE_TYPESCRIPT_MODULE=<ts6>/lib/typescript.js`
  and `TSTYCHE_STORE_PATH` set inside scratch, it ran 2 tests (3 assertions,
  including `toRaiseError("Unhandled error MissingEmbedLinks")`) in 1.5 s, on
  TS 6.0.3.
- `tstyche@8.0.0-beta.0` (unpacked, not run) has a native adapter that loads
  `exports["./sync"]`. It rejects 7.0 with "The installed TypeScript version
  7.0 is not supported. Please upgrade to TypeScript 7.1 or later."
- So tstyche on TS 7 needs TS ≥ 7.1 and tstyche 8. Revisit then.
  **UNVERIFIED:** whether tstyche 8 with TS 7.1 works with this project.

## 6. Prototype: fixture convention and runner (end to end)

Layout (`.scratch/type-testing/`):

```
lib/perms.ts                          # tiny stand-in for the typed layer (tagged errors, send, handler)
test/types/tsconfig.json              # extends root; include lib + pass + fail
test/types/pass/catch-tag-removes-exactly-its-tag.ts
test/types/pass/payload-computes-permissions.ts
test/types/fail/handler-rejects-unhandled-permission.ts
test/types/fail/handler-rejects-unhandled-permission.diagnostics.txt
test/types/fail/send-on-category-and-mixed-ids.ts
test/types/fail/send-on-category-and-mixed-ids.diagnostics.txt
scripts/type-tests.ts                 # the runner
scripts/budget.ts                     # the compile budget
budget/reference.ts, budget/baseline.json
```

Pass fixture (compiled, exact types):

```ts
const sent = send(channel, { content: "hi", embeds: [{ title: "t" }] })
expectTypeOf(sent).toEqualTypeOf<
  Effect.Effect<Message, MissingViewChannel | MissingSendMessages | SlowmodeActive | MissingEmbedLinks | DiscordUnavailable>
>()
const withoutEmbedLinks = sent.pipe(
  Effect.catchTag("MissingEmbedLinks", () => Effect.succeed<Message>({ channelId: channel.id }))
)
expectTypeOf<Effect.Error<typeof withoutEmbedLinks>>().toEqualTypeOf<
  MissingViewChannel | MissingSendMessages | SlowmodeActive | DiscordUnavailable
>()
```

Fail fixture with directives. Each `// @expect-error <mention>` owns the lines
up to the next directive:

```ts
// @expect-error CategoryChannel
send(category, { content: "hi" })

// @expect-error ChannelId
export const channelId: ChannelId = userId
```

Committed snapshot `send-on-category-and-mixed-ids.diagnostics.txt`, exactly
as `tsc --pretty false` printed it:

```
L7:6 TS2345
Argument of type 'CategoryChannel' is not assignable to parameter of type 'TextChannel'.
  Types of property 'kind' are incompatible.
    Type '"category"' is not assignable to type '"text"'.

L10:14 TS2322
Type 'UserId' is not assignable to type 'ChannelId'.
  Type 'UserId' is not assignable to type '{ readonly [ChannelIdBrand]: "ChannelId"; }'.
    Property '[ChannelIdBrand]' is missing in type 'String & { readonly [UserIdBrand]: "UserId"; }' but required in type '{ readonly [ChannelIdBrand]: "ChannelId"; }'.
```

The runner (`scripts/type-tests.ts`, type-checked under the repo's strict
tsconfig) runs `tsc -p test/types/tsconfig.json --pretty false` **once**,
parses located diagnostics (head line at column 0, chain lines indented), and
fails if:

1. tsc prints anything that is not a located diagnostic, such as `error TS5112`
   or a config error;
2. a diagnostic falls outside the fixture files, for example in `lib/`;
3. a pass fixture has any diagnostic;
4. a fail fixture has no directive, or compiles cleanly;
5. a diagnostic appears before the first directive;
6. a directive's range has no diagnostic;
7. a diagnostic does not contain its directive's mention, so the message must
   name the permission or rule;
8. a diagnostic exceeds the readability gate (4 lines or 600 characters), the
   wall-of-types check;
9. the rendered text differs from `<fixture>.diagnostics.txt`. A unified
   expected/actual dump is printed, and `--update` rewrites the snapshot.

Real outputs:

```
$ bun scripts/type-tests.ts                     # before snapshots existed, handler using technique 2
test/types/fail/handler-rejects-unhandled-permission.ts:8: unreadable diagnostic (2 lines, 607 chars; limit 4/600)
Argument of type 'Effect<…>' is not assignable to parameter of type 'Effect<…> & UnhandledErrorsMustBeCaught<"MissingEmbedLinks">' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' …
…
FAIL 3 problem(s); 2 pass + 2 fail fixtures, 3 diagnostics, tsc 98 ms, total 102 ms

$ bun scripts/type-tests.ts                     # after switching handler to technique 3 and --update
ok 2 pass + 2 fail fixtures, 3 diagnostics, tsc 95 ms, total 96 ms
```

I checked each failure mode with throwaway fixtures. A fail fixture that
compiles produced `// @expect-error MissingEmbedLinks produced no diagnostic`.
A wrong mention produced `diagnostic does not mention "MissingSendMessages"`.
A type error in a pass fixture produced `pass fixture has a type error: …`.

End-to-end wall time is **0.10–0.11 s** for the 4 fixtures and about 0.12–0.16 s
for 200. Nearly all of it is the single `tsc` process.

Required tsconfig wiring (verified):

- The root `tsconfig.json` currently includes `test`. It must add
  `"exclude": ["test/types/fail"]`, or `bun run typecheck` fails on purpose.
  Verified: with that exclude, the root-style config compiles clean.
- `test/types/tsconfig.json` extends the root and **must set `"exclude": []`**.
  A child config inherits `exclude` from its base when it sets only `include`.
  Verified: without `exclude: []` the fail fixture was silently dropped from
  `--listFilesOnly`.
- Fixtures must be modules, with an import or export, and must not use
  `declare global` or augmentation, because they share one program.
- Snapshot what users see: default truncation (`... 2 more ...`), no
  `--noErrorTruncation`, no `--locale`.
- `// @ts-expect-error` cannot replace snapshots. It hides the text. TS 7
  still reports unused directives (`TS2578: Unused '@ts-expect-error'
  directive.`), so it is fine for cheap "must not compile" checks where the
  message does not matter.

## 7. Compile budget prototype

`scripts/budget.ts` runs `tsc -p budget/tsconfig.json --extendedDiagnostics
--checkers 1 --pretty false` 5 times. It fails if any run has a diagnostic or
if Types/Instantiations differ between runs. It takes the median of `Check
time` and `Memory used`, then compares with `budget/baseline.json`:

```json
{ "typescript": "7.0.2", "files": 395, "types": 27628, "instantiations": 133758, "memoryKb": 150681, "checkMs": 167 }
```

Gates in the prototype:

- hard ceilings that are never raised casually: instantiations 250 000,
  types 60 000, check 1 000 ms;
- regression against the baseline: Instantiations/Types +2%, check time
  ≤ 1.5 × baseline + 25 ms;
- a refusal if the baseline's TypeScript version differs, because counts are
  not comparable across compilers.

Each run takes 1.5 s for 5 runs. Regression demo: an expensive mapped and
conditional type over `PermissionFlagsBits` added to `send`'s return type
gave

```
FAIL compile budget:
- instantiations 133758 -> 231543 (+73.1%, tolerance 2%)
```

In the same run, check time went only from 167 to 211 ms (+26%), which is
inside a sane time tolerance. Instantiations are the signal that catches it.
(Side data: the template-literal handler, technique 3, costs fewer
instantiations than the branded-intersection handler, technique 2: 133 758
against 140 855 on the same reference.)

## 8. Readable custom type errors: what TS 7.0.2 prints

All of these were compiled in `techniques/` with the project's strict
tsconfig. The text is verbatim from `--pretty false`. `leaky` is an
`Effect<void | Message, DiscordUnavailable | MissingEmbedLinks>`, and only
`DiscordUnavailable` is transient.

### 8.1 Trap: Effect plus `exactOptionalPropertyTypes`

`Effect`'s interface declares optional unification members
(`[Unify.typeSymbol]?: unknown; [Unify.unifySymbol]?: EffectUnify<this>;
[Unify.ignoreSymbol]?: {}`). With `exactOptionalPropertyTypes: true`, TS picks
the TS2375/TS2379 header for **every** `Effect`→`Effect` mismatch:

```
errors.ts(8,14): error TS2375: Type 'Effect<void, MissingEmbedLinks, never>' is not assignable to type 'Effect<void, never, never>' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
  Type 'MissingEmbedLinks' is not assignable to type 'never'.
```

With `--exactOptionalPropertyTypes false`, the same code prints a plain
`TS2322: Type 'Effect<void, MissingEmbedLinks, never>' is not assignable to type
'Effect<void, never, never>'.`. TS 6.0.3 prints the same misleading header, so
this is not new in TS 7. The advice is wrong and adds noise. Rules should fail
against a message type, not `Effect` against `Effect`.

### 8.2 Techniques compared

| # | Technique | TS 7.0.2 output | Verdict |
|---|---|---|---|
| 1 | Plain constraint `<A, E extends TransientError, R>(e: Effect<A,E,R>)` | `TS2379: Argument of type 'Effect<void \| Message, DiscordUnavailable \| MissingEmbedLinks, never>' is not assignable to parameter of type 'Effect<void \| Message, DiscordUnavailable, never>' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined'…`<br>`  Type 'DiscordUnavailable \| MissingEmbedLinks' is not assignable to type 'DiscordUnavailable' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined'…`<br>`    Property 'status' is missing in type 'MissingEmbedLinks' but required in type 'DiscordUnavailable'.` | Names the tag only inside a union. Two misleading headers and an irrelevant `status`. Poor. |
| 2 | Intersect with an interface whose **property name** is the message: `Effect<A,E,R> & ([NonTransient<E>] extends [never] ? unknown : UnhandledErrorsMustBeCaught<Tags>)` | `TS2379: … parameter of type 'Effect<…> & UnhandledErrorsMustBeCaught<"MissingEmbedLinks">' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined'…`<br>`  Property '"Handlers may only leave transient errors unhandled. Unhandled tags:"' is missing in type 'Effect<…>' but required in type 'UnhandledErrorsMustBeCaught<"MissingEmbedLinks">'.` | Message present, but still an Effect intersection, so the trap applies. 607 characters; failed the runner gate. |
| 3 | **Parameter collapses to a template-literal message**: `effect: [NonTransient<E>] extends [never] ? Effect<A,E,R> : \`Unhandled error ${Tags}: catch it, or opt out with Effect.orDie\`` | `TS2345: Argument of type 'Effect<void \| Message, DiscordUnavailable \| MissingEmbedLinks, never>' is not assignable to parameter of type '"Unhandled error MissingEmbedLinks: catch it, or opt out with Effect.orDie"'.` | **Best.** One line, names the tag and the escape hatch, no trap. Inference of A/E/R still works (pass fixture: `expectTypeOf(ok).toEqualTypeOf<Effect.Effect<void \| Message, DiscordUnavailable>>()` compiles). With 2 tags it prints a union of two message literals, which is still readable. |
| 4 | Conditional rest parameter `...unhandled: [...] extends [never] ? [] : [error: \`Unhandled ${Tags}\`]` | `TS2554: Expected 2 arguments, but got 1.` (the tag name appears only in related info, which `--pretty false` drops) | Bad. |
| 5 | Operation exists only on the members that allow it | `TS2339: Property 'send' does not exist on type 'CategoryChannel'.` / `… 'ForumChannel'.` / on the union: `… type 'CategoryChannel \| ForumChannel \| TextChannel'.`<br>`  Property 'send' does not exist on type 'CategoryChannel'.` | Excellent and free. Use it for channel kinds, message authorship and interaction state. |
| 6a | Plain overloads | `TS2769: No overload matches this call.`<br>`  The last overload gave the following error.`<br>`    Argument of type 'CategoryChannel' is not assignable to parameter of type 'ForumChannel'. …` | **TS 7 shows only the last overload.** The relevant overload's error can be hidden. |
| 6b | "Poison" overload carrying a message, placed **last** | `TS2769: No overload matches this call.`<br>`  The last overload gave the following error.`<br>`    Argument of type '"hi"' is not assignable to parameter of type '"Categories cannot receive messages; send to a text channel instead"'.` | Works only when the message overload is last. Placed first, TS 7 shows the ForumChannel error instead (verified in `ovl/ovl.ts`). Fragile. |
| 7 | Validate a `const` literal, return a message literal: `name: N extends Lowercase<N> ? N : \`Command names must be lowercase (got "${N}")\`` | `TS2322: Type '"Ping"' is not assignable to type '"Command names must be lowercase (got \"Ping\")"'.` | Excellent for command names, custom_id length and the like. Avoid `"` inside the message; it prints escaped. |
| 8 | `satisfies` against a discriminated shape | `TS2353: Object literal may only specify known properties, and 'custom_id' does not exist in type 'LinkButton'.` | Excellent for component layout rules (link buttons have no custom_id). |
| 9 | Collapse an invalid argument to `never` | `TS2345: Argument of type '{}' is not assignable to parameter of type 'never'.` | Anti-pattern; says nothing. |
| 10 | Intersect with a branded `TypeError<"message">` object | `TS2741: Property '"~typeError"' is missing in type '{}' but required in type 'TypeError<"A message needs at least one of: content, embeds, files, sticker_ids, poll">'.` | Good for object payloads that are not Effects. |
| 11 | (Effect built-in) `catchTag` with a tag the effect cannot produce | `TS2345: Argument of type '"MissingAttachFiles"' is not assignable to parameter of type '"DiscordUnavailable" \| "MissingSendMessages" \| "MissingViewChannel" \| "SlowmodeActive" \| readonly ["DiscordUnavailable" \| … , ...("DiscordUnavailable" \| ... 2 more ... \| "SlowmodeActive")[]]'.` | Acceptable; Effect's own wording. |
| 12 | IDs with Effect `Brand.Brand<"ChannelId">` | `TS2322: Type 'UserId' is not assignable to type 'ChannelId'.`<br>`  Type 'UserId' is not assignable to type 'Brand<"ChannelId">'.`<br>`    Types of property '[TypeId]' are incompatible.`<br>`      Property 'ChannelId' is missing in type '{ readonly UserId: "UserId"; }' but required in type '{ readonly ChannelId: "ChannelId"; }'.` | Head line is readable if IDs are **named aliases**. With `typeof Schema.brand(...).Type` and no alias it prints `string & Brand<"RoleId">`, which still names the brand. |

What a "wall" looks like, used to calibrate the gate (`ovl/wall.ts`, a mapped
and conditional `Validate<P>` called from generic code): 9 lines, nested 8
deep, the exactOptionalPropertyTypes header four times, and `'readonly { title:
string; }[]' is not assignable to type 'never'`. A 4-line / 600-character
limit rejects it, and every acceptable output above fits.

Guidance that follows:

- For the handler boundary, use technique 3.
- For "operation does not exist here", use member absence (5).
- For literal-validated definitions, use message literals (7).
- For payload shape, use `satisfies` or excess-property checks (8), or a
  branded `TypeError` (10).
- Avoid `never` collapses, rest-arity tricks and overload-based messages.
- Keep public type names readable. The hover probe showed
  `SendError<{ readonly content: "hi"; … }>`; resolving it to the tag union
  would read better.

## 9. Recommended setup (exact)

`package.json` scripts. These are proposals; I did not edit package.json.

```json
{
  "typecheck": "tsc -p . --pretty false",
  "test:types": "bun scripts/type-tests.ts",
  "test:types:update": "bun scripts/type-tests.ts --update",
  "budget": "bun scripts/budget.ts",
  "budget:update": "bun scripts/budget.ts --update",
  "budget:trace": "tsc -p examples/tsconfig.json --generateTrace .trace --checkers 1 --pretty false"
}
```

`verify:offline` should run `typecheck`, the unit tests, `test:types`,
truth-table replay, and `budget`. It must never run either `--update` variant.

Files:

- root `tsconfig.json`: add `"exclude": ["test/types/fail"]`;
- `test/types/tsconfig.json`: `{ "extends": "../../tsconfig.json", "include":
  ["../../src", "pass", "fail"], "exclude": [] }`;
- `test/types/pass/*.ts`: `import { expectTypeOf } from "vitest"`, exact
  `toEqualTypeOf` / `toBeNever` assertions, no runtime;
- `test/types/fail/*.ts` + `*.diagnostics.txt`: one `// @expect-error <Tag or
  rule word>` per expected error;
- `examples/tsconfig.json`: the reference bot only;
  `examples/budget.json`: the baseline, with the TS version.

Commands the runner and budget actually execute:

```
tsc -p test/types/tsconfig.json --pretty false
tsc -p examples/tsconfig.json --extendedDiagnostics --checkers 1 --pretty false   # x5, median time
```

Pin `typescript` to an exact version (`"7.0.2"`, not `^7.0.2`). Diagnostic
text, counts and the import path of the unstable API all change between
compiler releases (sections 2 and 5). A TS upgrade becomes a deliberate step:
re-run `test:types:update` and `budget:update` and review both diffs.

## Unverified

- Whether `checker.typeToString` output equals the editor hover (LSP quick
  info) text in TS 7.
- Whether tstyche 8 works with TS ≥ 7.1 on this project. Only its source was
  read.
- Whether the TS 7.0 "last overload only" reporting is intended and permanent,
  or will change in 7.1+.
- Behaviour on macOS or other hosts. All measurements are from minisforum
  (Linux x64, 16 cores). Counts with `--checkers 1` should be host-independent
  but were not checked on a second host.
- Whether `@typescript/analyze-trace` can be made to handle multi-checker
  traces (it found nothing with the default 4 checkers).

## Scratch index (`.scratch/type-testing/`)

- `scripts/type-tests.ts`: the runner.
- `scripts/budget.ts`: the budget check.
- `scripts/bench.ts`: the strategy timings.
- `scripts/api-probe*.ts`, `scripts/hover-probe.ts`, `scripts/related-probe.ts`:
  the unstable API probes.
- `techniques/`: section 8.
- `ovl/`: overload order and the wall example.
- `vt/`: vitest typecheck.
- `ts6/`: TS 6.0.3 alias and its API.
- `tstyche-eval/`, `tstyche8/`: tstyche.
- `analyze-trace/`: the trace analyser.
- `budget/`, `budget4/`: the reference and the file split.
- `inherit/`: tsconfig exclude inheritance.
- `cli/`: the flag outputs.
