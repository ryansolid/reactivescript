# S-sf-2 — Wrapped server functions: `GET(server fn …)`

Rules exercised: SF-1d, SF-2b, SF-3, SF-7a; IO-2.

## Modules

```rx
-- module: ./api.d.rx
export server pure fn findUser(id: number): Promise<{ id: number; name: string; secret: string }>
export server pure fn now(): Date
```

## Program

```rx
import pure { GET } from "@solidjs/web/server-functions"
import { findUser } from "./api"
export default component App() {
  getUser = GET(server fn (id: number) {
    let u = await findUser(id)
    return { name: u.name }
  })
  source id := 1
  user = await getUser(id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    loading fallback { <p>…</p> } { <p>{user.name}</p> }
  }
}
```

`server fn (…) { … }` is an expression, so whatever wraps a server function
— Solid's `GET`, `live`, `withMeta`, or an app's own — is an ordinary
function applied to it at its declaration. `getUser` is the server fn the
wrapper returns, with the function's rows (SF-1d): here a loader, so it is
a question in an equation (SF-2b). `GET` is Solid's assertion that the
function is a safe read; the language does not check it — the wrapper's
author owns it, as an import's `pure` (IO-3).

## Frames

| instant | action | frame |
| ------- | ------ | ----- |
| 0 | mount | `…` |
| 1 | resolve "findUser:1" { id: 1, name: "Ann", secret: "s" } | `Ann` |
| 2 | handler `id := 2` | `Ann` |
| 3 | resolve "findUser:2" { id: 2, name: "Bo", secret: "t" } | `Bo` |

## Rejected variants

```rx
-- reject: IO_IN_REACTIVE
import { GET } from "@solidjs/web/server-functions"
export default component App() {
  getUser = GET(server fn (id) { return id })

  <p>x</p>
}
```

The wrapper is called when the equation is evaluated, in reactive scope: it
is imported `pure` (IO-2).

```rx
-- reject: SERVER_CAPTURE
import pure { GET } from "@solidjs/web/server-functions"
export default component App() {
  source n := 1
  f = GET(server fn () { return n })
  x = await f() catch (e) => 0

  <p>{x}</p>
}
```

Wrapped or not, the body names nothing reactive (SF-3).

```rx
-- reject: IO_IN_REACTIVE
import pure { GET } from "@solidjs/web/server-functions"
import { insert } from "./api2"
export default component App() {
  save = GET(server fn (x) { await insert(x); return 1 })
  n = await save(1) catch (e) => 0

  <p>{n}</p>
}
```

The rows are the function's (SF-1d): this body is io, so its call in an
equation is refused — `GET` does not change what the body does.

```rx
-- types: WIRE_VALUE
import pure { GET } from "@solidjs/web/server-functions"
import { now } from "./api"
export default component App() {
  getUser = GET(server fn (id: number) { return { id: id, at: now() } })
  u = await getUser(1) catch (e) => null

  <p>{u == null ? "" : "ok"}</p>
}
```

The wire is the function's, wrapped or not (TY-5a).
