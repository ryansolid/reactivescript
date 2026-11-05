# S-latest-reask — `latest` of a guessed list answers the truth once a re-ask lands under the guess

Rules exercised: R-12, H-7, H-11, AC-3, AC-4, ST-4.

## Program

```
export default component App() {
  source rows key id = await fetch("l")
  action close(id) { try { optimistic rows := rows.filter(r => r.id != id); await fetch("close"); refresh rows } catch (e) {} }
  errored fallback(e) { <p>error</p> } { loading fallback { <p>loading</p> } { <p>{rows.length} / {(latest rows).length}</p> } }
}
```

`latest rows` reads past the guess's hold and answers what the graph holds: the guess, until an answer of `rows`'s
question lands that differs from it. A re-ask from outside the action (instant 3) lands under the pending guess
(instant 4) with the rows the server still has: that is a new answer, different from the guess at the guessed key,
so it corrects the graph now and `latest rows` is the truth (H-11, D-34), even though it equals the truth the guess
was made over. The screen keeps the guess until the hold commits. So a count read with `latest` beside a guessed list
is not the count the list shows; read the list where the list is read (under its boundary) for that.

## Frames

| instant | action | frame |
| ------- | ------ | ----- |
| 0 | mount | `loading` |
| 1 | resolve "l" [{"id":1},{"id":2},{"id":3}] | `3 / 3` |
| 2 | handler `close(1)` | `2 / 2` |
| 3 | handler `refresh rows` | `2 / 2` |
| 4 | resolve "l" [{"id":1},{"id":2},{"id":3}] | `2 / 3` |
| 5 | resolve "close" 0 | `2 / 3` |
| 6 | resolve "l" [{"id":2},{"id":3}] | `2 / 2` |

Found by the timing fuzzer on the chain4 reference desk (Solid 2.0.0-rc.21). The spec first said `latest` kept the
guess here (DV-19, filed as solidjs/solid#4689); ruled 2026-11-05 by adopting Solid's position, as for DV-10.

## Variant: the outside answer differs, then the write lands under the action's refresh

The same program. The outside re-ask brings a row the guess did not see (instant 4): a different answer at the guessed
key corrects the graph now, so `latest rows` answers the truth while the screen keeps the guess (H-11, D-34). The
write landing (instant 5) ends the body with the action's `refresh rows` in flight, so the corrected guess still
waits for that answer (D-35): the closed row does not come back. The re-ask's answer commits it all (instant 6).

| instant | action | frame |
| ------- | ------ | ----- |
| 0 | mount | `loading` |
| 1 | resolve "l" [{"id":1},{"id":2},{"id":3}] | `3 / 3` |
| 2 | handler `close(1)` | `2 / 2` |
| 3 | handler `refresh rows` | `2 / 2` |
| 4 | resolve "l" [{"id":1},{"id":2},{"id":3},{"id":4}] | `2 / 4` |
| 5 | resolve "close" 0 | `2 / 4` |
| 6 | resolve "l" [{"id":2},{"id":3},{"id":4}] | `3 / 3` |

Found reviewing PR #31: the interpreter showed `4 / 4` at instant 5 (a correction dropped the action's guess, so its
re-ask no longer held it). Solid 2.0.0-rc.21 shows `2 / 4` there.
