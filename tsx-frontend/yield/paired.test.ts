// solid-yield's explicit generator dialect, as a syntax, as a third frontend (spike; docs/YIELD.md). The counter and
// the issue tracker are written in that dialect (yield/fixtures/*.yield.tsx) and lowered by yield/lower.ts directly
// onto the pinned RX AST. The reference is the same as the TSX frontend's: the handwritten RX and its backends, and
// native Solid running the paired TSX fixture. A yield fixture is accepted only if its canonical facts equal the
// handwritten RX's and the TSX twin's, a fact change is detected, and its exact frames match on compiled and
// interpreted RX (from yield and handwritten) and on native Solid (the TSX twin).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { loadTsxModules } from "../tsx/modules.ts";
import { semanticFacts } from "../tsx/rx/facts.ts";
import { actionInference } from "../tsx/rx/infer.ts";
import { checkModules, compileModules, lowerViews, STRING_RENDERER, type ModuleSet } from "../tsx/rx/compiler.ts";
import { createApp, flush, Runtime } from "../tsx/rx/runtime.ts";
import { loadYieldModules, YieldError } from "./lower.ts";

const fixture = (name: string) => readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
const API: Record<string, string> = { "api.d.rx": "export fn assignIssue(id: number): string" };
const checked = (set: ModuleSet, name: string) => {
  assert.deepEqual(set.diags, [], name + " loads");
  assert.deepEqual(checkModules(set).diags, [], name + " checks");
  return set;
};
const fromYield = (name: string) => checked(loadYieldModules(name + ".tsx", p => (p === name + ".tsx" ? fixture(name + ".yield.tsx") : API[p])), name + ".yield.tsx");
const load = (file: string, text = fixture(file)) => checked(loadTsxModules(file, p => (p === file ? text : API[p])), file);
const outRoot = fileURLToPath(new URL("../.out/", import.meta.url));
const renderer = fileURLToPath(new URL("../tsx/test-renderer.ts", import.meta.url));

/** Click the n-th button, or answer the assignment request for one issue. */
type Step = { click: number } | { answer: number; owner?: string; failure?: string };
const COUNTER: Step[] = [{ click: 0 }, { click: 0 }];
const TRACKER: Step[] = [
  { click: 1 }, { answer: 1, owner: "dev" }, { click: 2 }, { answer: 2, failure: "offline" },
  { click: 0 }, { click: 1 }, { answer: 3, owner: "dev" },
];
const settle = async () => { for (let i = 0; i < 3; i++) { await new Promise<void>(done => setImmediate(done)); flush(); } };
const answer = (app: ReturnType<typeof createApp>, s: Extract<Step, { answer: number }>) => {
  const f = app.flights.get("assignIssue:" + s.answer);
  assert.ok(f, "issue " + s.answer + " has an open request");
  if (s.failure) f.reject(new Error(s.failure)); else f.resolve(s.owner);
};

async function rendered(files: Map<string, string>, entry: string, native: boolean, script: Step[]): Promise<string[]> {
  mkdirSync(outRoot, { recursive: true });
  const dir = mkdtempSync(outRoot + "yield-");
  const app = createApp();
  // Native Solid imports ./api as plain JS; it reaches the same controllable flights as the compiled RX.
  (globalThis as any).__yieldAssignIssue = (...args: unknown[]) => (app.api("assignIssue")(...args) as any).first;
  try {
    for (const [n, c] of files) writeFileSync(dir + "/" + n, c.replaceAll(STRING_RENDERER, renderer));
    const mod = await import(pathToFileURL(dir + "/" + entry).href);
    const dispose = app.mount(native ? () => mod.default() : mod.default(app));
    const buttons = (node: any): any[] => node?.tag === "button" ? [node] : (node?.children ?? []).flatMap(buttons);
    try {
      await settle();
      const frames = [app.frame()];
      for (const s of script) {
        if ("click" in s) buttons(app.root)[s.click].props.onClick(); else answer(app, s);
        await settle();
        frames.push(app.frame());
      }
      return frames;
    } finally { dispose(); }
  } finally {
    delete (globalThis as any).__yieldAssignIssue;
    rmSync(dir, { recursive: true, force: true });
  }
}
const compiled = (set: ModuleSet, script: Step[]) => {
  const built = compileModules(set);
  return rendered(lowerViews(built.files, "universal"), built.entry, false, script);
};
const native = (name: string, script: Step[]) => rendered(new Map([["native.mts",
  transform(fixture(name + ".tsx"), { filename: name + ".tsx", generate: "universal", moduleName: STRING_RENDERER }).code
    .replaceAll('"./api"', '"data:text/javascript,export const assignIssue=(...args)=>globalThis.__yieldAssignIssue(...args)"')]]),
  "native.mts", true, script);

function interpreted(set: ModuleSet, script: Step[]): string[] {
  const rt = new Runtime(set);
  const frames = [rt.step([]).at(-1)!.frame];
  const found = (items: any[]): any[] => items.flatMap((item: any) => item.k === "el" && item.tag === "button" ? [item]
    : found(item.children ?? item.inst?.items ?? item.committed?.inst?.items ?? item.committedRows?.flatMap((r: any) => r.inst.items) ?? []));
  try {
    for (const s of script) {
      if ("click" in s) {
        found(rt.view.items)[s.click].attrs.find((a: any) => a.name === "onClick").node.compute(rt)();
        frames.push(rt.handler([]).at(-1)!.frame);
      } else frames.push(rt.land('"assignIssue:' + s.answer + '"', s.failure ? new Error(s.failure) : s.owner, !!s.failure).at(-1)!.frame);
    }
    return frames;
  } finally { rt.root.dispose(); }
}

for (const [name, script, expected] of [
  ["counter", COUNTER, ["0", "2", "4"]],
  ["tracker", TRACKER, [
    "Filter: all2 openCrash on save: nobodytakeSlow search: anatakeTypo in footer: nobodytake",
    "Filter: all2 openCrash on save: metakeSlow search: anatakeTypo in footer: nobodytake",
    "Filter: all1 openCrash on save: devtakeSlow search: anatakeTypo in footer: nobodytake",
    "Filter: all1 openCrash on save: devtakeSlow search: metakeTypo in footer: nobodytake",
    "Filter: all1 openCrash on save: devtakeSlow search: anatakeTypo in footer: nobodytakeCould not assign #2",
    "Filter: open1 openTypo in footer: nobodytakeCould not assign #2",
    "Filter: open1 openTypo in footer: metakeCould not assign #2",
    "Filter: open0 openNothing to triage",
  ]],
] as [string, Step[], string[]][]) {
  test("yield " + name + ": canonical facts equal the handwritten RX and the Solid TSX twin", () => {
    const facts = semanticFacts(fromYield(name));
    assert.deepEqual(facts.diagnostics, []);
    assert.ok(facts.modules.every(m => m.symbols.every(s => !s.includes("::action:"))), "events do not declare actions");
    assert.deepEqual(facts, semanticFacts(load(name + ".rx")));
    assert.deepEqual(facts, semanticFacts(load(name + ".tsx")));
  });
  test("yield " + name + ": snapshotting a read in the handwritten RX is a fact difference", () => {
    const rx = fixture(name + ".rx");
    const changed = name === "counter" ? rx.replace("doubled = count * 2", "doubled = peek(count) * 2")
      : rx.replace('issue => mode == "all"', 'issue => peek(mode) == "all"');
    assert.notEqual(changed, rx);
    assert.notDeepEqual(semanticFacts(fromYield(name)), semanticFacts(load(name + ".rx", changed)));
  });
  test("yield " + name + " frames: native Solid (the TSX twin)", async () => {
    assert.deepEqual(await native(name, script), expected);
  });
  test("yield " + name + " frames: compiled RX from yield", async () => {
    assert.deepEqual(await compiled(fromYield(name), script), expected);
  });
  test("yield " + name + " frames: interpreted RX from yield", () => {
    assert.deepEqual(interpreted(fromYield(name), script), expected);
  });
  test("yield " + name + " frames: compiled handwritten RX", async () => {
    assert.deepEqual(await compiled(load(name + ".rx"), script), expected);
  });
  test("yield " + name + " frames: interpreted handwritten RX", () => {
    assert.deepEqual(interpreted(load(name + ".rx"), script), expected);
  });
}

test("yield counter: facts also equal the original plain-handler TSX and handwritten RX counters", () => {
  const facts = semanticFacts(fromYield("counter"));
  for (const ext of ["tsx", "rx"]) {
    const plain = readFileSync(new URL("../tsx/fixtures/paired/counter." + ext, import.meta.url), "utf8");
    assert.deepEqual(facts, semanticFacts(load("counter." + ext, plain)), ext + " plain counter");
  }
});

test("yield callbacks: inferred optimistic and write+await handlers satisfy action catches props", () => {
  for (const optimistic of [true, false]) {
    const body = optimistic ? 'yield* setValue("now");' :
      'const owner = yield* attempt(() => assignIssue(1), function* () {}); if (owner !== undefined) { yield* setValue(owner); }';
    const source =
      'import { component, view, $signal, $optimistic, $event, attempt } from "solid-yield"; import { assignIssue } from "./api"; ' +
      'export default component(function* Parent() { const [value, setValue] = yield* ' + (optimistic ? '$optimistic' : '$signal') + '(""); ' +
      'const run = $event(function* () { ' + body + ' }); return view(function* () { return <>{yield* Child({ onRun: run })}</>; }); }); ' +
      'const Child = component(function* Child(props: Props<{ onRun: Handler<[]> }>) { ' +
      'const invoke = $event(function* () { yield* props.onRun(); }); return view(function* () { return <button onClick={yield* invoke}>go</button>; }); });';
    const set = checked(loadYieldModules("callback.tsx", p => p === "callback.tsx" ? source : API[p]), "inferred callback");
    const program = set.programs.get("callback.tsx")!;
    const parent = program.decls.find(d => d.k === "component" && d.name === "Parent");
    const child = program.decls.find(d => d.k === "component" && d.name === "Child");
    assert.ok(parent?.k === "component" && child?.k === "component");
    assert.ok(parent.decls.every(d => d.k !== "action"));
    const application = parent.view[0];
    assert.equal(application.k, "el");
    assert.ok(application.k === "el");
    const handler = application.attrs[0].e;
    assert.ok(handler.k === "fn" && handler.stmts);
    assert.ok(actionInference(handler.stmts).trigger, "RX infers this body as an action");
    child.propsType = "{ onRun: action catches(nothing) }";
    assert.deepEqual(checkModules(set).diags, [], "no declared action is needed for the callback prop");
  }
});

test("yield events: calling a local event calls its handler, not a declared action", async () => {
  const source = fixture("counter.yield.tsx")
    .replace('  return view(', '  const relay = $event(function* (count: number) { yield* increment(); });\n  const invoke = $event(function* () { yield* relay(99); });\n  return view(')
    .replace('onClick={yield* increment}', 'onClick={yield* invoke}');
  const set = checked(loadYieldModules("counter.tsx", () => source), "local event call");
  assert.deepEqual(await compiled(set, COUNTER), ["0", "2", "4"]);
  assert.deepEqual(interpreted(set, COUNTER), ["0", "2", "4"]);
});

test("yield events: row parameters cannot capture a handler's source reads", async () => {
  const source = fixture("counter.yield.tsx").replace('component,', 'For, component,')
    .replace('return <button onClick={yield* increment}>{yield* doubled}</button>;',
      'return <>{yield* For({ each: [0], children: function* (count) { return view(function* () { return <button onClick={yield* increment}>{yield* doubled}</button>; }); } })}</>;');
  const set = checked(loadYieldModules("counter.tsx", () => source), "row-bound event");
  assert.deepEqual(await compiled(set, COUNTER), ["0", "2", "4"]);
  assert.deepEqual(interpreted(set, COUNTER), ["0", "2", "4"]);
});

test("TSX inline action callbacks: bodies without an AC-1b trigger still need a named action", () => {
  const source = fixture("counter.tsx").replace('createMemo }', 'createMemo, action }')
    .replace('onClick={() => setCount(count() + 1)}', 'onClick={action(function* () { setCount(count() + 1); })}');
  assert.throws(() => loadTsxModules("counter.tsx", () => source), /Inline action callbacks need an AC-1b trigger/);
});

const counter = fixture("counter.yield.tsx");
const refused = (source: string, at: string, message: RegExp) => {
  assert.ok(source.includes(at), "the refusal site exists: " + at);
  assert.throws(() => loadYieldModules("main.tsx", p => (p === "main.tsx" ? source : API[p])), (error: unknown) => {
    assert.ok(error instanceof YieldError, String(error));
    assert.equal(error.start, source.indexOf(at), "refused at " + at + ": " + error.message);
    assert.match(error.message, message);
    return true;
  });
};
test("yield refusals: forms outside the subset, or that would behave differently from RX, are refused at their source", () => {
  refused(counter.replace("const increment = $event(", "const now = yield* count;\n  const increment = $event("), "yield* count;\n", /a setup never reads/);
  refused(counter.replace("yield* setCount((yield* count) + 1);", "setCount((yield* count) + 1);"), "setCount((yield* count) + 1);", /returns a receipt/);
  refused(counter.replace("yield* setCount((yield* count) + 1);", "try { yield* setCount(1); } catch (e) {}"), "try {", /no-try-catch/);
  refused(counter.replace("{yield* doubled}</button>", "{yield* doubled}<Counter /></button>"), "<Counter />", /never tagged/);
  refused(counter.replace("$event(function* () {", "$event(async function* () {"), "async function* () {", /never async/);
  refused(counter.replace("import { $event,", "import { $effect, $event,"), "$effect", /effects are not in the yield subset/);
  refused(counter.replace("const increment = $event(function* () {", "const increment = $event(function* (step: number) {"), "increment}", /events with parameters/);
  refused(counter.replace("return view(function* () {", "return view(function* () {\n    const n = 1;"), "function* () {\n    const n", /a view has no body/);
  const tracker = fixture("tracker.yield.tsx");
  refused(tracker.replace("function* () {\n        yield* setStatus", "(cause) => new Error(String(cause)), function* () {\n        yield* setStatus"), "(cause) =>", /only an absorbing handler/);
  refused(tracker.replace("import { $event,", "import { $optimisticStore, $event,"), "$optimisticStore", /createOptimisticStore/);
  refused(tracker.replace("    if (owner !== undefined) {", "    {"), "const owner = yield*", /continues only inside if \(owner !== undefined\)/);
  refused(tracker.replace('yield* setStatus("");', 'yield* setStatus(yield* mode);'), "yield* mode);", /read before the attempt/);
});
