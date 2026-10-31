import { createSignal, createMemo } from "solid-js";

export function Counter() {
  const [count, setCount] = createSignal(0);
  const doubled = createMemo(() => count() * 2);
  return <button onClick={() => setCount(count() + 1)}>{doubled()}</button>;
}
