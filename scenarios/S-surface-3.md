# S-surface-3 — A class map: a stylesheet as a value, for elements a view does not own

Rules exercised: 07 §6b CSS-5 (TSRX's style expressions).

## Program

```rx
component Badge(props) {
  <span class={props.class}>{props.children}</span>
}
tones = <style>
  .warn { color: orange }
  .ok, .done { color: green }
  .warn:hover { color: red }
  span { margin: 0 }
</style>
export default component App() {
  source done := false
  <p>
    <Badge class={done ? tones.done : tones.warn}>{done ? "done" : "open"}</Badge>
    {" "}{(done ? tones.done : tones.warn).split(" ")[1]}
  </p>
  <button onClick={() => { done := true }}>finish</button>
}
```

`tones` is a value: a record from each standalone class of the stylesheet
to that class plus the stylesheet's scope class. A view's own `<style>`
cannot reach the `<span>` inside `Badge` — scoping stops at a component —
so the parent passes the class itself. Only standalone class rules are in
the map; `.warn:hover` and `span` match nothing a map can name, and are
pruned (TSRX). A class map is a constant, so it may be declared at a
module's top level.

## Frames

| instant | action                  | frame               |
| ------- | ----------------------- | ------------------- |
| 0       | mount                   | `open warnfinish`   |
| 1       | handler `done := true`  | `done donefinish`   |

## Scoped CSS

```
  .warn.h1 { color: orange }
  .ok.h1, .done.h1 { color: green }
  /* (unused) .warn:hover { color: red }*/
  /* (unused) span { margin: 0 }*/
```

## Rejected variants

```rx
-- types: TS2339
tones = <style>.warn { color: orange }</style>
export default component App() {
  <p class={tones.wran}>x</p>
}
```

The map's type is its classes: a misspelt class is a type error.

```rx
-- reject: CSS-5
export default component App() {
  <style ref={styles}>.a { color: red }</style>
  <p class="a">x</p>
}
```

A class map is a declaration, `styles = <style>…</style>`; TSRX's
`<style ref={styles}>` assigns into a variable, and a name here is bound
once, by its declaration.
