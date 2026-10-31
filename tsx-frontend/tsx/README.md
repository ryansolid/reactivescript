# Solid TSX Frontend Prototype

Oxc parses authored Solid-style TSX and `lowerTsx` constructs the existing
ReactiveScript `Program` from `ref/src/ast.ts`. This is a bounded executable
frontend, not a second checker, runtime, or a claim of full Solid/RX parity.
The shared checker, interpreter, and compiler remain authoritative.

The frontend targets only ReactiveScript's existing AST: there is no shared IR
and no node, flag, or field that exists for TSX. Every accepted form is spelled
with what an RX program could say (equations, `source x := peek(e)` snapshots,
`source x = e` questions, `fn`, one `effect` form, types as text). A Solid form
with no faithful RX spelling is refused with a diagnostic instead of being
lowered to nearby RX semantics. Frontend-only bookkeeping (which TSX exports are
plain values) lives in `lower.ts` (`immutableExports`), never in the AST.

See [MODULES.md](MODULES.md) for mixed RX/TSX module loading, builds, CLI usage,
and browser targets. [PARITY.md](PARITY.md) tracks the wider executable target,
remaining gaps, and verification boundaries. Exports never mount implicitly.

The adapter uses pinned `oxc-parser` through its explicit Node entry so the
browser condition does not select an unavailable WASM binding. JSX entities use
`entities` and `decodeHTML`, including native semicolon-less legacy/numeric
forms, not an incomplete hand-maintained entity table.
No Sound implementation is imported or depended on.

## API

```ts
import { lowerTsx } from "./lower.ts";
import { check } from "./rx/compiler.ts";

const program = lowerTsx(source, "Counter.tsx", {
  modules: new Map(), // authored source -> { path, program }
  declarations: new Map(), // authored JS source -> parsed JsDecl[]
});
const diagnostics = check(program);
```

For executable graphs, prefer the loader/build APIs documented in MODULES.md.
They attach JS declaration contracts, check the graph, select the mount, and
emit the chosen target. `lowerTsx` alone does not assert JS import purity.

## Supported Forms

| Authored form                                                                        | Existing AST and scope                                                                  |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Named synchronous uppercase component functions, optionally exported                 | `component`; same-file and resolved imported components                                 |
| Inline required primitive, record, array and handler prop contracts                  | `propsType`; live values and parameterized void `on[A-Z]` callbacks                     |
| Module/component/branch/owned-helper setup `const`                                   | Snapshot `source x := peek(e)` (E-4); function values are equations; see below          |
| Explicitly typed pure module/local helpers with inert `const` locals                 | Plain `fn` with `decls: []`; inert locals substituted into the tail; others refused    |
| Primitive `createSignal` and expression/single-return `createMemo`                   | `source` and `eq`; direct values and one-parameter signal updaters                      |
| Typed primitive previous-value memo parameter                                        | Self `pre`; initial previous value is undefined                                         |
| Solid 2 `createStore` with known record/array seed                                   | Source plus draft callback path writes                                                  |
| Synchronous `createProjection(draft => { ... }, seed)`                               | Seed snapshot source plus `eq` using `draft(pre projection -> seed)`                    |
| Primitive literals, records/arrays, known members and numeric indices                | Existing expression nodes; unsupported shape combinations fail closed                   |
| Arithmetic, strict equality, relational/logical operators, conditionals, parentheses | Existing operators; JS `===`/`!==` spell RX strict `==`/`!=`                            |
| `untrack`, `latest`, `isPending` callback probes                                     | `peek`, `latest`, `pending`                                                             |
| Fragments, comments, multiline/entity JSX text and quoted attributes                 | `el`, normalized/decoded `text`, ordinary attributes                                    |
| Primitive and nested primitive-array JSX children                                    | Explicit JS string conversion; booleans/null/undefined omitted                          |
| Conditional JSX, `&&`, non-keyed `Show`                                              | `mif`; Show callback argument is an accessor, not a value                               |
| Default `For`, one value-item callback and optional fallback                         | Identity-keyed `mfor`; no index accessor or custom key options                          |
| Extension `createRxEffect([() => input, ...], (sample, ...) => { ... })`             | RX's one `effect (inputs) { ... }` form (EF-2) with `$i` samples                         |
| Named JS calls with result annotations and declaration contracts                     | Ordinary `import`/`call`; shared checker decides purity/failure legality                |
| `createMemo(async (): Promise<T> => await call(...))`                                | `eq` with `await`; one returned await, explicit supported result shape                  |
| `Loading` and `Errored` with fallback                                                | Existing boundaries; explicit Loading `on` and one-error-accessor Errored callback      |

## Setup Consts, Effects, and Structure

Setup `const` (module, component, branch, owned-helper setup) is evaluated once,
eagerly, in Solid. RX's only eager form is a snapshot source:

- `const x = untrack(() => e)` lowers to `source x := peek(e)`.
- Any other initializer lowers to `source x := e` as written, except that reads
  of earlier setup consts and `useContext` lookups (which Solid does not track)
  are wrapped in `peek`: `const next = first + 1` is
  `source next := peek(first) + 1`. This keeps Solid's evaluate-once timing.
  Nothing else is peeked implicitly.
  Whether a name is an earlier setup const is decided by the binding it resolves
  to in the reading scope, never by spelling: a same-named const in a sibling
  component, child component or owned helper authorizes nothing.
- A function value (an accessor-typed `useContext` result, a closure, an
  accessor-typed provider seed) lowers to an equation over the snapshot
  (`read = peek(use Count)`): a source cannot hold a function as a value.
- Naming a store or projection (`const alias = state`) reads nothing; the alias
  is the store binding itself, as Solid keeps the same proxy.
- A bare tracked read (`const initial = count() * 2`, `props.x`, `state.x`, a
  source imported from an `.rx` module) is never silently snapshotted (Solid
  warns `STRICT_READ_UNTRACKED`): it stays outside `peek` and the shared checker
  reports `SNAPSHOT_INITIALIZER (E-4)` at the authored line. Write
  `untrack(() => …)` for a mount snapshot or `createMemo` for a derived value.
  Passing such a const to `createSignal` does not hide the error. (A
  `createSignal(count())` seed itself is still peeked, as before this change.)
- No setter is bound, so a const is never written; assignment is refused
  (`Assignments are only supported on the draft parameter of createStore/createProjection`).
  Exported consts are exported snapshot sources; TSX importers read them as plain
  values, RX importers as read-only sources (MO-2).
- Refused, because the RX snapshot would observe them differently from Solid:
  an unused const whose initializer could throw (`Unused setup const x: …`), a
  const reading an async value (`Setup const x reads an async value at mount; …
  (PENDING_ASYNC_UNTRACKED_READ)`), an initializer reading a binding initialized
  after it, directly or through a helper (`x reads y before its initialization
  (JavaScript's temporal dead zone)`), and server bodies capturing a const
  (`SERVER_CAPTURE (SF-3)`: pass it as an argument).

Eager initializers that could fail are refused, whether or not they are read.
This covers setup consts and signal, store, projection and provider seeds.
Solid throws during setup, to the boundary above the owner, before any boundary
inside it exists. An RX `source x := e` holds the failure and raises it at its
readers, perhaps inside an inner boundary, an untaken branch or a closure, and
the AST cannot carry Solid's routing. The diagnostic is `Setup const x can fail
at mount (…): …`, or `The eager initializer of x (a signal, store, projection or
provider seed) can fail at mount (…)`. The frontend accepts only a conservative
total subset, resolved lexically in this module:
- literals, operators, records/arrays, closures;
- earlier snapshots and signal/store values;
- calls of helpers whose tails are total, and array builtins whose callbacks
  are total;
- JS imports declared to reject nothing;
- equations and questions whose expressions are total;
- props fields of a non-exported component whose every application site in
  this module passes a total value;
- anything wrapped in a catch-all `catchFailure(…, [Error] or undefined, …)`.

Refused as possibly failing:
- explicit throws, including through helpers and memos;
- selective catches, since full discharge is not proved without class
  inference;
- JS imports that can reject, server functions, actions and callback values;
- reads of non-snapshot imports;
- props of exported components, whose callers in other modules are unknown.

An initializer with a bare reactive read is left to the shared checker's
`SNAPSHOT_INITIALIZER`.

Pure helpers are RX `fn`s with `decls: []`, whose body is one expression, so a
`const` local can only be substituted at its uses. Purity alone does not make
that sound: a call, member access, record/array literal or reactive read could
be evaluated a different number of times, in a different order, with a
different identity, or skipped in an untaken branch. Only inert locals are
substituted: literals, parameters, earlier locals, setup consts with inert
initializers, and operators, conditionals and templates over them. Any other
local is refused with `Pure helper local x cannot be lowered: an RX fn body is
one expression, …`. Unused locals are refused (`Unused pure helper local x: …`),
as is a substitution that an inner binding would capture. Imperative handler
bodies keep their `let` statements.

Effects: only `createRxEffect` is lowered, to RX's one `effect` form (EF-2
per-input value comparison). Plain Solid `createEffect` is refused with
`createEffect is not lowered: ReactiveScript has one effect form with per-input
value comparison (EF-2). Use createRxEffect from reactivescript-tsx`.

Structure is the type (ST-1): function-form `createStore` writes its value
contract as the source's `type` text, and the emitter lowers a question source
whose type is an object or array type as a store (as it does for path-written
questions). Object-valued `createSignal` stays refused, so the type rule never
turns a Solid signal into a store.

`Show` tests verify that truthy-to-truthy changes preserve local snapshots and
false-to-true remounts reset them. `For` tests verify value-item arguments and
row snapshot preservation through identity reordering. Projection tests verify
previous-draft accumulation. These are tested subsets, not all ownership cases.

Handlers support setter/callback/JS-call statements, initialized locals, bounded
conditionals, return, throw and try/catch/finally using existing imperative nodes.

Ordinary async callbacks are refused for now, pending
[issue #20](https://github.com/ryansolid/reactivescript/issues/20). Every authored `async` callback is rejected at its `async`
node, whatever its body does: event handlers and contextual callback props (with
or without writes before the `await`, without an `await`, expression bodies,
early return or throw), a child forwarding its callback prop through an async
arrow, stored async arrows, nested `async function` declarations, async closures
inside synchronous handlers, and `createRxEffect` apply callbacks and returned
cleanups. Nothing is lowered or silently converted to an action. This is refused:

```tsx
<button
  onClick={async () => {
    setN(1);
    const result: number = await request();
    setN(result);
  }}
>
  Save
</button>
```

The diagnostic points to an explicit generator action, which is supported:

```tsx
const save = action(function* () {
  try {
    const result: number = yield request();
    setN(result);
  } catch (error) {
    setN(-1);
  }
});
// ...
<button onClick={() => save()}>Save</button>
```

Writing it this way opts into action semantics: the action's writes are held until
it completes. It is not a semantics-preserving rewrite of the async callback,
whose writes before the `await` Solid applies immediately. `action(async function* ...)`,
`action(async function ...)` and `action(async () => ...)` are refused too: actions
take a synchronous generator and use `yield` instead of `await`. Async computations
are not callbacks and keep their own rules (`createMemo(async ...)`, async
function-form stores, `createServerMemo` and server functions).

Effects and ordinary imperative returns accept synchronous zero-argument cleanup
closures. Authored `$<digits>` bindings are reserved globally so that effect
samples cannot collide with locals or cleanup captures.
Effect cleanups retain their sampled values and run before replacement;
the shared checker remains responsible for closure lifetime and escape checks.
Component bodies remain declarations followed by one JSX return. Shadowing,
recursive component graphs and unsupported statement shapes are rejected rather
than resolved by spelling or guessed execution behavior.

## Semantic Limits

- JS declaration parsing currently discards return shapes. JS call results need
  an explicit supported TS annotation, such as `async (): Promise<number> => ...`,
  a typed helper return, or a typed const. Unknown returns are never assumed numeric.
- JS imports emit `pure: false`; the module loader attaches `.d.rx` contracts.
  Bare imports default to IO, usable in handlers but rejected in reactive calls
  by the shared checker. Result annotations cannot grant purity or suppress failures.
- Structured `createSignal` values are refused: RX sources automatically become
  stores and would silently change JS object identity semantics. Use `createStore`.
- Store callbacks allow straight-line path assignments and expression-bodied,
  shape-preserving root updaters. Explicit supported `createStore` type arguments
  supply empty-array item contracts. Known-array spreads and scalar one-item
  predicates in `.every`/`.filter` map to existing array/builtin nodes. One-item
  pure `.map` callbacks return supported scalar, record or array values, preserve
  caller tracking, and work inside root updaters. No index/array callback
  parameters or general reduce methods are inferred. Each used
  builtin name cannot also be an authored binding anywhere in the source,
  including later declarations, helpers and imports. Registration predicates
  may compare an item with a known ordinary store root; arbitrary
  structured equality remains refused. Reads of a
  field after a write to that field are refused because native draft reads see
  staged mutations while ordinary RX handler reads see committed values.
  Projection draft statements use actual RX draft semantics instead.
- Function-form `createStore((): { a: number } => ({ a: input() }))` uses a
  structured standing-question source with no invented seed. An async initializer
  (a computation, not an event callback) requires a single returned await and an
  explicit `Promise<T>` record/array contract. Synchronous initializers require a
  supported result annotation or
  explicit store type argument. Existing path writes remain store writes;
  `refresh(state)` and `affects(state)` target the original standing question.
  Static object/array stores are not invalidation targets. Imported JS purity
  remains enforced by the shared checker, not inferred from an annotation.
- Projection seeds are snapshotted eagerly. Synchronous draft blocks and
  `createProjection(() => rows, [], { key: "id" })` are supported. Keyed rows
  require a known number/string key field; tests cover replacement, reordering
  and row snapshot identity. Async projections, arbitrary root replacement,
  other options and writable derived stores remain unsupported. RX draft
  binding `d` is reserved.
- `createDeferred(() => value)` maps to a deferred equation. A single returned
  await with a supported result annotation also retains deferred scheduling;
  tests cover true pending async replacement, not just synchronous arithmetic.
  Previous-value parameters and deferred options are not covered.
- Async/stream memos accept `{ loadingValue: literal }` for matching primitive
  literals, optionally signed, through `await.init`. A callback annotated
  `(): AsyncIterable<T> => importedCall(...)` maps to `await.stream`; tests cover
  repeated yields, supersession cancellation, stale completions and disposal.
  Equality/deferred options, nonliteral loading values, async previous-value
  memos, arbitrary async blocks and generator stream bodies remain unsupported.
- Previous-value memos currently need a primitive parameter or return annotation.
  Their first previous value is undefined; no initial value is invented.
- `createPrevious(double, () => 0)` from `reactivescript-tsx` lowers to a
  separate equation using non-self `pre double` with a matching fallback. The
  synchronous zero-argument expression fallback stays lazy and reactive: it is
  evaluated only when the previous value is undefined, never for null. Without
  a fallback the accessor has shape `T | undefined`. Inputs must be original
  known source/memo accessors declared earlier in the same owned setup. Existing
  previous accessors can be read by later-mounted children, but constructing a
  companion for an inherited target cannot reconstruct history and is refused.
  Same-setup chaining is supported. Self-cycles, arbitrary callbacks, values,
  helper/ref targets, store/projection roots and imported getters are refused.
- Void `on[A-Z]` callback props accept explicitly typed primitive/inline object
  parameters; forwarding and invocation preserve arguments and validate their
  shape and count. Inline callback implementations may infer parameters from
  that prop contract. Intrinsic event handlers accept one explicitly typed
  parameter, for example `(e: { target: { value: string } }) => { ... }`.
  Destructured/default/optional event parameters and arbitrary DOM event types
  are not supported. Shared action failure contracts remain inferred.
  A `children: Element` prop, using Solid
  `import { type Element } from "solid-js"` (including an alias), is a raw markup
  slot; `JSX.Element` is also recognized. Children can be forwarded without
  stringification, but snapshots of slots are refused. Non-handler callback props,
  arbitrary named/generic TS types, JSX spreads and namespaced components remain
  unsupported.
- Typed accessor-returning setup helpers accept original `() => T` ref arguments
  and value arguments, own signals/memos/effects, and return an original accessor.
  Value arguments and local consts snapshot once at instantiation; ref arguments
  stay live. Pure value-returning helpers remain ordinary per-invocation functions
  with caller tracking. General returned closures and higher-order functions are
  not covered.
- Primitive `createSignal(() => value)` derivations use question sources.
  Manual writes remain visible until a dependency changes; function-valued
  payloads are not silently treated as ordinary source values.
- Module `createContext(literal)`, component `useContext(C)`, and callable
  `<C value={...}>` support primitive snapshots and read-only accessor payloads.
  Primitive defaults and literal-bodied default accessors are supported; typed
  default-less contexts require a provider, matching native Solid. Each provider
  snapshots its payload in an owned component: a primitive stays fixed while a
  captured accessor stays live. Aliases preserve context identity across modules.
  Arbitrary structured payloads/default evaluation and pure-helper context reads
  are not covered.
- `createSourceContext<T>()` and `useSourceContext(C)` from the real
  `reactivescript-tsx` helper module use required source contexts. Provider
  `value={[read, set]}` must name the same compatible authoritative source; mixed
  tuples and missing providers are rejected. Native, compiled and interpreter
  tests cover children updating the original source across module aliases.
  Structured contracts use actual store/value pairs, not object signals: the
  reader is a record/array value with draft-path and root-updater writes. The
  record-array regression verifies child writes reach the original store.
  Forwarding a consumed context tuple as another source provider, or invalidating
  a context reader, is refused until writable capability targeting is established.
- Fire-and-forget `refresh(target)` and one-target `affects(target)` statements
  accept original accessor/store bindings. Awaited refresh results and
  property-slot marks are not covered by this slice.
  Server-factory cache refresh requires `createServerMemo` and `refresh` from
  `reactivescript-tsx`. `createServerMemo` accepts the same bounded async/stream
  callbacks and loading-value option as `createMemo`. Ordinary Solid refresh of
  a known factory-backed memo is rejected: it does not evict native loader cache
  entries. Extension refresh of an ordinary factory-backed memo or imported async
  getter is also refused when getter-owned cache metadata is unavailable.
  A directly returned server call, including `createServerMemo(() => load())`,
  becomes an explicit AST await. Supported explicit `Promise<T>` annotations can
  describe raw JS promise results. Known local server result types are checked,
  not replaced by the callback annotation; raw Promises cannot enter arithmetic.
- `action(function* (typedArgs) { ... })` maps to `Decl.action`; parameterized
  handlers require explicit arguments through a zero-argument forwarding arrow.
  Non-delegating yields of imported JS/server calls suspend actions; consumed JS
  results require an explicit TS local annotation. Tests cover held writes,
  affects pending state, resolution and caught rejection.
  Immediately invoked `action(function* () { ... })()` uses the existing inline
  action statement, not a discarded generator or an ordinary async handler.
  `createOptimistic` setters use optimistic writes separately from the authoritative
  source writer.
  Primitive, record and array optimistic roots use question sources, not automatic
  stores. The array-clear/suspended-action regression proves held status writes,
  rollback and unchanged captured-array identity in all three execution paths.
  Optimistic path writes, `createOptimisticStore`, and roots containing projection
  proxies remain unsupported; ordinary structured `createSignal` is still refused.
  Async arrows/generators, delegated yields and consumed action return values
  remain unsupported.
- Real `reactivescript-tsx` helpers `defineError`, `raiseFailure`,
  `catchFailure`, and `FailureBoundary` lower to error declarations, throw/catch
  expressions and class-filtered boundaries. Fields/message parameters are
  explicit, classes are declared constructor arrays, built-in `Error`, or undefined, and boundary
  errors are real accessors. General error-class imports and reset callbacks
  remain unsupported. Recovery regressions are tested, not assumed.
  Failure constructor declarations and imported aliases named `Error` or `Panic`
  are rejected because those are reserved RX failure identities.
  In these extension helpers, `[Error]` intentionally means the RX top failure
  class, including primitive throws, and lowers like `catch (err: Error)`.
  Common `name`/`message` fields are available without assuming arbitrary thrown
  JS values are Errors or that those properties must be strings.
  An imperative catch containing only `if (err instanceof C.cls) { ... } else
{ throw err }`, or a union of those exact guards, becomes a selective catch
  with canonical classes and common payload fields. The else must rethrow the
  same binder. Raw `instanceof Error` guards and general instanceof narrowing
  are refused: native JS Error filtering is not RX catch-all semantics.
  User-defined constructor bindings may not use reserved `Error`/`Panic` identities.
- `serverFunction("name", function* (typedArgs): Generator<unknown, Result, Resume>
{ ... })` and `serverAction` use shared server declarations, yield suspension,
  capture/purity checks and the existing in-process wire runtime. Literal names
  must match bindings. These helpers do not imply an HTTP transport or general
  async-function translation.
- Module reactive declarations and component setup use the same lowering path.
  Exported signals expose reader and direct-value setter aliases; exported
  memos/constants carry supported type contracts. Imported setter updater
  functions and arbitrary action-result contracts are not covered.
- Direct aliases of projection-root proxies are lexical aliases, not eager
  object-value snapshots. Tests distinguish these live roots from captured
  nested objects that survive replacement without following the new object.
  Structured snapshots containing projection-root proxies, such as
  `{ root: projected }`, are refused after a native/compiled/interpreter
  differential reproduced stale interpreter values. Ordinary store aliases
  and captured nested objects remain supported.
- Loose JS equality, exponentiation and other operators without verified
  cross-path semantics are rejected. Possibly absent member reads require
  explicit optional access; this is not general JS null-dereference parity.
- Numeric JSX uses `"" + value`, not RX JSON formatting, preserving NaN, infinities
  and signed-zero display. Overflowed numeric literals remain rejected.
- Only authored JSX text and quoted JSX attributes are entity-decoded. JS string
  expressions such as `{'&amp;'}` remain literal. Whitespace normalization runs
  before decoding so numeric newline entities are preserved.

Unsupported forms throw `TsxError` with authored filename, 1-based line/column,
and UTF-16 start/end offsets. Parsing and lowering do not imply successful
checking or full DOM/SSR/hydration parity for every accepted HTML content model.

## Verification

From the package root (`frontend/`; see ../README.md for the pinned and canary workflows):

```sh
npm run check
npm test
npm run test:browser
```

The paired counter, composition, values, store and effect fixtures compare the
pinned checker's canonical semantic facts (tsx/rx/facts.ts) against handwritten
RX, run the shared checker, drive actual interpreter button
handlers, compile both ASTs, and compare multiple-click frames with native TSX
compiled by the pinned Solid compiler. Eager nodes currently have no RX surface
spelling, so snapshot fixtures replace designated parsed equations with explicit
`Decl.const` nodes before comparison.

Additional tests cover modules/builds, snapshots, helper recalculation, JSX text,
async JS declarations and boundaries, and browser target integration. Native
artifacts use `.mts` because Solid preserves inline TS types. Each test removes
only its own unique `frontend/.out/*` artifacts. `test-renderer.ts` applies
static element props through the existing renderer equally for all compared paths.
