# Differential fuzzer (milestone 1)

`tsx/fuzz/gen.ts` generates one seeded, deterministic abstract program per seed and emits it twice: as genuine Solid
TSX and as handwritten-style RX. `tsx/fuzz/run.ts` runs both through every leg and compares them.

## What is generated

Only verified-subset features: numeric signals with plain and functional setters; memos (arithmetic and ternaries);
a store with numeric record fields and a `rows` list, written through drafts (`setStore((d) => { d.f0 = … })`,
`d.rows[i].n = …`); `Show` with a fallback; `For` over the store rows; a later-declared `Child` component with a
value prop and an `onBump` callback; and an explicit generator action `save(amount)` with an optimistic write
(`createOptimistic(() => target())`, functional), a controllable flight `yield request(amount)` that succeeds or
fails, a functional commit and a caught failure counter. Each seed also gets an event and flight script: clicks on
the n-th rendered button, and answers (value or failure) for a flight by amount.

Generator constraints that keep programs inside the language without hiding divergences: a handler never reads a
source it already wrote (AC-1d `STALE_OWN_READ` refuses that), commits are functional (AC-1e `STALE_WRITE_BACK`),
displays and memos always read something (a bare literal is static text), and expressions read record fields, not
indexed array elements. The frontend types `store.rows[1].n` as possibly absent ("Possibly absent values require
optional member access"), which is correct, so the first draft's indexed reads were a generator bug, fixed by
reading fields. A program the frontend or the checker refuses counts as a generator bug.

## Legs and classification

Five legs run the same script: native Solid (the Solid compiler's universal output), compiled TSX, compiled RX,
interpreted TSX and interpreted RX. Native Solid's `./api` is routed to the same controllable flights the compiled RX
uses. Canonical facts (`tsx/rx/facts.ts`) of TSX and RX are compared too. A divergence is classified by which legs
disagree: TSX-derived vs RX-derived on one backend (or unequal facts) is the **adapter**; the interpreter vs the
compiler on the handwritten RX is **upstream**; compiled RX vs native Solid is a **semantics difference or bug**. The
reducer drops script steps, view nodes (shifting later click indices), handler writes, memos, signals, store parts
and the action, keeping a variant only when its classes are unchanged.

Run `npm run fuzz -- --seeds N --start S`. Results go to `.out/fuzz/run-S-N/`: summary.json, summary.md,
findings.md, and per divergence the generated and reduced TSX/RX, script and traces. `tsx/fuzz.test.ts` is a
fixed-seed smoke test (seeds 0..19) in `verify:subset`.

## Current gate: seeds 0..199 (fdbcad92, Solid 2105ffb8 / rc.21)

200 programs: 179 agree on all five legs; 21 differ only between the interpreter and compiled RX. No generator
errors, adapter differences or native-versus-compiled differences. The exact upstream seed list is in
baselines/fuzz-upstream.json. npm run verify:subset runs this fixed sample without reduction and fails on unlisted
upstream differences as well as adapter/semantics differences. --no-reduce writes original traces, not reduced cases.

## Historical larger run: seeds 0..499 (pin 8518fa1e, Solid 5e68925c)

500 programs, 0 generator bugs, 0 crashes. 454 agree on facts and exact frames on all five legs. 46 diverge, all
classified **upstream: interpreter vs compiled**. In every one native Solid, compiled TSX and compiled RX agree, and
interpreted TSX equals interpreted RX: no adapter divergence and no RX-vs-native difference was found. Feature use:
store 239, child 302, memos 332, action 256, Show 230, For 132.

The reduced cases fall into two upstream behaviors. Both are the interpreter applying writes that native Solid and
the compiled RX hold in a pending action's transition:

- **U1. Writes in the calling handler before the action (26 seeds):** 17 40 44 88 92 103 117 125 149 182 199 201 209
  242 256 258 273 280 306 320 367 419 420 427 444 484. A handler writes a signal or a store path and then calls the
  action. Native and compiled hold the write until the action settles; the interpreter shows it at once. This remains documented in docs/UPSTREAM-ISSUES.md; the old async-handlers suite was removed with the broad port.
- **U2. Writes while another action is pending (20 seeds):** 14 42 90 107 145 150 152 164 189 193 220 237 253 262 283
  349 355 413 446 461. With an action in flight, a plain handler's writes, a second optimistic write, or another
  action's commit or failure are held by native and compiled, while the interpreter applies them per action (11 with
  only overlapping actions, 9 with plain writes beside a pending action).

Smallest U1 repro (seed 367, one click; native and compiled `b01`, interpreter `b02`):

```tsx
import { createSignal, createStore, createOptimistic, action, For } from "solid-js";
import { request } from "./api";

export default function App() {
  const [s1, setS1] = createSignal(1);
  const [store, setStore] = createStore({ f0: 0, rows: [{ id: 1, n: 1 }] });
  const [guess, setGuess] = createOptimistic(() => s1());
  const [fails, setFails] = createSignal(0);
  const save = action(function* (amount: number) {
    setGuess((guessed) => guessed + amount);
    try {
      const got: number = yield request(amount);
      setS1((current) => current + got);
    } catch (error) {
      setFails((count) => count + 1);
    }
  });
  return (
    <section>
      <button onClick={() => { setStore((v0) => { v0.rows[0].n = 2; }); save(2); }}>b0</button>
      <For each={store.rows}>{(v1) => <u>{v1.n}</u>}</For>
    </section>
  );
}
```

```rx
import { request } from "./api";

export default component App() {
  source s1 := 1;
  source store := { f0: 0, rows: [{ id: 1, n: 1 }] };
  source guess = s1;
  source fails := 0;
  action save(amount: number) {
    optimistic guess := guessed => guessed + amount;
    try {
      let got = await request(amount);
      s1 := current => current + got;
    } catch (error) {
      fails := count => count + 1;
    }
  }
  <section>
      <button onClick={() => { store.rows[0].n := 2; save(2); }}>b0</button>
      {for v0 in store.rows { <u>{"" + v0.n}</u> }}
  </section>
}
```

Every divergence, with its reduced TSX, RX, script and all five traces: [FUZZ-findings.md](FUZZ-findings.md).
