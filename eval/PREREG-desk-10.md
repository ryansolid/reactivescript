# Round 10: cost per correct app, by model tier, across four approaches

Pre-registration, committed before any round 10 agent runs. Status: FROZEN (Ryan approved 2026-11-02: "lets go").

## Why

Rounds 2-9 found that frontier agents write correct async code in every arm when they are diligent: on the round 9
issue desk, frontier React, plain TypeScript and .rx desks all scored 36-38 of 38 overlap tests, and frontier React
and plain desks built their own pending-write logs by hand. The differences showed up in the small tier: small React
and plain desks scored 28-32 of 38, small .rx desks 34-36 (round 9, not pre-registered). Removing the turns .rx agents
spend looking up its semantics brings their cost level with React on rounds 5 and 7 (`fam.py`, 2026-11-01).

The claim under test (Ryan, 2026-11-01): .rx raises the floor. Correctness comes from the language rather than from
the agent's diligence, so a small model writing .rx gets the async correctness that React or plain code only gets from
a diligent frontier model, and the cost of a correct app falls.

The four arms are the four positions on where that responsibility lives (Ryan, 2026-11-01):

- **primitives**: .rx (the derived graph; Solid 2 underneath);
- **process**: Foldkit (The Elm Architecture on Effect: coordination made explicit);
- **platform**: plain TypeScript and the DOM, no framework (the `vanilla` arm);
- **today's center**: React 19 (TanStack Query installed and allowed).

## Task and arms

- Task: the round 9 issue desk, `tasks/desk9`, with the plain brief (`brief-plain.md`: production code; no race is
  named). Visible tests as given to the agent; graded by `hidden.mjs` (77 tests) and `hidden-overlap.mjs` (38 tests).
- Arms and documentation, all scaffolded by `harness/scaffold.mjs desk9 <arm> <dir> --brief plain`:
  - `rx` with `--inline-docs`: `guide/language.md` and `guide/async.md` at the end of the prompt, the spec in `docs/`.
    `rxc` built from the commit that holds this file, so its checks (R-8, CN-3d, CN-3e) apply.
  - `foldkit` with `--inline-docs`: Foldkit's `FOLDKIT.md` at the end of the prompt, the repository in `docs/foldkit`.
  - `react`: no docs (React is in the model's training).
  - `vanilla`: no docs.
- Solid: `solid-next` at `next` 81803325 (2026-11-02; includes the fixes for the Solid issues rounds 8-9 found, and
  #4613), the same build for every .rx run and grade.

## Runs

- Two tiers of the subagent models available in the session: **frontier** and **small**. 3 frontier and 6 small runs
  per arm: 36 runs.
- All 36 launched in one batch, interleaved by arm, so prompt-cache state is the same for every arm (round 5b lesson).
- Each run: the scaffolded prompt verbatim, at most 15 `./check` and `./test` calls, no other tools than file, search
  and shell inside its directory. A run that stops without a report is graded as it stands.
- `./test` builds the app in development mode and prints, after the results, the console warnings and errors the
  page logged (each once), so every arm's agent sees its framework's dev diagnostics (Solid's SILENT_HOLD and the
  like; React's warnings). Grading builds in production mode, as before. (Ryan, 2026-11-02.)

## Grading (per run, by the round 9 `grade.sh`)

- **Hidden**: tests failed of 77. **Overlap**: tests failed of 38.
- **Fuzz**: `harness/fuzz.mjs <dir> --seeds 20 --r9`, seeds 1-20, 30 steps; the number of seeds that found a hole. Holds
  that settle are not holes (Ryan, 2026-10-30); the allowances are those of `PREREG-fuzz-8.md` plus the round 9 ones
  in `fuzz.mjs`. A session that times out is re-run once alone before it counts (load flake seen in round 9 grading).
- **Legal holds**: an overlap or hidden failure is not a defect when the frame it expects shows once the action in
  flight lands, a loading or pending affordance shows meanwhile, and the held read is a source that action guessed on
  or re-asks (Ryan 2026-10-30: holds that settle and are not silent are not bugs; 2026-11-02: one question per node).
  Each such failure is checked by replay and listed; the same rule applies to every arm.
- **Defects** = hidden failed + overlap failed + fuzz seeds with a hole, less legal holds.
- **Correct** = 0 defects.
- **Cost**: billed units from the transcript (`harness/cost.mjs`: input 1, cache write 1.25, cache read 0.1, output 5)
  times the tier's list price per input token on the run date, in dollars; the prices are recorded in the results.
- Holes traced to a bug in an arm's framework (Solid, Foldkit, React) count against that arm; they are listed
  separately, and upstream issues are filed.

## Hypotheses and tests

- **H10a** (primary): in the small tier, .rx runs have fewer defects than React runs. One-sided permutation test on the
  mean defects, 100,000 relabellings, seed 10.
- **H10b**: in the small tier, .rx runs have fewer defects than plain runs, and fewer than Foldkit runs. Same test,
  Holm-corrected together with H10a.
- **H10c**: small-tier .rx runs have no more defects than frontier-tier React runs. Reported as the difference in
  means with a 90% bootstrap interval (10,000 resamples, seed 10); the claim holds if the interval's upper end is
  under 1 defect.
- **Cost per correct app** (descriptive): for each arm and tier, total dollars over the number of correct runs.
- Reported alongside: the frontier tier (expected parity; no hypothesis), defects by kind (hidden, overlap, fuzz),
  turns and lookup share (`fam.py`), lines of code.

The direction is the claim being tested. A null or reversed result is reported as plainly.

## Next (separate pre-registration)

Round 11, maintenance: each round 10 app gets one change that adds a new kind of write (for example editing a
comment), made by a fresh agent of the same tier, then graded the same way. It tests whether hand-built coordination
holds up when someone else extends it.
