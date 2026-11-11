# S-store-7 — `latest` of a guessed store, read outside a `loading on` region, holds nothing

Rules exercised: R-12, H-6, ST-4, AC-3, CN-3e (its `latest` exemption).

## Program

```rx
export default component App() {
  source filter := "open"
  source rows key id = await fetch("l:" + filter)
  shown = latest rows
  action ren(i) { try { guess rows[i].title := "x"; await fetch("save") } catch (e) {} }
  errored fallback(e) { <p>error: {e.message}</p> } {
    <b>{len(shown)}</b>{loading on(filter) fallback { <p>loading</p> } { <ul>{for t in rows { <li>{t.title}</li> }}</ul> }}
  }
}
```

`shown = latest rows` is read outside the `loading on(filter)` region. `latest` never holds (R-12), so CN-3e exempts it,
and the region's fallback shows when `filter` changes (instant 2), while the outside count keeps the last answer.

## Frames

| instant | action | frame |
| ------- | ------ | ----- |
| 0 | mount | `` |
| 1 | resolve "l:open" [{"id":1,"title":"A"}] | `1A` |
| 2 | handler `filter := "closed"` | `1loading` |
| 3 | resolve "l:closed" [{"id":2,"title":"B"}] | `1B` |

Found by an agent-written desk (round 9, desk9-rx-7): `latest` lowered to Solid's `latest(() => rows)`, which hands back
the store itself, so the read of its length outside `latest` was a tracked read of the guessed store and held the
change: the region never showed its fallback. `latest` of a store now reads the whole store inside `latest` and gives
a snapshot (`deep`), in the compiled runtime and in the oracle.
