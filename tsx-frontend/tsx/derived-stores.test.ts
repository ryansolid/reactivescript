import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { buildTsx } from "./build.ts";
import { loadModules, type ModuleSet } from "./rx/compiler.ts";
import { checkModules } from "./rx/compiler.ts";
import { CheckError } from "./rx/compiler.ts";
import { Runtime } from "./rx/runtime.ts";
import { compileModules } from "./rx/compiler.ts";
import { lowerViews, STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";

type Step = { click: number } | { land: string; value: unknown };
const declarations = `export pure fn fetchState(id: number): { a: number; b: number }
export pure fn gate(key: string): number`;
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    flush();
  }
};
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

async function differential(t: TestContext, source: string, rx: string, steps: Step[], expected: string[],
  calls: Record<string, number> = {}, nativeAlternatives: [string, string][] = [], refusedTsx?: RegExp) {
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "tsx-derived-stores-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  const traces: string[][] = [];
  const rendered = async (name: string, entry: string, files: Map<string, string>, native = false) => {
    const output = dir + "/" + name;
    mkdirSync(output);
    writeFileSync(output + "/api.mjs", `
export const fetchState = id => globalThis.__tsxDerivedStoreApi("fetchState", id);
export const gate = key => globalThis.__tsxDerivedStoreApi("gate", key);`);
    for (const [path, code] of files) writeFileSync(output + "/" + path, code.replaceAll(STRING_RENDERER, renderer));
    const requests = new Map<string, { resolve: (value: unknown) => void; landed: boolean }[]>();
    const ask = (name: string, arg: unknown) => new Promise(resolve => {
      const key = name + ":" + arg;
      let entries = requests.get(key);
      if (!entries) requests.set(key, (entries = []));
      entries.push({ resolve, landed: false });
    });
    (globalThis as any).__tsxDerivedStoreApi = ask;
    const module = await import(pathToFileURL(output + "/" + entry).href);
    const app = createApp({ api: { fetchState: id => ask("fetchState", id), gate: key => ask("gate", key) } });
    const dispose = app.mount(native ? () => module.Counter() : module.default(app));
    try {
      await settle();
      const frames = [app.frame()];
      assert.equal(frames[0], expected[0], name + " mount");
      for (const step of steps) {
        if ("click" in step) {
          const callback = buttons(app.root)[step.click]?.props.onClick;
          assert.equal(typeof callback, "function", "invoke the actual authored button handler");
          callback();
        } else {
          const request = requests.get(step.land)?.find(request => !request.landed);
          assert.ok(request, name + " must have asked " + step.land);
          request.landed = true;
          request.resolve(structuredClone(step.value));
        }
        await settle();
        frames.push(app.frame());
        assert.equal(frames.at(-1), expected[frames.length - 1], name + " instant " + (frames.length - 1));
      }
      assert.deepEqual(frames, expected, name);
      assert.deepEqual(Object.fromEntries([...requests].map(([key, entries]) => [key, entries.length])), calls, name + " actual API calls");
      traces.push(frames);
    } finally { dispose(); }
  };
  const interpreted = (name: string, set: ModuleSet) => {
    const runtime = new Runtime(set);
    try {
      const frames = [runtime.step([]).at(-1)!.frame];
      assert.equal(frames[0], expected[0], name + " mount");
      for (const step of steps) {
        if ("click" in step) {
          const node = interpretedButtons(runtime.view.items)[step.click]?.attrs.find((attr: any) => attr.name === "onClick")?.node;
          assert.ok(node, "interpreter must expose the actual authored handler");
          const callback = node.compute(runtime);
          assert.equal(typeof callback, "function");
          callback();
          frames.push(runtime.handler([]).at(-1)!.frame);
        } else frames.push(runtime.land(JSON.stringify(step.land), structuredClone(step.value)).at(-1)!.frame);
        assert.equal(frames.at(-1), expected[frames.length - 1], name + " instant " + (frames.length - 1));
      }
      assert.deepEqual(frames, expected, name);
      for (const trace of traces) assert.deepEqual(frames, trace, "all backends must match the full native trace");
    } finally { runtime.root.dispose(); }
  };
  try {
    let nativesProven = 0;
    for (const [name, nativeSource] of [["native Solid", source], ...nativeAlternatives]) {
      await t.test(name, async () => {
        const code = transform(nativeSource, { filename: "Counter.tsx", generate: "universal", moduleName: STRING_RENDERER }).code
          .replaceAll('"./api"', '"./api.mjs"');
        await rendered("native-" + traces.length, "native.mts", new Map([["native.mts", code]]), true);
        nativesProven++;
      });
    }
    assert.equal(nativesProven, nativeAlternatives.length + 1, "prove native expectations before checking RX or TSX");
    const inputs: Record<string, string> = { "main.rx": rx, "main.tsx": source, "api.d.rx": declarations };
    const handwritten = loadModules("main.rx", path => inputs[path]);
    assert.deepEqual(handwritten.diags, []);
    assert.deepEqual(checkModules(handwritten).diags, []);
    await t.test("compiled handwritten RX", async () => {
      const compiled = compileModules(handwritten);
      await rendered("handwritten", compiled.entry, lowerViews(compiled.files, "universal"));
    });
    await t.test("interpreted handwritten RX", () => interpreted("handwritten RX", handwritten));
    await t.test("compiled authored TSX", async () => {
      // A TSX spelling with no faithful RX lowering at the pin must be refused, while native and RX legs still run.
      if (refusedTsx) return assert.throws(() => buildTsx("main.tsx", path => inputs[path], { target: "universal", mount: "Counter" }), refusedTsx);
      const built = buildTsx("main.tsx", path => inputs[path], { target: "universal", mount: "Counter" });
      await rendered("authored", built.entry, built.files);
    });
    await t.test("interpreted authored TSX", () => {
      if (refusedTsx) return assert.throws(() => buildTsx("main.tsx", path => inputs[path], { target: "universal", mount: "Counter" }), refusedTsx);
      const built = buildTsx("main.tsx", path => inputs[path], { target: "universal", mount: "Counter" });
      interpreted("authored TSX", built.set);
    });
  } finally {
    delete (globalThis as any).__tsxDerivedStoreApi;
    rmSync(dir, { recursive: true, force: true });
  }
}

const asyncSource = `import { createSignal, createStore, action, refresh, isPending, latest, Loading, Errored } from "solid-js";
import { fetchState, gate } from "./api";
export function Counter() {
  const [id, setId] = createSignal(1);
  const [state, setState] = createStore(async (): Promise<{ a: number; b: number }> => await fetchState(id()));
  const patch = action(function*() {
    try { setState(d => { d.a = 5; }); yield gate("w"); } catch (error) {}
  });
  return <Errored fallback={error => <p>failed</p>}><Loading fallback={<p>loading</p>}><div>
    <p>{state.a} {state.b} {isPending(() => state.a) ? "a!" : "-"} {isPending(() => state.b) ? "b!" : "-"}|{latest(() => state.a)}/{latest(() => state.b)}</p>
    <button onClick={() => setId(id() + 1)}></button>
    <button onClick={() => refresh(state)}></button>
    <button onClick={() => patch()}></button>
    <button onClick={() => setState(d => { d.b = 8; })}></button>
  </div></Loading></Errored>;
}`;
const asyncRx = `import { fetchState, gate } from "./api";
source id := 1;
source state = await fetchState(id);
action patch() { try { state.a := 5; await gate("w"); } catch {} }
export default component App() { errored fallback(error) { <p>failed</p> } {
  {loading fallback { <p>loading</p> } { <div>
    <p>{state.a} {state.b} {pending? state.a ? "a!" : "-"} {pending? state.b ? "b!" : "-"}|{latest state.a}/{latest state.b}</p>
    <button onClick={() => { id := id + 1; }}></button>
    <button onClick={() => { refresh state; }}></button>
    <button onClick={() => { patch(); }}></button>
    <button onClick={() => { state.b := 8; }}></button>
  </div> }}
} }`;

test("S-solid-37 seedless derived stores suspend initially, re-ask by id and refresh quietly", t =>
  differential(t, asyncSource, asyncRx, [
    { land: "fetchState:1", value: { a: 1, b: 1 } }, { click: 0 },
    { land: "fetchState:2", value: { a: 2, b: 2 } }, { click: 1 },
    { land: "fetchState:2", value: { a: 3, b: 3 } },
  ], [
    "loading", "1 1 - -|1/1", "1 1 a! b!|1/1", "2 2 - -|2/2", "2 2 - -|2/2", "3 3 - -|3/3",
  ], { "fetchState:1": 1, "fetchState:2": 2 }, [
    ["native Solid explicit null seed", asyncSource.replace("await fetchState(id()))", "await fetchState(id()), null)")],
  ]));

test("S-solid-37 held path writes pend only their key and latest sees the uncommitted path", t =>
  differential(t, asyncSource, asyncRx, [
    { land: "fetchState:1", value: { a: 1, b: 1 } }, { click: 2 },
    { land: "gate:w", value: 0 }, { click: 3 }, { click: 0 },
    { land: "fetchState:2", value: { a: 2, b: 2 } },
  ], [
    "loading", "1 1 - -|1/1", "1 1 a! -|5/1", "5 1 - -|5/1", "5 8 - -|5/8", "5 8 a! b!|5/8", "2 2 - -|2/2",
  ], { "fetchState:1": 1, "gate:w": 1, "fetchState:2": 1 }));

test("sync derived stores retain manual paths until an input changes, with stable root and captured nested aliases", t =>
  differential(t, `import { createSignal, createStore, untrack } from "solid-js";
export function Counter() {
  const [id, setId] = createSignal(1);
  const [tick, setTick] = createSignal(0);
  const [state, setState] = createStore((): { a: number; b: number; nested: { value: number } } => ({ a: id(), b: id() * 10, nested: { value: id() } }));
  const alias = state;
  const nested = untrack(() => state.nested);
  return <div><p>{state.a}/{state.b}|{alias.a}/{alias.b}|{state.nested.value}/{nested.value}|{tick()}</p>
    <button onClick={() => setState(d => { d.a = 5; })}></button>
    <button onClick={() => setTick(tick() + 1)}></button>
    <button onClick={() => setId(id() + 1)}></button>
    <button onClick={() => setState(d => { d.nested.value = 9; })}></button>
  </div>;
}`, `source id := 1; source tick := 0;
source state = { a: id, b: id * 10, nested: { value: id } };
alias = state;
nested = state.nested;
export default component App() { <div><p>{state.a}/{state.b}|{alias.a}/{alias.b}|{state.nested.value}/{nested.value}|{tick}</p>
  <button onClick={() => { state.a := 5; }}></button>
  <button onClick={() => { tick := tick + 1; }}></button>
  <button onClick={() => { id := id + 1; }}></button>
  <button onClick={() => { state.nested.value := 9; }}></button>
</div> }`, [
    { click: 0 }, { click: 1 }, { click: 2 }, { click: 3 }, { click: 1 }, { click: 2 },
  ], [
    "1/10|1/10|1/1|0", "5/10|5/10|1/1|0", "5/10|5/10|1/1|1", "2/20|2/20|2/2|1",
    "2/20|2/20|9/9|1", "2/20|2/20|9/9|2", "3/30|3/30|3/3|2",
    // `untrack(() => state.nested)` returns Solid's live nested proxy; the pinned RX has only a value snapshot (peek),
    // so the authored TSX is refused (README: semantic limits). The handwritten RX spells the alias as an equation.
  ], {}, [], /untrack of a structured (value of a derived or computed store|store value that is later written inside) is unsupported/));

test("read-only derived stores keep a live root alias without path writers or pending probes", t =>
  differential(t, `import { createSignal, createStore } from "solid-js";
export function Counter() {
  const [id, setId] = createSignal(1);
  const [state, setState] = createStore((): { a: number; b: number } => ({ a: id(), b: id() * 10 }));
  const alias = state;
  return <div><p>{state.a}/{state.b}|{alias.a}/{alias.b}</p>
    <button onClick={() => setId(id() + 1)}></button>
  </div>;
}`, `source id := 1;
source state = { a: id, b: id * 10 };
alias = state;
export default component App() { <div><p>{state.a}/{state.b}|{alias.a}/{alias.b}</p>
  <button onClick={() => { id := id + 1; }}></button>
</div> }`, [{ click: 0 }, { click: 0 }], [
    "1/10|1/10", "2/20|2/20", "3/30|3/30",
  ]));

test("derived store result annotations do not invent purity for an imported loader", () => {
  const build = (contract: string) => buildTsx("main.tsx", path => path === "main.tsx" ? asyncSource
    : path === "api.d.rx" ? contract : undefined, { target: "universal", mount: "Counter" });
  assert.doesNotThrow(() => build(declarations));
  assert.throws(() => build(declarations.replace("export pure fn fetchState", "export fn fetchState")),
    (error: unknown) => error instanceof CheckError && error.diagnostics.some(diagnostic => diagnostic.code === "IO_IN_REACTIVE"));
});
