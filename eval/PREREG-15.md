# Round 15: six arms, two tasks, two tiers, for publication

Pre-registration, committed before any round 15 agent runs. Status: DRAFT (needs Ryan's review; nothing here is frozen yet).

## Why

Rounds 10 to 14 were exploratory. Each one changed the guide, Solid, or the grader between runs, used one task the guide had been tuned on (desk9), and ran on unreleased builds. Round 15 is the round meant to be published.

- **Fixed in advance:** the arms, tasks, builds, grader and tests below.
- **Builds:** released versions only.
- **Tasks:** one task the guide has never seen (board) next to the familiar one (desk9).
- **Reporting:** every result is published, including nulls and reversals.

Ryan's direction (2026-11-12): .rx has to at least equal React at frontier models to matter. The defect gap at small models is the claim it may be able to win. Cost is reported, but it isn't a hypothesis.

## Arms

All six arms have a hand-written reference that grades 0 on both tasks (see "References").

| arm | stack | what it stands for |
|---|---|---|
| `rx` | ReactiveScript over Solid 2.0, with `--inline-docs` (language.md, async.md, reference.md) | PRIMITIVES |
| `react` | React 19, TanStack Query offered | the default |
| `contract` | Exact (Contract + TypeScript data module), its own `start-here.md` | Exact, a likely competitor |
| `xstate` | React 19 + xstate 5.32 + @xstate/react 6.1, Stately v5 docs | PROCESS (state machines) |
| `foldkit` | Foldkit 0.170 on Effect 4, with `--inline-docs` | PROCESS (Effect/TEA) |
| `vanilla` | plain TypeScript and the DOM | PLATFORM (stand-in for Remix 3's no-abstractions bet) |

## Tasks

- **`desk9`** (`brief-plain.md`), unchanged since round 12. Graded by `hidden.mjs` (77), `hidden-overlap.mjs` (38) and `fuzz.mjs --r15`, 20 seeds. The guide was tuned against this task over rounds 9 to 14, so it is not held out. It is reported as the familiar task.
- **`board`** (`brief-plain.md`), a sprint board: cards across three columns, moves and reordering, a work-in-progress limit, each card's checklist, renames, adds, an archive page, and overlapping writes. It is new and held out: no .rx, guide or Solid change was made while looking at agent output for it. Graded by `hidden.mjs` (45), `hidden-overlap.mjs` (26) and `fuzz-board.mjs`, 20 seeds. Agents see `visible.mjs` (26).

## Builds (released only; exact versions filled in at freeze)

- **Solid:** the first `@solidjs/signals` / `solid-js` 2.0 release candidate that contains #4856. It must also either contain the fix for #4859 or be recorded here as not containing it.
- **rxc:** a published `@reactivescript/compiler` built from the commit that freezes this file (bump release first).
- **Exact:** a tagged Exact release (not a checkout). If Exact has none, then a pinned commit, named as a deviation.
- **Foldkit:** the published 0.170.x, with Effect 4 as Foldkit pins it.
- **React / XState:** as installed in round 12 (react 19, xstate 5.32.6, @xstate/react 6.1.0, @tanstack/react-query 5).

**Gate:** before the round starts, all 12 references (6 arms × 2 tasks) are regraded on the frozen builds and must grade 0. If one gains a hole, it is traced. A framework bug is filed upstream and the round waits; a reference bug is fixed in the reference.

## Grading

- **What counts:** only defects (Ryan, 2026-11-10). Holds that are by design (H-11) and failures the brief caused are excluded from every total. Each exclusion is listed with its trace.
- **Defects per app:** failed hidden tests, plus failed overlap tests, plus fuzz seeds with a hole, with a task's tests and fuzz counted together (as `harness/grade.sh`).
- **Fuzz rules,** the same for every arm:
  - **Same field written twice:** at rest, the field must show the server's last answer (Ryan, 2026-11-14, final). This is why `--r15` drops desk9's A2 allowance.
  - **Late writes:** a write that answers after its page was left need not show on the next visit (Ryan, 2026-11-14: out of scope). On desk9 this is A4, extended to the detail, labels, comments and two-views checks. On board it is B1: settled checks are skipped, as is the duplicate-card check, in a visit where a late write landed.
  - **B2 (board):** after two moves overlap in the air, a column's settled order isn't checked, only which cards it holds.
  - **Distinct texts:** fuzz-added cards and items get unique texts, because two adds of one text are one flight to the harness.
- **Board fuzz oracles:** these are listed at the top of `harness/fuzz-board.mjs`.
  - Every frame: duplicate card, heading count, card count against progress, every card's count against the server (give or take that card's own writes still in the air), the work-in-progress limit, the detail's column and title.
  - Settled: columns, checklist and archive equal the server's.

## Runs

- **Count:** for each arm and task, 6 frontier (Opus) and 6 small (Haiku) apps. That is 6 × 2 × 12 = 144 runs, in one interleaved batch.
- **Limits:** at most 15 `./check`/`./test` calls per run.
- **Harness:** subagents with the round 12 prompt per arm (`harness/prompt-arms.json`). Time is recorded per run (`.agent.json` `ms`).

## Hypotheses

All tests use seed 15. Each app's defects are summed across its task's three graders. Comparisons pool the two tasks, and permutations shuffle labels within a task, so 12 apps per arm per tier.

- **H15a (primary family, small tier):** .rx apps have fewer defects than each other arm.
  - Five one-sided permutation tests on mean defects, 100,000 relabellings, Holm-corrected together: rx < react, rx < contract, rx < xstate, rx < foldkit, rx < vanilla.
- **H15b (frontier tier):** .rx apps have no more defects than React apps.
  - Difference in means (rx − react), with a 90% bootstrap interval stratified by task, 10,000 resamples. Holds if the upper end is under 1 defect.
  - The same interval is reported for rx against each other arm, without a claim.
- **H15c (held-out check):** H15a's rx < react, on board alone, small tier. Reported beside the pooled test. This shows whether the effect survives on a task the guide was never tuned for.
- **Descriptive, every arm × tier × task:** mean defects with a 90% interval; defects by kind; cost per run and per correct app; time per run; turns; lines.
  - Cost and time are not hypotheses (Ryan: .rx won't win on cost).
- **Not tested:** PROCESS against PLATFORM comparisons are reported descriptively only.

The direction is the claim. A null or reversed result is reported as plainly, and all 144 apps, their grades and their traces are published.

## Known caveats (from writing the references)

- **Board, .rx:** the guide's desk9 shape gives fuzz holes on board: each write refreshes its keyed list, and guesses on one list from separate actions end together (H-11, ruled). The .rx reference instead keeps one record of every write per page (passes, 547 lines). Agents who follow the guide's desk9 shape will lose points here. That counts as an agent/guide defect, not a test bug. The guide is not changed for round 15.
- **Board, Exact:** `parallel` hides an earlier send's failure once a later send concludes, and the brief clears a move error only when the next move starts. The Exact reference keeps errors in its data module.
- **Board brief, unspecified but untested:**
  - a move into a column still loading;
  - whether "archive error" covers both the archive page's load failure and a declined archive;
  - adding before To do has loaded;
  - when the archive error clears;
  - re-selecting a card whose checklist failed to load.
- **Desk9 (from rounds 9 to 14):**
  - the fuzz server never returns a stale answer to a load that started before a write;
  - the 60 ms settle can hide late TanStack updates.
- **Solid:** #4859 (a new key under `Loading on(key)` shows the old answer while a guess is out) was found by the .rx board reference. If the frozen Solid lacks the fix, .rx agents can hit it, and each such hole counts as a defect, attributed to Solid in the report.

## References (all grade 0)

| task | rx | react | contract | xstate | foldkit | vanilla |
|---|---|---|---|---|---|---|
| desk9 (`--r15`) | 0 | 0 | 0 | 0 | 0 | 0 |
| board (+40 extra seeds) | 0 (547 lines) | 0 (681) | 0 (510) | 0 (890) | 0 (1293) | 0 (752) |

`reference/desk9/*` and `reference/board/*`, graded on Solid `next` 57a7f422f, regraded at the gate.

## Review and cost

- **Review:** before freezing, an outside reviewer (not Claude) reads this file and the board brief and tests. Ryan picks who.
- **Cost:** about $200 to $250. Frontier runs cost about $1.30 to $3.30 each, depending on arm; small runs about $0.15 to $0.30 each.
