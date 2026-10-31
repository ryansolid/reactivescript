# 05 — Holds

**Status: OPEN (2026-10-21).** What the screen does with pending readers.
This document restates Solid 2.0's fundamentals (`RULES-FUNDAMENTALS.md`,
F-1…F-12, `solidjs/solid@next`) over the calculus of 02–04. Each H-rule
cites the F-rule it restates and must agree with it; an open question there
(Q-n) is open here. This document does not rule on Solid's open questions.

---

## The model: two versions of state

The synchronous core (02 §4) has one state `σ`. Holds add a second:

- **Committed `σ`.** What readers show, what apply blocks and snapshots see.
  Always a whole frame (F-1).
- **In-flight `σ′`.** The state an open hold is moving toward. Writes of a
  held instant live here; async answers land here; equations settle against
  it. Only probes read it (R-9).

Membership is per **change**: every write and every flight belongs to the
instant that made it, and a reader that consumes a held change joins it.
Changes merge when one reader consumes two; a merged group commits as one
frame when no reader is pending on it and no flight it opened is still
awaited by a display. (Revised 2026-10-21 after porting Solid S-2 and S-4:
the first draft had one in-flight version that every later instant joined,
which showed `A 0` where Solid shows `A 1` — S-hold-3.)

---

## H — Rules

- **H-1 (The screen is whole).** [F-1] Every frame is `σ` after a commit: a
  value and everything on screen derived from it changed in the same frame.
  The one exception is declared lag: `deferred x = …` declares that `x`'s
  previous answer is acceptable while the next loads. Its first load holds
  like any; after that its re-asks hold nothing — readers keep the answer
  they show, `pending? x` is `true`, and each landing is its own change
  (S-solid-41). It may lag the screen, never lead it: a re-ask that read a
  held input lands into that hold and shows with its commit (F-7). After
  its first landing a deferred node's readers — including readers created
  later — are never pending: no boundary, armed or re-armed by `on`, shows
  a fallback for them; `pending? x` is the only visible sign. Lag is a
  property of the value: everything derived from a deferred node lags with
  it, and a `deferred` over a pending plain equation parks and lags
  (S-ai-grid, both runners). To get a fresh load *and* a lagging re-ask
  from one fetch, put the `deferred` in a region recreated by the fresh
  input (`for p in [page] { deferred data = await fetchRows(p, sortBy) … }`)
  under `loading on(page)`.

- **H-2 (A change is held by its pending readers).** [F-2] An instant is a
  change. Its writes and the flights it opens belong to it. After settle, the
  change is **held** iff some reader that consumed it is pending (H-4) or a
  flight it opened is still awaited by a display (a served reader, H-3). A
  held change commits nothing: `σ` is unchanged and the screen keeps its
  frame. When nothing holds it, it commits as one frame — its writes and
  landed answers become `σ`, the structure it mounted attaches, its readers
  show — and then the observe phase runs (apply blocks see the committed
  instant). Instant 0 (mount) can be held; the screen shows nothing until it
  commits. `action { … }` keeps one change open across its awaited work
  (AC-1): its body is a holder like a pending reader, and a continuation
  after `await` is the same change (S-solid-8, S-solid-9). A write to a slot
  an open change holds is a second proposal: the writer's instant joins that
  change and reveals with it (Solid D-8; S-solid-34 — the two actions on
  `id` are one hold). A held lane (H-7) keeps its change staged as well: a
  landing the lane is waiting on stays uncommitted (S-solid-33).

- **H-3 (Served, or joined).** [F-2, Solid D-1, D-3, D-4, D-23] A reader
  that **directly** reads a flight still pending — of its own change or of an
  open one — is *served* `σ`'s value for it, and so is a reader of a source
  written by another open change. A served pass publishes its text at once
  (served values are committed; nothing tears): `[pending? x, x]` shows
  `[true, x0]` in the instant that re-asked `x` (S-solid-27). What differs
  is who holds: serving a flight of the reader's *own* change holds that
  change; serving a foreign one holds nothing, but the foreign change — and
  every change in the flight's question — stays open while a display is
  waiting on it. A source written by the reader's own change is read, not
  served: that reader shows at the change's commit (S-solid-4's `1:0`).
  Lane values are never served: pending in a lane is the lane's (H-7). An **equation** never serves: it computes on
  `σ′`, and a reader that consumes a value derived from `c`'s held writes, or
  a landed answer of `c`, **joins** `c` — its reveal belongs to `c`'s commit
  and `d` merges into `c`'s group. A reader that consumed `d`'s own fresh
  writes shows at `d`'s commit. A new question on a source already in flight
  supersedes the flight (R-4). So two unrelated changes do not wait for each
  other (S-solid-4: `1:0` beside a stale `detailsA`), while a shared
  derivation makes them one (`sum` variant), and nothing derived from a held
  write ever shows ahead (S-solid-2: `Panel 1` beside `Count 0` is
  impossible).

- **H-3a (Membership is the tick's).** [Solid D-4, D-10] An instant `d`
  joins an open change `c` only through a pass that `d`'s own writes
  *triggered* and that consumed `c`'s held value — not through the
  maintenance re-run of a reader that was already held (S-solid-3: the
  unrelated `title` write is not swallowed). An equation whose held pass
  dropped an input keeps the inputs of its committed pass subscribed until
  it commits, so a write to a kept input still triggers it (S-solid-12:
  `count` reaches `selected` though the held pass reads only `fixed`, and
  the pass joins). The view attaches when the mount's own change commits,
  not when any change does (S-solid-11 instant 1).

- **H-4 (Who holds).** [F-3] A reader holds the group it joined iff it is
  pending after its pass, it is still the display (its region is live and it
  will still be a reader after the instant), no armed boundary catches it
  (H-5 — the catch takes precedence over being served), and it is not a lane
  reader (H-7). A reader the instant itself removes holds nothing; a reader
  behind a fallback holds nothing; an effect's compute half, an unread
  equation, a snapshot, or a probe holds nothing. A held reader's pass is
  re-run every instant: it is the display, and serving happens in the pass.

- **H-5 (Armed boundary catches).** [F-4] A `loading` region is **armed**
  until it has shown content, and again after `on`. While armed, pending
  readers under it — and *born-held* readers, whose value derives from a
  held change and has no committed value of its own (Solid D-12,
  S-solid-14) — belong to the boundary, not the hold: the hold does not
  wait for them, and the boundary shows its fallback in their place. The
  fallback belongs to the frame of whatever armed the boundary (the mount, or
  the `on` change) and appears with that frame — possibly never, if that
  frame is itself held until the content is ready.

- **H-6 (Disarmed boundary forwards).** [F-5] Once a `loading` region has
  shown content it is disarmed: pending readers under it are forwarded into
  the instant's hold exactly as if the boundary were not there; the content
  stays on screen. `on` re-arms it: a change to anything `on` reads makes
  its readers leave the hold and the boundary show its fallback with that
  change's frame — *if* a reader under it is pending in that change's
  settle; with nothing pending the re-arm is a no-op and the content
  updates in place (S-ai-grid). The value `on` yields is never compared;
  children are not recreated.

- **H-7 (Lanes).** [F-6] A reader whose equation carries `lane(x)` (R-10)
  renders from `σ′` for `x` and what is derived from it, beside the held
  screen, and never holds the instant — except at the mount: a lane reader
  with no committed value has no committed world to show, so it is the
  mount's and holds instant 0 like any reader (S-hold-4; found by the
  oracle). A lane has identity — the probed
  source — and a pending reader in lane `x` holds every reader of lane `x`
  (S-solid-24: the header keeps `0` while `details` is pending under a
  disarmed boundary), unless an armed boundary catches it (then the lane
  reveals at once). A boundary whose `on` reads a probe shows its fallback
  now, beside the held frame (D-17, S-solid-21). `latest x` while `x`'s
  flight is pending is `x`'s committed value (the value an update is moving
  toward does not exist yet). A lane reader mounted mid-hold shows the
  committed world and reveals with the lane (D-26, S-solid-30). A branch a
  lane condition opens is a mainline mount and attaches now; content under
  it that read a write the instant holds is born held — a fresh boundary
  there shows its fallback (D-27, S-solid-31). But pending work *inside* the lane —
  an `await` over `latest x`, a derivation of it that is pending — holds the
  lane: the lane's readers keep what they showed and reveal together when
  it lands. A lane hold and the instant's hold are independent on both sides.
  One reader is not held by a guess's lane: `latest x` of an optimistic
  guess (H-11) reads ahead of the guess's held lane, as every probe reads
  ahead of the instant's hold. It shows the guess — after a correction, the
  truth — beside the lane's held readers (S-solid-35 variant instant 2:
  `1 x1 / 5`; ruled 2026-10-26 by adopting Solid's position, DV-10). A lane
  of `latest` readers is not a guess's lane: there pending work inside it
  still holds its probes (S-solid-24).

- **H-8 (Nothing else reveals early).** [F-7] Content derived from a held
  instant — a derivation, a new mount's content, a boundary's content —
  appears with the commit. Only probes (H-7) and the fallbacks they arm show
  ahead of it.

- **H-9 (Verdicts).** [F-9] `pending? latest x` is the latest channel's
  own verdict — `x`'s own async is up — not the hold's (S-solid-27 instant
  4: `[false, x1]` beside the atomic pair's `[true, x0]`). `pending?` over
  a composite expression is the verdict of the reads inside it (S-solid-29).
  A verdict is final only at commit: lane readers
  are settled again after the hold decision, against the committed world, so
  a `pending?` that was `true` during settle reads `false` in the frame that
  commits the answer (found by `ref/`: S-hold-1 instant 3). `pending? x` is `true` iff `x`'s value in `σ` is
  not the final answer to a *new question*: an input changed and the answer
  is not committed, or a landed answer waits in a hold, or in-flight work
  declared `affects x`. A plain write an action holds is the first case:
  `pending? x` is `true` from the action's instant until its change
  commits (S-solid-8, S-solid-32). A re-ask (`refresh`, polling, a confirming refetch)
  is quiet: `pending? x` stays `false` and the fresh value reveals silently.
  A node with no committed value has no verdict (R-9). Pending is per node —
  per object key for structured values — never store-wide.

- **H-10 (A write is visible at its instant's settle).** [F-10] Between
  `x := v` in an imperative run and the end of that run, nothing sees `v`:
  not `σ`, not `σ′`, not a probe. The instant begins when the run ends
  (W-3); from then `v` is in `σ′` (probes see it) and in `σ` at commit.

- **H-11 (Optimistic).** [F-11, D-32…D-35] `optimistic x := e`, legal only
  inside an action body, declared or inferred (AC-3, AC-1b), and only on a source with a question (ST-5),
  writes a *guess* for `x`: from the instant's settle it is the graph's
  value (equations derive from it — S-solid-33: `related` re-asks from the
  guess) and the screen's, display-ahead — its readers are in a lane whose
  identity is `x` (H-7), so they show now unless pending work inside that
  lane holds it — and `latest x` shows the guess even then (H-7, DV-10).
  It is verdict-inert: `pending? x` is unaffected by the
  guess alone (S-solid-32, S-solid-35); `latest x` answers the guess
  (S-solid-33, S-solid-34 — the first draft said "unaffected"; Solid's
  D-26 and S-33 say otherwise). It lives as long as the hold it was made
  over: the hold's commit ends it and reveals the truth in the same frame;
  the hold ending without a commit reverts it. A path guess's hold is its own action's
  (per key), except that a keyed source with a question is a projection of
  its answer: while an action's re-ask of it is in flight, every reader of
  it waits for that action, a declined guess's revert included (ruled
  2026-10-31: by design, a re-ask can touch every row). When `x`'s own question
  answers: an answer equal to the guess confirms silently — the held answer
  is not pending (S-solid-34 instant 5); a different answer **corrects the
  graph now** (derivations re-derive from the truth, `latest x` is the
  truth, `pending? x` is `true`) while the screen keeps what it showed
  until the commit — and a guess the screen never showed is void
  (S-solid-33). An older question's late answer is superseded (R-4) and
  moves nothing (S-solid-34). When the body returns and nothing
  authoritative is in flight for `x`, the guess is corrected by the truth
  at hand, against the settled instant (S-solid-35; S-solid-26 variant).
  For a streamed source (ST-6) the truth at hand is its latest landed
  answer: a stream is never "in flight" in this sense, so a guess over it
  is confirmed or corrected by the next landing, or by the body's end
  against the current answer (S-ai-feed). Lowering and the full form:
  06-stores.

- **H-12 (Errors).** [F-12, D-41] An error value reaching a reader under
  `errored` sends that region to its fallback, which is then the display
  (H-4: readers behind it hold nothing and keep no change open). An error
  is an answer: a held rejection is staged like a value and reveals with
  its frame — the fallback moves with the frame of the change whose answer
  caused it, and so does a recovery (S-solid-42: `1 | 1 | 1` stays until
  `slow` lands, then `2 | Error | 2` as one frame; the error stays the
  display through a retry, and recovering to the last good value is still a
  new answer, so the effect's arm runs). An effect's apply receives an
  error value like any answer (E-12); only pending withholds the apply. Pending is never an error: `errored` does not
  catch it — and it is not an answer either: an `errored` region on its
  fallback stays there while the content under it is pending, and leaves
  only when a value replaces the error (Solid D-39; found by `ref/`:
  S-hold-5 instant 2) — unless a `loading` above it is armed (re-armed by
  its `on`): that boundary takes the pending content behind the error
  fallback and shows its own fallback over both (S-hold-6; found by
  S-ai2-search, Solid's behaviour). A typed boundary (`fallback(e: A | B)`) takes only
  its classes; another class passes it to the boundary above as if it were
  not there, and a boundary showing a failure re-decides when the failure
  changes class (04 R-f-4; S-fail-1). An error that escapes every boundary
  halts the instant and the reactive system: for a failure that is a
  compile error (R-f-5), so only a panic can (R-f-3). Apply-block errors
  are imperative and ordinary; compute-half errors are values (E-12).

---

## Divergences from the oracle (Solid's `next`, `ref/oracle/`)

Every scenario is also run through the real runtime — Solid's `next` branch
built from source at the commit in `ref/SOLID_NEXT` (`0847122`, 2026-10-26;
before that `2f7dc84` and `2a0da2f`, 2026-10-24;
the records before that date were found on the published rc.16 and all
re-run there): the oracle lowers the abstract syntax onto `solid-js` +
`@solidjs/universal` by interpretation, and the compiled runner's views go
through Solid's own compiler (`@solidjs/compiler`). Where the runtime shows
something other than the rule, the scenario records it in a
`## Divergences` section and the question is listed here until ruled. Every
repro in `ref/oracle/repros/` still reproduces on that commit.

- **DV-1 (The mount) — resolved 2026-10-22.** The first oracle run showed
  Solid rendering the mount partially; that was the harness mounting through
  `createRoot` + `insert` instead of the renderer's `render()`, which mounts
  the whole tree through one scheduled insert so uncaught async holds the
  first commit (Ryan: "I did something special in mount so that we render
  blank if we hit async outside boundary"). Through `render()` Solid holds
  the mount exactly as H-2 says. One rule changed on the way: a lane reader
  with no committed value is part of the mount's hold — there is no
  committed world for it to show (H-7; S-hold-4 instants 0–1 now ``).
- **DV-2 (A failed action) — ruled 2026-10-22.** Solid's: the plain
  writes a failed action held commit; only its optimistic state reverts.
  AC-1 now says so (S-solid-8 and S-solid-32 variants).
- **DV-5 (`pre`) — ruled 2026-10-23: Solid's.** `pre x` is `x`'s value
  before its most recent change (C-2, P-6 rewritten); the frame-indexed
  rule is withdrawn. S-core-1 now matches the oracle without divergences.
- **Lowering at JSX granularity (2026-10-24).** The oracle and the compiler
  used to insert an element's whole content through one render effect.
  Solid's compiled JSX gives each `{…}` child of an element its own insert,
  and makes a `{…}` outside an element (a fragment, a component's or a
  branch's view) a `memo`. The compiler now emits JSX that Solid's compiler
  lowers, so it has that shape by construction; the oracle lowers the same
  way by hand. Two records moved: DV-4 no longer shows in any scenario, and
  DV-10 appeared.
- **DV-10 (a held lane, per render effect) — reversed 2026-10-26: Solid's
  position adopted** (solidjs/solid#4284; `ref/oracle/repros/dv10-lane-effects.mjs`,
  found by S-solid-35's variant once the lowering matched JSX). The spec
  said a pending reader in lane `x` holds every reader of lane `x`, probes
  included, so the variant's instant 2 was `1 x1 / 1`, and DV-10 was ruled
  a Solid bug that morning (PR #2). Solid answered that a tracked
  `latest()` of a guess reads ahead of the guess's held lane (pinned in
  Solid's `verdict-contract.test.ts`, "the reader breaks out of the lane");
  its bug is the other grouping: one render effect reading both the guess
  and the probe freezes the probe. Solid is the source for holds, so H-7
  and H-11 now say so and the frame is `1 x1 / 5`. The open part of #4284
  (the one-effect grouping, the repro's `one` mode) shows in no scenario:
  every `{…}` is its own effect. Fixed on `next` too: at `2c9fdd9` the
  repro's `one` mode shows `1 x1 / 5`.
- **DV-13 (an empty fragment in the universal renderer) — a Solid bug,
  reproduced 2026-10-24; fixed on `next` 2026-10-26 (solidjs/solid#4274, fix #4276)** (`ref/oracle/repros/dv13-universal-empty.mjs`,
  found by S-ai2-search once its views went through Solid's compiler). In
  `@solidjs/universal`, an element whose children are all dynamic gets
  `null` markers, and each region keeps its place with a sentinel; a region
  whose value becomes an empty array (`<></>` compiles to `[]`) removes its
  sentinel, and what replaces it later is appended after its siblings. The
  DOM build uses comment markers and is not affected. The emitter writes an
  empty view as `null`, which keeps its slot.
- **DV-9, DV-11, DV-12, DV-14 (the server and hydration)** — Solid's server render
  and its hydrating client; recorded in 10-server.md.
- **DV-17 (a shared boundary merges mounts) — a Solid bug, ruled
  2026-10-26; reproduced 2026-10-25; fixed on `next` 2026-10-26
  (solidjs/solid#4283, fix #4302)** (`ref/oracle/repros/dv17-boundary-merges-mounts.mjs`,
  found by S-solid-5). Two branches mounted in separate instants, each
  reading a value one of two independent holds keeps (born held, D-1),
  stay independent — until both sit under one error boundary: then Solid
  merges the holds, and the first landing reveals nothing. Solid's rules
  do not say a boundary is a shared reader (D-4 "membership is the
  tick's"; D-3 "a render effect's mere existence entangles nothing"), so
  the spec keeps them independent. Ruled 2026-10-26 (Ryan): the merge is
  a Solid bug — a boundary reads nothing under it, so it entangles
  nothing. Filed as solidjs/solid#4283. The scenario keeps the ruled frame.
- **DV-16 (S-39, `latest` first) — a Solid bug, reproduced 2026-10-25;
  fixed on `next` 2026-10-26 (solidjs/solid#4275, fix #4281)**
  (`ref/oracle/repros/dv16-latest-first.mjs`, found by S-solid-39). A
  newly mounted reader that reads `latest s` before `n0` — a lane
  derivation that has never shown a value — publishes its branch with the
  slot empty instead of holding the mount; the `n0`-first order holds.
  Solid's own ruling (D-28) names the empty slot the violation. The spec
  frames stand; the interpreter holds in both orders (a reader that has
  never shown anything has no lane display to keep, so a read that throws
  holds the pass).
- **DV-8 (keyed projections) — a Solid bug, reproduced 2026-10-24; mostly
  fixed on `next` 2026-10-26 (solidjs/solid#4271, fix #4280)**
  (`ref/oracle/repros/dv8-projection.mjs`, found by S-ai2-search). A
  keyed equation lowers to `createProjection` over its memo; once the
  projection has held a value, a later failure of the memo is swallowed
  (the projection keeps its last value) and the memo's re-ask reports no
  `pending?`. The spec frames stand (the interpreter matches the agent's
  predictions, and the same app without `key` matches in Solid).
  Since the fix the projection reports its memo's errors and its re-ask's
  `pending?`. The two cases left in S-ai2-search (instants 2 and 4: no
  `searching…`) were ours, not Solid's (2026-10-27,
  `ref/oracle/repros/dv8b-projection-pending.mjs`): `pending? results`
  lowered to `isPending(() => proj)`, and Solid's probe judges the reads
  its thunk makes, never its return value — `isPending(() => store)` reads
  nothing and is `false` by design (D-24, A23). `pending?` over a
  structured value now reads its keys (`__rt.isPending`, the oracle's
  `pending` case), Solid's "whole-store questions are asked through
  reads"; S-ai2-search matches on every runner.
- **DV-18 (a keyed projection's rows miss later landings) — a Solid bug,
  reproduced 2026-10-26** (`ref/oracle/repros/dv18-projection-relanding.mjs`,
  found by S-ai2-search on the repin). A regression from DV-8's fix
  (solidjs/solid#4280, bisected to `1212b77`; `f811097` before it is
  fine): once a keyed projection over an async memo has taken its first
  landing, a memo per row — what a `for` row's `{r.name}` is — never sees
  a later landing, so the list and everything held with it keep the old
  rows. A render effect reading the rows directly follows. The spec frames
  stand. Filed as solidjs/solid#4305; fixed on `next` 2026-10-27 (shows
  in no scenario at `2c9fdd9`).
- **DV-4 (S-37 row 2 under a boundary) — a Solid bug, reproduced
  2026-10-23; fixed on `next` 2026-10-26 (solidjs/solid#4269, fix #4278)** (`ref/oracle/repros/dv4-signals.mjs`). Under a
  `<Loading>` that has shown content, a derived store's per-key verdicts
  (`isPending(() => state.a)`) read `false` while the derive re-asks —
  when the verdict is read in the same computation as the value. Outside a
  boundary, for an async memo under the same boundary (S-solid-26), or with
  the verdict in its own `{…}` hole — which is how compiled JSX reads it —
  they read `true` as D-30 says. Since the lowering matches JSX
  (2026-10-24) S-solid-37 shows the ruled frame on every runner.
- **DV-3 (S-22 row 3′) — a Solid bug, reproduced 2026-10-23; fixed on
  `next` 2026-10-26 (solidjs/solid#4268, fix #4282).** A render
  effect created inside a re-armed boundary's fallback, reading data the
  same change made pending, holds the content's reveal: content that lands
  first is withheld until the fallback's own data lands. Any compiled JSX
  fallback has such an effect (`<p>Meta {meta()}</p>` is an element plus an
  `insert`); Solid's pinned test reads the data directly in the fallback
  function and misses it. Standalone repro, signals only:
  `ref/oracle/repros/dv3-signals.mjs` (README there). The scenario keeps
  the ruled frame.

## What this document inherits without ruling

- Solid Q-7 (`loadingValue` after a shown failure) and the U-table items in
  `OPEN-QUESTIONS.md`. Scenarios that touch them are marked `inherits Q-n`
  and the expected frame is whichever column Solid rules.

## Scenarios

Ports of Solid's `SCENARIOS.md` are `S-solid-n` (same `n`); `S-hold-n` are
this spec's own. Ported so far: S-1, S-2, S-3 (branch-mounted form), S-4, S-6, S-7, S-10,
S-11, S-12, S-13, S-14, S-16, S-17, S-18, S-19, S-21, S-22, S-24, S-25,
S-26, S-27, S-29, S-30, S-31, S-36, S-38, S-40, S-41,
S-42+S-43, and with 06: S-8, S-9 (inverted — no escape), S-15, S-20,
S-26 rows 4–7, S-32, S-33, S-34, S-35, S-37, and with 03 RG-8: S-23;
S-28 (imperative probes, R-12), S-39 (one reader, two orders; DV-16) and
S-5 (two roots as two branches of one app — MO-1c; DV-17). Every scenario
of Solid's `SCENARIOS.md` is now ported. Divergences found and fixed
by porting are recorded in the rule they changed. Solid's probe columns
(`latest(x)`, `isPending(x)` beside a screen) are untracked reads; an
on-screen probe in a held lane of `latest` readers keeps what it showed
(D-25, S-solid-24; a guess's lane does not hold its `latest` probe — H-7), so
ports show the probe only where it is not in the held lane.

Scenario actions gain `resolve x v` and `reject x e`, which land the current
flight of equation `x`. Frames list, per instant, the screen and the probe
verdicts a reader of `pending? x` would show.

- `S-hold-1`: first load reaches a boundary; later update is held; `latest`
  on the control, `pending?` on the content (F-2, F-6, F-9).
- `S-hold-2`: shared input, three panels, slowest wins; one `on` boundary
  releases its panel (F-2, F-4, F-5).
- `S-hold-3`: joining — second write during a hold lands in the same `σ′`
  (H-3).
- `S-hold-4`: lane: `await` over `latest x` holds the lane, not the instant
  (H-7).
- `S-hold-5`: `errored` under a hold; error is an answer (H-12).
