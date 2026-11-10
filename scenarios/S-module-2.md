# S-module-2 — a declaration file for a JS module: rows declared once, checked at every import

Rules: MO-8, R-io-4, R-f-8, R-f-4, R-f-6.

## Modules

```rx
-- module: ./api.d.rx
// what ./api (a JS module) exports, in rows
export error NotFound
export error Offline
export pure fn fetchUser(id: number) rejects(NotFound | Offline)
export fn saveUser(id: number, name: string) rejects(Offline)
export type User = { id: number; name: string }
```

`fetchUser` is `pure` (a loader: safe to call from reactive scope, R-io-4)
and rejects with two declared classes; `saveUser` is `io` — dirty is the
default, so it says nothing. No import restates any of this.

## Program

```rx
import { fetchUser, saveUser, NotFound, Offline, User } from "./api"
export default component App() {
  source id := 1
  source status := ""
  user = await fetchUser(id) catch (e: NotFound) => null
  action rename(n) {
    try { await saveUser(id, n); status := "saved" }
    catch (e: Offline) { status := "offline" }
  }

  errored fallback(e: Offline) { <p>offline: {e.message}</p> } {
    <p>{user == null ? "no such user" : user.name} {status}</p>
  }
}
```

`user` can fail with `Offline` only — `NotFound` became `null` — and the
boundary lists exactly `Offline`, so nothing is left over. The action
catches the one class `saveUser` rejects with.

## Frames

| instant | action                              | frame                     |
| ------- | ----------------------------------- | ------------------------- |
| 0       | mount                               | ``                        |
| 1       | resolve user { id: 1, name: "Ann" } | `Ann`                     |
| 2       | handler `rename("Anne")`            | `Ann`                     |
| 3       | reject "saveUser:1,Anne" Offline("no network") | `Ann offline`  |
| 4       | handler `id := 2`                   | `Ann offline`             |
| 5       | reject user NotFound("no user 2")   | `no such user offline`    |
| 6       | handler `id := 3`                   | `no such user offline`    |
| 7       | reject user Offline("no network")   | `offline: no network`     |

Instant 3: the rejection is an `Offline` (the harness rejects with the
class the declaration names), caught inside the action (AC-7). Instant 5: a
`NotFound` is an answer of `null`. Instant 7: an `Offline` reaches the
typed boundary.

## Rejected variants

```rx
-- reject: NOT_EXPORTED
import { deleteUser } from "./api"

export default component App() {
  <p>x</p>
}
```

MO-8: with a declaration file, a JS module exports what it declares.

```rx
-- reject: IMPORT_ROW_MISMATCH
import pure { saveUser } from "./api"

export default component App() {
  <p>x</p>
}
```

`saveUser` is declared io; `pure` on the import cannot lower it.

```rx
-- reject: IMPORT_ROW_MISMATCH
import { fetchUser } from "./api" fails NotFound

export default component App() {
  <p>x</p>
}
```

The declaration file is the row; the import cannot restate it.

```rx
-- reject: IO_IN_REACTIVE
import { saveUser } from "./api"
export default component App() {
  saved = saveUser(1, "x")

  <p>{saved}</p>
}
```

```rx
-- reject: UNHANDLED_FAILURE
import { fetchUser, NotFound } from "./api"
export default component App() {
  user = await fetchUser(1) catch (e: NotFound) => null

  errored fallback(e: NotFound) { <p>{e.message}</p> } { <p>{user.name}</p> }
}
```

`Offline` is left: the declared rejections are the whole row, and nothing
here discharges `Offline`.

```rx
-- reject: UNCAUGHT_ACTION_FAILURE
import { saveUser, NotFound } from "./api"
export default component App() {
  source status := ""
  action save() { try { await saveUser(1, "x") } catch (e: NotFound) { status := "?" } }

  <p>{status}</p>
}
```
