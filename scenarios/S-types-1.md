# S-types-1 — Types: the program as TypeScript sees it

Rules exercised: TY-1–TY-5 (08 §TY), 07 §2, 04 R-1a.

## Modules

```rx
-- module: ./api.d.rx
export type User = { id: number; name: string; email: string | null }
export error NotFound
export pure fn fetchUser(id: number): Promise<User> rejects(NotFound)
```

## Program

```rx
import { fetchUser, User, NotFound } from "./api"
error TooShort(min: number) => `at least ${min}`
context accent: string = "blue"
component Badge(props: { label: string; count?: number }) {
  tone = use accent
  <span class={tone}>{props.label}{props.count == null ? "" : ` ${props.count}`}</span>
}
export default component App() {
  source id := 1
  source draft := ""
  source tags: string[] := []
  user = await fetchUser(id) catch (e: NotFound) => null
  initial = user == null ? "?" : user.name.slice(0, 1)
  fn shout(s: string): string => s.toUpperCase()
  action add(t: string) {
    try {
      if (len(t) < 2) { throw TooShort(2) }
      tags := xs => [...xs, t]
      draft := ""
    } catch (e: TooShort) { draft := `${e.message} (${e.min})` }
  }

  errored fallback(e) { <p>error: {e.message}</p> } {
    {loading fallback { <p>…</p> } {
      {if user { <p>{shout(user.name)} {user.email ?? "no email"}</p> } else { <p>no user {initial}</p> }}
      {for t in tags { <Badge label={t} count={len(t)} /> }}
      <button onClick={() => { add(draft) }}>add</button>
    }}
  }
}
```

Everything TypeScript needs is already in the program: the `.d.rx`'s types
(MO-8), the written annotations, and what each form is as a value — `user`
is `User | null` (the answer, or the catch's `null`), so it is read under
`if user`; `tags` is a `string[]` because it says so (`[]` alone says
nothing about later writes); the catch binds a `TooShort`, whose field
`min` is a number.

## Frames

| instant | action                                                      | frame          |
| ------- | ----------------------------------------------------------- | -------------- |
| 0       | mount                                                       | `…`            |
| 1       | resolve "fetchUser:1" { id: 1, name: "ann", email: null }   | `ANN no emailadd` |
| 2       | handler `draft := "x"; add(draft)`                          | `ANN no emailadd` |
| 3       | handler `add("red")`                                        | `ANN no emailred 3add` |

Instant 2: the action reads `draft` as it was (H-10) — `""` — and its catch
writes the message (`draft` is not on screen). Instant 3: `red` is added; the
badge shows its length.

## Rejected variants

(`-- types: CODE`: refused by the type layer — TypeScript over the projection.)

```rx
-- types: TS2345
export default component App() {
  source count := 0

  <button onClick={() => { count := "one" }}>{count}</button>
}
```

A write is checked against the source (TY-2): `0` makes it a number.

```rx
-- types: TS2322
component Badge(props: { label: string }) { <span>{props.label}</span> }

export default component App() {
  <Badge label={3} />
}
```

A component's props are checked where it is applied (TY-3).

```rx
-- types: TS2322
component Badge(props: { label: string }) { <span>{props.label}</span> }

export default component App() {
  <Badge />
}
```

A missing prop, likewise. (What a reader may insert is Solid's `JSX.Element`,
which takes any object — a renderer's value — so a record shown by mistake
is still Solid's `UNRECOGNIZED_INSERT_VALUE`, at run time.)

```rx
-- types: TS18047
import { fetchUser, NotFound } from "./api"
export default component App() {
  user = await fetchUser(1) catch (e: NotFound) => null

  errored fallback(e) { <p>{e.message}</p> } { <p>{user.name}</p> }
}
```

`user` may be `null`: read it under `if user { … }`, which narrows it
(RG-1c).

```rx
-- types: TS2339
error TooShort(min: number) => `at least ${min}`
export default component App() {
  source msg := ""
  action check(t: string) {
    try { throw TooShort(2) } catch (e: TooShort) { msg := e.max }
  }

  <p>{msg}</p>
}
```

A typed catch binds its classes (R-f-4); `TooShort` has no `max`.

```rx
-- types: TS2345
context accent: string = "blue"
component Panel(props) {
  provide accent = 3
  <p>{use accent}</p>
}

export default component App() {
  <Panel />
}
```

A provision is checked against its context's type (RG-7).

```rx
-- types: TS2345
export default component App() {
  fn shout(s: string): string => s.toUpperCase()

  <p>{shout(1)}</p>
}
```

```rx
-- types: WIRE_VALUE
type Row = { id: number; at: Date }
server fn rows(): Row[] { return [] }
export default component App() {
  r = await rows() catch (e) => []

  <p>{len(r)}</p>
}
```

SF-6a, statically: a `Date` is an instance of a class, so the result is
not data. (Untyped, the check is the run time's, S-sf-1.)

```rx
-- types: MISSING_AWAIT
import { fetchUser } from "./api"
export default component App() {
  source id := 1
  user = fetchUser(id)

  <p>{id}</p>
}
```

R-1: the equation lowers to a memo, and Solid's memo consumes the promise
its function returns, so `user` would be pending at run time while the
source says it is a value. The value is never a promise: write
`await fetchUser(id)`.

```rx
-- types: MISSING_AWAIT
import { fetchUser } from "./api"
export default component App() {
  source id := 1
  user = id > 0 ? fetchUser(id) : null

  <p>{id}</p>
}
```

A promise on one branch is enough: on that branch Solid consumes it.
