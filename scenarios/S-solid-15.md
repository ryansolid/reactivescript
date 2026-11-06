# S-solid-15 — a boundary whose own mount is held appears at that hold's commit (Solid S-15; D-12)

Rules: AC-1, H-5, H-8, RG-1.

## Program

```
export default component App() {
  source x := false
  slow = await fetch("slow:" + str(x))
  action open() { try { x := true; await fetch("gate") } catch {} }

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>Slow {slow}</p> {if x { <div>{loading fallback { <p>fallback</p> } { content = await fetch("content"); <p>{content}</p> }}</div> }}</div>
  }
}
```

## Frames

| instant | action                   | frame                    |
| ------- | ------------------------ | ------------------------ |
| 0       | mount                    | ``                       |
| 1       | resolve slow "false"     | `Slow false`             |
| 2       | handler `open()`         | `Slow false`             |
| 3       | resolve "gate" 0         | `Slow false`             |
| 4       | resolve slow "true"      | `Slow true fallback`     |
| 5       | resolve content "ready"  | `Slow true ready`        |

Instant 2: `x = true` is held on `slow(true)`; the branch it opens is held
with it, so the boundary is not on screen. Instant 4: `slow` lands and the
change commits; the boundary appears on its fallback — the hold did not
wait for `content` (H-5). Never `fallback` beside `Slow false`.
