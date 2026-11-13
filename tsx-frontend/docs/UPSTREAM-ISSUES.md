# Upstream issues relevant to the kept subset

Pin: clean ReactiveScript fdbcad921c6bc1cae59cbebe9905eeabc480e88f, Solid 2105ffb8 (2.0.0-rc.21).
These are observations, not waived frontend failures. Nothing was filed upstream by this work.

## S-store-8: upstream's interpreter fails its own scenario

The upstream test runner reports 111 pass, 1 fail. S-store-8 instant 4 expects Z-B- but gets Z+B-:
the pending marker remains after the store-path write. The oracle and compiled runners pass all 112 scenarios.
The full pinned gate records test exit 1 and fails; pins.json records the actual 111/1 baseline, not a clean result.
No scenario is excluded and no exit code is ignored.

## Held writes: interpreter differs from compiled RX and native Solid

The fixed 200-seed run has 179 matching cases and 21 interpreter-only differences. In those cases, TSX and RX agree
on each backend and compiled RX agrees with native Solid. The interpreter exposes writes the other backends hold:

- U1: calling-handler writes before a pending action.
- U2: writes while another action is already pending.

See docs/FUZZ.md and docs/FUZZ-findings.md for the reduced cases. baselines/fuzz-upstream.json names all 21 current
seeds. The gate reports them; new upstream differences, generator errors, frontend differences or native-versus-
compiled differences fail. The smoke test still asserts seeds 14 and 17 exactly. No held-write fix is claimed here.

## Ordinary async callbacks: issue #20

They remain refused, with guidance to use an explicit synchronous generator action only when its held-write
semantics are wanted. This is not a semantics-preserving rewrite. Explicit generator actions remain tested.

## Removed scope

The old broad port's failures are not part of the kept subset. Its source contexts, server helpers, async stores,
effects, browser tests and associated issue catalog were removed, not fixed. Upstream withdrew source contexts
(O-4 / RG-7c, PR #26); use write actions instead. They now receive the general outside-subset refusal.

Patch 0001 (server question keys) still applied at fdbcad92, but was dropped with server-function support.
Its removal is not evidence of an upstream fix. The package now runs against clean upstream with no patches.
