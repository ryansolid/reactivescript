/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { Loading, For, action, createMemo, createOptimisticStore, createSignal, refresh, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
const draft = (d: any, v: any[]) => { d.length = v.length; v.forEach((x, i) => { d[i] = { ...x }; }); };
const OPEN = [{ id: 1, assignee: "-" }, { id: 3, assignee: "-" }];
// Two lists, each over a constant question; a filter picks one. A row guess on the open list is out while the user
// switches to closed and back (the switch back re-asks the open list).
for (const reask of [true, false]) for (const order of ["closed lands after switching back", "closed lands before switching back"] as const)
test(`split lists: ${order}, reask ${reask}`, async () => {
  const asks: { key: string; res: (v: any) => void }[] = [];
  const ask = (key: string) => new Promise<any>(res => asks.push({ key, res }));
  const land = (key: string, v: any) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key + " in " + asks.map(a => a.key)); asks.splice(i, 1)[0].res(v); };
  const c = document.body.appendChild(document.createElement("div"));
  const frames: string[] = []; const snap = (l: string) => frames.push(`${l.padEnd(34)} ${c.textContent}`);
  let toClosed!: () => void, toOpen!: () => void, assign!: () => any;
  render(() => {
    const [filter, setFilter] = createSignal("open");
    const aOpen = createMemo(() => ask("open"));
    const aClosed = createMemo(() => ask("closed"));
    const [open, setOpen] = createOptimisticStore((d: any) => { draft(d, aOpen()); }, [] as any[], { key: "id" } as any);
    const [closed] = createOptimisticStore((d: any) => { draft(d, aClosed()); }, [] as any[], { key: "id" } as any);
    const issues = createMemo(() => filter() === "open" ? open : closed);
    toClosed = () => setFilter("closed");
    toOpen = () => { setFilter("open"); if (reask) { refresh(aOpen); refresh(open); } };
    assign = action(function* () {
      setOpen((d: any) => { d[d.findIndex((r: any) => r.id === 3)].assignee = "ann"; });
      yield ask("assign");
      refresh(aOpen); refresh(open);
    });
    return <Loading on={filter()} fallback={<i>loading</i>}>
      <For each={issues()}>{(r: any) => <b>#{r.id}({r.assignee}) </b>}</For>
    </Loading>;
  }, c);
  await tick(); land("open", OPEN); await tick(); snap("start");
  assign(); await tick(); snap("assign #3 (out)");
  toClosed(); await tick(); snap("filter closed");
  if (order === "closed lands before switching back") { land("closed", []); await tick(); snap("closed lands"); }
  toOpen(); await tick(); snap("filter open (re-asks open)");
  if (order === "closed lands after switching back") { land("closed", []); await tick(); snap("closed lands"); }
  if (reask) land("open", OPEN); await tick(); snap("open answers (no ann yet)");
  const during = c.textContent;
  land("assign", {}); await tick(); snap("assign answers");
  if (asks.some(a => a.key === "open")) land("open", OPEN.map(r => r.id === 3 ? { ...r, assignee: "ann" } : r)); await tick(); snap("its refresh answers");
  frames.push("still out: " + asks.map(a => a.key).join(", "));
  console.log(frames.join("\n"));
  expect(during).toBe("#1(-) #3(ann) ");
});
