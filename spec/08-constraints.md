# 08 — Constraints and their enforcement

**Status: OPEN (2026-10-22).** What the compiler refuses, how it decides, and
what the escape looks like. CN-1, CN-3, CN-4, CN-5 and CN-6 are ruled. The stance is Rust's: every static check is an
error, the checks are sound (an over-approximation that rejects some fine
programs and never admits a wrong one), modular (a module is checked against
its imports' signatures, not their bodies), and the only way around a check
is explicit, local and greppable — the check does not silently become a
runtime check.

---

## CN-1 — Severity

- **CN-1a (Errors only).** Bins U (unwritable) and S (static) in
  `99-diagnostics.md` are compile errors. There is no warning tier. Bin R
  is not a constraint: it is the runtime's attribution report (timing,
  holds, waterfalls) and never fails a build. (Ruled 2026-10-22.)
- **CN-1b (Diagnostics keep Solid's names).** A static error carries the
  code the dev runtime would have raised for the same shape, so a reader
  who knows one knows the other.

## CN-2 — The checks, by enforcer

| constraint | rules | enforcer |
| --- | --- | --- |
| no write, statement or `io` call in reactive scope; `optimistic` only in an action; a draft writes only `d` | W-1, W-2, IO-2, AC-3, ST-3a | grammar: no position exists (bin U) |
| `io` rises and never falls; `fn` is pure, `action` is `io`; `pure` only at the JS boundary | R-io-1..4 | row inference in the checker |
| `pending` enters only through `await`; `lane` only through probes; rows flow through equations and across modules | R-1, R-10, R-13, R-14 | row inference |
| no instantaneous cycle | C-1 | the static input graph (CN-3) |
| a reactive value never escapes its region; a closure capturing a region-local name does not outlive the region | O-1..O-5, SC-3 | escape analysis over closures: a region is a lifetime |
| a value parameter given a reactive argument | E-10 | static |
| an unkeyed `for` over records whose values change | ST-4b | static shape check |
| exported rows: a component's props and an exported equation carry their rows in their types | RG-4, R-14 | emitted in `.d.rx`; checked at the import (CN-4) |
| every failure a reader can see is discharged above it; an action catches what its body can fail with | R-f-5, R-f-6 | the `fails` row over the static application tree (CN-6) |

## CN-3 — Soundness and the static graph

- **CN-3a (Over-approximate).** C-1 and the region/escape checks run over
  the **static** input graph: the union of every branch's inputs, every
  prop read, every arm of a conditional. A program the static graph cannot
  prove acyclic or region-closed is rejected, even if no run would ever
  close the cycle or leak the value (`a = m ? b : 1; b = m ? 2 : a` is an
  error). `pre` is the declared delay that breaks a cycle (C-2);
  restructuring is the fix for an escape. The static graph is only ever
  used to *refuse* programs: scheduling is the runtime's dynamic tracking,
  as in Solid, and the static graph is never the truth for when updates
  happen. (Ruled 2026-10-22: "Solid can't loop like that easily today
  anyway" — a memo cannot read itself through a branch without `prev` —
  so the rejection costs no program people write.)
- **CN-3b (The JS boundary is the runtime's, not an escape).** An edge the
  static graph cannot see — a closure handed to a JS function, a cycle
  through a JS-owned value, a prop of a JS component — is not marked and
  not approximated: it is outside the graph, so no static rule fires, and
  the runtime's existing checks (the disposed-read error, the cycle error)
  are the backstop there. The compiler never replaces a failed static
  check inside `.rx` with a runtime check; the two have disjoint domains.
- **CN-3c (Pending is not a constraint).** A reader whose expression
  carries `pending` need not be under a `loading` region: with SSR the
  held mount is the correct behaviour and only an SPA would want to know.
  Uncaught `pending` at the mount stays a runtime diagnostic
  (`ASYNC_OUTSIDE_LOADING_BOUNDARY`) and the mount is held (H-2). The row
  is still inferred and displayed. (Ruled 2026-10-22.) A client-only build
  is the SPA case: CN-3d.
- **CN-3d (First load in a client-only build) — taken by default
  2026-10-30.** In a build with no SSR (Solid's `dom` target, not
  hydratable: a plain SPA), a reader that the first load surely waits on
  and that no `loading` region holds, on some path that renders it, is
  `ASYNC_OUTSIDE_LOADING_BOUNDARY` (bin S): nothing would be on screen until
  it answers, since there is no server-rendered page to keep. It is the
  same check as SV-7b's client question, over every question: readers
  across the static application tree (CN-3a), a prop checked where the
  component reads it. Surely waits: the reader's expression, or an
  equation it reads, has an `await` with no first paint (`-> v`, R-7) that
  is not behind a condition (`c ? null : await f()`, `c && await f()`, a
  `catch`'s alternative): whether such a question is asked on the first
  load depends on `c`'s first value, which the checker does not know, and
  the common case (a search that asks nothing until typed) never holds the
  first load. A probe waits like a read (R-9). Only the first load is
  checked: an answer that lands after the first paint is a transition
  (H-2), legal anywhere. Whether a later hold shows on screen is the
  affordances' business (`pending?`, `latest`, an `optimistic` guess; a
  `loading` region is an escape, not an affordance), and a hold that shows
  none is Solid's run-time `SILENT_HOLD` report; the static form stays
  advice (99, the advisory rows). With SSR the held mount stays correct
  (CN-3c, SV-1d), so the check is off: `rxc --spa`, and the Vite front end
  turns it on from Solid's options (`generate: "dom"`, `hydratable:
  false`). (Ryan, 2026-10-30: "The problem with topmost in csr on initial
  load is you see nothing"; "Answer after first paint is fine.. its just a
  transition as normal".) Checked by `rxc`, not yet by `ref/`.
- **CN-3e (An outside read holds a `loading on`) — Ryan, 2026-10-30.** A
  `loading on(k)` region re-arms when `k` changes, to show its fallback
  while what it waits on loads again. A reader outside that region of a
  question the region waits on, and that `k` re-asks (directly or through
  the equations it reads), holds the same change: nothing above it shows a
  fallback, so the change is held, the region's fallback is never seen, and
  the old content stays up with no sign of the wait (S-solid-16's rejected
  variant, S-solid-19). That is `LOADING_ON_OUTSIDE_HOLD` (bin S). Readers
  are views and effect inputs; a read under `latest`, `pending?` or `peek`
  holds nothing, and neither does a reader under another region that
  re-arms on the same change (it shows that region's fallback). Keys are
  the names `on` reads, and for a prop the field (`on(props.selected)` keys
  on `selected`). Checked within a component: a read through a prop in
  another component is left to Solid's run-time report. The fix is
  structural: move the read under the region, or read `latest x` outside
  it. (Ryan: "if you can make a reasonable static check we should do it";
  found by the round 9 eval, where a tab count's effect outside the list's
  `loading on(filter)` froze the old list on a filter switch in 39 of 82
  `.rx` apps.) Checked by `rxc` and `ref/`.

## CN-4 — Rows in signatures

- **CN-4a (Inferred, displayable, writable).** Rows (`io`, `pending`,
  `lane(x)`) are inferred everywhere, shown by tooling, emitted into
  `.d.rx` for every export and every component's props, and may be
  written by the author to constrain: `data: pending User` on a prop,
  `io (n: number) => Promise<void>` on a value. A written row narrower
  than the inferred one is an error (`ROW_NARROWER_THAN_INFERRED`, bin
  S); a wider one is accepted (the author promises less). (Ruled
  2026-10-22.)
- **CN-4b (Modular).** An import is checked against the signature only
  (09 MO-3: what a signature holds, and a component's summary).
  A JS import has no signature for rows: it is `io` (R-io-4) and its
  values are row-free unless the author writes rows at the import.

## CN-6 — Failures (ruled 2026-10-23)

- **CN-6a (Compile errors).** A reader with an undischarged failure is
  `UNHANDLED_FAILURE`; an action whose body lets one out is
  `UNCAUGHT_ACTION_FAILURE` (04 R-f-5, R-f-6). The stance is Rust's
  `Result`: an error that escapes every boundary halts the reactive system,
  which no program wants, so — unlike a pending mount (CN-3c) — the check is
  a constraint. Every JS promise can reject, so every async app has an
  `errored` above its async readers, usually one at the root.
- **CN-6b (Panics are not failures).** A synchronous throw from JS is not
  in the row (R-f-3) — as a Rust panic is not in a function's type. The
  same boundaries take it at run time. The check is sound for failures and
  silent on panics; the two do not mix, so neither weakens the other. A
  boundary may name `Panic` to take only what the check leaves (R-f-10).
- **CN-6c (The boundary assertion).** `fails A | B` on an import narrows
  what its promises reject with (R-f-8). It is an unchecked assertion in the
  direction that lowers the row, the same kind of statement as `pure`
  (CN-5): written at the JS boundary, greppable, nowhere else.
- **CN-6d (Over-approximate).** The row is computed over the static graph
  (CN-3a): every branch's failures, a pure closure's body as if it ran, a
  provision's failures at every `use`. An `await` whose promise cannot be
  traced to an import fails with `Error`.

## CN-5 — The escape

One word: **`pure`**, at the JS boundary (R-io-4) — the author asserts a
row the compiler cannot check, and only in the direction that lowers
taint. Its sibling at the same boundary is `fails A | B` (CN-6c), which
narrows a failure row the same way. There is no `allow`, no per-file lint level, no `unchecked` block,
and no `dynamic` marker: the static graph's checks are sound over `.rx`
(CN-3a) and silent outside it (CN-3b), so nothing needs opting out.
(Ruled 2026-10-22; the earlier `dynamic` proposal is withdrawn.)

---

## Diagnostics this document settles

| code | bin | rule |
| --- | --- | --- |
| `ROW_NARROWER_THAN_INFERRED` (new) | S | CN-4a; R-f-9 for `fails(…)` |
| `UNHANDLED_FAILURE` (new) | S | CN-6a, R-f-5 |
| `UNCAUGHT_ACTION_FAILURE` (new) | S | CN-6a, R-f-6 |
| `NOT_AN_ERROR_CLASS` (new) | S | R-f-1 |
| `ASYNC_OUTSIDE_LOADING_BOUNDARY` | R; S in a client-only build | CN-3c: a runtime report, not a constraint; CN-3d: a first load nothing holds in a client-only build |
| `LOADING_ON_OUTSIDE_HOLD` | S | CN-3e: a reader outside a `loading on(k)` region of what it waits on |

---

## Implementation (`ref/src/check.ts`)

The checker runs over the AST before the interpreter; a program with any
diagnostic does not run (`CheckError`). `node --experimental-strip-types
ref/check.ts file.rx…` prints them. Every code is listed in
`99-diagnostics.md §Codes the checker adds` with the scenario that rejects
it; `S-check-1`'s accepted program is built from near-misses so a checker
that over-reaches fails a scenario too.

How each enforcer is realised:

- **Names** resolve lexically. A component body sees its declaration site,
  never its caller (RG-7a); the interpreter's own lookup is laxer, so this
  is the checker's job.
- **Rows.** `io` is a symbol property: actions and non-`pure` imports carry
  it, an equation bound to one inherits it; a call of an `io` value in
  reactive scope is refused (in a `fn` body, as `IO_IN_FN`). A closure
  written in reactive scope is reactive scope (SC-3). `pending` / `lane`
  are inferred per equation through the equations it reads (R-13) and
  compared only where a row is written (CN-4a).
- **The static graph (C-1)** is per block: an equation's edges are every
  name it reads in any branch; `pre x` inside `x` contributes no edge,
  `pre y` of another node is an edge to `y` (C-2).
- **Regions are lifetimes (O-3).** Each block is a region with a depth. A
  write whose stored value contains a closure — directly, through a `let`,
  or as the result of a functional write's function — capturing a reactive
  name from a region deeper than the written source's is `REGION_ESCAPE`.
  (A write through a provision, `use p := …`, is no longer a program:
  O-4. A closure passed to an action that stores it is not followed yet,
  O-4a.) A name holds
  a closure through a `let` or an equation's expression; a call to a
  `fn` holds what its result captures, with the instance of an
  instantiation (RG-6) standing for whatever it declared, at the call's
  region (O-3a). A prop written into a place that outlives the component
  is recorded on the component, and the argument is checked at each
  application, where a provision's place is found up the application
  tree from the site (O-3b).
- **Provisions (RG-7b)** are checked over the static application tree:
  the names available in a region are its own provisions plus, for a
  component, the intersection over every place it is applied; children
  passed to a component are owned where it reads them, so they see its
  provisions. A component never applied, or applied only recursively, is
  undecidable and not checked (the runtime's `ContextNotFound` remains).

- **Failures (CN-6)** are recorded during the walk and resolved after it,
  when every symbol's thunk exists. Each reader, each argument at an
  application, and each action body gets a row: classes, plus *prop
  references* (`props.x` of some component, with the catches already
  applied on the way out of the expression). Resolution builds, per
  region, the chains of catches up to its component's root — through
  children, which continue at the chains of the component's own
  `props.children` reads and then the application site's. A prop's chains
  are its reads' chains; a component's escaping classes are its readers'
  classes that some chain lets through, and they continue at each
  application site; the program root's are errors. An action's prop
  references are checked at each application against the argument.
  Recursion and cycles cut to the empty set, which is sound because a
  path through a recursive application only adds catches.

- **Modules (CN-4b)** are 09: each module is checked dependencies first,
  against the signatures computed so far (MO-3), and produces its own. The
  failure and provision checks run as one pass whose steps record what
  each region discharges; an imported component's summary is one step.

A module may also be known by its `.d.rx` alone (09 MO-9): the text is its
signature, read in place of the body.

Types are 13: TypeScript checks a projection of the program (TY-1). Not yet: handler
statements typed into a scenario's `handler` rows (the interpreter checks
those at run time).
