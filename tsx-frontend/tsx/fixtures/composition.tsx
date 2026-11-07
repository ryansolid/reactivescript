import { createSignal, createMemo } from "solid-js";

export function Counter() {
  const [count, setCount] = createSignal(0);
  const doubled = createMemo(() => count() * 2);
  return <CounterButton direct={count()} value={doubled()} onIncrement={() => setCount(count() + 1)} />;
}

function CounterButton(incoming: { direct: number; value: number; onIncrement: () => void }) {
  const [count, setCount] = createSignal(10);
  const doubled = createMemo(() => incoming.value * 2);
  return <Button direct={incoming.direct} value={doubled()} local={count()} onIncrement={incoming.onIncrement} />;
}

function Button(props: { direct: number; value: number; local: number; onIncrement: () => void }) {
  return <button onClick={() => props.onIncrement()}>{props.direct}/{props.value}/{props.local}</button>;
}
