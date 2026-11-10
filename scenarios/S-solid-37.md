# S-solid-37 — a derived source's seed is never visible; pending is per key (Solid S-37; D-30)

Rules: ST-2c, ST-5, AC-4, R-7.

## Program

```rx
export default component App() {
  source id := 1
  source state = await fetch("s:" + str(id))
  action patch() { try { state.a := 5; await fetch("w") } catch {} }

  errored fallback(e) { <p>error: {e.message}</p> } {
    {loading fallback { <p>loading</p> } { <p>{state.a} {state.b} {pending? state.a ? "a!" : "-"} {pending? state.b ? "b!" : "-"}</p> }}
  }
}
```

## Frames

| instant | action                        | frame          |
| ------- | ----------------------------- | -------------- |
| 0       | mount                         | `loading`      |
| 1       | resolve state { a: 1, b: 1 }  | `1 1 - -`      |
| 2       | handler `id := 2`             | `1 1 a! b!`    |
| 3       | resolve state { a: 2, b: 2 }  | `2 2 - -`      |
| 4       | handler `refresh state`       | `2 2 - -`      |
| 5       | resolve state { a: 3, b: 3 }  | `3 3 - -`      |

Instant 0: there is no seed to see — the first load suspends to the
boundary. Instant 2: the derive re-asks: the whole family is pending.
Instant 4: a quiet re-ask.

## Variant: a held path write pends exactly its key (row 2′)

| instant | action                        | frame          |
| ------- | ----------------------------- | -------------- |
| 2       | handler `patch()`             | `1 1 a! -`     |
| 3       | resolve "w" 0                 | `5 1 - -`      |

Per key: the sibling is final.
