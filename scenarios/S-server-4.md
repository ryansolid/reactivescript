# S-server-4 — The content model across templates: what the parser would rebuild is refused

Rules exercised: SV-7d; SV-3a; MO-3.

## Modules

```rx
-- module: ./row.rx
export component Row(props) { <tr><td>{props.name}</td></tr> }
```

## Program

```rx
import { Row } from "./row.rx"
component Note(props) { <p class="note">{props.children}</p> }
export default component App() {
  source names := ["Ann", "Bo"]

  <table><tbody>{for n in names { <Row name={n} /> }}</tbody></table>{" "}
  <Note><b>hi</b></Note>
}
```

`Row`'s root is a `<tr>`: its signature says so (MO-3), and it is applied
in a `<tbody>`, where the parser puts a `<tr>`. `Note` places its caller's
children in a `<p>`; a `<b>` is phrasing content, so it stays there.

## Frames

| instant | action                              | frame         |
| ------- | ----------------------------------- | ------------- |
| 0       | mount                               | `AnnBo hi`    |
| 1       | handler `names := ["Ann", "Bo", "Cy"]` | `AnnBoCy hi` |

## Rejected variants

```rx
-- reject: CONTENT_MODEL
import { Row } from "./row.rx"
export default component App() {
  source names := ["Ann"]

  <table>{for n in names { <Row name={n} /> }}</table>
}
```

The server's `<table><tr>` is parsed with a `<tbody>` the client never
builds (it inserts each row into the table). Solid's compiler assumes "table
partials are used in the right place"; this is the place.

```rx
-- reject: CONTENT_MODEL
import { Row } from "./row.rx"

export default component App() {
  <div><Row name="x" /></div>
}
```

Outside a table the parser drops the `<tr>` and `<td>` tags.

```rx
-- reject: CONTENT_MODEL
component Panel(props) { <div class="panel">{props.children}</div> }

export default component App() {
  <p><Panel>x</Panel></p>
}
```

A `<div>` closes an open `<p>`: the served `<p>` is empty and the panel is
its sibling.

```rx
-- reject: CONTENT_MODEL
component Line(props) { <tr>{props.children}</tr> }

export default component App() {
  <table><tbody><Line><span>x</span></Line></tbody></table>
}
```

Children land where the component puts them: here, a `<span>` in a
`<tr>`, which the parser moves out of the table.

```rx
-- reject: CONTENT_MODEL
export default component App() {
  source ok := true

  <p>{if ok { <div>x</div> } else { <span>y</span> }}</p>
}
```

A branch is its own template: Solid's compiler sees `<p>` and `<div>`
apart. The checker sees them together.

```rx
-- reject: CONTENT_MODEL
component Link(props) { <a href="/x">{props.children}</a> }

export default component App() {
  <a href="/y"><Link>z</Link></a>
}
```

Links do not nest: the parser closes the outer one.
