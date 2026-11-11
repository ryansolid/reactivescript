# S-guess-equation-store — a guess by path over a keyed equation (Solid `createOptimisticStore(fn, seed)`)

Rules: AC-3, ST-5c, ST-4, H-11, D-34.

## Program

```rx
export default component App() {
  source todos key id = await fetch("todos")
  open key id = todos.filter(t => !t.done)
  action finish(i) {
    try { guess open[i].title := "…"; await fetch("save"); refresh todos } catch {}
  }

  errored fallback(e) { <p>error: {e.message}</p> } {
    {loading fallback { <p>loading</p> } {
      <ul>{for t in open { <li>{t.title}</li> }}</ul>
      <p>{len(todos)}</p>
    }}
  }
}
```

`open` is a keyed equation, never written. A guess by path sits over one
row of it (ST-5c), as Solid's `createOptimisticStore(fn, seed)` with the
filter as its derive: the rest of `open` is the truth beneath the guess.
`todos`, the source it is derived from, does not move.

## Frames

| instant | action                                                                                   | frame      |
| ------- | ---------------------------------------------------------------------------------------- | ---------- |
| 0       | mount                                                                                    | `loading`  |
| 1       | resolve todos [{ id: 1, title: "A", done: false }, { id: 2, title: "B", done: false }]   | `AB2`      |
| 2       | handler `finish(0)`                                                                      | `…B2`      |
| 3       | resolve "save" 0                                                                         | `…B2`      |
| 4       | resolve todos [{ id: 1, title: "A2", done: false }, { id: 2, title: "B", done: false }]  | `A2B2`     |

Instant 2: the guess shows on the one row. Instant 3: the re-ask of
`todos` is in flight, and `open` follows it, so the guess waits for that
answer (D-34). Instant 4: the answer differs at the guessed key, so it
corrects the row, and the action's change commits in one frame.

## Variant: the save fails

| instant | action                    | frame      |
| ------- | ------------------------- | ---------- |
| 3       | reject "save" "boom"      | `AB2`      |

Nothing is re-asked, so the guess gives way to the truth at hand (D-34).
