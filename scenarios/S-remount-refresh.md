# S-remount-refresh — a refresh after a remount re-asks only the live mount's question

Rules exercised: AC-4, H-11, ST-4, O-2.

## Program

```
component List() {
  source rows key id = tag(await fetch("l"))
  action ren() { try { optimistic rows[0].title := "x"; await fetch("save"); refresh rows } catch (e) {} }
  errored fallback(e) { <p>error</p> } { loading fallback { <p>loading</p> } { <b>{for r in rows { <i>{r.title}</i> }}</b> } }
}
fn tag(rs) => rs.map(r => ({ id: r.id, title: r.title, seen: true }))
export default component App() {
  source tab := "list"
  {if tab == "list" { <List /> } else { <p>help</p> }}
}
```

`rows` awaits inside a call, so its question is asked by a hoisted await (07 §3) that `refresh rows` re-asks with it.
The first mount's action is still waiting on its re-ask when the tab is left (instant 4); the new mount asks the same
question and one answer serves both (instant 6). The new mount's action re-asks that mount's question only, and its
guess ends when that answer lands (instant 9).

## Frames

| instant | action | frame |
| ------- | ------ | ----- |
| 0 | mount | `loading` |
| 1 | resolve "l" [{"id":1,"title":"A"}] | `A` |
| 2 | handler `ren()` | `x` |
| 3 | resolve "save" 0 | `x` |
| 4 | handler `tab := "help"` | `help` |
| 5 | handler `tab := "list"` | `loading` |
| 6 | resolve "l" [{"id":1,"title":"B"}] | `B` |
| 7 | handler `ren()` | `x` |
| 8 | resolve "save" 0 | `x` |
| 9 | resolve "l" [{"id":1,"title":"C"}] | `C` |

Found by the timing fuzzer (round 10, r7-chain4-rx-2 seed 49): after leaving the Issues tab and coming back, a declined
close's row stayed hidden and the detail stayed on "loading" at rest. The compiled runtime and the oracle kept an
equation's hoisted awaits by name for the whole app, so `refresh` also re-asked the disposed mount's question, which
never answers: the action never ended and its change held every guess on the store. They are now kept per instance.
