# S-solid-3 — a mount during a hold: a derivation born held holds the mount (Solid S-3; D-1, D-3)

The branch is opened by a write instead of a click; `title` is the
unrelated mainline write of Solid's row 3.

## Program

```rx
export default component App() {
  source x := 0
  source show := false
  source title := ""
  slow = await fetch("slow:" + x)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><h1>{x}</h1> <i>{slow}</i> <b>{title}</b> {if show {
      m = x * 10
      <p>{m} {x}</p>
    }}</div>
  }
}
```

## Frames

| instant | action                   | frame            |
| ------- | ------------------------ | ---------------- |
| 0       | mount                    | ``               |
| 1       | resolve slow 0           | `0 0 `           |
| 2       | handler `x := 1`         | `0 0 `           |
| 3       | handler `show := true`   | `0 0 `           |
| 4       | handler `title := "t"`   | `0 0 t`          |
| 5       | resolve slow 1           | `1 1 t 10 1`     |

Instant 3: `m` reads the held `x`, so `<p>{m}</p>` joins the hold and the
branch is not attached (`p 10` beside `h1 0` would publish the future; `p 0`
is a value `m` never had). Instant 4: an unrelated write shows at once —
not swallowed into the hold (D-3).
