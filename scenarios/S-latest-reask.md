# S-latest-reask — `latest` of a guessed list answers the guess after a re-ask lands under it

Rules exercised: R-12, H-7, AC-3, AC-4, ST-4.

## Program

```
export default component App() {
  source rows key id = await fetch("l")
  action close(id) { try { optimistic rows := rows.filter(r => r.id != id); await fetch("close"); refresh rows } catch (e) {} }
  errored fallback(e) { <p>error</p> } { loading fallback { <p>loading</p> } { <p>{rows.length} / {(latest rows).length}</p> } }
}
```

`latest rows` reads past any hold on `rows` but answers what `rows` shows: the guess, while its action is out (H-7).
A re-ask of the list from outside the action (instant 3) lands under the pending guess (instant 4); the guess stays,
and `latest rows` still answers it.

## Frames

| instant | action | frame |
| ------- | ------ | ----- |
| 0 | mount | `loading` |
| 1 | resolve "l" [{"id":1},{"id":2},{"id":3}] | `3 / 3` |
| 2 | handler `close(1)` | `2 / 2` |
| 3 | handler `refresh rows` | `2 / 2` |
| 4 | resolve "l" [{"id":1},{"id":2},{"id":3}] | `2 / 2` |

## Divergences (DV-19)

- oracle "Frames" instant 4: `2 / 3`

Found by the timing fuzzer on the chain4 reference desk (Solid 2.0.0-rc.21): a tab count read with `latest` showed the
server's row count beside a list with a close in flight. Filed as solidjs/solid#4689.
