# S-solid-17 — after a reset the fallback stays until every reader under it settles (Solid S-17; D-12)

## Program

```
export default component App() {
  source b := 0
  source k := 0
  fast = await fetch("f:" + k)
  slow = await fetch("s:" + k + ":" + b)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>B {b}</p> {loading on(k) fallback { <p>Loading</p> } { <p>Fast {fast}</p> <p>Slow {slow}</p> }}</div>
  }
}
```

## Frames

| instant | action              | frame                   |
| ------- | ------------------- | ----------------------- |
| 0       | mount               | `B 0 Loading`           |
| 1       | resolve fast 0      | `B 0 Loading`           |
| 2       | resolve slow 0      | `B 0 Fast 0Slow 0`      |
| 3       | handler `b := 1`    | `B 0 Fast 0Slow 0`      |
| 4       | handler `k := 1`    | `B 1 Loading`           |
| 5       | resolve fast 1      | `B 1 Loading`           |
| 6       | resolve slow 1      | `B 1 Fast 1Slow 1`      |

Instant 4: the released write commits; the boundary waits. Instant 5: the
forwarded `slow` is still in the air — one coherent reveal at 6.
