# Changelog

## Unreleased

**New**

- Under `vite dev`, an edit inside a dependency's components re-renders them in place instead of reloading the page:
  the module's top-level sources and every other component's state are kept. An edit to the module's top level or to
  an entry still reloads. The runtime's new `@reactivescript/runtime/hot` entry does the swap; it needs a
  `@solidjs/vite-plugin` with the front end's `hotUpdate` hook.

**Fixed**

- `affects` on a keyed or structured source that takes a guess threw `INVALID_AFFECTS_TARGET` in a dev build, so the
  action never reached its `await`, and did nothing in a production build, so `pending?` stayed false (#50,
  S-affects-keyed).
- A keyed source that takes a guess (`source rows key id = q.rows`) merges each answer by key instead of replacing every
  row, so a row's readers re-run only when its own leaves change (#51).
- The guide's action example (`guide/async.md` §3) lost an error thrown before the first `await`: the `onFlush` clear
  ran after the catch. The catch now writes the error through `onFlush` as well (#52).

## 0.3.1

**New**

- Spread attributes in markup, `<button {...rest}>` and `<Inner {...rest} />`, lowered to Solid's spread and `merge`:
  later attributes override, and each field keeps updating (07 §4, S-surface-5).

## 0.3.0

`@reactivescript/compiler`, `@reactivescript/runtime`, `@reactivescript/language-server` and the editor extension,
together.

**Breaking**

- `UNGUARDED_SNAPSHOT` (R-8) is stricter: an `errored` region or `disabled` covers a failure only when it reads the
  value. A region whose content reads `x` only under `pending? x` never shows its fallback, so it no longer counts
  (#58).

**New**

- Solid libraries (MO-10): declare a primitive once in a `.d.rx` (`export pure fn createToggle(v: boolean): [ref
  boolean, (v: boolean) => void]`) and use it like .rx: it is called once, `ref` arguments go in as accessors, readers
  are read without a call, and setters are io. A package's `.d.rx` sits beside the file its import resolves to.
  `guide/libraries.md` (#57).
- The guide (shipped in `@reactivescript/compiler`) places data by its lifetime: what a visit, a write or the screen
  needs, with a module only for data whose writes outlive their page (#58, #59).

**Fixed**

- `refresh` of a keyed equation re-asks it. It used to re-ask nothing in compiled code (#58).

## 0.2.0

`@reactivescript/compiler`, `@reactivescript/runtime`, `@reactivescript/language-server` and the editor extension,
together.

**Breaking**

- `optimistic` is now `guess` (`guess todos := …`), and errors clear with `onFlush` (#47). `optimistic` is no longer
  a keyword.
- A new check, `GUESS_WHILE_LOADING` (AC-3a): a guess written before its value has been shown is an error (#53).

**New**

- `rx-tsc`, in `@reactivescript/language-server`: TypeScript's `tsc` with `.rx` files in the program, for CI (#41).
- `else if` in markup: `{if a { … } else if b { … } else { … }}`.
- A guess over an equation, as Solid's `createOptimistic(fn)` (#48).
- Destructuring (RG-4b): live in declarations, a snapshot in `let`, with rest (#49).
- Parse errors are coded and name the JS or React habit they come from; every code has a page in
  `guide/diagnostics.md`, linked from Vite, `rx-tsc` and the editor (#42).

**Fixed**

- A relative JS import (`import pure { f } from "./util.js"`) compiles to an ES import. It used to fail as "not in
  the scenario prelude", so a package.json `#imports` alias was needed. `./api` is still the app's injected API.
