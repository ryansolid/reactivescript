# S-store-8 — `latest` of a store shows a guess still in flight

Rules exercised: R-12, AC-3 (path targets), ST-4, H-11.

## Program

```
export default component App() {
  source todos key id = await fetch("todos")
  shown = latest todos
  action toggle(i) {
    try { optimistic todos[i].done := true; await fetch("save") } catch {}
  }
  action rename(i) {
    try { optimistic todos[i].title := "Z"; await fetch("ren") } catch {}
  }

  errored fallback(e) { <p>error: {e.message}</p> } {
    {loading fallback { <p>loading</p> } {
      <ul>{for t in shown { <li>{t.title}{t.done ? "+" : "-"}</li> }}</ul>
    }}
  }
}
```

`latest todos` is the newest value of the store, and a guess is the newest value there is (R-12): the row the action
guesses shows done while the save is out, as it does through `todos` itself (S-store-6). When one of two guesses on
the same row is declined, the other still shows (instant 4).

## Frames

| instant | action                                                                                 | frame   |
| ------- | -------------------------------------------------------------------------------------- | ------- |
| 0       | mount                                                                                  | `loading` |
| 1       | resolve todos [{ id: 1, title: "A", done: false }, { id: 2, title: "B", done: false }] | `A-B-`  |
| 2       | handler `toggle(0)`                                                                    | `A+B-`  |
| 3       | handler `rename(0)`                                                                    | `Z+B-`  |
| 4       | reject "save" "no"                                                                     | `Z-B-`  |

Found by an agent-written desk (round 10 baseline, desk9-rx-7): S-store-7's snapshot was taken with Solid's `deep`,
which served an older frame than reads through the store: after instant 4 it still showed the declined guess (`Z+B-`),
so a declined write on a row stayed on screen while another write to that row was out. The snapshot is now copied by
reading through the store, inside `latest`, and agrees with `todos` itself.
