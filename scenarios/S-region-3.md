# S-region-3 — rows by identity; reorder moves, remove/add resets

Rules exercised: RG-2a, RG-2b, RG-2c, E-4.

## Program

```rx
export default component App() {
  source a := { id: "a" }
  source b := { id: "b" }
  source c := { id: "c" }
  source items := []

  <ul>
    {for item in items {
      source hits := 0
      <li>{item.id}:{hits}</li>
    }}
  </ul>
}
```

Row-local writes: `hits` is addressed through the row's region. For the
scenario, the action `handler` form `rows[i].hits := n` is not available in
phase 1; instead the row keeps `hits` at its initializer and identity is
observed through region creation (the `(new)` marker is not rendered). Row
state is exercised in S-region-5 once row-addressed writes exist.

## Frames

| instant | action                               | frame           |
| ------- | ------------------------------------ | --------------- |
| 0       | mount                                | ``              |
| 1       | handler `items := [a, b, c]`         | `a:0b:0c:0`     |
| 2       | handler `items := [c, a, b]`         | `c:0a:0b:0`     |
| 3       | handler `items := [c, b]`            | `c:0b:0`        |
| 4       | handler `items := [c, b, a]`         | `c:0b:0a:0`     |
| 5       | handler `items := [a, a]`            | `a:0a:0`        |
| 6       | handler `a.id := "A"`                | `A:0A:0`        |

Instant 6: a path write to `a` reaches both rows' readers of `item.id`
without recreating either row — `item` is a constant bound to the same
object (RG-2b), and the reader tracks the path through it.
