# S-hold-3 — a second write during a hold: served committed, not joined

Rules: H-2, H-3, H-4, H-10, R-4. (H-3 rewritten after Solid S-4.)

## Program

```rx
export default component App() {
  source id := "a"
  source n := 0
  product = await fetch("p:" + id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <p>{product.name} {n}</p>
  }
}
```

## Frames

| instant | action                              | frame   |
| ------- | ----------------------------------- | ------- |
| 0       | mount                               | ``      |
| 1       | resolve product { name: "A" }       | `A 0`   |
| 2       | handler `id := "b"`                 | `A 0`   |
| 3       | handler `n := 1`                    | `A 1`   |
| 4       | resolve product { name: "B" }       | `B 1`   |

Instant 0: no boundary, so the mount itself is held (H-2) and nothing shows.
Instant 2 opens a hold. Instant 3: `n`'s change needs no async; the reader
is served `product`'s committed value and shows `A 1` now (Solid D-3 —
this table first said `A 0`, which was the divergence porting Solid's S-4
caught). Instant 4: `product` lands.

## Variant: superseded flight

```rx
export default component App() {
  source id := "a"
  product = await fetch("p:" + id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <p>{product.name}</p>
  }
}
```

| instant | action                              | frame   |
| ------- | ----------------------------------- | ------- |
| 0       | mount                               | ``      |
| 1       | resolve product { name: "A" }       | `A`     |
| 2       | handler `id := "b"`                 | `A`     |
| 3       | handler `id := "c"`                 | `A`     |
| 4       | resolve "p:b" { name: "B" }         | `A`     |
| 5       | resolve product { name: "C" }       | `C`     |

Instant 3 supersedes the flight for `b` (R-4); its late answer at instant 4
is discarded; the screen never shows `B`.
