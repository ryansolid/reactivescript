# S-solid-6 — a new async memo a reader consumes waits with the hold (Solid S-6; D-1, F-2, #3800)

## Program

```
export default component App() {
  source count := 1
  source child := false
  slow = await fetch("slow:" + count)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>parent {count} {slow}</p> {if child {
      fast = await fetch("fast:" + count)
      <p>child {fast}</p>
    }}</div>
  }
}
```

## Frames

| instant | action                   | frame                  |
| ------- | ------------------------ | ---------------------- |
| 0       | mount                    | ``                     |
| 1       | resolve slow 1           | `parent 1 1 `          |
| 2       | handler `count := 2`     | `parent 1 1 `          |
| 3       | handler `child := true`  | `parent 1 1 `          |
| 4       | resolve fast 2           | `parent 1 1 `          |
| 5       | resolve slow 2           | `parent 2 2 child 2`   |

Instant 3: `fast` is created during the hold and reads the held `count`; the
child's reader holds its mount and joins. Instant 4: `fast` lands while the
hold is live — the answer does not show beside the parent on the old value.

## Variant: `fast` slower than `slow`

```
export default component App() {
  source count := 1
  source child := false
  slow = await fetch("slow:" + count)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>parent {count} {slow}</p> {if child {
      fast = await fetch("fast:" + count)
      <p>child {fast}</p>
    }}</div>
  }
}
```

| instant | action                   | frame                  |
| ------- | ------------------------ | ---------------------- |
| 3       | handler `child := true`  | `parent 1 1 `          |
| 4       | resolve slow 2           | `parent 1 1 `          |
| 5       | resolve fast 2           | `parent 2 2 child 2`   |

The hold also waits for the child: a reader outside a boundary consumes it
(F-2). Row E1 of Solid's table (the parent showing first) was F-8, withdrawn.
