# S-module-1 — three modules: shared module state, read-only across the boundary, rows and provisions through signatures

Rules: MO-1, MO-1d, MO-2, MO-3, MO-4, MO-5, MO-6, R-f-5, R-f-6, RG-7b.

## Modules

```rx
-- module: ./store.rx
export error NotFound(id) => `no user ${id}`
export source selected := 1
export user = selected > 0 ? await fetch("u:" + selected) : throw NotFound(selected)
export action select(id) { selected := id }
export fn initials(name) => name.slice(0, 1)
```

```rx
-- module: ./ui.rx
import { NotFound, initials } from "./store.rx"
export context who: string
export component Card(props) {
  errored fallback(e) { <p>?</p> } { <div>{props.children}</div> }
}
export component Name(props) {
  <i>{props.user.name catch (e: NotFound) => "nobody"}</i>
}
export component Badge(props) {
  <b>{initials(use who)}</b>
}
export component Save(props) {
  action go() { log(props.v) }
  <button onClick={() => { go() }}>save</button>
}
source picks := []
export component Pick(props) {
  effect (props.n) { picks := ps => [...ps, props.onPick] }
  <u>{props.n}</u>
}
```

```rx
-- module: ./a.rx
import { b } from "./b.rx"
export a = b + 1
```

```rx
-- module: ./b.rx
import { a } from "./a.rx"
export b = a + 1
```

`store.rx` owns the state and exports the only way to write it, an action
(MO-2). `ui.rx` is checked once, against `store.rx`'s signature; `main` is
checked against both signatures and never sees a body (MO-3). Its view of
`ui.rx` (`ref/check.ts --signature`):

```text
export context who: string
export component Card(props: { children: catches(*) }) shape(roots p div; closes-p; children-at div)
export component Name(props: { user: catches(NotFound) }) shape(roots i)
export component Badge(props: {}) uses(./ui.rx#who) shape(roots b)
export component Save(props: { v: unrendered action go catches(nothing) }) shape(roots button)
export component Pick(props: { n }) retains(onPick: module) shape(roots u)
```

`Pick` keeps the callback it is given in a source of its module, which
outlives every application of it: `retains(onPick: module)` is how an
importer learns that, so the closure it passes is checked where it passes
it (O-3).

The same text, with no `ui.rx` beside it, is read in place of the module
(MO-9, S-module-3).

## Program

```rx
import { selected, user, select } from "./store.rx"
import { Card, Name, Badge, who } from "./ui.rx"
provide who = "Zed"

export default component App() {
  <div><p>#{selected}</p> <Card><Name user={user} /></Card> <Badge /></div>
}
```

`user` fails with `Error` (the fetch) and `NotFound` (the throw). `Name`
discharges `NotFound`; the `Error` left over leaves `Name` at its
application, which is a child of `Card`, whose boundary takes every class.
`Badge` needs a provision of `who`, the context `ui.rx` declares and
exports; `main` imports it and provides it above the place it is applied. `initials` is found in `ui.rx`, where `Badge` is declared, not
in `main`, which does not import it (MO-6).

## Frames

| instant | action                         | frame          |
| ------- | ------------------------------ | -------------- |
| 0       | mount                          | ``             |
| 1       | resolve user { name: "Ann" }   | `#1 Ann Z`     |
| 2       | handler `select(0)`            | `#0 nobody Z`  |
| 3       | handler `select(2)`            | `#0 nobody Z`  |
| 4       | reject user "offline"          | `#2 ? Z`       |

Instant 2: the write goes through `store.rx`'s action; `user` throws
`NotFound` with no await and `Name` shows its value. Instant 3: a new
question holds the change. Instant 4: the rejection is an `Error`, which
`Name` passes and `Card` takes, in one frame with `#2`.

## Rejected variants

```rx
-- reject: MO-2
import { selected } from "./store.rx"

export default component App() {
  <button onClick={() => { selected := 5 }}>{selected}</button>
}
```

An imported source is read-only: the module exports `select` to write it.

```rx
-- reject: REGION_ESCAPE
import { Pick } from "./ui.rx"

export default component App() {
  source rows := [1, 2]
  <ul>{for r in rows {
    source hits := 0
    <Pick n={r} onPick={() => { hits := hits + 1 }} />
  }}</ul>
}
```

O-3 through a signature: the row's closure would outlive the row in
`ui.rx`'s `picks`. The checker sees only `retains(onPick: module)`.

```rx
-- reject: NOT_EXPORTED
import { hidden } from "./store.rx"

export default component App() {
  <p>{hidden}</p>
}
```

```rx
-- reject: MODULE_NOT_FOUND
import { x } from "./nope.rx"

export default component App() {
  <p>{x}</p>
}
```

```rx
-- reject: MODULE_CYCLE
import { a } from "./a.rx"

export default component App() {
  <p>{a}</p>
}
```

MO-5: `a.rx` and `b.rx` import each other.

```rx
-- reject: IMPORT_ROW_MISMATCH
import pure { select } from "./store.rx"

export default component App() {
  <p>{select}</p>
}
```

MO-4: `select` is an action — `io` in its signature; `pure` cannot lower an
`.rx` row.

```rx
-- reject: CONTEXT_NOT_FOUND
import { Badge } from "./ui.rx"

export default component App() {
  <Badge />
}
```

RG-7b through a signature: `Badge` uses `who`, and nothing above this
application provides it.

```rx
-- reject: UNHANDLED_FAILURE
import { user } from "./store.rx"
import { Name } from "./ui.rx"

export default component App() {
  <Name user={user} />
}
```

`Name` discharges `NotFound` only; the fetch's `Error` comes out at this
application with nothing above it.

```rx
-- reject: UNCAUGHT_ACTION_FAILURE
import { user } from "./store.rx"
import { Save } from "./ui.rx"

export default component App() {
  errored fallback(e) { <p>{e.message}</p> } { <Save v={user} /> }
}
```

`Save`'s action reads `props.v`: an argument that can fail is refused at
the application, whatever boundary is above it (R-f-6).

```rx
-- reject: SHADOWED_IMPORT
import { initials } from "./store.rx"

export default component App() {
  source initials := "AB"
  <p>{initials(initials)}</p>
}
```

MO-1d: the component's `initials` would hide the imported function, and the
call would call a string. Rename one: `import { initials as short }`.
