# S-solid-13 — the last on-screen reader leaving releases the hold (Solid S-13; D-9, O3)

## Program

```rx
export default component App() {
  source count := 0
  source show := true
  details = await fetch("d:" + count)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>Count {count}</p> {if show { <p>{details}</p> }}</div>
  }
}
```

## Frames

| instant | action                    | frame        |
| ------- | ------------------------- | ------------ |
| 0       | mount                     | ``           |
| 1       | resolve details 0         | `Count 0 0`  |
| 2       | handler `count := 1`      | `Count 0 0`  |
| 3       | handler `show := false`   | `Count 1 `   |

Instant 3: the gate closes; no on-screen reader derives from the flight, so
nothing holds `count = 1` any more. `details(1)` never lands in this
scenario.
