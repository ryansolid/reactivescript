/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { Loading, Errored, For, action, createSignal, createOptimistic, createProjection, refresh, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
test("a keyed checklist under Loading on(selected) does not go back to the previous selection when a toggle is accepted", async () => {
  const asks: { key: string; res: (v: any) => void }[] = [];
  const ask = (key: string) => new Promise<any>(res => asks.push({ key, res }));
  const take = (key: string) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key + " in " + asks.map(a => a.key)); return asks.splice(i, 1)[0]; };
  const c = document.body.appendChild(document.createElement("div"));

  const [selected, setSelected] = createSignal(2);
  const [checklist, setChecklist] = createSignal(async () => { const s = selected(); return { card: s, items: await ask(`checklist:${s}`) }; });
  const [toggling, guessToggling] = createOptimistic<number[]>(() => []);
  const [adding, guessAdding] = createOptimistic<{ card: number; text: string }[]>(() => []);
  const items = createProjection(() => {
    const l: any = checklist();
    return [
      ...l.items.map((it: any) => ({ k: `i${it.id}`, t: `${l.card}/${it.text}${toggling().includes(it.id) ? " (toggling)" : ""}` })),
      ...adding().filter(a => a.card === l.card).map((a, i) => ({ k: `a${i}`, t: `${a.card}/${a.text} (adding)` })),
    ];
  }, [] as any, { key: "k" } as any) as any;
  const addOne = action(function* (card: number, text: string) {
    guessAdding(as => [...as, { card, text }]);
    const it = yield ask(`addItem:${card},${text}`);
    setChecklist((l: any) => (l.card !== card ? l : { card, items: [...l.items, it] }));
  });
  const toggle = action(function* (card: number, item: number) {
    guessToggling(ts => [...ts, item]);
    yield ask(`toggle:${card},${item}`);
    refresh(checklist);
  });

  render(() => <div>
    <Loading on={selected()} fallback={<p>loading checklist</p>}>
      <Errored fallback={<p>err</p>}>
        <p>{items.length}: <For each={items}>{(it: any) => <span>{it.t} </span>}</For></p>
      </Errored>
    </Loading>
  </div>, c);
  const screen = () => c.textContent!.replace(/\s+/g, " ").trim();

  take("checklist:2").res([{ id: 21, text: "repro" }, { id: 22, text: "patch" }]); await tick();
  addOne(2, "ship"); await tick();
  toggle(2, 22); await tick();
  setSelected(4); await tick();
  console.log("after select 4:", screen(), "| air:", asks.map(a => a.key).join(", "));
  take("toggle:2,22").res({ id: 22, done: true }); await tick();
  const afterAccept = screen();
  console.log("after accept toggle:", afterAccept, "| air:", asks.map(a => a.key).join(", "));
  expect(afterAccept).not.toMatch(/2\/repro/);   // shows card 2's rows again while card 4 is selected
});
