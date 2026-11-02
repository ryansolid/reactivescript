# Round 10 results: defects and cost by model tier, four approaches (2026-11-02)

Pre-registration: `eval/PREREG-desk-10.md` (frozen 9aba2ef). 36 runs: 4 arms × (3 frontier + 6 small). Solid `next` 81803325,
rxc from 9aba2ef. Frontier runs used the current Opus model, small runs the current Haiku model (from the transcripts).

## Defects per app (hidden failed + overlap failed + fuzz seeds with a hole, less legal holds)

| arm | frontier mean | small mean | small per desk |
|---|---|---|---|
| .rx (inline docs) | 6.7 | **6.7** | 3, 4, 6, 13, 3, 11 |
| React | 3.0 | 14.7 | 14, 7, 18, 17, 16, 16 |
| plain TypeScript | 2.7 | 9.8 | 13, 9, 9, 10, 9, 9 |
| Foldkit (inline docs) | 4.7 | 14.5 | 16, 13, 15, 14, 15, 14 |

Tests (small tier; `stats.txt`):

- **H10a** (.rx < React): permutation p = 0.0071, Holm 0.014. **Supported.**
- **H10b** (.rx < Foldkit): p = 0.0020, Holm 0.006. **Supported.** (.rx < plain): p = 0.070, Holm 0.070. **Not supported.**
- **H10c** (small .rx no worse than frontier React): difference +3.7 defects, 90% bootstrap interval [1.0, 6.5]; the
  upper end is not under 1. **Not supported.** Small .rx is level with frontier .rx, but frontier React and plain are
  better than both.

Correct apps (0 defects): none in any arm. Two overlap tests fail in 28 of 36 desks across every arm, frontier
included ("labels that load while an add is out keep the add", "comments that load while a post is out keep the
post"). So the pre-registered **cost per correct app is undefined in every cell**; cost per app is reported instead.

### Breakdown (means per app)

| arm, tier | hidden | overlap | fuzz |
|---|---|---|---|
| .rx frontier | 0.7 | 1.7 (2.3 raw) | 4.3 |
| .rx small | 1.3 | 3.3 (3.8 raw) | 2.0 |
| React frontier | 0.0 | 2.0 | 1.0 |
| React small | 0.2 | 10.3 | 4.2 |
| plain frontier | 0.3 | 2.0 | 0.3 |
| plain small | 0.8 | 7.7 | 1.3 |
| Foldkit frontier | 0.0 | 3.3 | 1.3 |
| Foldkit small | 0.2 | 11.8 | 2.5 |

Where the small React, plain and Foldkit desks lose: overlapping writes against loads (a list or detail that loads while
an assign, rename or close is out drops the guess: 18 desks; an older declined rename clobbers a newer accepted one:
14 desks; overlapping settings saves: 12). No small .rx desk fails those.

## Legal holds (replay-checked, `legal.mjs`, `legal/`)

- "two issues assigned at once: declining one reverts only that row": .rx desks 1, 3, 5, 8, 9 hold the declined row
  until the other assign's refresh lands (H-11; Ryan 2026-10-31: a declined row guess waiting on another action's
  refresh of the list is by design), then show the expected rows. Subtracted (1 each). rx-7 fails it for real (its
  second assign never fires).
- No other failure qualified.

## Brief ambiguity (sensitivity only, not subtracted above)

"a detail that loads while a rename is out keeps the new title" clicks `retry` on a loaded issue. The brief lists
`retry` after the error states; 25 desks (all arms) show it only on error, so the test fails on a missing button.
Excluding it: small .rx 5.7, React 13.7, plain 8.8, Foldkit 13.7; the tests come out the same (`stats.txt`).

## Framework bugs found (count against the arm, per the prereg)

Filed with plain Solid repros:

- solidjs/solid#4627: an `Errored` recovery waits for a flight that a fresh nested `Loading` in the new content should
  catch. Hidden "retry after not found" fails in rx-6, rx-8, rx-9; rx-1, 2, 3 worked around it during their runs.
- solidjs/solid#4629: a second optimistic guess made while the first action's refresh is in flight never shows through a
  keyed projection (rx-1 and rx-3 fuzz seed 12).
- solidjs/solid#4631: a keyed projection keeps a removed row after a declined removal is guessed again (rx-5 fuzz
  seed 3, where the row shows `#undefined undefined (undefined)`).

Other .rx fuzz holes (counts at rest or while closes are out, closed rows shown, detail titles) are not yet reduced.
Some may be the same bugs. The hidden failures "selecting after a failure shows loading, not the old failure" (rx-4,
rx-9) are D-39 behaviour (an error stays on screen until a new answer replaces it) meeting a test that expects the
loading text. They are counted.

## Cost (billed units × list input price per token: frontier $4/M, small $0.10/M)

| arm | frontier $/app | small $/app | frontier calls | small calls |
|---|---|---|---|---|
| .rx | 2.90 | 0.085 | 30.3 | 15.8 |
| React | 1.35 | 0.066 | 14.0 | 8.7 |
| plain | 1.24 | 0.082 | 10.3 | 9.7 |
| Foldkit | 3.56 | 0.155 | 37.3 | 35.8 |

Small desks cost about 1/15 to 1/40 of frontier desks in every arm. Defects per dollar are not a pre-registered measure.

## Reading

In the small tier, .rx roughly halves React's and Foldkit's defects (H10a, H10b supported) and is level with plain code.
The gap is overlap: the language handles the overlap cases the small React, Foldkit and plain desks miss.
The floor is not raised to frontier React: frontier React and plain desks write fewer defects than any .rx desk, and
frontier .rx has the most fuzz holes; the three Solid issues filed above account for some of them. Six small desks
(react-4, rx-7, rx-8, vanilla-7, vanilla-8, vanilla-9) ended without a final report and were graded as they stood.
rx-7 (13 defects) and rx-9 (11) are the two weak .rx desks.

Files: `summary.txt` (per desk), `graded/` (grade.sh output), `full/` (full hidden and overlap output), `cost.json`,
`usd.json`, `agents-10.txt` (desk to transcript), `stats.py`.
