/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { test, expect } from "vitest";
import { Loading, action, createOptimistic, createSignal, refresh, flush } from "solid-js";
import { render } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
// A guess made while its source is loading a new question (the selection just changed).
for (const kind of ["object", "array"] as const) test(`guess while the source loads a new question (${kind})`, async () => {
  const asks: { key: string; res: (v: any) => void }[] = [];
  const ask = (key: string) => new Promise<any>(res => asks.push({ key, res }));
  const pick = (key: string) => { const i = asks.findIndex(a => a.key === key); if (i < 0) throw new Error("no ask " + key + " in " + asks.map(a => a.key)); return asks.splice(i, 1)[0]; };
  const c = document.body.appendChild(document.createElement("div"));
  const frames: string[] = []; const snap = (l: string) => frames.push(`${l.padEnd(26)} ${c.textContent}`);
  let select!: (id: number) => void, write!: () => any;
  render(() => {
    const [sel, setSel] = createSignal(0);
    const [truth] = createSignal<any>(() => sel() === 0 ? (kind === "object" ? null : []) : ask(`fetch:${sel()}`));
    const [shown, guess] = createOptimistic(() => truth());
    select = setSel;
    write = action(function* () {
      if (kind === "object") guess((d: any) => d == null ? null : { ...d, title: "Bravo" });
      else guess((cs: any[]) => [...cs, "ping"]);
      yield ask("write");
      refresh(truth);
    });
    return <Loading on={sel()} fallback={<i>loading</i>}>
      {kind === "object" ? <b>{shown()?.title ?? "-"}</b> : <b>{shown().join(",")}</b>}
    </Loading>;
  }, c);
  await tick(); snap("start");
  select(3); await tick(); snap("select #3");
  write(); await tick(); snap("write while #3 loads");
  pick("fetch:3").res(kind === "object" ? { title: "Old bug" } : ["seen it too"]); await tick(); snap("#3 lands, write out");
  frames.push("still out: " + asks.map(a => a.key).join(", "));
  console.log(frames.join("\n"));
  // the guess either applies to #3's answer, or it is void (D-34) and #3's answer shows as it is
  expect(c.textContent).toBe(kind === "object" ? "Bravo" : "seen it too,ping");
});
