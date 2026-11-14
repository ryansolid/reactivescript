# desk9 reference: XState v5 + React 19

Grades 0: hidden 77/77, overlap 38/38, fuzz 0/20 (`--r9`). 1140 lines.

- Pages are actors invoked by `appMachine` per tab; leaving a tab stops the page and its writes.
- Reads are `fromPromise` invokes in parallel regions; writes are spawned callback actors (`mutation.ts`).
- Pending writes kept in context for the page's lifetime and laid over every load; newest accepted write per field wins.

Pitfalls an agent may hit: `reenter: true` on a region of a parallel state restarts its siblings (reloads the list on
select); spawned actors' done/error events are untyped.

Brief ambiguities seen (none tested): `assign` error prefix; related-help query after an optimistic rename; a failed
save overtaken by a newer accepted save; inputs not cleared on selection; clicking the open tab does not reset it.
