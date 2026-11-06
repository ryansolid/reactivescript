# 00 — Vocabulary

**Status: DRAFT.** The only words the rules use. Each noun has one form in the
language and one counterpart in Solid 2.0. Internal runtime names (transaction,
staging, `_pendingValue`, computation node) do not appear in any rule.

Where a noun is already defined by Solid's `RULES-FUNDAMENTALS.md` vocabulary,
the definition here must agree with it; the Solid term is given in brackets.

---

## V-1. Source

A named value that is **written** from imperative scope and never derived. It
is declared with `:=` — an assignment, done once (E-4) —  and, optionally, a
standing **question** (V-9) that re-derives it until it is next written.

Solid: `createSignal`, `createStore`; with a question, `createSignal(fn)`,
`createStore(fn, seed)`.

## V-2. Equation

A named value that **holds for all time**: whenever any input it reads changes,
it reflects that change in the same instant (V-6). An equation is never written.
It evaluates on demand and only when something reaches it.

Solid: `createMemo`, `createProjection`, a JSX expression, a prop getter.

## V-3. Effect

Two halves. The **compute** half is an equation (V-2). The **apply** half is a
block in imperative scope (SC-2) that runs once per instant in which the compute
half's value changed, after every equation in the instant has settled, against
the committed state (V-13). Its writes begin the next instant.

An effect is not a reader (V-4): its compute half holding a pending value does
not hold the screen.

Solid: `createEffect(compute, apply)`; an apply half with no inputs is `onSettled`
(its owned form; the form called from a handler is 02 EF-7).

## V-4. Reader [Solid: reader]

A position in a **view** (V-5) whose value is shown. Only readers hold (V-7) and
only readers reach boundaries (V-10). An equation counts only through the
readers that reach it; an effect, a snapshot read (V-11), or an unread equation
is never a reader.

Solid: a render effect.

## V-5. View

Markup at the tail of a reactive block — there is no keyword for it. The set
of readers of a program is the set of expression positions inside its views. A view inside a `for` row, an `if`
branch, or a boundary belongs to that region (V-8).

Solid: JSX output of a component; `insert`, attribute bindings.

## V-6. Instant [Solid: change, flush]

The unit of time. An instant is opened by one or more writes from one imperative
run (a handler, an apply half, a resumed `await`), settles every equation those
writes reach, and ends by committing. Several writes in one imperative run are
one instant. Nothing observes a half-settled instant.

Solid: a flush; "several writes in one synchronous tick are one change."
`onFlush` (02 EF-8) schedules a run of its own after one.

## V-7. Hold [Solid: hold]

An instant that cannot commit because a reader (V-4) it would show reads a
pending value (R-1). While held, the committed state stays on screen; when every
such value has answered, the instant commits as one frame. Holds are not
declared; `action` is the explicit form, extending a hold across awaited work.

## V-8. Region [Solid: owner]

A lexical scope that owns what is declared in it: a component body, an `if`
branch, a `for` row, a boundary's content, an effect. An equation lives in the
region that declares it and is released when the region ends. Moving a value to
a longer-lived region requires `escape` (O-3).

Solid: an owner; `onCleanup`; `runWithOwner`.

## V-9. Question, re-ask [Solid: question, re-ask]

A source's or equation's inputs are its question. An input changing asks a **new
question**; `refresh`, polling, or an action's confirming refetch **re-ask** the
same one. A re-ask is quiet (H-9): the shown value still answers.

## V-10. Boundary [Solid: boundary; armed / disarmed]

A region that can take a wait away from the instant. `loading` catches pending
readers under it while **armed** (before it has shown content, or re-armed by
`on`); once it has shown content it is **disarmed** and forwards. `errored`
catches errors. A boundary's fallback is content and belongs to the frame that
armed the boundary.

Solid: `<Loading>`, `<Errored>`.

## V-11. Snapshot

A read that does not track: the value as committed at the moment of the read.
Every read in imperative scope is a snapshot. In reactive scope a snapshot
requires `peek`, with one exception: a source's initializer is a snapshot (E-4).

Solid: `untrack`; reads inside an effect's apply half.

## V-12. Probe [Solid: display-ahead read]

`latest x` and `pending? x`: reads that show a held instant, or the verdict about
it, ahead of its commit. A probe never holds the instant it reads ahead of
(H-7). What is derived from a probe lives in a **lane** (V-14). A probe is a
read, not a kind of reader: a plain read beside it in the same pass is still a
plain read (R-11; Solid renamed "display-ahead reader" to "display-ahead read"
in #4695 for this reason).

Solid: `latest()`, `isPending()`.

## V-13. Committed, in-flight

The two versions of state. **Committed** is what readers, apply halves, and
snapshots see: always a whole instant. **In-flight** is the version an open hold
is moving toward; only probes (V-12) see it. (Core, `02-core.md`, has only the
committed version; holds, `05-holds.md`, add the second.)

## V-14. Lane [Solid: lane]

The world a probe opens: the committed screen plus what the probe shows ahead.
Equations derived from a probe belong to its lane; pending work in a lane holds
the lane, never the parent instant (H-7). A branch a probe merely gates is not
derived from it: it is a mainline mount whose plain reads are the screen's
(H-7, Solid D-25).

## V-15. Draft

The one place an equation may write: a copy of its own previous value (`pre`),
bound to a name, writable only inside the equation's body (ST-3). Writes to a
draft are the equation's delta, not an effect.

Solid: the draft passed to `createProjection` / a store setter callback.

## V-16. Declared lag [Solid: declared lag]

`deferred`: an equation whose author declares its previous answer acceptable
while the next loads. Its re-asks hold nothing; its readers keep the shown
answer until the new one lands. It may lag the screen; it never leads it (H-1).

Solid: `createDeferred`.

## V-17. Frame [Solid: screen]

The values at every reader position after an instant commits. A scenario's
oracle is a sequence of frames. "On screen" means "in the current frame."

---

## Nouns deliberately absent

- **Signal / memo / store / projection.** Collapsed into source (V-1) and
  equation (V-2); the structured-vs-atomic split is a property of the type
  (ST-1), not a different noun.
- **Transition, transaction.** Internal; the visible noun is hold (V-7).
- **Tracking scope, owner tree.** Internal; the visible nouns are scope (SC-1)
  and region (V-8).
- **Batch.** An instant (V-6) is the batch.
