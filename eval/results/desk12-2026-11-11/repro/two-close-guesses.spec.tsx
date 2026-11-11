/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { For, Loading, action, createOptimistic, createOptimisticStore, createMemo, createSignal, refresh, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
const V = process.env.V ?? "full";
test("two close guesses on one list: both hold until the refresh lands", async () => {
  const asks: { key: string; res: (v: any) => void }[] = [];
  const ask = (key: string) => new Promise<any>(res => asks.push({ key, res }));
  const pick = (key: string) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key + " in " + asks.map(a => a.key)); return asks.splice(i, 1)[0]; };
  const c = document.body.appendChild(document.createElement("div"));
  let close!: (id: number) => any, assign!: (id: number) => any;
  let server = [{ id: 1, a: "" }, { id: 4, a: "dana" }];
  render(() => {
    const [issues, setIssues] = createOptimisticStore(async (d: any) => { const v = await ask("fetch"); d.splice(0, d.length, ...v); }, [] as any[], { key: "id" } as any);
    const [truth] = createSignal<number[]>(() => []);
    const [hidden, guessHidden] = createOptimistic(() => truth());
    const shown = createMemo(() => issues.filter((i: any) => !hidden().includes(i.id)));
    close = action(function* (id: number) { guessHidden(h => [...h, id]); yield ask(`close:${id}`); refresh(issues); });
    assign = action(function* (id: number) { setIssues((d: any) => { d.find((x: any) => x.id === id).a = "guest"; }); yield ask(`assign:${id}`); refresh(issues); });
    return <Loading fallback={<i>loading</i>}><For each={shown()}>{r => <i>[#{r.id}]</i>}</For></Loading>;
  }, c);
  await tick();
  pick("fetch").res(server.map(x => ({ ...x }))); await tick();
  expect(c.textContent).toBe("[#1][#4]");
  close(1); await tick();
  if (V !== "noassign") { assign(4); await tick(); }
  close(4); await tick();
  expect(c.textContent).toBe("");
  server = server.filter(x => x.id !== 4);
  pick("close:4").res({}); await tick();
  expect(c.textContent).toBe("");
  server = server.filter(x => x.id !== 1);
  pick("close:1").res({}); await tick();
  expect(c.textContent).toBe("");   // the fetch the closes asked is still out: both guesses hold (D-33, F-11)
});
