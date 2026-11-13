/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { For, Loading, action, createOptimistic, createMemo, createSignal, createProjection, refresh, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
test("rows that land while guesses are out render their text", async () => {
  const asks: { key: string; res: (v: any) => void; rej: (e: any) => void }[] = [];
  const inAir = new Map<string, Promise<any>>();
  const ask = (key: string) => new Promise<any>((res, rej) => asks.push({ key, res, rej }));
  const askQ = (key: string) => { let p = inAir.get(key); if (!p) { p = ask(key).finally(() => inAir.delete(key)); inAir.set(key, p); } return p; };   // a question asked again while in the air joins it
  const pick = (key: string) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key + " in " + asks.map(a => a.key)); return asks.splice(i, 1)[0]; };
  const c = document.body.appendChild(document.createElement("div"));
  const frames: string[] = []; const snap = (l: string) => frames.push(`${l.padEnd(22)} ${c.innerHTML}  | in the air: ${asks.map(a => a.key)}`);

  const [filter, setFilter] = createSignal("closed");
  const server = createMemo(() => askQ(filter()));
  const [assigningT] = createSignal<{ id: number; user: string }[]>(() => []);
  const [assigning, guessAssigning] = createOptimistic(() => assigningT());
  const [closingT] = createSignal<number[]>(() => []);
  const [closing, guessClosing] = createOptimistic(() => closingT());
  const rowsSrc = createMemo(() => (server() as any[]).filter(i => !closing().includes(i.id))
    .map(i => ({ id: i.id, title: i.title, assignee: assigning().reduce((n, x) => x.id === i.id ? x.user : n, i.assignee) })));
  const rows = createProjection(() => rowsSrc() as any, [] as any, { key: "id" } as any);
  const showOpen = action(function* () { setFilter("open"); });
  const assignTo = action(function* (id: number, user: string) {
    try { guessAssigning(xs => [...xs, { id, user }]); yield ask(`assign:${user}`); refresh(server); } catch (e) {}
  });
  const closeOne = action(function* (id: number) {
    try { guessClosing(xs => [...xs, id]); yield ask(`close`); refresh(server); } catch (e) {}
  });
  const list = () => <ul><For each={rows as any}>{(it: any) => <li>{`#${it.id} ${it.title} (${it.assignee})`}</li>}</For></ul>;
  render(() => <Loading fallback={<p>loading</p>}>{list()}</Loading>, c);

  const steps: [string, () => void][] = [
    ["mount", () => {}],
    ["closed list lands", () => pick("closed").res([{ id: 2, title: "Old bug", assignee: "eve" }])],
    ["assign #2 ann", () => assignTo(2, "ann")],
    ["close #2", () => closeOne(2)],
    ["assign #2 guest", () => assignTo(2, "guest")],
    ["that assign lands", () => pick("assign:guest").res({})],              // re-asks the closed list
    ["close declined", () => pick("close").rej(new Error("declined"))],
    ["assign #2 guest again", () => assignTo(2, "guest")],
    ["assign ann lands", () => pick("assign:ann").res({})],                // re-asks the closed list (joins the one in the air)
    ["switch to open", () => showOpen()],
    ["open list lands", () => pick("open").res([{ id: 1, title: "Login fails", assignee: null }, { id: 3, title: "Crash on save", assignee: null }])],
    ["second assign lands", () => pick("assign:guest").res({})],          // re-asks the open list
    ["open list lands again", () => pick("open").res([{ id: 1, title: "Login fails", assignee: null }, { id: 3, title: "Crash on save", assignee: null }])],
  ];
  for (const [n, f] of steps) { f(); await tick(); snap(n); }
  console.log(frames.join("\n"));
  expect(c.textContent).toBe("#1 Login fails (null)#3 Crash on save (null)");
});
