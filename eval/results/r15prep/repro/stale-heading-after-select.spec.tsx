/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { Show, Loading, Errored, action, createMemo, createSignal, createOptimistic, flush, untrack } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
test("a heading reading a rename guess shows the newly selected issue's title, not the previous issue's", async () => {
  const asks: { key: string; res: (v: any) => void }[] = [];
  const ask = (key: string) => new Promise<any>(res => asks.push({ key, res }));
  const land = (key: string, v: any) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key); asks.splice(i, 1)[0].res(v); };
  const c = document.body.appendChild(document.createElement("div"));

  const [selected, setSelected] = createSignal<number | null>(null);
  const [renames, guessRename] = createOptimistic<{ id: number; title: string }[]>(() => []);
  const detail = createMemo(() => (selected() != null ? ask(`detail:${selected()}`) : undefined));
  const heading = createMemo(() => { const d: any = detail(); return d == null ? "" : renames().reduce((t, r) => (r.id === d.id ? r.title : t), d.title); });
  const select = action(function* (id: number) { setSelected(id); });
  const rename = action(function* (id: number, title: string) { guessRename(rs => [...rs, { id, title }]); yield ask(`rename:${id}`); });

  // related help searched by the heading, under its own boundary
  const Related = (props: { title: string }) => {
    const hits = createMemo(() => ask(`search:${props.title}`));
    return <Loading on={props.title} fallback={<p>finding related help</p>}>
      <Errored fallback={<p>failed</p>}>
        <Show when={(hits() as any[]).length === 0} fallback={<p>some help</p>}><p>no help</p></Show>
      </Errored>
    </Loading>;
  };
  render(() => <Loading on={selected()} fallback={<p>loading #{selected()}</p>}>
    <h2>#{(detail() as any)?.id} {heading()}</h2>
    <Related title={heading()} />
  </Loading>, c);

  select(4); await tick();
  land("detail:4", { id: 4, title: "Typo in footer" }); await tick();
  select(3); await tick();
  land("search:Typo in footer", [{ id: 9 }]); await tick();
  rename(3, "Delta"); await tick();                                   // its answer stays out
  land("detail:3", { id: 3, title: "Crash on save" }); await tick();
  console.log("heading memo:", untrack(heading), "| screen:", c.querySelector("h2")?.textContent, "| in the air:", asks.map(a => a.key).join(", "));
  expect(c.querySelector("h2")?.textContent).toBe("#3 Delta");      // shows "#3 Typo in footer": #4's title
});
