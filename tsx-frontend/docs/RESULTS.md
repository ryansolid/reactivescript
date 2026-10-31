# Measured results

## Current state (2026-10-31, pin 8518fa1e)

Stack: reactivescript 8518fa1e + patches/0001-server-question-keys (rebased; worktree `reactivescript-patched`),
Solid 5e68925c (= ref/SOLID_NEXT, solid-js 2.0.0-rc.20), Node 24.18.0, Rust 1.97.1. Run: `frontend/.out/repin-8518`
(`OUT=.out/repin-8518 sh scripts/verify-pinned.sh --rust`, READINESS mode).

**Verdict: NOT READY (3 blockers: suite exit 1, browser exit 1, 96 failing tests).** Integrity problems: 0.

Upstream at the pin (unmodified runners on pin + 0001, the new `pins.json` baseline): interpreter 109/0, oracle
109/0/0, compiled 109/0/0, types 149/0, SSR 102/0 with 7 skips; crate parity 317/317, `crate --lower` 181/181,
`crate --project` 182/182; `cargo test --release` in `compiler/` 6 passed, 0 failed. The frontend numbers below are
unchanged from aa85cbde (demo-1, same failing set): moving the pin added no failure and fixed none. Patch 0001 still
applies (rebased, same changes); the defect is not fixed upstream at 8518fa1e. Upstream's new AC-1e finding
(`STALE_WRITE_BACK`) needed no adapter change.

Previous state (2026-10-29, aa85cbde, `frontend/.out/demo-1`, `--skip-upstream`): the same frontend counts, with
the upstream runners skipped.

| | Now |
| --- | --- |
| All tests | 568 tests, 472 pass, 96 fail |
| Ported suite | 537 tests, 444 pass, 93 fail |
| Browser (Chromium) | 31 tests, 28 pass, 3 fail |
| Coverage manifest (568) | 568 ran, 0 missing, 0 unlisted |
| Skip / todo | 0 |
| Strict types | 0 package diagnostics; upstream's 12 strict errors baselined |
| `npm run verify:subset` | 21/21 (boundary 9, paired counter 3, composition 2, tracker demo 7) |

Comparison with `baselines/observed-failures.json` (an unapproved observation, unchanged): 0 new failures, 0 new
coverage gaps. Three observed entries no longer fail under their recorded identity, all because of the async-callback
policy below, not because a backend was fixed: `async-handlers :: interpreted authored TSX #5` now passes as a
refusal, and the `lower.test.ts` async block handler test and the browser `tsx async-handler` test were renamed to
refusal tests. Every other failure is still classified as in the history below; none is approved.

Changes since the 2026-10-28 measurement:

- **Async-callback policy (temporary, [issue #20](https://github.com/ryansolid/reactivescript/issues/20)).** Every
  authored ordinary async callback (event handlers, contextual callback props, forwarded and stored callbacks,
  `createRxEffect` apply callbacks and cleanups) is refused at its `async` node with guidance to write
  `action(function* () { ... yield request(); ... })`, which opts into held action semantics and is not a
  semantics-preserving rewrite. `action(async ...)` is refused too. Async memo/store/server computations and
  explicit generator actions are unaffected. Native and handwritten RX legs of the async-handler suites still run.
- **Subset checkpoint.** `npm run verify:subset` (typecheck, boundary, paired counter, composition, demo); see
  `docs/SUBSET.md`.
- **Tracker demo.** `tsx/demo.test.ts` with `tsx/fixtures/demo/tracker.{tsx,rx}`: store list with a draft path write,
  filter signal and memos, `For`/`Show` with fallback, a later-declared child with a callback prop, and an explicit
  generator action with an optimistic claim, success commit and failure rollback. Equal checker facts and identical
  frames across native Solid, both compiled programs and both interpreted programs.

## History: measurement of 2026-10-28

Stack: reactivescript aa85cbde + patches/0001-server-question-keys (worktree `reactivescript-patched`), Solid
ac28157 (= ref/SOLID_NEXT, Rust 1.97.1), Node 24.18.0, this package at commit 31ca133. Final run:
`frontend/.out/verify-8` (`sh scripts/verify-pinned.sh --rust`, READINESS mode).

**Verdict: NOT READY.** The port is not complete; the failures below are classified, not accepted.

### Upstream at the pins (unmodified runners, on pin + patch 0001; identical to the clean pin)

interpreter 104 PASS / 0 FAIL; oracle 104/0 (0 divergences); compiled 104/0 (0 divergences); types 144/0; SSR 97/0
with upstream's 7 skips; crate parity 305/305; `crate --lower` 176/176; `crate --project` 176/176. The same numbers
were measured on the clean pin before the patch (verify-pinned-3) and in the full canary of `main` (= pin).

### This package

| | Original worktree (old pin, reproduced from archive) | Now (pin + 0001) |
| --- | --- | --- |
| Ported suite | 513 tests, 510 pass, 3 fail | 527 tests, 432 pass, 95 fail |
| Browser (Chromium) | 31/31 | 31 tests, 27 pass, 4 fail |
| Coverage manifest (558) | n/a | 558 ran, 0 missing, 0 unlisted |
| Skip / todo | 0 | 0 |
| Strict types | clean | 0 package diagnostics; upstream's 12 strict errors baselined |
| Contracts | n/a | boundary 6/6, verifier 5/5, paired counter 3/3 |

Original known failures: structured optimistic rollback now **passes**; same-setup previous accessor still fails
(interpreter leg); async structured keyed replacement still fails (native leg).

### Coverage reconciliation

The manifest is the original 513 identities (file + name + occurrence) with 3 recorded renames (two lower.test.ts
decisions, the ported server namespace test), plus 14 added tests and the 31 browser tests. All 558 ran. The 22
async-handlers subtests that had stopped registering now always register; where upstream refuses the form, each leg
asserts that refusal.

### The 99 failures (baselines/observed-failures.json; unapproved observation)

Triage is leg-based where tests have backend legs (every leg runs the same lowered program).

| Category | Count | Evidence |
| --- | --- | --- |
| legacy core regression (patch not carried) | 23 | raw-AST/RX core suites (effect-semantics, rx-effects, snapshot-core) and store-inference emitter output written for the old runtime/emit patches |
| upstream behavior (handwritten RX reproduces) | 20 | the handwritten RX legs fail the same way (async-handlers, derived-stores interpreter frames, …) |
| upstream interpreter divergence | 17 | only interpreted legs fail; compiled legs of the same program match native (callbacks try/finally, previous, keyed-async, owned-lifetimes, …) |
| upstream defect | 17 | aliased error identity (reference + Rust checkers), same-named server fn keys (UPSTREAM-ISSUES #2, #3) |
| upstream interpreter divergence (single test) | 11 | a test's interpreter assertion fails before its compiled/native ones |
| upstream rule change | 4 | AC-1d STALE_OWN_READ (browser async-handler RX, features) |
| upstream semantic change (AC-1b/AC-1c) | 2 | inferred-action refusal outside the leg-based suites (features, browser TSX async-handler) |
| native behavior change | 2 | keyed-async native legs differ at Solid ac28157 |
| paired behavior mismatch (suspected upstream, unconfirmed) | 2 | server-identities refresh across two instances (compiled refresh is keyed by equation name, `lastKey.get(name)`) and serverFunction owner detachment (compiled shows `failed`); TSX-only tests, no handwritten RX repro yet |
| upstream behavior difference | 1 | in-place server body runs in the client owner (UPSTREAM-ISSUES #4) |

No failure is classified as an adapter (TSX-only) failure. Adapter defects found and fixed during triage: missing
`ErrVal`/`PENDING` adapter exports (snapshot-core failed to load), a fragment wrongly migrated by the entry tool
(features), `untrack(() => store.path)` silently changing meaning when the captured object is updated in place (now
refused at the authored span; accepted where nothing can update it in place).

### Not run / not covered

- No Rust route for TSX lowering (the crate consumes RX source; the frontend produces `Program` objects).
- The alias-identity and same-name server key defects need fixes in both the reference and Rust implementations; not
  patched. Interpreter divergences are reported, not patched.
