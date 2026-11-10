# S-action-4 — two actions guessing one slot are one hold

Rules exercised: H-2, H-11, AC-1, AC-3; Solid D-8. Found by #33 (U2): native
Solid and compiled .rx show `0` at instant 3; the interpreter showed `5`.

## Program

```rx
export default component App() {
  source n := 0
  source guess = n
  action save(amount) {
    optimistic guess := value => value + amount
    try {
      let got = await fetch("r" + amount)
      n := value => value + got
    } catch (error) {}
  }
  <p>{n}</p>
}
```

## Frames

| instant | action             | frame |
| ------- | ------------------ | ----- |
| 0       | mount              | `0`   |
| 1       | handler `save(2)`  | `0`   |
| 2       | handler `save(3)`  | `0`   |
| 3       | resolve "r2" 5     | `0`   |
| 4       | resolve "r3" 0     | `5`   |

Instant 2: the second action's guess is on the slot the first action's open
guess holds. As with two writes to a held slot (H-2's second proposal), the
two holds are one. Instant 3: the first action writes `n` and returns, but
its write stays held until the shared hold commits. Instant 4: the second
action returns, the hold commits, and `n` shows `5`. The guess doesn't have
to be on screen for this.
