# Round 12: round 11 again with five arms and twice the frontier runs

Pre-registration, committed before any round 12 agent runs. Status: FROZEN (Ryan, 2026-11-11 "Go").

## Why

Round 11 (`results/desk-2026-11-11`) replicated round 10's small-tier result.

- **Small tier:** .rx had 3.8 defects per app and React 9.7. H11a holds, at p = 0.047.
- **Frontier tier:** every arm was between 2 and 3. With three runs per arm, H11c ("no worse than React") could not be shown: the interval was [−2.3, 2.3].
- **XState:** a side check the same day (`results/xstate-2026-11-11`, not pre-registered) put small XState at 7.0, between .rx and React and below Foldkit's 13.2.

Round 12 asks whether these hold with fresh agents. It adds XState as a fifth arm and doubles the frontier runs, so the frontier comparison has a chance to resolve.

Ryan, 2026-11-11: replication now, maintenance next. Maintenance moves to round 13 and runs on round 12's apps.

## Task and arms (as round 11 unless stated)

**Task:** `tasks/desk9` with `brief-plain.md`, unchanged. Graded by `hidden.mjs` (77) and `hidden-overlap.mjs` (38), unchanged.

**Arms:**
- **`rx`** with `--inline-docs` (`language.md`, `async.md`, `reference.md`).
- **`foldkit`** with `--inline-docs`.
- **`react`**.
- **`vanilla`**.
- **`xstate`**, new: React 19 with xstate 5.32.6 and @xstate/react 6.1.0, with no TanStack Query. It uses `--inline-docs`, which here means Stately's own v5 cheatsheet and @xstate/react's README in the prompt. Every Stately v5 docs page is readable in `docs/xstate`, from statelyai/docs at 7ee0c60. The checker is the same as React's.

**Language and guide changes since round 11's freeze:**
- `guess` replaces `optimistic` (#47).
- Errors are cleared with `onFlush` (#47).
- A guess over an equation is allowed (#48).
- Destructuring works (#49).

The guide follows all four. `rxc` is built from the commit that holds this file once it is frozen. Round 11's .rx desks use `optimistic`, so the gate below grades them with round 11's `rxc`, which isolates the Solid change.

**Guide addition** (principle only, no task code): `async.md` says how to guess a prop. You guess over the child's own equation of it, never `props.x`.

**Solid:** `solid-next` at `next` bcef1041, built from source. It holds the fixes for both cases of solidjs/solid#4762: cf32a50b (a keyed projection of a projection losing a row on a switch) and #4769 (two guesses, one landing after the switch, now hold together as D-33 says).

**Harness:** subagents, as in round 11.

## Runs, grading

**Runs:** 6 frontier and 6 small per arm, 60 in all, in one interleaved batch. Each run gets at most 15 `./check`/`./test` calls.

**Grading:** `harness/grade.sh`, with round 11's definitions of correct and cost. Only defects are counted. A fuzz hole counts unless it is traced to a legal hold, and each exclusion is listed with its trace.

## Hypotheses and tests

All tests use seed 12.

- **H12a** (primary, replication of H11a): small .rx runs have fewer defects than small React runs. One-sided permutation test on mean defects, 100,000 relabellings.
- **H12b**: three comparisons, Holm-corrected together with H12a:
  - small .rx has fewer defects than small XState;
  - small .rx has fewer defects than small plain;
  - small .rx has fewer defects than small Foldkit.
- **H12c**: frontier .rx runs have no more defects than frontier React runs. Difference in means with a 90% bootstrap interval, 10,000 resamples. The claim holds if the upper end is under 1 defect.
- **H12d**: small XState runs have fewer defects than small Foldkit runs. Same test as H12a, reported apart from the .rx family. This is the PROCESS question: state machines against Effect/TEA.
- **Descriptive:** cost per correct app, by arm and tier.
- **Reported alongside:**
  - the change from round 11 for each arm and tier;
  - defects by kind;
  - turns, cost per run and lines.

The direction is the claim being tested. A null or reversed result is reported as plainly.

## Gate before freezing

Round 11's nine .rx desks are regraded on the pinned Solid, with round 11's `rxc`. Any desk that gains a hole is traced. A Solid regression is filed upstream, then fixed or recorded, before the round starts.

**Gate result** (2026-11-11, on `next` bcef1041's source, round 11's `rxc`): 26 defects across the nine desks, against 29 in round 11. Only rx-2 changed, from 5 to 2: its three fuzz holes (seeds 1, 3, 18, solidjs/solid#4762) are gone, and its two overlap failures, which are its own (a pending source in a component that remounts), remain. The other eight desks grade exactly as in round 11. No desk gained a hole, so nothing needed tracing.

## Cost

About $67 at round 11's prices: 6 × ($2.05 + $1.38 + $1.27 + $3.63 + $2.30) for the frontier runs, plus about $3.30 for the small ones.
