# S-fail-1 — typed failures: a class becomes a value, a typed boundary takes its class, another class passes it

Rules: R-f-1, R-f-3, R-f-4, R-f-5, H-12, D-41.

## Program

```rx
error BadId(id) => `bad id ${id}`
error NotFound(id) => `no user ${id}`
source id := 1
user = id > 0 ? await fetch("u:" + id) : throw BadId(id)
name = user == null ? throw NotFound(id) : user.name

export default component App() {
  errored fallback(e) { <p>down: {e.message}</p> } {
    <div><p>#{id}</p> {errored fallback(e: BadId) { <p>{e.message}</p> } {
      <p>{name catch (e: NotFound) => "(nobody)"}</p>
    }}</div>
  }
}
```

`name`'s row is `fails(Error | BadId | NotFound)`: `Error` from the fetch
(a JS promise, R-f-8), `BadId` and `NotFound` from its `throw`s. The reader
catches `NotFound` into a value; the inner boundary takes `BadId`; the root
boundary takes the rest. Remove any one of the three and the program is
refused (below).

## Frames

| instant | action                         | frame             |
| ------- | ------------------------------ | ----------------- |
| 0       | mount                          | ``                |
| 1       | resolve user { name: "Ann" }   | `#1 Ann`          |
| 2       | handler `id := 2`              | `#1 Ann`          |
| 3       | resolve user null              | `#2 (nobody)`     |
| 4       | handler `id := 0`              | `#0 bad id 0`     |
| 5       | handler `id := 3`              | `#3 bad id 0`     |
| 6       | reject user "offline"          | `down: offline`   |
| 7       | handler `id := 4`              | `down: offline`   |
| 8       | resolve user { name: "Dee" }   | `#4 Dee`          |

Instant 3: `NotFound` is caught into a value — the reader shows
`(nobody)` and no boundary moves. Instant 4: `BadId` is thrown with no
await; the typed boundary takes it in the same frame as `#0`. Instant 5:
the content is pending behind an error fallback, which holds nothing
(H-4) and stays until an answer replaces the error (D-41). Instant 6: the
rejection is an `Error`: the `BadId` boundary does not take it, the root
does. Instants 7–8: a new question, then its answer recovers through both
boundaries in one frame.

## Variant: a boundary that lists `Error` takes everything

```rx
error BadId(id) => `bad id ${id}`
error NotFound(id) => `no user ${id}`
source id := 1
user = id > 0 ? await fetch("u:" + id) : throw BadId(id)
name = user == null ? throw NotFound(id) : user.name

export default component App() {
  errored fallback(e: Error | NotFound) { <p>down: {e.message}</p> } {
    <p>{name catch (e: NotFound) => "(nobody)"}</p>
  }
}
```

| instant | action                         | frame             |
| ------- | ------------------------------ | ----------------- |
| 0       | mount                          | ``                |
| 1       | resolve user { name: "Ann" }   | `Ann`             |
| 2       | handler `id := 0`              | `down: bad id 0`  |

`Error` is the top class (R-f-1): a list that names it discharges every
failure, so `BadId` lands here although it is not listed.

## Rejected variants

```rx
-- reject: UNHANDLED_FAILURE
error BadId(id) => `bad id ${id}`
error NotFound(id) => `no user ${id}`
source id := 1
user = id > 0 ? await fetch("u:" + id) : throw BadId(id)
name = user == null ? throw NotFound(id) : user.name

export default component App() {
  <p>#{id}</p>
  errored fallback(e: BadId) { <p>{e.message}</p> } {
    <p>{name catch (e: NotFound) => "(nobody)"}</p>
  }
}
```

R-f-5: without the root boundary, the fetch's `Error` passes the `BadId`
boundary and nothing above discharges it.

```rx
-- reject: UNHANDLED_FAILURE
error BadId(id) => `bad id ${id}`
error NotFound(id) => `no user ${id}`
source id := 1
user = id > 0 ? await fetch("u:" + id) : throw BadId(id)
name = user == null ? throw NotFound(id) : user.name

export default component App() {
  errored fallback(e: BadId) { <p>{e.message}</p> } {
    <p>{name}</p>
  }
}
```

Neither `NotFound` (no catch on the reader) nor `Error` is discharged.

```rx
-- reject: NOT_AN_ERROR_CLASS
export default component App() {
  source id := 1
  user = await fetch("u:" + id)

  errored fallback(e: Missing) { <p>{e.message}</p> } { <p>{user}</p> }
}
```

```rx
-- reject: ROW_NARROWER_THAN_INFERRED
error NotFound(id) => `no user ${id}`
source id := 1
user = await fetch("u:" + id)
name: pending fails(NotFound) string = user == null ? throw NotFound(id) : user.name

export default component App() {
  errored fallback(e) { <p>{e.message}</p> } { <p>{name}</p> }
}
```

R-f-9: the written row leaves out the fetch's `Error`.
