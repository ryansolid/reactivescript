import { test } from "node:test";
import { runtimeFiles } from "./rx/runtime.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Decl, Expr, Markup, Program } from "./rx/ast.ts";
import { check, checkModules, checkWithSignature } from "./rx/compiler.ts";
import { singleModule, type ModuleSet } from "./rx/compiler.ts";
import { Runtime, ErrVal, PENDING } from "./rx/runtime.ts";
import { printSignature } from "./rx/compiler.ts";
import { compileModules } from "./rx/compiler.ts";
import { lowerViews, STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";
import { lowerTsx, TsxError } from "./lower.ts";
import { parseDeclarations } from "./rx/compiler.ts";

const id = (name: string): Expr => ({ k: "id", name });
const lit = (v: unknown): Expr => ({ k: "lit", v });
const call = (name: string, ...args: Expr[]): Expr => ({ k: "call", f: id(name), args });
const read = (name: string): Markup => ({ k: "read", e: id(name) });
const text = (s: string): Markup => ({ k: "text", s });
const source = (name: string, v: unknown): Decl => ({ k: "source", name, init: lit(v), line: 1 });
/** RX's eager snapshot: `source name := peek(e)` (E-4), never written. */
const snapshot = (name: string, e: Expr, line = 2): Decl => ({ k: "source", name, init: { k: "peek", e }, line });
type Change = [name: string, value: unknown];

async function traces(input: Program | ModuleSet, changes: Change[], expected: string[]) {
  const set = "programs" in input ? input : singleModule(input);
  assert.deepEqual(checkModules(set).diags, []);
  const rt = new Runtime(set);
  const frames = [rt.step([]).at(-1)!.frame];
  for (const [name, value] of changes) {
    const node = rt.findNode(name);
    assert.ok(node, name);
    frames.push(rt.step([{ node, path: [], value }]).at(-1)!.frame);
  }
  assert.deepEqual(frames, expected, "interpreter");

  const out = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(out + "snapshot-core-");
  const renderer = runtimeFiles.stringRenderer;
  try {
    const compiled = compileModules(set);
    for (const [name, code] of lowerViews(compiled.files, "universal"))
      writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
    const mod = await import(pathToFileURL(dir + "/" + compiled.entry).href);
    const app = createApp();
    const dispose = app.mount(mod.default(app));
    try {
      flush();
      const actual = [app.frame()];
      for (const [name, value] of changes) {
        app.dset(name, [], value);
        flush();
        actual.push(app.frame());
      }
      assert.deepEqual(actual, expected, "compiled Solid");
    } finally { dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("const is eager even when its first read happens after source writes", async () => {
  await traces({
    decls: [source("count", 0), source("show", false), snapshot("initial", id("count"))],
    view: [read("count"), text("/"), { k: "mif", c: id("show"), tDecls: [], t: [read("initial")], fDecls: [], f: [text("hidden")] }],
  }, [["count", 4], ["count", 9], ["show", true], ["count", 12]],
  ["0/hidden", "4/hidden", "9/hidden", "9/0", "12/0"]);
});

test("component const captures mount state once, including pure calls, records and arrays", async () => {
  await traces({
    decls: [source("count", 3), {
      k: "fn", name: "double", params: [{ name: "n", ref: false }], decls: [],
      tail: { k: "bin", op: "*", l: id("n"), r: lit(2) }, line: 2,
    }, {
      k: "component", name: "Counter", props: "props", line: 3, decls: [
        snapshot("initial", call("double", id("count")), 4),
        snapshot("record", { k: "rec", fields: [{ key: "value", v: id("count") }] }, 5),
        snapshot("array", { k: "arr", items: [id("count")] }, 6),
      ],
      view: [read("count"), text("/"), read("initial"), text("/"),
        { k: "read", e: { k: "member", o: id("record"), p: "value" } }, text("/"),
        { k: "read", e: { k: "index", o: id("array"), i: lit(0) } }],
    }],
    view: [{ k: "el", tag: "Counter", attrs: [], children: [] }],
  }, [["count", 5], ["count", 8]], ["3/6/3/3", "5/6/3/3", "8/6/3/3"]);
});

test("new branch and component snapshots see the mounting pass and resnapshot only on reentry", async () => {
  await traces({ decls: [source("count", 0), { k: "component", name: "Child", props: "props", line: 2,
    decls: [snapshot("initial", id("count"), 3)], view: [read("count"), text("/"), read("initial")],
  }], view: [{ k: "mif", c: id("count"), tDecls: [snapshot("branchInitial", id("count"), 4)],
    t: [{ k: "el", tag: "Child", attrs: [], children: [] }, text("/"), read("branchInitial")], fDecls: [], f: [text("hidden")],
  }] }, [["count", 1], ["count", 2], ["count", 0], ["count", 3], ["count", 4]],
  ["hidden", "1/1/1", "2/1/1", "hidden", "3/3/3", "4/3/3"]);
});

test("bound function initialization supports local const snapshots of ref parameters", async () => {
  await traces({
    decls: [source("count", 2), {
      k: "fn", name: "capture", params: [{ name: "value", ref: true }],
      decls: [snapshot("initial", id("value"), 4)], tail: id("initial"), line: 3,
    }, { k: "eq", name: "captured", e: call("capture", id("count")), line: 5 }],
    view: [read("count"), text("/"), read("captured")],
  }, [["count", 7], ["count", 11]], ["2/2", "7/2", "11/2"]);
});

test("pure helper locals are substituted into a plain RX fn that reevaluates for every caller value", async () => {
  // RX fns are one expression (E-9): TSX helper locals are substituted into the tail, so the fn has no declarations.
  const lowered = lowerTsx('function label(value: number): string { const doubled = value * 2; return "#" + doubled; } export function Counter() { return <p>{label(1)}</p>; }', "main.tsx");
  const fn = lowered.decls.find(d => d.k === "fn");
  assert.ok(fn?.k === "fn");
  assert.deepEqual(fn.decls, []);
  assert.deepEqual(fn.tail, { k: "bin", op: "+", l: lit("#"), r: { k: "bin", op: "*", l: id("value"), r: lit(2) } });
  const helper: Decl = { ...fn, exported: true };
  const p: Program = { decls: [source("count", 1), helper, { k: "eq", name: "value", e: call("label", id("count")), line: 4 }], view: [read("value")] };
  const signature = checkWithSignature(p).sig.exports.get("label");
  assert.ok(signature?.kind === "fn" && !signature.instantiating);
  await traces(p, [["count", 3], ["count", 7]], ["#2", "#6", "#14"]);
  // TSX would evaluate an unused local eagerly (it could throw or suspend); a pure RX fn has only its tail.
  assert.throws(() => lowerTsx('function label(value: number): string { const unused = value + 1; return "#" + value; } export function Counter() { return <p>{label(1)}</p>; }', "main.tsx"),
    /Unused pure helper local unused/);
});
test("a pure helper read is tracked in an equation and fixed in a snapshot source", async () => {
  await traces({ decls: [source("count", 2), { k: "fn", name: "readCount", params: [], line: 2, decls: [], tail: id("count") },
    snapshot("initial", call("readCount"), 4), { k: "eq", name: "current", e: call("readCount"), line: 5 }],
  view: [read("initial"), text("/"), read("current")] }, [["count", 5], ["count", 9]], ["2/2", "2/5", "2/9"]);
});
test("imported pure helpers remain ordinary functions under an alias", async () => {
  const dependency: Program = { decls: [{ k: "fn", name: "label", exported: true, params: [{ name: "n", ref: false }], line: 1,
    decls: [], tail: { k: "bin", op: "*", l: id("n"), r: lit(2) },
  }], view: [] };
  const entry: Program = { decls: [
    { k: "import", from: "./helper.rx", resolved: "helper.rx", pure: true, line: 1, names: [{ name: "label", alias: "double" }] },
    source("count", 2), { k: "eq", name: "value", e: call("double", id("count")), line: 3 },
  ], view: [read("value")] };
  await traces({ entry: "main.rx", order: ["helper.rx", "main.rx"], programs: new Map([["helper.rx", dependency], ["main.rx", entry]]), diags: [] },
    [["count", 5], ["count", 9]], ["4", "10", "18"]);
});

test("own-pre memo accumulation advances once per reactive instant", async () => {
  await traces({ decls: [source("count", 0), { k: "eq", name: "total", line: 2, e: {
    k: "bin", op: "+", l: { k: "pre", name: "total", init: lit(0) }, r: id("count"),
  } }], view: [read("count"), text("/"), read("total")] },
  [["count", 1], ["count", 2], ["count", 3], ["count", 4]], ["0/0", "1/1", "2/3", "3/6", "4/10"]);
});

test("own-pre draft seeds retain the previous instant rather than a settle-pass result", async () => {
  await traces({ decls: [source("count", 0), { k: "eq", name: "projection", line: 2, e: {
    k: "draft", seed: { k: "pre", name: "projection", init: { k: "rec", fields: [{ key: "count", v: lit(0) }, { key: "sum", v: lit(0) }] } }, body: [
      { k: "write", target: { name: "d", path: ["count"] }, e: id("count") },
      { k: "write", target: { name: "d", path: ["sum"] }, e: { k: "bin", op: "+",
        l: { k: "member", o: id("d"), p: "sum" }, r: { k: "member", o: id("d"), p: "count" },
      } },
    ],
  } }], view: [{ k: "read", e: { k: "member", o: id("projection"), p: "count" } }, text("/"),
    { k: "read", e: { k: "member", o: id("projection"), p: "sum" } }],
  }, [["count", 1], ["count", 2], ["count", 3], ["count", 4]], ["0/0", "1/1", "2/3", "3/6", "4/10"]);
});

test("aliased imported instantiating helpers keep their local compiled name", async () => {
  const dependency: Program = { decls: [{
    k: "fn", name: "capture", params: [{ name: "value", ref: true }],
    decls: [snapshot("initial", id("value"), 4)], tail: id("initial"), line: 3, exported: true,
  }], view: [] };
  const entry: Program = { decls: [
    { k: "import", from: "./helper.rx", resolved: "helper.rx", pure: true, line: 1, names: [{ name: "capture", alias: "freeze" }] },
    source("count", 2), { k: "eq", name: "captured", e: call("freeze", id("count")), line: 5 },
  ], view: [read("count"), text("/"), read("captured")] };
  await traces({ entry: "main.rx", order: ["helper.rx", "main.rx"], programs: new Map([["helper.rx", dependency], ["main.rx", entry]]), diags: [] },
    [["count", 7], ["count", 11]], ["2/2", "7/2", "11/2"]);
});

test("eager snapshots do not turn effect reads into dependencies on their original sources", () => {
  assert.deepEqual(check({ decls: [source("count", 1), snapshot("initial", id("count")), {
    k: "effect", inputs: [id("initial")], line: 4, body: [{ k: "write", target: { name: "count", path: [] }, e: lit(2) }],
  }], view: [] }), []);
});

test("eager TSX initializers refuse bindings initialized later, directly and through pure helpers", () => {
  // JavaScript's temporal dead zone; RX sources have no such ordering, so the frontend refuses it.
  assert.throws(() => lowerTsx("const first: number = later; const later: number = 1; export function Counter(){return <p>{first}</p>}", "main.tsx"),
    /Unknown value: later/);
  assert.throws(() => lowerTsx("function readLater(): number { return later; } const first: number = readLater(); const later: number = 1; export function Counter(){return <p>{first}</p>}", "main.tsx"),
    /first reads later before its initialization \(JavaScript's temporal dead zone\)/);
});
test("equation dependencies do not reorder eager snapshot and source initialization", async () => {
  const p: Program = { decls: [
    { k: "eq", name: "earlyEquation", e: id("last"), line: 1 },
    { k: "fn", name: "helper", params: [], decls: [], tail: lit(3), line: 2 },
    snapshot("first", call("helper"), 3),
    { k: "source", name: "middle", init: call("helper"), line: 4 },
    snapshot("last", call("helper"), 5),
  ], view: [read("first"), text("/"), read("middle"), text("/"), read("last")] };
  const code = compileModules(singleModule(p)).files.get("main.mjs")!;
  assert.ok(code.indexOf("const [v$first,") >= 0 && code.indexOf("const [v$first,") < code.indexOf("const [v$middle,"));
  assert.ok(code.indexOf("const [v$middle,") < code.indexOf("const [v$last,"));
  await traces(p, [["middle", 8]], ["3/3/3", "3/8/3"]);
});

test("exported snapshot sources are fixed values, shared by import aliases and read-only to importers", async () => {
  const dependency: Program = {
    decls: [source("count", 1), { ...snapshot("initial", id("count")), exported: true } as Decl], view: [],
  };
  const entry: Program = {
    decls: [{ k: "import", from: "./state.rx", resolved: "state.rx", pure: false, line: 7, names: [
      { name: "initial", alias: "first" }, { name: "initial", alias: "second" },
    ] }],
    view: [read("first"), text("/"), read("second")],
  };
  const set: ModuleSet = { entry: "main.rx", order: ["state.rx", "main.rx"], programs: new Map([["state.rx", dependency], ["main.rx", entry]]), diags: [] };
  const result = checkModules(set);
  assert.equal(result.sigs.get("state.rx")!.exports.get("initial")?.kind, "source");
  assert.match(printSignature(result.sigs.get("state.rx")!), /export source initial/);
  await traces(set, [["count", 6], ["count", 10]], ["1/1", "1/1", "1/1"]);
  const bad: Program = { ...entry, decls: [...entry.decls, { k: "action", name: "bad", params: [], line: 9, body: [{ k: "write", target: { name: "first", path: [] }, e: lit(2) }] }] };
  assert.ok(check(bad, { sigs: result.sigs }).some(d => d.code === "WRITE_TO_NON_SOURCE" && d.line === 9));
  // A TSX setup const has no setter, and the frontend refuses assignment to it, in its module or an importer.
  for (const handler of ["{initial = 2}", "{first = 2}"]) {
    const sourceText = handler.includes("first")
      ? 'import {initial as first} from "./state.tsx"; export function Counter(){return <button onClick={()=>' + handler + '}>{first}</button>}'
      : 'const initial: number = 1; export function Counter(){return <button onClick={()=>' + handler + '}>{initial}</button>}';
    assert.throws(() => lowerTsx(sourceText, "main.tsx", { modules: new Map([["./state.tsx", { path: "state.tsx", program: lowerTsx("export const initial: number = 1;", "state.tsx") }]]) }),
      (e: unknown) => e instanceof TsxError && /Assignments are only supported on the draft parameter/.test(e.message));
  }
});

test("snapshot sources keep source-line diagnostics", () => {
  assert.ok(check({ decls: [snapshot("x", id("missing"), 17)], view: [] }).some(d => d.code === "UNBOUND" && d.line === 17));
  assert.ok(check({ decls: [snapshot("x", lit(1), 2), snapshot("x", lit(2), 18)], view: [] }).some(d => d.code === "DUPLICATE_DECLARATION" && d.line === 18));
  // A bare reactive read is not silently snapshotted (DV-6); the TSX frontend leaves it outside peek so this reports it.
  assert.ok(check({ decls: [source("count", 1), { k: "source", name: "x", init: id("count"), line: 19 }], view: [] })
    .some(d => d.code === "SNAPSHOT_INITIALIZER" && d.line === 19));
});
test("snapshot initializers do not make unknown imports pure", () => {
  const imp: Decl = { k: "import", from: "./prelude", pure: false, names: [{ name: "log", alias: "io" }], line: 1 };
  assert.ok(check({ decls: [imp, snapshot("x", call("io"), 31)], view: [] }).some(d => d.code === "IO_IN_REACTIVE" && d.line === 31));
});
test("snapshot failures surface at readers, and TSX refuses unused eager consts whose initializer could throw", async () => {
  const failure: Expr = { k: "throw", e: call("Oops") };
  const error: Decl = { k: "error", name: "Oops", params: [], line: 1 };
  // R-f-2: a snapshot holds its initializer's failure; a reader must discharge it.
  assert.ok(check({ decls: [error, snapshot("value", failure, 36)], view: [{ k: "read", e: id("value"), line: 37 }] })
    .some(d => d.code === "UNHANDLED_FAILURE" && d.line === 37));
  await traces({ decls: [error, snapshot("value", { k: "catch", e: failure, classes: ["Oops"], alt: lit(42) })], view: [read("value")] }, [], ["42"]);
  // Solid evaluates a setup const at mount even if nothing reads it, so an unobserved RX snapshot would hide its failure.
  assert.throws(() => lowerTsx('import {untrack} from "solid-js"; function Child(props: {v: number}){const unused = untrack(() => props.v); return <p>child</p>} export function Counter(){return <Child v={1}/>}', "main.tsx"),
    (e: unknown) => e instanceof TsxError && /Unused setup const unused: TSX evaluates it eagerly at mount/.test(e.message));
  assert.doesNotThrow(() => lowerTsx("export function Counter(){const unusedLiteral = 1; return <p>x</p>}", "main.tsx"));
});
test("TSX setup consts refuse untracked async reads instead of snapshotting a pending value", () => {
  const declarations = new Map([["./api", parseDeclarations("export pure fn load(n: number): number")]]);
  assert.throws(() => lowerTsx('import {createMemo, untrack} from "solid-js"; import {load} from "./api"; export function Counter(){const data = createMemo(async (): Promise<number> => await load(1)); const x = untrack(() => data()); return <p>{x}</p>}', "main.tsx", { declarations }),
    (e: unknown) => e instanceof TsxError && /Setup const x reads an async value at mount; Solid refuses untracked async reads there \(PENDING_ASYNC_UNTRACKED_READ\)/.test(e.message));
});
test("const function aliases do not conceal client-state captures from server bodies", () => {
  const p: Program = { decls: [source("count", 1),
    { k: "fn", name: "reader", params: [], decls: [], tail: id("count"), line: 2 },
    snapshot("alias", id("reader"), 3),
    { k: "server", kind: "fn", name: "load", params: [], body: [{ k: "return", e: call("alias") }], line: 4 },
  ], view: [] };
  assert.ok(check(p).some(d => d.code === "SERVER_CAPTURE" && d.line === 4));
});

test("ordinary missing-row access panics while optional member and index access return undefined", async () => {
  const row: Expr = { k: "index", o: id("rows"), i: lit(5) };
  const panic = (e: Expr): Expr => ({ k: "catch", e, classes: ["Panic"], alt: lit("panic") });
  await traces({ decls: [{ k: "source", name: "rows", init: { k: "arr", items: [
    { k: "rec", fields: [{ key: "name", v: lit("present") }] },
  ] }, line: 1 }], view: [
    { k: "read", e: panic({ k: "member", o: row, p: "name" }) }, text("/"),
    { k: "read", e: { k: "member", o: row, p: "name", opt: true } }, text("/"),
    { k: "read", e: panic({ k: "index", o: row, i: lit("name") }) }, text("/"),
    { k: "read", e: { k: "index", o: row, i: lit("name"), opt: true } },
  ] }, [], ["panic/undefined/panic/undefined"]);
});

test("optional access boxes primitives and skips computed keys, arguments and chain continuations", async () => {
  const bomb = call("fail", lit("must not evaluate"));
  const optionalCall: Expr = { k: "call", f: { k: "member", o: lit(null), p: "method", opt: true }, args: [bomb] };
  await traces({ decls: [], view: [
    { k: "read", e: { k: "member", o: lit("abc"), p: "length", opt: true } }, text("/"),
    { k: "read", e: { k: "index", o: lit("abc"), i: lit(1), opt: true } }, text("/"),
    { k: "read", e: { k: "call", f: { k: "member", o: lit(12), p: "toString" }, args: [] } }, text("/"),
    { k: "read", e: { k: "index", o: lit(null), i: bomb, opt: true } }, text("/"),
    { k: "read", e: optionalCall }, text("/"),
    { k: "read", e: { k: "member", o: optionalCall, p: "name" } }, text("/"),
    { k: "read", e: { k: "catch", classes: ["Panic"], alt: lit("panic"), e: {
      k: "member", o: { k: "member", o: { k: "rec", fields: [] }, p: "missing", opt: true }, p: "name",
    } } }, text("/"),
    { k: "read", e: { k: "catch", classes: ["Panic"], alt: lit("panic"), e: {
      k: "member", o: { k: "if", c: lit(true), t: optionalCall, f: lit(undefined) }, p: "name",
    } } },
  ] }, [], ["3/b/12/undefined/undefined/undefined/panic/panic"]);
});

test("member and index access propagate pending and error values instead of treating them as nullish", async () => {
  const rt = new Runtime({ decls: [], view: [] });
  const failure = new ErrVal(new Error("original"));
  for (const value of [PENDING, failure]) for (const opt of [false, true]) {
    assert.equal(rt.evalExpr({ k: "member", o: lit(value), p: "name", opt }, rt.root), value);
    assert.equal(rt.evalExpr({ k: "index", o: lit(value), i: lit(0), opt }, rt.root), value);
  }
  const accesses: Markup[] = [false, true].flatMap(opt => [
    { k: "read", e: { k: "member", o: id("value"), p: "name", opt } } as Markup,
    { k: "read", e: { k: "index", o: id("value"), i: lit(0), opt } } as Markup,
  ]);
  await traces({ decls: [
    { k: "error", name: "Oops", params: [], line: 1 },
    { k: "eq", name: "value", e: { k: "throw", e: call("Oops") }, line: 2 },
  ], view: [{ k: "errored", classes: ["Oops"], decls: [], body: accesses, fallback: [text("original error")] }] }, [], ["original error"]);
  await traces({ decls: [
    { k: "import", from: "./prelude", pure: true, fails: [], names: [{ name: "fetch", alias: "fetch" }], line: 1 },
    { k: "eq", name: "value", e: { k: "await", e: call("fetch", lit("pending")) }, line: 2 },
  ], view: [{ k: "loading", decls: [], body: accesses, fallback: [text("pending")] }] }, [], ["pending"]);
});
