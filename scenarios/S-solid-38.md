# S-solid-38 — an error is a boundary returning to its fallback; a write beside an old error (Solid S-38; D-41)

## Program

```
export default component App() {
  source count := 0
  data = await fetch("d:" + count)

  <div><p>{count}</p> {errored fallback { <p>Fetch error</p> } { {loading fallback { <p>loading</p> } { <p>{data}</p> }} }}</div>
}
```

## Frames

| instant | action                  | frame             |
| ------- | ----------------------- | ----------------- |
| 0       | mount                   | `0 loading`       |
| 1       | reject data "e0"        | `0 Fetch error`   |
| 2       | handler `count := 1`    | `1 Fetch error`   |
| 3       | reject data "e1"        | `1 Fetch error`   |

Instant 2: the write publishes beside the old error; the inner `loading` is
hidden behind it — a pending is not a value, and the error fallback never
clears to show broken state underneath.
