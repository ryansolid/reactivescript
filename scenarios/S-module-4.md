# S-module-4 — a Solid library, declared: primitives instantiate, readers read, setters are io

Rules: MO-10a, MO-10b, MO-10c, MO-10d, E-9, E-10, RG-6, R-io-3, CN-3e.

## Modules

```rx
-- module: ./prims.d.rx
// what ./prims (a JS module of Solid primitives) exports
export pure fn createToggle(initial: boolean): [ref boolean, (v: boolean) => void]
export pure fn createShout(ref s: string): ref string
```

```json
-- module: ./node_modules/@demo/prims/package.json
{ "name": "@demo/prims", "exports": { ".": { "types": "./dist/index.d.ts", "solid": "./dist/index.jsx", "default": "./dist/index.js" } } }
```

```rx
-- module: ./node_modules/@demo/prims/dist/index.d.rx
// shipped by the package, beside the file its import resolves to
export pure fn createToggle(initial: boolean): [ref boolean, (v: boolean) => void]
```

`createToggle` hands back an accessor and a setter; `createShout` takes an
accessor and hands one back. Both instantiate, inferred from `ref` (MO-10a).
The runners over Solid run them as Solid primitives (`ref/src/prims.ts`);
the interpreter runs the `.rx` they mean.

## Program

```rx
import { createToggle, createShout } from "./prims"
export default component App() {
  source name := "ann"
  source start := false
  [isOn, setOn] = createToggle(peek start)
  loud = createShout(name)
  action flip() { setOn(!isOn) }

  <p>{isOn ? loud : "off"}</p>
}
```

`isOn` is read without a call: the compiler reads the accessor (MO-10b).
`name` is passed to a `ref` parameter, so as an accessor (RG-6b).

## Frames

| instant | action                 | frame  |
| ------- | ---------------------- | ------ |
| 0       | mount                  | `off`  |
| 1       | handler `flip()`       | `ann!` |
| 2       | handler `name := "bo"` | `bo!`  |
| 3       | handler `start := true` | `bo!` |
| 4       | handler `flip()`       | `off`  |

Instant 2: the accessor `createShout` was given follows `name`. Instant 3:
`start` was read once (`peek`); the toggle is not rebuilt, so its state
stands (RG-6a), where a lifted call would have made a new one.

## Rejected variants

```rx
-- reject: SNAPSHOT_ARGUMENT
import { createToggle } from "./prims"
export default component App() {
  source start := false
  [isOn, setOn] = createToggle(start)

  <p>{isOn}</p>
}
```

E-10: a value parameter's argument is read once.

```rx
-- reject: IO_IN_REACTIVE
import { createToggle } from "./prims"
export default component App() {
  [isOn, setOn] = createToggle(false)
  oops = setOn(true)

  <p>{isOn} {oops}</p>
}
```

MO-10b: a function part of a primitive's result is io.

```rx
-- reject: INSTANTIATION_NOT_BOUND
import { createShout } from "./prims"
export default component App() {
  source name := "ann"

  <p>{createShout(name)}</p>
}
```

A primitive is called once, where it is bound (RG-6).

```rx
-- reject: IO_IN_REACTIVE
import { createToggle } from "@demo/prims"
export default component App() {
  [isOn, setOn] = createToggle(false)
  oops = setOn(true)

  <p>{isOn} {oops}</p>
}
```

MO-10c: a package's declaration is beside the file the import resolves to
(here `exports` → `solid` → `dist/index.jsx`, so `dist/index.d.rx`), with no
export condition of its own.

```rx
-- reject: CN-3e
import { createShout } from "./prims"
export default component App() {
  source name := "ann"
  loud = createShout(name)

  <div>{loading on(name) fallback { <p>…</p> } { <p>{loud}</p> }} <p>{loud}</p></div>
}
```

MO-10d: a foreign reader may hold, as a question's reader does, so the
outside read of `loud` keeps the change `loading on(name)` waits for.
