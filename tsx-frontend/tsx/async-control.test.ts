import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { buildTsx } from "./build.ts";
import { STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";
import { Runtime } from "./rx/runtime.ts";

type Step = { click: number } | { land: string; value: unknown };
const imports = 'import { createSignal, createMemo, createDeferred, isPending, Loading, Errored, action, refresh, affects } from "solid-js"; import { fetch } from "./api";';
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise<void>(resolve => setImmediate(resolve)); flush(); } };
const buttons = (node: any): any[] => node.tag === "button" ? [node] : (node.children ?? []).flatMap(buttons);

function interpretedButtons(items: any[]): any[] {
  return items.flatMap(item => {
    if (item.k === "el" && item.tag === "button") return [item];
    const nested = item.children ?? item.inst?.items ?? item.committed?.inst?.items
      ?? item.committedRows?.flatMap((row: any) => row.inst.items)
      ?? ((item.k === "loading" || item.k === "errored") ? (item.committedFallback ? item.fallback : item.content)?.items : []);
    return interpretedButtons(nested ?? []);
  });
}

async function differential(
  nativeSources: [string, string][], compiledSources: [string, string][], declarations: string, steps: Step[], expected: string[], calls: Record<string, number>,
) {
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "async-control-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  const traces: string[][] = [];
  try {
    // The direct native form establishes the contract before the alternate spelling or checker is consulted.
    for (const { name, source, native } of [
      ...nativeSources.map(([name, source]) => ({ name, source, native: true })),
      ...compiledSources.map(([name, source]) => ({ name, source, native: false })),
    ]) {
      const output = dir + "/" + name; mkdirSync(output);
      writeFileSync(output + "/api.mjs", "export const fetch = key => globalThis.__asyncControlFetch(key);");
      const requests = new Map<string, { resolve: (value: unknown) => void; landed: boolean }[]>();
      const fetch = (key: string) => new Promise<unknown>(resolve => {
        let entries = requests.get(key); if (!entries) requests.set(key, (entries = []));
        entries.push({ resolve, landed: false });
      });
      (globalThis as any).__asyncControlFetch = fetch;
      let entry: string;
      if (native) {
        entry = name + ".mts";
        const code = transform(source, { filename: "main.tsx", generate: "universal", moduleName: STRING_RENDERER }).code.replaceAll('"./api"', '"./api.mjs"');
        writeFileSync(output + "/" + entry, code.replaceAll(STRING_RENDERER, renderer));
      } else {
        const inputs: Record<string, string> = { "main.tsx": source, "api.d.rx": declarations };
        const built = buildTsx("main.tsx", path => inputs[path], { target: "universal", mount: "Counter" });
        entry = built.entry;
        for (const [path, code] of built.files) writeFileSync(output + "/" + path, code.replaceAll(STRING_RENDERER, renderer));
      }
      const module = await import(pathToFileURL(output + "/" + entry).href);
      const app = createApp({ api: { fetch } });
      const dispose = app.mount(native ? () => module.Counter() : module.default(app));
      try {
        await settle();
        const frames = [app.frame()];
        for (const step of steps) {
          if ("click" in step) {
            const handler = buttons(app.root)[step.click]?.props.onClick;
            assert.equal(typeof handler, "function", name + " must use the authored handler"); handler();
          } else {
            const request = requests.get(step.land)?.find(entry => !entry.landed);
            assert.ok(request, name + " must have an unsettled fetch(" + JSON.stringify(step.land) + ")");
            request.landed = true; request.resolve(step.value);
          }
          await settle(); frames.push(app.frame());
          assert.equal(frames.at(-1), expected[frames.length - 1], name + " instant " + (frames.length - 1));
        }
        assert.deepEqual(frames, expected, name);
        assert.deepEqual(Object.fromEntries([...requests].map(([key, entries]) => [key, entries.length])), calls, name + " actual fetch calls");
        traces.push(frames);
      } finally { dispose(); }
    }
    for (const [name, source] of compiledSources) {
      const inputs: Record<string, string> = { "main.tsx": source, "api.d.rx": declarations };
      const built = buildTsx("main.tsx", path => inputs[path], { target: "universal", mount: "Counter" });
      const runtime = new Runtime(built.set);
      const frames = [runtime.step([]).at(-1)!.frame];
      for (const step of steps) {
        if ("click" in step) {
          const node = interpretedButtons(runtime.view.items)[step.click]?.attrs.find((attr: any) => attr.name === "onClick")?.node;
          assert.ok(node, "interpreter must expose the authored button handler");
          const handler = node.compute(runtime); assert.equal(typeof handler, "function"); handler();
          frames.push(runtime.handler([]).at(-1)!.frame);
        } else frames.push(runtime.land(JSON.stringify(step.land), step.value).at(-1)!.frame);
        assert.equal(frames.at(-1), expected[frames.length - 1], "interpreter " + name + " instant " + (frames.length - 1));
      }
      assert.deepEqual(frames, expected, "interpreter " + name);
      for (const trace of traces) assert.deepEqual(frames, trace, "all backends must match the full native trace");
    }
  } finally { delete (globalThis as any).__asyncControlFetch; rmSync(dir, { recursive: true, force: true }); }
}

const deferredView = 'return <Errored fallback={error => <p>failed</p>}><Loading fallback={<span></span>}><button onClick={() => setPeriod(period() + 1)}>Period {period()} fast {fast()} {isPending(() => fast()) ? "true" : "false"} slow {slow()} {isPending(() => slow()) ? "true" : "false"}</button></Loading></Errored>; }';
const deferredStart = imports + "export function Counter() { const [period, setPeriod] = createSignal(1); ";
const deferredDirect = deferredStart + 'const fast = createDeferred(async (): Promise<number> => await fetch("f:" + period())); const slow = createDeferred(async (): Promise<number> => await fetch("s:" + period())); ' + deferredView;
const deferredComposed = deferredStart + 'const fastQuestion = createMemo(async (): Promise<number> => await fetch("f:" + period())); const slowQuestion = createMemo(async (): Promise<number> => await fetch("s:" + period())); const fast = createDeferred(() => fastQuestion()); const slow = createDeferred(() => slowQuestion()); ' + deferredView;

test("S-solid-41 async deferred questions block initially, then land independently with live pending probes", async () => {
  await differential([["native-direct", deferredDirect], ["native-composed", deferredComposed]], [["compiled-direct", deferredDirect], ["compiled-composed", deferredComposed]], "export pure fn fetch(key: string): number", [
    { land: "f:1", value: 1 }, { land: "s:1", value: 1 }, { click: 0 },
    { land: "f:2", value: 2 }, { land: "s:2", value: 2 }, { click: 0 },
    { land: "s:3", value: 30 }, { land: "f:3", value: 3 },
  ], [
    "", "", "Period 1 fast 1 false slow 1 false", "Period 2 fast 1 true slow 1 true",
    "Period 2 fast 2 false slow 1 true", "Period 2 fast 2 false slow 2 false", "Period 3 fast 2 true slow 2 true",
    "Period 3 fast 2 true slow 30 false", "Period 3 fast 3 false slow 30 false",
  ], { "f:1": 1, "s:1": 1, "f:2": 1, "s:2": 1, "f:3": 1, "s:3": 1 });
});

const reloadBody = 'try { affects(user); refresh(user); yield fetch("gate"); } catch (error) {}';
const refreshSource = imports + 'export function Counter() { const [id, setId] = createSignal(1); const user = createMemo(async (): Promise<{ name: string }> => await fetch("u:" + id())); const reload = action(function*() { ' + reloadBody + ' }); return <Errored fallback={error => <p>failed</p>}><Loading fallback={<p>loading</p>}><div><p>{user().name} {isPending(() => user()) ? "updating" : ""}</p><button onClick={() => setId(id() + 1)}></button><button onClick={() => refresh(user)}></button><button onClick={() => reload()}></button></div></Loading></Errored>; }';
const refreshInline = refreshSource.replace("const reload = action(function*() { " + reloadBody + " }); ", "").replace("onClick={() => reload()}", "onClick={() => action(function*() { " + reloadBody + " })()}");

test("S-solid-26 quiet refresh stays quiet; affects holds an early reask landing until the gate commits", async () => {
  await differential([["native-named-action", refreshSource], ["native-inline-action", refreshInline]], [["compiled-named-action", refreshSource], ["compiled-inline-action", refreshInline]], "export pure fn fetch(key: string): { name: string }", [
    { land: "u:1", value: { name: "Ann" } }, { click: 0 }, { land: "u:2", value: { name: "Bob" } },
    { click: 1 }, { land: "u:2", value: { name: "Bob2" } }, { click: 2 },
    { land: "u:2", value: { name: "Bob3" } }, { land: "gate", value: 0 },
  ], ["loading", "Ann ", "Ann updating", "Bob ", "Bob ", "Bob2 ", "Bob2 updating", "Bob2 updating", "Bob3 "],
  { "u:1": 1, "u:2": 3, gate: 1 });
});
