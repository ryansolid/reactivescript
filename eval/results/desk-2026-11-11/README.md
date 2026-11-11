# Round 11 results: defects and cost by model tier, four approaches (2026-11-11)

**Pre-registration:** `eval/PREREG-desk-11.md`, frozen at b8b9e0b.

**Runs:** 36, which is 4 arms × (3 frontier + 6 small). Frontier runs used the current Opus model, small runs the current Haiku model; the model is read from each transcript.

**Toolchain:** Solid `next` 6751472f, built from source; rxc from b8b9e0b.

**Grading:** `harness/grade.sh` (hidden 77, overlap 38, 20 fuzz seeds). Defects are failed hidden tests, plus failed overlap tests, plus fuzz seeds that found a hole. Only defects are counted. No fuzz hole was traced to a legal hold, so nothing is excluded.

## Defects per app

| arm | frontier mean | small mean | small per desk |
|---|---|---|---|
| .rx (inline docs) | 2.0 | **3.8** | 3, 3, 4, 2, 9, 2 |
| React | 2.0 | 9.7 | 13, 2, 17, 14, 1, 11 |
| plain TypeScript | 3.0 | 14.5 | 12, 16, 11, 9, 20, 19 |
| Foldkit (inline docs) | 2.7 | 13.2 | 17, 13, 13, 12, 10, 14 |

Frontier per desk: .rx 0, 5, 1; React 0, 2, 4; plain 3, 3, 3; Foldkit 4, 2, 2.

## Tests

All tests are on the small tier unless named otherwise; full output is in `stats.txt`.

- **H11a** (.rx < React): permutation p = 0.047, Holm 0.047. **Supported.**
- **H11b** (.rx < plain): p = 0.0021, Holm 0.0041. **Supported.**
- **H11b** (.rx < Foldkit): p = 0.0010, Holm 0.0031. **Supported.**
- **H11c** (frontier .rx no worse than frontier React): difference 0.0, 90% bootstrap interval [−2.3, 2.3]. The upper end is not under 1, so it is **not shown**. Both arms average 2.0, but three runs each are too few.
- **H10c again** (small .rx no worse than frontier React): +1.8, interval [−0.3, 4.2]. **Not shown.**

## Correct apps and cost

Two apps have no defect, the first in any round: frontier `.rx-1` and frontier `React-1`.

**Cost per correct app:** frontier .rx $6.14 and frontier React $4.15 (each arm's three runs over its one correct app). Every other cell has no correct app, so its cost per correct app is undefined.

Cost per run is billed tokens (`cost.json`) at round 10's rates (`usd.json`):

| arm | frontier $/run (round 10) | small $/run (round 10) | frontier calls | small calls |
|---|---|---|---|---|
| .rx | **2.05** (2.90) | 0.092 (0.085) | 21.3 | 15.5 |
| React | 1.38 (1.35) | 0.069 (0.066) | 12.7 | 11.8 |
| plain | 1.27 (1.24) | 0.077 (0.082) | 12.3 | 10.0 |
| Foldkit | 3.63 (3.56) | 0.175 (0.155) | 37.3 | 38.5 |

Frontier .rx cost about 30% less than in round 10. The other arms cost about the same.

## Change from round 10, same tests

Round 10's desks were regraded on this round's toolchain and tests (`r10-regraded/`). As pre-registered, the rename-reload test that round 10's brief caused is dropped from those numbers.

| arm, tier | round 10 regraded | round 11 |
|---|---|---|
| .rx frontier | 2.7 | 2.0 |
| .rx small | 4.7 | 3.8 |
| React frontier | 3.0 | 2.0 |
| React small | 13.7 | 9.7 |
| plain frontier | 2.7 | 3.0 |
| plain small | 8.8 | 14.5 |
| Foldkit frontier | 4.0 | 2.7 |
| Foldkit small | 13.5 | 13.2 |

Round 10 as first published had .rx at 6.7 in both tiers. The Solid fixes since then account for most of the drop to 2.7 and 4.7.

## Defects by kind

- **.rx:** no failure repeats in more than two desks. The overlap tests that fail in most desks of the other arms ("labels / comments that load while an add is out keep it") fail in only one .rx desk (rx-2).
- **React, plain, Foldkit (small):** most defects are overlap. Each fails 7 to 11 of 38 overlap tests on average: loads that land while a change is out drop the change, and late saves overwrite newer ones.

### .rx fuzz holes, traced

- **rx-2, seeds 1, 3, 18: a Solid bug.** A keyed projection whose function returns another keyed projection loses a row when the question switches while a guess is out. In a browser this shows as a duplicated row. The plain Solid repro is filed as solidjs/solid#4762. It counts against .rx, as pre-registered.
- **rx-5, rx-6, rx-7, the "row assignee" holes: agent mistakes.** The assign guess is written only when the row is in the list on screen (`if (i >= 0)`), so a row hidden by a close guess never gets it.
- **rx-5 and rx-8, the "detail title" holes: agent mistakes.** rx-5 seed 15 was replayed; rx-8 has the same code shape and was not replayed. The rename guess is written to a source derived from the detail before the detail has loaded. Solid drops a guess that was never shown (D-34), so the old title stays on screen while the rename is out.
- **rx-4 seed 15 (detail title): agent mistake.** Rename guesses are kept in their own list, and the heading reads it with `find`, which returns the oldest guess. With two renames out, the heading shows the first one, while the row shows the second.

## Lines of source per app

Non-blank lines, without the given `api` and `flights` files.

| arm | frontier | small |
|---|---|---|
| .rx | 414 | 373 |
| React | 784 | 744 |
| plain | 873 | 967 |
| Foldkit | 2276 | 2340 |

## Deviations

- foldkit-6 and foldkit-7 ended without a final report and were graded as they stood.
- rx-5 used 16 check/test runs, one over the cap of 15.
- react-5 listed the file names in `eval/` (it read no contents) and said so.
- Three agents (rx-1, rx-2, react-4) added temporary visible tests and then restored the file.
- None of these affects grading.

## Reading

- **Small tier:** the round 10 result replicates. Small .rx writes fewer than half of React's defects and about a quarter of plain's and Foldkit's.
- **Frontier tier:** all four arms are now close, between 2 and 3 defects. .rx is level with React, but three runs per arm cannot show "no worse".
- **Cost:** frontier .rx is still dearer than React and plain ($2.05 against about $1.30) but cheaper than Foldkit. With 3 of its 6 frontier defects from one Solid bug, the frontier .rx count is partly Solid's still.

## Files

- `summary.txt`: per desk.
- `graded/`: `grade.sh` output.
- `r10-regraded/`: round 10's desks on this toolchain.
- `stats.py`, `stats.txt`.
- `cost.json`, `usd.json`.
- `agents-11.txt`: desk to transcript.
