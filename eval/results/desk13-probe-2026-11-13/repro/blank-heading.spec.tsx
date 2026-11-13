/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { For, Loading, Show, action, createOptimistic, createMemo, createSignal, refresh, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
test("a heading that reads a guess shows it when its async source lands", async () => {
  const asks: { key: string; res: (v: any) => void }[] = [];
  const ask = (key: string) => new Promise<any>(res => asks.push({ key, res }));
  const pick = (key: string) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key + " in " + asks.map(a => a.key)); return asks.splice(i, 1)[0]; };
  const c = document.body.appendChild(document.createElement("div"));
  const frames: string[] = []; const snap = (l: string) => frames.push(`${l.padEnd(18)} ${c.innerHTML}  | in the air: ${asks.map(a => a.key)}`);

  const [selected, setSelected] = createSignal(false);
  const [renamesT] = createSignal<string[]>(() => []);
  const [renames, guessRename] = createOptimistic(() => renamesT());

  const list = createMemo(() => ask("list"));
  const rows = createMemo(() => (list() as any[]).map(i => ({ id: i.id, title: renames().reduce((t, r) => r, i.title) })));
  const detail = createMemo(() => selected() ? ask("detail") : null);
  const heading = createMemo(() => { const d: any = detail(); return d == null ? "" : renames().reduce((t, r) => r, d.title); });

  const rename = action(function* (title: string) { guessRename(rs => [...rs, title]); yield ask("rename"); refresh(list); refresh(detail); });
  const other = action(function* () { yield ask("other"); refresh(list); });

  render(() => <main>
    <Loading fallback={<p>loading</p>}><ul><For each={rows()}>{(it: any) => <li>{it.title}</li>}</For></ul></Loading>
    <Show when={selected()} fallback={<p>select</p>}>
      <Loading fallback={<p>loading detail</p>}><h2>{heading()}</h2><p>{(detail() as any)?.body}</p></Loading>
    </Show>
  </main>, c);

  const steps: [string, () => void][] = [
    ["list lands", () => pick("list").res([{ id: 2, title: "Old bug" }])],
    ["select", () => setSelected(true)],
    ["other action", () => other()],
    ["rename to Delta", () => rename("Delta")],
    ["other lands", () => pick("other").res({})],   // re-asks the list
    ["detail lands", () => pick("detail").res({ title: "Old bug", body: "long gone" })],
  ];
  for (const [n, f] of steps) { f(); await tick(); snap(n); }
  console.log(frames.join("\n"));
  expect(c.querySelector("h2")?.textContent).toBe("Delta");
});
