import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadTsxModules } from "./modules.ts";
import { checkModules } from "./rx/compiler.ts";
import { compileModules } from "./rx/compiler.ts";
import { lowerViews, STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";
import { Runtime } from "./rx/runtime.ts";
import type { ModuleSet } from "./rx/compiler.ts";

const tsxParent = 'import { createSignal } from "solid-js"; import { Button as Child } from "./Button.EXT"; export function Counter() { const [count, setCount] = createSignal(0); return <Child value={count()} onIncrement={() => setCount(count() + 1)} />; }';
const rxParent = 'import { Button as Child } from "./Button.EXT"; export component Counter() { source count := 0; <Child value={count} onIncrement={() => { count := count + 1 }} /> }';
const tsxChild = 'export function Button(props: { value: number; onIncrement: () => void }) { return <button onClick={() => props.onIncrement()}>{props.value}</button>; }';
const rxChild = 'export component Button(props: { value: number; onIncrement: action catches(nothing) }) { <button onClick={() => { props.onIncrement(); }}>{"" + props.value}</button> }';

function load(files: Record<string, string>, entry = "main.tsx") {
  return loadTsxModules(entry, path => files[path]);
}

function mount(set: ModuleSet) {
  const entry = set.programs.get(set.entry)!;
  entry.view = [{ k: "el", tag: "Counter", attrs: [], children: [] }];
  return set;
}

async function trace(set: ModuleSet, expected = ["0", "1", "2", "3"]) {
  assert.deepEqual(checkModules(set).diags, []);
  const rt = new Runtime(set);
  const interpreted = [rt.step([]).at(-1)!.frame];
  const findButton = (items: any[]): any => {
    for (const item of items) {
      if (item.k === "el" && item.tag === "button") return item;
      const found = findButton(item.children ?? item.inst?.items ?? item.committed?.inst?.items ?? []);
      if (found) return found;
    }
  };
  for (let i = 1; i < expected.length; i++) {
    const handler = findButton(rt.view.items)?.attrs.find((a: any) => a.name === "onClick").node;
    assert.ok(handler, "the interpreter must expose the authored module handler");
    handler.compute(rt)();
    interpreted.push(rt.handler([]).at(-1)!.frame);
  }
  assert.deepEqual(interpreted, expected, "interpreter");
  const built = compileModules(set);
  const files = lowerViews(built.files, "universal");
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "tsx-modules-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  try {
    for (const [name, text] of files) writeFileSync(dir + "/" + name, text.replaceAll(STRING_RENDERER, renderer));
    const module = await import(pathToFileURL(dir + "/" + built.entry).href);
    const app = createApp();
    const dispose = app.mount(module.default(app));
    try {
      flush();
      const frames = [app.frame()];
      const button = (node: any): any => node.tag === "button" ? node : node.children?.map(button).find(Boolean);
      for (let i = 1; i < expected.length; i++) { button(app.root).props.onClick(); flush(); frames.push(app.frame()); }
      assert.deepEqual(frames, expected);
    } finally { dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const [parentExt, childExt] of [["tsx", "tsx"], ["tsx", "rx"], ["rx", "tsx"], ["rx", "rx"]]) {
  test(parentExt + " imports " + childExt + ": aliases, live props and callbacks cross module factories", async () => {
    const parent = (parentExt === "tsx" ? tsxParent : rxParent).replace(".EXT", "." + childExt);
    const set = load({ ["main." + parentExt]: parent, ["Button." + childExt]: childExt === "tsx" ? tsxChild : rxChild }, "main." + parentExt);
    assert.deepEqual(set.order, ["Button." + childExt, "main." + parentExt]);
    assert.deepEqual(set.programs.get(set.entry)!.view, [], "exports are not implicit mounts");
    await trace(mount(set));
  });
}

test("a diamond reads and lowers each module once", () => {
  const files: Record<string, string> = {
    "main.rx": 'import { Left } from "./left.rx"; import { Right } from "./right.rx"; export default component App() { <Left/><Right/> }',
    "left.rx": 'import { Shared } from "./shared.tsx"; export component Left() { <Shared/> }',
    "right.rx": 'import { Shared } from "./shared.tsx"; export component Right() { <Shared/> }',
    "shared.tsx": 'export function Shared() { return <p>shared</p>; }',
  };
  const reads = new Map<string, number>();
  const set = loadTsxModules("main.rx", path => { reads.set(path, (reads.get(path) ?? 0) + 1); return files[path]; });
  assert.deepEqual(checkModules(set).diags, []);
  assert.equal(reads.get("shared.tsx"), 1);
  assert.deepEqual(set.order, ["shared.tsx", "left.rx", "right.rx", "main.rx"]);
  assert.equal(new Runtime(set).step([]).at(-1)!.frame, "sharedshared");
});

test("missing entry is a loader diagnostic, not an empty successful build", () => {
  const set = load({});
  assert.equal(set.diags[0].code, "MODULE_NOT_FOUND");
  assert.equal(set.diags[0].file, "main.tsx");
});

test("missing imports retain the importing filename and line", () => {
  const set = load({ "main.tsx": 'import { Child } from "./missing.rx"; export function Counter() { return <Child/>; }' });
  assert.equal(set.diags[0].code, "MODULE_NOT_FOUND");
  assert.equal(set.diags[0].file, "main.tsx");
  assert.equal(set.diags[0].line, 1);
});

test("mixed-language cycles are rejected before lowering incomplete imports", () => {
  const set = load({
    "main.tsx": 'import { Child } from "./child.rx"; export function Counter() { return <Child/>; }',
    "child.rx": 'import { Counter } from "./main.tsx"; export component Child() { <Counter/> }',
  });
  assert.equal(set.diags[0].code, "MODULE_CYCLE");
  assert.match(set.diags[0].msg, /main.tsx.*child.rx.*main.tsx/);
});

test("RX declaration files retain JS purity contracts in a mixed graph", () => {
  const set = load({
    "main.rx": 'import { f } from "./api"; answer = f(1); export default component App() { <p>{answer}</p> }',
    "api.d.rx": 'export pure fn f(value: number): number',
  }, "main.rx");
  assert.equal(set.declarations?.size, 1);
  assert.deepEqual(checkModules(set).diags, []);
});

test("module paths normalize without guessing extensions", () => {
  const set = load({
    "main.rx": 'import { Shared } from "./folder/../shared.tsx"; export default component App() { <Shared/> }',
    "shared.tsx": 'export function Shared() { return <p>ok</p>; }',
  }, "./main.rx");
  assert.equal(set.entry, "main.rx");
  assert.deepEqual(checkModules(set).diags, []);
});

test("a shared missing dependency cannot accidentally lower a second incomplete importer", () => {
  const set = load({
    "main.rx": 'import { Left } from "./left.rx"; import { Right } from "./right.rx"; export default component App() { <Left/><Right/> }',
    "left.rx": 'import { Shared } from "./shared.rx"; export component Left() { <Shared/> }',
    "right.rx": 'import { Shared } from "./shared.rx"; export component Right() { <Shared/> }',
    "shared.rx": 'import { Missing } from "./missing.rx"; export component Shared() { <Missing/> }',
  }, "main.rx");
  assert.equal(set.diags[0].code, "MODULE_NOT_FOUND");
  assert.equal(set.diags[0].file, "shared.rx");
  assert.equal(set.programs.has("main.rx"), false);
});

test("unknown RX imports are still checked against exported signatures", () => {
  const set = load({ "main.rx": 'import { Hidden } from "./child.rx"; export default component App() { <p>ok</p> }', "child.rx": 'component Hidden() { <p>hidden</p> }' }, "main.rx");
  assert.ok(checkModules(set).diags.some(d => d.code === "NOT_EXPORTED"));
});

test("importing a source does not permit writing through the module boundary", () => {
  const set = load({ "main.rx": 'import { value } from "./child.rx"; export default component App() { <button onClick={() => { value := 1 }}>{value}</button> }', "child.rx": 'export source value := 0' }, "main.rx");
  assert.ok(checkModules(set).diags.some(d => d.code === "WRITE_TO_NON_SOURCE" && d.rule === "MO-2"));
});

test("JS declaration contracts do not silently make a dirty TSX import pure", () => {
  const set = load({
    "main.tsx": 'import { createMemo } from "solid-js"; import { request as fetchValue } from "./api"; export function Counter() { const result = createMemo(async (): Promise<number> => await fetchValue(1)); return <p>{result()}</p>; }',
    "api.d.rx": 'export fn request(n: number): number',
  });
  assert.ok(checkModules(mount(set)).diags.some(d => d.code === "IO_IN_REACTIVE"));
});

test("an RX component's failure contract remains checked at a TSX application", () => {
  const set = load({
    "main.tsx": 'import { Reader } from "./reader.rx"; export function Counter() { return <Reader/>; }',
    "reader.rx": 'import pure { request } from "./api"; value = await request(1); export component Reader() { <p>{value}</p> }',
  });
  assert.ok(checkModules(mount(set)).diags.some(d => d.code === "UNHANDLED_FAILURE" && d.file === "main.tsx"));
});

for (const contextSyntax of ["tsx", "rx"]) for (const readerSyntax of ["tsx", "rx"]) {
  test(contextSyntax + " context identity survives aliases in a " + readerSyntax + " reader", async () => {
    const main = 'import { createSignal } from "solid-js"; import { Theme as Current } from "./context.' + contextSyntax + '"; import { Button as Reader } from "./reader.' + readerSyntax + '"; export function Counter() { const [n,setN] = createSignal(0); return <Current value={n()}><Reader onIncrement={() => setN(n()+1)}/></Current>; }';
    const context = contextSyntax === "tsx"
      ? 'import { createContext } from "solid-js"; export const Theme = createContext(7);'
      : 'export context Theme: number = 7';
    const reader = readerSyntax === "tsx"
      ? 'import { useContext } from "solid-js"; import { Theme as ReadTheme } from "./context.' + contextSyntax + '"; export function Button(props: {onIncrement: () => void}) { const theme = useContext(ReadTheme); return <button onClick={() => props.onIncrement()}>{theme}</button>; }'
      : 'import { Theme as ReadTheme } from "./context.' + contextSyntax + '"; export component Button(props: {onIncrement: action catches(nothing)}) { value = use ReadTheme; <button onClick={() => { props.onIncrement(); }}>{"" + value}</button> }';
    const set = load({ "main.tsx": main, ["context." + contextSyntax]: context, ["reader." + readerSyntax]: reader });
    await trace(mount(set), ["0", "0", "0", "0"]);
  });
}

for (const contextSyntax of ["tsx", "rx"]) for (const readerSyntax of ["tsx", "rx"]) {
  test(contextSyntax + " source-context writes cross aliases in a " + readerSyntax + " reader", async () => {
    const main = 'import { createSignal } from "solid-js"; import { Count as Current } from "./context.' + contextSyntax + '"; import { Reader } from "./reader.' + readerSyntax + '"; export function Counter() { const [count,setCount] = createSignal(0); return <Current value={[count,setCount]}><Reader/></Current>; }';
    const context = contextSyntax === "tsx"
      ? 'import { createSourceContext } from "reactivescript-tsx"; export const Count = createSourceContext<number>();'
      : 'export context Count: source number';
    const reader = readerSyntax === "tsx"
      ? 'import { useSourceContext } from "reactivescript-tsx"; import { Count as Current } from "./context.' + contextSyntax + '"; export function Reader() { const [count,setCount] = useSourceContext(Current); return <button onClick={() => setCount(count()+1)}>{count()}</button>; }'
      : 'import { Count as Current } from "./context.' + contextSyntax + '"; export component Reader() { <button onClick={() => { use Current := use Current + 1 }}>{"" + use Current}</button> }';
    await trace(mount(load({ "main.tsx": main, ["context." + contextSyntax]: context, ["reader." + readerSyntax]: reader })));
  });
}
