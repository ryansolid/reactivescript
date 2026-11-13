# desk9 on the new guide, Opus, 6 apps (2026-11-13)

Not preregistered. Question: with `guide/async.md`'s two new sections (#58: "lay every view of a write over the
answer", "data belongs with its lifetime"), does Opus get near the hand-written reference's 0?

**Setup:** Solid `next` + the #4828 fix (b8a8c2805, solidjs/solid#4829), rxc from main at 7e5bc81, desk9 scaffolded
`--brief plain --inline-docs`, Opus via general-purpose agents, graded with `harness/grade.sh`. The reference
(`reference/desk9/rx`) grades 77/77, 38/38, 0/20 on this build.

## Results

| app | guide | hidden | overlap | fuzz holes | defects |
| --- | --- | ---: | ---: | ---: | ---: |
| rx-1 | #58 | 76 | 37 | 2 | 4 |
| rx-2 | #58 | 76 | 37 | 0 | 2 |
| rx-3 | #58 | 76 | 37 | 3 | 5 |
| rx-4 | #58 + `visit := -1` | 77 | 37 | 1 | 2 |
| rx-5 | #58 + `visit := -1` | 77 | 37 | 1 | 2 |
| rx-6 | #58 + `visit := -1` | 77 | 36 | 1 | 3 |

rx-1..3 could not run `./test`: the eval's Playwright wanted its own Chromium build, which this container lacks, and
`./test` did not pass `CHROMIUM`. They wrote blind. `harness/driver.mjs` now falls back to `/opt/pw-browsers/chromium`.
rx-4..6 tested normally.

## What the defects are

- **Guide-caused, every app: settings moved into a module.** All six applied "data belongs with its lifetime" to the
  settings page too, with `guess saved := next` on the module's question. Reopening settings while a save is out then
  waits for the save: the tab switch is held with the reload, so the page never shows "Loading settings…" (overlap
  "a save that answers after the page was left"). rx-1..3 also loaded settings at app start (`visit := 0`), one ask
  too many (hidden "loads again when reopened"); the `-1` line fixed that for rx-4..6.
- **Guide-caused, rx-4/5/6: the open count moved out of the list's region.** With the data in a module, all three
  put the count `effect` beside it (module or App). An effect outside the list's `loading` waits for every re-ask, so
  a close guessed while a refresh is out shows in the rows but not in the tab (fuzz rx-4 s13, rx-5 s17, rx-6 s16).
  The reference's `OpenCount` sits inside the region.
- **Detail heading blank** (rx-1 s11, s15; rx-3 s15): `heading = detail == null ? "" : titleOf(renaming, …)` reads
  `""` while `detail.title` in the same frame reads the answer (probed). Needs a rename guess out, a failed list
  re-ask and a close's re-ask; a minimal scenario does not reproduce it. Unresolved: likely Solid.
- rx-3 s11, s19: page hangs (120 s). Not traced.
- rx-6: a row error from a write that answered after the issues page was left shows on its return (agent).

## Guide change after this probe

`guide/async.md` "Data belongs with its lifetime" now gives one rule (each value has one lifetime: the visit, the write
or the screen; split a value that would need two) and derives the module list, the save, the guess and the count from it.

## Rerun on the lifetime rule (rx-7..9)

| app | hidden | overlap | fuzz holes | defects |
| --- | ---: | ---: | ---: | ---: |
| rx-7 | 75 | 38 | 0 | 2 |
| rx-8 | 77 | 38 | 1 | 1 |
| rx-9 | 77 | 38 | 0 | **0** |

Mean 1.0 (rx-4..6: 2.33). No settings or count-placement failures: all three kept settings in the page and put the
count inside the list's region.

- rx-7: the help item's `errored` sits outside its `loading on(selected)`, so a new selection keeps the old failure
  or not-found message instead of showing loading (agent; not a lifetime case).
- rx-8 s16: the rows render as empty text (`["","",""]`) after the open list lands, while the tab counts 3. Same
  shape as rx-1/rx-3's blank heading: a text node left empty while its value is there. Likely Solid; no minimal repro.

## The blank text, in plain Solid

`repro/blank-rows.spec.tsx` (drop into solid-next `packages/web/test/`) reproduces rx-8 s16 in about 50 lines: a
keyed `createProjection` over a memo of an async list, two `createOptimistic` guess lists (assigns, closes), a declined
close among overlapping assigns, then a switch to another list. When the new list's re-ask lands, `For` renders one
`<li>` per row with no text. It fails on next b8a8c2805 and on cd4de2874 (before #4828). Without the projection
(`For` over the memo) it passes. Errored, `Loading on` and the page remount are not needed.

## On next f00ce6f52 (with the #4831 fix)

The repro passes. rx-8 regrades 77/77, 38/38, 0/20: **0 defects** (rx-7..9 now 2, 0, 0). The reference stays at 0.
rx-1 and rx-3 keep their blank detail heading (s11, s15): a plain memo, not a projection, so a separate bug.

## The blank heading, in plain Solid

`repro/blank-heading.spec.tsx` reproduces rx-1/rx-3 s15 on next f00ce6f52 in about 45 lines. There is no projection
and no error boundary. Setup:

- a list memo, and a detail memo that is still loading;
- one `createOptimistic` rename guess, read by both the list's rows and the heading memo;
- another action, out at the same time, that re-asks the list;
- the rename itself, still out.

When the other action lands (its re-ask goes out), and then the detail lands, the `<h2>` renders empty while
`detail.body` beside it shows. Without the other action the test passes.

## On next f00ce6f52 + solidjs/solid#4835 (the #4834 fix, still an open PR)

Built at c1949ba3a. Both repros (`repro/blank-rows.spec.tsx`, `repro/blank-heading.spec.tsx`) pass. Grades in `graded-4835/`.

| app | hidden | overlap | fuzz holes | defects | before |
| --- | --- | --- | --- | --- | --- |
| rx-1 | 76 | 37 | 1 | 3 | 4 |
| rx-2 | 76 | 37 | 0 | 2 | 2 |
| rx-3 | 76 | 37 | 2 | 4 | 5 |
| rx-4 | 77 | 37 | 0 | 1 | 2 |
| rx-5 | 77 | 37 | 1 | 2 | 2 |
| rx-6 | 77 | 36 | 0 | 2 | 3 |
| rx-7 | 75 | 38 | 0 | 2 | 2 |
| rx-8 | 77 | 38 | 0 | 0 | 0 |
| rx-9 | 77 | 38 | 0 | 0 | 0 |
| reference | 77 | 38 | 0 | 0 | 0 |

"Before" is the last grade of each app: rx-1, rx-3 and rx-8 on f00ce6f52, the others on the Solid of their first grade.
The blank heading (seed 15 in rx-1 and rx-3) is gone. rx-4 s13 and rx-6 s16 (count outside the list's region) no
longer fire; rx-5 s17 still does. Everything left is agent or guide-caused, except two untraced holes: rx-1 s11
(the #3 detail shows #4's guessed title "Bravo"; the trail replayed alone ends correctly, so it may depend on timing)
and rx-3 s11/s19 (page hangs). Apps on the current guide (rx-7..9): 2, 0, 0.
