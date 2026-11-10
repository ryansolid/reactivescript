# S-infer-3 — a guess over an action the handler launches

Rules: AC-1b, AC-1 (D-7 adoption), AC-3, H-11.

## Program

```rx
export default component App() {
  source liked = "no"
  action like() { try { let r = await fetch("like"); liked := r } catch (e) {} }

  <button onClick={() => { optimistic liked := "yes"; like() }}>{liked}</button>
}
```

The handler has no `await`: the save is a named action it launches. The
guess makes the handler an action (AC-1b), and the action it launches is
the same instant's change (D-7), so the guess lives until `like` ends.

## Frames

| instant | action                                         | frame |
| ------- | ---------------------------------------------- | ----- |
| 0       | mount                                          | `no`  |
| 1       | handler `optimistic liked := "yes"; like()`    | `yes` |
| 2       | resolve "like" "yes"                           | `yes` |

## Variant: the server declines

| instant | action                                         | frame |
| ------- | ---------------------------------------------- | ----- |
| 0       | mount                                          | `no`  |
| 1       | handler `optimistic liked := "yes"; like()`    | `yes` |
| 2       | reject "like" "offline"                        | `no`  |
