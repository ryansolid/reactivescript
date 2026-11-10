# S-infer-5 — a run never reads its own write

Rules: AC-1d, W-4, H-10, W-6; Solid 2.0.0-rc.19: an `action()` that writes a signal, yields, and reads it again gets the old value until the action commits.

## Program

```rx
export default component App() {
  source count := 0
  source seen := 0

  <button onClick={() => { let n = count + 1; count := n; seen := n }}>{count} {seen}</button>
}
```

## Frames

| instant | action                                           | frame |
| ------- | ------------------------------------------------ | ----- |
| 0       | mount                                            | `0 0` |
| 1       | handler `let n = count + 1; count := n; seen := n` | `1 1` |

The value written is kept in a local and read from there.

## Rejected variants

```rx
-- reject: STALE_OWN_READ
export default component App() {
  source count := 0
  source seen := 0
  <button onClick={() => { count := count + 1; seen := count }}>{count} {seen}</button>
}
```

`seen := count` would read `0`: a write is not visible in the run that
made it (W-4). The checker can see the run's own writes, so this read is
an error; a read of anything else is the committed snapshot it always was.

```rx
-- reject: STALE_OWN_READ
export default component App() {
  source seq := 0
  source busy := false
  action save() {
    let n = seq + 1
    seq := n
    try { await fetch("save") } catch (e) {}
    if (seq == n) { busy := false }
  }
  <button onClick={() => { save() }}>{seq}</button>
}
```

In an action the change lasts the whole body, so after the `await` the run
still reads the old `seq` and the comparison is always false. Solid does
the same. A plain handler's change ends at its `await`, so there the read
would see the committed write; but a handler that writes and awaits is
now an action (AC-1b).

```rx
-- reject: STALE_OWN_READ
export default component App() {
  source form := { name: "", email: "" }
  <button onClick={() => { form.name := "Ann"; log(form.name) }}>{form.name}</button>
}
```

Keys count: after `form.name := …`, reading `form.name` or `form` is
stale; reading `form.email` is not.
