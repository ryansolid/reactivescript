# S-solid-9 — a write after `await` is still the action's (Solid S-9, inverted; D-7)

Rules: AC-1.

Solid's S-9 documents a platform escape: a fresh signal written between an
`await` and the next `yield` commits ambiently. The language has the scope,
so there is no escape to write: every write between an action's entry and
its return belongs to its change.

## Program

```rx
export default component App() {
  source a := 0
  source b := 0
  source c := 0
  action run() { try { a := 1; await fetch("x"); b := 1; c := 1 } catch {} }

  <p>{a} {b} {c}</p>
}
```

## Frames

| instant | action           | frame     |
| ------- | ---------------- | --------- |
| 0       | mount            | `0 0 0`   |
| 1       | handler `run()`  | `0 0 0`   |
| 2       | resolve "x" 0    | `1 1 1`   |

Solid shows `0 1 0` after instant 2's `setB(1)` (the escape) and `1 1 1`
when the body returns. Here `b := 1` after the `await` is the action's, and
the body returns in the same instant: one frame.
