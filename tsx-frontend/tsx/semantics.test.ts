import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { lowerTsx } from "./lower.ts";
import { check } from "./rx/compiler.ts";
import { Runtime } from "./rx/runtime.ts";
import { compile } from "./rx/compiler.ts";
import { lowerViews, STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";

async function compare(source: string, expected: string[]) {
  const native = transform(source, { filename: "Counter.tsx", generate: "universal", moduleName: STRING_RENDERER }).code;
  const program = lowerTsx(source, "Counter.tsx");
  program.view = [{ k: "el", tag: "Counter", attrs: [], children: [] }];
  assert.deepEqual(check(program), []);
  const runtime = new Runtime(program);
  const interpreted = [runtime.step([]).at(-1)!.frame];
  const find = (items: any[]): any => {
    for (const item of items) {
      if (item.k === "el" && item.tag === "button") return item;
      const nested = item.children ?? item.inst?.items ?? item.committed?.inst?.items ??
        item.committedRows?.flatMap((row: any) => row.inst.items) ?? [];
      const hit = find(nested);
      if (hit) return hit;
    }
  };
  for (let i = 1; i < expected.length; i++) {
    const handler = find(runtime.view.items)?.attrs.find((a: any) => a.name === "onClick")?.node;
    assert.ok(handler, "interpreter must execute the authored handler");
    const click = handler.compute(runtime);
    assert.equal(typeof click, "function");
    click();
    interpreted.push(runtime.handler([]).at(-1)!.frame);
  }
  assert.deepEqual(interpreted, expected, "interpreter");
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "tsx-semantics-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  try {
    for (const name of ["native.mts", "lowered.mjs"]) {
      let code = native;
      if (name === "lowered.mjs") {
        code = lowerViews(new Map([[name, compile(program)]]), "universal").get(name)!;
      }
      const path = dir + "/" + name;
      writeFileSync(path, code.replaceAll(STRING_RENDERER, renderer));
      const module = await import(pathToFileURL(path).href);
      const app = createApp();
      const dispose = app.mount(name === "native.mts" ? () => module.Counter() : module.default(app));
      try {
        flush();
        const frames = [app.frame()];
        const button = (node: any): any => node.tag === "button" ? node : node.children?.map(button).find(Boolean);
        for (let i = 1; i < expected.length; i++) { button(app.root).props.onClick(); flush(); frames.push(app.frame()); }
        assert.deepEqual(frames, expected, name);
      } finally { dispose(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("scalar snapshots stay fixed while string/boolean derivations remain live", async () => {
  await compare('import { createSignal, createMemo, untrack } from "solid-js"; export function Counter() { const [n,setN] = createSignal(0); const initial = untrack(() => n()); const label = createMemo(() => n() > 1 ? "many" : "few"); return <button onClick={() => setN(n()+1)}>{initial}:{n()}:{label()}:{n() > 1}</button>; }',
    ["0:0:few:", "0:1:few:", "0:2:many:", "0:3:many:"]);
});

test("ordinary helpers receive current values without turning helper locals into equations", async () => {
  await compare('import { createSignal, createMemo, untrack } from "solid-js"; function label(value: number): string { const doubled = value * 2; return "#" + doubled; } export function Counter() { const [n,setN] = createSignal(1); const initial = untrack(() => label(n())); const text = createMemo(() => label(n())); return <button onClick={() => setN(n()+1)}>{initial}/{text()}</button>; }',
    ["#2/#2", "#2/#4", "#2/#6", "#2/#8"]);
});

test("nested store draft writes preserve native primitive display and live memo reads", async () => {
  await compare('import { createStore, createMemo, untrack } from "solid-js"; export function Counter() { const [state,setState] = createStore({count:0, flags:{enabled:true}}); const initial = untrack(() => state.count); const label = createMemo(() => state.flags.enabled ? "on" : "off"); return <button onClick={() => setState(draft => { draft.count = state.count + 1; draft.flags.enabled = !state.flags.enabled; })}>{initial}/{state.count}/{label()}</button>; }',
    ["0/0/on", "0/1/off", "0/2/on", "0/3/off"]);
});

test("handler writes preserve native Solid committed-read ordering", async () => {
  await compare('import { createSignal } from "solid-js"; export function Counter() { const [a,setA] = createSignal(0); const [b,setB] = createSignal(0); return <button onClick={() => { setA(a()+1); setB(a()); }}>{a()}/{b()}</button>; }',
    ["0/0", "1/0", "2/1", "3/2"]);
});

test("fragments, ordinary attributes, decoded entities and multiline whitespace match native Solid", async () => {
  await compare('import { createSignal } from "solid-js"; export function Counter() { const [n,setN] = createSignal(0); return <>\n  <button title="count" onClick={() => setN(n()+1)}>A &amp; B {n()}</button>\n  <span>tail</span>\n</>; }',
    ["A & B 0tail", "A & B 1tail", "A & B 2tail"]);
});

test("structured projections update their draft from reactive inputs", async () => {
  await compare('import { createSignal, createProjection } from "solid-js"; export function Counter() { const [n,setN] = createSignal(0); const projected = createProjection(draft => { draft.value = n() * 2; }, {value:0}); return <button onClick={() => setN(n()+1)}>{projected.value}</button>; }',
    ["0", "2", "4", "6"]);
});

test("derived sources accept manual writes and rederive when their inputs change", async () => {
  await compare('import { createSignal } from "solid-js"; export function Counter() { const [base,setBase] = createSignal(1); const [step,setStep] = createSignal(0); const [draft,setDraft] = createSignal(() => base() * 10); return <button onClick={() => { setStep(step()+1); if (step()%3 === 0) { setDraft(99); } else if (step()%3 === 1) { setBase(base()+1); } else { setDraft(50); } }}>{base()}/{draft()}</button>; }',
    ["1/10", "1/99", "2/20", "2/50", "2/99", "3/30"]);
});

test("a memo's previous-value parameter follows the node's latest change", async () => {
  await compare('import { createSignal, createMemo } from "solid-js"; export function Counter() { const [n,setN] = createSignal(0); const total = createMemo((previous: number | undefined) => (previous ?? 0) + n()); return <button onClick={() => setN(n()+1)}>{total()}</button>; }',
    ["0", "1", "3", "6", "10"]);
});

test("explicit table sections retain live component cells across updates", async () => {
  await compare('import {createSignal} from "solid-js"; function Row(props:{n:number}) { return <tr><td>{props.n}</td></tr>; } export function Counter() { const [n,setN]=createSignal(0); return <><table><tbody><Row n={n()}/></tbody></table><button onClick={()=>setN(n()+1)}>go</button></>; }',
    ["0go", "1go", "2go"]);
});

test("browser-repaired content models fail at their authored component application", () => {
  const invalid = [
    'function Row() { return <tr><td>cell</td></tr>; }\nexport function Counter() {\n  return <table>\n    <Row/>\n  </table>;\n}',
    'function Block() { return <div>block</div>; }\nexport function Counter() {\n  return <p>\n    <Block/>\n  </p>;\n}',
  ];
  for (const source of invalid) {
    const diagnostics = check(lowerTsx(source, "Counter.tsx"));
    assert.ok(diagnostics.some(d => d.code === "CONTENT_MODEL" && d.line === 4));
  }
});
