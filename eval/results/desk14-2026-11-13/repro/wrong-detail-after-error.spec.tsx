/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { Loading, Errored, Show, action, createOptimistic, createMemo, createSignal, refresh, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
test("after a failed detail, its re-ask's answer shows, not the detail of the issue selected before", async () => {
  const asks: { key: string; p: Promise<any>; res: (v: any) => void; rej: (e: any) => void }[] = [];
  // one flight per key while it is out, like the app's backend plumbing
  const ask = (key: string) => { const o = asks.find(a => a.key === key); if (o) return o.p; let res: any, rej: any; const p = new Promise<any>((a, b) => { res = a; rej = b; }); asks.push({ key, p, res, rej }); return p; };
  const pick = (key: string) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key + " in " + asks.map(a => a.key)); return asks.splice(i, 1)[0]; };
  const c = document.body.appendChild(document.createElement("div"));
  const frames: string[] = []; const snap = (l: string) => frames.push(`${l.padEnd(18)} ${c.innerHTML}  | in the air: ${asks.map(a => a.key)}`);

  const [selected, setSelected] = createSignal<number | null>(null);
  const [renaming, guessRename] = createOptimistic<{ id: number; title: string }[]>(() => []);
  const [closing, guessClose] = createOptimistic<number[]>(() => []);

  const list = createMemo(() => ask("list"));
  const answer = createMemo(() => selected() != null ? ask(`detail:${selected()}`) : undefined);
  const detail = createMemo(() => selected() == null ? null : answer());
  const heading = createMemo(() => { const d: any = detail(); return d == null ? "" : renaming().reduce((t, r) => r.id === d.id ? r.title : t, d.title); });

  const select = action(function* (id: number) { setSelected(id); });
  const rename = action(function* (id: number, title: string) { guessRename(rs => [...rs, { id, title }]); yield ask(`rename:${id}`); refresh(list); refresh(answer); refresh(detail); });
  const close = action(function* (id: number) { guessClose(cs => [...cs, id]); yield ask(`close:${id}`); refresh(list); });

  render(() => <main>
    <Show when={selected() != null} fallback={<p>select</p>}>
      <Loading on={selected()} fallback={<p>loading #{selected()}</p>}>
        <Errored fallback={(e: any) => <p>detail error: {e()?.message}</p>}>
          <h2>#{selected()} {heading()} (detail of #{(detail() as any)?.id})</h2>
        </Errored>
      </Loading>
    </Show>
  </main>, c);

  const issues = [{ id: 1, title: "Login fails" }, { id: 3, title: "Crash on save" }, { id: 4, title: "Typo in footer" }];
  const steps: [string, () => void][] = [
    ["list lands", () => pick("list").res(issues)],
    ["select #4", () => select(4)],
    ["rename #4", () => rename(4, "Alpha")],
    ["detail #4 lands", () => pick("detail:4").res({ id: 4, title: "Typo in footer" })],
    ["select #3", () => select(3)],
    ["close #3", () => close(3)],
    ["close #4", () => close(4)],
    ["rename #3", () => rename(3, "Delta")],
    ["rename #4 lands", () => pick("rename:4").res({})],
    ["detail #3 fails", () => pick("detail:3").rej(new Error("declined"))],
    ["close #4 lands", () => pick("close:4").res({})],
    ["rename #3 lands", () => pick("rename:3").res({})],
    ["detail #3 lands", () => pick("detail:3").res({ id: 3, title: "Delta" })],
    ["close #3 lands", () => pick("close:3").res({})],
    ["list lands", () => { while (asks.some(a => a.key === "list")) pick("list").res(issues); }],
  ];
  for (const [i, [n, f]] of steps.entries()) { if (skip.includes(i)) continue; try { f(); } catch (e) { snap("SKIPPED " + n); continue; } await tick(); snap(n); }
  console.log(frames.join("\n"));
  expect(c.querySelector("h2")?.textContent).toBe("#3 Delta (detail of #3)");
});
