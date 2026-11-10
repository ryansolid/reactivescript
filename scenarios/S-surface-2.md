# S-surface-2 — Scoped styles: one stylesheet per view, TSRX's engine

Rules exercised: 07 §6b CSS-1–CSS-4.

## Program

```rx
component Card(props) {
  source open := false
  <style>
    .card { border: 1px solid }
    h2 { margin: 0 }
    .body { color: gray }
    .card :global(.icon) { opacity: 1 }
    table { width: 100% }
  </style>
  <div class="card">
    <h2>{props.title}</h2>
    {if open { <p class="body">{props.children}</p> }}
  </div>
}

export default component App() {
  <style>
    b { font-weight: 600 }
  </style>
  <Card title="Hi"><b>there</b></Card>
}
```

`Card`'s stylesheet scopes `Card`'s view — the branch included, so `.body`
is used. `table` matches nothing in it and is pruned; `:global(.icon)` is
left unscoped. `App`'s view has its own: the `<b>` it passes to
`Card` is its element, wherever `Card` puts it. A stylesheet is not text
in the frame.

## Frames

| instant | action                | frame      |
| ------- | --------------------- | ---------- |
| 0       | mount                 | `Hi`       |
| 1       | handler `open := true` | `Hithere` |

## Scoped CSS

```
    .card.h1 { border: 1px solid }
    h2.h1 { margin: 0 }
    .body.h1 { color: gray }
    .card.h1 .icon { opacity: 1 }
    /* (unused) table { width: 100% }*/
    b.h2 { font-weight: 600 }
```

(`h1`, `h2`: the two scope classes, `tsrx-` and eight hex digits, in order
of appearance.)

## Rejected variants

```rx
-- reject: STYLE_PLACEMENT
export default component App() {
  <div><style>p { color: red }</style><p>x</p></div>
}
```

A stylesheet scopes a whole view, so it is written at the view's top level.

```rx
-- reject: STYLE_PLACEMENT
export default component App() {
  source ok := true

  if ok { <style>p { color: red }</style> <p>x</p> }
}
```

A branch is part of its view: TSRX counts this as the view's stylesheet; here
where it is written is what it scopes.

```rx
-- reject: STYLE_PLACEMENT
export default component App() {
  <style>p { color: red }</style>
  <style>b { color: blue }</style>
  <p>x</p>
}
```

One stylesheet per view (TSRX: "fragments can only have one style tag").
