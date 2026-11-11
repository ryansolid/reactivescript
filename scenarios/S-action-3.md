# S-action-3 — a functional guess applies to the screen, not to the handler's held write

Rules exercised: AC-1, AC-3, H-11, W-6. Found by #33 (U1): native Solid and
compiled .rx show `1` at instant 1; the interpreter showed `3`.

## Program

```rx
export default component App() {
  source n := 0
  source guess = n
  action save() {
    guess guess := value => value + 1
    try { await fetch("r1") } catch (error) {}
  }
  <p>{guess}</p>
}
```

## Frames

| instant | action                   | frame |
| ------- | ------------------------ | ----- |
| 0       | mount                    | `0`   |
| 1       | handler `n := 2; save()` | `1`   |
| 2       | resolve "r1" 0           | `2`   |

Instant 1: the handler's write to `n` is the action's, held with it (AC-1),
so the screen still shows the old answer `0`. The functional guess applies to
the value the screen shows (W-6 applied to the guess's slot), so it guesses
`1`, not `n`'s held `2` plus one. Instant 2: the action returns; its hold
commits `n := 2`, which ends the guess and shows the truth in the same frame
(H-11).
