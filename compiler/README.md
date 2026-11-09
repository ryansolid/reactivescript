# compiler — ReactiveScript's crate

The production compiler (spec/11 CP-1a): a Rust crate, `reactivescript`, with
the command line `rxc`. It has parse (07), modules (09), check (02–06, 08),
signatures (MO-9) and the resolved model between check and lower (CP-6),
ported from `ref/src/`, and the lowering, ported from `ref/compile/`: each
module is built as an `oxc_ast::Program` and handed to Solid's
`solidjs-compiler` (`compile_program`, CP-1c; styles through `compile_style`,
CP-1d). Both give the same answers as the reference.

| module | port of | |
| --- | --- | --- |
| `parse.rs`, `ast.rs` | `ref/src/parse.ts`, `ast.ts` | `.rx` and `.d.rx` declarations; the AST serialises as the reference's does |
| `modules.rs` | `modules.ts` | the module graph, MO-5 cycles, MO-6 missing modules, MO-8/MO-9 declaration files |
| `check.rs` | `check.ts` | every diagnostic, with the reference's messages |
| `signature.rs` | `signature.ts` | a module's signature, printed and read back as `.d.rx` |
| `content.rs` | `content.ts` | SV-7d HTML nesting |
| `model.rs` | `model.ts` | CP-6: regions, symbols, computations with their reads, writes and calls |
| `emit.rs`, `awaits.rs` | `ref/compile/emit.ts`, `awaits.ts` | the lowering: `__rt` calls around JSX views, and each target through Solid |
| `js.rs`, `oxc.rs` | | the lowered module as a tree, then as an Oxc program (spans: spec/11 CP-1c) |
| `spans.rs` | | what the AST's spans promise (spec/11 CP-8b), and a diagnostic's range (CP-8d) |
| `project.rs`, `prelude.ts` | `ref/types/project.ts` | the TSX projection TypeScript checks (spec/13 TY-1), with mappings onto `.rx` (CP-8c) |

The Solid pin (`solidjs-compiler` in `Cargo.toml`) must be the commit in
`ref/SOLID_NEXT`.

```sh
cargo build --release
target/release/rxc check ../examples/todo.rx     # diagnostics
target/release/rxc check --json ../examples/todo.rx   # … with ranges, for an editor or an agent (CP-8d)
target/release/rxc project ../examples/todo.rx   # the TSX projection, with mappings onto .rx (CP-8c)
target/release/rxc model ../examples/todo.rx     # the resolved model, as JSON
target/release/rxc serve                         # a language server's requests, a JSON line each (CP-8e)
cargo build --lib --release --target wasm32-unknown-unknown   # … the same requests as WebAssembly (src/wasm.rs), what the server loads
target/release/rxc compile ../examples/todo.rx --out out   # modules (dom; --target ssr|universal), source maps onto .rx, style.css
target/release/rxc app ../examples/todo.rx       # the same as JSON, imports by .rx path: what the Vite front end gets
target/release/rxc check --spa ../examples/todo.rx   # a client-only build: a first load nothing holds is an error (08 CN-3d); also compile, app
npm --prefix ../ref run crate                    # CP-5: the crate against ref/ on every program
npm --prefix ../ref run crate -- --project       # … and the TSX projection, text for text, every mapping checked
RX_CRATE=1 npm --prefix ../ref run types         # the types scenarios, on the crate's projection
npm --prefix ../ref run crate -- --lower         # … and the lowered JavaScript, for every target, and its source maps
RX_CRATE=1 npm --prefix ../ref run compiled      # the scenarios, run on the crate's output
RX_CRATE=1 npm --prefix ../ref run ssr           # … served and hydrated from the crate's output
```

## The npm package: `@reactivescript/compiler`

The crate's Node-API build (`--features node`, `src/node.rs`) is the npm
package `@reactivescript/compiler`, with one binary per platform
(`@reactivescript/compiler-<platform>`, in `npm/`) as `@solidjs/compiler`
ships. Its `/vite` export (`vite.mjs`) is ReactiveScript's front end for
Solid's Vite plugin, which loads it on its own: an app installs the package
and keeps `solid()` as it is (spec/11 CP-7, decision 7).

```sh
npm ci && npm run build      # compiler.<platform>.node and its loader, index.js
npm test                     # the binding compiles a program for every target
SOLID_VITE_PLUGIN=../../solid-vite-plugin node test/vite.mjs   # every example app, built by Vite and run in Chromium
```

`test/vite.mjs` needs a built checkout of solid-vite-plugin with built-in
`.rx` (solidjs/solid-vite-plugin#471) until a release has it.

What happens to a `.rx` module in Vite:

- **Entries find themselves.** JavaScript imports only a program's entry,
  whose default export mounts the app; a dependency is a factory over the
  app (09 MO-1b) that only `.rx` imports. So an `.rx` module imported
  plainly is an entry. The program is checked and compiled whole from it
  (CP-2), once per target and again after a change to one of its files.
  Dependencies are imported as `./x.rx?rx-dep` and served from the build of
  a program that contains them; a module two programs share is one module
  (CP-4b `module`). A failed check fails the transform with the checker's
  diagnostics.
- **Already through Solid's compiler** for the environment's `generate`,
  with its map onto `.rx` (by line, CP-1c) and, on the entry, the program's
  stylesheet. Solid's plugin then runs its lazy, refresh and
  server-function passes (12 SF-7a) and links the stylesheet as a CSS module
  (CSS-4).

The app mounts a program with `createApp` from `@reactivescript/runtime`
(`../runtime`, CP-4a), as the examples do.

Not yet: hot updates of `.rx` modules are untested; server rendering in Vite
needs a request-scoped app for server functions to run in; no WebAssembly
fallback for platforms without a binary.

### Releasing

A release is a version bump merged to `main`: `npm version <patch|minor>
--no-git-tag-version` here, whose `version` script brings `npm/*` and
`optionalDependencies` along. The `compiler` workflow builds and tests
every platform on every change; on `main`, once the repository variable
`RELEASES` is `on`, it publishes a version npm does not have, platform
packages first, by trusted publishing from the `release` environment, and
tags it `compiler-v<version>`.

`@reactivescript/runtime` (`../runtime`) is released the same way by the
`runtime` workflow, tagged `runtime-v<version>`.

Once, by hand: npm sets up trusted publishing only on a package that
exists, so each of the seven packages needs a placeholder first,

```sh
npm login
for p in runtime compiler compiler-darwin-x64 compiler-darwin-arm64 compiler-linux-x64-gnu compiler-linux-arm64-gnu compiler-win32-x64-msvc; do
  npx setup-npm-trusted-publish "@reactivescript/$p"
done
```

then, on each package's **Settings › Trusted publishing**, GitHub Actions:
owner `solidjs`, repository `reactivescript`, workflow `compiler.yml`
(`runtime.yml` for the runtime), environment `release`.

`ref/` stays the specification: a change of behaviour lands there first (with
its scenario), then here, and `ref/crate.ts` keeps the two equal.
