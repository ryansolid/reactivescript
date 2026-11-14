# S-module-5 — Solid components from JS: applied, and given components as values

Rules: MO-11a, MO-11b, MO-11c, DV-24, MO-10c, R-f-5, RG-7b, SV-7d, RG-4a, TY-4b.

## Modules

```json
-- module: ./node_modules/@demo/ui/package.json
{ "name": "@demo/ui", "types": "./dist/index.d.ts", "exports": { ".": { "solid": "./dist/index.jsx", "default": "./dist/index.js" } } }
```

```rx
-- module: ./node_modules/@demo/ui/dist/index.d.rx
// a Solid component library, declared beside the file its import resolves to (MO-10c)
export component Shell(props: {
  header?: Component      // a field per line, as in TypeScript
  children?: View
}) shape(roots div; closes-p; children-at div)
export component Link(props: { href: string; children?: View }) shape(roots a; a; children-at a)
export component Divider(props: { mark: "," | ";" | "}"; pages?: Component[] })
export pure fn pageList(): Component[]
export pure fn pick(): Component<{}> | Array<number>
```

```rx
-- module: ./theme.rx
export context theme: string
export component Swatch() {
  <i>{use theme}</i>
}
```

`Shell` renders the component it is given as `header`, then its children,
in a `<div>`; `Link` renders an `<a>` around its children (MO-11a).

## Program

```rx
import pure { fetch, len } from "./prelude"
import { Shell, Link, Divider, pageList, pick } from "@demo/ui"

component Title() {
  name = await fetch("name")
  <h1>{name}</h1>
}
export default component App() {
  pages = pageList()
  picked = pick()
  errored fallback(e) { <p>failed</p> } {
    <Shell header={Title}><Link href="/">home</Link></Shell> <Divider mark=";" /> <p>{len(pages)} {picked.length}</p>
  }
}
```

Accepted. `Title` is passed as a value to `header`, typed `Component`, and
checked as applied among `<Shell>`'s children (MO-11c), so its fetch's
`Error` is discharged by the `errored` above `<Shell>`. A string literal type
with `;` in it is one field, and `Component[]` or
`Component<{}> | Array<number>` is a value, not a component (only
`Component` and `Component<P>` are). The runners that execute have no
`@demo/ui` to run.

## Rejected variants

```rx
-- reject: UNHANDLED_FAILURE
import pure { fetch } from "./prelude"
import { Shell } from "@demo/ui"
component Title() {
  name = await fetch("name")
  <h1>{name}</h1>
}
export default component App() {
  <Shell header={Title} />
}
```

What a component value lets out is checked above the application it is
passed to, on every path, whether or not the library renders it (MO-11c).

```rx
-- reject: COMPONENT_AS_VALUE
import { Link } from "@demo/ui"
component Home() { <b>home</b> }
export default component App() {
  <Link href={Home} />
}
```

`href` is a `string`, not a `Component`: a component is a value only where
a JS component's declaration asks for one.

```rx
-- reject: COMPONENT_AS_VALUE
component Home() { <b>home</b> }
component Frame(props) { <div>{props.page}</div> }
export default component App() {
  <Frame page={Home} />
}
```

An `.rx` component cannot take one: it has no way to apply a value.

```rx
-- reject: UNKNOWN_COMPONENT
import { Badge } from "./badge.js"
export default component App() {
  <Badge />
}
```

A JS import with no declaration is not a component (MO-11a): the message
names the line to write in `./badge.d.rx`.

```rx
-- reject: CONTEXT_NOT_FOUND
import { Shell } from "@demo/ui"
import { theme, Swatch } from "./theme.rx"
export default component App() {
  <Shell header={Swatch} />
}
```

RG-7b over a component value: `Swatch` uses `theme`, and nothing above
`<Shell>` provides it.

```rx
-- reject: CONTENT_MODEL
import { Link } from "@demo/ui"
export default component App() {
  <a href="/x"><Link href="/">home</Link></a>
}
```

`Link`'s declared shape is an `<a>`, which the HTML parser does not nest in
another (SV-7d over a JS component's `shape(…)`).

```rx
-- reject: CONTENT_MODEL
import { Shell } from "@demo/ui"
component Back() { <a href="/">back</a> }
component Wrapped() { <Shell header={Back} /> }
export default component App() {
  <a href="/x"><Wrapped /></a>
}
```

A component value counts in the shape of the component that passes it:
`Wrapped` contains an `<a>`, through `Shell`'s `header`.

```rx
-- types: TS2322
import { Link } from "@demo/ui"
export default component App() {
  <Link href={1}>home</Link>
}
```

TY-4b: the declaration's field types are the component's props, checked
where it is applied (`href` is a `string`).
