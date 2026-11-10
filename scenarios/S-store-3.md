# S-store-3 — a keyed collection reconciles: rows keep identity across a new result

Rules: ST-4, RG-2.

## Program

```rx
export default component App() {
  source rows := [{ id: 1, name: "a" }, { id: 2, name: "b" }]
  view key id = map(rows, fn(r) => { id: r.id, name: r.name + "!" })

  {for r in view {
    effect (r.name) { log(r.id, $0) }
    <p>{r.name}</p>
  }}
}
```

## Frames

| instant | action                                                              | frame     | effect             |
| ------- | ------------------------------------------------------------------- | --------- | ------------------ |
| 0       | mount                                                               | `a!b!`   | log(1, a!); log(2, b!) |
| 1       | handler `rows := [{ id: 1, name: "a" }, { id: 2, name: "B" }]`      | `a!B!`   | log(2, B!)         |
| 2       | handler `rows := [{ id: 2, name: "B" }, { id: 1, name: "a" }]`      | `B!a!`   | —                  |
| 3       | handler `rows := [{ id: 2, name: "B" }, { id: 3, name: "c" }]`      | `B!c!`   | log(3, c!)         |

Instant 1: a fresh result; row 2 keeps its object and receives the one
changed key — row 1's effect is quiet. Instant 2: a reorder moves rows,
nothing is recreated. Instant 3: row 1 is removed, row 3 created.

## Rejected variants

```rx
-- reject: UNSTABLE_LIST_IDENTITY
export default component App() {
  source rows := [{ id: 1, name: "a" }, { id: 2, name: "b" }]
  view = map(rows, fn(r) => { id: r.id, name: r.name + "!" })

  {for r in view {
    effect (r.name) { log(r.id, $0) }
    <p>{r.name}</p>
  }}
}
```

Unkeyed, every result would recreate every row (each `map` builds fresh
records, RG-2a identifies rows by element identity): ST-4b makes it a
compile error — declare `key id`.
