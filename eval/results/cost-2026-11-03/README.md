# Cutting what .rx costs agents (2026-11-03, not preregistered, not counted)

**Question.** Round 10's frontier .rx desks cost $2.90 and 30.3 calls on average; React's cost $1.35 and 14 calls.
Most of the gap was the agent reading the spec. Does one page of rules, inlined in the prompt, close it?

**Change.** `guide/reference.md` puts the rules on one page, one line each, with their ids. It is inlined after
`language.md` and `async.md` (`harness/scaffold.mjs --inline-docs`). The prompt now tells the agent to look up a rule by
its id, not to read chapters (`harness/prompt-arms.json`, rx-inline).

**Run.** 3 frontier .rx desks on round 10's brief and harness (`desk9` task, plain brief), graded as round 10 was:
hidden, hidden-overlap, and 20 `--r9` fuzz seeds.

| | calls | $ | defects on Solid next 81803325 | defects on Solid next 6f336022 |
| --- | --- | --- | --- | --- |
| round 10 frontier .rx (1–3) | 30, 34, 27 (30.3) | 2.92, 3.45, 2.32 (2.90) | 9, 6, 7 (7.3) | 4, 6, 4 (4.7) |
| this run (1–3) | 20, 33, 38 (30.3) | 1.80, 2.66, 3.18 (2.55) | 8, 6, 6 (6.7) | **0**, 3, 3 (2.0) |
| round 10 frontier React | 19, 11, 12 (14) | 1.35 | 3.0 | n/a |

Defects are raw counts: failed hidden tests, failed overlap tests and fuzz seeds with a hole. The H-11 legal hold
("two issues assigned at once") is not taken out here. Taking it out leaves 0, 2 and 2 for this run. Desk 1 on
6f336022 passes 77/77 hidden and 38/38 overlap and has no fuzz hole: it is the first fully correct app on this brief
in any arm.

**What it shows.**
- Spec reading fell from whole chapters to 2–6 targeted greps. Cost fell 12%, but calls did not change.
- The calls that remain went into runtime traps, not into looking up the language:
  - All three desks reported the open count from outside the list's `loading on(filter)` region. CN-3e caught it and
    suggested `latest x`, but that still held the switch. It is a Solid bug, solidjs/solid#4661: a memo that read
    `latest(x)` in its last run holds a `Loading on` switch even when its new run doesn't read `x`. Each desk ended up
    moving the count into a child component inside the region. 10 of the 12 .rx desks across rounds 10 and 11 wrote
    that same component.
  - Desk 3 spent about 12 calls on "a retry doesn't clear the error". That was solidjs/solid#4627, fixed on next.
- Solid next 6f336022 fixes #4627, #4629, #4631 and #4638. On it, round 10's frontier .rx desks go from 7.3 to 4.7
  defects, and small .rx desks (4–9) go from 7.2 to 6.3.
- Still open, in 3 desks: fuzz seed 5 ("closed row shown"), not yet reduced.

n = 3, so this is a direction, not a result.
