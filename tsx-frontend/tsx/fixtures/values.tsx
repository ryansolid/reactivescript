import { createSignal, createMemo, untrack } from "solid-js";
const factor: number = 2;
function format(n: number): string { return "n=" + n; }
export function Counter() {
  const [count, setCount] = createSignal(0);
  const initial = untrack(() => count());
  const label = createMemo(() => format(count() * factor));
  const frozen = createMemo(() => untrack(() => count()));
  return <button title="counter" disabled={false} onClick={() => setCount(previous => previous + 1)}>{initial}/{label()}/{frozen()}/{count() > 1 ? "many" : "few"}/{false}/{null}</button>;
}
