# S-solid-42 — a held rejection reveals with its frame; a held recovery keeps the shown error (Solid S-42, S-43; D-41)

## Program

```
export default component App() {
  source count := 1
  data = await fetch("d:" + count)
  slow = await fetch("s:" + count)
  effect (data) { log($0) }

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>{count}</p> {errored fallback { <p>Error</p> } { <p>{data}</p> }} <p>{slow}</p></div>
  }
}
```

The effect's apply receives an error value like any answer (E-12): Solid's
`error` arm. It arrives as `$0`; reading `data` by name in the apply would
be a snapshot, and a snapshot of an error throws it (R-f-7).

## Frames

| instant | action                 | frame        | effect        |
| ------- | ---------------------- | ------------ | ------------- |
| 0       | mount                  | ``           | —             |
| 1       | resolve data 1         | ``           | —             |
| 2       | resolve slow 1         | `1 1 1`      | `log(1)`      |
| 3       | handler `count := 2`   | `1 1 1`      | —             |
| 4       | reject data "boom"     | `1 1 1`      | —             |
| 5       | resolve slow 2         | `2 Error 2`  | `log(#error)` |
| 6       | handler `count := 3`   | `2 Error 2`  | —             |
| 7       | resolve data 1         | `2 Error 2`  | —             |
| 8       | resolve slow 3         | `3 1 3`      | `log(1)`      |

Instant 4: the error settled `data` but is staged like a value would be —
the frame is still held on `slow(2)`. Instant 5: one frame — input, error
fallback, sibling — and the effect's arm runs then. Instants 6–7: the error
stays the display through the retry (D-41); the recovery to `1` is settled,
not shown. Instant 8: `1` equals the last good value and is still a new
answer — the arm runs.
