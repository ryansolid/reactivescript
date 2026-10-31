// First executable milestone of the moving-foundation layout: an authored TSX counter and an authored RX counter,
// both default-component entries (MO-1c), lowered/parsed onto the pinned upstream Program and checker. They must have the
// same canonical semantic facts (tsx/rx/facts.ts) and the same interpreter, compiled and native frames. No RX import,
// raw AST or shared constructor stands in for the TSX side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { loadTsxModules } from "./modules.ts";
import { semanticFacts } from "./rx/facts.ts";
import { compileModules, lowerViews, STRING_RENDERER, type ModuleSet } from "./rx/compiler.ts";
import { createApp, flush, Runtime } from "./rx/runtime.ts";

const fixture = (name: string) => readFileSync(new URL("./fixtures/paired/" + name, import.meta.url), "utf8");
const load = (name: string): ModuleSet => {
  const files: Record<string, string> = { [name]: fixture(name) };
  const set = loadTsxModules(name, path => files[path]);
  assert.deepEqual(set.diags, [], name + " loads");
  return set;
};
const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
const outRoot = fileURLToPath(new URL("../.out/", import.meta.url));
const buttons = (node: any): any[] => node?.tag === "button" ? [node] : (node?.children ?? []).flatMap(buttons);
const CLICKS = 2;

function interpreted(set: ModuleSet): string[] {
  const rt = new Runtime(set);
  const frames = [rt.step([]).at(-1)!.frame];
  const find = (items: any[]): any => {
    for (const item of items) {
      if (item.k === "el" && item.tag === "button") return item;
      const hit = find(item.children ?? item.inst?.items ?? []);
      if (hit) return hit;
    }
  };
  for (let i = 0; i < CLICKS; i++) {
    const handler = find(rt.view.items)?.attrs.find((a: any) => a.name === "onClick")?.node;
    assert.ok(handler, "the interpreter exposes the authored handler");
    handler.compute(rt)();
    frames.push(rt.handler([]).at(-1)!.frame);
  }
  return frames;
}

async function rendered(files: Map<string, string>, entry: string, mountOf: (mod: any, app: any) => unknown): Promise<string[]> {
  mkdirSync(outRoot, { recursive: true });
  const dir = mkdtempSync(outRoot + "paired-");
  try {
    for (const [name, code] of files) writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
    const mod = await import(pathToFileURL(dir + "/" + entry).href);
    const app = createApp();
    const dispose = app.mount(mountOf(mod, app));
    try {
      flush();
      const frames = [app.frame()];
      for (let i = 0; i < CLICKS; i++) {
        const [button] = buttons(app.root);
        assert.equal(typeof button?.props.onClick, "function", "the authored handler is rendered");
        button.props.onClick();
        flush();
        frames.push(app.frame());
      }
      return frames;
    } finally { dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const compiled = (set: ModuleSet) => {
  const built = compileModules(set);
  return rendered(lowerViews(built.files, "universal"), built.entry, (mod, app) => mod.default(app));
};

test("paired counter: TSX and RX have the same canonical semantic facts", () => {
  const tsx = semanticFacts(load("counter.tsx"));
  const rx = semanticFacts(load("counter.rx"));
  assert.deepEqual(tsx.diagnostics, []);
  assert.ok(tsx.modules[0].computations.some(c => c.kind === "memo" && c.reads.some(r => r.includes("count tracked"))), "the memo tracks count");
  assert.ok(tsx.modules[0].computations.some(c => c.kind === "handler" && c.writes.some(w => w.includes("count write"))), "the handler writes count");
  assert.deepEqual(tsx, rx);
});

test("paired counter: a different read mode is a fact difference, not normalized away", () => {
  assert.notDeepEqual(semanticFacts(load("counter.tsx")), semanticFacts(load("counter-peek.rx")));
});

test("paired counter: interpreter, compiled and native frames agree", async () => {
  const expected = ["0", "2", "4"];
  const native = await rendered(
    new Map([["native.mjs", transform(fixture("counter.tsx"), { filename: "counter.tsx", generate: "universal", moduleName: STRING_RENDERER }).code]]),
    "native.mjs", mod => () => mod.default());
  assert.deepEqual(native, expected, "native Solid");
  for (const name of ["counter.tsx", "counter.rx"]) {
    const set = load(name);
    assert.deepEqual(interpreted(set), expected, name + " interpreter");
    assert.deepEqual(await compiled(set), expected, name + " compiled");
  }
});
