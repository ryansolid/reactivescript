# Round 12, regraded with shared data: the server changes on its own

Pre-registration, committed before the fuzz family below runs on any round 12 agent app. Status: COMMITTED (Ryan, 2026-11-12: "we should have tests that show why"; his to veto). The reference
apps were used to calibrate the oracle: one harness bug was fixed (a write answering after the page was left told the new page nothing, A4), then all four references (rx, React, Solid, Foldkit) had 0/20 counted holes; Solid had one "two views (stale)", reported apart.

## Why

Ryan, 2026-11-12: the apps in every arm show writes straight away and roll them back, because the brief asks for it.
Where they differ is what the brief leaves open:
- After a write, all 12 .rx apps re-ask the server. None of the other 48 refetch.
- When a new answer lands while a write is out, .rx holds (H-11). The others lay their pending changes over the new
  answer.

Real issue trackers are shared, so another user can change the data at any time. This family asks whether the client
stays consistent while that happens. ".rx has its shape for a reason and we should have tests that show why."

## What runs

`harness/fuzz.mjs --others` (it implies `--r9`), 20 seeds per app, the same seeds as round 12 (1-20). On each step,
with probability 0.15 and before the usual choice of move or answer, another user changes the server. They rename any
issue to a unique title (`Echo<n>`), assign it to `zoe` or `yan`, close an open issue (never the last one), post a
comment as `zoe`, or add a label `x<n>`. No request from the page is involved, so the page is not told.

The apps are the 60 round 12 desks as submitted, plus the references (`reference/desk/*`), on `solid-next` at the
newest `next` with all filed fixes merged (a8b8b678). The round 12 grading stands. This family is reported beside it,
not added to it.

## Oracles

A client need not learn of a change it never asked about, so a stale screen is not a defect. Every frame, a field may
show any value the server has held for it, and a row another user closed may stay in the open list. Round 9's oracles
apply otherwise, except that "two views" (a row title against the detail heading) moves to rest and is reported apart.
What counts:

1. **Reverted change** (every frame). A field showed one server value, then later shows an older one. A field is a
   row's title or assignee, or the detail heading's title. It doesn't count when the older value is the user's own
   write in flight, or a declined write lingering under A1. Whatever was shown on the issues page is forgotten when the
   page is left.
2. **At rest, no older than told.** Nothing is in flight.
   - Every shown row value is no older than the newest answer the app received that carried it: a list answer that
     held the row, or the response to the user's own write. A2 still allows the newest of the user's own accepted
     writes.
   - The heading is no older than the newest `fetchIssue` answer or rename response.
   - Labels equal the newest `fetchLabels`/`addLabel`/`removeLabel` answer, or the server.
   - Comments equal the newest `fetchComments` answer plus the user's own accepted posts since, or the server.
   - The rows are the newest answer to the current filter's list, less the user's own closes accepted after it. A row
     the server has since closed may be missing; one it still has open may not be.
   - The count follows the rows (A3).
3. **Reported apart, not counted:** "at rest: two views (stale)": the row's title and the heading disagree at rest.
   Whether a client must keep two views of one record in step after another user's change is a product choice the
   brief doesn't make.

Holes are counted per seed (first hole per seed), as in round 12. A hole counts unless it is traced to a legal hold or
a bug in the harness, and each exclusion is listed with its trace. Known Solid bugs are traced and reported, but they
still count.

## Hypotheses

- **HO-a:** small .rx apps have fewer seeds with a hole than small React apps (one-sided permutation test on per-app
  counts, seed 12, 100000 shuffles).
- **HO-b:** the same for frontier .rx against frontier React.
- **HO-c**, descriptive: the classes of hole per arm, especially reverted changes from rollback snapshots and from
  write responses patched over newer answers.

Holm over HO-a and HO-b. If .rx is worse, that is the result.

## What would make this unfair, and the guard

- **The oracle is built around .rx's choices.** Staleness is allowed everywhere, so an app that never refetches can
  pass every seed. Only going backwards, or ending older than the app was told, counts.
- **.rx holds can hide changes.** A held list that shows an older answer for a long time is a hold, not a revert, as
  long as it never shows a newer value first.
- **The brief never said the data is shared.** That's why this is a regrade reported beside round 12 and not a new
  score. A new round would add one line to the brief ("other people use the tracker at the same time; the server can
  change at any moment"), which states the product without naming a race.

