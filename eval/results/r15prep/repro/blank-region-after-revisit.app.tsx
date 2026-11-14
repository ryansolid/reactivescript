import { Show, Loading, Errored, action, createMemo, createSignal, createOptimistic } from "solid-js";
import { fetchCards, addCard } from "./api.js";

export default function App() {
  // as rxc lowers blank-region-after-revisit.rx: state owned by the root, `adding` a guess layer over its own truth
  const [visit, setVisit] = createSignal(0);
  const [cards, setCards] = createSignal<any>(() => (visit() >= 0 ? fetchCards("todo") : null), { loadingValue: null } as any);
  const [addingTruth] = createSignal<string[]>(() => []);
  const [adding, guessAdding] = createOptimistic<string[]>(() => addingTruth());
  const rows = createMemo(() => { const cs = cards(); return cs == null ? null : [...cs.map((c: any) => c.title), ...adding()]; });
  const add = action(function* (t: string) {
    try {
      guessAdding(as => [...as, t]);
      const r: any = yield addCard("todo", t);
      setCards((cs: any) => (cs == null ? cs : [...cs, { id: r.id, title: r.title, done: 0, total: 0 }]));
    } catch { /* declined */ }
  });
  const Page = () => <div data-testid="out"><Loading fallback={<p>loading</p>}><Errored fallback={<p>err</p>}>
    <Show when={rows() == null} fallback={<p>{rows()?.join(",")}</p>}>{(_x: any) => <p>first load</p>}</Show>
  </Errored></Loading></div>;
  const [page, setPage] = createSignal("a");
  return <div>
    <button data-testid="add" onClick={() => add("x")}>add</button>
    <button data-testid="away" onClick={() => setPage("b")}>away</button>
    <button data-testid="back" onClick={() => { setVisit(visit() + 1); setPage("a"); }}>back</button>
    <Show when={page() === "a"} fallback={<p>other page</p>}>{(_x: any) => <Page />}</Show>
  </div>;
}
