# 04 — Rows

**Status: OPEN (2026-10-21; R-fails ruled 2026-10-23).** Four properties of
an expression that the compiler tracks and the grammar restricts: `io` (may
write or side-effect), `pending` (may have no answer yet), `lane(x)`
(derived from a probe of `x`), `fails(C)` (may fail with an error of class
`C`). All four are inferred; annotations exist for declarations and display.

This document is the static side. What the screen does with a pending reader
is `05-holds.md`; this file only says where rows come from, how they flow,
and where they may not go.

---

## R-io — effectful functions (restated from 02 IO-1..3)

- **R-io-1 (One-way taint).** `io` is a row the compiler infers inside
  `.rx`: a function is `io` iff its body writes a source, calls an `io`
  function, or calls a value whose type carries `io`. Taint only rises:
  nothing in `.rx` can declare a tainted body clean.
- **R-io-2 (Declaration is the row).** `fn` is pure by definition — a `fn`
  whose body is `io` is a compile error (`IO_IN_FN`, bin S). `action` is
  `io` by definition (AC-1). An apply block, an action body and an arrow
  written in imperative scope are `io` scopes; an equation, a `fn` body,
  a draft block and an arrow written in reactive scope are not.
- **R-io-3 (Call site).** An `io` value may be called only in an `io` scope
  (SC-2). Calling one anywhere else is a compile error (`IO_IN_REACTIVE`,
  bin S — Solid's runtime `ACTION_CALLED_IN_OWNED_SCOPE` has no runtime
  form here). Carrying an `io` value (storing it, passing it) is not a
  call; its type carries the row: `io (n: number) => Promise<void>`.
- **R-io-4 (The boundary).** Every JS import is `io`. `import pure { f }
  from …` is the one assertion that lowers taint, and it is unchecked for
  JS (checked when the imported module is `.rx`, where it must agree with
  the inferred row: `IMPORT_ROW_MISMATCH`, 09 MO-4). `pure` means safe to call from reactive scope: no
  writes to reactive state, and safe to re-ask — a data loader returning a
  promise is `pure` in this sense, and is the normal input of an `await`
  equation (R-1). There is no `io` keyword: dirty is the default and is
  inferred; `pure` is the only word, and it points one way. (Ruled
  2026-10-22.)

## R-pending — absence

- **R-1 (Entry).** `pending` enters only through `await e` in reactive scope.
  `await` is the row marker, not a scheduler: if `e` is already a value,
  `await e` is `e` in the same instant with no tick; if `e` is a promise or an
  async iterable, the equation is pending until the first answer lands.
- **R-1a (No promise without `await`).** [ruled 2026-10-28] An equation's
  value is never a promise or an async iterable. It lowers to a memo, and
  Solid's memo consumes one its function returns, so `x = fetchUser(id)`
  would be pending at run time while the source says it is a value. Where
  the type is known, an equation whose value may be a promise or a stream
  (on any branch) is `MISSING_AWAIT`, checked by the type layer (13 TY-5b):
  write `await e` or `await* e`. A promise inside a value
  (`{ p: fetchUser(id) }`, `[a, b]`) is not consumed and is passed as one.
  Where the type is `any`, the check cannot see it and Solid still consumes
  the promise; the rows (R-3) and the AC checks then miss that entry. Where
  more could be done: refuse an `any`-typed call into a JS import in an
  equation without `await`; noted, not adopted. (Replaces "a Promise-valued
  expression without `await` is an ordinary value of type Promise and is
  never pending", which the lowering contradicted.)
- **R-2 (Flow).** An equation that reads a pending value is pending. A reader
  of a pending value is a pending reader (05 decides what that does to the
  screen). An effect whose compute half is pending does not run its apply
  (EF-2: nothing changed). Passing a pending value — as a prop, into a `ref`
  parameter, into a `fn` — is not reading it; only evaluation of the value is.
- **R-3 (Functions).** A `fn` whose body contains `await` has row `pending`;
  a lifted call to it is a pending equation. Rows compose through calls like
  values.
- **R-4 (Flights).** The in-flight work of a pending equation belongs to its
  question (V-9), and the question belongs to the change whose pass asked it:
  a pending pass triggered by change `d` is `d`'s, whether or not a new
  request was issued (S-solid-16: `page` re-asks `details` through
  `pageData` without a new fetch). An input change asks a new question: the old flight is
  abandoned (its answer, if it lands, is discarded), the body restarts from
  the top, and the old body's `finally` runs. A re-ask (`refresh`) restarts
  the body for the *same* question — quiet (F-9).
- **R-5 (Static inputs).** Because inputs are collected at compile time, a
  read after an `await` is a dependency like any other. There is no tracking
  window; `UNTRACKED_READ_AFTER_AWAIT` is unwritable. Likewise an absent
  operand (pending or error) does not erase the equation's other inputs:
  `"d:" + pageData + ":" + count` depends on `count` even while `pageData` is
  pending (found by `ref/`: S-solid-16 — a dynamic-tracking
  evaluator that short-circuits on absence drops `count` and lets its hold
  commit).
- **R-6 (Errors).** A rejected `await` is an error value (E-12): it ends the
  wait, flows like a value, is caught by `errored` or `catch`, and is
  retried by a new question or `refresh`. There is no separate errored
  state. Its class is `Error`, or what its import declares (R-f-8).
- **R-7 (First paint).** `await e -> v` declares `v` as the value until the
  first answer lands: the equation is never pending on its first flight and
  `pending?` of it is `false` until then. Later questions follow R-4 and the
  hold rules. (Solid: `loadingValue`.)
- **R-8 (Imperative scope).** [taken by default 2026-10-30; replaces the
  unenforced draft "reading a pending equation is a type error"] A snapshot
  reads `σ` (H-10): an equation with a new question out reads its committed
  value, which is the value the screen shows. What a snapshot cannot give is a
  value that is not there: an equation whose row has `pending` with no
  committed value yet (a first load without `-> v`, R-7), or whose row
  `fails` (R-f-7: the snapshot throws). A handler (a plain arrow, an action,
  an apply block) that snapshots such an equation `x` must either **handle**
  it or be **covered**:
  - handled: for the absent half, the equation has a first-paint default
    (`await f() -> v`, R-7), so it always has a value (a probe does not
    help: on a first load `pending? x` is `false` and `latest x` throws,
    R-12); for the failure half, the read is inside a `try` or a `catch`
    expression that takes its failures (`x.some(…) catch (e) => false`,
    R-f-7). In an action, R-f-6 already requires the second;
  - covered: the element sits inside a `loading` and an `errored` region
    whose content reads `x` (the usual form: the control lives in the region
    that shows `x`, with `disabled={pending? x}` for a new question), or the
    handler is on an element whose `disabled` reads `x`. The second form
    holds on `x`'s first load like any reader: with no `loading` above it,
    that is the page (H-5), so it fits an `x` that already has a value. A covered
    element is not there, or not enabled, while `x` has no value, a new
    question out, or an error, so the handler never runs then: the element's
    attributes are the handler's compute half, with the same separated
    inputs an effect has (EF-1).

  Neither is `UNGUARDED_SNAPSHOT` (static). The check adds nothing at run
  time and Solid has no equivalent: `untrack` of a pending node throws there
  too, but nothing says so before it runs. A handler that needs "the value
  when it lands" uses `await` in its own body, which is ordinary JS
  asynchrony (SC-3: the continuation stays imperative). Found by the AI
  eval's round 8 timing fuzzer (eval/results/fuzz-2026-10-30): in every
  labels app, `add label` reads `shown.some(…)` from a button outside the
  labels' `loading` region; clicking it before the labels' first answer
  throws `snapshot(...).some is not a function`, and after a failed load it
  throws the load's error out of the click (scenario S-guard-1 below).

  **S-guard-1** (handler over a first load). Program: `source labels = await
  fetchLabels(id)`, `shown = labels.filter(…)`, a `loading`/`errored` region
  listing `shown`, and outside it `<button onClick={() => { if
  (!shown.some(l => l == input)) { addOne(input) } }}>`. Actions: mount;
  click. Frames: `loading labels | [add]`, then a run-time `TypeError` (no
  value). With `reject labels e` before the click: `labels error | [add]`,
  then the click throws `e`. Both are `UNGUARDED_SNAPSHOT` at compile time.
  Fix (the eval references): the button inside a `loading on(id)` and an
  `errored` region of its own, with `disabled={pending? shown}`. A bare
  `disabled={pending? shown}` on the button outside any region also passes
  the check, but holds the detail on the labels' first load (the eval's tests
  then fail). Checked by `rxc` (`UNGUARDED_SNAPSHOT`), not yet by `ref/`.

## R-lane — display-ahead

- **R-9 (Probes).** `latest x` and `pending? x` are the two probes. `latest x`
  reads the in-flight value of `x` if there is one, else the committed value.
  `pending? x` is `true` iff `x`'s value is not the final answer to a new
  question (F-9); on a first load, both probes do what a read of `x` does —
  there is no verdict until there is an answer. A failure is an answer
  (H-12): a first load that fails ends the first load, and `pending? x` is
  then `false` (found by S-ai2-search).
- **R-10 (Lane row).** A probe is itself a dependency on `x` (a lane one):
  the probing reader re-evaluates when `x` changes. The result of a probe of `x` carries row `lane(x)`. The
  row flows through equations like `pending`: `y = latest x * 2` has
  `lane(x)`; an expression over probes of two sources has both lanes. It
  stops at readers: a reader of a lane-typed value renders in that lane (for
  the probe-derived part of what it reads; its plain reads are R-11's). This
  is Solid F-6 ("a display-ahead read is a world of its own") as a type; what
  it means for the screen is 05.
- **R-11 (Probes never hold; posture is per read).** A probe never holds the
  instant it reads ahead of (F-6). Only the probe reads ahead: the row
  `lane(x)` is the probe's, and every other read in the pass keeps its own
  (Solid D-25, decision 1 of solidjs/solid#4695). A plain read of a source
  the same pass also probes is the screen's: `[pending? x, x]` is `[true,
  committed]` while `x`'s change is held, in either order, in a view reader
  and in an equation alike, and the two are atomic because they are one
  pass (D-23, V-1; S-solid-27). A plain read of any *other* held value makes
  the pass the hold's work (H-3), whatever it probes beside it
  (S-solid-27's equation variants; an `on` expression likewise, H-6,
  S-solid-49). A pass's posture is decided by its reads in that pass: never
  inherited from what created it or what it reads, never carried into its
  next pass (S-solid-50).
- **R-12 (Probes in imperative scope).** `latest x` and `pending? x` are
  readable in imperative scope as snapshots of the verdict / in-flight value
  at that moment. On a first load there is no owner to hold, so `pending?
  x` is `false` — no new question yet, only no answer — and `latest x`
  throws, as it does anywhere: a value that has never had one is not read
  (Solid S-28, A7; S-solid-28). A `try` in the handler catches it.

## R-fails — failure (ruled 2026-10-23)

Rust's split, in this language's terms: a **failure** is part of a value's
type and must be handled before it reaches the screen or leaves an action;
a **panic** is a bug — caught at run time by the same boundaries, not
tracked. Inspired by solid-yield's typed failure color; the checks are
`ref/src/check.ts` (08 CN-6).

- **R-f-1 (Error classes).** `error Name(f₁, …, fₙ) => message` declares an
  error class. `Name(…)` constructs one (no `new`); at run time it is a JS
  class extending `Error`, with `name`, the fields, and `message` — the
  expression after `=>` over the fields, or the name when there is none.
  Classes are flat. `Error` is the top class: every failure is an `Error`,
  and a list that names `Error` names every class. A JS class imported is a
  class too. A name used as a class (in a `catch`, a boundary, an import's
  `fails`) that is neither is `NOT_AN_ERROR_CLASS` (bin S).
- **R-f-2 (The row).** `fails(A | B)` is the set of classes an expression's
  evaluation may fail with. It is inferred like `pending` (R-13): it flows
  through equations, lifted calls, and the pure closures an expression
  creates (a closure may be called during the evaluation, by `map` or
  `filter`), and composes by union.
- **R-f-3 (Entry).** A failure enters in three places:
  1. `throw e` — an expression in reactive scope (TC39's throw-expression
     shape: `x > 0 ? x : throw BadInput(x)`; the equation's value is the
     error, E-12) and a statement in imperative scope. Its class: `C(…)` of
     a class `C` is `C`; a `catch` binding rethrown is what that catch
     caught; anything else is `Error`.
  2. `await e` of a JS promise — `e` a call into a JS import, directly or
     through an equation or a `fn` that returns one: the import's declared
     failure, `Error` unless narrowed (R-f-8). An `await` whose promise
     cannot be traced to its origin is `Error`.
  3. A snapshot read in imperative scope of a value whose row fails (R-f-7).

  A synchronous throw from a JS function — `fail(msg)` in the scenario
  prelude, or any bug — is a **panic** and is in no row. A boundary takes it
  at run time like anything else; if nothing does, the runtime halts
  (H-12). The static guarantee is about failures, not bugs.

  A source holds what its initializer gave it, so a `source x := e` whose
  `e` can fail has `e`'s failures until it is written (found by
  S-ai2-settings: `source draft := peek(props.initial.name)`).
- **R-f-4 (Discharge).** A failure leaves the row at:
  - `errored fallback(e: A | B) { … } { … }`, for every reader in its
    content: `A` and `B`. `fallback(e)` or a bare `fallback` discharges
    every class. At run time a failure of another class passes the boundary
    to the next one up — the boundary does not show its fallback for it, and
    re-decides when the failure it shows changes class (S-fail-1 instant 6).
  - `e catch (x: A | B) => alt`, an expression: when `e` fails with `A` or
    `B` its value is `alt`, with `x` the error; other failures and pending
    pass through untouched. `catch (x) => alt` discharges every class. It
    binds looser than every operator, `?:` included — `c ? a : b catch …`
    catches the conditional; parenthesise to catch one arm. Over an
    equation's `await`, a matching rejection is an answer:
    `user = await fetchUser(id) catch (e: NotFound) => null` lands `null`.
  - An effect: its apply receives the failure as a value (`$0…`, H-12), so
    its inputs are discharged.
  - `pending? e` is a verdict and never reads `e`'s failure; `latest e` and
    `peek e` carry it.
- **R-f-5 (Readers discharge).** A reader whose row has a class that no catch
  and no boundary above it discharges is `UNHANDLED_FAILURE` (bin S). A
  reader is `{e}`, a non-handler attribute, an `if` condition, a `for`
  collection, `loading on(e)`. "Above" follows the static application tree
  (CN-3a, the tree RG-7b uses). Passing a value is not reading it (R-2): a
  prop's failures are checked where the component reads `props.x` — against
  the catches and boundaries inside the component, then those above each
  place it is applied, with that place's argument. Children are read where
  the component reads `props.children` (RG-4c): a component that wraps its
  children in `errored` discharges for them, and children it never reads are
  never checked (S-fail-2). A component never applied is not checked (its
  failures are its signature's, CN-4b); an equation no reader reaches is not
  checked. (Ruled 2026-10-23: an error that escapes every boundary halts the
  reactive system, which is never the right behaviour — unlike a pending
  mount, CN-3c, there is no SSR case for it. An app typically has one
  `errored` at its root — `fallback(e: Panic)` when its panes are meant to
  keep their failures, R-f-10.)
- **R-f-6 (Actions catch).** An action's body may not let a failure out: a
  class it can fail with that no enclosing `catch` in the body discharges
  is `UNCAUGHT_ACTION_FAILURE` (bin S). The handler that launched the action
  does not await it, so nothing after the body could (ruled 2026-10-23).
  `catch (e: A | B)` discharges `A` and `B` — at run time other classes are
  rethrown; `catch (e)` or a bare `catch` discharges every class; `finally`
  discharges nothing; a nested `action` is its own. Awaiting an action fails
  with nothing: it cannot fail. An action reading `props.x` is checked at
  each application against that argument, with no boundary to help.
  DV-2 (a body ended by an exception commits its held writes, reverts its
  guesses) now applies to panics only (S-action-1). Plain handlers and
  apply blocks are not checked: a throw there is ordinary JS (H-12).
- **R-f-7 (Snapshots of failures throw).** In imperative scope, a snapshot
  read (SC-2) of a value that is an error throws its error — the imperative
  form of the same failure, which the action's `catch` handles. (Before
  this rule the runtimes returned an error value, which `.name` then read
  silently as `undefined`.) An apply's parameters are values: a failure
  arrives as `$0`, not thrown (S-solid-42).
- **R-f-8 (The JS boundary).** A JS promise may reject with anything.
  `import pure { f } from "./api" fails A | B` declares what that import's
  promises reject with — an unchecked assertion, like `pure` (CN-5).
  Without it, `Error`. A declaration file beside the JS module (`api.d.rx`)
  states purity and rejections once for every import (09 MO-8).
- **R-f-9 (Written rows).** `fails(A | B)` may be written in a type's row
  prefix (CN-4a): `name: pending fails(NotFound) string = …`. A written
  failure row narrower than the inferred one is `ROW_NARROWER_THAN_INFERRED`,
  and so is a written prefix that leaves `fails(…)` out of a value that fails.

- **R-f-10 (A boundary for panics).** `Panic` may be listed in a catch or
  a boundary: `errored fallback(e: Panic) { … } { … }`. Statically it
  discharges no failure class, so every failure under it must be discharged
  below it; at run time it takes whatever reaches it — which, failures being
  discharged below, can only be a panic. This is the root boundary for an
  app whose panes handle their own failures: a catch-all `fallback(e)` at
  the root would also be accepted, but then a pane that lets `Error` out
  still checks and a failing pane takes the page down; with `Panic` the
  checker keeps each failure in its pane (ruled 2026-10-24, from the second
  AI test; S-fail-3).

- **R-f-11 (A failure in another section's boundary).** [WITHDRAWN 2026-11-03,
  Ryan: too specific] Drafted 2026-11-02 from the round 10 AI eval (desk rx-2:
  the list, passed to the detail as `rows`, replaced the detail when it
  failed) as `FOREIGN_FAILURE`: a question's failure surfacing in an `errored`
  region that guards an unrelated question, while it also surfaces in its own
  non-nested region. The principle (a boundary shows the failures of the
  questions it owns) holds, but the general form refuses ordinary code (one
  question shown in two places on purpose) and the narrow form matched one
  program in 695. Kept as a guide idiom (catch a borrowed read). Checks come
  back when a pattern recurs or follows from a principle already held
  (S-fail-4 keeps the accepted program).

## R-inference

- **R-13.** Rows are inferred locally per function and per equation from the
  body; no whole-program analysis. `io` from writes and `io` calls; `pending`
  from `await` and pending inputs; `lane` from probes and lane inputs.
- **R-14.** A declaration (`.d.ts`-equivalent) states rows for imports:
  `! io`, `! pending` (a function returning a promise that the language
  should treat as awaitable in place). Absent a declaration, R-io-4 applies.

---

## Diagnostics this document makes unwritable or static

| code                             | bin | rule  |
| -------------------------------- | --- | ----- |
| `UNTRACKED_READ_AFTER_AWAIT`     | U   | R-5   |
| `PENDING_ASYNC_UNTRACKED_READ`   | S   | R-8: `UNGUARDED_SNAPSHOT` (new), a handler's snapshot of a value that may be absent or failing, neither handled nor covered |
| `PENDING_ASYNC_FORBIDDEN_SCOPE`  | S   | same  |
| `SYNC_NODE_RECEIVED_ASYNC`       | U   | R-1   |
| `MISSING_AWAIT` (new)            | S   | R-1a: an equation whose value may be a promise or a stream (13 TY-5b) |
| `ASYNC_WATERFALL`                | S   | an `await` whose inputs depend on another `await` (R-2) |
| `UNTRACKED_ASYNC_HANDLER` (structural half) | S | a handler that awaits with no write before and no `action` |
| `UNHANDLED_FAILURE` (new)        | S   | R-f-5 |
| `UNCAUGHT_ACTION_FAILURE` (new)  | S   | R-f-6 |
| `NOT_AN_ERROR_CLASS` (new)       | S   | R-f-1 |

## Scenarios (executable once 05 gives pending readers a screen semantics)

- `S-row-1`: `await` of a value is same-instant; of a promise is pending until
  `resolve` (R-1).
- `S-row-2`: input change abandons the flight; late answer discarded (R-4).
- `S-row-3`: `await e -> v` first paint; `pending?` false until first answer
  (R-7).
- `S-row-4`: rejected await is an error value; new question retries (R-6).
- `S-row-5`: `fn load(id) => await fetch(id)`; `x = load(id)` pending (R-3).
- `S-fail-1` ✓: typed classes — a class caught into a value, a typed
  boundary taking its class, another class passing it to the root, recovery
  through both (R-f-1..5, R-f-9); four rejected variants.
- `S-fail-2` ✓: failures through components — children under the
  component's boundary, a prop checked where it is read, a tail `await …
  catch` (R-f-4, R-f-5); five rejected variants incl. R-f-6.
- `S-action-1` ✓: a panic ends a body (DV-2); two R-f-6 rejections.
