# S-hold-6 — a re-armed `loading` above an error fallback takes the next question (found by S-ai2-search)

Rules: H-12, H-6, H-5, D-41.

## Program

```
error NotFound(id) => `item ${id} not found`
source sel := 4
item = await fetch("i:" + sel)
shown = item == null ? throw NotFound(sel) : item

export default component App() {
  loading on(sel) fallback { <p>loading…</p> } {
    errored fallback(e) { <p>{e.message}</p> } { <p>{shown}</p> }
  }
}
```

## Frames

| instant | action              | frame              |
| ------- | ------------------- | ------------------ |
| 0       | mount               | `loading…`         |
| 1       | resolve item null   | `item 4 not found` |
| 2       | handler `sel := 3`  | `loading…`         |
| 3       | resolve item "pear" | `pear`             |

Instant 2: the error fallback alone would stay up while the content under it
is pending (D-41), showing item 4's failure while item 3 loads. But the
`loading` above it is re-armed by `on(sel)`, and an armed boundary takes
the pending content even behind an error fallback: its fallback replaces
both (Solid's behaviour; the second AI test's search pane first wrapped its
pane in `for id in [selected]` to get this).
