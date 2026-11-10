# S-context-1 — declared contexts: identity is the declaration, defaults, rows and writability are declared

Rules: RG-7a..e, MO-7, R-f-5, CN-4a.

## Modules

```rx
-- module: ./theme.rx
export context theme: string = "light"
export context accent: string
```

```rx
-- module: ./other.rx
export context accent: string
```

`other.rx`'s `accent` is a different context from `theme.rx`'s: the same
spelling, another declaration.

## Program

```rx
import { theme, accent } from "./theme.rx"
source mode := "dark"
component Label(props) { <b>{use theme}/{use accent}</b> }
component Themed(props) {
  provide theme = mode
  <i>{props.children}</i>
}
provide accent = "blue"

export default component App() {
  <div><Label /> <Themed><Label /></Themed></div>
}
```

The first `Label` has no provision of `theme` above it and reads its
default; the second reads `Themed`'s. Both find `main`'s `accent`.

## Frames

| instant | action                | frame                   |
| ------- | --------------------- | ----------------------- |
| 0       | mount                 | `light/blue dark/blue`  |
| 1       | handler `mode := "dim"` | `light/blue dim/blue` |

## Rejected variants

```rx
-- reject: CONTEXT_NOT_FOUND
import { accent } from "./theme.rx"
import { accent as paint } from "./other.rx"
component Label(props) { <b>{use accent}</b> }
provide paint = "red"

export default component App() {
  <Label />
}
```

MO-7: a provision of `other.rx`'s `accent` is not one of `theme.rx`'s.

```rx
-- reject: ROW_NARROWER_THAN_INFERRED
import { accent } from "./theme.rx"
provide accent = await fetch("accent")

export default component App() {
  errored fallback(e) { <p>{e.message}</p> } { <b>{use accent}</b> }
}
```

RG-7e: an exported context's type is its contract — `accent: string`
writes no rows, so a provision that is pending and can fail is refused at
the `provide`. Its importers, on both sides, rely on the declaration.

```rx
-- reject: UNHANDLED_FAILURE
context who: string
provide who = await fetch("who")

export default component App() {
  <b>{use who}</b>
}
```

A context that is not exported and writes no rows takes its rows from its
provisions: `use who` can fail with `Error`, so its reader needs a boundary.

```rx
-- reject: WRITE_TO_NON_SOURCE
import { accent } from "./theme.rx"
provide accent = "blue"

export default component App() {
  <button onClick={() => { use accent := "red" }}>{use accent}</button>
}
```

O-4: a context is read beneath its provision, never written through.

```rx
-- reject: SOURCE_CONTEXT
context picked: source number

export default component App() {
  source n := 1
  provide picked = n
  <b>{use picked}</b>
}
```

`context x: source T` (RG-7c) is withdrawn (ruled 2026-10-31): the
provider provides the writes it allows, as functions.

```rx
-- reject: NOT_A_CONTEXT
export default component App() {
  source picked := 1
  provide picked = 2

  <b>{picked}</b>
}
```

```rx
-- reject: CONTEXT_AS_VALUE
import { theme } from "./theme.rx"

export default component App() {
  <b>{theme}</b>
}
```
