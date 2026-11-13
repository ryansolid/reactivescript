# A hand-written .rx desk9 reference, graded (2026-11-13)

Not a preregistered round, and no agent ran. The question: can .rx, on current Solid, reach **zero defects** on
desk9 when the code is written by hand, and if not, is the floor the language, Solid, or the guide? Prompted by
Exact's `bench/reactivescript` (expo/exact), which grades a hand-written Contract reference with this harness at 0
after three language changes (their LLP 1161).

**Setup:** Solid `next` at cd4de287 (holds the fixes for #4821, #4824, #4825; #4828 is still open), built from source
and linked over `eval/node_modules`. `rxc` from this branch. Graded with `harness/grade.sh` (hidden 77, overlap 38,
20 fuzz seeds with `--r9`).

## Results

| app | hidden | overlap | fuzz seeds with a hole | defects |
| --- | ---: | ---: | ---: | ---: |
| `reference/chain4/rx` (round 7's hand-written app, desk9's features) | 77/77 | 38/38 | 3 of 20 | 3 |
| `reference/desk9/rx` (this branch) | 77/77 | 38/38 | 0 of 20 | **0** |

## What the three holes in the chain4 app were

- **Seed 8, row title (the app).** A rename made while its row was not in the list on screen guessed nothing
  (`findIndex` gave -1). The row then arrived from another write's re-ask with the old title, and after the rename was
  accepted it showed that title until the list was asked again.
- **Seed 12, two views (the app).** A rename made before the issues tab was left and opened again: the new page's list
  had been asked before the rename landed, and the rename's `refresh` re-asked the old page's list, which was gone.
  The detail, asked after, showed the new title beside the stale row.
- **Seed 11, page error (a gap in R-8).** The `add-label` button sat inside an `errored` region whose markup read
  only `pending? shown`. When the labels failed, nothing in that region read the failure, so the button stayed live,
  and its handler's `shown.includes(…)` threw as an uncaught error. The checker accepts a handler read under an
  `errored` region (R-8), but the region catches only failures its content reads. **Ruled by Ryan (2026-11-13):
  tighten R-8.** An `errored` region, or a `disabled`, covers the failure half only when it reads the value, not only
  `pending?` of it. `rxc` now refuses seed 11's shape (`UNGUARDED_SNAPSHOT`); the five references with that
  `labels.rx` (chain1-4, labels) are fixed the same way as desk9's.

## What the reference does differently

- **Issue data lives as long as its writes** (`desk.rx`; Ryan: data belongs with its lifetime), as in Exact's reference ("every resource is the root's"): the list, the
  detail and the writes live in one module, so a write's re-ask reaches the list and detail on screen when it lands,
  whatever was left and reopened in between. Opening the issues tab bumps `visit`, which the list's question reads,
  so the page still starts loading again.
- **Writes are laid over every answer.** Each kind of write guesses a list of its own with a constant question
  (`renames`, `assigns`, `closing`), and `rows` and `heading` apply them to whatever the answers are. This is
  `guide/async.md`'s "three layers" used for every write, and it is Exact's `overlay` written as equations: a row
  that arrives from a reload while a write on it is out shows the write, and the row and the heading read one rename,
  so they cannot disagree. Guessing a constant-question source also never holds a filter switch or a selection.
- **An accepted write ends with the list's re-ask; a declined one does not**, so a revert and its message show in
  one frame, while an accepted guess stays until the server's list lands (D-34).
- **A control reads what it guards**: `add-label` renders from `shown` (`for have in [shown]`), so a failure puts
  it on its region's fallback.

442 non-blank, non-comment lines (chain4's: 411; Exact's reference: 476).

## A runtime bug found on the way

`refresh x` of a keyed equation (`rows key id = await …`) re-asked nothing in the compiled runtime and the oracle:
`keyed` returned the projection's accessor without the memo under it. An action ending in such a refresh ended at
once and took its guesses with it. Fixed in `ref/compile/rt.ts`, `ref/compile/rt-web.ts` and `ref/oracle/lower.ts`;
`scenarios/S-keyed-refresh.md` pins it on all three runners. Suites on Solid cd4de287: oracle and compiled 123 pass,
4 fail, the same 4 as without the fix; the interpreter passes.
