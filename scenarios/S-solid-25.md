# S-solid-25 — nothing shows a write before its instant; then every channel at once (Solid S-25; D-22, D-33)

A write becomes visible at its instant's settle, to every channel (H-10).
The in-run invisibility (Solid's "no flush" row) is W-4 and is exercised by
S-core-1's multi-write instant; this scenario covers the held case.

## Program

```rx
export default component App() {
  source count := 20
  doubled = count * 2
  slow = await fetch("s:" + count)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>{count}</p> <p>{latest count}</p> <p>{latest doubled}</p> <p>{pending? count}</p> <i>{slow}</i></div>
  }
}
```

## Frames

| instant | action                 | frame                  |
| ------- | ---------------------- | ---------------------- |
| 0       | mount                  | ``                     |
| 1       | resolve slow 20        | `20 20 40 false 20`    |
| 2       | handler `count := 30`  | `20 30 60 true 20`     |
| 3       | resolve slow 30        | `30 30 60 false 30`    |

Instant 2: an async reader holds `count`; the plain read stays `20`, both
probes show `30`/`60` together (never `latest count` 30 beside
`latest doubled` 40), and the verdict is `true`.
