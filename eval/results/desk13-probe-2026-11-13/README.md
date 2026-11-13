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
