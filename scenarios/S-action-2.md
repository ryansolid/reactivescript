# S-action-2 — `until`: a guess cannot confirm itself; the truth that flips the wait reveals with the action

Rules exercised: AC-6, AC-3, AC-1, H-11; Solid D-31 (`until` reads the
authoritative view), `tests/until.test.ts`.

## Program

```rx
export default component App() {
  source name := "Ann"              // the truth, as a live channel pushes it
  source shown = name
  source status := ""
  action rename(n) {
    try {
      optimistic shown := n
      await fetch("send")           // fire-and-forget: the answer is not the confirmation
      await until(() => shown == n) // the confirmation is the truth arriving
      status := "confirmed"
    } catch (e) { status := e.message }
  }
  <p>{shown} {status}</p>
}
```

`until(p)` waits until the predicate `p` settles truthy. It reads the
authoritative view: the action's own guess `shown = "Bob"` is invisible to
it, so the guess cannot satisfy the wait for its own confirmation.

## Frames

| instant | action                 | frame          |
| ------- | ---------------------- | -------------- |
| 0       | mount                  | `Ann`          |
| 1       | handler `rename("Bob")` | `Bob`         |
| 2       | resolve "send" 0       | `Bob`          |
| 3       | handler `name := "Bo"` | `Bob`          |
| 4       | handler `name := "Bob"` | `Bob confirmed` |

Instant 2: the action awaits `until`; the predicate reads `shown` as the
truth (`Ann`), so it waits. Instant 3: a truth that does not satisfy the
predicate; the guess still shows (D-34: the screen keeps the guess until the
hold commits). Instant 4: the write flips the predicate; that write joins
the action's change, the action resumes, writes `status` and returns, and
everything reveals in one frame — never `Bob` beside an unconfirmed status
after the truth arrived, and never `Ann` in between.

## Variant: the condition already holds

| instant | action                  | frame           |
| ------- | ----------------------- | --------------- |
| 1       | handler `rename("Ann")` | `Ann`           |
| 2       | resolve "send" 0        | `Ann confirmed` |

The truth is already `Ann`: `until` resolves at once.

## Rejected variants

```rx
-- reject: IO_IN_REACTIVE
export default component App() {
  source ok := false
  done = until(() => ok)
  <p>{ok}</p>
}
```

`until` waits for the world; it is called from imperative scope (Solid:
"Cannot call until inside a reactive scope").

```rx
-- reject: UNTIL_PREDICATE
export default component App() {
  source ok := false
  action wait() { await until(ok) }
  <p>{ok}</p>
}
```

The argument is a predicate, `() => e`: a value is read once, and would never
change.

```rx
-- reject: REACTIVE_WRITE_IN_OWNED_SCOPE
export default component App() {
  source ok := false
  action wait() { await until(() => { ok := true; return ok }) }
  <p>{ok}</p>
}
```

The predicate is reactive scope: it reads; it does not write.

```rx
-- reject: UNCAUGHT_ACTION_FAILURE
export default component App() {
  source id := 1
  user = await fetch("u:" + str(id))
  action wait() { await until(() => user == "x") }
  <p>{user catch (e) => ""}</p>
}
```

`until` rejects with what its predicate fails with — here `user`'s question
can fail — so the action catches it (R-f-6). A predicate that cannot fail
needs no `try` (the Program above has one only for `fetch("send")`).
