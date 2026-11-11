# Round 12 results: round 11 again, five arms, six runs per tier (2026-11-11)

**Pre-registration:** `eval/PREREG-desk-12.md`, frozen at 82c6e42.

**Runs:** 60, which is 5 arms × (6 frontier + 6 small), in one interleaved batch. Desks 1–6 are the frontier tier (Opus), desks 7–12 the small tier (Haiku).

**Toolchain:**
- Solid `next` bcef1041 (source identical to 0739445a), built from source.
- rxc from 82c6e42.

**Grading:** `harness/grade.sh`, with hidden 77, overlap 38 and 20 fuzz seeds.
- Defects are failed hidden tests, plus failed overlap tests, plus fuzz seeds that found a hole.
- Only defects are counted.
- No fuzz hole has been traced to a legal hold yet, so nothing is excluded. The traces so far are below.

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

### .rx traces so far

- **rx-1, seed 15 ("closed row shown"): a Solid bug.**
  - The app guesses two closes on a `createOptimistic` list of hidden ids and an assign on the optimistic issues store.
  - When the first close lands, its `refresh` drops both close guesses while the refresh is still out. Under D-33 and F-11, they should hold until it answers.
  - The plain-Solid repro is `repro/two-close-guesses.spec.tsx`. It passes without the assign guess.
  - It also fails on round 11's Solid (6751472f), so it is not caused by #4769.
  - Not filed yet.
- **rx-7, seed 12 ("closed row shown"): an agent mistake, most likely.**
  - After its await, each close writes `closed := [...closed, r.id]`. With two closes out, the second write reads `closed` without the first close's id, so an accepted close comes back.
  - The guide's functional form (`closed := c => [...c, r.id]`) avoids this.
  - AC-1e only covers a read made before the await, so no check fired.
- **rx-2, seed 13 ("closed row shown"): not yet classified.**
  - The app keeps two lists and chooses between them with `filter == "open" ? openIssues : closedIssues`.
  - After a failed open load, an accepted assign on the closed list and a switch to open, the open view shows the closed list's rows, still at rest after the open list lands.
  - This is the shape of #4762 (a keyed derivation over a choice of projections). It needs a plain-Solid repro.
- **The tab-count holes (rx-3, rx-10, rx-12):** each app passes the count to the app from an `effect` inside the list's loading region. While a row guess is out, the tab shows the count from before the guess. These are a tear between two views, not a hold, so they count.
- **The rest have not been traced.** That covers detail title, row assignee and dropped guess.

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

## Reading

- **Small tier:** .rx still has the fewest defects, about half of React's, plain's, XState's and Foldkit's. With the pre-registered Holm family, only the Foldkit comparison clears 0.05, so the primary hypothesis is not supported this round.
- **Frontier tier:** .rx is the worst arm, at 3.2, though its median is 2. One desk (rx-2, 10 defects) accounts for much of that, and one of rx-1's holes is a Solid bug. React is best at 1.8.
- **XState:** level with React at the frontier. In the small tier it lost the side check's advantage (7.0 → 13.0) and is now level with Foldkit and plain.
- **Cost:** frontier .rx costs $2.38 per run, against $1.31 for React. That is up from round 11's $2.05.

## Files

- `summary.txt`: per desk.
- `graded/`: `grade.sh` output.
- `stats.py`, `stats.txt`.
- `cost.json`, `usd.json`.
- `agents-12.txt`: desk to transcript.
- `repro/`: the plain-Solid repro.
