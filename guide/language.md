# .rx on one page

ReactiveScript is TypeScript's expressions and JSX, plus a few reactive forms spelled with words. It compiles to
Solid 2.0. This page is the whole working language; `async.md` is how to talk to a server; `reference.md` is the
grammar and the rules on one page. The rules cited (E-1, AC-3, …) are in full in `spec/`; you don't need them to write
code. When the compiler reports an error, `diagnostics.md` has its code: why, and the fix.

## Modules

```rx
import pure { fetchUser } from "./api"     // a loader: callable anywhere, re-asked when its inputs change
import { saveUser } from "./api"           // io: callable only in imperative code (handlers, actions, effects)
import { Avatar } from "./Avatar.rx"       // another .rx module
export default component App() { … }       // the entry module's default component is mounted
```

A file's top level is imports, exports and declarations. A `source` at the top level is app state; inside a
component it is that instance's state. Only the block that declares a source writes it: importers, props, function
parameters and contexts are read-only, at every path into a store. To let other code write it, hand it an action that
does (`export action select(id) { selected := id }`, or an action passed as a prop or provided in a context).

## Declarations

```rx
source count: number := 0                  // state; written only with `:=` in imperative code
source user = await fetchUser(id)          // state with a question: re-asked when `id` changes, can take a guess
double = count * 2                         // an equation: always equal to its right side, never written
label = `${user.name} (${count})`
rows key id = items                        // a keyed collection (rows keep identity by `id`)
{ name, age = 0 } = user                   // destructuring: one equation per name, each keeps updating
fn area(w: number, h: number): number => w * h       // a pure function
action save(n: string) { … }               // writes and awaits (async.md)
component Row(props: { item: Item }) { … }
error NotFound(id: number) => `no issue ${id}`       // an error class; `NotFound(3)` makes one
type Item = { id: number; name: string }
```

There is no `let` at the top level or in a component: a value that changes is a `source`, and one computed from
others is an equation. Bare `x = e` is always an equation and `let x = e` (in imperative code) always a snapshot, as
in JS; that holds for destructuring too. Mutation is only `:=` and `guess`. A rest, `{ id, ...rest } = props`, is the other fields
(Solid's `omit`) and keeps updating too. Equations are lazy and exact: an arm of `c ? a : b` that isn't taken isn't evaluated.

## Expressions

TypeScript's, minus assignment operators (`=`, `+=`, `++`), `this`, `function`, `async` and `new` on reactive
values. Arrays and strings have their usual methods: `xs.filter(f)`, `xs.map(f)`, `xs.findIndex(f)`, `xs.some(f)`,
`xs.length`, `s.trim()`. Added forms:

| Form | Meaning |
| --- | --- |
| `await e` | the answer to `e` (in an equation: re-asked when inputs change, stale answers dropped) |
| `pending? x` | `true` while `x` is being re-asked or written by an action in flight |
| `latest x` | the value `x` is moving toward (what was typed, before the answer lands) |
| `peek(x)` | `x` read once, without depending on it |
| `e catch (err) => alt` | `alt` when `e` fails |
| `c ? a : throw NotFound(id)` | a failure as a value of an arm |
| `use name` / `provide name = e` | context: the nearest provision above, read-only (provide actions to let readers write) |

## Markup

A component body is declarations, then markup. JSX is verbatim; control flow is braced:

```rx
component IssueList(props: { issues: Issue[] }) {
  source open := true
  <section>
    <button data-testid="toggle" onClick={() => { open := !open }}>toggle</button>{" "}
    {if open {
      <ul>
        {for it in props.issues {
          <li data-testid="issue">#{it.id} {it.title}</li>
        }}
      </ul>
    } else {
      <p>hidden</p>
    }}
    {loading fallback { <p>loading…</p> } { <Details /> }}
    {errored fallback(e) { <p>failed: {e.message}</p> } { <Details /> }}
  </section>
}
```

- `{if c { … } else { … }}`, `{for x in xs { … }}`, `{loading … { … }}`, `{errored … { … }}` inside an element;
  the same without the outer braces at a block's top level. Each body may start with its own declarations.
- Text follows JSX: line breaks between elements are not text. Write `{" "}` for a space between elements.
- Events: `onClick={() => { … }}`, `onInput={(e) => { name := e.target.value }}`. An input shows a source with
  `value={name}`.

## Imperative code

Handlers, `action` bodies and `effect` apply blocks:

```rx
<button onClick={() => { count := count + 1 }}>+</button>

effect (count) { log($0) }   // runs after `count` changes; `$0` is its value (async.md §6)
```

- A write is `x := v`, `x.field := v`, `xs[i].done := v`, or functional `x := old => …` (applied to the slot as it
  stands at the write).
- `let`/`const` (destructuring too: `let { a, b } = pair` takes snapshots), `if`, `try`/`catch`/`finally`, `return`, `throw` work as in TypeScript (no `for`/`while` loops:
  use array methods).
- Browser and JS globals (`console`, `document`, `window`) are not in scope. `log(…)` prints; anything else from
  JS comes in through an import from a `.js` module.
- Reading a source gives its value at the start of the run: after `x := v`, `x` still reads the old value. Keep the
  new value in a local (`let n = count + 1; count := n`).
- `await` is a statement: `await save(x)` or `let r = await load(x)`. A handler that writes and awaits is an action,
  with the rules in `async.md`.

## Components

```rx
component Card(props: { title: string; children: View }) {
  source open := false
  <div onClick={() => { open := !open }}>
    <h2>{props.title}</h2>
    {if open { {props.children} }}
  </div>
}
```

`props.x` stays live: don't copy it into a source unless you mean a one-time seed (`source draft := peek(props.x)`).
Destructured props stay live too: `component Card({ title, open = false })` or `{ title } = props` (RG-4b).

A prop that takes a handler is named `on…` and typed as a function: `props: { onPick: (id: number) => void }`, passed
as `<Row onPick={id => { selected := id }} />` and called from the component's own handlers (`props.onPick(id)`).
