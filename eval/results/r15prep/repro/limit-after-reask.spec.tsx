/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { For, action, createMemo, createSignal, createOptimistic, flush, refresh } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };

// A kanban board: card 5 moves into "doing" (a guess), the move is accepted, and the action re-asks both columns in a
// nested action. While the doing re-ask is still out, the todo re-ask lands: the todo rows are rebuilt and the new
// buttons read `intoDoing` as if the guess were gone, while the text beside them still reads it with the guess.
test("rows rebuilt while a sibling refresh is out read a memo without the action's guess", async () => {
  const fl: Record<string, ((v: any) => void)[]> = {};
  const ask = (k: string) => new Promise<any>(r => (fl[k] ??= []).push(r));
  const land = (k: string, v: any) => { const rs = fl[k]; fl[k] = []; rs.forEach(r => r(structuredClone(v))); };
  const c = document.body.appendChild(document.createElement("div"));

  const [todoAns] = createSignal<any>(() => ask("todo"), { loadingValue: null } as any);
  const [doingAns] = createSignal<any>(() => ask("doing"), { loadingValue: null } as any);
  const [moving, guessMoving] = createOptimistic<number[]>(() => []);
  const todoRows = createMemo(() => { const a = todoAns(); return a == null ? [] : a.filter((id: number) => !moving().includes(id)).map((id: number) => ({ id })); });
  const doingRows = createMemo(() => { const a = doingAns(); return a == null ? null : [...a, ...moving()]; });
  const doingUp = createMemo(() => doingRows() != null);          // needed: a second reader of doingRows
  const intoDoing = createMemo(() => doingRows() != null && doingRows()!.length < 3);
  const reask = action(function* () { refresh(todoAns); refresh(doingAns); });
  const move = action(function* (id: number) {
    guessMoving(ms => [...ms, id]);
    yield ask("move");
    yield reask();                                                // needed: nested action (inline refreshes pass)
  });
  render(() => <div>
    <For each={todoRows()}>{(r: any) => <button disabled={!intoDoing()}>{r.id}</button>}</For>
    <p>{doingUp() ? "up" : "down"}</p>
    <p>doing={String(doingRows()?.length)} into={String(intoDoing())}</p>
  </div>, c);
  const state = () => `${[...c.querySelectorAll("button")].map(b => b.textContent + (b.disabled ? "x" : "")).join(",")} ${c.querySelectorAll("p")[1].textContent}`;

  land("doing", [3, 4]); land("todo", [1, 2, 5]); await tick();
  expect(state()).toBe("1,2,5 doing=2 into=true");
  move(5); await tick();
  expect(state()).toBe("1x,2x doing=3 into=false");
  land("move", {}); await tick();
  expect(state()).toBe("1x,2x doing=3 into=false");
  land("todo", [1, 2, 5]); await tick();                          // doing's re-ask still out
  console.log("after todo lands:", state());
  expect(state()).toBe("1x,2x doing=3 into=false");                // actual: "1,2 doing=3 into=false"
});
