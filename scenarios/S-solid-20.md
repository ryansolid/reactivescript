# S-solid-20 — the action outlasts the data: a race the fallback lost (Solid S-20; D-17)

Rules: AC-1, H-5, H-6.

## Program

```
export default component App() {
  source id := 1
  comments = await fetch("c:" + id)
  action go() { try { id := 2; await fetch("longer") } catch {} }

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>{id == 1 ? "A" : "B"}</p> {loading on(id) fallback { <p>spinner</p> } { <p>comments-{comments}</p> }}</div>
  }
}
```

## Frames

| instant | action                  | frame             |
| ------- | ----------------------- | ----------------- |
| 0       | mount                   | `A spinner`       |
| 1       | resolve comments "A"    | `A comments-A`    |
| 2       | handler `go()`          | `A comments-A`    |
| 3       | resolve comments "B"    | `A comments-A`    |
| 4       | resolve "longer" 0      | `B comments-B`    |

Instant 2: `on` re-arms the boundary; its fallback belongs to the change's
frame, which the action holds — so it is the display and is not shown
(H-5). Instant 3: the data lands, the action is still open. Instant 4: the
fallback was never displayed.

## Variant: the action ends before the data lands

| instant | action                  | frame             |
| ------- | ----------------------- | ----------------- |
| 3       | resolve "longer" 0      | `B spinner`       |
| 4       | resolve comments "B"    | `B comments-B`    |

The race the fallback won: it shows with the commit, then the content.
