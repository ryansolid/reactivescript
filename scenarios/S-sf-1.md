# S-sf-1 — Server functions: awaited in an equation a question, in an action a request; only declared failures cross

Rules exercised: SF-1, SF-2, SF-3, SF-4, SF-5a, SF-6; SV-5; R-io-3, R-f-5.

## Modules

```rx
-- module: ./api.d.rx
// a database module: it runs only on the server
export error NotFound
export server pure fn findUser(id: number) rejects(NotFound)
export server fn insertNote(id: number, text: string)
export client pure fn viewport()
```

`findUser` and `insertNote` are `server` JS (SF-5a): only a server
function's body may call them. `findUser` is a loader; `insertNote` is io.
`viewport` is `client` JS (SF-5b): it is not on the server.

## Program

```rx
import { findUser, insertNote, NotFound } from "./api"
error TooLong(n: number) => `too long: ${n}`
server fn loadUser(id) {
  let u = await findUser(id)
  return { name: u.name, notes: u.notes }
}
server fn addNote(id, text) {
  if (len(text) > 5) { throw TooLong(len(text)) }
  await insertNote(id, text)
  return len(text)
}
source id := 1
source status := ""
user = await loadUser(id)
action note(t) {
  try { let n = await addNote(id, t); status := `saved ${n}` }
  catch (e) { status := e.message }
}

export default component App() {
  errored fallback(e) { <p>error: {e.message}</p> } {
    {loading fallback { <p>loading</p> } { <p>{user.name}: {user.notes} notes {status}</p> }}
  }
}
```

`user` is an ordinary question (SF-2b) over a server `fn`: asked when `id`
changes, held, and its answer is what the body returned — the record it
built, not the row `findUser` gave it (the password stays on the server).
`addNote` is io — its body calls `insertNote` (SF-1) — so it is called
only from imperative scope; `note` awaits it (SF-2c) and writes what it
returned (SF-4). A `loadUser` call can fail with `NotFound` (its body lets
`findUser`'s through) and with `Error` (every call can fail in transit,
SF-6b); the untyped boundary discharges both.

## Frames

| instant | action                                                    | frame                                |
| ------- | --------------------------------------------------------- | ------------------------------------ |
| 0       | mount                                                     | `loading`                            |
| 1       | resolve "findUser:1" { name: "Ann", notes: 0, password: "hunter2" } | `Ann: 0 notes`             |
| 2       | handler `note("hi")`                                      | `Ann: 0 notes`                       |
| 3       | resolve "insertNote:1,hi" true                            | `Ann: 0 notes saved 2`               |
| 4       | handler `note("toolong")`                                 | `Ann: 0 notes too long: 7`           |
| 5       | handler `note("ok")`                                      | `Ann: 0 notes too long: 7`           |
| 6       | reject "insertNote:1,ok" "disk full"                      | `Ann: 0 notes Internal Server Error` |
| 7       | handler `id := 2`                                         | `Ann: 0 notes Internal Server Error` |
| 8       | reject "findUser:2" NotFound("no user 2")                 | `error: no user 2`                   |

Instant 1: `findUser`'s answer resumes `loadUser`'s body, whose return is
`user`'s answer — one landing. Instant 3: `insertNote`'s answer ends
`addNote`'s body, which resumes `note` after its `await`. Instant 4: the
body throws a declared class before it awaits anything; it crosses with
its message (SV-5a). Instant 6: `insertNote` rejects with a plain `Error`
— undeclared, so the client gets the generic one (SV-5b): `disk full`
stays on the server. Instant 8: `NotFound` is declared (the `.d.rx`), so
it crosses as itself.

## Rejected variants

```rx
-- reject: SERVER_CAPTURE
source n := 1
server fn f() { return n }
x = await f() catch (e) => 0

export default component App() {
  <p>{x}</p>
}
```

SF-3: a source, wherever it is declared — on the server it is the
request's, never the client's value. Pass it: `server fn f(n)`.

```rx
-- reject: SERVER_CAPTURE
source n := 1
fn next() => n + 1
server fn f() { return next() }
x = await f() catch (e) => 0

export default component App() {
  <p>{x}</p>
}
```

A value `fn` is nameable unless it reads reactive state; this one reads
`n`.

```rx
-- reject: SERVER_CAPTURE
component Card(props) {
  server fn title() { return props.title }
  t = await title() catch (e) => ""
  <h2>{t}</h2>
}

export default component App() {
  <Card title="x" />
}
```

Capture is by kind, not position: a server function inside a component
is fine, naming its props is not.

```rx
-- reject: SERVER_WRITE
source status := ""
server fn save(x) { status := "saved"; return x }

export default component App() {
  <p>{status}</p>
}
```

SF-4: return the value; the action that awaited the call writes it.

```rx
-- reject: SERVER_ONLY
import { findUser } from "./api"
export default component App() {
  user = await findUser(1) catch (e) => null

  <p>{user}</p>
}
```

SF-5a: `findUser` is not in the client bundle.

```rx
-- reject: CLIENT_IN_SERVER
import { viewport } from "./api"
server fn size() { return viewport() }
export default component App() {
  n = await size() catch (e) => 0

  <p>{n}</p>
}
```

SF-5c: the browser's JS does not exist where the body runs.

```rx
-- reject: IMPORT_ROW_MISMATCH
import client pure { findUser } from "./api"

export default component App() {
  <p>x</p>
}
```

The declaration file says where `findUser` runs; the import cannot restate
it.

```rx
-- reject: IO_IN_REACTIVE
import { insertNote } from "./api"
server fn add(id) { await insertNote(id, "x"); return 1 }
export default component App() {
  n = await add(1) catch (e) => 0

  <p>{n}</p>
}
```

SF-1: `add` is io because its body is, and an equation's `await` is a
question, which may be asked again: io is called from imperative scope.
The message names the call in the body that made it io.

```rx
-- reject: UNHANDLED_FAILURE
server fn one() { return 1 }
export default component App() {
  x = await one()

  <p>{x}</p>
}
```

SF-6b: a call can fail in transit even when the body cannot fail.

```rx
-- reject: WIRE_VALUE
server fn f() { return { g: (x) => x } }
export default component App() {
  v = await f() catch (e) => null

  <p>{v}</p>
}
```

SF-6a: a function does not cross. While types are text, this is found
when the call returns.
