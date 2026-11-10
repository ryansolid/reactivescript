# S-store-4 — a source with a standing question: derived until written

Rules: ST-5, AC-4, E-6.

## Program

```rx
export default component App() {
  source base := 1
  source x = base * 10

  <p>{x}</p>
}
```

## Frames

| instant | action                | frame   |
| ------- | --------------------- | ------- |
| 0       | mount                 | `10`    |
| 1       | handler `x := 7`      | `7`     |
| 2       | handler `base := 2`   | `20`    |
| 3       | handler `x := 7`      | `7`     |
| 4       | handler `refresh x`   | `20`    |

Instant 1: a write overrides the equation. Instant 2: an input changed —
the next re-derivation drops the override. Instant 4: `refresh x` re-asks
the question with unchanged inputs: the override is dropped, quietly.

## Variant: an async question, re-asked quietly

```rx
export default component App() {
  source id := 1
  source profile = await fetch("p:" + str(id))

  errored fallback(e) { <p>error: {e.message}</p> } {
    <p>{profile} {pending? profile ? "p" : "-"}</p>
  }
}
```

| instant | action                      | frame     |
| ------- | --------------------------- | --------- |
| 0       | mount                       | ``        |
| 1       | resolve profile "A"         | `A -`     |
| 2       | handler `profile := "A*"`   | `A* -`    |
| 3       | handler `refresh profile`   | `A* -`    |
| 4       | resolve profile "A2"        | `A2 -`    |
| 5       | handler `id := 2`           | `A2 p`    |
| 6       | resolve profile "B"         | `B -`     |

Instant 3: the re-ask is in flight, the override still shows, nothing
pends. Instant 5: a new question pends.

## Rejected variants

```rx
-- reject: INVALID_REFRESH_TARGET
-- handler: refresh base
export default component App() {
  source base := 1

  <p>{base}</p>
}
```

A plain source has no question to re-ask.
