# Regrade on Solid 2.0.0-rc.21 (2026-11-05, not a round)

The rc.21 repin (41a6b1f) carried the fixes for every Solid issue the eval had filed but did not rerun anything. This
regrades what the repository holds, with rc.21 from npm and `rxc` from this commit. Round 10's and round 11's desks are
not in the repository (their run directories stayed in the session that ran them), so they are not here.

## References on the desk9 brief (`harness/grade.sh`: hidden, overlap, 20 fuzz seeds)

| app | hidden | overlap | fuzz seeds with a hole |
| --- | --- | --- | --- |
| chain4 .rx | 77/77 | 38/38 | 3 |
| chain4 React | 77/77 | 38/38 | 0 |
| recipe React (TanStack's optimistic-updates guide) | 77/77 | 22/38 | 7 |

The recipe React desk scores what round 9 recorded for it (22/38), so this setup grades as the rounds did. The chain4
.rx reference passes every hidden and overlap test, including "retry after not found" (#4425, #4627), which failed in
every .rx run from round 5 on.

Its three fuzz holes, replayed:

| seed | hole | cause | owner |
| --- | --- | --- | --- |
| 1 | the tab count shows 3 beside 2 rows, a close in flight | `latest issues` answers the re-asked truth, not the guess, once a list refresh lands under a pending close | Solid: solidjs/solid#4689, DV-19 (S-latest-reask) |
| 11 | an accepted rename's row shows the old title until the refresh lands | the row was not in the list when the rename was sent (`findIndex` -1): nothing was guessed on it | the app; `guide/async.md` §4 now says so |
| 15 | an accepted rename's detail heading shows the old title until the refresh lands | the detail was still loading when the rename was sent: nothing was guessed on it (the row guess held) | the app; the same |

Seed 1 is the reference as the checker wants it: CN-3e refuses the count effect's read of `issues` outside the
`loading on(filter)` region and suggests `latest issues`, which is the right program by H-7. Four references (chain2,
chain3, chain4, count) had the outside read, predating the rule, and are now written that way; they pass their own
tasks' hidden and overlap tests (`graded/`). The count hole is the runtime's, recorded as DV-19, and will close with
#4689.

Reducing seed 15 turned up a second Solid bug, solidjs/solid#4690: with nothing rendering a store, an effect reading it
sees a guess revert at the action's end, before the action's refresh lands, once an outside re-ask has landed under it.
A rendered reader keeps the guess, and so does an effect beside one; an effect over a source nothing renders reaches
it (DV-20, S-guess-reask-refresh's effect-only variant; `ref/oracle/repros/4690-guess-reask-refresh.mjs`).

Seed 1's verdict rests on DV-19 being Solid's bug. H-11 says a new answer that differs from the guess corrects the
graph with `latest x` the truth, and the outside answer here differs from the guess (it equals the truth the guess was
made over). If Solid declines #4689, the reference's `latest issues` count is not the count the list shows, and the
four references need another reader (see spec/05 DV-19).

## Round 4's .rx apps (18, `results/change-2026-10-28/runs`) on rc.21 and this `rxc`

| | runs |
| --- | --- |
| pass every hidden and overlap test | 14 |
| refused by `STALE_WRITE_BACK` (AC-1e, added after round 4) | 3: small close-rx-1, small comments-rx-2, frontier rename-rx-3 |
| one overlap test failed | 1: small rename-rx-1, a guess on `detail` with `refresh issues` only |

The three refusals are the three the round 4 write-up predicted. The one failure is the shape `guide/async.md` §4 now
names ("refresh every question you guessed on"). Nothing in round 4's residue is Solid's.

## Reference suites on rc.21

Interpreter 114 pass; oracle and compiled 114 pass, 3 recorded divergences (DV-19, DV-20 at two instants);
server render 107 pass, 7 skip (not rerun after the review fixes); types 156 pass; the crate agrees with ref/ on 321/321 programs.

S-store-8 (two actions' guesses on one row; a declined one reverts alone) had failed on the interpreter since the
commit that added it (edb76be): the interpreter kept one guess per node with one owner, so the newer action's guess took
the row and the older action's decline found nothing of its own to revert. Guesses are now entries per key and hold
(`ref/src/runtime.ts`), as H-11 says; the same-key variant added to S-store-8 passes on all three runners. A new answer that corrects a guess (D-34) marks
the action's entry spent instead of dropping it, so the action's re-ask still holds the corrected guess (D-35): with
the entry dropped, a closed row came back between the write landing and the re-ask (S-latest-reask's variant, `4 / 4`
for `2 / 4`; Solid shows `2 / 4`).

## Setup

`eval/package.json` now lists Playwright; `CHROMIUM=/path/to/chromium` drives a system browser in `harness/driver.mjs`
and `ref/ssr/run.ts`. `graded/`: the grade output per app above, and `round4-<tier>-<run>.txt` per round 4 app.
