# S-solid-48 — `on(id)`: the `on` pass reads the held value plainly, so the swap lands with the write's frame (Solid S-48; D-17)

Rules: H-6, H-7, R-11.

## Program

```
export default component App() {
  source id := 1
  product = await fetch("p:" + id)
  comments = await fetch("c:" + id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><span>{product}</span> {loading on(id) fallback { <p>[fallback]</p> } { <span>{comments}</span> }}</div>
  }
}
```

## Frames

| instant | action              | frame            |
| ------- | ------------------- | ---------------- |
| 0       | mount               | ``               |
| 1       | resolve product "p1" | `p1 [fallback]` |
| 2       | resolve comments "c1" | `p1 c1`        |
| 3       | handler `id := 2`   | `p1 c1`          |
| 4       | resolve product "p2" | `p2 [fallback]` |
| 5       | resolve comments "c2" | `p2 c2`        |

Instant 3: the `on` pass read the held `id` plainly, so it is the hold's work
and the re-arm is held with it (Solid D-17). Instant 4: the frame commits and
the swap lands with it. `p1 [fallback]` at instant 3 would show the fallback
ahead of the frame the plain read belongs to. S-solid-21 is the same program
with `on(latest id)`: there every held read of the `on` pass was ahead, and
the fallback shows now.
