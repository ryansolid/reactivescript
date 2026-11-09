# 06 — Stores, questions, actions

**Status: OPEN (2026-10-21).** Structured values, sources with a standing
question, drafts, keys, streams, and the imperative forms that tie writes to
async work: `action`, `optimistic`, `refresh`, `affects`. Rules cite Solid's
F-9, F-11 and the derived rules they restate. In `ref/`: ST-1…ST-6,
AC-1…AC-5 (S-store-1…5, S-solid-8/9/15/20/26/32…35/37). Optimistic path writes: S-store-6. AC-6 `until`: S-action-2. AC-7 try/catch: S-action-1. A functional guess over a held input, and two actions guessing one slot (H-11): S-action-3, S-action-4. AC-1b…AC-1d (inferred actions, held writes, stale own reads): S-infer-1…5. AC-1e (stale write-back): S-infer-6.

---

## ST — Structured values

- **ST-1 (Structured vs atomic is the type).** A source or equation whose
  value is an object or array is structured; there is no separate store
  primitive. Atomic lowers to `createSignal`/`createMemo`, structured to
  `createStore`/`createProjection`.
- **ST-2 (Dependencies are per object identity, per key).** A read of `o.k`
  depends on `(o, k)`; a read of a reactive name depends on its root. Reaching
  `o` through `x` tracks every step. A shared object reached through two
  names notifies readers through either (S-region-3 instant 6).
- **ST-2a (Writes).** `x := v` replaces the root; E-6 per-path equality
  applies (an equal-by-paths value is a no-op and keeps the old identity).
  `x.a.b := v` mutates in place and notifies `(x.a, b)`; readers of `x`
  alone are not notified. Several path writes in one imperative run are one
  change (W-3).
- **ST-2b (Equation results).** A structured equation result is compared per
  path with its previous value (E-6): equal → cut, keep old identity;
  otherwise the root changed. With a key (ST-4) the result is reconciled
  instead.
- **ST-2c (Pending is per key).** [Solid F-9, D-30, S-37] A held path write makes
  `pending? x.a` true and leaves `pending? x.b` false; a root write or a
  re-ask of a source with a question (ST-5) makes the whole family pending
  (S-solid-37 and its variant).

## ST-3 — Draft

An equation may write only its own draft, in its own body:

```
selected = draft(pre selected -> {}) { d[id] := true; d[prevId] := false }
```

- **ST-3a.** `draft(e) Block` evaluates `e` (normally `pre x -> seed`),
  binds a copy of it to `d` in the block, runs the block (the only place
  `:=` appears in reactive scope, and only on paths rooted at `d`), and the
  equation's value is `d`. Writes are the delta (O(changes)); the copy is
  made along written paths only, so untouched sub-objects keep identity
  (S-store-2). E-6 then compares the draft with the previous value per
  path: an unchanged key's readers and effects are quiet.
- **ST-3b.** The block is reactive scope for reads: every read is an input.
  It is not imperative scope: no `io` calls, no writes to anything but `d`
  (W-1 applies), no `await` except as an equation input.
- **ST-3c.** A draft never escapes its body: a closure that captures `d` and
  runs later is rejected (O-3). Late answers are `yield` (ST-6), not
  callbacks into a draft.

## ST-4 — Key

- **ST-4a.** `x: T[] key k = e` (abstract syntax `x key k = e`; also on a
  source, `source x key k = e`) declares
  that elements of `x` have identity `k`. A new result is **reconciled** by
  `k`: rows with the same key keep their object identity and receive
  per-key path updates (their readers run only for changed keys); new keys
  create, missing keys remove; a reorder moves rows (S-store-3). `pending?`
  and `latest` on an element follow the key.
- **ST-4b.** `for u in x` over a keyed collection uses the key for row
  identity (RG-2a). A collection derived from a keyed one by selection
  (`filter(rows, …)`) keeps the rows' identity and needs no key of its own;
  an unkeyed `for` over records that are rebuilt on every change (`map`
  into fresh objects) is a diagnostic (`UNSTABLE_LIST_IDENTITY`, bin S).
- **ST-4c.** Solid: `createProjection(fn, seed, { key })`, `<For keyed>`.

## ST-5 — A source with a standing question

- **ST-5a.** `source x = e` (not `:=`) declares a source whose value is the
  equation `e` **until written**: it re-derives when `e`'s inputs change, and
  a write `x := v` overrides it until the next re-derivation. `e` may
  `await`. `e` may also be a constant (`source editing = null`,
  `source cart = []`): a question with no inputs, whose truth is that
  constant — the shape for provisional UI state that a guess (AC-3) can
  clear and that reverts to the truth when the hold ends (examples/users.rx,
  examples/cart.rx). Solid: `createSignal(fn)`, `createStore(fn, seed)`;
  written both plainly and optimistically, a `createSignal(fn)` truth under
  a `createOptimistic(() => truth())` layer.
- **ST-5b.** Its question (V-9) is `e`'s inputs. `refresh x` re-asks it
  quietly; `affects x` declares that in-flight work will change it (H-9).
- **ST-5c.** It is the only legal target of `optimistic` (AC-3): a guess
  needs a truth that will confirm or correct it.

## ST-6 — Streams

- **ST-6a.** `yield v` in an equation body is another answer to the same
  question: a quiet update (F-9), each landing its own change —
  `pending?` is `false` after the first answer. A change to an input
  restarts the body (R-4) — later answers of the old body are inert — and
  runs its `finally`. `yield` has no meaning in imperative scope. In `ref/`
  a stream is a flight that lands more than once (S-store-5); the body form
  waits on 07's concrete syntax.
- **ST-6b.** `await* e` of an async iterable is its latest answer; the loop
  is implied (07: streams are `await*`). A plain `await` takes one answer —
  of an async iterable, its first; later landings are not its answers (the
  three runners in `ref/` follow this since 2026-10-24; S-store-5 reads its
  stream with `await*`). A keyed structured stream reconciles each answer
  (ST-4).
- **ST-6c.** Solid: an async-generator memo/projection; `live(fn)`.

---

## AC — Actions and guesses (imperative forms)

- **AC-1 (action).** `action name(params) { … }` declares an `io` function
  whose body is **one change** across its awaited work: every write between
  entry and return belongs to that change and is held until the body returns
  (F-2's explicit form) — that is, until every `await` in it has landed. The
  questions its writes cause (a fetch re-asked because a source changed) are
  not the action's: they hold the change only as any change's pending
  readers do (H-2…H-6), so an action with no `await`, `select(id) { selected
  := id }`, is an ordinary instant and a `loading on(selected)` shows its
  fallback at once (clarified 2026-10-24: all three agents of the second AI
  test asked). The
  handler that launches it is the same instant, so the handler's own plain
  writes — before or after the call — are the action's and are held with it
  (D-7's same-tick adoption); to land something now, make it a guess, a
  separate event, or an `onFlush` run (02 EF-8).
  `action { … }` inline in a handler is the same for one run, and so is an
  arrow whose body guesses, declares `affects`, or writes and awaits
  (AC-1b). There is no
  escape: a write after an `await` is still the action's (the language has
  the scope, so none of 2.0's generator plumbing — S-9's "fresh write
  escapes" is unwritable; S-solid-9 is the inverted port). A rejection
  inside the body ends it like a return: the writes it held commit, and
  only its optimistic state reverts — a write is intent, a guess is the one
  provisional state (ruled 2026-10-22 against the oracle, DV-2; S-solid-8
  and S-solid-32 variants). Compensation is the catch's job. An action body suspends only at a
  statement-level `await` (`await e` or `let v = await e`, either with a
  `catch (x: C) => alt` after it: a matching rejection is the statement's
  value, R-f-4); an `await` anywhere else in imperative scope is
  `AWAIT_IN_EXPRESSION` (bind it first; S-await-1). The instant
  begins when the run suspends or returns (H-10). An action called from a
  handler is launched, not awaited: the handler continues, and the
  handler's own writes are the same instant's change (D-7's same-tick
  adoption).
- **AC-1b (Inferred action).** [ruled 2026-10-28] An arrow function in
  imperative scope, including an element's event handler (02 SC-4), is an
  action when its own statements include `optimistic x := e` (AC-3),
  `affects x` (AC-5), or both a write to a source (W-1) and a
  statement-level `await` (07 decision 16). It is then `(ps) => action { B }`
  with every consequence of AC-1: one change across its awaited work, its
  writes held with it, its guesses living over that hold, and every failure
  it can produce caught (R-f-6). "Own statements" excludes the bodies of
  closures inside it, each inferred on its own, and an inline `action { … }`,
  which is its own run; it includes the statements of a local closure the
  body calls by name (`let f = () => { … }; f()`), whose writes are this
  run's. Calling an inferred arrow launches the action, as calling a
  declared one does. A body that awaits and writes nothing is a plain run.
  An `effect`'s apply block is never inferred: its return is the effect's
  cleanup (EF-5), which an action's body cannot give, and the next run's
  cleanup could not cancel an action in flight. A server function's body is
  never inferred. A guess in either stays `OPTIMISTIC_OUTSIDE_HOLD`.
  Lowers to Solid's `action` exactly as `action { … }` does, nothing added
  (11). Solid: a TypeScript function's promises are invisible to the
  transition, so its author writes `action(function* () { … })`; here every
  suspension is a statement the compiler sees, so the keyword is needed only
  to hold a write on purpose (AC-1c) or to name an action (S-infer-1, 3, 4).
- **AC-1c (Held write).** [ruled 2026-10-28] In an inferred action (AC-1b),
  a plain write from which some path of the body reaches an `await` is a
  compile error (`HELD_WRITE`): it would be held until the work ends (AC-1),
  so a later write in the body hides it and otherwise it lands late, and
  nothing in the text says so. The fix names what the write is for:
  ephemeral state that shows while the work runs ("saving", a spinner, a
  pending row) is a guess, `optimistic x := v` on a source with a question
  (ST-5c; often a constant one, `source status = ""`); a reset that lands
  now and stays (clear an error, clear an input, close a menu) is
  `onFlush(() => { x := v })` (02 EF-8). A write meant to be held — a
  transition: `action go() { id := 2; await prefetch() }` (S-solid-20) — is
  written in a declared action, which this check does not cover: `action`
  is the author saying "hold it". Guesses and `affects` are not plain writes
  (S-infer-2). The check is the language's, not Solid's (Solid cannot see a
  body): it adds nothing at run time.
- **AC-1d (Stale own read).** [ruled 2026-10-28] In any imperative run — a
  handler, an apply block, an action body, declared or inferred — reading a
  source that the same change has already written, on some path before the
  read, is a compile error (`STALE_OWN_READ`). The read gets the committed
  value, not the write (02 W-4, 05 H-10, SC-2). Solid agrees: in 2.0.0-rc.19
  an `action()` that writes a signal, yields, and reads it again gets the
  old value until the action commits. "The same change" is the whole body
  for an action (AC-1) and the stretch up to the next `await` for a plain
  run, where the `await` ends the change (07 §5). Keys count: after
  `x.a := v`, reading `x.a` or `x` is stale and reading `x.b` is not. A
  guess is a write the run does not see either (H-10). A functional write
  (`x := v => …`, W-6) reads nothing now; a closure's body runs later,
  except a local closure the run calls, whose reads are the run's;
  `pending?` and `latest` are probes, not snapshots. Every other read is
  the committed snapshot it always was, with no error. The fix is the local
  the value came from (`let n = seq + 1; seq := n; … n`) or a functional
  write (S-infer-5).
- **AC-1e (Stale write-back).** [taken by default 2026-10-28] In any
  imperative run, a plain value write `x := e` after an `await`, where `e`
  is computed from a read of `x` taken before that `await` — directly, or
  through locals bound from it — is a compile error (`STALE_WRITE_BACK`).
  The read is `x` as the run started; whatever changed `x` while the run
  waited (another action, a reload, a click) is erased by the write: a
  lost update. Keys count as in AC-1d: a read of `x.a` or `x` and a write
  of `x.a` or `x` overlap; a read of `x.b` and a write of `x.a` do not; an
  index computed from `x` (`let i = indexOf(x, …); … x[i].f := v`) is not
  the written value and does not count. The fix is the functional write
  (`x := v => …`, W-6), which applies to `x` as it stands at the write, or
  a guess (`optimistic`, AC-3) that the answer replaces. A guess or a write
  before the `await` is the change's own and is not checked; nor is an
  awaited answer (`let r = await …`), which is the server's, not a
  snapshot of `x`. The check is the language's (Solid cannot see the read,
  the suspension and the write in one body): it adds nothing at run time.
  Found by the AI eval's round 4 (eval/results/change-2026-10-28): 2 of
  its 3 .rx defects, and a latent one in a run that passed every test; on
  all 76 eval .rx apps and the repository's examples it fires on those 3
  runs only (S-infer-6).
- **AC-2 (Not special).** An action is only a way to tie writes to async
  work; the hold is the thing (H-2). `refresh`, `affects` and probes behave
  the same inside and outside one.
- **AC-3 (optimistic).** `optimistic x := e`, legal only inside an action
  body, declared or inferred (AC-1b); in an `effect`'s apply block, which
  is never an action, it is `OPTIMISTIC_OUTSIDE_HOLD`, and only on a source with a
  question (ST-5; `OPTIMISTIC_NO_QUESTION`): writes a guess that is the
  graph's and the screen's value for `x` from the instant's settle,
  display-ahead and verdict-inert, until the hold it was made over commits
  or `x`'s own answer differs — the full rule is H-11. `x`'s truth is
  whatever its question gives: a constant (`source draft = "Ann"`), another
  source (`source draft = name`, S-solid-32), or an `await`. Lowers to
  `createOptimistic`/`createOptimisticStore` by usage. Path targets
  (`optimistic x.a := v`, `optimistic todos[i].done := true`) guess per key,
  as Solid's per-node override: the rest of `x` is the truth beneath the
  guess, a new answer corrects only where it differs at a guessed key, and
  equal there it confirms silently (S-store-6). A question re-asked by an
  action that guessed (`refresh x`) is authoritative work in flight: the
  change waits for that answer before the body-end correction (D-34) — for
  a guess on `x` itself, and for a guess on another source whose truth may
  follow `x` (S-app-todos: an add guessed in its own list stays until the
  re-asked server list brings the row; a declined toggle's revert and its
  recorded failure land with that list, in one frame). Solid does the same:
  the action's transition holds until the refresh it started lands.
  Lowers to `createOptimisticStore(fn, seed)`; a plain write to a source
  that is also guessed by path is not lowered yet. A guess is verdict-inert: an
  action that wants `pending? x` true while its guess stands declares
  `affects x` (AC-5; the idiom is in 07 §5).
- **AC-4 (refresh).** `refresh x`, in imperative scope anywhere, re-asks
  `x`'s question (ST-5) or re-runs an `await` equation for the same inputs:
  quiet — `pending? x` stays `false`, `x` keeps showing its last answer
  while the re-ask is up, and the fresh value reveals silently
  (S-solid-26 instants 4–5, S-solid-37). On a question source it drops a
  write's override (S-store-4). Issued inside an open change, the landing is
  staged into that change and reveals at its commit, still quiet (Solid
  D-31; S-solid-26 instant 7). Any other target is `INVALID_REFRESH_TARGET`.
  An awaited `refresh x` resolves when the re-ask lands (not in `ref/`).
- **AC-5 (affects).** `affects x`, in imperative scope anywhere, declares
  that work now in flight will change `x`: `pending? x` is `true` until
  the change it was declared in commits (S-solid-26 instants 6–8). In an
  arrow it makes the arrow an action (AC-1b), since only an action's change
  lasts across the work (S-infer-4); in an apply block it lasts one instant.
- **AC-7 (try/catch).** [ruled 2026-10-23] Actions are imperative code,
  so they fail the way imperative code does: `try { … } catch (e) { … }
  finally { … }` and `throw e` are statements of imperative scope. A
  rejected `await` throws at the `await`; a `catch` inside the body runs
  **inside the action** — the same change, still open — so its writes land
  with the body's end in one frame (S-action-1: the reverted guess and
  `status := "failed: …"` commit together). `finally` runs on the way out
  either way. An uncaught throw or rejection is the action's rejection
  (AC-1, DV-2) — and since R-f-6 (ruled 2026-10-23) a compile error for any
  failure the body can produce: an action catches what it can fail with,
  and only a panic reaches DV-2. `catch (e: A | B)` takes those classes and
  rethrows the rest; a snapshot of a failing value throws at the read
  (R-f-7). In a plain handler the same statements work with no hold
  involved and no check. Solid: a generator action's `try` around `yield` —
  the rejection is thrown back at the yield point.
- **AC-6 (until).** [executable 2026-10-25] `await until(() => p)` in
  imperative scope waits until the predicate `p` settles truthy and gives
  that value. It is a function of the language, not syntax — Solid's
  `until` — and is called from imperative scope (in reactive scope,
  `IO_IN_REACTIVE`); its argument is a predicate, `() => e`
  (`UNTIL_PREDICATE`), whose body is reactive scope: it reads, tracked, and
  does not write. `p` reads the **authoritative view**: guesses (AC-3), and
  whatever is derived from them, are invisible, so a guess never satisfies
  the wait for its own confirmation; staged truth reads normally. Pending
  is "not yet". When `p` fails, `until` rejects with that failure, so
  `await until(…)` fails with what its predicate can fail with (R-f-6 —
  a predicate that cannot fail needs no `try`). The write or landing that
  flips `p` joins the awaiting action's change and reveals with it (Solid
  D-31): the action resumes in that instant (S-action-2). Not yet: Solid's
  `{ timeout, signal }` options.

---

## Diagnostics this document makes unwritable or static

| code                            | bin | rule                                             |
| ------------------------------- | --- | ------------------------------------------------ |
| `ASYNC_STORE_SETTER`            | U   | ST-3b: a draft block has no `await` statement    |
| `IMMUTABLE_UPDATE_IN_STORE`     | U   | ST-3: a structured equation is a delta over `pre`|
| `UNSTABLE_LIST_IDENTITY`        | S   | ST-4b                                            |
| `ACTION_CALLED_IN_OWNED_SCOPE`  | U   | AC-1: an action is `io` (IO-2)                   |
| `INVALID_REFRESH_TARGET`        | S   | AC-4: not a source with a question / await eq    |
| `INVALID_AFFECTS_TARGET`        | S   | AC-5                                             |
| `OPTIMISTIC_OUTSIDE_HOLD` (new) | S   | AC-3: an apply block (never an action, AC-1b)    |
| `HELD_WRITE` (new)              | S   | AC-1c: an early write in an inferred action      |
| `STALE_OWN_READ` (new)          | S   | AC-1d: a read of the change's own write          |
| `STALE_WRITE_BACK` (new)        | S   | AC-1e: a pre-`await` read written back after it  |
| `OPTIMISTIC_NO_QUESTION` (new)  | S   | AC-3 / ST-5c                                     |

## Scenarios

- `S-store-1`: path writes notify per key; a root write compares per path (ST-2). ✓
- `S-store-2`: draft delta keeps identity (ST-3). ✓
- `S-store-3`: keyed reconcile; rows keep identity across a new result (ST-4). ✓
- `S-store-4`: `source x = e` derived until written; refresh is quiet (ST-5, AC-4). ✓
- `S-store-5`: stream of answers, restart on input change (ST-6). ✓
- Solid ports: S-8 (+ rejection variant), S-9 (inverted: no escape), S-15,
  S-20 (+ the race the fallback won), S-26 rows 4–7 (+ verdict-inert guess),
  S-32 (+ two rejected variants), S-33, S-34, S-35 (+ derived flight), S-37
  (+ per-key variant). ✓
