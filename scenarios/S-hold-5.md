# S-hold-5 — an error is an answer; `errored` is the display

Rules: H-12, H-4, R-6, E-12.

## Program

```rx
export default component App() {
  source id := "a"
  product = await fetch("p:" + id)

  <div>{errored fallback { <p>failed</p> } {
    {loading fallback { <p>loading</p> } { <p>{product.name}</p> }}
  }}</div>
}
```

## Frames

| instant | action                        | frame     |
| ------- | ----------------------------- | --------- |
| 0       | mount                         | `loading` |
| 1       | reject product "boom"           | `failed`  |
| 2       | handler `id := "b"`           | `failed`  |
| 3       | resolve product { name: "B" } | `B`       |

Instant 1: the rejection ends the wait like a value (R-6) and reaches the
`errored` region, which becomes the display (H-12). Instant 2: a new
question; the reader behind the error fallback holds nothing (H-4), so the
instant commits and the fallback stays (Solid D-41). Instant 3: the answer
replaces the error; content returns.
