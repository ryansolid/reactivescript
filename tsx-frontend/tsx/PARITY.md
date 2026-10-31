# RX Parity Target

Parity means that an executable RX feature has an authored TSX spelling that
lowers to the same shared semantics and passes behavioral tests. Merely exposing
an AST node or allowing a TSX module to import an RX implementation does not
establish syntax parity.

The baseline is the current reference interpreter and compiled scenario suite,
not unimplemented production-compiler plans. The shared compiler still has its
existing JS-prelude restrictions, six recorded Solid-oracle frame differences,
and incomplete server-function transport. This frontend does not remove those
limits. Nor does RX parity imply compatibility with arbitrary JavaScript.

## Completion Checklist

- Primitive and structured expressions, one-time snapshots and helper functions.
- Atomic and structured sources, equations, previous values, drafts, deferred
  equations, keyed reconciliation, and derived-until-written sources.
- Components, reactive props, callback contracts, children, ownership and cleanup.
- Conditional regions and loops, including stateful branch and row bodies.
- Split effects, imperative locals, writes, branches, return, throw and try/catch,
  including non-held async callbacks and their Promise completion semantics
  (authored TSX async callbacks are refused for now: [issue #20](https://github.com/ryansolid/reactivescript/issues/20)).
- Async equations, initial values, streams, loading/error boundaries and probes.
- Actions, optimistic writes, refresh and affects, within RX's implemented limits.
- Typed failures and error classes, retaining checking across module boundaries.
- Context identities, defaults, provision scopes and required-context checking.
- Mixed RX/TSX modules, exported signatures and JS declaration-file contracts.
- Universal, DOM and SSR emission, plus actual browser hydration and interaction.
- Server functions/actions with the same capture and wire checks as RX.

This is a completion target, not a claim that every item is implemented. The
README describes the accepted syntax; tests are the coverage evidence. Unsupported
forms must continue to fail explicitly instead of being assigned guessed semantics.

## Authored Evidence

These suites start from authored TSX and exercise behavior, rather than counting
shared AST constructors as frontend coverage. The raw-AST core regressions remain
useful additional evidence, but are not substitutes for these tests.

| Executable behavior | Authored spelling | Proof suites |
| --- | --- | --- |
| Expressions, eager snapshots (`source x := peek(e)`), pure (inert locals only) and owned helpers | Ordinary values, `const` with `untrack` for tracked reads, typed functions, accessor arguments | `semantics.test.ts`, `features.test.ts`, `owned-helpers.test.ts`, `setup-values.test.ts`, `snapshot-core.test.ts` |
| Atomic/structured sources and previous answers | `createSignal`, `createStore`, memo previous-value parameter, `createProjection` | `semantics.test.ts`, `features.test.ts` |
| Deferred answers, pending probes, independent landings | Async `createDeferred`, `isPending`, `latest` | `async-control.test.ts` |
| Components, props, events, callback failures and finally | Typed props/handlers, forwarding, ordinary `try`/`catch`/`finally` | `lower.test.ts`, `callbacks.test.ts`, `contracts.test.ts` |
| Non-held async callbacks and microtask ordering (native and handwritten RX legs) | None for now: authored `async` callbacks are refused at their `async` node ([issue #20](https://github.com/ryansolid/reactivescript/issues/20)); an explicit `action(function* ...)` opts into held semantics instead | `async-handlers.test.ts`, `boundary.test.ts`, `browser.ts` |
| Branch and row ownership, removal and fresh remounts | `Show`, `For`, keyed projections, owned helper calls | `features.test.ts`, `owned-lifetimes.test.ts`, `browser.ts` |
| RX effects (EF-2), error answers and cleanup; plain `createEffect` refused | Extension `createRxEffect` | `features.test.ts`, `effect-semantics.test.ts`, `rx-effects.test.ts`, `owned-lifetimes.test.ts`, `browser.ts` |
| Async values, seeded answers, streams and boundaries | Async/iterable memos, `Loading`, `Errored`, probes | `async-bridge.test.ts`, `async-stream.test.ts`, `browser.ts` |
| Held actions, optimistic values, refresh and affects | Named/inline generator `action`, `createOptimistic`, `refresh`, `affects` | `actions.test.ts`, `async-control.test.ts`, `features.test.ts` |
| Declared/filtered failures and imperative catches | `defineError`, `raiseFailure`, `catchFailure`, `FailureBoundary`, guarded catches | `features.test.ts`, `contracts.test.ts`, `callbacks.test.ts` |
| Context identity, defaults, required/live and writable contexts | Native contexts/accessors; canonical `createSourceContext` tuples | `features.test.ts`, `modules.test.ts`, `contracts.test.ts`, `owned-lifetimes.test.ts` |
| Mixed modules, JS contracts, HTML content models | Explicit `.tsx`/`.rx` imports and `.d.rx` declarations | `modules.test.ts`, `contracts.test.ts`, `build.test.ts` |
| Server capture, wire values, cache identity and refresh | `serverFunction`, `serverAction`, `createServerMemo`, extension `refresh` | `primitives.test.ts`, `server-identities.test.ts`, `contracts.test.ts` |
| Universal, DOM, SSR and actual hydration | Checked build targets and explicit component mounting | `build.test.ts`, `browser.ts` |

The baseline's HTTP transport, partial hydration/resumability, arbitrary npm
execution, optimistic path writes, and recorded oracle/SSR divergences are not
made complete by a syntax frontend. The README records the supported native
subset and deliberate rejections separately from this RX feature target.

## Architectural Constraints

JavaScript snapshots must be eager values, not lazy untracked equations. An
object-valued Solid signal must not silently become a fine-grained store. JSX
booleans/null/undefined must be omitted rather than formatted as RX text.
Ordinary function calls must retain value-versus-accessor parameter behavior.
Providers must not leak to sibling owners. Import aliases must preserve binding
and context identity. Async handlers must not silently become hold-safe actions; for now TSX refuses them outright.

The frontend targets only ReactiveScript's existing AST; it adds no shared AST
constructs, flags, or fields, and there is no shared IR. Where a Solid behavior
has no faithful spelling in the existing nodes, the form is refused explicitly:

- Setup snapshots are RX snapshot sources (`source x := peek(e)`, E-4/DV-6); a
  bare tracked read in setup is reported as `SNAPSHOT_INITIALIZER` by the shared
  checker rather than snapshotted. Snapshots whose eager timing RX would observe
  differently (unused failing initializers, untracked async reads, reads before
  initialization, server-body captures) are refused.
- Plain Solid `createEffect` reruns for equal direct computes and skips compute
  errors, unlike RX's EF-2 value filtering and E-12 error-as-answer contract. It
  is refused; `createRxEffect` is the effect form, and it lowers to RX's one
  `effect` form.
- Structured versus atomic is the type (ST-1): store questions carry their value
  contract as type text, and object-valued `createSignal` stays refused.
- Eager initializers that could fail are refused unless caught by a catch-all in
  the initializer: Solid's setup-time throw routing cannot be expressed by an RX
  snapshot source. Props snapshots are accepted only for non-exported components
  whose in-module call sites pass total values; selective catches, rejecting JS
  calls and other modules' values are refused (README, "Setup Consts").
