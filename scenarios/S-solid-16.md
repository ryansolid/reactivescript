# S-solid-16 — a reset ends the hold on writes only its readers observed; an outside reader keeps it (Solid S-16; D-12)

## Program

```rx
export default component App() {
  source page := 0
  source count := 0
  pageData = await fetch("pg:" + page)
  details = await fetch("d:" + pageData + ":" + count)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div>{loading on(page) fallback { <p>Loading...</p> } { <p>Details {details}</p> }} <p>Sum {page + count}</p></div>
  }
}
```

## Frames

| instant | action                      | frame                       |
| ------- | --------------------------- | --------------------------- |
| 0       | mount                       | `Loading... Sum 0`          |
| 1       | resolve pageData 0          | `Loading... Sum 0`          |
| 2       | resolve details "d(0,0)"    | `Details d(0,0) Sum 0`      |
| 3       | handler `count := 1`        | `Details d(0,0) Sum 0`      |
| 4       | handler `page := 1`         | `Loading... Sum 2`          |
| 5       | resolve pageData 1          | `Loading... Sum 2`          |
| 6       | resolve details "d(1,1)"    | `Details d(1,1) Sum 2`      |

Instant 3: `details` re-asks under the shown boundary — forwarded, held.
Instant 4: the reset puts `details`' only reader behind the fallback; the
`count = 1` hold is over, `page = 1` joins and commits with it, one frame.
The boundary alone waits.

## Rejected variants

```rx
-- reject: CN-3e
export default component App() {
  source page := 0
  source count := 0
  pageData = await fetch("pg:" + page)
  details = await fetch("d:" + pageData + ":" + count)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div>{loading on(page) fallback { <p>Loading...</p> } { <p>Details {details}</p> }} <p>Outside {details}</p> <p>Sum {page + count}</p></div>
  }
}
```

An outside reader keeps the hold (CN-3e, LOADING_ON_OUTSIDE_HOLD): `Outside {details}` is shown and outside the
boundary, so at instant 4 its read of `details(1, 1)` holds the frame and the boundary's fallback is never seen. In
Solid the frames are `Details d(0,0) Outside d(0,0) Sum 0` from instant 2 until `details` resolves "d(1,1)", then
`Details d(1,1) Outside d(1,1) Sum 2`; Solid's dev build warns `LOADING_ON_OUTSIDE_HOLD`. The checker refuses it.
