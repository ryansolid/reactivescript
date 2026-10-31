import { createSignal } from "solid-js";
import { createRxEffect } from "reactivescript-tsx";
export function Counter() {
  const [count, setCount] = createSignal(0);
  const [seen, setSeen] = createSignal(0);
  createRxEffect([() => count()], value => { setSeen(value * 10); });
  return <button onClick={() => setCount(count() + 1)}>{count()}/{seen()}</button>;
}
