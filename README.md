# ReactiveScript

A small language for reactive UIs that carries
[Solid](https://github.com/solidjs/solid) 2.0's reactive semantics as
*language* semantics, and checks them before your code runs. Files are `.rx`;
they compile to plain Solid 2.0.

> **Status:** experimental, 0.1. The spec, its scenarios and the compiler
> still change often, and releases follow Solid 2.0's release candidates. See
> [CONTRIBUTING.md](CONTRIBUTING.md) to run the suite or propose a change.

## Why

In Solid you already write UIs as derivations over signals. Most of what goes
wrong is a *shape* mistake: writing to something that should be derived,
writing during a computation, reading async data with no loading or error
boundary above it, leaking a value past the owner that created it. Solid's
dev runtime warns about many of these when they happen. ReactiveScript makes
them things the compiler refuses, the way Rust refuses a borrow, so the
program that runs is one where those mistakes cannot happen
([spec/08](spec/08-constraints.md), [spec/99](spec/99-diagnostics.md)).

The checks are static only. A `.rx` program compiles to ordinary Solid 2.0
code and adds nothing at run time beyond what Solid does
([spec/11](spec/11-compiler.md)).

It is also meant to be easy for an AI to write correctly. The rules are
small and explicit, and each checker error names the rule it enforces and usually the fix. We
test that directly: fresh agents given only the spec wrote the apps in
[`examples/ai`](examples/ai) and [`examples/ai2`](examples/ai2) cold and
predicted 70 of 71 frames of their behaviour before running them
([examples/README.md](examples/README.md)).

## A taste

Three kinds of names do all the work:

- `source x := 0` is state. Only a source can be written, with `:=`.
- `y = x * 2` is an **equation**: it is always true, and recomputes when
  what it reads changes (E-1).
- Writes happen only in imperative scope: an event handler or an `action`
  (W-1, W-2).

```rx
export default component Counter() {
  source count := 0
  double = count * 2

  <button onClick={() => { count := count + 1 }}>{count} × 2 = {double}</button>
}
```

Write to the equation instead, `double := 4`, and the checker refuses it:

```
counter.rx:5: error WRITE_TO_NON_SOURCE [W-1] double is an equation: only sources are written (W-1)
```

Async is an `await` in an equation. The compiler tracks that the value can be
pending and can fail, so it asks you to say what to show in both cases:

```rx
import pure { fetchUser } from "./api"   // `pure`: safe to call from an equation (R-io-4)

export default component Profile() {
  source id := 1
  user = await fetchUser(id)              // re-asked whenever `id` changes

  <section>
    <button onClick={() => { id := id + 1 }}>Next</button>
    {errored fallback(e) { <p>Couldn't load: {e.message}</p> } {
      {loading fallback { <p>Loading…</p> } {
        <h1>{user.name}</h1>
      }}
    }}
  </section>
}
```

Leave out the `errored` boundary and it does not compile:

```
profile.rx:10: error UNHANDLED_FAILURE [R-f-5] a reader of user.name (in <Profile>) can fail with Error and no catch or errored boundary above it discharges Error — wrap it in `errored fallback(e) { … } { … }`, or catch it: `… catch (e) => …`
```

Beyond this the language has structured stores with per-path writes
([spec/06](spec/06-stores.md)), optimistic updates and held values while new
data loads ([spec/05](spec/05-holds.md)), modules that own their state and
export actions to change it ([spec/09](spec/09-modules.md)), streamed SSR with
hydration ([spec/10](spec/10-server.md)), `server fn` for code that runs on
the server ([spec/12](spec/12-server-functions.md)), scoped `<style>`
([spec/07](spec/07-surface.md)), and types checked by TypeScript through a
TSX projection ([spec/13](spec/13-types.md)). For whole apps, start with
[`examples/todo.rx`](examples/todo.rx) and
[`examples/signup.rx`](examples/signup.rx).

## What's here

| | |
| --- | --- |
| [`spec/`](spec) | the language, as numbered rules |
| [`scenarios/`](scenarios) | about 100 executable cases: program, actions, expected frames, accepted or refused |
| [`examples/`](examples) | real apps in `.rx` |
| [`ref/`](ref) | the reference implementation in TypeScript: interpreter, checker, compiler, and runners that check every scenario against Solid itself |
| [`compiler/`](compiler) | the production compiler, a Rust crate (`rxc`) built on Solid's own compiler; also the npm package `@reactivescript/compiler` with a Vite front end |
| [`runtime/`](runtime) | `@reactivescript/runtime`, the small layer compiled `.rx` calls over Solid |
| [`tooling/rx-language-server`](tooling/rx-language-server) | the `.rx` language server: TypeScript's hover, go to definition, rename, completion and type errors on `.rx`, plus the checker's diagnostics with their rules |
| [`tooling/vscode-rx`](tooling/vscode-rx) | the VS Code extension: highlighting, and the language server |

## Install

ReactiveScript 0.1 is experimental. It follows Solid 2.0's release
candidates, so expect breaking changes until Solid 2.0 is final.

**In a Solid app (Vite).** Install the compiler and the runtime beside Solid
2.0:

```sh
npm i solid-js@next @solidjs/web@next @solidjs/signals@next @reactivescript/runtime
npm i -D vite @solidjs/vite-plugin @reactivescript/compiler
```

Keep `solid()` in `vite.config.js` as it is. Solid's Vite plugin
(3.0.0-next.57 or later) finds the compiler and compiles `.rx` on its own
(spec/11 CP-7).

```rx
// src/app.rx
export default component App() {
  source count := 0
  doubled = count * 2
  <button onClick={() => { count := count + 1 }}>{count} × 2 = {doubled}</button>
}
```

```js
// src/main.js
import { createApp } from "@reactivescript/runtime";
import main from "./app.rx";

const app = createApp({ root: document.getElementById("app") });
app.mount(main(app));
```

**In an editor.** Install the ReactiveScript extension (publisher
`solidjs`) from the VS Code Marketplace, or from Open VSX for Cursor
and VSCodium. It brings highlighting and the language server. Other editors
can run the language server on its own: `npx @reactivescript/language-server
--stdio` ([`tooling/rx-language-server`](tooling/rx-language-server)).

**In CI.** Vite compiles `.rx` without type-checking it, as it does `.ts`.
`rx-tsc` is `tsc` with `.rx` in the program: the same check the editor runs,
plus the checker's errors with their rules.

```sh
npm i -D @reactivescript/language-server typescript
npx rx-tsc --noEmit
```

It reads `tsconfig.json`, whose `include` must name the `.rx` files
(`"include": ["src"]` or `["src/**/*.rx", "src/**/*.ts"]`), with Solid's JSX:
`"jsx": "preserve"`, `"jsxImportSource": "@solidjs/web"`.

How releases are made: [`tooling/RELEASING.md`](tooling/RELEASING.md) and
[`compiler/README.md`](compiler/README.md).

## Try it

You need Node 22 or later. The checker and the interpreter run straight from
the repo with no install:

```sh
git clone https://github.com/solidjs/reactivescript && cd reactivescript
node --experimental-strip-types ref/check.ts examples/todo.rx   # check a program
node --experimental-strip-types ref/run.ts                      # run every scenario
```

Running the scenarios on Solid itself needs Solid's `next` branch built from
source (pnpm and a Rust toolchain); see [CONTRIBUTING.md](CONTRIBUTING.md) and
[`ref/README.md`](ref/README.md). The compiler builds with Cargo
([`compiler/README.md`](compiler/README.md)). To try an unreleased editor build, install a `.vsix` from a run of the
repository's `editor` workflow, or build one
([`tooling/vscode-rx/README.md`](tooling/vscode-rx/README.md)).

## Reading the spec

The spec is the product: every behaviour claim is a numbered rule or a
scenario. A good order for a first read is
[00 vocabulary](spec/00-vocabulary.md) (each term mapped to Solid's),
[01 scopes](spec/01-scopes.md), [02 core](spec/02-core.md), then
[07 surface](spec/07-surface.md) for the syntax and
[08 constraints](spec/08-constraints.md) for what the compiler refuses.
Semantics come from Solid 2.0 (`solidjs/solid@next`); where this spec departs
from Solid it records a `DV-n`.

### Layout

```
spec/
  00-vocabulary.md     the nouns; each mapped to its Solid 2.0 term
  01-scopes.md         reactive vs imperative scope; lexical inheritance
  02-core.md           the synchronous calculus: syntax, static rules, instants, pre, causality
  03-regions.md        ownership, disposal, escape
  04-rows.md           effect rows: pending, lane, io, fails; inference
  05-holds.md          the two-version store; Solid's F-1…F-12 restated over the calculus
  06-stores.md         structured types, paths, draft, key/reconcile, follows
  07-surface.md        concrete syntax — written LAST
  08-constraints.md    what the compiler refuses, how, and the escape (Rust stance)
  09-modules.md        .rx modules: what an import binds, the value boundary, signatures
  10-server.md         SSR as the streamed mount; what runs where; hydration; what crosses
  11-compiler.md       the production compiler: a crate on solidjs-compiler; the one seam it needs
  12-server-functions.md  server fn (io inferred, the call site decides); the server and client rows; the wire
  13-types.md          types: the program projected to TSX and checked by TypeScript
  99-diagnostics.md    Solid 2.0's diagnostic table, each code binned: unwritable / static / runtime
scenarios/             one file per scenario: program, action, frames, compiles-or-rejects
ref/                   interpreter, checker, Solid oracle, compiler and server runner (TypeScript) — all run scenarios/
```

### Discipline

1. **Core before holds.** `02-core.md` is finished and `ref/` passes its scenarios
   before `05-holds.md` opens. The two are separate documents on purpose.
2. **Rules and screens, not prose.** Every claim is a numbered rule or a scenario
   (program → action → frames → verdict). A section that cannot be written that
   way is not ready.
3. **One grammar.** `07-surface.md` is the concrete syntax; `ref/` parses it
   and every scenario is written in it. `02-core.md §1` keeps the abstract
   syntax the rules are stated over.
4. **Solid's fundamentals are upstream.** `05-holds.md` inherits
   `packages/signals/docs/RULES-FUNDAMENTALS.md` from `solidjs/solid@next`. An
   open question there (Q-n) is open here; this spec does not rule on it.

### Rule IDs

- `V-n` vocabulary (00) · `SC-n` scopes (01)
- `E-n` equations · `W-n` writes · `C-n` causality · `P-n` properties of an instant · `EF-n` effects · `IO-n` io (02)
- `O-n` ownership · `RG-n` regions · `PT-n` portals (03)
- `R-n` rows · `R-f-n` failures · `R-io-n` io (04)
- `H-n` holds, each citing the Solid `F-n` it restates; `DV-n` divergences from Solid, recorded per scenario (05, 10)
- `ST-n` stores · `AC-n` actions (06) · `CSS-n` scoped styles (07) · `CN-n` constraints (08)
- `MO-n` modules (09) · `SV-n` server (10) · `CP-n` compiler (11) · `SF-n` server functions (12) · `TY-n` types (13)
- Diagnostics keep Solid's codes (`UNHANDLED_FAILURE`), binned in 99.

Scenario IDs: `S-<area>-n` for the areas above (`S-core`, `S-region`,
`S-hold`, `S-store`, `S-action`, `S-fail`, `S-module`, `S-server`, `S-sf`,
`S-types`, …), `S-solid-n` for a port of Solid's `SCENARIOS.md` `S-n`, and
`S-app-*`, `S-ai-*`, `S-ai2-*` for the example apps under `examples/`.

### References

- **Revisiting ReactiveScript** —
  <https://hackmd.io/@0u1u3zEAQAO0iYWVAStEvw/BktlDvq9R>. Earlier thinking
  (before TSRX), kept for the record; later decisions supersede it where
  they differ. The case for the language as *strictness*, narrowed to two
  concerns, and where this spec answers each:
  - *Signals vs stores* — one `source`, atomic or structured behind a signal
    slot (06 ST-1, ST-2a); a mutable derivation is a `draft` (ST-3, its
    `$project`); `$memo` is an equation (E-1), `$async` an `await` in an
    equation's tail (R-1).
  - *Read vs write* — writes only in imperative scope (W-1, W-2), only by
    the declaring region or what it nests (W-5, O-4); an imported source is
    read-only and is written through the actions its module exports (09
    MO-2a).
  - *Reactivity crossing a function boundary* (its open question: what a
    `$` function may return) — reactivity is a property of names, not
    values: a `ref` parameter takes an equation by reference (E-9), an
    instantiating `fn` runs once and its tail is bound as an equation in
    the caller (03 RG-6), and a writer crosses only as an `action` the
    tail carries (`{ value: n, inc }`), never as a setter.
  - *Superset of `.tsx`, no SFCs* — superseded: expressions and JSX are
    TS's verbatim and a file is a module (07 §1); declarations are keywords
    (`source`, `x = e`), as 07 rules.

## License

[MIT](LICENSE)
