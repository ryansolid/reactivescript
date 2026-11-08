# S-solid-27 — `[pending? x, x]` is atomic; the `latest` form follows x's own async only (Solid S-27; D-23)

## Program

```
export default component App() {
  source n := 0
  x = await fetch("x:" + n)
  y = await fetch("y:" + x)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>{str(pending? x) + "," + str(x)}</p> <p>{str(pending? latest x) + "," + str(latest x)}</p> <i>{y}</i></div>
  }
}
```

The first `<p>` is one reader with a plain read beside the probe: it holds
like `x` alone and the pair stays atomic (R-11). The second reads `x` only
through `latest`, so it follows `x`'s own async.

## Frames

| instant | action              | frame                     |
| ------- | ------------------- | ------------------------- |
| 0       | mount               | ``                        |
| 1       | resolve x "x0"      | ``                        |
| 2       | resolve y "y0"      | `false,x0 false,x0 y0`    |
| 3       | handler `n := 1`    | `true,x0 true,x0 y0`      |
| 4       | resolve x "x1"      | `true,x0 false,x1 y0`     |
| 5       | resolve y "y1"      | `false,x1 false,x1 y1`    |

Instant 4: `x(1)` landed but `y(1)` is still up, so the frame is held: the
atomic pair shows `[true, x0]` (a landed answer awaiting reveal); the
`latest` form saw `x`'s own answer — `[false, x1]`. Never `[true, x1]`.

## Variant: an equation probes `n` and reads it plainly

```
export default component App() {
  source n := 0
  x = 1 + n + (pending? n ? 1 : 0)
  action save() { try { n := 5; await fetch("save") } catch {} }

  <div><p>x {x}</p></div>
}
```

| instant | action              | frame     |
| ------- | ------------------- | --------- |
| 0       | mount               | `x 1`     |
| 1       | handler `save()`    | `x 2`     |
| 2       | resolve "save" 0    | `x 6`     |

Solid S-27's memo case (D-25, decision 1 of solidjs/solid#4695): posture is
per read. The plain read of `n` beside its probe in the same pass is the
screen's `0`, in either order, and the probe is `true`: `x 2` shows now and
the equation is not the hold's work (R-11). `x 7` (the plain read seeing the
held `5`) and `x 1` (the equation held with the write it probed) are both
wrong.

## Variant: an equation probes `n` and reads another held value plainly

```
export default component App() {
  source n := 0
  source k := 0
  x = 1 + k + (pending? n ? 1 : 0)
  action save() { try { n := 5; k := 1; await fetch("save") } catch {} }

  <div><p>x {x}</p></div>
}
```

| instant | action              | frame     |
| ------- | ------------------- | --------- |
| 0       | mount               | `x 1`     |
| 1       | handler `save()`    | `x 1`     |
| 2       | resolve "save" 0    | `x 2`     |

The plain read of `k`, which the action holds, makes the pass the hold's
work (R-11; Solid D-25): the probe beside it does not let it show ahead.

## Divergences (DV-21)

- oracle "Variant: an equation probes `n` and reads another held value plainly" instant 1: `x 2`

Solid ruled this in #4695 (D-25, S-49 and S-50, ruled, not built): today one
probe in a pass makes the whole pass a display-ahead reader, so the plain read
of `k` is served the screen's `0` and the equation shows now.
