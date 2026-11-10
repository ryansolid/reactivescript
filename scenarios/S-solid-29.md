# S-solid-29 — a verdict reader's own async is held (Solid S-29; D-25, #3442)

## Program

```rx
export default component App() {
  source n := 0
  fast = await fetch("f:" + n)
  slow = await fetch("s:" + n)
  copy = slow

  errored fallback(e) { <p>error: {e.message}</p> } {
    <p>Fast {fast} / Slow {copy} / Pending {str(pending? [fast, copy])}</p>
  }
}
```

`pending? e` over a composite: the verdict of the reads inside it.

## Frames

| instant | action              | frame                                  |
| ------- | ------------------- | -------------------------------------- |
| 0       | mount               | ``                                     |
| 1       | resolve fast 0      | ``                                     |
| 2       | resolve slow 0      | `Fast 0 / Slow 0 / Pending false`      |
| 3       | handler `n := 1`    | `Fast 0 / Slow 0 / Pending true`       |
| 4       | resolve fast 1      | `Fast 0 / Slow 0 / Pending true`       |
| 5       | resolve slow 1      | `Fast 1 / Slow 1 / Pending false`      |

Instant 4: `copy` computes under its own posture — still pending on `slow`;
`Fast 1 / Slow 0 / Pending false` is the rejected screen.
