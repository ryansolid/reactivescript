# S-guess-reask-refresh — a guess stays until the action's refresh lands, even after an outside re-ask landed under it

Rules exercised: AC-3, AC-4, H-11, D-35.

## Program

```
export default component App() {
  source detail = await fetch("d")
  action rename(t) { try { optimistic detail.title := t; await fetch("save"); refresh detail } catch (e) {} }
  errored fallback(e) { <p>error</p> } { loading fallback { <p>loading</p> } { <b>{detail.title}</b> } }
}
```

An action's `refresh` is authoritative work in flight: the guess waits for that answer before the body-end correction
(06 D-35; S-remount-refresh instants 3 and 8). That holds whether or not the question was re-asked from outside the
action while the guess was pending: the outside answer (instant 4) lands under the guess and leaves it; the write
landing (instant 5) ends the body, and the action's own re-ask is what corrects the guess (instant 6).

## Frames

| instant | action | frame |
| ------- | ------ | ----- |
| 0 | mount | `loading` |
| 1 | resolve "d" {"title":"Old"} | `Old` |
| 2 | handler `rename("New")` | `New` |
| 3 | handler `refresh detail` | `New` |
| 4 | resolve "d" {"title":"Old"} | `New` |
| 5 | resolve "save" 0 | `New` |
| 6 | resolve "d" {"title":"New"} | `New` |

Solid 2.0.0-rc.21 does this for a rendered reader. A store read by effects alone, with nothing rendering it, reverts
at the body's end in this sequence and shows the old truth until the re-ask lands (`ref/oracle/repros/4690-guess-reask-refresh.mjs`,
solidjs/solid#4690); any rendered reader of the store holds the effect's view too. No `.rx` program reaches it, so
no divergence is recorded.
