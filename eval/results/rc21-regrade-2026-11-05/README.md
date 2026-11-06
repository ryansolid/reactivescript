# Regrade on Solid 2.0.0-rc.21 (2026-11-05, not a round)

The rc.21 repin (41a6b1f) carried the fixes for every Solid issue the eval had filed but did not rerun anything. This
regrades what the repository holds, with rc.21 from npm and `rxc` from this commit. Round 10's and round 11's desks are
not in the repository (their run directories stayed in the session that ran them), so they are not here.

## References on the desk9 brief (`harness/grade.sh`: hidden, overlap, 20 fuzz seeds)

| app | hidden | overlap | fuzz seeds with a hole |
| --- | --- | --- | --- |
| chain4 .rx (count read with `latest issues`) | 77/77 | 38/38 | 3 |
| chain4 .rx (count read under the list's region) | 77/77 | 38/38 | 2 |
| chain4 React | 77/77 | 38/38 | 0 |
| recipe React (TanStack's optimistic-updates guide) | 77/77 | 22/38 | 7 |

The recipe React desk scores what round 9 recorded for it (22/38), so this setup grades as the rounds did. The chain4
.rx reference passes every hidden and overlap test, including "retry after not found" (#4425, #4627), which failed in
every .rx run from round 5 on.

The `latest issues` reference's three fuzz holes, replayed:

| seed | hole | cause | owner |
| --- | --- | --- | --- |
| 1 | the tab count shows 3 beside 2 rows, a close in flight | `latest issues` answers the re-asked truth, not the guess, once a list refresh lands under a pending close | Solid: `latest` should keep a shown guess until its hold commits (solidjs/solid#4689, ruled in #4695 decision 3, not built; DV-19) |
| 11 | an accepted rename's row shows the old title until the refresh lands | the row was not in the list when the rename was sent (`findIndex` -1): nothing was guessed on it | the app; `guide/async.md` §4 now says so |
| 15 | an accepted rename's detail heading shows the old title until the refresh lands | the detail was still loading when the rename was sent: nothing was guessed on it (the row guess held) | the app; the same |

Seed 1 was the reference as the checker suggested it: CN-3e refuses the count effect's read of `issues` outside the
`loading on(filter)` region and suggests `latest issues`. Four references (chain2, chain3, chain4, count) had the
outside read, predating the rule. By the spec (and Solid's own ruling, #4695 decision 3) `latest issues` answers the
guess the list shows, so that program is right and the hole is Solid's (DV-19, #4689, not built). The references
read the count where the list is read instead, in a small component under the list's region: it holds and reveals
with the rows, it is equally right by the spec, it does not depend on #4689, and it is what 10 of 12 agent desks in
rounds 10 and 11 wrote. With it, chain4 has two fuzz holes, both the app's (seeds 11 and 15), and chain2, chain3 and
count pass their own tasks' hidden and overlap tests (`graded/`).

Reducing seed 15 turned up a second Solid bug, solidjs/solid#4690: with nothing rendering a store, an effect reading it
sees a guess revert at the action's end, before the action's refresh lands, once an outside re-ask has landed under it.
A rendered reader keeps the guess, and so does an effect beside one; an effect over a source nothing renders reaches
it (DV-20, S-guess-reask-refresh's effect-only variant; `ref/oracle/repros/4690-guess-reask-refresh.mjs`). Fixed on
`next` (Ryan, 2026-11-05); recorded until the repin.

## Round 4's .rx apps (18, `results/change-2026-10-28/runs`) on rc.21 and this `rxc`

| | runs |
| --- | --- |
| pass every hidden and overlap test | 14 |
| refused by `STALE_WRITE_BACK` (AC-1e, added after round 4) | 3: small close-rx-1, small comments-rx-2, frontier rename-rx-3 |
| one overlap test failed | 1: small rename-rx-1, a guess on `detail` with `refresh issues` only |

The three refusals are the three the round 4 write-up predicted. The one failure is the shape `guide/async.md` §4 now
names ("refresh every question you guessed on"). Nothing in round 4's residue is Solid's.

## Reference suites on rc.21

Interpreter 114 pass; oracle and compiled 114 pass, 6 recorded divergences (DV-19 at four instants, DV-20 at two);
server render 107 pass, 7 skip (not rerun after the review fixes); types 156 pass; the crate agrees with ref/ on 321/321 programs.

S-store-8 (two actions' guesses on one row; a declined one reverts alone) had failed on the interpreter since the
commit that added it (edb76be): the interpreter kept one guess per node with one owner, so the newer action's guess took
the row and the older action's decline found nothing of its own to revert. Guesses are now entries per key and hold
(`ref/src/runtime.ts`), as H-11 says; the same-key variant added to S-store-8 passes on all three runners. A new answer that corrects a guess (D-34) marks
the action's entry spent instead of dropping it, so the action's re-ask still holds the corrected guess (D-35): with
the entry dropped, a closed row came back between the write landing and the re-ask (S-latest-reask's variant, `4 / 4`
for `2 / 4`; Solid shows `2 / 4`). The interpreter now follows #4695's D-34: a landing answer is compared with the guess (before,
only one that changed the truth corrected), the correction re-derives the graph, and the screen, the guess's effects
and `latest` of a shown guess keep it until the hold commits.

## Setup

`eval/package.json` now lists Playwright; `CHROMIUM=/path/to/chromium` drives a system browser in `harness/driver.mjs`
and `ref/ssr/run.ts`. `graded/`: the grade output per app above, and `round4-<tier>-<run>.txt` per round 4 app.
