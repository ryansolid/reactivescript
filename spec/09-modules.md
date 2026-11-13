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

---

## Diagnostics this document adds

| code | bin | rule |
| --- | --- | --- |
| `WRITE_TO_NON_SOURCE` (rule MO-2) | S | MO-2a |
| `IMPORT_ROW_MISMATCH` | S | MO-4a |
| `MODULE_CYCLE` | S | MO-5 |
| `NOT_EXPORTED`, `MODULE_NOT_FOUND` | S | MO-6a; MO-8b for a declared JS module |
| `CONTEXT_NOT_FOUND` across modules | S | MO-7, RG-7b |

## Implementation

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
   Not yet built: array destructuring (07 decision 20) is ruled but not
   parsed, and the crate and `ref/` do not yet read MO-10.
