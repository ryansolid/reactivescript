# S-solid-14 — a fresh boundary a separate change mounts over a held value shows its fallback now (Solid S-14; D-12)

## Program

```rx
export default component App() {
  source count := 0
  source open := false
  slow = await fetch("slow:" + count)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>Count {count}</p> <p>Slow {slow}</p> {if open {
      m = count
      {loading fallback { <p>fallback</p> } { <p>count {m}</p> }}
    }}</div>
  }
}
```

## Frames

| instant | action                 | frame                        |
| ------- | ---------------------- | ---------------------------- |
| 0       | mount                  | ``                           |
| 1       | resolve slow 0         | `Count 0 Slow 0 `            |
| 2       | handler `count := 1`   | `Count 0 Slow 0 `            |
| 3       | handler `open := true` | `Count 0 Slow 0 fallback`    |
| 4       | resolve slow 1         | `Count 1 Slow 1 count 1`     |

Instant 3: `m` is born held (its only value is in `count`'s hold); its read
under a fresh boundary is caught, so it holds nothing, `open`'s change
never entangles with the hold, and its frame shows now — with the fallback.
Instant 4: the content arrives with the hold's commit.

## Variant: a plain read beside the boundary holds the mount (2b)

```rx
export default component App() {
  source count := 0
  source open := false
  slow = await fetch("slow:" + count)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>Count {count}</p> <p>Slow {slow}</p> {if open {
      m = count
      <span>{m}</span>
      {loading fallback { <p>fallback</p> } { <p>count {m}</p> }}
    }}</div>
  }
}
```

| instant | action                 | frame                        |
| ------- | ---------------------- | ---------------------------- |
| 3       | handler `open := true` | `Count 0 Slow 0 `            |
| 4       | resolve slow 1         | `Count 1 Slow 1 1count 1`    |

The span's read of `m` is not caught; it holds `open`'s frame, the branch
appears at the commit, and the fallback is never seen.
