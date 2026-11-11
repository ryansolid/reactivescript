# S-infer-2 — a write and an await make an action; an early write must say what it means

Rules: AC-1b, AC-1c, AC-1, EF-8, W-6.

## Program

```rx
export default component App() {
  source status := ""

  <button onClick={() => {
    onFlush(() => { status := "saving" })
    let r = await fetch("save") catch (e) => e.message
    status := r
  }}>status: {status}</button>
}
```

The arrow writes `status` and awaits, so it is an action (AC-1b). The
"saving" write is a reset that should land now, so it is an `onFlush` run
of its own (EF-8): it does not wait for the save.

## Frames

| instant | action                                                                                          | frame            |
| ------- | ----------------------------------------------------------------------------------------------- | ---------------- |
| 0       | mount                                                                                           | `status: `       |
| 1       | handler `onFlush(() => { status := "saving" }); let r = await fetch("save") catch (e) => e.message; status := r` | `status: `       |
| 2       | (flush)                                                                                         | `status: saving` |
| 3       | resolve "save" "ok"                                                                             | `status: ok`     |

Instant 1: the action's change opens with nothing written yet. Instant 2:
the `onFlush` run is a change of its own and commits at once, while the
save is still out (S-flush-1).

## Variant: held on purpose

```rx
export default component App() {
  source status := ""
  action save() {
    status := "saving"
    let r = await fetch("save") catch (e) => e.message
    status := r
  }
  <button onClick={() => { save() }}>status: {status}</button>
}
```

| instant | action              | frame        |
| ------- | ------------------- | ------------ |
| 0       | mount               | `status: `   |
| 1       | handler `save()`    | `status: `   |
| 2       | resolve "save" "ok" | `status: ok` |

A declared action holds its early write (AC-1): `saving` and `ok` commit
together and compose in order (W-6), so `saving` is never on screen. That
is what the inferred form would do silently, which is why it is an error
there.

## Rejected variants

```rx
-- reject: HELD_WRITE
export default component App() {
  source status := ""
  <button onClick={() => {
    status := "saving"
    let r = await fetch("save") catch (e) => e.message
    status := r
  }}>status: {status}</button>
}
```

Written as a plain handler, this showed `saving` at once. As the action
the body now is, `saving` would wait for the server. The fixes are named
by what the write is for: `guess` for state that shows while the work
runs, `onFlush` for a reset, a declared action to hold it on purpose.

```rx
-- reject: HELD_WRITE
export default component App() {
  source saving := false
  <button onClick={() => {
    let start = () => { saving := true }
    start()
    await fetch("save") catch (e) => null
    saving := false
  }}>{saving ? "saving" : "idle"}</button>
}
```

A local closure called in the body runs its writes in this run, so the
checks follow the call.
