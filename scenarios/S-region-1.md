# S-region-1 — a branch with a source resets on re-entry

Rules exercised: RG-1a, RG-1b, E-4, O-2.

## Program

```rx
export default component App() {
  source open := true

  <div>
    {if open {
      source clicks := 0
      <p>{clicks}</p>
    } else { <p>closed</p> }}
  </div>
}
```

(`source` inside a view branch declares into the branch region; the handler
writes the branch-local source by name while the branch is live.)

## Frames

| instant | action                     | frame    |
| ------- | -------------------------- | -------- |
| 0       | mount                      | `0`      |
| 1       | handler `clicks := 3`      | `3`      |
| 2       | handler `open := false`    | `closed` |
| 3       | handler `open := true`     | `0`      |
| 4       | handler `open := 1`        | `0`      |

Instant 3: the branch region was disposed at 2 and recreated at 3; `clicks`
re-ran its initializer (RG-1a). Instant 4: truthy→truthy does not switch
(RG-1b); `clicks` keeps 0 from instant 3's fresh region.

## Rejected variants

```rx
-- reject: W-1
-- handler: total := 2
export default component App() {
  source open := true
  <div>
    {if open {
      total = 1
      <p>{total}</p>
    }}
  </div>
}
```
