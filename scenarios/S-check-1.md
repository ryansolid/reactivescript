# S-check-1 — the checker: what it accepts, and one program per diagnostic

Rules: 08 CN-1..CN-5, and every rule a code below cites.

The program is built from near-misses: each line is something a too-eager
checker would refuse. Every rejected variant below is refused by the
checker, statically, before the program runs.

## Program

```rx
import pure { len } from "./prelude"

context panel: string                   // RG-7: a declared context
component Panel(props) {
  provide panel = props.label
  <section>{props.children}</section>
}
component Badge(props) {
  label = use panel                      // RG-7b: provided by Panel, read through Panel's children
  <b>{label}{props.n}</b>
}

export default component App() {
  source items := [1, 2]
  source notes := []
  source handlers := []
  source mode := true

  total = len(items)
  a = mode ? 1 : (pre a -> 0)              // C-1: an equation's own `pre` breaks the cycle
  fn twice(x) => x * 2 + total             // a fn may read module state; it stays pure
  cb = () => total                         // a closure created in reactive scope: pure (SC-3)
  action note(n) { notes := xs => [...xs, n] }

  <div>
    <Panel label="P"><Badge n={twice(1)} /></Panel>
    {for i in items {
      source hits := 0
      <i onClick={() => { let h = hits + 1; hits := h; note(h); handlers := [...handlers, () => total] }}>{i}:{hits}</i>
    }}
    <p>{a} {cb()} {len(notes)}</p>
  </div>
}
```

In the row handler: storing the *value* of `hits` is never an escape;
storing a closure over `total` (module-level) into a module-level source is
not one either (O-3).

## Frames

| instant | action                 | frame              |
| ------- | ---------------------- | ------------------ |
| 0       | mount                    | `P41:02:01 2 0` |
| 1       | handler `mode := false`  | `P41:02:01 2 0` |
| 2       | handler `note(7)`        | `P41:02:01 2 1` |

Instant 1: `a`'s own `pre` is the value it is replacing, `1` (C-2).

## Rejected variants

```rx
-- reject: DUPLICATE_DECLARATION
export default component App() {
  source x := 1
  x = 2

  <p>{x}</p>
}
```

```rx
-- reject: CYCLE
export default component App() {
  source m := true
  a = m ? b : 1
  b = m ? 2 : a

  <p>{a}</p>
}
```

The branches are exclusive and no run closes the cycle; the static graph is
the union of branches and refuses it (CN-3a).

```rx
-- reject: CYCLE
export default component App() {
  source s := 1
  a = pre b
  b = a + 1

  <p>{b}</p>
}
```

`pre` of *another* node is an input of it (C-2): only an equation's own
`pre` breaks a cycle.

```rx
-- reject: PRE_OF_NON_REACTIVE
export default component App() {
  fn f(x) => x
  y = pre f

  <p>{y}</p>
}
```

```rx
-- reject: ROW_NARROWER_THAN_INFERRED
export default component App() {
  source id := 1
  user: lane string = await fetch("u:" + id)

  <p>{user}</p>
}
```

The written row says `lane` only; the value is also `pending` (CN-4a). Rows
are checked only when written.

```rx
-- reject: UNBOUND
component Row(props) { <p>{caption}</p> }
component List(props) {
  caption = "hi"
  <Row />
}

export default component App() {
  <List />
}
```

`Row` sees its declaration site, not its caller (RG-7a).

```rx
-- reject: UNKNOWN_COMPONENT
export default component App() {
  <Nope />
}
```

```rx
-- reject: ACTION_CALLED_IN_OWNED_SCOPE
export default component App() {
  source n := 1
  action bump() { n := n + 1 }
  x = bump()

  <p>{x}</p>
}
```

```rx
-- reject: IO_IN_FN
import { log } from "./prelude"
export default component App() {
  fn noisy(v) => log(v)
  source n := 1

  <p>{noisy(n)}</p>
}
```

```rx
-- reject: REACTIVE_WRITE_IN_OWNED_SCOPE
export default component App() {
  source n := 1
  reset = () => { n := 0 }

  <p>{n}</p>
}
```

A closure created in reactive scope is pure (SC-3); a statement body is a
write position. Handlers are written on the element (`onClick={() => { … }}`).

```rx
-- reject: ASYNC_STORE_SETTER
export default component App() {
  source id := 1
  sel = draft(pre sel -> {}) { refresh id }

  <p>{sel}</p>
}
```

```rx
-- reject: WRITE_TO_NON_SOURCE
export default component App() {
  source n := 1
  double = n * 2

  <button onClick={() => { double := 4 }}>{double}</button>
}
```

```rx
-- reject: OPTIMISTIC_OUTSIDE_HOLD
export default component App() {
  source name := "Ann"
  source shown = name
  effect (name) { optimistic shown := "Zed" }

  <p>{shown}</p>
}
```

```rx
-- reject: OPTIMISTIC_NO_QUESTION
export default component App() {
  source shown := "Ann"
  action fix() { optimistic shown := "Zed"; await fetch("x") }

  <p>{shown}</p>
}
```

```rx
-- reject: INVALID_REFRESH_TARGET
export default component App() {
  source base := 1

  <button onClick={() => { refresh base }}>{base}</button>
}
```

```rx
-- reject: INVALID_AFFECTS_TARGET
export default component App() {
  action go(n) { affects n }

  <p>x</p>
}
```

```rx
-- reject: REGION_ESCAPE
export default component App() {
  source handlers := []
  source rows := [1, 2]

  <ul>{for r in rows {
    source hits := 0
    <li onClick={() => { handlers := [...handlers, () => hits] }}>{hits}</li>
  }}</ul>
}
```

`() => hits` captures the row's `hits`; `handlers` outlives the row (O-3).

```rx
-- reject: REGION_ESCAPE
export default component App() {
  source handlers := []
  source open := true

  <div>{if open {
    source n := 0
    <b onClick={() => { let read = () => n; handlers := xs => [...xs, read] }}>{n}</b>
  }}</div>
}
```

Through a `let`, and through a functional write's result: the function a
functional write is given is applied, but what it returns is stored (W-6).

(A case here stored a closure through a `source` context, `use fields :=
fs => [...fs, () => v]`. RG-7c is withdrawn, 2026-10-31: a provider now
provides writer functions, and a closure handed to one as an argument is
not yet followed by O-3. See the gap noted under O-3 in 03-regions.)

```rx
-- reject: REGION_ESCAPE
source handlers := []
fn counter(ref start: number) {
  source n := peek(start)
  { get: () => n }
}

export default component App() {
  source rows := [1, 2]
  <ul>{for r in rows {
    c = counter(r)
    <li onClick={() => { handlers := [...handlers, c.get] }}>{r}</li>
  }}</ul>
}
```

An instantiation's result carries what its closures capture: `c.get`
reads the instance's `n`, and the instance lives as long as the row it
was made in (RG-6a). Made in `App`'s own region and stored in `App`'s own
source, the same closure is fine.
Calling it is fine anywhere: `handlers := [...handlers, c.get()]` stores
a number. What a call returns holds a closure only when the closure called
makes one:

```rx
-- reject: REGION_ESCAPE
export default component App() {
  source handlers := []
  source rows := [1, 2]

  <ul>{for r in rows {
    source hits := 0
    later = () => () => hits
    <li onClick={() => { handlers := [...handlers, later()] }}>{hits}</li>
  }}</ul>
}
```

```rx
-- reject: REGION_ESCAPE
source registry := []
component Item(props) {
  effect (props.label) { registry := r => [...r, props.onFocus] }
  <i>{props.label}</i>
}

export default component App() {
  source rows := [1, 2]
  <ul>{for r in rows {
    source hits := 0
    <Item label={r} onFocus={() => { hits := hits + 1 }} />
  }}</ul>
}
```

`Item` stores the closure it is given, which is the caller's: what it
captures is checked where `Item` is applied. Storing `props.label` (a
value) is never an escape.

(A case here stored `props.onPick`, passed on through `Labeled`, through
a `source` context provided above the rows. That form is withdrawn
(RG-7c, 2026-10-31); the same store made through a provided writer
function is the O-3 gap noted in 03-regions.)

```rx
-- reject: CONTEXT_NOT_FOUND
context panel: string
component Panel(props) {
  provide panel = "P"
  <section>{props.children}</section>
}
component Badge(props) { <b>{use panel}</b> }

export default component App() {
  <div><Panel><Badge /></Panel> <Badge /></div>
}
```

The second `<Badge />` is rendered on a path with no provision (RG-7b): one
path without it is enough.
