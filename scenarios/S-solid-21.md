# S-solid-21 — a display-ahead read in `on` shows the fallback now, beside the held frame (Solid S-21; D-17)

## Program

```rx
export default component App() {
  source id := 1
  product = await fetch("p:" + id)
  comments = await fetch("c:" + id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><h1>{product.name}</h1> {loading on(latest id) fallback { <p>spinner</p> } { <ul>{comments}</ul> }}</div>
  }
}
```

## Frames

| instant | action                          | frame            |
| ------- | ------------------------------- | ---------------- |
| 0       | mount                           | ``               |
| 1       | resolve product { name: "A" }   | `A spinner`      |
| 2       | resolve comments "comments-A"   | `A comments-A`   |
| 3       | handler `id := 2`               | `A spinner`      |
| 4       | resolve product { name: "B" }   | `B spinner`      |
| 5       | resolve comments "comments-B"   | `B comments-B`   |

Instant 3: `on` read `latest id`, whose frame has landed, so the new id's
loading state shows inside the old page; reads of `id` stay held.
