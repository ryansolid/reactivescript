# S-solid-30 — a `latest` reader mounted mid-hold shows the committed value and reveals with the lane (Solid S-30; D-25)

## Program

```rx
export default component App() {
  source v := 0
  source late := false
  source gate := 0
  details = await fetch("d:" + latest v)
  hold = await fetch("g:" + gate + ":" + v)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>Details {details} / Value {v}</p> {if late { <p>Late {latest v}</p> }} <i>{hold}</i></div>
  }
}
```

`hold` stands in for Solid's action: a reader of it holds every write to `v`.

## Frames

| instant | action                  | frame                              |
| ------- | ----------------------- | ---------------------------------- |
| 0       | mount                   | ``                                 |
| 1       | resolve details 0       | ``                                 |
| 2       | resolve hold "g"        | `Details 0 / Value 0 g`            |
| 3       | handler `v := 1`        | `Details 0 / Value 0 g`            |
| 4       | handler `late := true`  | `Details 0 / Value 0 Late 0 g`      |
| 5       | resolve details 1       | `Details 1 / Value 0 Late 1 g`      |
| 6       | resolve hold "g2"       | `Details 1 / Value 1 Late 1 g2`     |

Instant 3: the lane holds itself on `details(1)`; the instant is held on
`hold`. Instant 4: an outsider mounted mid-hold shows what is on screen —
`Late 0`, not `Late 1` beside `Details 0`. Instant 5: the lane lands and
reveals as one (`Details 1 / Late 1`) while `Value` is still held.
