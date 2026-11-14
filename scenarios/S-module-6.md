# S-module-6 — a router: a component factory, its route table, its hooks, and per-route data

Rules: MO-11d, MO-11e, MO-11f, DV-24, MO-10a, MO-10b, MO-10c, R-f-5, RG-7b, R-io-3.

## Modules

```json
-- module: ./node_modules/@solidjs/router/package.json
{ "name": "@solidjs/router", "types": "./dist/index.d.ts", "exports": { ".": { "solid": "./dist/index.jsx", "default": "./dist/index.js" } } }
```

```rx
-- module: ./node_modules/@solidjs/router/dist/index.d.rx
// what @solidjs/router 2.0 would ship beside dist/index.jsx (MO-10c); an app without it re-exports the router from a local module
export type Params = Record<string, string>
export type RouteDefinition = { path?: string; component?: any; children?: RouteDefinition[] }
export pure fn createRouter(config: { routes: RouteDefinition[] }): Component
export pure fn useParams(): Params instantiates
export pure fn useNavigate(): (to: string) => void instantiates
```

```rx
-- module: ./theme.rx
export context theme: string
export component Swatch() {
  <i>{use theme}</i>
}
```

`createRouter` hands back a component, so its call is an instantiation
(MO-10a, inferred from the `Component` result) and the name it is bound to
is applied as a component (MO-11f). Links are plain `<a href>`: the router
handles their clicks.

## Program

```rx
import pure { fetch } from "./prelude"
import { createRouter, useParams, useNavigate } from "@solidjs/router"

component Layout(props) {
  <nav><a href="/">Home</a> <a href="/people/1">Ann</a></nav>
  <main>{props.children}</main>
}
component Home() {
  navigate = useNavigate()
  action meetBo() { navigate("/people/2") }
  <h1>Home</h1> <button onClick={meetBo}>Bo</button>
}
component Person() {
  params = useParams()
  person = await fetch(`person:${params.id}`)
  <h1>{person.name}</h1>
}
Router = createRouter({ routes: [{ path: "/", component: Layout, children: [{ path: "/", component: Home }, { path: "/people/:id", component: Person }] }] })

export default component App() {
  errored fallback(e) { <p>failed</p> } {
    loading fallback { <p>loading…</p> } {
      <Router />
    }
  }
}
```

Accepted. The route table names `Layout`, `Home` and `Person` as values:
each is checked as applied among the children of `<Router />`, so the
`errored` above it discharges `Person`'s `Error` (MO-11f, R-f-5). `params`
is the router's store, read as a value whose fields track (MO-11d), and
`person` is asked again when `params.id` changes (MO-11e). `navigate` is io,
called from an action. The runners that execute have no router to run; the
Vite suite builds `examples/router/` and navigates it in Chromium.

## Rejected variants

```rx
-- reject: UNHANDLED_FAILURE
import pure { fetch } from "./prelude"
import { createRouter, useParams } from "@solidjs/router"
component Person() {
  params = useParams()
  person = await fetch(`person:${params.id}`)
  <h1>{person.name}</h1>
}
Router = createRouter({ routes: [{ path: "/people/:id", component: Person }] })
export default component App() {
  <Router />
}
```

A route the router may render is checked where the router is applied: its
`Error` escapes `<Router />`, with no boundary above (MO-11f).

```rx
-- reject: CONTEXT_NOT_FOUND
import { createRouter } from "@solidjs/router"
import { theme, Swatch } from "./theme.rx"
component Layout(props) {
  provide theme = "dark"
  <main>{props.children}</main>
}
Router = createRouter({ routes: [{ path: "/", component: Layout, children: [{ path: "/", component: Swatch }] }] })
export default component App() {
  <Router />
}
```

DV-24: the router renders `Swatch` inside `Layout`, where `theme` is
provided, but the checker does not know that: both are checked as children
of `<Router />`. Providing `theme` above `<Router />` is accepted.

```rx
-- reject: COMPONENT_AS_VALUE
import { createRouter } from "@solidjs/router"
component Home() { <h1>Home</h1> }
export Router = createRouter({ routes: [{ path: "/", component: Home }] })
export default component App() {
  <Router />
}
```

A component a factory made is applied in its own module, where the checker
knows what it was given (MO-11f).

```rx
-- reject: COMPONENT_AS_VALUE
import { useParams } from "@solidjs/router"
component Home() { <h1>Home</h1> }
export default component App() {
  params = useParams(Home)
  <p>{params.id}</p>
}
```

Only a function declared to hand back a `Component` takes components in its
arguments.

```rx
-- reject: IO_IN_REACTIVE
import { useNavigate } from "@solidjs/router"
export default component App() {
  navigate = useNavigate()
  done = navigate("/")
  <p>{done}</p>
}
```

`useNavigate` hands back a function, which is io (MO-10b, R-io-3).

```rx
-- reject: UNHANDLED_FAILURE
import pure { fetch } from "./prelude"
import { createRouter } from "@solidjs/router"
component Page() {
  name = await fetch("name")
  <h1>{name}</h1>
}
Inner = createRouter({ routes: [{ path: "/", component: Page }] })
Outer = createRouter({ routes: [{ path: "/", component: Inner }] })
export default component App() {
  <Outer />
}
```

A factory's component handed to another factory brings what it was given
with it: `Page` is checked under `<Outer />`.

```rx
-- reject: CONTENT_MODEL
import { createRouter } from "@solidjs/router"
component Home() { <div>home</div> }
Router = createRouter({ routes: [{ path: "/", component: Home }] })
export default component App() {
  <p><Router /></p>
}
```

A factory's component renders what it was given where it is applied, with no
element of its own: `Home`'s `<div>` would close the `<p>` (SV-7d).

```rx
-- reject: C-1
import { createRouter } from "@solidjs/router"
Router = createRouter({ routes: [{ path: "/", component: Router }] })
export default component App() {
  <Router />
}
```

A factory given its own component is a cycle in the static graph (C-1).

```rx
-- reject: UNHANDLED_FAILURE
import pure { fetch } from "./prelude"
import { createRouter } from "@solidjs/router"
component Home() { <h1>Home</h1> }
Router = createRouter({ routes: [{ path: "/", component: Home }], base: await fetch("base") })
export default component App() {
  errored fallback(e) { <p>failed</p> } { <Router /> }
}
```

The factory is called once, where it is bound: its arguments are read
there, so a failure in them needs a boundary above the binding, not above
`<Router />` (MO-11f).

```rx
-- reject: COMPONENT_AS_VALUE
import { createRouter } from "@solidjs/router"
import { Swatch as swatch } from "./theme.rx"
Router = createRouter({ routes: [{ path: "/", component: swatch }] })
export default component App() {
  <Router />
}
```

A component value is applied as its tag would be, so its name is
capitalised like one (RG-4a).
