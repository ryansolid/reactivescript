# S-region-6 — lifted calls vs instantiation

Rules exercised: E-9, E-10 (diagnostic), RG-6a, RG-6b, RG-6c.

## Program

```rx
export default component App() {
  fn double(v) => v * 2
  fn counter(ref base, step) {
    source extra := 0
    total = base + extra + step
    total
  }
  source n := 1
  d = double(n)
  t = counter(n, 10)

  <p>{d} {t}</p>
}
```

## Frames

| instant | action               | frame   |
| ------- | -------------------- | ------- |
| 0       | mount                | `2 11`  |
| 1       | handler `n := 2`     | `4 12`  |
| 2       | handler `extra := 5` | `4 17`  |
| 3       | handler `n := 3`     | `6 18`  |

`d = double(n)` is lifted: an equation over `n` (E-9). `t = counter(n, 10)`
is an instantiation: once, in a nested region (RG-6a); `base` is `n` by
reference, `step` is a snapshot (RG-6b); `extra` persists across changes
of `n` — the body did not re-run (instant 3 shows 3 + 5 + 10).

## Rejected variants

```rx
-- reject: SNAPSHOT_ARGUMENT
export default component App() {
  fn watch(v) {
    effect (v) { log(v) }
    v
  }
  source n := 1
  w = watch(n)

  <p>{w}</p>
}
```

```rx
-- reject: E-9
export default component App() {
  fn counter(ref base) {
    source extra := 0
    base + extra
  }
  source n := 1

  <p>{counter(n)}</p>
}
```
