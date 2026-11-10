# S-check-2 — an effect writing its own source (C-3)

Rules: C-3, EF-5, ST-5.

A write in the apply block itself to a source the compute half reads is a
loop across instants and is refused. A write in a closure the apply creates
— here its cleanup — is a later event and is legal.

## Program

```rx
export default component App() {
  source n := 0
  effect (n) { log($0); return () => { n := 0 } }

  <p>{n}</p>
}
```

## Frames

| instant | action          | frame | effect   |
| ------- | --------------- | ----- | -------- |
| 0       | mount           | `0`   | log(0)   |
| 1       | handler `n := 5` | `5`  | log(5)   |
| 2       | (effect)        | `0`   | log(0)   |

Instant 1: the run for `0` is cleaned up before the run for `5`; its
cleanup writes `n := 0`, which opens instant 2 (EF-5, W-3).

## Rejected variants

```rx
-- reject: EFFECT_WRITES_OWN_SOURCE
export default component App() {
  source count := 0
  effect (count) { if ($0 > 10) count := 10 }

  <p>{count}</p>
}
```

Clamping in the apply: write `clamped = count > 10 ? 10 : count`, or clamp at
the write.

```rx
-- reject: EFFECT_WRITES_OWN_SOURCE
export default component App() {
  source items := [1, 2]
  source selected := 1
  valid = items.includes(selected)
  effect (valid) { if (!$0) selected := null }

  <p>{selected}</p>
}
```

Through an equation: `valid` reads `selected`. Derive the shown value
instead — `shown = valid ? selected : null` — or make `selected` a source
with a question over `items` (ST-5), which re-derives when `items` changes
and stays writable otherwise.

```rx
-- reject: EFFECT_WRITES_OWN_SOURCE
export default component App() {
  source n := 0
  effect (n) { try { n := n + 1 } catch (e) { } }

  <p>{n}</p>
}
```

Nested statements are still the apply's own.
