# S-fail-2 — failures through components: a prop's failures are checked where it is read, children's where they are rendered

Rules: R-f-4, R-f-5, R-f-6, R-2, RG-4c, H-4, D-41.

## Program

```
error Missing(key) => `missing ${key}`
source key := "a"
value = key == "" ? throw Missing(key) : await fetch("v:" + key)
other = await fetch("w:" + key) catch (e) => "none"
component Safe(props) {
  errored fallback(e) { <p>unavailable</p> } { {props.children} }
}
component Line(props) {
  <p>{props.text catch (e: Missing) => "-"}</p>
}
component Panel(props) {
  <p>{props.body}</p>
}

export default component App() {
  <div>
    <Safe><p>{value}</p></Safe>
    <Safe><Line text={value} /></Safe>
    {errored fallback(e) { <p>{e.message}</p> } { <Panel body={value} /> }}
    <p>{other}</p>
  </div>
}
```

Four readers of failing values, each discharged a different way: `{value}`
is a child of `Safe`, so it is under `Safe`'s boundary — where `Safe` reads
`props.children`, not where the caller writes them (RG-4c). `Line` catches
`Missing` itself; the `Error` left over goes out through `Line`'s
application, which is inside a `Safe`. `Panel` catches nothing: its prop is
discharged by the boundary around `<Panel>` at the caller. `other` catches
every failure of its own flight into a value.

## Frames

| instant | action                    | frame                          |
| ------- | ------------------------- | ------------------------------ |
| 0       | mount                     | ``                             |
| 1       | resolve value "x"         | ``                             |
| 2       | resolve other "y"         | `xxxy`                      |
| 3       | handler `key := ""`       | `xxxy`                      |
| 4       | reject other "down"       | `unavailable-missing none`   |
| 5       | handler `key := "b"`      | `unavailable-missing none`   |
| 6       | resolve value "z"         | `unavailable-missing none`   |
| 7       | resolve other "q"         | `zzzq`                      |

Instant 3: `Missing` is thrown with no await, but `other` re-asks and its
reader holds the change; the three error fallbacks are staged with it (an
error is an answer, H-12). Instant 4: the rejection is caught into `none`
and the frame commits as one. Instants 5–7: behind their fallbacks the
readers of `value` hold nothing (H-4) and recover with the answer (D-41);
`other`'s reader holds the change until `q` lands.

## Rejected variants

```
-- reject: UNHANDLED_FAILURE
error Missing(key) => `missing ${key}`
source key := "a"
value = key == "" ? throw Missing(key) : await fetch("v:" + key)
component Safe(props) {
  {props.children}
}

export default component App() {
  <Safe><p>{value}</p></Safe>
}
```

R-f-5: `Safe` renders its children with no boundary above them.

```
-- reject: UNHANDLED_FAILURE
error Missing(key) => `missing ${key}`
source key := "a"
value = key == "" ? throw Missing(key) : await fetch("v:" + key)
component Panel(props) {
  <p>{props.body}</p>
}

export default component App() {
  <Panel body={value} />
}
```

Passing is not reading (R-2): the failure is found where `Panel` reads
`props.body`, and followed out through this application to the root.

```
-- reject: UNHANDLED_FAILURE
error Missing(key) => `missing ${key}`
source key := "a"
value = key == "" ? throw Missing(key) : await fetch("v:" + key)
component Line(props) {
  <p>{props.text catch (e: Missing) => "-"}</p>
}

export default component App() {
  <Line text={value} />
}
```

`Line` discharges `Missing`; the fetch's `Error` passes its catch.

```
-- reject: UNCAUGHT_ACTION_FAILURE
component Btn(props) {
  action go() { log(props.v) }
  <button onClick={() => { go() }}>go</button>
}

export default component App() {
  source key := "a"
  value = await fetch("v:" + key)
  errored fallback(e) { <p>{e.message}</p> } { <Btn v={value} /> }
}
```

R-f-6, R-f-7: the action's snapshot of `props.v` throws when the argument
is an error — the boundary at the caller cannot catch inside an action.

```
-- reject: UNCAUGHT_ACTION_FAILURE
error Missing(key) => `missing ${key}`
export default component App() {
  source status := ""
  action save() {
    try { await fetch("save") } catch (e: Missing) { status := e.message }
  }

  <p>{status}</p>
}
```

A typed catch discharges only its classes: the fetch fails with `Error`.
