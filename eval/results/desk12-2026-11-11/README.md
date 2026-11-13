# Round 12 results: round 11 again, five arms, six runs per tier (2026-11-11)

**Pre-registration:** `eval/PREREG-desk-12.md`, frozen at 82c6e42.

**Runs:** 60, which is 5 arms × (6 frontier + 6 small), in one interleaved batch. Desks 1–6 are the frontier tier (Opus), desks 7–12 the small tier (Haiku).

**Toolchain:**
- Solid `next` bcef1041 (source identical to 0739445a), built from source.
- rxc from 82c6e42.

**Grading:** `harness/grade.sh`, with hidden 77, overlap 38 and 20 fuzz seeds.
- Defects are failed hidden tests, plus failed overlap tests, plus fuzz seeds that found a hole.
- Only defects are counted.
- **Correction (2026-11-13):** rx-3 seed 5 ("closed row shown: #3") was later traced to a legal H-11 hold: the close is
  guessed while an assign's re-ask of the list is out, so the row and the count both keep #3 until that re-ask answers,
  and they never disagree. Excluded: rx-3 goes from 4 to 3 defects, frontier .rx from 3.17 to 3.0. The fuzzer now
  excuses this hold (an accepted close whose guess never showed, while anything is in flight). Re-running all 60 apps
  with it changed only that seed.
- At grading time no fuzz hole was traced to a legal hold, so nothing was excluded. Two holes are Solid bugs (filed), and they count against .rx, as pre-registered.

## Defects per app

| arm | frontier mean | frontier per desk | small mean | small per desk | small median |
|---|---|---|---|---|---|
| .rx (inline docs) | 3.2 | 1, 10, 4, 0, 2, 2 | **6.0** | 3, 5, 9, 2, 15, 2 | 4 |
| React | 1.8 | 3, 0, 1, 3, 2, 2 | 11.3 | 16, 12, 6, 8, 11, 15 | 11.5 |
| plain TypeScript | 2.7 | 3, 2, 4, 3, 2, 2 | 12.3 | 7, 18, 13, 12, 14, 10 | 12.5 |
| Foldkit (inline docs) | 2.8 | 3, 2, 4, 3, 2, 3 | 13.2 | 15, 12, 13, 12, 16, 11 | 12.5 |
| XState (inline docs) | 2.0 | 3, 2, 1, 1, 2, 3 | 13.0 | 18, 19, 18, 1, 5, 17 | 17.5 |

## Tests

All tests use seed 12. Full output is in `stats.txt`.

| test | result | verdict |
|---|---|---|
| **H12a** (primary): small .rx < small React | p = 0.046, Holm 0.091 | **Not supported** |
| **H12b**: small .rx < small Foldkit | p = 0.011, Holm 0.043 | **Supported** |
| **H12b**: small .rx < small plain | p = 0.023, Holm 0.068 | **Not supported** |
| **H12b**: small .rx < small XState | p = 0.056, Holm 0.091 | **Not supported** |
| **H12c**: frontier .rx no worse than frontier React | difference +1.33, 90% interval [−0.83, 3.83] | **Not shown.** The upper end is not under 1. |
| **H12d**: small XState < small Foldkit | p = 0.50 | **Null** |

H12a and H12b are Holm-corrected together, as pre-registered. H12a's raw p is about the same as round 11's (0.047). The difference is that round 12 pre-registered three more comparisons in the same family, so the correction is stricter.

## Change from round 11

| arm, tier | round 11 | round 12 |
|---|---|---|
| .rx frontier | 2.0 | 3.2 |
| .rx small | 3.8 | 6.0 |
| React frontier | 2.0 | 1.8 |
| React small | 9.7 | 11.3 |
| plain frontier | 3.0 | 2.7 |
| plain small | 14.5 | 12.3 |
| Foldkit frontier | 2.7 | 2.8 |
| Foldkit small | 13.2 | 13.2 |
| XState frontier | 2.0 (side check) | 2.0 |
| XState small | 7.0 (side check) | 13.0 |

## Correct apps and cost

**Correct apps:** two have no defect, frontier `rx-4` and frontier `react-2`.

**Cost per correct app:**
- frontier .rx: $14.29 (six runs over one correct app);
- frontier React: $7.85.

Every other cell has no correct app.

Cost per run is billed tokens (`cost.json`) at round 10's rates (`usd.json`):

| arm | frontier $/run | small $/run | frontier calls | small calls | lines (frontier / small) |
|---|---|---|---|---|---|
| .rx | 2.38 | 0.095 | 25.2 | 17.5 | 431 / 370 |
| React | 1.31 | 0.064 | 14.5 | 11.2 | 857 / 736 |
| plain | 1.19 | 0.073 | 12.3 | 8.2 | 918 / 1000 |
| Foldkit | 3.29 | 0.169 | 35.7 | 41.5 | 2355 / 2113 |
| XState | 2.49 | 0.137 | 26.5 | 26.5 | 1388 / 1296 |

Lines are non-blank source lines, without the given `api` and `flights` files.

## Defects by kind

- **Overlap tests:** the four non-.rx small arms average 8.3 to 10.8 failed overlap tests per app; small .rx averages 2.5. "Comments / labels that load while an add is out keep it" still fails in most desks of every arm, including rx-2, rx-5 and rx-6.
- **Fuzz holes:** .rx holes, by kind:

| kind | holes | desks |
|---|---|---|
| detail title | 6 | rx-2, rx-3, rx-9, rx-10 |
| closed row shown | 4 | rx-1, rx-2, rx-3, rx-7 |
| tab count out of step with the rows | 4 | rx-3 (×2), rx-10, rx-12 |
| row assignee | 4 | all rx-11 |
| dropped guess | 2 | rx-7, rx-11 |
| row title | 1 | rx-2 |
| labels at rest | 1 | rx-11 |

- **Small-tier outliers:** XState is bimodal (1, 5 against 17–19). In the high desks, most defects are overlap: late loads drop changes still in flight.

### .rx traces

- **rx-1, seed 15 ("closed row shown"): a Solid bug, filed as solidjs/solid#4786.**
  - The app guesses two closes on a `createOptimistic` list of hidden ids and an assign on the optimistic issues store.
  - When both closes have landed, both close guesses are gone, although `assign:4` and both refetches are still out.
  - It passes without the assign guess. It also fails on round 11's Solid (6751472f).
  - Repro: `repro/two-close-guesses.spec.tsx`.
- **rx-2, seed 13 ("closed row shown"): a Solid bug, filed as solidjs/solid#4787.**
  - The app chooses between two keyed lists with `filter == "open" ? openIssues : closedIssues`.
  - When it switches back to a list whose load failed, the refetch never clears the error.
  - With an accepted guess on the other list, the open view shows the closed list's rows, at rest. It also fails on 6751472f.
  - Repro: `repro/switch-after-failed-list.spec.tsx`.
- **rx-7, seed 12 ("closed row shown"): an agent mistake.**
  - After its await, each close writes `closed := [...closed, r.id]`. With two closes out, the second write loses the first close's id.
  - The guide's functional form avoids this. AC-1e only covers a read made before the await, so no check fired.
- **Detail title (rx-2 seeds 5 and 8, rx-9 seed 15, rx-10 seed 15, replayed): agent mistakes, the same kind as round 11's.** Two shapes:
  - The rename is made while the detail is still loading. A guess on a value that was never shown is void (D-34), so the heading shows the old title through the whole rename.
  - The app puts no guess on the heading at all (rx-2).
  - rx-3 seed 15 and rx-9 seed 11 have the same trail shape but were not replayed.
- **Tab count (rx-3 ×2, rx-10, rx-12): counted.** Each app passes the count up from an `effect` inside the list's loading region. While a row guess is out, the tab shows the count from before the guess. This is a tear between two views, not a hold.
- **Not classified:**
  - rx-7 seed 8: a close declined on #4 also drops the assign guess on #4. Both guesses are functional guesses on one source, so this may be H-11.
  - rx-11 (row assignee ×4, a dropped rename guess, doubled labels): the desk fails 9 hidden and overlap tests on its own rename and save logic, so these are most likely its own.
  - rx-3 seed 5.

**Without the two Solid bugs**, frontier .rx is 3.0 instead of 3.2 (rx-1 0, rx-2 9), and small .rx is unchanged at 6.0. The tests above do not move.

## Deviations

- **Temporary visible tests, restored byte for byte (checked):** rx-1, rx-2, rx-3, rx-5, rx-6, xstate-1, xstate-2, react-11, react-12.
- **Scratch files written to `/tmp` and then deleted:** react-7, foldkit-9.
- **foldkit-9 posted one stray message to the project thread.** It has been edited to say so.
- **Ran `tsc` outside the check/test budget:** foldkit-7, foldkit-12.
- **Listed file names in `eval/harness` (read no contents):** foldkit-7.
- **Scratch scripts or simulations inside the run dir, deleted:** xstate-7, xstate-9, xstate-11, xstate-12.
- **rx-9 ended at 29 of 30 visible tests:** a related hit never opens the help page. It is graded as it stands.
- **A machine restart interrupted grading twice.** The interrupted desks were regraded from the start, and no result mixes two runs.
- None of these affects grading.

## Recurring .rx traps reported by the agents (guide candidates, not checks)

- **A filter switch held by a row guess (rx-2, rx-3, rx-5):** with one list whose question reads the filter, a guess on it holds the filter switch. All three split the list per filter.
- **A hold at mount (rx-4, rx-8, rx-9, rx-12):** `pending?` or a mount-time read outside a loading region holds the tab switch. rx-9 never solved it.

## Sensitivity (not pre-registered)

- **Without the worst small desk** (rx-11, 15 defects), small .rx averages 4.2, and every Holm comparison clears 0.05 (React p = 0.009).
- **A rank test**, which one outlier cannot dominate, gives small .rx < React p = 0.036.
- **Without the worst frontier desk** (rx-2, 10), frontier .rx averages 1.8, level with React.
- **Spread:** the standard deviation of small-tier defects is 7.9 for XState, 5.1 for .rx, 3.9 for React and 1.9 for Foldkit. Frontier is 3.6 for .rx and 1.2 for React.

## Reading

- **Small tier:** .rx still has the fewest defects, about half of React's, plain's, XState's and Foldkit's. With the pre-registered Holm family, only the Foldkit comparison clears 0.05, so the primary hypothesis is not supported this round.
- **Frontier tier:** .rx is the worst arm, at 3.2, though its median is 2. One desk (rx-2, 10 defects) accounts for much of that, and two .rx holes are Solid bugs (#4786, #4787). React is best at 1.8.
- **XState:** level with React at the frontier. In the small tier it lost the side check's advantage (7.0 → 13.0) and is now level with Foldkit and plain.
- **Cost:** frontier .rx costs $2.38 per run, against $1.31 for React. That is up from round 11's $2.05.

## Files

- `summary.txt`: per desk.
- `graded/`: `grade.sh` output.
- `stats.py`, `stats.txt`.
- `cost.json`, `usd.json`.
- `agents-12.txt`: desk to transcript.
- `repro/`: the plain-Solid repros.
