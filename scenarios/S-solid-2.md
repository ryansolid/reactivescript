# S-solid-2 — a memo that starts reading a held value reveals with it (Solid S-2; D-1)

## Program

```rx
export default component App() {
  source count := 0
  source show  := false
  details = await fetch("d:" + count)
  panel   = show ? count : "hidden"

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>Count {count}</p> <p>Details {details}</p> <p>Panel {panel}</p></div>
  }
}
```

## Frames

| instant | action                   | frame                                 |
| ------- | ------------------------ | ------------------------------------- |
| 0       | mount                    | ``                                    |
| 1       | resolve details 0        | `Count 0 Details 0 Panel hidden`      |
| 2       | handler `count := 1`     | `Count 0 Details 0 Panel hidden`      |
| 3       | handler `show := true`   | `Count 0 Details 0 Panel hidden`      |
| 4       | resolve details 1        | `Count 1 Details 1 Panel 1`           |

Instant 3: `panel` is an equation; its pass reads the held `count` (1 in
σ′) and so it joins the hold — `Panel 1` beside `Count 0` would reveal the
future (the ✗ row). The `show` write waits with it.
