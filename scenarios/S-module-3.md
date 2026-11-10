# S-module-3 — modules read by their `.d.rx`: checked against the signature, with no body

Rules: MO-9, MO-3, MO-2, MO-6, R-f-5, R-f-6, RG-7b.

## Modules

```rx
-- module: ./store.d.rx
export error NotFound(id)
export source selected := …
export user: pending fails(Error | NotFound)
export action select
export pure fn initials(name) rejects(Error)
```

```rx
-- module: ./ui.d.rx
export context who: string
export component Card(props: { children: catches(*) }) shape(roots p div; closes-p; children-at div)
export component Name(props: { user: catches(NotFound) }) shape(roots i)
export component Badge(props: {}) uses(./ui.rx#who) shape(roots b)
export component Save(props: { v: unrendered action go catches(nothing) }) shape(roots button)
```

These are S-module-1's `store.rx` and `ui.rx` as `ref/check.ts --signature`
prints them. Neither `.rx` file is here: `import … from "./store.rx"`
finds `./store.d.rx` beside where the module would be and reads it in place
of the module (MO-9), as a crate is checked against another crate's
metadata. The program and every refusal below are S-module-1's, with the
same verdicts — `ref/run.ts` checks that for every scenario with modules,
by printing each module's signature, reading it back and checking each
module against its imports' text instead of their bodies.

## Program

```rx
import { selected, user, select } from "./store.rx"
import { Card, Name, Badge, who } from "./ui.rx"
provide who = "Zed"

export default component App() {
  <div><p>#{selected}</p> <Card><Name user={user} /></Card> <Badge /></div>
}
```

Accepted: `Name` discharges `NotFound` and `Card`'s boundary takes the
`Error` left over (R-f-5); `who` is provided above `Badge` (RG-7b, its key
`./ui.rx#who` is the declaration's). There is no body to run here — the
runners that execute (interpreter, oracle, compiled, server) need the
modules' compiled code, which a `.d.rx` does not carry.

## Rejected variants

```rx
-- reject: UNHANDLED_FAILURE
import { user } from "./store.rx"
import { Name } from "./ui.rx"
export default component App() {
  <div><Name user={user} /></div>
}
```

`Name` discharges `NotFound` only; the fetch's `Error` leaves it at its
application, with no boundary above (R-f-5 through the summary).

```rx
-- reject: CONTEXT_NOT_FOUND
import { Badge } from "./ui.rx"
export default component App() {
  <div><Badge /></div>
}
```

`uses(./ui.rx#who)`: no provision above the application (RG-7b).

```rx
-- reject: WRITE_TO_NON_SOURCE
import { selected } from "./store.rx"
export default component App() {
  <button onClick={() => { selected := 2 }}>{selected}</button>
}
```

MO-2: an imported source is read-only.

```rx
-- reject: NOT_EXPORTED
import { users } from "./store.rx"
export default component App() {
  <p>{users}</p>
}
```

```rx
-- reject: UNCAUGHT_ACTION_FAILURE
import { user } from "./store.rx"
import { Save } from "./ui.rx"
export default component App() {
  <div><Save v={user} /></div>
}
```

R-f-6: `Save`'s action reads `props.v` and catches nothing; `user` can
fail with `Error | NotFound`.

```rx
-- reject: INVALID_REFRESH_TARGET
import { selected } from "./store.rx"
export default component App() {
  action again() { refresh selected }
  <p>{selected}</p>
}
```

`selected := …`: a plain source, no question to re-ask (AC-4) — the
signature says which.
