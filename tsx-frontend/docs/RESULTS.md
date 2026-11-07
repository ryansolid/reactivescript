# Measured results

## Shrink and repin: fdbcad92 / Solid rc.21

Clean ReactiveScript fdbcad921c6bc1cae59cbebe9905eeabc480e88f; Solid
2105ffb8ca2fced55f5fac0763177fc93f97c2c2, exactly ref/SOLID_NEXT (2.0.0-rc.21).
Node 24.18.0, Rust 1.97.1. No upstream patches.

The gate is now the kept subset, not the old full-port failure catalog. It includes every yield test from frontend
main 6fb8ea8. No yield source or fixture was changed by the shrink. V8 coverage of the kept TSX tests and 200 seeds
was used to find unused branches; removed behavior is refused before lowering.

| Check | Result |
| --- | --- |
| Kept tests | 53 passed (33 TSX/verifier, 20 yield), 0 failed/skipped/todo/cancelled |
| Fuzz seeds 0–199 | 179 agree; 21 listed interpreter-only differences; no adapter/semantics differences or generator errors |
| Strict types | 0 package diagnostics; unchanged baseline of 12 upstream diagnostics |
| Upstream interpreter | 111 pass, 1 fail: S-store-8 |
| Upstream oracle | 112 pass, 0 fail, 0 skip |
| Upstream compiled | 112 pass, 0 fail, 0 skip |
| Upstream types | 152 pass, 0 fail |
| Upstream SSR / Chromium | 105 pass, 0 fail, 7 upstream skips |
| Rust AST/check/model parity | 317/317 |
| Rust lowering | 184/184; 232 modules across 3 targets, 696 source maps |
| Rust projection | 185/185; 283 files, 11672 mappings |
| Rust unit tests | 6 passed, 0 failed |

Commands: npm run verify:subset; OUT=.out/repin-fdbcad92 sh scripts/verify-pinned.sh --rust; git diff --check.
The frontend subset is green. The full pinned check is red because upstream's S-store-8 exits 1; its expected
Z-B- frame is Z+B- at instant 4. The runner and its exit are not hidden. Raw logs and the report are under
.out/repin-fdbcad92; the fixed fuzz traces are under .out/fuzz/run-0-200.

The 21 fuzz differences are explicitly listed in baselines/fuzz-upstream.json, not passed off as backend agreement.
Native Solid and compiled RX agree; TSX and handwritten RX agree within each backend. The interpreter still exposes
held writes early (docs/FUZZ.md U1/U2). New upstream differences fail the gate until reviewed.

## What was removed, not fixed

The old baseline was 573 tests with 96 failures. Legacy tests outside the kept set, browser fixtures, the failure
catalog, coverage rename/removal machinery, server/context/effect helpers and patch queue were deleted. Source
contexts were withdrawn upstream (O-4 / RG-7c); they now get the general outside-subset refusal. Async computations,
derived stores, previous/deferred values, general setup helpers/constants and cross-module components are also out.
Patch 0001 still applied at this pin; it was dropped because server functions are outside the subset, not because
upstream fixed the key defect. Old failing tests were not weakened or relabeled as successes.

DOM/hydration is no longer a frontend claim. Upstream's own SSR runner still runs unfiltered, with its own seven skips.
The retained frame/fact assertions are unchanged. The default-component entry and plain-value optimistic question
flag remain required by the paired and yield tests.
