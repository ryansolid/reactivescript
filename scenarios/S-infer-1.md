# S-infer-1 — a guess in a handler makes the handler an action

Rules: AC-1b, AC-1, AC-3, AC-7, H-11, R-f-6.

## Program

```rx
export default component App() {
  source liked = "no"
  source error := ""

  <button onClick={() => {
    optimistic liked := "yes"
    try {
      let r = await fetch("like")
      liked := r
    } catch (e) {
      error := e.message
    }
  }}>{liked} {error}</button>
}
```

No `action` keyword: the arrow guesses, so it is an action (AC-1b), the
same as wrapping its body in `action { … }`. The handler rows below run
that body.

## Frames

| instant | action                                                                                                   | frame  |
| ------- | -------------------------------------------------------------------------------------------------------- | ------ |
| 0       | mount                                                                                                    | `no `  |
| 1       | handler `optimistic liked := "yes"; try { let r = await fetch("like"); liked := r } catch (e) { error := e.message }` | `yes ` |
| 2       | resolve "like" "yes"                                                                                     | `yes ` |

Instant 1: the guess shows at once (H-11). Instant 2: the truth confirms
it silently and the body ends.

## Variant: the server declines

| instant | action                                                                                                   | frame        |
| ------- | -------------------------------------------------------------------------------------------------------- | ------------ |
| 0       | mount                                                                                                    | `no `        |
| 1       | handler `optimistic liked := "yes"; try { let r = await fetch("like"); liked := r } catch (e) { error := e.message }` | `yes `       |
| 2       | reject "like" "offline"                                                                                  | `no offline` |

The guess reverts and the catch's write lands in the same frame (AC-7),
as in S-action-1.

## Rejected variants

```rx
-- reject: UNCAUGHT_ACTION_FAILURE
export default component App() {
  source liked = "no"
  <button onClick={() => { optimistic liked := "yes"; let r = await fetch("like"); liked := r }}>{liked}</button>
}
```

An inferred action catches what its body can fail with, like a declared
one (R-f-6): nothing awaits a handler.

```rx
-- reject: OPTIMISTIC_OUTSIDE_HOLD
export default component App() {
  source draft := "a"
  source saved = "a"
  effect (draft) { optimistic saved := $0 }
  <p>{saved}</p>
}
```

An apply block is never inferred: its return is the effect's cleanup
(EF-5). Declare the action and call it from the block.
