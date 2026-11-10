# S-effect-store-2 — an effect on a store under `catch` follows the store back from an error

Rules exercised: EF-1, EF-2, E-12, ST-4, AC-4.

## Program

```rx
export default component App() {
  source rows key id = await fetch("l")
  effect (rows catch (e) => null) { log($0 == null ? "none" : len($0)) }
  errored fallback(e) { <p>error</p> } { loading fallback { <p>loading</p> } { <b>{len(rows)}</b> } }
}
```

The effect reads `rows` through `catch`, so a failed answer reaches it as `null` (instant 3). The next answer
(instant 5) is a store again, with different contents, and the apply runs with it.

## Frames

| instant | action | frame | effect |
| ------- | ------ | ----- | ------ |
| 0 | mount | `loading` | |
| 1 | resolve "l" [{"id":1},{"id":3},{"id":4}] | `3` | `log(3)` |
| 2 | handler `refresh rows` | `3` | |
| 3 | reject "l" "down" | `error` | `log(none)` |
| 4 | handler `refresh rows` | `error` | |
| 5 | resolve "l" [{"id":1},{"id":4}] | `2` | `log(2)` |

Found by the timing fuzzer (round 10, r7-chain3-rx-2 seed 27): an app reported the open list's length to its tab from
`effect (filter, issues catch (e) => null)`; after a failed answer the tab kept its last count with three rows on
screen at rest. `catch` in an equation lowers to an error boundary around the read, and the read of a store returned
the store without reading any of its keys, so once the boundary had caught the failure nothing it tracked changed again.
The boundary now reads a store's keys (as `pending?` does), and an effect input that is a store enters whole, as a
snapshot (S-effect-store-1).

## Variant: the first answer fails

| instant | action | frame | effect |
| ------- | ------ | ----- | ------ |
| 1 | reject "l" "down" | `error` | `log(none)` |
| 2 | handler `refresh rows` | `error` | |
| 3 | resolve "l" [{"id":1},{"id":4}] | `2` | `log(2)` |
