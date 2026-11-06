# S-solid-31 — a verdict reader's mount is mainline: a boundary it opens shows its fallback (Solid S-31; D-1, D-25, #3851)

## Program

```
export default component App() {
  source x := 0
  source gate := 0
  hold = await fetch("g:" + gate + ":" + x)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>{x}</p> {if latest x > 0 { {loading fallback { <p>fallback</p> } { <p>content {x}</p> }} }} <i>{hold}</i></div>
  }
}
```

## Frames

| instant | action               | frame                 |
| ------- | -------------------- | --------------------- |
| 0       | mount                | ``                    |
| 1       | resolve hold "g"     | `0 g`                 |
| 2       | handler `x := 1`     | `0 fallback g`         |
| 3       | resolve hold "g2"    | `1 content 1 g2`       |

Instant 2: the branch opens ahead (display-ahead); the boundary is a
mainline mount whose content read the held write — born held — so it shows
its fallback. `0 | content 1` is the torn frame.
