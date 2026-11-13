# Using Solid libraries from .rx

A Solid library (solid-primitives, a design system's hooks, your own `create*` helpers) is plain JavaScript. To use
one from .rx, declare what it exports once, in a `.d.rx` file, and then use it like .rx. The declaration is checked
at every use; the JavaScript itself is not checked (it's the library's).

## Declare it

```rx
// media.d.rx, beside media.js — or shipped by the package beside the file its import resolves to
export pure fn createToggle(initial: boolean): [ref boolean, (v: boolean) => void]
export pure fn createDebounced(ref source: string, ms: number): ref string
export pure fn createMediaQuery(query: string): ref boolean
export pure fn createEventListener(target: EventTarget, type: string, handler: (e: Event) => void) instantiates
```

- **`ref T` is an accessor.** In a parameter, the library takes an accessor (Solid's `Accessor<T>`); in a result, it
  hands one back. .rx has no accessor type: you pass and read plain values, and the compiler adds the `() => …` and
  the call.
- **A function in a result is io.** A setter can be called only in imperative code (an action, a handler).
- **Anything else is a value.** A store a library returns is a value whose fields track, as in Solid.
- **`instantiates`** says the call creates state and must run once. It is inferred from any `ref`, so you write it
  only for a primitive with no `ref` on either side (one that registers a listener, or returns a store).
- `pure fn` is right for a primitive: making it writes nothing but its own state.

Where the file goes:

- **Your own JS module:** `./media.js` with `./media.d.rx` beside it.
- **A package that ships one:** nothing to do. The compiler resolves the import the way a bundler does (`exports`,
  `module`, `main`) and reads the `.d.rx` beside that file (`dist/index.jsx` → `dist/index.d.rx`).
- **A package that doesn't:** re-export what you use from a local file and declare that:
  `export { createMediaQuery } from "@solid-primitives/media"` in `./media.js`, then `./media.d.rx` as above.

## Use it

```rx
import { createToggle, createDebounced, createMediaQuery } from "./media.js"

export component Search(props: { start: boolean, q: string }) {
  [isOn, setOn] = createToggle(peek props.start)   // runs once; peek: `start` is read once, and you mean it
  query = createDebounced(props.q, 300)            // passed as an accessor: it follows props.q
  wide = createMediaQuery("(min-width: 768px)")
  action flip() { setOn(!isOn) }

  <button onClick={flip}>{isOn && wide ? query : "off"}</button>
}
```

`isOn`, `query` and `wide` are equations like any other: read them without calling them. They may hold, like a
value from an `await` (Solid promises nothing about an accessor), so `latest`, `pending?` and `loading` apply.

What the compiler catches:

| you write | you get |
| --- | --- |
| `createToggle(props.start)` | `SNAPSHOT_ARGUMENT`: a value argument is read once; write `peek props.start`, or the library should take `ref` |
| `x = setOn(true)` | `IO_IN_REACTIVE`: a setter is called from an action or handler |
| `<p>{createMediaQuery(q)}</p>` | `INSTANTIATION_NOT_BOUND`: bind it, `wide = createMediaQuery(q)` |

## What stays the library's

- **Its setters are not writes of a source.** The compiler can't see them as writes, so a read right after one, in
  the same action, gives the value from before it (Solid batches the write), and nothing warns you:

  ```rx
  action flip() {
    setOn(!isOn)
    label := isOn ? "on" : "off"     // still the old isOn
  }
  ```

  Compute the new value once and use it: `let next = !isOn; setOn(next); label := next ? "on" : "off"`.
- **Callbacks you pass are plain functions.** An action passed as `handler` is checked as an action; a plain closure
  is not checked beyond what any closure is.
- **Without a declaration,** an import is io unless you import it `pure`, and `import pure` of a primitive is
  unchecked: the call is then an equation, re-run (and the primitive rebuilt) whenever an argument changes. Declare
  primitives instead.

Rules: `spec/09-modules.md` MO-10 (and MO-8 for declaration files).
