# Yield frontend (spike)

`yield/lower.ts` lowers solid-yield's explicit generator dialect, taken as a syntax design only (its documentation at
`fcc100e`; none of its packages or runtime is used), directly onto the pinned RX AST. It reaches upstream only through
`tsx/rx/` and does not use the TSX lowering. The reference is the TSX frontend's: a yield fixture is accepted only if
its canonical facts equal the handwritten RX's and the TSX twin's, and its exact frames match on compiled and
interpreted RX and on native Solid running the paired TSX fixture (`yield/paired.test.ts`).

## Construct mapping

| Yield | RX | TSX twin |
| --- | --- | --- |
| `component(function* Name(props: Props<{…}>) { setup; return view(…) })` | `component Name(props: {…})`; `Source<T>` is `T`, `Handler<[A]>` a callback `(arg0: A) => void` | `function Name(props)` |
| `const [x, setX] = yield* $signal(v)` / `$store(o)` | `source x := v` | `createSignal` / `createStore` |
| `const [x, setX] = yield* $optimistic(v)` | an optimistic question source; writes are `optimistic x := …` | `createOptimistic(v)` |
| `yield* $memo(function* () { const a = yield* s; return e; })` | `m = e`, the read locals substituted | `createMemo` |
| `yield* x` | a tracked read: an accessor's id, or a store, prop or row path | `x()` / `x.path` |
| `$event(function* (…) { … })` | a plain statement-bodied arrow; RX infers an action only for AC-1b bodies | a plain callback, or `action(function* (…) { … })` when RX would infer an action |
| `yield* setX(v)`, `yield* setX((v) => e)`, `yield* setStore((d) => { d.p = e; })` | a write, a functional write, path writes | the setter call |
| `yield* evt(x)`, `yield* props.onX(x)` in an event | a call | a call |
| `const r = yield* attempt(() => f(…), function* () { … }); if (r !== undefined) { … }` | `try { let r = await f(…); … } catch (error) { … }` | `try { const r = yield f(…) } catch` |
| `view(function* () { return <…/>; })`, holes `{yield* x}` | the component's markup, each hole a read; a conditional hole a region | the JSX |
| `onClick={yield* evt}` | the handler body itself | `onClick={() => { … }}` |
| `{yield* Show({ when, fallback, children })}` | `if … else …` | `<Show>` |
| `{yield* For({ each, children: function* (item) { return view(…); } })}` | `for item in …` | `<For>` |
| `{yield* Child({ value, onX: evt })}` | `<Child value=… onX=…/>`, the handler passed directly | the same |

## Events and callback props

`$event` does not declare an RX action. Its plain handler body lets RX apply AC-1b (`spec/06-stores.md:143–160`):
a write plus an await, an optimistic write, or `affects` makes it an action. A synchronous write alone does not.
The counter facts now equal both original plain-handler fixtures in `tsx/fixtures/paired/counter.{tsx,rx}`.

The pinned RX checker accepts an inferred-action arrow for a callback prop typed `action catches(nothing)`
(`yield/paired.test.ts`); no declared-action fallback is needed. Child components receive the handler itself.
The tracker still waits and guesses, with equal facts and frames on all five legs. Its native Solid twin uses an
inline `action(function* (…) { … })` callback because Solid does not infer actions. The TSX frontend accepts that
callback form only when RX would infer it too; otherwise a named action is still required.

## Refused

Outside the subset: `$effect`, `$cleanup`, `$optimisticStore`, `$projection`, contexts, `Loading`, `Errored`,
`Switch`/`Match`, `Repeat`, `lazy`, `refresh`, typed failures (`raise`, `Failure`, an `attempt` handler returning a failure),
async memos, derived `$signal`/`$store` bodies, options, row setup and `For`'s index, attributes other than event bindings.

Accepted yield code that would behave differently from its RX lowering is refused, as #20 refuses ordinary async
callbacks:

- a bare setter call (a receipt in yield, which writes nothing; lowered it would write);
- a read in a setup (an error in yield; RX would take a snapshot);
- a source read after an `attempt` in an event (yield's transaction gives the pre-call value; RX reads after the wait);
- read-after-own-write and write-back after a wait in an event: RX's checker refuses them (AC-1d `STALE_OWN_READ`, AC-1e
  `STALE_WRITE_BACK`); yield would give the pre-call value;
- `try`/`catch`, `throw`, async routines, component tags, spreads, `yield*` in a call's arguments, and bound events with
  parameters (yield passes the DOM event);
- an `attempt` not followed by `if (r !== undefined) { … }` as the event's last statement.

## Open questions

- **The `attempt` translation** is faithful only when the call never succeeds with `undefined`; nothing checks that.
- **Optimistic lists:** `$optimistic` takes only a value, so the TSX demo's optimistic list copy has no yield spelling
  here; the yield tracker claims with `$optimistic(0)`.
- **P/E/W/R:** a later step could cross-check solid-yield's type-level colors (pending, failures, may-wait, requirements)
  against RX's static checks (`ASYNC_OUTSIDE_LOADING_BOUNDARY`, `UNHANDLED_FAILURE` / `UNCAUGHT_ACTION_FAILURE`,
  `PENDING_ASYNC_UNTRACKED_READ`, `CONTEXT_NOT_FOUND`); the subset exercises none of them.
