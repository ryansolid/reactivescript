# S-fail-3 — a root boundary for panics only: crashes are caught, failures must still be handled where they happen

Rules: R-f-10, R-f-3, R-f-4, R-f-5, CN-6b.

## Program

```rx
import pure { fail } from "./prelude"
export default component App() {
  source raw := "ok"
  detail = await fetch("detail")
  parsed = raw == "bad" ? fail("corrupt input") : raw

  errored fallback(e: Panic) { <p>crashed: {e.message}</p> } {
    <div><p>{parsed}</p> {errored fallback(e) { <p>detail failed: {e.message}</p> } { <p>{detail}</p> }}</div>
  }
}
```

`fail` is the prelude's JS function that throws synchronously: a panic, in
no row (R-f-3). The root boundary lists `Panic`, which discharges no
failure class (R-f-10): the fetch's `Error` must be discharged by the
detail's own boundary — remove that boundary and the program is refused
(below), although the root would catch anything at run time.

## Frames

| instant | action                    | frame                                  |
| ------- | ------------------------- | -------------------------------------- |
| 0       | mount                     | ``                                     |
| 1       | reject detail "timeout"   | `ok detail failed: timeout`            |
| 2       | handler `raw := "bad"`    | `crashed: corrupt input`               |
| 3       | handler `raw := "fine"`   | `fine detail failed: timeout`          |

Instant 1: the failure stays in its pane. Instant 2: the panic reaches the
root's `Panic` boundary — the only boundary above `parsed`. Instant 3: a
value replaces it and the page recovers.

## Rejected variants

```rx
-- reject: UNHANDLED_FAILURE
export default component App() {
  source raw := "ok"
  detail = await fetch("detail")

  errored fallback(e: Panic) { <p>crashed: {e.message}</p> } {
    <div><p>{raw}</p> <p>{detail}</p></div>
  }
}
```

R-f-10: a `Panic` boundary does not discharge the fetch's `Error`. With
`fallback(e)` at the root this program is accepted, and a failing detail
would take the whole page down; with `fallback(e: Panic)` the checker keeps
"the detail's failure stays in the detail" a compile-time fact.
