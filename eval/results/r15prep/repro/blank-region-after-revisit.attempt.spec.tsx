/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { Show, Loading, Errored, action, createMemo, createSignal, createOptimistic, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { await new Promise(r => setTimeout(r, 50)); };
// .rx (results/r15prep/repro/blank-region-after-revisit.rx), as rxc lowers it: an add is out (a guess on `adding`);
// the page is left and opened again (`visit` asks `cards` anew); the add's answer is written to `cards` while that
// question is out; then its answer lands. The page's <Loading> then shows neither its fallback nor its content.
test("a region over a source written while its new question is out shows its content when the answer lands", async () => {
  (globalThis as any).__log = [];
  const asks: { key: string; res: (v: any) => void }[] = [];
  const ask = (key: string) => new Promise<any>(res => asks.push({ key, res }));
  const land = (key: string, v: any) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key + " in " + asks.map(a => a.key)); asks.splice(i, 1)[0].res(v); };
  const c = document.body.appendChild(document.createElement("div"));

  const [visit, setVisit] = createSignal(0);
  const [cards, setCards] = createSignal<any>(() => (visit() >= 0 ? ask(`cards:${visit()}`) : null), { loadingValue: null } as any);
  const [addingTruth] = createSignal<string[]>(() => []);
  const [adding, guessAdding] = createOptimistic<string[]>(() => addingTruth());
  const rows = createMemo(() => { const cs = cards(); return cs == null ? null : [...cs, ...adding()]; });
  const add = action(function* (t: string) {
    guessAdding(as => [...as, t]);
    const r: string = yield ask(`add:${t}`);
    setCards((cs: any) => (cs == null ? cs : [...cs, r]));
  });
  const [page, setPage] = createSignal("a");
  render(() => <Show when={page() === "a"} fallback={<p>other page</p>}>{() =>
    <div id="out"><Loading fallback={<p>loading</p>}><Errored fallback={<p>err</p>}>
      <Show when={rows() == null} fallback={<p>{(rows() as string[]).join(",")}</p>}>{() => <p>first load</p>}</Show>
    </Errored></Loading></div>}
  </Show>, c);
  await tick();
  land("cards:0", ["a"]); await tick();
  expect(c.textContent).toBe("a");
  add("x"); await tick();
  expect(c.textContent).toBe("a,x");
  setPage("b"); await tick();
  setVisit(1); setPage("a"); await tick();
  (globalThis as any).__log.push("back:", JSON.stringify(c.textContent));
  land("add:x", "x"); await tick();
  (globalThis as any).__log.push("add accepted:", JSON.stringify(c.textContent));
  land("cards:1", ["a", "x"]); await tick();
  (globalThis as any).__log.push("reload landed:", JSON.stringify(c.textContent), c.innerHTML);
  expect(c.textContent).toBe("a,x");
  expect((globalThis as any).__log.join(" | ")).toBe("");
});
