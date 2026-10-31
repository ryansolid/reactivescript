import { createEffect, createMemo, createSignal, NotReadyError, untrack, type Accessor } from "solid-js";
import { createErrorBoundary } from "@solidjs/signals";
import { isServer } from "@solidjs/web";

/** E-12's error answer, shared by every failed input (not the thrown exception). */
export const RX_ERROR = Object.freeze({ toString: () => "#error" });
export type RxEffectError = typeof RX_ERROR;
type Answers<Inputs extends readonly unknown[]> = { -readonly [I in keyof Inputs]: Awaited<Inputs[I]> | RxEffectError };

/** RX EF-2/E-12 semantics; ordinary Solid createEffect deliberately remains unchanged. */
export function createRxEffect<const Inputs extends readonly unknown[]>(
  inputs: { readonly [I in keyof Inputs]: Accessor<Inputs[I]> },
  apply: (...values: Answers<NoInfer<Inputs>>) => void | (() => void),
): void {
  if (isServer) {
    const values = createMemo(() => inputs.map(input => {
      try { return input(); } catch (error) { if (error instanceof NotReadyError) throw error; return RX_ERROR; }
    }));
    createEffect(values, { effect() {}, error() {} });
    return;
  }
  const waiting = Symbol();
  const computes = inputs.map(input => {
    // Client-only plumbing must not consume the server tuple/effect's hydration slots.
    const compute = createMemo(input, { equals: Object.is, transparent: true });
    const [answer, setAnswer] = createSignal<unknown>(waiting, { equals: Object.is });
    // Error arms publish settled answers; boundary redraws alone can briefly expose stale values.
    createEffect(compute, {
      effect: value => { setAnswer(() => value); },
      error: () => { setAnswer(RX_ERROR); },
    }, { transparent: true });
    return { compute, answer };
  });
  const values = createMemo(() => computes.map(({ compute, answer }) => {
    // Suspend the tuple on pending. A record protects function/array answers from view flattening.
    createErrorBoundary(() => ({ value: compute() }), () => ({ value: RX_ERROR }))();
    return answer();
  }), {
    equals: (previous, next) => previous.every((value, i) => Object.is(value, next[i])),
  });
  // Filter before the effect phase: a skipped answer must not dispose the previous cleanup.
  createEffect(values, next => {
    if (!next.includes(waiting)) return untrack(() => apply(...next as Answers<Inputs>));
  });
}
