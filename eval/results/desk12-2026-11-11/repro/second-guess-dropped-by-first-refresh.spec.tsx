/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { Loading, Show, action, createMemo, createOptimisticStore, refresh, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
// A heading shows a rename guess (an optimistic store slot) over the detail's title. A second rename is guessed on the
// same slot while the first rename's refresh of another source (the list) is still out; then that refresh answers.
test("a second rename guess on one slot stays when the first rename's refresh answers", async () => {
  const asks: { key: string; res: (v: any) => void }[] = [];
  const ask = (key: string) => new Promise<any>(res => asks.push({ key, res }));
  const take = (key: string) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key + " in " + asks.map(a => a.key)); return asks.splice(i, 1)[0]; };
  const c = document.body.appendChild(document.createElement("div"));
  const frames: string[] = []; const snap = (l: string) => frames.push(`${l.padEnd(30)} ${c.textContent}`);
  let rename!: (t: string) => any;
  render(() => {
    const detail = createMemo(() => ask("detail"));
    const [renaming, setRenaming] = createOptimisticStore((d: any) => { for (const k of Object.keys(d)) delete d[k]; }, {} as Record<number, string>);
    const list = createMemo(() => ask("list"));
    rename = action(function* (t: string) { setRenaming((d: any) => { d[2] = t; }); yield ask(`rename:${t}`); refresh(list); refresh(detail); });
    return <Loading fallback="loading">
      <i>{(list() as any[]).length} </i><h2>{(renaming[2] ?? "") !== "" ? <span>{renaming[2]}</span> : <span>{(detail() as any).title}</span>}</h2>
    </Loading>;
  }, c);
  await tick(); take("detail").res({ title: "Old" }); take("list").res([1]); await tick(); snap("loaded");
  rename("Bravo"); await tick(); snap("rename Bravo (out)");
  take("rename:Bravo").res({}); await tick(); snap("Bravo lands, detail re-asked");
  take("detail").res({ title: "Bravo" }); await tick(); snap("detail answers Bravo");
  rename("Delta"); await tick(); snap("rename Delta (out)");
  take("list").res([1]); await tick(); snap("Bravo's list answers");
  const during = c.textContent!;
  console.log(frames.join("\n"));
  expect(/Delta/.test(during)).toBe(true);
});
