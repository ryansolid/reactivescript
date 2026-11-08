# Round 11: round 10 again, on a Solid with every eval bug fixed and the current guide

Pre-registration, committed before any round 11 agent runs. Status: DRAFT (needs Ryan's OK before it is frozen).

## Why

Round 10 (`results/desk-2026-11-02`) confirmed H10a: small .rx desks had 6.7 defects, small React desks 14.7. It
rejected H10c: frontier React desks had 3.0. Most of the .rx frontier defects traced to Solid bugs, and those have
all been fixed since (#4627 #4629 #4631 #4638 #4661 #4666 #4689). Regrading round 10's own apps on the fixed Solid
moved frontier .rx from 7.3 to 4.7 raw defects. Since round 10 the guide has gained `guide/reference.md`, the rules on
one page (PR #29), and the instant model (PR #34). A 3-desk check with `reference.md` (`results/cost-2026-11-03`, not
counted) gave frontier .rx 2.0 defects. Round 11 asks whether that holds with fresh agents, all four arms, both tiers,
and the same design as round 10, so the two rounds compare directly.

Round 10's plan named maintenance as round 11. It moves to round 12 and runs on round 11's apps, so the apps it extends
were written with the current guide on a fixed Solid.

## Task and arms (as round 10 unless stated)

- Task: `tasks/desk9` with `brief-plain.md`. **One change from round 10**: the detail's `retry` button is now always
  present while an issue is selected, not only after a failure. In round 10, 25 of 36 desks across all arms failed
  "a detail that loads while a rename is out keeps the new title" because the brief left this unclear. Graded by
  `hidden.mjs` (77) and `hidden-overlap.mjs` (38), unchanged.
- Arms: `rx` with `--inline-docs` (now `language.md`, `async.md` and `reference.md`), `foldkit` with `--inline-docs`,
  `react`, `vanilla`. `rxc` is built from the commit that holds this file once it is frozen.
- Solid: `solid-next` at `next` 2789ca9c (2026-11-08; includes the #4689 fix, which is not yet in an rc), built from
  source. The same build is used for every .rx run and grade. rc.22 isn't out; if it ships before the round starts and
  holds every fix, it replaces this pin.
- Harness: subagents, as in round 10. Numbers are comparable only within one harness: on the Foldkit side check
  (2026-11-08), the CLI harness alone moved Foldkit from 4.7 to 2.7 defects.

## Runs, grading

As round 10: 3 frontier and 6 small runs per arm (36), one interleaved batch, at most 15 `./check`/`./test` calls,
graded by `harness/grade.sh`. The definitions of legal holds, defects, correct and cost are round 10's.

## Hypotheses and tests

- **H11a** (primary, replication of H10a): small .rx runs have fewer defects than small React runs. One-sided
  permutation test on mean defects, 100,000 relabellings, seed 11.
- **H11b**: small .rx has fewer defects than small plain, and fewer than small Foldkit. Same test, Holm-corrected with
  H11a.
- **H11c**: frontier .rx runs have no more defects than frontier React runs. Difference in means with a 90% bootstrap
  interval (10,000 resamples, seed 11); the claim holds if the upper end is under 1 defect. (Round 10's H10c compared
  small .rx with frontier React. That comparison is reported again, as H10c was.)
- **Cost per correct app** (descriptive), by arm and tier. In round 10 no app was correct, so this was undefined.
- Reported alongside: the change from round 10 for each arm and tier, defects by kind, turns, cost per run, and lines.

The direction is the claim being tested. A null or reversed result is reported as plainly.

## Gate before freezing

The 12 existing .rx desks (round 10 1-9, cost check 1-3) are regraded on the pinned Solid. A regression against
rc.21 is filed upstream and fixed or recorded before the round starts.

Result (2026-11-08): on 2789ca9c one desk had a new deterministic hole (round 10 rx-8, fuzz seed 3: a close guess
during another action's refresh, then the refresh fails). It came from the lowering, not from the app: a whole guess
(`optimistic rows := rs => rs.map(...)`) was written into the draft row by row, which replaces each matched row. It now
lowers to the setter's return, which Solid diffs shallowly against the view as guesses (its default). With that, the
other 11 desks grade as before the change (52 defects over the 12; round 10 rx-9 fuzz seed 8, a known hole, is
deterministic on both lowerings and was missed once by timing), and seed 3 is gone. The plain Solid case is solidjs/solid#4724.

## Cost

About $30 at round 10's prices: frontier $2.90 (.rx), $1.35 (React), $1.24 (plain), $3.56 (Foldkit) per run;
small under $0.16.
