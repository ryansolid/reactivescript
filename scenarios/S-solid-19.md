# S-solid-19 — a same-source outside read: the fallback is armed off screen and never seen (Solid S-19; D-17)

## Program

```rx
export default component App() {
  source id := 1
  data = await fetch("d:" + id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div>{loading on(id) fallback { <p>spinner</p> } { <p>{data}</p> }} {loading on(id) fallback { <p>spinner</p> } { <p>{data}</p> }}</div>
  }
}
```

## Frames

| instant | action              | frame              |
| ------- | ------------------- | ------------------ |
| 0       | mount               | `spinner spinner`  |
| 1       | resolve data "A"    | `A A`              |
| 2       | handler `id := 2`   | `spinner spinner`  |
| 3       | resolve data "B"    | `B B`              |

Both boundaries re-arm on `id`: each read of `data(2)` is behind a fallback, so nothing holds the frame and both
spinners show. This is the shape CN-3e accepts: a reader of what a `loading on(k)` region waits on sits under a region
that re-arms on the same change.

## Rejected variants

```rx
-- reject: CN-3e
export default component App() {
  source id := 1
  data = await fetch("d:" + id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div>{loading on(id) fallback { <p>spinner</p> } { <p>{data}</p> }} {loading fallback { <p>spinner</p> } { <p>{data}</p> }}</div>
  }
}
```

Solid's S-19. The second boundary has no `on`: it has shown content, so its read of `data(2)` holds the frame — which
is exactly what the first boundary's fallback waits on, so the spinner is never painted. In Solid the frames are
`spinner spinner`, `A A`, then `A A` after `id := 2` until `data` resolves "B", then `B B`; Solid's dev build warns
`LOADING_ON_OUTSIDE_HOLD`. The checker refuses it (CN-3e).

```rx
-- reject: CN-3e
export default component App() {
  source id := 1
  data = await fetch("d:" + id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><b>{latest id}</b> {loading on(id) fallback { <p>spinner</p> } { <p>{data}</p> }} {loading fallback { <p>spinner</p> } { <p>{data}</p> }}</div>
  }
}
```

A header reading `latest id` beside `on(id)`: the header shows `2` at once (`2 A A` until `data` resolves "B"), but the
outside read still holds the frame, so the spinner is still never seen. Refused the same way.
