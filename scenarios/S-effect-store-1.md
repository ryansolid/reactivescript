# S-effect-store-1 — an effect on a store fires when the store's contents change

Rules exercised: EF-1, EF-2, H-11, ST-4, AC-3, AC-4.

## Program

```rx
export default component App() {
  source rows key id = await fetch("l")
  effect (rows) { log(rows_title($0)) }
  action ren() { try { guess rows[0].title := "x"; await fetch("save"); refresh rows } catch (e) {} }
  errored fallback(e) { <p>error</p> } { loading fallback { <p>loading</p> } { <b>{for t in rows { <i>{t.title}</i> }}</b> } }
}
fn rows_title(rs) => rs.map(r => r.title).join(",")
```

`rows` is a keyed store: a guess and each new answer change it in place, so the value the effect receives is the same
object every time. EF-2 compares values, and the list's value changes when the guess shows (instant 2, H-11: an input
that derives from a guess fires with the reveal) and when the new answer lands (instant 4).

## Frames

| instant | action | frame | effect |
| ------- | ------ | ----- | ------ |
| 0 | mount | `loading` | |
| 1 | resolve "l" [{"id":1,"title":"A"},{"id":2,"title":"C"}] | `AC` | `log(A,C)` |
| 2 | handler `ren()` | `xC` | `log(x,C)` |
| 3 | resolve "save" 0 | `xC` | |
| 4 | resolve "l" [{"id":1,"title":"B"},{"id":2,"title":"C"}] | `BC` | `log(B,C)` |

Found by the timing fuzzer (round 10, r7-chain3-rx-2 seed 27): an app reported the open list's length to its tab from
`effect (filter, issues catch (e) => null)`, and the tab kept `0` with three rows on screen at rest. The compiled
runtime handed the effect the store itself, whose identity never changes, and read none of its keys, so nothing after
the first answer reran the effect. An input that is a store now enters the effect as a snapshot of the whole store
(`deep`), which tracks every key, and inputs are compared structurally, so an equal answer is still not a change.
