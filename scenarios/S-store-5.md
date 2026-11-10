# S-store-5 — a stream: each landing is its own quiet change; an input change restarts it

Rules: ST-6, R-4, H-9.

In `ref/` a stream is a flight that lands more than once: `resolve x v`
again on the same flight is the equation body's `yield v`. A stream is read
with `await*` (07); a plain `await` takes the flight's first answer only.

## Program

```rx
export default component App() {
  source room := "a"
  msgs = await* fetch("room:" + room)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <p>{msgs} {pending? msgs ? "p" : "-"}</p>
  }
}
```

## Frames

| instant | action                  | frame     |
| ------- | ----------------------- | --------- |
| 0       | mount                   | ``        |
| 1       | resolve msgs "a1"       | `a1 -`    |
| 2       | resolve msgs "a2"       | `a2 -`    |
| 3       | handler `room := "b"`   | `a2 p`    |
| 4       | resolve "room:a" "a3"   | `a2 p`    |
| 5       | resolve msgs "b1"       | `b1 -`    |
| 6       | resolve msgs "b2"       | `b2 -`    |

Instant 2: a later answer to the same question — quiet. Instant 3: a new
question; the old stream is superseded (R-4) and its later answer (instant
4) is inert.

## Hydration window

- "Frames" instant 4: `a3 -` — SV-3b: a stream the server is still sending when the client takes over is the server's until it ends; `room := "b"` is not followed before then, so `room:b` is not asked and the old stream's landing shows (Solid's position, DV-11)
