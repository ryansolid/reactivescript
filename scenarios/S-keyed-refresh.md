# S-keyed-refresh — `refresh` re-asks a keyed equation, and a guess beside it waits for that answer

Rules exercised: AC-4, ST-4, H-11, D-34.

## Program

```rx
export default component App() {
  rows key id = await fetch("l")
  source marks: number[] = []
  action mark(id: number) {
    try {
      guess marks := ms => [...ms, id]
      await fetch("save")
    } catch (e) {}
    refresh rows
  }
  errored fallback(e) { <p>error</p> } {
    loading fallback { <p>loading</p> } {
      <b>{for r in rows { <i>{r.title}{marks.includes(r.id) ? "*" : ""}</i> }}</b>
    }
  }
}
```

The guess is on `marks`, a list of its own with a constant question; the action ends by re-asking `rows`, a keyed
equation. The re-ask is the action's (AC-4), so its change, and the guess with it, stays up until the list lands
(D-34): the mark never blinks out before the server's answer shows.

## Frames

| instant | action | frame |
| ------- | ------ | ----- |
| 0 | mount | `loading` |
| 1 | resolve "l" [{"id":1,"title":"A"}] | `A` |
| 2 | handler `mark(1)` | `A*` |
| 3 | resolve "save" 0 | `A*` |
| 4 | resolve "l" [{"id":1,"title":"B"}] | `B` |

Found writing the desk9 reference (2026-11-13): the compiled runtime's `keyed` returned the projection's accessor
without registering the memo under it, so `refresh rows` re-asked nothing. The action ended at once, the guess went
with it, and the row showed unmarked with no request in the air (instant 3 read `A`).
