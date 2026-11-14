import { For, action, createMemo, createSignal, createOptimistic, refresh } from "solid-js";
import { fetchCards, moveCard } from "./api.js";

export default function App() {
  const [todoAns] = createSignal<any>(() => fetchCards("todo"), { loadingValue: null } as any);
  const [doingAns] = createSignal<any>(() => fetchCards("doing"), { loadingValue: null } as any);
  const [movingTruth] = createSignal<number[]>(() => []);
  const [moving, guessMoving] = createOptimistic<number[]>(() => movingTruth());
  const todoRows = createMemo(() => { const a = todoAns(); return a == null ? [] : a.filter((c: any) => !moving().includes(c.id)).map((c: any) => ({ card: c })); });
  const doingRows = createMemo(() => { const a = doingAns(); return a == null ? null : [...a, ...moving()]; });
  const doingUp = createMemo(() => doingRows() != null);   // a second reader of doingRows whose value never changes
  const intoDoing = createMemo(() => doingRows() != null && doingRows()!.length < 3);
  const reask = action(function* () { refresh(todoAns); refresh(doingAns); });
  const move = action(function* (card: any) {
    guessMoving(ms => [...ms, card.id]);
    yield moveCard(card.id, "doing", 2);
    yield reask();
  });
  return <div>
    <section data-testid="col-todo">
      <For each={todoRows()}>{(r: any) => <button data-testid="right" disabled={!intoDoing()} onClick={() => move(r.card)}>right</button>}</For>
    </section>
    <p>{doingUp() ? "up" : "down"}</p>
    <p data-testid="dbg">doing={String(doingRows()?.length)} intoDoing={String(intoDoing())}</p>
  </div>;
}
