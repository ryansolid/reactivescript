# S-solid-4 — one hole, two sources: an unrelated sync write passes through (Solid S-4; D-3)

## Program

```rx
export default component App() {
  source a := 0
  source b := 0
  detailsA = await fetch("d:" + a)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <p>{b}:{detailsA}</p>
  }
}
```

`{b}` and `{detailsA}` are two readers here; Solid's compiled hole is one.
The contrast variant below makes the dependence explicit through an
equation.

## Frames

| instant | action               | frame  |
| ------- | -------------------- | ------ |
| 0       | mount                | ``     |
| 1       | resolve detailsA 0   | `0:0`  |
| 2       | handler `a := 1`     | `0:0`  |
| 3       | handler `b := 1`     | `1:0`  |
| 4       | resolve detailsA 1   | `1:1`  |

Instant 3: `b`'s change needs no async; the reader of `detailsA` is served
the committed value (F-2: "a render effect reading a held value it can be
served shows that value and holds nothing"). `b = 1` shows beside the
stale-but-committed `detailsA`, which is not derived from `b` (H-1 intact).

## Variant: through a shared derivation the write waits

```rx
export default component App() {
  source a := 0
  source b := 0
  detailsA = await fetch("d:" + a)
  sum = b + detailsA

  errored fallback(e) { <p>error: {e.message}</p> } {
    <p>{b}:{detailsA} sum {sum}</p>
  }
}
```

| instant | action               | frame            |
| ------- | -------------------- | ---------------- |
| 0       | mount                | ``               |
| 1       | resolve detailsA 0   | `0:0 sum 0`      |
| 2       | handler `a := 1`     | `0:0 sum 0`      |
| 3       | handler `b := 1`     | `0:0 sum 0`      |
| 4       | resolve detailsA 1   | `1:1 sum 2`      |

`sum` is pending (it reads `detailsA` in σ′), so its reader holds; `b`'s
change joins `a`'s hold and `b = 1` waits with `a = 1`.
