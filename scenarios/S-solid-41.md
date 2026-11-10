# S-solid-41 — declared lag: the write shows now, each panel lags to its own landing (Solid S-41; D-40)

## Program

```rx
export default component App() {
  source period := 1
  deferred fast = await fetch("f:" + period)
  deferred slow = await fetch("s:" + period)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><h1>Period {period}</h1> <p>fast {fast} {pending? fast}</p> <p>slow {slow} {pending? slow}</p></div>
  }
}
```

## Frames

| instant | action                  | frame                                        |
| ------- | ----------------------- | -------------------------------------------- |
| 0       | mount                   | ``                                           |
| 1       | resolve fast 1          | ``                                           |
| 2       | resolve slow 1          | `Period 1 fast 1 false slow 1 false`         |
| 3       | handler `period := 2`   | `Period 2 fast 1 true slow 1 true`           |
| 4       | resolve fast 2          | `Period 2 fast 2 false slow 1 true`          |
| 5       | resolve slow 2          | `Period 2 fast 2 false slow 2 false`         |

The first loads hold like any (instants 0–1). Instant 3: the write shows
now; nothing holds on the panels. Each landing is its own change.

## Variant: plain async equations — one hold, gated on the slowest

```rx
export default component App() {
  source period := 1
  fast = await fetch("f:" + period)
  slow = await fetch("s:" + period)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><h1>Period {period}</h1> <p>fast {fast} {pending? fast}</p> <p>slow {slow} {pending? slow}</p></div>
  }
}
```

| instant | action                  | frame                                        |
| ------- | ----------------------- | -------------------------------------------- |
| 3       | handler `period := 2`   | `Period 1 fast 1 true slow 1 true`           |
| 4       | resolve fast 2          | `Period 1 fast 1 true slow 1 true`           |
| 5       | resolve slow 2          | `Period 2 fast 2 false slow 2 false`         |

## Variant: `period` is held by another reader — a re-ask lands into that hold

```rx
export default component App() {
  source period := 1
  gate = await fetch("g:" + period)
  deferred fast = await fetch("f:" + period)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><h1>Period {period}</h1> <p>fast {fast}</p> <i>{gate}</i></div>
  }
}
```

| instant | action                  | frame                 |
| ------- | ----------------------- | --------------------- |
| 0       | mount                   | ``                    |
| 1       | resolve gate "g"        | ``                    |
| 2       | resolve fast 1          | `Period 1 fast 1 g`   |
| 3       | handler `period := 2`   | `Period 1 fast 1 g`   |
| 4       | resolve fast 2          | `Period 1 fast 1 g`   |
| 5       | resolve gate "g2"       | `Period 2 fast 2 g2`  |

`fast 2` beside `Period 1` would lead the hold (F-7); the re-ask that read
the held `period` shows with its commit.
