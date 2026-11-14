/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { For, Show, action, createMemo, createSignal, createOptimistic, createProjection, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
// .rx: `rows key k = [...items, ...adding]` (createProjection keyed), `for r in rows { if r.adding {…} else {…} }`.
// Passes without the <Show> (row text only), and with <For each={src()}> (no projection); passes in .rx with two
// plain signals written in one click (no guess). So: projection + a guess dropped and a row added in one commit + Show.
// An add's action ends: its guess row (key b-two) goes and its answer's row (key a-two) comes, in one commit.
test("a keyed row that replaces a guessed row in one commit renders under <For>/<Show>", async () => {
  let res!: (v: string) => void;
  const c = document.body.appendChild(document.createElement("div"));
  const [items, setItems] = createSignal<string[]>(["one"]);
  const [adding, guessAdding] = createOptimistic<string[]>(() => []);
  const src = createMemo(() => [
    ...items().map(t => ({ k: `a-${t}`, t, adding: false })),
    ...adding().map(t => ({ k: `b-${t}`, t, adding: true })),
  ]);
  const rows = createProjection(() => src() as any, [] as any, { key: "k" } as any) as any;
  const add = action(function* (t: string) {
    guessAdding(xs => [...xs, t]);
    const r: string = yield new Promise<string>(r => (res = r));
    setItems(xs => [...xs, r]);
  });
  render(() => <p>{rows.length}:<For each={rows}>{(r: any) =>
    <Show when={r.adding} fallback={<span>[{r.t}]</span>}><span>[{r.t} (adding)]</span></Show>}</For></p>, c);
  await tick();
  add("two"); await tick();
  expect(c.textContent).toBe("2:[one][two (adding)]");
  res("two"); await tick();
  console.log("after accept:", c.textContent);
  expect(c.textContent).toBe("2:[one][two]");
});
