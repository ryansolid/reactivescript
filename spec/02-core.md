# 02 — Core: the synchronous calculus

**Status: DRAFT.** The fragment with no async, no holds, no structured values,
no regions beyond "a program is one region." It is the part that rests on
proven ground (Lustre's equations and `pre`; Adapton's demand-driven
consistency) and it must be closed — rules fixed, `ref/` passing
`scenarios/S-core-*` — before `05-holds.md` opens.

Everything later in the spec is an extension of this document. Nothing later
may contradict a rule here; a case that seems to need that is a proposed change
to this file, raised as a scenario.

---

## 1. Abstract syntax

Concrete syntax is `07-surface.md`, decided last. All examples in `spec/` and
`scenarios/` use this form.

```
Program   ::= RBlock                          -- the program is a reactive block

RBlock    ::= Decl* Markup*                   -- declarations, then the block's view (V-5); no keyword
                                              -- (markup begins at '<', '{', 'if', 'for'; a declaration at a keyword or 'x =')

Decl      ::= source x := Expr                -- V-1; ':=' assigns now — a snapshot (E-4)
            | x = Expr                        -- V-2, equation
            | effect (Expr*) Block            -- V-3; compute exprs ‖ apply block
            | deferred x = Expr               -- V-16; declared lag (05 H-1)
            | fn f (Param*) => Expr           -- pure function (E-9)
            | fn f (Param*) { Decl* ; Expr }  -- function with a body: decls then a value
            | component C (props) RBlock      -- RG-4: a function from props to a region with a view
            | error C (x*) [=> Expr]          -- R-f-1: an error class; the expression is its message
Param     ::= x | ref x                       -- E-9: value or ref parameter

Expr      ::= lit | x | op(Expr*) | f(Expr*)  -- pure
            | pre x | pre x -> Expr            -- x's value before its last change; with initial (C-2, C-2a)
            | peek Expr                       -- snapshot read (V-11)
            | Expr ? Expr : Expr
            | Expr . field | Expr [ Expr ]    -- projections (full treatment: 06-stores)
            | fn (x*) => Expr                 -- pure function value
            | { Decl* ; Expr }                -- reactive block: local declarations, then value
            | throw Expr                      -- R-f-3: the value is the error (E-12)
            | Expr catch (x [: C|…]) => Expr  -- R-f-4: a failure of those classes becomes a value

Markup    ::= Element | Control                  -- at block level, control forms are bare
Element   ::= <tag attr={Expr}*> (Element | text | {Expr} | {Control})* </tag>
            | <C attr={Expr}*> Markup* </C>      -- RG-4a: component application (C capitalised)
Control   ::= if Expr RBlock else RBlock         -- each branch is a reactive block (region)
            | for x in Expr RBlock               -- each row is a reactive block; keyed form: 06-stores
            | loading [on(Expr)] fallback { Markup* } RBlock    -- 05 H-5/H-6
            | errored fallback [(x [: C|…])] { Markup* } RBlock   -- 05 H-12; typed: R-f-4
                                              -- inside an element, text is literal: control forms are braced,
                                              -- `{if c { … }}`, the way JSX braces `{cond && …}` (found by ref/: S-hold-1)

Block     ::= Stmt*                            -- imperative scope (SC-2)
Stmt      ::= x := Expr                        -- write to a source
            | let y = Expr | y := Expr         -- imperative locals
            | Expr                             -- call for effect
            | if Expr Block else Block | while Expr Block
            | try Block catch (x [: C|…]) Block finally Block | throw Expr   -- AC-7, R-f-6: imperative failure
            | fn-decl, return, …               -- ordinary JS statements
```

Function application `f(e…)` covers both language functions and FFI imports;
`04-rows.md` separates them. In core, every function is pure.

## 2. Scopes (summary of 01-scopes)

- **SC-1 Reactive scope.** Program top level, equation initializers, reactive
  blocks, compute expressions of effects, and views. Contains declarations and
  expressions only. Has no statement position.
- **SC-2 Imperative scope.** Apply blocks and event handlers. Ordinary JS
  statements. Writes are legal only here. Every read of a reactive value here
  is a snapshot of the committed state; no `peek` is needed or allowed.
- **SC-3 Lexical inheritance.** A closure created in a scope is in that scope.
  A `fn` value created in reactive scope is a pure function; a closure created
  in an apply block or handler is imperative and may write.
- **SC-4 Handler positions.** An event attribute in a view (`on*={…}`) takes an
  imperative function. An arrow literal written there is imperative scope
  regardless of the enclosing view; a named function there must be `io` or
  pure. The event is the function's parameter. An arrow there, as anywhere
  in imperative scope, is a plain run or an action by its body (06 AC-1b).

---

## 3. Static rules

### E — Equations

- **E-1 (Equation rule).** In reactive scope, `x = e` declares `x` as the
  equation `e` over its free reactive variables. `x` has no statement position
  and is never a write target.
- **E-2 (Lifting).** Every expression in reactive scope denotes an equation. A
  constant is an equation with no inputs. `op(e₁…eₙ)` and `f(e₁…eₙ)` for pure
  `f` are equations whose inputs are the union of their arguments' inputs.
- **E-3 (Demand).** An equation's body is evaluated only when a reader, an
  effect's compute half, or another demanded equation reaches it in the current
  instant. Unreached equations have no observable cost or effect.
- **E-4 (Initializer is an assignment).** A source is declared with `:=`:
  `source x := e` assigns `x` the value of `e` once, in the instant the
  declaration is reached, and `e`'s inputs do not become inputs of `x`. The
  operator carries the meaning: `=` is always an equation (holds for all
  time), `:=` is always "assign the current value now" — once in a
  declaration, on every execution in imperative scope. There is no implicit
  snapshot anywhere; the other explicit one is `peek`. `source x = e` is
  a source with a standing question (06-stores ST-5).
  **Ruled 2026-10-23 (DV-6):** an initializer that reads a reactive value
  is a compile error (`SNAPSHOT_INITIALIZER`, bin S) unless the snapshot is
  written as one: `source email := peek(form.email)`. The text then shows
  what happens — `peek` is the snapshot read (E-5) — and an edit buffer
  seeded from the form is written exactly that way (examples/ai/wizard.rx).
  A reactive argument to a value parameter is the same shape at a call
  (E-10).
- **E-5 (peek).** `peek e`, in reactive scope only, evaluates `e` against the
  values of the pass it runs in and contributes no inputs to the enclosing
  equation. A region instantiated by a change sees that change's answers:
  a component mounted by the frame in which its data lands seeds from that
  data (`source draft := peek(props.initial.name)`). (Refined 2026-10-24,
  found by S-ai2-settings: the first text said "the committed state", which
  seeded the draft from the failure the change was replacing; Solid's
  `untrack` reads the current values, and so does `ref/` now. Imperative
  reads still see σ, H-10.) It has
  no meaning in imperative scope, where every read is already a snapshot
  (SC-2). `peek e` of an equation nothing demands evaluates it from scratch
  (P-3) without making it part of the frame: it stays undemanded for E-8/P-6.
  (Solid: `untrack` on a lazy memo.)
- **E-6 (Equality cuts).** An equation whose re-evaluation yields a value equal
  to its previous value has not changed: it is not part of the instant's cone
  from that point on, its dependents are not re-evaluated through it, and
  effects over it do not run. Equality for atomic values is `Object.is`.
  Equality for structured values is per path (06-stores); there is no
  per-equation override. "Notify even if unchanged" is not a thing an
  equation can ask for — a re-ask is quiet (V-9, H-9).
- **E-7 (Equations are a system).** Within a reactive block the order of
  equation declarations is irrelevant; an equation may be used before the line
  that declares it. Only sources (their initializers, E-4) and effects (EF)
  keep declaration order. Each name is declared once. C-1 rejects cycles.
- **E-8 (Undemanded equations retain nothing).** An equation not demanded in
  an instant has no value in that frame: no cached value for E-6 and no `pre`
  (P-6). When next demanded it is evaluated from scratch and counts as changed.
  Its *region* (03) is unaffected; this is about state, not lifetime.
- **E-9 (Parameters: value or ref).** A `fn` parameter is a *value* parameter
  by default; `ref x` declares a *ref* parameter, which denotes an equation
  inside the body. A call with only value parameters is **lifted** (E-2): it
  is an equation over its arguments' inputs and re-evaluates with them. A call
  to a function with any `ref` parameter, or whose body declares a source,
  effect, or region, is an **instantiation** (03 RG-6): it happens once at the
  call site. In an instantiation, value arguments are snapshots (E-4) and ref
  arguments are passed as equations.
- **E-11 (Lazy conditional).** In `c ? a : b` as an expression, only
  the selected arm is demanded; the equation's inputs are `c`'s plus the
  selected arm's, and change as `c` changes. The unselected arm is neither
  evaluated nor an input.
- **E-12 (Errors are values).** An equation whose evaluation throws has an
  *error value* in the frame. An equation or reader reaching an errored input
  is errored. There is no `try` statement in reactive scope: an error becomes
  a value through `e catch (x: C) => alt`, or fallback content at an
  `errored` boundary (03 RG-5, 05); which classes may reach a reader is its
  `fails` row, and every one must be discharged (04 R-f). (Solid F-12.) An
  error in an apply block is imperative and ordinary.
- **E-10 (Snapshot arguments).** At an instantiation, a value parameter
  receives a snapshot. Passing a *reactive* expression to a value parameter
  is therefore a silent loss of reactivity and is a diagnostic at the call
  site (`SNAPSHOT_ARGUMENT`, bin S) — not an error, because "options read
  once" is legitimate. The check lives at the call site because that is where
  both facts are known: the parameter's kind and the argument's reactivity.
  (First drafted as a rejection inside the function body; `ref/` S-region-6
  showed that rejects `counter(n, 10)`, the legitimate case.)

### W — Writes

- **W-1 (Write position).** `x := e` as a statement is legal only in
  imperative scope (SC-2) and only when `x` is a source (V-1); as a
  declaration (`source x := e`) it is the initializer (E-4). An equation, a `peek`, a function
  parameter, or an imperative local written with `:=` is a plain local, not a
  source.
- **W-2 (No writes in reactive scope).** Reactive scope has no statement
  position; a bare `x := e` there (without `source`) is a parse error, not a
  semantic one.
- **W-3 (Instant).** All writes performed by one imperative run — one handler
  invocation, one apply block, one resumed continuation — form one instant
  (V-6). An action's body, declared or inferred (06 AC-1b), is one change
  across its continuations (AC-1). There is no API to split or merge instants from inside a run:
  `onFlush` (EF-8) does not split one, it schedules another run. A
  run whose writes all equal their slots' values (E-6) changes nothing and
  opens no instant (ruled with DV-5, 2026-10-23: the earlier "an equal
  write still opens an instant" existed only for the frame-indexed `pre`).
- **W-4 (Visibility).** A write is not visible to any read, in any scope, until
  its instant commits. Within the run that wrote it, `x` still reads the
  committed value. (Restates Solid F-10 for the synchronous case.) So a
  read of a source the run's own change has written is a compile error
  (`STALE_OWN_READ`, 06 AC-1d): it could only mean the write.
- **W-5 (Writer scope).** A source is written only through its own name, by
  imperative code in its declaring region or a region nested in it. Props,
  parameters, contexts and imports are read-only; the owner passes an action
  to let other code write. (Full rule: 03-regions O-4, ruled 2026-10-31.)
- **W-6 (Functional writes).** [ruled 2026-10-22] `x := f`, with `f` a
  function, writes the result of applying `f` to the slot *as it stands at
  the instant* — after the writes before it in the same instant — rather
  than to σ. Writes to one slot from several imperative runs in one
  instant therefore compose in run order; value writes still replace. A
  path target applies `f` to the path's value. Solid: the setter's updater
  form, `setX(f)`. (Found by S-region-7: two fields registering with their
  form in the same instant each read σ and the second value write erased
  the first.)

### IO — Effectful functions

- **IO-1 (One-way taint).** `io` is a row the compiler infers: a function
  is `io` iff its body writes a source, calls an `io` function, or calls a
  value whose type carries `io`. Taint only rises. `fn` is pure by
  definition (an `io` body in a `fn` is a compile error); `action` is `io`.
- **IO-2 (Call position).** An `io` value may be called only in imperative
  scope. Calling one in reactive scope is a compile error (the write rule,
  W-1, cannot be bypassed through a call). Carrying it is not calling it.
- **IO-3 (FFI).** Every JS import is `io`. `import pure { f }` is the one
  assertion that lowers taint; it is the trust boundary and is unchecked
  for JS. There is no `io` keyword. (Full rules: 04-rows R-io-1..4.)

(The other rows — `pending`, `lane` — and inference: 04-rows.)

### C — Causality

- **C-1 (No instantaneous cycle).** The input relation over equations, taken
  within one instant, must be acyclic. A program with a cycle `x → … → x` not
  broken by `pre` is rejected.
- **C-2 (pre).** [ruled 2026-10-23, DV-5: Solid's] `pre x` denotes the value
  `x` had **before its most recent change** — not in the previous frame.
  An unrelated write, equal or not, does not move it; it moves in the same
  instant as the change it precedes (S-core-1 instant 1: `2 prev 0`). Before
  `x`'s first change it is `undefined`. Two cases:
  - inside `x`'s own equation, `pre x` is `x`'s current value — the one this
    recompute replaces (Solid: the memo's `prev` argument). It contributes
    no dependency, which is how a cycle is broken (C-1).
  - of another node `y`, `pre y` is an **input of `y`**: it demands `y`
    (so `y` stays evaluated while something reads `pre y`, S-core-1
    variant instant 5: `prev 14`) and it is an instantaneous edge — `a =
    pre b; b = a + 1` is a cycle (C-1). Lowering: a companion memo carrying
    (current, previous).
  (The first draft, frame-indexed `pre`, moved on unrelated instants —
  S-core-1's old `prev 2` at an equal write — and could not be lowered
  without a frame clock.)
- **C-2a (Initial value).** `pre x -> e` is `pre x` where that is defined and
  `e` otherwise. `pre x` has type `T | undefined`; `pre x -> e` with `e : T`
  has type `T`. This is the only way to discharge the `undefined`; there is no
  implicit default. (Solid's `(prev = v) => …` default parameter is this form
  attached to the operator instead of to the consumer's signature.)
- **C-3 (An apply does not feed its own compute).** [ruled 2026-10-23] An
  apply block whose own statements write a source that its compute half
  reads — directly or through the equations it reads — is a compile error
  (`EFFECT_WRITES_OWN_SOURCE`, bin S): it is a loop across instants that
  either never settles or settles after showing a wrong frame, and every
  converging form has a direct spelling — an equation (`clamped = …`), a
  source with a question (`source selected = …`, ST-5), or the write moved
  to the event that changed the inputs. Writes in closures the apply
  creates — a timer, a listener, its cleanup — are later events and stay
  legal (a clock, a poller); writes through a provision are not visible to
  the checker and are the runtime's. (S-check-2.)

### EF — Effects

- **EF-1 (Split).** `effect (e₁…eₙ) B`: each `eᵢ` is an equation (E-2); `B` is
  imperative scope and receives the values of `e₁…eₙ` by position as `$0…$n`
  (07 §5). Reads of reactive names inside `B` are snapshots of the committed
  state (SC-2), so the parameters are how `B` sees the values it fired for.
- **EF-2 (When).** `B` runs in an instant iff at least one `eᵢ`'s value
  differs from the value `B` last received for it, or it is the instant in
  which the effect was declared. A value that was pending and lands equal to
  the last received value is not a change (ruled 2026-10-23 with the oracle:
  Solid's effect compares values; E-8's "absent counts as changed" governs
  readers, not applies). It runs after every equation the instant reaches
  has settled (§4). An `eᵢ` that derives from a guess or a lane value
  (H-7, H-11) fires with the lane's reveal — now, not at the hold's commit —
  and again when the guess reverts (S-ai-feed instant 4; both runners).
- **EF-3 (Once, completely).** `B` runs at most once per instant and is never
  interrupted by that instant's settling; its writes begin a new instant.
- **EF-4 (No inputs).** `effect () B` runs once, in the instant the effect is
  declared, after settle — the mount hook.
- **EF-5 (Cleanup).** `B` may return a function — `return () => { … }`, or a
  closure as its last expression; both are the cleanup — and it runs before
  the next run of `B` and when the effect's region ends.
- **EF-6 (Order is unspecified).** The order in which apply blocks run within
  one instant's observe phase is not specified. A program whose behavior
  depends on it is incorrect. (`ref/` uses declaration order; scenarios must
  not rely on it.) What *is* specified: every cleanup of a region ending in
  the instant runs before any apply block of that instant (O-2), so
  `log(leave, 1); log(enter, 2)` across a step change is a legal
  expectation (S-ai-wizard).
- **EF-7 (onSettled).** [taken by default 2026-10-27] `onSettled(() => B)`,
  called in imperative scope, schedules `B` to run once, as an imperative
  run of its own, in the observe phase of the instant in which the change
  the calling run belongs to commits: the change its writes open, or the
  change that adopts them (a handler that launches an action: AC-1). A
  run whose writes open no instant (an apply block that writes nothing)
  has its callbacks run at the end of the current instant. `B` reads the
  committed state (SC-2); its writes begin the next instant (EF-3). It is
  Solid's `onSettled` in its unowned form: "schedule work to run after the
  action / transition triggered by the event has completed" (S-settled-1).
  The owned form, in a component body, is `effect () { … }` (EF-4), so in
  reactive scope `onSettled` is `IO_IN_REACTIVE`. `B` has no region, so a
  cleanup return (EF-5's shapes) is `SETTLED_CLEANUP_UNOWNED`, a compile
  error (Solid: a dev-mode throw). The argument is a closure with no
  parameters (`HOOK_CALLBACK`). Like `until` (AC-6) it is a function of
  the language, not syntax: a binding named `onSettled` shadows it.
- **EF-8 (onFlush).** [taken by default 2026-10-27] `onFlush(() => B)`,
  called in imperative scope, schedules `B` to run once, as an imperative
  run of its own, right after the instant the calling run opens and the
  instants its apply blocks' writes go on to open (EF-3). It never waits
  on a hold: the callback runs even while that instant is held. Every `onFlush` callback registered in one step
  runs in call order as one instant. Its use is keeping a write out of
  another write's hold: `B`'s writes are a new change, which commits on its
  own unless it joins a hold the way any later change does (H-2, D-8; a
  write to a held slot, or a reader of both). So `onFlush(() => { open :=
  false }); page := 2` closes a menu now while the page loads (S-flush-1),
  where `open := false; page := 2` is one instant and waits for it (W-3).
  A write in `B` lands after the run's own writes; writing one slot in
  both is legal and composes in that order (W-6). In reactive scope it is
  `IO_IN_REACTIVE` (Solid: the `ON_FLUSH_IN_OWNED_SCOPE` warning); the
  argument is a closure with no parameters (`HOOK_CALLBACK`); a binding
  named `onFlush` shadows it. Solid: `onFlush` (solidjs/solid#4292); a
  no-op on the server, where no imperative run happens (10 SV-2a).

### V — Views

- **V-0 (The view is the tail).** The markup at the tail of a reactive block
  is that block's view. There is no keyword; a block with no markup has no
  readers of its own.
- **V-1 (Readers).** Each `{e}` and `attr={e}` in a view is one reader (V-4 in
  vocabulary) with equation `e`: `{a + b}` is a single reader with inputs
  `{a, b}`, not two. Holds and equality cuts are per reader.
- **V-2 (Conditional).** `if c { M₁ } else { M₂ }` in a view: `c` is an
  equation; the branch markup is a region (03-regions) that exists only while
  `c` selects it; switching ends one region and begins the other.
- **V-3 (Repetition).** `for x in e { … }`: `e` is an equation over a
  collection; each element gets its own region with `x` bound as an equation
  projecting that element. Keying and identity: 06-stores.

---

## 4. Dynamic semantics: an instant

State is a map `σ` from sources to committed values, plus for every equation
and `pre` its last evaluated value. The program starts with `σ₀` from
initializers (E-4), evaluated in declaration order, then settles and commits
instant 0, running effects per EF-2/EF-4.

An instant proceeds in three phases and no phase overlaps another:

1. **Write.** An imperative run executes. Each `x := v` is recorded; `σ` is
   unchanged (W-4). The run ends.
2. **Settle.** Let `Δ` be the set of written sources. The instant's **cone** is
   every equation and reader reachable from `Δ` through the input relation.
   Every demanded equation in the cone (E-3: demanded by a reader or an
   effect's compute half) is re-evaluated against `σ' = σ[Δ ↦ v]`, in a
   topological order of the input relation (C-1 guarantees one exists). An
   equation whose re-evaluation yields an equal value is cut (E-6): its
   dependents are not in the cone through it.
3. **Observe.** `σ := σ'`. The frame (V-17) is the value at every reader
   position. Then every effect whose compute half changed (EF-2) runs its apply
   block in declaration order; writes they make are recorded for the next
   instant, which begins when this phase ends.

### Properties (to be checked by `ref/` against scenarios, then proved)

- **P-1 Glitch-freedom.** No reader, apply block, or `peek` ever observes a
  state in which an equation disagrees with its inputs. (Follows from phases
  not overlapping and topological settle.)
- **P-2 Determinism.** Given `σ` and the multiset of writes of an instant, the
  resulting `σ'` and frame are unique, independent of evaluation order within
  the topological constraints.
- **P-3 Consistency with from-scratch.** The value of every equation after an
  instant equals what it would be if every equation were re-evaluated from
  `σ'` with no memoization. (Adapton's correctness criterion.)
- **P-4 Minimality.** Only equations in the cone are evaluated; equations whose
  value did not change cut propagation (E-6).
- **P-6 pre is evaluation-indexed.** For every node `x`, `pre x` read from
  outside `x` equals the value `x` held before its most recent change, and
  reading it demands `x`; inside `x`, it is the value being replaced.
  (Ruled 2026-10-23; the frame-indexed P-6 is withdrawn.)
- **P-5 Write isolation.** Within an imperative run, no read observes that run's
  own writes (W-4), and two runs never interleave within one instant (W-3).

---

## 5. What core excludes (and where it goes)

| Excluded                                | Document       | Why not here                                              |
| --------------------------------------- | -------------- | --------------------------------------------------------- |
| `await`, pending, `latest`, `pending?`  | 04-rows, 05-holds | Introduces the in-flight version of state (V-13)       |
| Regions other than "the program"        | 03-regions     | Needs `if`/`for` branches as scopes with lifetimes        |
| FFI, impure functions, `io` row         | 04-rows        | Needs function coloring                                   |
| Structured values, paths, draft, key    | 06-stores      | Needs identity and path-granular propagation              |
| Concrete syntax                         | 07-surface     | Decided after the semantics are closed                    |

---

## 6. Worked scenario (abstract syntax)

`scenarios/S-core-1.md` — the counter.

```
export default component App() {
  source count := 0
  source show := true
  double = op*(count, 2)
  label  = op+("prev ", pre double -> 0)
  effect (double) { log(double) }
  <p>{show ? double : "-"} {label}</p>
}
```

| instant | action                           | frame `<p>`  | effect    | notes                                           |
| ------- | -------------------------------- | ------------ | --------- | ----------------------------------------------- |
| 0       | mount                            | `0 prev 0`   | `log(0)`  | EF-4; C-2a discharges `undefined`               |
| 1       | handler `count := 1`             | `2 prev 0`   | `log(2)`  | one instant; `pre` is frame 0's `double`        |
| 2       | handler `count := 1`             | `2 prev 2`   | —         | E-6: equal value cuts; effect does not run      |
| 3       | handler `count := 5; count := 7` | `14 prev 2`  | `log(14)` | two writes, one instant (W-3)                   |
| 4       | handler `show := false`          | `- prev 14`  | —         | `double` still demanded by the effect's compute half; `pre` is frame 3 |
| 5       | handler `count := 8`             | `- prev 14`  | `log(16)` | `label` reads `pre double` = frame 4's 14       |

Variant without the effect (so `double` is undemanded while `show` is false):

| instant | action                  | frame `<p>`  | notes                                                          |
| ------- | ----------------------- | ------------ | -------------------------------------------------------------- |
| 4       | handler `show := false` | `- prev 14`  |                                                                |
| 5       | handler `count := 8`    | `- prev 0`   | P-6: `double` not in frame 4 → `pre double` undefined → `-> 0` |

Solid 2.0's lazy memo would give `prev 14` at instant 5 (last evaluation);
this spec gives `prev 0` (previous frame). Recorded as a known divergence to
confirm against the runtime in `ref/` phase 3.

Rejected programs for the same scenario:

| program fragment                  | rule | diagnostic bin (99) |
| --------------------------------- | ---- | ------------------- |
| `double := 4` in a handler        | W-1  | unwritable          |
| `count := 1` at top level         | W-2  | unwritable          |
| `a = op+(b, 1); b = op+(a, 1)`    | C-1  | static              |
| `effect (count) { count := count + 1 }` | C-3 | static (info)    |
