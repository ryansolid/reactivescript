# 09 — Modules

**Status: OPEN (2026-10-23).** A program is a set of `.rx` modules. This
document says what an import binds, what crosses a module boundary, and what
the checker knows about another module (its signature, never its body). It
makes 08 CN-4b executable. `ref/src/modules.ts` loads a program,
`ref/src/check.ts` checks it module by module, and every runner executes
it: the interpreter, the Solid oracle, and the compiler, which emits one ES
module per `.rx` module (the compiled, server and types runners). `S-module-1` and `S-app-shop` cover it; `S-module-3`
covers a module read by its `.d.rx` (MO-9).

Rulings: file = module (07, 2026-10-22); a module boundary is a value
boundary (07 §1, 2026-10-22). The rest was taken by default and ruled 2026-10-26 —
see the list at the end.

---

## MO-1 — Instantiation

- **MO-1a.** `import { a, b as c } from "./x.rx"` binds names that `x.rx`
  exports. The path is relative to the importing file.
- **MO-1b.** Each module is instantiated **once per app**: its top-level
  sources, equations and effects exist once, and every importer reads the
  same ones. Module-level state is app state — not a JS module variable: on
  the server an app is a request (SV-4), so nothing in it outlives or is
  shared beyond its request. Dependencies are instantiated before their
  importers.
- **MO-1c.** [ruled 2026-10-25] A module has no markup at its top level
  (`TOP_LEVEL_MARKUP`). The app's view is the entry module's default
  component, `export default component App() { … }`: the runtime mounts it,
  as Solid's `render(() => <App />, el)`. A module imported for its exports
  may have a default component too; it is a component like any other.
- **MO-1d.** [taken by default 2026-10-27] A declaration in a nested block
  may not shadow a name an import bound (`SHADOWED_IMPORT`): rename one,
  `import { filter as keep }`. A declaration that hides an imported
  function turns every call of it in that block into a call of a
  value, which nothing checks before run time (no type checker in the
  loop, 11). Found in round 4 of the AI eval: a component's
  `source filter` hid the prelude's `filter`.

## MO-2 — The value boundary

- **MO-2a.** An imported source is read-only in the importing module:
  `x := …` and `guess x := …` through an import are
  `WRITE_TO_NON_SOURCE` (rule MO-2). The exporting module exports actions as
  its write interface (`export action select(id) { selected := id }`).
- **MO-2b.** `refresh x` and `affects x` of an imported question are
  allowed: they ask, they do not write.
- **MO-2c.** Reading an import is an ordinary read: rows, holds and lanes are
  the same as for a local name (`latest discount` in `main.rx` over
  `catalog.rx`'s question, S-app-shop instant 5).

## MO-3 — Signatures

A module is checked against its imports' **signatures**, never their bodies
(CN-4b). The checker infers a signature for every export.

| export | what an importer sees |
| --- | --- |
| `source x` | a read-only reactive name; its rows (`pending`, `lane`, `fails(…)`); whether it is a question |
| `x = e` | its rows, including `io` when it is bound to an io value |
| `fn f(ref a, b)` | its parameters (value or `ref`, E-9), whether it instantiates (RG-6), its rows, and what a promise it returns rejects with (R-f-8) |
| `action f` | `io` (R-io-2); it never fails (R-f-6) |
| `error C(…)` | an error class (R-f-1) |
| `component C` | its **summary**, below |

A component's summary is what the static application tree needs from it
(R-f-5, RG-7b), reduced to the component's own boundary:

- **what escapes its root:** the failure classes its own readers (and the
  components it applies) let out, which continue at each place it is
  applied, and the provisions it `use`s that nothing inside it provides;
- **per prop:** the classes discharged on *every* path from the
  component's reads of that prop to its root. A class not in that set comes
  out at the application with that application's argument. For
  `children`, the same holds for provisions. A prop an action reads also
  records what the action catches: an argument with another class is
  refused at the application (R-f-6);
- **what it stores (O-3):** each prop it stores where the stored value
  outlives the component (in a source of its module, or through a
  provision above it), passed on to a component that does included. A
  closure passed for one is checked at the application against that
  place. `.d.rx`: `retains(onPick: module, onFocus: ./form.rx#fields)`.

The summary is exact for the checks it serves: a class escapes a set of
paths iff it is missing from the intersection of what the paths discharge.

`ref/check.ts --signature file.rx` prints a program's signatures as `.d.rx`
text, and that text is the whole signature: it is read back in place of the
module (MO-9).

```rx
export source products: pending fails(Error) = …      // `= …`: a question (ST-5); `:= …` a plain source
export discount: pending fails(Error)
export pure fn qtyOf(id)
export action setCoupon
export component Panel(props: { title; children: catches(Error) }) shape(roots section; children-at section)
export context who: string
export component Badge(props: {}) uses(./ui.rx#who) shape(roots b)
export component Save(props: { v: unrendered action go catches(nothing) })
```

## MO-4 — Rows at the boundary

- **MO-4a.** An `.rx` import's rows are its signature's. Neither escape
  applies: `import pure { f } from "./x.rx"` where `f` is `io` in the
  signature is `IMPORT_ROW_MISMATCH`, and `fails A | B` on an `.rx` import is
  `IMPORT_ROW_MISMATCH` (both assert rows at the JS boundary only — R-io-4,
  R-f-8, CN-5).
- **MO-4b.** Without `pure`, an `.rx` import is not `io` unless its signature
  says so: a pure `fn` from another module is callable in reactive scope.

## MO-5 — No cycles

- **MO-5.** Modules that import each other in a cycle are `MODULE_CYCLE`.
  Signatures are computed dependencies first; a cycle has no first. (JS
  allows cycles between modules; Rust allows them between a crate's modules
  but not between crates. Here every module is checked as its own unit.)

## MO-6 — Names

- **MO-6a.** Importing a name a module does not export is `NOT_EXPORTED`;
  an `.rx` path that does not resolve is `MODULE_NOT_FOUND`.
- **MO-6b (Lexical across modules).** An imported component, `fn` or
  action resolves names where it was declared, never where it is applied
  (RG-7a). `ui.rx`'s `Badge` calls `initials` from `store.rx`, which
  `main.rx` does not import (S-module-1). The runtimes follow: a binding
  carries its declaring region, and a component's region is owned at the
  application but resolves names from the declaration.
- **MO-6c.** An export is a declaration at the top level of a module.
  `export type T` is importable (`import { T } from "./x.rx"`) and binds no
  value: types are text to the checker (07 §2). (The first text refused the
  import, found by S-ai2-settings.)

## MO-7 — Contexts across modules

- **MO-7 (ruled 2026-10-23).** A context is a declaration (RG-7a), so it
  crosses modules like any export: `export context who: string` in
  `ui.rx`, `import { who } from "./ui.rx"` and `provide who = …` in the
  module that renders `Badge` (S-module-1). Two modules that each declare
  `accent` declare two contexts, and a provision of one is not a provision
  of the other (S-context-1). An imported component's summary names the
  contexts it needs by declaration (`uses(ui.rx#who)`), checked above each
  place it is applied. An exported context's type is its contract on both
  sides (RG-7e): a provider in one module and a reader in another agree
  through the declaration, not through each other.

## MO-8 — Declaration files for JS modules

- **MO-8a.** A JS module may have a declaration file beside it: for
  `import … from "./api"`, the file `./api.d.rx` (an extension `.js`,
  `.mjs` or `.ts` on the import is dropped). It declares each export in
  rows, once, in the same notation as an `.rx` signature (MO-3):

  ```rx
  export pure fn fetchUser(id: number) rejects(NotFound | Offline)   // safe to call from reactive scope (R-io-4); its promise rejects with these (R-f-8)
  export fn saveUser(id: number, name: string) rejects(Offline)     // io: dirty is the default
  export error NotFound                                             // a JS class that is an error class (R-f-1)
  export type User = { id: number; name: string }
  
```

  `pure` is still the only row word that lowers taint and points one way;
  `rejects(…)` defaults to `Error`. In every `.d.rx` — written for a JS
  module or printed for an `.rx` one — `pure fn` is pure, `fn` is io, and
  `action` is an action.
- **MO-8b.** With a declaration file, the file is the row, as a signature is
  for an `.rx` import (MO-4a): an import that names an undeclared export is
  `NOT_EXPORTED`; `pure` on the import must agree (`IMPORT_ROW_MISMATCH`
  for an io export); `fails` on the import is refused. Without one, a JS
  import is what R-io-4 and R-f-8 say: io unless `pure`, `fails(Error)`
  unless narrowed at the import. The declaration is unchecked against the
  JS, as `pure` is (CN-5): it is the boundary's one statement, written once
  instead of at every import (S-module-2).
- **MO-8c.** A JS import, relative (`./util.js`) or a package's, stays an
  ES import in the compiled module, for the bundler to resolve; no
  `package.json` `#imports` alias is needed. The one exception is `./api`,
  which is the app's injected API (`createApp({ api })`, CP-4).

## MO-9 — A signature read in place of its module

- **MO-9a.** `import … from "./x.rx"` where there is no `x.rx` but there is
  an `x.d.rx` beside where it would be: the importer is checked against
  that file, read as `x.rx`'s signature (MO-3), and never sees a body —
  separate checking, as one crate is checked against another's metadata.
  With both files, the `.rx` is the module and the `.d.rx` is not read.
  With neither, `MODULE_NOT_FOUND`.
- **MO-9b.** The text is the signature, all of it (`ref/src/signature.ts`
  prints and reads it). An importer checked against a printed `.d.rx` gets
  the verdicts it gets against the body: `ref/run.ts` checks this for every
  scenario program with modules, each module against its imports' printed
  text (S-module-3 is S-module-1 with only the text). Beyond decision 5's
  words, a line carries:
  - a source's kind: `export source x … = …` asks a question (ST-5),
    `:= …` does not (`refresh x` and `guess x := …` depend on it);
  - a fn's parameters (`ref`, with their written types), `rejects(…)` (absent:
    the fn returns nothing that rejects — unlike a JS declaration's, MO-8a,
    where absent is `Error`), and `instantiates` (RG-6);
  - `export server fn f(a)` (12 SF-1; `server pure fn` when it is not io);
  - per prop: `catches(*)` where every class is discharged, `provides(…)`
    for children (RG-7b), `unrendered` for a prop only an action reads, and
    the action's name (`action go catches(…)`) for its diagnostics;
  - `uses(…)`: context keys relative to the module (`./ui.rx#who`), and
    `loading` for a reader of a client question that needs a `loading`
    above it (SV-7b);
  - `shape(…)`: what SV-7d's content-model check needs where the component
    is applied — its roots, `closes-p`, `a`, `form`, and `children-at`
    chains.
- **MO-9c.** A `.d.rx` carries rows, not code or types. The compiler binds
  an import's kinds from it (accessor, function, instantiating function,
  action, component) and imports the module's own compiled JavaScript,
  beside it (`x.rx` → `x.mjs`); the types come from the `.d.ts` TypeScript
  emits from the module's projection (13 TY-4c). A program whose module is
  only a `.d.rx` checks and compiles; it runs once that JavaScript exists
  (`ref/`'s runners have none, so S-module-3 is checked only).

## MO-10 — Solid libraries

A Solid primitive is a JS function called once in an owner that hands back
accessors, setters and stores. Its declaration (MO-8) says so in the words a
printed `.rx` signature already has (MO-9b). Nothing is added at run time: the
call is the same JS call, placed where an instantiation goes (RG-6a).

```rx
// media.d.rx, beside ./media.js, or shipped by the package (MO-10c)
export pure fn createToggle(initial: boolean): [ref boolean, (v: boolean) => void]
export pure fn createDebounced(ref source: string, ms: number): ref string
export pure fn createMediaQuery(query: string): ref boolean
export pure fn createEventListener(target: EventTarget, type: string, handler: (e: Event) => void) instantiates
```

```rx
import { createToggle, createDebounced, createMediaQuery } from "./media.js"

export component Search(props: { start: boolean, q: string }) {
  [isOn, setOn] = createToggle(peek props.start)   // once; without peek, SNAPSHOT_ARGUMENT (E-10)
  query = createDebounced(props.q, 300)            // ref: passed as () => props.q
  wide = createMediaQuery("(min-width: 768px)")
  action flip() { setOn(!isOn) }                   // `x = setOn(true)` is IO_IN_REACTIVE
  <button onClick={flip}>{isOn && wide ? query : "off"}</button>
}
```

- **MO-10a (Instantiating JS functions).** A JS declaration's `fn` may end
  with `instantiates`. As E-9 infers it for an `.rx` fn, it is inferred when a
  parameter is `ref` or the return has a `ref` part (a reader handed back means
  the call made nodes), so it is written only for a primitive with neither —
  one that registers a listener, or returns a store. A call is an
  instantiation (RG-6): once, in the caller's region, never re-evaluated; the
  primitive's owner is that region, so its cleanups run with it. Value
  arguments are snapshots (E-10); a `ref` argument is passed as an accessor,
  `() => e` (RG-6b), which is Solid's `Accessor<T>` argument. It must be bound
  (`INSTANTIATION_NOT_BOUND`). A primitive is declared `pure fn`, as a
  printed `.rx` one is (`export pure fn toggle(ref start: boolean)
  instantiates`): making it writes no reactive state but its own, so it is
  called where its value is bound; what it hands back is MO-10b's. `.rx` has no accessor type: `ref` is the one
  word for an accessor at the boundary, in either direction.
- **MO-10b (What the result is).** The return says what `.rx` sees:
  - `ref T` is a *reader*. Bound by destructuring or projection, it is an
    equation of `T`, read without a call (`isOn`, not `isOn()`): the name is
    bound to the accessor and each read compiles to its call, with no node of
    its own. Passed to a `ref` parameter, the accessor is passed as it is, not
    wrapped again. In imperative scope a read is its value, as any
    equation's.
  - A function type is `io` (R-io-3): callable only in imperative scope.
    A primitive's functions write, so `pure` on a part is not offered.
  - Anything else, a store or a plain value, is a value. A store's fields
    track at run time as Solid's do. A store passed *in* is likewise passed as
    itself; an `.rx` structured source is a store behind a signal slot (11), so
    a whole write (`todos := next`) swaps it, and a value parameter misses
    that: `SNAPSHOT_ARGUMENT` stands (`peek todos` says it is meant), and an
    API that takes an accessor of a store declares `ref`.
  - Only the return and its tuple or object parts are declared; an accessor
    nested deeper is a value.
- **MO-10c (Where a package's declaration is).** Beside the file the import
  resolves to, as MO-8a's is beside a relative module and a `.d.ts` beside its
  `.js`: `@solid-primitives/media` resolves through the package's `exports`
  with the build's conditions to `dist/index.jsx`, and its declaration is
  `dist/index.d.rx`. No export condition is needed. A package whose
  conditions resolve to more than one file ships the declaration beside
  each; the rows of one export are the same in every build.
  A package that ships none is declared through a local module: `./media.js`
  re-exports it and `./media.d.rx` beside it declares it (MO-8a, MO-8c).
  Without either, the import is what R-io-4 says, and `import pure` of a
  primitive is unchecked (CN-5): the call is then lifted (E-9) and re-runs,
  rebuilding the primitive, whenever an argument changes.
- **MO-10d (Holds; Ryan 2026-11-13).** Solid promises nothing about an
  accessor: any read can hold. A reader bound from a `ref` result is checked
  as a reader of a question (ST-5): `pending?`, `latest` and `loading` apply,
  with whatever hold checks a reader of `await` gets. Its hold is visible
  where it is bound, at the instantiation, as a question's is at its `await`.
  No declaration can say an accessor never holds.
- **MO-10e (What stays the library's).** A call to a foreign setter is not a
  write of a source: O-4 and AC-1 see only `.rx` sources. So a read of `isOn`
  after `setOn(v)` in the same action reads the value before the write, under
  Solid's batching, and AC-1d cannot say so; the guide teaches it. A plain
  closure passed as a callback option is unchecked, as O-4a's is.

## MO-11 — Solid components and routers (taken by default 2026-11-13; veto here)

A Solid component is a JS function from props to a view. Its declaration
(MO-8) says so, and `.rx` applies it as it applies its own. A JS function may
also hand back a component, which is how `@solidjs/router` 2.0 makes its
router from a route table, and either may take components as values where
the declaration asks for them. Nothing is added at run time: an application
is the same JSX, a factory's call is MO-10's once-only call, and a component
value is the compiled component.

```rx
// router.d.rx, beside ./router.js (`export { createRouter, useParams, useNavigate } from "@solidjs/router"`)
export type Params = Record<string, string>
export type RouteDefinition = { path?: string; component?: Component; children?: RouteDefinition[] }
export pure fn createRouter(config: { routes: RouteDefinition[] }): Component
export pure fn useParams(): Params instantiates
export pure fn useNavigate(): (to: string) => void instantiates
```

```rx
import { createRouter, useParams } from "./router.js"
import { fetchPerson, NotFound } from "./people.js"

component Layout(props) {
  <nav><a href="/">Home</a> <a href="/people/1">Ann</a></nav>   // the router handles a link's click
  <main>{props.children}</main>
}
component Home() { <h1>People</h1> }
component Person() {
  params = useParams()                      // once, in the page's region (MO-10a); a store: params.id tracks
  person = await fetchPerson(params.id)     // per-route data: asked again when the param changes
  errored fallback(e: NotFound) { <p>{e.message}</p> } {
    loading fallback { <p>loading…</p> } { <h1>{person.name}</h1> }
  }
}
Router = createRouter({ routes: [{ path: "/", component: Layout, children: [
  { path: "/", component: Home }, { path: "/people/:id", component: Person }] }] })

export default component App() {
  <Router />
}
```

- **MO-11a (Declared components).** A JS module's `.d.rx` may declare a
  component: `export component Link(props: { href: string; children?: View })`.
  Each field is a TypeScript type (TY-4b): `View` for a view (07 §6),
  `Component` (`Component<P>`) for a component value (MO-11c). A field may
  start with `catches(…)`, what the component discharges for it (MO-3).
  After the props, `fails(…)` says what escapes its root and `shape(…)` what
  SV-7d needs where it is applied (MO-9b's words). Absent, each is empty.
  The application is any component's, `<Link href="/">home</Link>`, and it
  lowers to the import as a JSX tag; with no children it is JSX's `<X />`,
  with no `children` prop (an `.rx` component's is an empty view). A JS
  import applied without a declaration is `UNKNOWN_COMPONENT`, and the
  message names the line to write.
- **MO-11b (What the checks see).** A declared JS component is one step of
  the static application tree, with its declaration as its summary (MO-3):
  an argument's failures, and its children's (RG-4c), continue at the
  application unless the field `catches` them, a prop it does not declare
  included; it needs no provision. What its own body reads is outside the
  graph (CN-3b): its pending is not seen, and its failures are not in the
  row unless `fails(…)` names them. Solid's boundaries take them at run
  time, as they take a panic (CN-6b).
- **MO-11c (Components as values).** A component, declared in this module
  or imported, and named with a capital as its tag would be, may be the value of a JS component's prop whose declared type
  is `Component` (`<Shell header={Title} />`), or sit anywhere inside the
  record and array literals of a factory's arguments (MO-11f). Those are the
  only places a component is a value (`COMPONENT_AS_VALUE` elsewhere): `.rx`
  has no way to apply a value, so only JS takes one. The checker checks it
  as applied there, with no arguments, among the children of the
  application (for a factory, of every application of the component it made):
  what escapes it (R-f-5), the provisions it uses (RG-7b), a first load it
  waits on (CN-3d) and its content model (SV-7d) are checked above that
  application, on every path, whether or not the library ever renders it.
  Its props are the library's (`params`, `location`, `children`) and carry
  no rows. It lowers to the compiled component itself.
- **MO-11d (Hooks).** A library's hooks are MO-10's primitives. `useParams`
  and `useLocation` hand back a store, a value whose fields track at run
  time (MO-10b), so `id = params.id` follows the URL. `useNavigate` hands
  back a function, which is io (R-io-3) and called from an action or a
  handler. Each is called once, in the component's region (MO-10a), which
  is where Solid's `useContext` finds the router. A hook called with no
  router above throws at run time; the checker does not know the router's
  context.
- **MO-11e (Route data).** A route's data is an `await` equation over its
  params, in the route's component: `person = await fetchPerson(params.id)`.
  A change of `params.id` is a new question, held as any re-ask is (H-2); a
  newly matched route mounts its component, whose question holds where
  nothing above it shows a fallback. Its failures and its first load are
  checked above `<Router />` or in the page (MO-11c). The router's `query()`
  is a JS function: wrapped in a JS module and declared `pure fn`, it is
  awaited like any other, and its cache is the library's. A route's
  `preload` is a closure handed to JS, unchecked (MO-10e).
- **MO-11f (Component factories).** A JS fn whose declared result is
  `Component` hands back a component: `createRouter(config): Component`. Its
  call is an instantiation (MO-10a; `instantiates` is inferred from the
  result), so it is bound once (`Router = createRouter({ … })`), and the
  bound name is a component, applied in a view (`<Router />`) and never read
  as a value. The components in its arguments are values there (MO-11c).
  The checker knows what the call was given only in the module that makes
  it, so the made component is applied there: `export Router = …` is
  `COMPONENT_AS_VALUE`; export the components it takes instead. For SV-7d
  the made component has no element of its own: what it was given is
  checked where it is applied, and counts in the shape of the component that
  applies it (as a component value does). Links need
  nothing of the language: the router handles a click on any `<a href>`.
- **DV-24 (a component value is owned at its application) — taken by
  default 2026-11-13.** Solid lets a library render a component value
  anywhere: under any owner, any number of times, or never. MO-11c's check
  assumes it is rendered beneath the owner of the application it was passed
  to, which is what `@solidjs/router` does (every route renders inside
  `<Router />`, so an `errored` or a `provide` above `<Router />` reaches it).
  A library that renders one under a root of its own escapes the check
  (CN-3b); Solid's run-time errors stand there. The assumption also gives
  away precision: a route component is checked as a child of `<Router />`,
  not of its parent route's `props.children`, so a `provide` or an
  `errored` in a layout route is not credited to the routes it wraps. A
  layout that provides a context to its pages is refused
  (`CONTEXT_NOT_FOUND`); provide it above `<Router />`.

### Design note: why declared components and factories, not a routing form

`@solidjs/router` 2.0 (`2.0.0-next.44`) is a route table, not markup:
`createRouter({ routes })` returns the router component, a route is an
object whose `component` is a component, and a link is a plain `<a href>`.
Three ways were weighed for using it from `.rx`.

- **(a) Declared JS components and factories (taken).** MO-11a to MO-11f.
  The router's own API is usable as it is, and so is any Solid component
  library: two declaration forms and one value rule, with no router
  semantics in the language. What the checks keep across the boundary:
  R-f-5 and RG-7b over every route as if rendered at `<Router />` (MO-11c);
  CN-3d over every route's first load, so a client-only app cannot ship a
  page that shows nothing while it loads; SV-7d where a declaration writes
  `shape(…)`; owner order on both sides is Solid's, since the router and
  the compiled components are both Solid code (CP-4a). What they lose:
  which route renders when, a layout route's boundaries and provisions
  (DV-24), and the hooks' context (MO-11d). Types are TypeScript's, from the
  router's own `.d.ts`, in `rx-tsc` (TY-1c).
- **(b) A routing form in the language** (`routes { "/people/:id" => Person }`,
  compiled onto `createRouter`). The checker would know the route tree, so
  it could credit a layout's `errored` and `provide`, type each route's
  params from its path, and check a link's target. The cost is a form whose
  meaning is one library's, a second place to follow the router's releases
  (its 2.0 API moved from `<Router>`/`<Route>` markup to a route table while
  this was written), and no help for any other component library. Most of
  what it would prove can be added to (a) later as declaration words.
- **(c) Something smaller.** Only the hooks from `.rx`, with the route table
  in TSX. That needs TSX to import an `.rx` page as a Solid component, but a
  compiled module's default export is a function of the app (CP-4a), not a
  component, and the projection's default export is drafted elsewhere (#65).
  It also checks nothing across the routes. (a) does not need it; it
  remains a separate interop question.

Executable: S-module-5 (declared components and component values, checked
only), S-module-6 (the router: a factory, hooks, route data; checked only,
against a package that ships its `.d.rx`), and `examples/router/`, built by
Vite with `@solidjs/router` 2.0.0-next.44 and driven in Chromium
(`compiler/test/vite.mjs`).

---

## Diagnostics this document adds

| code | bin | rule |
| --- | --- | --- |
| `WRITE_TO_NON_SOURCE` (rule MO-2) | S | MO-2a |
| `IMPORT_ROW_MISMATCH` | S | MO-4a |
| `MODULE_CYCLE` | S | MO-5 |
| `NOT_EXPORTED`, `MODULE_NOT_FOUND` | S | MO-6a; MO-8b for a declared JS module |
| `CONTEXT_NOT_FOUND` across modules | S | MO-7, RG-7b |
| `UNKNOWN_COMPONENT` for an undeclared JS component, `COMPONENT_AS_VALUE` outside MO-11c's places | S | MO-11a, MO-11c, MO-11f |

## Implementation

- MO-10: `parseDeclarations` reads `ref`, `ref T` and `instantiates` into a
  declaration's `refs` and `shape`; the checker binds a primitive as an
  instantiating fn (so E-9, E-10 and RG-6's checks are an `.rx` fn's) and
  marks each equation bound from its result a reader, an io function or a
  value. The lowering calls it once and binds a `ref` part to the accessor
  itself. A package's declaration is found by `packageDeclaration`
  (`modules.ts`, `package_declaration` in the crate). The scenarios' Solid
  library is `./prims` (`ref/src/prims.ts`: the `.rx` the interpreter runs,
  and `compile/prims-solid.ts`, the Solid primitives the other runners call).
- `ref/src/modules.ts` loads an entry and every `.rx` module it imports,
  sets each import's resolved key, orders them dependencies first, and
  reports cycles and missing modules. Scenarios declare modules in a
  `## Modules` section (fences beginning `-- module: ./x.rx`); a `file:`
  program finds its modules beside it on disk.
- `checkModules` checks each module in that order, against the signatures
  computed so far, and produces its signature. The failure check (R-f-5)
  and the provision check (RG-7b) are one pass over the static application
  tree: each step up from a reader records what it discharges — failures at
  a boundary or a catch, provisions at a `provide` — and an imported
  component's summary is one such step.
- A `.d.rx` found in place of an `.rx` import (MO-9) is parsed by
  `parseSignature` into `ModuleSet.signatures`, which `checkModules` starts
  from; such a module has no program and is not in `order`.
- The interpreter instantiates each dependency in a region of its own; the
  oracle declares it in a scope of its own inside the mounted root. The
  compiler emits `mN.mjs` per dependency — a factory over the app that
  `__rt.module` runs once — and `main.mjs` for the entry, which
  instantiates its dependencies at the start of its view.

## Decisions (all ruled; the last open ones 2026-10-26)

1. **Module state is a singleton per app** (MO-1b; ruled 2026-10-26), as module-level
   signals are in Solid.
2. **No import cycles** (MO-5; ruled 2026-10-26).
3. **`.rx` rows are the signature's** (ruled 2026-10-26): `pure` must agree and `fails` is
   refused on an `.rx` import (MO-4a).
4. **Contexts are declared** (MO-7, ruled 2026-10-23). The keyword
   `context`, and defaults allowed except on a `source` context, ruled
   2026-10-26 (07 #13). Ruled 2026-10-26 with the rest: an exported context's type is its contract, a
   module's own context infers its rows unless it writes them.
5. **The `.d.rx` notation** (ruled 2026-10-26): `catches(…)` on a prop is what the component
   discharges for it; `action catches(…)` is what an action reading it
   catches; `fails(…)` after a component is what escapes its root;
   `uses(…)` the provisions it needs.
6. **A `.d.rx` read in place, and the words it adds** (MO-9; taken by default 2026-10-26, veto
   here): an `.rx` import with no `.rx` file reads `x.d.rx`; the `.rx`
   wins when both exist (a stale `.d.rx` is not compared with it — noted:
   checking it against the computed signature, as an `.mli` is, would be a
   static check this could add). The added words are MO-9b's; `uses(…)`
   names keys by relative path (`./ui.rx#who`) where it named a bare file
   name, so that a key is exact across directories.
7. **Solid libraries are declared, not wrapped** (MO-10; taken by default
   2026-11-13, veto here). A JS `.d.rx` takes `instantiates` and `ref`, the
   words of a printed signature, and `ref T` in a return (new: `ref` in a
   type position, in JS declarations only — an `.rx` import never needs it,
   since a returned equation is its value). `instantiates` is inferred from
   `ref` and written only where neither side has one. Ryan, 2026-11-13: any
   accessor can hold (MO-10d), and the notation is `.rx`'s, with no
   `Accessor` type. A package ships its declaration beside the file its import
   resolves to, as a `.d.ts` beside its `.js` (an `"rx"` export condition was
   drafted and dropped, Ryan 2026-11-13: nothing needs it), else a local
   re-export declares it; a project-level folder of
   declarations keyed by package was the alternative, not taken.
   Built in `ref/` and the crate (S-module-4).
8. **Solid components and factories are declared, and components are values
   only to JS** (MO-11; taken by default 2026-11-13, veto here). Open for a
   maintainer:
   - (a) over a routing form (b): the design note above.
   - A JS component's fields are TypeScript types, with `catches(…)` as the
     only row word on a field. Its own failures default to none (CN-6b), not
     to `Error` as a JS fn's rejections do (MO-8a): `.rx` does not await a
     component's body.
   - A component is a value only on a `Component` prop of a JS component or
     inside a factory's argument literals; an `.rx` component cannot take
     one (it would need a form to apply a value).
   - A factory's component is applied only in the module that makes it
     (MO-11f). Exporting it would need its summary to carry the escaping
     rows of the components it was given.
   - DV-24: a component value is checked as applied among the children of
     the application it reaches. A word that says where the library renders
     it (a route's `component` inside its parent's `props.children`) would
     credit layout boundaries and provisions; not added.
   - The hooks' context is not checked statically (MO-11d). A `uses(…)`
     word naming a JS context, satisfied by the factory's component, would
     make `useParams` outside the router a compile error; not added.
   - `.rx` has no type arguments, so `useParams<{ id: string }>()` cannot be
     written: a param is the router's `string | undefined` in `rx-tsc`.
     `defineRoute`'s typed params, or a declaration word for them, are open.
   - Not covered: TSX importing an `.rx` page (CP-4a's default export, #65),
     and the router under SSR (`ref/ssr` runs no JS component; a server
     render needs the router's `url`).
