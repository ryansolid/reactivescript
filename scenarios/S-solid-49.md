# S-solid-49 — a mixed `on`: a plain read of a held value makes the re-arm wait (Solid S-49; D-17, D-25)

Rules: H-6, H-7, R-11.

## Program

```
export default component App() {
  source id := 1
  source filter := 0
  product = await fetch("p:" + id)
  comments = await fetch("c:" + id)
  action go() { try { id := 2; filter := 1; await fetch("go") } catch {} }

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><span>{product}</span> {loading on([latest id, filter]) fallback { <p>[fallback]</p> } { <span>{comments}</span> }}</div>
  }
}
```

## Frames

| instant | action                | frame            |
| ------- | --------------------- | ---------------- |
| 0       | mount                 | ``               |
| 1       | resolve product "p1"  | `p1 [fallback]`  |
| 2       | resolve comments "c1" | `p1 c1`          |
| 3       | handler `go()`        | `p1 c1`          |
| 4       | resolve "go" 0        | `p1 c1`          |
| 5       | resolve product "p2"  | `p2 [fallback]`  |
| 6       | resolve comments "c2" | `p2 c2`          |

Instant 3: `filter` is a plain read of a write the action holds, so the `on`
pass is the hold's work and the re-arm waits, whatever `latest id` beside it
read: posture is per read (decision 1 of solidjs/solid#4695). Instant 5: the
hold commits and the swap lands with the frame.

## Divergences (DV-21)

- oracle "Frames" instant 3: `p1 [fallback]`
- oracle "Frames" instant 4: `p1 [fallback]`

Solid ruled this row in #4695 (S-49, ruled, not built): today one probe in
the `on` pass makes the whole pass a display-ahead reader.
