# 07 — Surface

**Status: OPEN (2026-10-22).** Concrete syntax for everything 02–06 gives a
semantics to. Written last, so every form below names the rule it spells.
`ref/src/parse.ts` implements this grammar and every scenario parses under
it; `S-surface-1` exercises the parts the semantic scenarios do not (types,
imports, handlers, template literals, method calls, functional writes). Ruled so far: file = module; `source` / `=` / `:=`; imports
`io` unless `pure`; handlers are JSX attributes; `c ? a : b` only; streams
are `await*`; `errored fallback(e)`; `.rx`; the `fails` row (§9). The list
at the end records each.

Design stance: the expression language is TypeScript's, verbatim, minus the
forms the scopes forbid; the reactive forms are few and spelled with words
(`source`, `effect`, `action`, `pre`, `peek`, `latest`, `pending?`) rather
than sigils, because an AI reader keys on words. JSX elements are kept
verbatim; control flow inside markup is braced forms, not components.

---

## 1. Files and modules

A file (`.rx`) is a module. Its top level is imports, exports and
declarations. A declaration at the top level lives for the module's lifetime
(a module-level `source` is app state, as a module-level signal is in Solid).

```rx
import { fetchUser } from "./api"          // an io value: callable only in imperative scope (IO-2)
import pure { formatName } from "./format" // a lifted value function: callable anywhere (E-9)
import { Avatar } from "./Avatar.rx"       // a component; its rows come from Avatar.rx's signature (09 MO-3)

export component Profile(props: { id: number }) { … }
```

- Every JS import is `io` unless imported `pure` (R-io-4). `pure` is the
  one word in the language that lowers taint, and it is unchecked for JS;
  inside `.rx` the row is inferred and only rises: a `fn` that calls `io`
  is a compile error, an `io` call outside imperative scope is a compile
  error (R-io-1..3). `fn` is pure by definition, `action` is `io`. `pure`
  means *safe to call from reactive scope* — no writes to reactive state,
  safe to re-ask — so a data loader (`fetchUser`) is imported `pure`: it
  returns a promise the equation awaits (R-1), and re-asking it is what a
  new question does.
- `import pure { getUser, NotFound } from "./api" fails NotFound` declares
  what the import's promises reject with (R-f-8); without `fails`, `Error`.
  A declaration file `api.d.rx` beside the JS module says it once instead,
  and the import then states nothing (09 MO-8).
- **A module is declarations; a view is a component's** (ruled
  2026-10-25). The app's entry is the entry module's default component,
  `export default component App() { … }`, which the runtime mounts (MO-1c).
  Markup at a module's top level is `TOP_LEVEL_MARKUP`. So where a `source`
  is written says what it is: inside a component it is the instance's
  state; at a module's top level it is app state — instantiated once per
  app, and on the server once per request (MO-1b, SV-4), never a JS module
  variable shared across requests. Module state lives as long as the app
  and there is one of it: state for a subtree, a route or an instance
  belongs in a component, shared down through a context (RG-7).
- `export` works on `component`, `fn`, `action`, `error`, `type`, and
  module-level sources and equations (exported as accessors — a module
  boundary is a value boundary, never a write boundary: W-1 holds across
  modules). What an import binds and what is checked across the boundary
  is 09-modules.

## 2. Declarations (02 §1)

```rx
source count: number := 0              // E-4: assigned once, written only in imperative scope
source user = await fetchUser(id)      // ST-5: a source with a standing question
double = count * 2                     // E-1: an equation; holds for all time
label: string = `${user.name} (${count})`
deferred preview = await render(doc)   // H-1: declared lag
rows key id = map(items, …)            // ST-4: keyed collection
selected = draft(pre selected -> {}) { d[id] := true }   // ST-3
effect (count, user.name) { log($0, $1) }   // EF: compute half in parens, apply half in braces; `$0…$n` are the values
effect () { … }                        // EF-4: the mount hook
source messages = await* stream(room) -> []   // ST-6b + R-7: a stream with a first paint
rows key id = fetchedRows              // ST-4: a keyed collection; `source rows key id = …` is also allowed
fn area(ref w: number, h: number): number => w * h       // E-9: `ref` is an instantiation parameter
fn Counter(ref start: number) {        // RG-6: an instantiating fn — has declarations
  source n := peek(start)              // E-4: a ref parameter is reactive — the snapshot is written as one
  n
}
action save(name: string) { … }        // AC-1
component Row(props: { item: Item }) { … }   // RG-4
component Header() { … }               // no props
context theme: Theme = defaultTheme    // RG-7a: a declared context (module level); `= …` is its default
provide theme = settings.theme         // RG-7b: to everything rendered beneath
palette = (use theme).palette          // RG-7b: the nearest provision above
provide fields = { add: addField }    // O-4: a context is read beneath it; to let readers write, provide actions
error NotFound(id: number) => `no user ${id}`   // R-f-1: an error class; `NotFound(3)` constructs one
```

- Types are TypeScript's, after the name. On a source they type the value;
  on an equation, the value it holds; on `fn`/`action`/`component`
  parameters as in TS.
- `source x = e` (not `:=`) is the only place `=` declares something that
  can be written.
- `pre x -> init` is `pre x` with the value for the first instant (C-2a).
- A declaration is terminated by a newline or `;`.

## 3. Expressions (02 §1, 04)

TypeScript expression grammar verbatim, with these removals and additions.

Removed (unwritable, bin U): assignment and update operators (`=`, `+=`,
`++`, …), `delete`, `new` on reactive values, `this`, `function`
expressions, `async`/generators, `?.` on a probe. Arrow functions are
allowed and are reactive (lifted) in reactive scope, imperative in
imperative scope (SC-3).

Added:

| form | meaning | rule |
| --- | --- | --- |
| `await e` | the answer to `e`'s flight; absent until it lands | R-1 |
| `await e -> v` | the same, with `v` as the first paint | R-7 |
| `await* e`, `await* e -> v` | the latest answer of an async iterable (a stream), with a first paint | ST-6b, R-7 |
| `pre x`, `pre x -> init` | `x`'s value in the previous instant | C-2 |
| `peek(e)` | `e` read without subscribing | E-? (untrack) |
| `pending? e`, `latest e` | the verdict of the reads inside `e`; the value `e` is moving toward — both take a **unary** operand: `pending? a || b` is `(pending? a) || b`, `latest x * 2` is `(latest x) * 2` | R-9, H-9 |
| `c ? a : b` | TS's conditional, lazy: only the selected arm is an input | E-11 |
| `draft(e) { … }` | a copy of `e` written along `d` | ST-3 |
| `x => e`, `(a, b) => e`, `() => { … }` | arrow functions; a statement body only in imperative scope | SC-3 |
| `[...xs, y]`, `{ ...o, k: v }`, `{ id }` | spread, shorthand properties (computed keys `{ [k]: v }`: not yet in `ref/`) | — |
| `a ?? b` | nullish coalescing (absence propagates like `\|\|`) | R-5 |
| `` `a ${e} b` `` | template literal | — |
| `o?.k`, `xs.map(f)` | optional chaining, method calls | — |
| `===` / `!==` | accepted as `==` / `!=` | E-6 |
| `use name` | the nearest provision above (a unary form: `(use x) == y`) | RG-7 |
| `type T = …` | a TS type declaration, kept as text | — |
| `throw e` | a failure, in either scope: `x > 0 ? x : throw BadInput(x)` (TC39's throw expression) | R-f-3 |
| `e catch (x: A \| B) => alt` | `alt` when `e` fails with `A` or `B`; `catch (x) =>` takes every class; looser than `?:` | R-f-4 |

`await` may appear anywhere in an expression of reactive scope — an
equation, a reader `{…}`, an attribute or prop, an `if` condition, a `for`
collection, an effect's input, a provision; the compiler lifts each one to
its own flight (04 R-1), asked only while the conditions that reach it hold
(E-11; S-await-1). In imperative scope a run suspends only at a statement
(06 AC-1): `await e`, `let v = await e`, either followed by `catch (x: C)
=> alt`. `yield` is not an expression; a stream is `await*`.

## 4. Markup (02 §V, 03)

A reactive block is declarations, then markup. JSX elements are verbatim:
attributes are equations, children are readers, components are applied as
`<Name prop={e}>…</Name>` (RG-4).

```rx
<section class={theme}>
  <h1>{user.name}</h1>
  {if open {
    <Panel items={rows} />
  } else {
    <p>closed</p>
  }}
  {for row in rows {
    source hits := 0
    <li onClick={() => { hits := hits + 1 }}>{row.name} {hits}</li>
  }}
  {loading on(id) fallback { <Spinner/> } {
    <Details data={await fetchDetails(id)} />
  }}
  {errored fallback(e) { <p>{e.message}</p> } {
    <Risky/>
  }}
</section>
```

- `{if}`, `{for}`, `{loading}`, `{errored}`, `{portal}` are braced inside an
  element and bare at block level. `portal to(e) { … }` renders into `e`
  (RG-8). Each block is a region: declarations, then markup
  (RG-1, RG-2, RG-5). `if x { … }` narrows `x` inside (RG-1c).
- `for x in e` keys rows by identity, or by the collection's `key` (ST-4b).
- Text follows JSX: whitespace that contains a line break is not text, a
  line's leading and trailing whitespace is not text, and text that runs
  over two lines is joined by one space. Write `{" "}` where a space is
  wanted between elements. (The first parser made every run of whitespace
  between nodes a space; Solid's compiler — which lowers the views, 10 —
  rejected the text it put inside a `<tr>`, which HTML forbids, and
  S-app-users found it. 140 frames in 15 scenarios lost spaces that were
  only formatting.)
- `errored fallback(e)` binds the error value; `fallback` without a
  parameter ignores it. `fallback(e: A | B)` takes only those classes;
  others pass to the boundary above (R-f-4). `fallback(e: Panic)` takes
  only panics (R-f-10) — the root boundary that leaves every failure to the
  panes.

## 5. Imperative scope (02 SC-2, 06 AC)

Imperative scope is: an `effect`'s apply block, an `action` body, and any
arrow function written in imperative scope or as an element's event handler.

```rx
<button onClick={() => { count := count + 1 }}>+</button>

effect (count) {
  document.title = `${$0}`           // io: a plain JS statement; `$0` is `count`'s value for this run
  return () => { … }                 // the cleanup (O-2); a closure as the last expression is the same
}

action rename(n: string) {
  guess user.name := n          // AC-3: only here
  let saved = await api.rename(n)    // AC-1: a hold-safe suspension
  user := saved
}

action { refresh user; affects user }   // inline, one run (AC-1)

<button onClick={() => {             // an action without the keyword: it guesses (AC-1b)
  guess liked := true
  try { let r = await api.like(id); liked := r } catch (e) { likeError := e.message }
}}>♥</button>
```

- A write is `target := e`; `target` is a source declared in this region or
  one enclosing it, or a path into one (W-1, O-4). There is no compound
  assignment; `x := f` with `f` a function is a functional write — `f` is
  applied to the slot at the instant, so writes to one slot in one instant
  compose (W-6).
- `let` (or `const`) declares an imperative local; `if (c) { … } else { … }`,
  `return`, `try { … } catch (e) { … } finally { … }`, `throw e` and
  expression statements are allowed (`for`/`while`: not yet in `ref/`);
  reads of reactive names are snapshots of σ (H-10, SC-2), and a snapshot of
  a failing value throws (R-f-7). A rejected `await` throws at the `await`;
  a catch inside an action is still the action's change (AC-7).
  `catch (e: A | B)` takes those classes and rethrows the rest.
  `let r = await save(x) catch (e: Offline) => null` is the statement form
  of the same: a `try` around the `await` whose catch gives `r` (S-await-1).
- An action catches every failure its body can produce (R-f-6): there is
  no one after the body to catch it.
- An arrow that guesses, declares `affects`, or both writes and awaits is
  an action (06 AC-1b); an `effect`'s apply block never is. In such an
  arrow a plain write before an `await` is `HELD_WRITE` (AC-1c): make it
  `guess` if it is ephemeral state that shows while the work runs,
  `onFlush(() => { … })` if it is a reset that lands now, or declare the
  action to hold it on purpose. In every run, reading a source the run's
  own change wrote is `STALE_OWN_READ` (AC-1d): keep the value in a local.
  A plain write after an `await` computed from the same source as read
  before it is `STALE_WRITE_BACK` (AC-1e): write functionally, `x := v => …`.
- `await` in an action body suspends the run and keeps its change open; in
  a plain run it ends the change (the continuation is a new one). A plain
  run that awaits writes nothing, or it would be an action.
- A handler that launches an action and also writes (`() => { draft := "";
  send() }`) makes one change: the handler's plain writes are adopted by the
  action and held with it (AC-1). Writes that should land now go in a
  separate instant (a separate event, or `onFlush(() => { draft := "" })`:
  02 EF-8), or are guesses.
- `onSettled(() => { … })` runs a block once the change this run belongs
  to has committed (02 EF-7): `() => { save(); onSettled(() => toast("Saved")) }`.
  In a component body the same thing is `effect () { … }` (EF-4).
- The optimistic-action idiom, with a spinner:

  ```rx
  action placeOrder() {
    let items = cart              // a snapshot of what is being ordered
    guess cart := []         // the guess shows now (AC-3)
    affects cart                  // `pending? cart` is true until the body ends (AC-5) — the guess alone is verdict-inert
    try {
      let receipt = await checkout(items)
      cart := []                  // the truth; equal confirms silently
    } catch (e) {
      orderError := e.message     // AC-7: lands with the reverted guess, one frame
    }
  }
  ```

  A plain write placed *before* the `await` commits whatever the body does
  next (AC-1, DV-2): only the guess reverts. Put the truth after the
  `await`, inside the `try`, and report failure from the `catch` (AC-7,
  R-f-6). An optimistic write over a *structured* question source is a
  root write (functional or whole); path targets are not in `ref/` yet.
- `refresh x`, `affects x`, `guess x := e` are statements (AC-3..5).

## 6. Components (RG-4)

```rx
component Card(props: { title: string; children: View }) {
  source open := false
  <div class="card" onClick={() => { open := !open }}>
    <h2>{props.title}</h2>
    {if open { props.children }}
  </div>
}
```

- `props` is a structured value; reading `props.x` tracks the caller's
  equation for `x`. `props.children` is a `View`, shown by reading it.
- A component is applied only in markup. It returns nothing.

## 6b. Scoped styles (ruled 2026-10-24: per component, as TSRX)

```rx
component Card(props) {
  source open := false
  <style>
    .card { border: 1px solid }
    h2 { margin: 0 }
    .card :global(.icon) { opacity: 1 }
  </style>
  <div class="card">
    <h2>{props.title}</h2>
    {if open { <p class="body">{props.children}</p> }}
  </div>
}
```

- **CSS-1 (Where).** A `<style>` is written at the top level of a
  component's view, or of the program's: one per view. Its content is CSS,
  read as raw text — a stylesheet is static, and the grammar has no place
  for an expression in it (bin U). A `<style>` anywhere else (inside an
  element, a branch, a `for` body, a `loading` or `errored` region), or a
  second one, is `STYLE_PLACEMENT` (bin S). TSRX takes a stylesheet
  anywhere in its owner, refuses a second, and silently drops one in an
  `@for` body or an `@pending` branch; here, where it is written is what
  it scopes. A `<style>` takes no attributes.
- **CSS-2 (What it scopes).** Every HTML element of the view — through
  `if`, `for`, `loading` and `errored`, bodies and fallbacks alike, and the
  children the view passes to a component — carries the view's scope class.
  A component's body is its own view, with its own stylesheet or none.
  Children belong to the view that wrote them, wherever the component
  places them.
- **CSS-3 (The stylesheet).** TSRX's engine, unchanged (`tsrx::style` in
  Solid's compiler; 11 CP-1d): selectors are scoped to the class
  (`tsrx-` and eight hex digits of the module, the style's position and its
  text), `:global(…)` leaves a selector or part of one unscoped, a selector
  no element of the view can match is pruned, `@keyframes` names are local.
  A region is matched conservatively, as TSRX matches its control flow.
- **CSS-4 (Output).** The `<style>` is removed from the view; the module's
  stylesheet is returned beside its JavaScript, for the bundler to emit.
  Nothing is inserted at run time on either side, so the served page and
  the hydrated page use one stylesheet and the same classes (SV-7).
- **CSS-5 (A class map is a value).** [2026-10-25] `styles = <style>…</style>`
  — a `<style>` in expression position — is TSRX's style expression: a
  constant record from each standalone class of the stylesheet (a
  top-level rule whose selectors are each one class, `.a` or `.a, .b`) to
  that class with the stylesheet's own scope class, `"tsrx-… a"`. Its
  rules are scoped to that class; any other rule is pruned, as TSRX does.
  It is how a view styles an element it does not own: scoping stops at a
  component, so the parent passes `class={styles.a}` to the child, which
  puts it on its element. It is a constant, so it may be declared at a
  module's top level, and its type is its classes (`{ readonly a: string }`:
  a misspelt class is a type error, TY). TSRX's other form,
  `<style ref={styles}>`, assigns the view's class map into a variable;
  a name here is bound once, by its declaration, so it is not adopted
  (a parse error naming CSS-5). A view that wants both writes its own
  `<style>` and a class map beside it.

Executable: S-surface-2, S-surface-3 (the compiled runner checks the
stylesheet).

## 7. Worked ports

S-solid-8:

```rx
export default component App() {
  source x := 0
  action save() { try { x := 1; await api.save() } catch {} }   // R-f-6: a failed save ends the body; `x` commits (DV-2)
  <div>
    <p>{x}</p> <p>latest {latest x}</p>
    <p>{pending? x ? "saving" : "idle"}</p>
    <button onClick={() => { save() }}>save</button>
  </div>
}
```

S-solid-26 (rows 4–7):

```rx
export default component App() {
  source id := 1
  user = await fetchUser(id)
  action reload() { try { affects user; refresh user; await gate() } catch {} }

  errored fallback(e) { <p>{e.message}</p> } {      // R-f-5: `fetchUser` can reject
    {loading fallback { <p>…</p> } {
      <p>{user.name}</p> <p>{pending? user ? "updating" : ""}</p>
    }}
  }
}
```

S-store-3:

```rx
export default component App() {
  source rows := [{ id: 1, name: "a" }, { id: 2, name: "b" }]
  view key id = map(rows, r => ({ id: r.id, name: r.name + "!" }))

  {for r in view {
    effect (r.name) { log(r.id, $0) }
    <p>{r.name}</p>
  }}
}
```

## 8. Failures (04 R-f)

```rx
import pure { fetchUser } from "./api"           // its promises reject with `Error` (R-f-8)
error BadId(id: number) => `bad id ${id}`
error NotFound(id: number) => `no user ${id}`

source id := 1
user = id > 0 ? await fetchUser(id) : throw BadId(id)   // fails(Error | BadId)
name = user == null ? throw NotFound(id) : user.name     // fails(Error | BadId | NotFound)

errored fallback(e) { <p>down: {e.message}</p> } {       // the rest: Error
  {errored fallback(e: BadId) { <p>{e.message}</p> } {   // BadId only; others pass up
    <p>{name catch (e: NotFound) => "(nobody)"}</p>      // NotFound becomes a value
  }}
}

action rename(n: string) {
  try { await saveUser(id, n) }
  catch (e) { saveError := e.message }                    // R-f-6: required — nothing after the body could catch
}
```

Remove any of the three discharges and the program is refused
(`UNHANDLED_FAILURE`); drop the action's `catch` and it is refused
(`UNCAUGHT_ACTION_FAILURE`). A JS function that throws synchronously is a
panic: not tracked, still caught at run time (R-f-3).

## 9. Grammar sketch

```
Module    ::= Import* Decl*                                          -- no markup: a view is a component's (MO-1c)
Import    ::= "import" "pure"? ("{" (Name ("as" Name)?),* "}" | Name) "from" String ("fails" Classes)?
Classes   ::= Name ("|" Name)*                                       -- error classes (R-f-1); `Error` is every class
Decl      ::= "export"? Decl' | "export" "default" Component        -- the entry's default component is the mounted view
Decl'     ::= "source" Name Type? ("key" Name)? (":=" | "=") Expr
            | ("type" | "interface") Name …                        -- kept as text
            | "context" Name (":" "source"? Type)? ("=" Expr)?            -- RG-7a; `source`: SOURCE_CONTEXT (RG-7c withdrawn)
            | "provide" Name "=" Expr                                  -- Name: a context
            | "deferred"? Name Type? ("key" Name)? "=" Expr
            | "effect" "(" (Expr ("," Expr)*)? ")" Block           -- no inputs: EF-4
            | "fn" Name "(" Params ")" Type? ("=>" Expr | "{" Decl* Expr "}")
            | "action" Name "(" Params ")" Block
            | "component" Name "(" Name Type? ")" "{" RBlock "}"
            | "error" Name ("(" Params ")")? ("=>" Expr)?                -- R-f-1
RBlock    ::= Decl* Markup*
Markup    ::= JSXElement | "{" Expr "}" | Control
Control   ::= "if" Expr "{" RBlock "}" ("else" "{" RBlock "}")?
            | "for" Name "in" Expr "{" RBlock "}"
            | "loading" ("on" "(" Expr ")")? "fallback" "{" RBlock "}" "{" RBlock "}"
            | "errored" "fallback" ("(" Name (":" Classes)? ")")? "{" RBlock "}" "{" RBlock "}"
Block     ::= "{" Stmt* "}"
Stmt      ::= Target ":=" Expr | "guess" Target ":=" Expr      -- Target `use` Name Path: WRITE_TO_NON_SOURCE (O-4)
            | "refresh" Name | "affects" Name | "action" Block
            | ("let" | "const") Name Type? "=" Expr
            | "if" "(" Expr ")" (Block | Stmt) ("else" (Block | Stmt))?
            | "try" Block ("catch" ("(" Name (":" Classes)? ")")? Block)? ("finally" Block)?
            | "throw" Expr | "return" Expr? | Expr
Expr      ::= TSExpr with §3's removals and additions
            | "throw" Unary | Expr "catch" ("(" Name (":" Classes)? ")")? "=>" Expr   -- R-f-3/4; catch is the loosest form
```

---

## Decisions (all ruled; the last open ones 2026-10-26)

1. **File = module** (ruled 2026-10-22), components declared with
   `component`, exported with `export`.
2. **`source` / `=` / `:=`** kept over `let`/`const` (ruled 2026-10-22):
   `let`/`const` would still need `=` beside `:=`, because a derived `let`
   (`source x = e`, ST-5) exists — so the keywords would not carry the
   distinction and the operators would anyway. `source` names the one kind
   of binding that can be written; `=` vs `:=` says whether it starts from
   a question or a value.
3. **TS expression grammar verbatim**, with the removal list in §3. No
   `yield`; streams are `await*` (ruled 2026-10-22).
4. **`c ? a : b` is the one conditional expression** (ruled 2026-10-26;
   E-11): `if` is a markup region and a statement, never an expression.
5. **Imports are `io` unless `import pure`** (ruled 2026-10-22; R-io-4).
   `pure` is the only taint keyword and points one way.
6. **Event handlers are JSX attributes** (`onClick={() => { … }}`), the
   arrow being imperative scope (ruled 2026-10-22). No `on:click` form.
7. **`errored fallback(e)`** binds the error; `loading on(e)` (ruled
   2026-10-22).
8. **File extension `.rx`** (ruled 2026-10-22; `.rsx` is also free, `.rxs`
   is ooRexx's).
9. **DV-2** ruled 2026-10-22: a failed action's held writes commit; only
   its optimistic state reverts (AC-1). Since R-f-6, only a panic reaches it.
10. **The `fails` row** (ruled 2026-10-23): an undischarged failure at a
    reader is a compile error; an action must catch in its body; a JS
    promise fails with `Error`, narrowable at the import (`fails A | B`).
11. **`throw`, not `raise`** (ruled 2026-10-26): one word for a failure in
    both scopes — TS's statement, and TC39's throw expression in reactive
    scope. The class is read off the operand (R-f-3).
12. **`e catch (x: A | B) => alt`** (ruled 2026-10-26): a failure becomes a value without a region. Looser than every
    operator, so `c ? a : b catch …` catches the conditional.
13. **Contexts are declared** (ruled 2026-10-23): `context x: T [= d]`;
    `provide`/`use` name the declaration (RG-7). Keyword `context`, and
    defaults, ruled 2026-10-26. (`source` contexts withdrawn 2026-10-31, O-4.)

14. **One `catch` per `try`** (ruled 2026-10-25): TypeScript's statement
    form; a typed `catch (e: A)` rethrows other classes (AC-7), and two
    kinds of failure handled differently nest two `try`s (examples/notes).
15. **The entry is `export default component App`** (ruled 2026-10-25):
    no markup at a module's top level. Module-level state stays, as app
    state (MO-1b, SV-4); weighed against components-only state, which would
    force a provider component for every shared store and buys no SSR
    safety, since a module is already instantiated per request.
16. **In imperative scope, `await` is a statement** (taken by default
    2026-10-26, veto here): `await e` or `let v = await e`, either with a
    `catch (x: C) => alt` (06 AC-1, which already said a run suspends only
    there); elsewhere `AWAIT_IN_EXPRESSION`. In reactive scope `await` goes
    anywhere (§3). The alternative is JavaScript's rule — an `await` inside
    any imperative expression. The compiler lowers that today (a body is a
    generator), but the order of a statement's other reads around the
    suspension becomes part of the semantics (each is a snapshot of σ, H-10,
    taken before or after the instant the await opens), and the reference
    interpreter would need a continuation per expression. Binding first
    keeps every snapshot on one side of the suspension.
17. **Inferred actions** (ruled 2026-10-28): an arrow whose body guesses,
    declares `affects`, or writes and awaits is an action without the
    keyword (06 AC-1b), with two checks that keep the hold visible:
    `HELD_WRITE` for an early write in such a body (AC-1c) and
    `STALE_OWN_READ` for a read of a run's own write anywhere (AC-1d).
    Weighed against keeping `action` explicit: agents in the AI eval wrote
    server writes as plain async handlers with hand-made counters, which
    worked only because the handler's `await` committed the counter; the
    compiler sees every `await` (decision 16), so it can hold the run as
    Solid would and refuse the code that would then break. An `effect`'s
    apply block is not inferred (its return is the cleanup, EF-5). The
    declared `action` stays for names, reuse, and holding a write on
    purpose.
18. **`guess x := e`, not `optimistic x := e`** (ruled 2026-11-11): the
    statement is named for what it writes, a guess (AC-3, H-11), which the
    answer replaces. The word was `optimistic` through 0.1, after Solid's
    `createOptimistic`, which it still lowers to. A guess on state nothing
    will answer reads wrong on its face (`guess saveError := …`: the eval's
    pilot runs wrote that nine times as `optimistic`, `GUESS_NO_QUESTION`).
    `optimistic` stays reserved, and a line that uses it is the parse error
    `OPTIMISTIC`, which names `guess`. `source` was weighed against `state`
    and `signal` the same day and kept (decision 2): `signal` reads as atomic
    beside stores, and an equation is state too.
