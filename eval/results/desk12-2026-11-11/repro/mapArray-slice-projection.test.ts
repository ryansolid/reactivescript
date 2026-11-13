import { test, expect } from "vitest";
import { mapArray, createOptimistic, createProjection, createMemo, createSignal, createRoot, createRenderEffect, action, flush } from "../src/index.js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
// A keyed projection of a list filtered by one guess (closing) and mapped by another (renaming), read through
// mapArray. A removal guess is declined while the rename is still out, so the removed row comes back.
for (const withRename of [true, false]) test(`mapArray over a keyed projection after a declined removal (rename out: ${withRename})`, async () => {
  const seen: string[] = [];
  let close!: (id: number) => any, decline!: () => void, rename!: (id: number) => any;
  createRoot(() => {
    const [base] = createSignal([{ id: 1 }, { id: 3 }, { id: 4 }]);
    const [renT] = createSignal<any[]>(() => []); const [ren, guessRen] = createOptimistic(() => renT());
    const [closingT] = createSignal<number[]>(() => []); const [closing, guessClosing] = createOptimistic(() => closingT());
    const src = createMemo(() => base().filter(i => !closing().includes(i.id)).map(i => ({ id: i.id, title: ren().filter((r: any) => r.id === i.id).reduce((a: string, r: any) => r.title, `t${i.id}`) })));
    const rows: any = createProjection(() => src() as any, [] as any, { key: "id" } as any);
    const mapped = mapArray(() => rows, (r: any) => () => (typeof r === "function" ? r() : r)?.id);
    createRenderEffect(() => mapped().map((f: any) => String(f())).join(","), v => { seen.push(v); });
    // a second reader of the projection, by length and index
    createRenderEffect(() => Array.from({ length: rows.length }, (_, i) => rows[i]?.id).join(","), () => {});
    rename = action(function* (id: number) { guessRen((rs: any[]) => [...rs, { id, title: "new" }]); yield new Promise(() => {}); });
    close = action(function* (id: number) { guessClosing((cs: number[]) => [...cs, id]); try { yield new Promise((_, rej) => (decline = () => rej(new Error("declined")))); } catch {} });
  });
  await tick();
  if (withRename) { rename(3); await tick(); }
  close(1); await tick();
  decline(); await tick();
  console.log(seen.join("\n"));
  expect(seen.at(-1)).toBe("1,3,4");
});
