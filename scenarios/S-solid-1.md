# S-solid-1 — navigation: page B appears whole (Solid S-1; D-1, F-2, F-7)

## Program

```rx
export default component App() {
  source id := 1
  product  = await fetch("p:" + id)
  comments = await fetch("c:" + id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><h1>{product.name}</h1> {loading fallback { <p>spinner</p> } { <ul>{comments}</ul> }} <i>{pending? id}</i></div>
  }
}
```

## Frames

| instant | action                           | frame                     |
| ------- | -------------------------------- | ------------------------- |
| 0       | mount                            | ``                        |
| 1       | resolve product { name: "A" }    | `A spinner false`         |
| 2       | resolve comments "comments-A"    | `A comments-A false`      |
| 3       | handler `id := 2`                | `A comments-A true`       |
| 4       | resolve comments "comments-B"    | `A comments-A true`       |
| 5       | resolve product { name: "B" }    | `B comments-B false`      |

Instants 0–2 prime the page (Solid's "primed" row). Instant 1: `product`
landed but `comments` has not; `comments` is under an armed boundary, so the
mount commits with the spinner; `pending? id` is `false` — a source always
has a verdict (Solid S-1 row 0).
Instant 3 holds on both; the shown boundary keeps `comments-A` (H-6).
Instant 4: still held on `product`. Instant 5: whole.
