# S-solid-50 — an equation that probed once, re-run by a plain write, holds the instant (Solid S-50; D-25)

Rules: H-3a, H-7, R-11.

## Program

```rx
export default component App() {
  source x := 0
  source k := 0
  source probe := true
  m = 1 + k + (probe ? (pending? x ? 1 : 0) : 0) + x
  action save() { try { x := 1; await fetch("save") } catch {} }

  <div><p>m {m}</p> <p>k {k}</p></div>
}
```

## Frames

| instant | action                              | frame       |
| ------- | ----------------------------------- | ----------- |
| 0       | mount                               | `m 1 k 0`   |
| 1       | handler `save()`                    | `m 2 k 0`   |
| 2       | handler `probe := false; k := 1`    | `m 2 k 0`   |
| 3       | resolve "save" 0                    | `m 3 k 1`   |

Instant 1: the pass probes `x` and reads it plainly; the plain read is the
screen's `0` and the probe is `true`, shown now (R-11; Solid S-27's memo
case). Instant 2: this pass probes nothing, so its read of `x` is a plain read
of the held write: `m` is the hold's work, and the instant that wrote `k`
joins the hold through it (H-3a). A posture is never carried into the next
pass: `m 2 k 1` here would be the probe of the last pass leaking into this one.

## Divergences (DV-21)

- oracle "Frames" instant 2: `m 2 k 1`

Solid ruled this row in #4695 (S-50, ruled, not built).
