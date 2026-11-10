# S-hold-4 — a lane holds itself, not the instant

Rules: H-7, R-9, R-10, R-4.

## Program

```rx
export default component App() {
  source id := "a"
  product = await fetch("p:" + id)
  preview = await fetch("v:" + latest id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>{product.name}</p> <p>{preview}</p></div>
  }
}
```

`preview` is derived from a probe, so it and its reader are in `id`'s lane
(R-10): the reader never holds the instant; pending work inside the lane
holds the lane.

## Frames

| instant | action                        | frame   |
| ------- | ----------------------------- | ------- |
| 0       | mount                         | ``      |
| 1       | resolve product { name: "A" } | ``      |
| 2       | resolve preview "pa"          | `A pa`  |
| 3       | handler `id := "b"`           | `A pa`  |
| 4       | resolve preview "pb"          | `A pb`  |
| 5       | resolve product { name: "B" } | `B pb`  |

Instants 0–1: both first loads hold the mount — a lane reader with no
committed value has no committed world to show, so at the mount it is the
mount's (H-7; found by the oracle: Solid reveals the two together). Instant
2: the mount commits as one frame. Instant 3: the instant is held by `product`; the lane's
own `await` is pending, so the lane keeps `pa`. Instant 4: the lane lands
and reveals ahead of the still-held instant (H-7). Instant 5: the instant
commits.
