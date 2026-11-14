/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { Loading, Errored, For, action, createMemo, createSignal, createOptimistic, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
test("a checklist reading the selection and a pending guess shows the fallback on select, and drops a declined guess at once", async () => {
  const asks: { key: string; res: (v: any) => void; rej: (e: any) => void }[] = [];
  const ask = (key: string) => new Promise<any>((res, rej) => asks.push({ key, res, rej }));
  const take = (key: string) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key); return asks.splice(i, 1)[0]; };
  const c = document.body.appendChild(document.createElement("div"));

  const [selected, setSelected] = createSignal(2);
  const [toggling, guessToggling] = createOptimistic<number[]>(() => []);
  const checklist = createMemo(() => ask(`checklist:${selected()}`));
  const toggle = action(function* (item: number) {
    try { guessToggling(ts => [...ts, item]); yield ask(`toggle:${item}`); } catch { /* declined */ }
  });

  render(() => <div>
    <p id="count">{toggling().length}</p>
    <Loading on={selected()} fallback={<p id="fb">loading checklist</p>}>
      <Errored fallback={<p>error</p>}>
        {(() => {
          const items = createMemo(() => (checklist() as any[]).map(it => `${selected()}/${it.text}:${toggling().includes(it.id)}`));
          return <For each={items()}>{it => <span class="item">{it()}</span>}</For>;
        })()}
      </Errored>
    </Loading>
  </div>, c);
  const screen = () => `count=${c.querySelector("#count")!.textContent} | ${c.querySelector("#fb") ? "loading checklist" : [...c.querySelectorAll(".item")].map(e => e.textContent).join(" ")}`;

  take("checklist:2").res([{ id: 21, text: "repro" }, { id: 22, text: "patch" }]); await tick();
  toggle(22); await tick();
  console.log("after toggle:", screen());
  setSelected(1); await tick();
  const afterSelect = screen();
  console.log("after select 1:", afterSelect);
  take("toggle:22").rej(new Error("read only")); await tick();
  const afterDecline = screen();
  console.log("after decline:", afterDecline, "| in the air:", asks.map(a => a.key).join(", "));
  expect(afterSelect).toBe("count=1 | loading checklist");
  expect(afterDecline).toBe("count=0 | loading checklist");
});
