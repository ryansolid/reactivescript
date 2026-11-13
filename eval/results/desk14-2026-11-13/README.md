# Round 14 (exploratory): frontier .rx vs React vs Exact, 2026-11-13

Not preregistered. 18 Opus apps on the desk9 brief (`--brief plain --inline-docs`), 6 per arm, run in three waves of
six (two per arm per wave). Graded with the usual suite: hidden 77, overlap 38, 20 fuzz seeds (`--r9`).

- Solid next dba2aadbb (includes #4831 and #4835, the #4834 fix). rxc built from main + this branch (54853d0).
- React arm: React 19 + TypeScript, @tanstack/react-query installed and offered.
- Exact arm: Exact `contract` (app.contract + app.ts) from the checkout described in `desk13-exact-2026-11-13`.
- The .rx guide is the one-lifetime-rule guide from the desk13 probe.
- The hand-written .rx reference grades 0 (77/77, 38/38, 0/20).

## Results

| arm | defects per app | mean | apps at 0 | mean minutes | mean tokens |
| --- | --- | --- | --- | --- | --- |
| .rx | 1, 0, 0, 0, 0, 1 | **0.33** | 4/6 | 7.1 | 112k |
| React | 2, 3, 1, 3, 2, 2 | 2.17 | 0/6 | 6.7 | 89k |
| Exact | 2, 2, 2, 1, 0, 3 | 1.67 | 1/6 | 9.9 | 150k |

Minutes are each agent's wall time (from its task notification, in `<desk>/.agent.json`). Three waves of six ran on
one machine, so a wave's builds and browsers shared the CPU.

## What the defects are

- **.rx (2): both are page hangs, and both are a Solid bug.** rx-1 seed 2 and rx-6 seed 19 time out (120 s): selecting
  another issue while a guess is out (a rename, or an assign) never returns. Reduced to
  `repro/guess-select-loop.spec.tsx` (plain Solid, about 35 lines; filed solidjs/solid#4840): a detail rendered per selection through `<For>`
  under a component that passes its children by getter, a heading memo reading a `createOptimistic` guess, and a
  selection change while that guess's action is out. Solid's dev build reports "Potential Infinite Loop Detected. Kept
  alive by scheduled work; last staged node: <For>"; the production build spins. rx-6 s19 is the rename case exactly;
  rx-1 s2 has assign guesses out instead (not reduced separately). The same loop is behind desk13 rx-3 s11/s19.
- **React (13): mostly one class.** 6/6 lose a guessed comment or label when the list it sits in reloads while the
  post or add is out (hidden "labels that load while an add is out keep the add" 6/6, "comments ... keep the post"
  5/6). react-2 and react-4 also show a posted comment twice at rest (fuzz s16).
- **Exact (10): mostly the settings save.** 4/6 get overlapping saves wrong ("a later save failing while an earlier
  one is out"; contract-3 also "an earlier save failing after a later one succeeded"), the default mutation mode
  replacing an earlier write with a later one, as in the desk13 Exact probe. 2/6 let a row error and a detail error
  clear each other; contract-1 doesn't reload settings when the page reopens (2 tests); contract-6 asks the server
  for an invalid name.

## Also traced: desk13 rx-1 seed 11 (Solid, filed solidjs/solid#4841)

The detail of issue #3 showed issue #4's data. Instrumenting the app showed the detail memo computing #3's answer
while the screen kept #4's. `repro/wrong-detail-after-error.spec.tsx` (plain Solid): a heading memo reading a rename
guess; select #3 while closes and renames are out; #3's detail fails, a rename's refresh asks again, and the answer
lands while a close is still out. The screen shows "#3 Alpha (detail of #4)" instead of "#3 Delta (detail of #3)".

## Deviations

`deviations.txt`. Most agents in every arm added their own tests to `tests/visible.mjs` and restored the file;
contract-6 kept its extra tests in `.exact/extra.mjs`. rx-6 removed an unused import after its last test run (it
type-checks; grading builds it fine).
