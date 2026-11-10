# S-solid-36 — a declared first paint is loading, not pending (Solid S-36; D-30)

## Program

```rx
export default component App() {
  source id := 1
  feed = await fetch("feed:" + id) -> "placeholder"

  errored fallback(e) { <p>error: {e.message}</p> } {
    {loading fallback { <p>never shown</p> } { <div><p>{feed}</p> <p>{pending? feed}</p></div> }}
  }
}
```

## Frames

| instant | action                   | frame                 |
| ------- | ------------------------ | --------------------- |
| 0       | mount                    | `placeholder false`   |
| 1       | resolve feed "rows1"     | `rows1 false`         |
| 2       | handler `id := 2`        | `rows1 true`          |
| 3       | resolve feed "rows2"     | `rows2 false`         |

Instant 0: the window — no fallback, no hold, `pending?` false. Instant 1:
the window closes; the node is an ordinary equation. Instant 2: a new
question, held like any (R-7).
