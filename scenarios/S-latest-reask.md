# S-latest-reask — `latest` of a shown guess keeps the guess after a re-ask lands under it

Rules exercised: R-12, H-7, H-11, AC-3, AC-4, ST-4.

## Program

```
export default component App() {
  source rows key id = await fetch("l")
  action close(id) { try { optimistic rows := rows.filter(r => r.id != id); await fetch("close"); refresh rows } catch (e) {} }
  errored fallback(e) { <p>error</p> } { loading fallback { <p>loading</p> } { <p>{rows.length} / {(latest rows).length}</p> } }
}
```

A re-ask of the list from outside the action (instant 3) lands under the pending guess (instant 4). It answers the
guess's own question and differs from the guess, so it corrects the graph now (H-11, D-34): derivations re-derive from
the truth. But the slot still displays the guess, and `latest rows` answers what the slot displays: the guess, until
the hold commits (H-11; Solid D-22 and D-34, decision 3 of solidjs/solid#4695). The write landing (instant 5) ends the
body with the action's `refresh rows` in flight, so nothing commits yet (D-35); the re-ask's answer commits it all
(instant 6).

## Frames

| instant | action | frame |
| ------- | ------ | ----- |
| 0 | mount | `loading` |
| 1 | resolve "l" [{"id":1},{"id":2},{"id":3}] | `3 / 3` |
| 2 | handler `close(1)` | `2 / 2` |
| 3 | handler `refresh rows` | `2 / 2` |
| 4 | resolve "l" [{"id":1},{"id":2},{"id":3}] | `2 / 2` |
| 5 | resolve "close" 0 | `2 / 2` |
| 6 | resolve "l" [{"id":2},{"id":3}] | `2 / 2` |

## Variant: the outside answer changes the truth

The same program. The outside re-ask brings a row the guess did not see (instant 4): the graph is corrected, the screen
and `latest rows` keep the guess, and the closed row does not come back when the write lands under the action's
refresh (instant 5). The re-ask's answer commits the server's list (instant 6).

| instant | action | frame |
| ------- | ------ | ----- |
| 0 | mount | `loading` |
| 1 | resolve "l" [{"id":1},{"id":2},{"id":3}] | `3 / 3` |
| 2 | handler `close(1)` | `2 / 2` |
| 3 | handler `refresh rows` | `2 / 2` |
| 4 | resolve "l" [{"id":1},{"id":2},{"id":3},{"id":4}] | `2 / 2` |
| 5 | resolve "close" 0 | `2 / 2` |
| 6 | resolve "l" [{"id":2},{"id":3},{"id":4}] | `3 / 3` |

## Divergences (DV-19)

- oracle "Frames" instant 4: `2 / 3`
- oracle "Frames" instant 5: `2 / 3`
- oracle "Variant: the outside answer changes the truth" instant 4: `2 / 4`
- oracle "Variant: the outside answer changes the truth" instant 5: `2 / 4`

Found by the timing fuzzer on the chain4 reference desk (Solid 2.0.0-rc.21): a tab count read with `latest` showed the
server's row count beside a list with a close in flight. Filed as solidjs/solid#4689; Solid ruled it (decision 3 in
#4695, D-22: "a slot that is displaying a guess has the guess as its newest value"), not built yet. The variant was
found reviewing PR #31: an earlier interpreter change let the closed row come back at instant 5 (`4 / 4`).
