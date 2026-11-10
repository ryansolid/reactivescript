# S-solid-10 — a write is a proposal (Solid S-10; D-8)

## Program

```rx
export default component App() {
  source count := 0
  source show := true
  details = await fetch("d:" + count)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>{show ? details : "hidden"}</p> <p>Count {count}</p></div>
  }
}
```

## Frames

| instant | action                                   | frame             |
| ------- | ---------------------------------------- | ----------------- |
| 0       | mount                                    | ``                |
| 1       | resolve details 0                        | `0 Count 0`       |
| 2       | handler `count := 1`                     | `0 Count 0`       |
| 3       | handler `show := false; show := true`    | `0 Count 0`       |
| 4       | handler `show := false`                  | `hidden Count 1`  |

Instant 3 nets to the committed value: no proposal, `show` is not held.
Instant 4: the hide publishes, and dropping `details`' last reader releases
the hold in the same instant — `Count 1` with it.
