# XState side check (2026-11-11, not pre-registered)

This side check runs nine desks in a new `xstate` arm, compared against round 11's arms. Everything else matches round 11 (`eval/results/desk-2026-11-11`):

- **Brief:** desk9, `--brief plain`.
- **Grading:** the same grader (`harness/grade.sh`) and tests.
- **Toolchain:** Solid next 6751472f, used only by the .rx and Solid arms.
- **Tiers:** 1–3 are the frontier tier on Opus, 4–9 the small tier on Haiku.

Ryan chose to run this side check first and then add XState as a pre-registered arm in round 12.

## The arm

- **Stack:** React 19, TypeScript, xstate 5.32.6 and @xstate/react 6.1.0. TanStack Query is not available, so the machines own the server state.
- **Instruction:** model state and requests as XState machines and actors.
- **Docs:** Stately's own, unedited:
  - in the prompt: the v5 cheatsheet and @xstate/react's README;
  - readable in `docs/xstate`: every v5 page (statelyai/docs at 7ee0c60).
- **Checker:** the same as React's, tsc strict plus react-hooks.

## Defects per app

| arm | frontier mean | small mean | small per desk | small median |
|---|---|---|---|---|
| **XState** | **2.0** (2, 2, 2) | **7.0** | 3, 5, 6, 16, 1, 11 | 5.5 |
| .rx (round 11) | 2.0 | 3.8 | 3, 3, 4, 2, 9, 2 | 3 |
| React (round 11) | 2.0 | 9.7 | 13, 2, 17, 14, 1, 11 | 12 |
| Foldkit (round 11) | 2.7 | 13.2 | 17, 13, 13, 12, 10, 14 | 13 |

Small tier, one-sided permutation tests (seed 11), descriptive only:

| comparison | p |
|---|---|
| XState < Foldkit | 0.021 |
| XState < React | 0.25 |
| .rx < XState | 0.13 |

Every frontier XState desk fails the same two overlap tests ("comments / labels that load while an add is out keep it"), as most desks in other arms do. The most common small-tier failures are settings saves out of order (a later save failing while an earlier one is out) and the same two overlap tests. Two small desks (7, 9) account for most of the fuzz holes.

## Cost and size

| | frontier $/run | small $/run | frontier calls | small calls | lines |
|---|---|---|---|---|---|
| XState | 2.30 | 0.142 | 24.0 | 25.8 | about 1,300 |
| .rx | 2.05 | 0.092 | 21.3 | 15.5 | about 390 |
| React | 1.38 | 0.069 | 12.7 | 11.8 | about 760 |
| Foldkit | 3.63 | 0.175 | 37.3 | 38.5 | about 2,300 |

Cost is billed tokens at round 10's rates (`cost.json`).

## Reading

- **Against Foldkit:** state machines do better than the Effect/TEA process arm in the small tier, at about half the defects, and cost less.
- **Against React:** XState sits between plain React and .rx, but six runs don't separate it from either.
- **Frontier:** XState is level with React and .rx at 2.0, at about 1.7× React's cost.
- **Caveat:** this check is not pre-registered and compares with another day's runs of the other arms. Round 12 runs XState as a pre-registered arm.

## Deviations

- Desks 5, 6 and 8 drove their machines in Node with scratch scripts, which they then deleted. That is allowed (scratch inside the run dir).
- Desk 2 reports that `reenter: true` on one region of a parallel state restarted its siblings, and worked around it. This was not checked against XState.
