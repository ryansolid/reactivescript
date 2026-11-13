/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { For, Loading, action, createOptimistic, createMemo, createSignal, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
test("selecting another issue while a rename guess is out does not loop", async () => {
  const asks: { key: string; res: (v: any) => void }[] = [];
  const ask = (key: string) => new Promise<any>(res => asks.push({ key, res }));
  const pick = (key: string) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key); return asks.splice(i, 1)[0]; };
  const c = document.body.appendChild(document.createElement("div"));

  const [selected, setSelected] = createSignal<number | null>(null);
  const [renaming, guessRename] = createOptimistic<{ id: number; title: string }[]>(() => []);
  const detail = createMemo(() => selected() != null ? ask(`detail:${selected()}`) : undefined);
  const heading = createMemo(() => { const d: any = detail(); return d == null ? "" : renaming().reduce((t, r) => r.id === d.id ? r.title : t, d.title); });
  const selList = createMemo(() => selected() == null ? [] : [selected()]);
  const rename = action(function* (id: number, title: string) { guessRename(rs => [...rs, { id, title }]); yield ask(`rename:${id}`); });

  // A page component: its children are read through a getter, as a compiled `if` passes them.
  const Page = (p: { children: any }) => <>{p.children}</>;
  const Detail = (props: { id: number }) => <div>
    <Loading fallback={<p>loading #{props.id}</p>}>
      <h2>#{props.id} {heading()}</h2><p>{(detail() as any)?.body}</p>
    </Loading>
  </div>;
  render(() => <main><Page><For each={selList()}>{(s: any) => <Detail id={s} />}</For></Page></main>, c);

  setSelected(4); await tick();
  rename(4, "Bravo"); await tick();                                   // the guess stays out: rename never answers
  pick("detail:4").res({ id: 4, title: "Typo in footer", body: "four" }); await tick();
  expect(c.textContent).toContain("#4 Bravo");
  setSelected(3); await tick();                                       // here: "Potential Infinite Loop Detected" (a hang in production)
  expect(c.textContent).toContain("loading #3");
});
