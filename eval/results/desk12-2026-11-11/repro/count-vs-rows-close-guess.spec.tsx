/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { For, Show, Loading, action, createEffect, createMemo, createOptimisticStore, createProjection, createSignal, refresh, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
// A list with a per-row "closing" guess (an optimistic store keyed by id). The count of open rows is a memo over the
// list and the guesses, reported by an effect. Three closes overlap: #3 out, #1 out and accepted (its refresh out),
// #3 declined, then #4 guessed while #1's refresh is still out.
test("count and rows agree on a close guessed during another close's refresh", async () => {
  const asks: { key: string; res: (v: any) => void; rej: (e: any) => void }[] = [];
  const ask = (key: string) => new Promise<any>((res, rej) => asks.push({ key, res, rej }));
  const take = (key: string) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key); return asks.splice(i, 1)[0]; };
  const c = document.body.appendChild(document.createElement("div"));
  const frames: string[] = []; const snap = (l: string) => frames.push(`${l.padEnd(30)} ${c.textContent}`);
  let close!: (id: number) => any;
  render(() => {
    const [count, setCount] = createSignal(-1);
    const server = createMemo(() => ask("list"));
    const [closing, setClosing] = createOptimisticStore((d: any) => { for (const k of Object.keys(d)) delete d[k]; }, {} as Record<number, boolean>);
    const rows = createProjection(() => server() as any, [] as any, { key: "id" } as any);
    const openCount = createMemo(() => (rows as any[]).filter(i => closing[i.id] !== true).length);
    close = action(function* (id: number) { setClosing((d: any) => { d[id] = true; }); try { yield ask(`close:${id}`); refresh(server); } catch {} });
    return <>
      <i>[{count()}] </i>
      <Loading fallback="loading">
        {(createEffect(() => openCount(), n => { setCount(n); }), null)}
        <For each={rows as any}>{(r: any) => <Show when={closing[r.id] !== true}><b>#{r.id} </b></Show>}</For>
      </Loading>
    </>;
  }, c);
  await tick(); take("list").res([{ id: 1 }, { id: 3 }, { id: 4 }]); await tick(); snap("loaded");
  close(3); await tick(); snap("close #3 (out)");
  close(1); await tick(); snap("close #1 (out)");
  take("close:1").res({}); await tick(); snap("close #1 lands, refresh out");
  take("close:3").rej(new Error("declined")); await tick(); snap("close #3 declined");
  close(4); await tick(); snap("close #4 during the refresh");
  const during = c.textContent!;
  take("close:4").res({}); await tick(); snap("close #4 lands");
  while (asks.some(a => a.key === "list")) { take("list").res([{ id: 3 }]); await tick(); }
  snap("refreshes answer");
  console.log(frames.join("\n"));
  expect(Number(during.match(/\[(-?\d+)\]/)![1])).toBe((during.match(/#\d+/g) ?? []).length);
});
