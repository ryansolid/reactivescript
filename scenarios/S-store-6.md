# S-store-6 — An optimistic path write: a guess per key, confirmed by the re-ask

Rules exercised: AC-3 (path targets), ST-2c, ST-4, ST-5, AC-4, H-11; Solid
D-34 (`createOptimisticStore`).

## Program

```rx
export default component App() {
  source todos key id = await fetch("todos")
  action toggle(i) {
    try { optimistic todos[i].done := true; await fetch("save"); refresh todos } catch {}
  }

  errored fallback(e) { <p>error: {e.message}</p> } {
    {loading fallback { <p>loading</p> } {
      <ul>{for t in todos { <li>{t.title}{t.done ? "+" : "-"}</li> }}</ul>
      <p>{pending? todos ? "p" : "."}</p>
    }}
  }
}
```

`optimistic todos[i].done := true` guesses one key of one row; the rest of
`todos` is the truth beneath it. The action saves, then re-asks the list
(`refresh todos`) for the truth that confirms the guess.

## Frames

| instant | action                                                                                   | frame      |
| ------- | ---------------------------------------------------------------------------------------- | ---------- |
| 0       | mount                                                                                    | `loading`  |
| 1       | resolve todos [{ id: 1, title: "A", done: false }, { id: 2, title: "B", done: false }]   | `A-B-.`    |
| 2       | handler `toggle(0)`                                                                      | `A+B-.`    |
| 3       | resolve "save" 0                                                                         | `A+B-.`    |
| 4       | resolve todos [{ id: 1, title: "A", done: true }, { id: 2, title: "B", done: true }]     | `A+B+.`    |

Instant 2: the guess shows at once and is verdict-inert (`pending?` stays
false). Instant 3: the body has returned, but the guess's own question is
being re-asked, so nothing corrects it yet (D-34: a guess whose source is
still answering waits for that answer). The re-ask is quiet (AC-4).
Instant 4: the truth agrees at the guessed key — a silent confirm — and
brings `B` done as well (another tab); everything the action held reveals
in one frame.

## Variant: the truth disagrees — the guess is corrected at the commit

| instant | action                                                                                   | frame      |
| ------- | ---------------------------------------------------------------------------------------- | ---------- |
| 4       | resolve todos [{ id: 1, title: "A", done: false }, { id: 2, title: "B", done: false }]   | `A-B-.`    |

## Variant: the save fails — the guess reverts to the truth at hand

| instant | action                    | frame      |
| ------- | ------------------------- | ---------- |
| 3       | reject "save" "boom"      | `A-B-.`    |

The catch takes the rejection inside the action; the body returns without
re-asking, and nothing authoritative is in flight, so the guess is
corrected by the truth it was made over (D-34).

## Variant: a path guess on a record

```rx
export default component App() {
  source id := 1
  source state = await fetch("s:" + str(id))
  action patch() { try { optimistic state.a := 5; await fetch("w") } catch {} }

  errored fallback(e) { <p>error: {e.message}</p> } {
    {loading fallback { <p>loading</p> } { <p>{state.a} {state.b} {pending? state.a ? "a!" : "-"} {pending? state.b ? "b!" : "-"}</p> }}
  }
}
```

| instant | action                        | frame          |
| ------- | ----------------------------- | -------------- |
| 0       | mount                         | `loading`      |
| 1       | resolve state { a: 1, b: 1 }  | `1 1 - -`      |
| 2       | handler `patch()`             | `5 1 - -`      |
| 3       | resolve "w" 0                 | `1 1 - -`      |

Beside S-solid-37's row 2′ (a held *plain* path write: `1 1 a! -`): the
guess shows now and pends nothing. Nothing re-asks `state`, so at the
body's end the guess reverts to the truth.

## Rejected variants

```rx
-- reject: OPTIMISTIC_NO_QUESTION
export default component App() {
  source todos: { done: boolean }[] := [{ done: false }]
  action toggle(i) { try { optimistic todos[i].done := true; await fetch("save") } catch {} }

  <p>{len(todos)}</p>
}
```

A path guess is a guess: its source needs a question to confirm it.
