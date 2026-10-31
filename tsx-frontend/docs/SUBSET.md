# Solid-Parity Subset

The contract is native Solid behavior, not RX behavior under TSX syntax. Refuse
forms that cannot be represented faithfully instead of silently changing meaning.

## Current Checkpoint

Run `npm run verify:subset`. It runs the package typecheck, all boundary contracts,
paired-counter tests, component-composition tests, and the issue-tracker demo
without test-name filtering. Any failed command fails the checkpoint. The
behavioral scope is deliberately narrow: the authored counter, composition and
tracker fixtures and their handwritten RX counterparts.

```tsx
import { createSignal, createMemo } from "solid-js";

export default function Counter() {
  const [count, setCount] = createSignal(0);
  const doubled = createMemo(() => count() * 2);
  return <button onClick={() => setCount(count() + 1)}>{doubled()}</button>;
}
```

Tests require equal canonical checker facts and rendered frames `0`, `2`, `4`
across the RX interpreter, RX compiler, and native Solid universal renderer.
Changed tracked/snapshot reads must remain detectable. This is not a browser DOM
or hydration claim, or proof for every combination of these primitives.

Boundary tests check pins and adapter API contracts, and the temporary async
callback boundary ([issue #20](https://github.com/ryansolid/reactivescript/issues/20)). Every authored ordinary async callback
must be refused at its `async` node: event handlers and contextual callback props
with any body, forwarded and stored callbacks, and `createRxEffect` apply callbacks
and cleanups. The message must point to `action(function* () { ... yield request(); ... })`
and say this opts into held action semantics rather than preserving meaning.
`action(async ...)` and async generator actions are refused too. Explicit generator
actions, `createMemo(async ...)` and `createServerMemo` must still lower. Before
this boundary only a write before an `await` was refused (Solid applies it
immediately; RX infers an action that holds it). This is a refusal contract, not
async parity.

## Component Props And Callbacks

`tsx/composition.test.ts` uses `fixtures/composition.tsx` and `composition.rx`.
The fixture passes a direct signal read, a memo value, and a synchronous callback
through two later-declared child components:

```tsx
// Parent Counter
return <CounterButton direct={count()} value={doubled()}
  onIncrement={() => setCount(count() + 1)} />;

// CounterButton: its own count starts at 10 and must remain independent.
const [count, setCount] = createSignal(10);
const doubled = createMemo(() => incoming.value * 2);
return <Button direct={incoming.direct} value={doubled()} local={count()}
  onIncrement={incoming.onIncrement} />;

// Button
return <button onClick={() => props.onIncrement()}>
  {props.direct}/{props.value}/{props.local}
</button>;
```

Across four clicks the exact frames must be:

```text
0/0/10 -> 1/4/10 -> 2/8/10 -> 3/12/10 -> 4/16/10
```

Variants attach `onClick={props.onIncrement}` directly or forward through
`onIncrement={() => incoming.onIncrement()}`. Each variant compares canonical
TSX/RX facts, checks both programs, and asserts expected frames in the TSX-derived
interpreter, both compiled RX programs, and native Solid's universal renderer.
No callback return-value, argument-forwarding, async, or DOM-event behavior is
claimed by these examples.

These are the two existing composition tests moved unchanged from
`lower.test.ts`, not replacement assertions. The full suite still discovers them,
and the coverage manifest records their new paths.

## Demo: Issue Tracker

`tsx/demo.test.ts` uses `fixtures/demo/tracker.tsx` and its handwritten RX
counterpart `tracker.rx`: a demo for review, not a broader parity claim. It
combines a `createStore` issue list with a draft path write located by
`findIndex` (lowered to RX's predicate `indexOf`, which both RX runtimes define as
`findIndex`), a filter signal with `createMemo` views (visible rows, open count),
`<For>` rows inside a `<Show>` with an empty-state fallback, a later-declared
`IssueRow` child with props and an `onAssign` callback, and an explicit generator
action that writes the claim into an optimistic copy of the list
(`createOptimistic(() => issues.list)`), commits the yielded `assignIssue(id)`
answer to the store on success, and rolls back with a status message on failure.
The tests require equal canonical checker facts (and that snapshotting the filter
in the RX is detected), and the same eight exact frames from native Solid's
universal renderer, the RX compiler for both programs, and the RX interpreter for
both programs: a successful claim shown at once and committed, a failed claim
rolled back, a filter change, and a claim that empties the open view into its
fallback. The script never repeats a request with the same arguments. Each such
call is a new request in Solid and in RX (SF-2c: "two calls with the same arguments
are two requests"), but the RX interpreter's scenario model makes every `./api`
function "a flight keyed by its arguments" (ref/src/runtime.ts), so a retry would
reuse the first answer there for a harness reason. Async list loading, async memos
and server functions are deliberately left out.

## Stale Write-Back (AC-1e)

`tsx/stale-write.test.ts` shows upstream's `STALE_WRITE_BACK` through authored TSX. An explicit generator action reads
`likes()`, yields `save()`, then writes `setLikes(before + 1)`; a like made while the save was in flight is lost.
Native Solid runs that TSX and shows the lost update (frames end at 1, not 2). The frontend refuses it through its
normal checker route (`buildTsx` throws `CheckError`: `AC-1e: STALE_WRITE_BACK (AC-1e) likes.tsx:6: …`), as the
checker refuses the handwritten RX. The functional setter `setLikes((n) => n + 1)` is accepted, has the same
canonical facts as its RX, and keeps the concurrent like on native Solid, both compiled programs and both
interpreted programs.

`npm run verify:subset` passes 25 tests with no skips or TODOs; the package
typecheck is clean. Upstream's 12
strict-mode diagnostics remain the separately recorded baseline.

## Exclusions

Async behavior beyond the demo's scripted action flights, server functions, cross-module error identity, previous values,
stores, owner lifetimes, SSR, and hydration are not certified by this command.
Their existing tests and native assertions remain in the full suites. The full
migration remains NOT READY while those suites fail.

`npm run verify:pinned` remains the full readiness gate. Comparison-only results
do not approve failures. No tests are removed from the full suite or coverage
manifest to make the subset pass.

## Expansion Rule

Require authored TSX, handwritten RX, and native Solid evidence for each addition,
including relevant failure and cleanup ordering. Fix adapter errors first. Backend
defects need minimal reproductions; temporary patches need removal conditions.
If native behavior is unrepresentable, test a specific diagnostic and retain the
native counterexample. Do not weaken assertions, sort effect logs, or add skips.
