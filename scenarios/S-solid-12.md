# S-solid-12 — the committed frame keeps its inputs (Solid S-12; D-10, A30)

## Program

```rx
export default component App() {
  source fixed := false
  source count := 0
  slow = await fetch("slow:" + fixed)
  selected = fixed ? 2 : count

  errored fallback(e) { <p>error: {e.message}</p> } {
    <p>Fixed {fixed} / Count {count} / Selected {selected} / Slow {slow}</p>
  }
}
```

## Frames

| instant | action                   | frame                                              |
| ------- | ------------------------ | -------------------------------------------------- |
| 0       | mount                    | ``                                                 |
| 1       | resolve slow false       | `Fixed false / Count 0 / Selected 0 / Slow false`  |
| 2       | handler `fixed := true`  | `Fixed false / Count 0 / Selected 0 / Slow false`  |
| 3       | handler `count := 1`     | `Fixed false / Count 0 / Selected 0 / Slow false`  |
| 4       | resolve slow true        | `Fixed true / Count 1 / Selected 2 / Slow true`    |

Instant 2: `selected`'s held pass is `2` and stopped reading `count`.
Instant 3: the write still reaches `selected` through the *kept* committed
input; its pass reads the held `fixed` and joins, so `Count 1` reveals with
the hold rather than beside `Selected 0 / Fixed false`.
