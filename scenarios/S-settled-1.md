# S-settled-1 — `onSettled` from a handler: after the change it started commits

Rules exercised: EF-7, EF-4, AC-1, H-2; Solid `onSettled` (unowned form).

## Program

```rx
export default component App() {
  source status := "idle"
  action save() {
    await fetch("save") catch (e) => null
    status := "saved"
  }
  <p>{status}</p>
}
```

Solid's own example: a save button whose handler launches an action and
schedules a toast for when it is done.

## Frames

| instant | action                                                   | frame   | effect                     |
| ------- | -------------------------------------------------------- | ------- | -------------------------- |
| 0       | mount                                                    | `idle`  |                            |
| 1       | handler `save(); onSettled(() => log("toast", status))`  | `idle`  |                            |
| 2       | resolve "save" 0                                         | `saved` | `log(toast, saved)`        |

Instant 1: the handler's run is the action's change (AC-1), so the callback
waits for that change. Instant 2: the action's body ends, the change
commits, and the callback runs after it, reading the committed state.

## Variant: nothing held

| instant | action                                                       | frame  | effect                |
| ------- | ------------------------------------------------------------ | ------ | --------------------- |
| 1       | handler `status := "x"; onSettled(() => log("toast", status))` | `x`  | `log(toast, x)`       |

A change that nothing holds commits at once, and the callback runs after it
in the same instant.

## Rejected variants

```rx
-- reject: IO_IN_REACTIVE
export default component App() {
  source n := 0
  ready = onSettled(() => log(n))
  <p>{n}</p>
}
```

In a component body the mount hook is `effect () { … }` (EF-4).

```rx
-- reject: SETTLED_CLEANUP_UNOWNED
export default component App() {
  source n := 0
  <button onClick={() => { onSettled(() => { return () => { log(n) } }) }}>x</button>
}
```

A callback scheduled from imperative scope has no region to bind a cleanup
to; setup with teardown is `effect () { … return () => { … } }` (EF-5).
