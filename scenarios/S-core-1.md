# S-core-1 — the counter

Rules exercised: E-1, E-2, E-4, E-6, W-1, W-2, W-3, C-2, C-2a, EF-2, EF-4, P-6.

## Program

```rx
export default component App() {
  source count := 0
  source show := true
  double = count * 2
  label  = "prev " + pre double -> 0
  effect (double) { log(double) }

  <p>{show ? double : "-"} {label}</p>
}
```

## Frames

| instant | action                           | frame        | effect    |
| ------- | -------------------------------- | ------------ | --------- |
| 0       | mount                            | `0 prev 0`   | `log(0)`  |
| 1       | handler `count := 1`             | `2 prev 0`   | `log(2)`  |
| 2       | handler `count := 1`             | `2 prev 0`   | —         |
| 3       | handler `count := 5; count := 7` | `14 prev 2`  | `log(14)` |
| 4       | handler `show := false`          | `- prev 2`   | —         |
| 5       | handler `count := 8`             | `- prev 14`  | `log(16)` |

## Variant: no effect (`double` undemanded while `show` is false)

```rx
export default component App() {
  source count := 0
  source show := true
  double = count * 2
  label  = "prev " + pre double -> 0

  <p>{show ? double : "-"} {label}</p>
}
```

| instant | action                  | frame       |
| ------- | ----------------------- | ----------- |
| 4       | handler `show := false` | `- prev 2`  |
| 5       | handler `count := 8`    | `- prev 14` |

`pre double` demands `double` (C-2), so `double` is evaluated even while no
reader shows it, and `pre` is its value before its last change — `14` —
whether or not that change was on screen. (Ruled 2026-10-23, DV-5: Solid's
evaluation-indexed `pre`; the earlier frame-indexed rule gave `prev 0`
here and `prev 2` / `prev 14` at instants 2 and 4 of the main table.)

## Rejected variants

```rx
-- reject: W-1
source count := 0
double = count * 2
effect (count) { double := 4 }
```

```rx
-- reject: W-2
source count := 0
count := 1
```

```rx
-- reject: C-1
export default component App() {
  source s := 0
  a = b + 1
  b = a + 1

  <p>{a}</p>
}
```
