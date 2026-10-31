// Setup values and pure-helper locals lowered onto ReactiveScript's existing AST only: setup consts are never-written
// snapshot sources (E-4), tracked reads are never peeked implicitly, and helper locals are substituted only when inert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lowerTsx, TsxError } from "./lower.ts";
import { loadTsxModules } from "./modules.ts";
import { check, checkModules } from "./rx/compiler.ts";
import { Runtime } from "./rx/runtime.ts";
import type { Decl, Expr, Program } from "./rx/ast.ts";

const id = (name: string): Expr => ({ k: "id", name });
const lit = (v: unknown): Expr => ({ k: "lit", v });
const peek = (e: Expr): Expr => ({ k: "peek", e });
const component = (p: Program, name = "Counter") => {
  const c = p.decls.find(d => d.k === "component" && d.name === name);
  assert.ok(c && c.k === "component");
  return c.decls;
};
const named = (decls: Decl[], name: string) => decls.find(d => "name" in d && d.name === name);
const codes = (p: Program) => check(p).map(d => d.code + "@" + d.line);
const refused = (source: string, message: RegExp) =>
  assert.throws(() => lowerTsx(source, "main.tsx"), (e: unknown) => e instanceof TsxError && message.test(e.message));

test("explicit untrack and earlier snapshots lower to source := peek; literals need no peek", () => {
  const p = lowerTsx(`import { createSignal, untrack } from "solid-js";
export function Counter() {
  const [n, setN] = createSignal(1);
  const first = untrack(() => n());
  const next = first + 1;
  const label = "fixed";
  return <button onClick={() => setN(n() + 1)}>{first}/{next}/{label}</button>;
}`, "main.tsx");
  const decls = component(p);
  assert.deepEqual(named(decls, "first"), { k: "source", name: "first", init: peek(id("n")), line: 4 });
  assert.deepEqual(named(decls, "next"), { k: "source", name: "next", init: { k: "bin", op: "+", l: peek(id("first")), r: lit(1) }, line: 5 });
  assert.deepEqual(named(decls, "label"), { k: "source", name: "label", init: lit("fixed"), line: 6 });
  assert.deepEqual(codes(p), []);
  const rt = new Runtime({ ...p, view: [{ k: "el", tag: "Counter", attrs: [], children: [] }] });
  assert.equal(rt.step([]).at(-1)!.frame, "1/2/fixed");
  assert.equal(rt.step([{ node: rt.findNode("n")!, path: [], value: 5 }]).at(-1)!.frame, "1/2/fixed", "a setup const is evaluated once");
});

test("bare tracked setup reads are reported at the authored line, never peeked", () => {
  const cases: [string, string][] = [
    ["signal", "const initial = n() * 2;"],
    ["props", "const initial = props.start;"],
    ["store", "const initial = state.count;"],
  ];
  for (const [what, line] of cases) {
    const p = lowerTsx(`import { createSignal, createStore } from "solid-js";
export function Counter(props: { start: number }) {
  const [n, setN] = createSignal(1);
  const [state, setState] = createStore({ count: 0 });
  ${line}
  return <button onClick={() => setN(n() + 1)}>{initial}</button>;
}`, "main.tsx");
    const initial = named(component(p), "initial");
    assert.ok(initial?.k === "source" && initial.init.k !== "peek", what + " read must stay outside peek");
    assert.deepEqual(codes(p), ["SNAPSHOT_INITIALIZER@5"], what);
  }
});

test("a createSignal seed does not authorize the bare setup read it snapshots", () => {
  const p = lowerTsx(`import { createSignal } from "solid-js";
export function Counter() {
  const [n, setN] = createSignal(1);
  const initial = n();
  const [copy, setCopy] = createSignal(initial);
  return <button onClick={() => setCopy(copy() + 1)}>{copy()}</button>;
}`, "main.tsx");
  assert.deepEqual(named(component(p), "copy"), { k: "source", name: "copy", init: peek(id("initial")), line: 5 });
  assert.deepEqual(codes(p), ["SNAPSHOT_INITIALIZER@4"]);
});

test("setup consts are immutable to authored TSX, in their module and through imports", () => {
  refused('const limit: number = 1; export function Counter(){return <button onClick={()=>{limit = 2}}>{limit}</button>}',
    /Assignments are only supported on the draft parameter/);
  refused('import {createSignal} from "solid-js"; export function Counter(){const [n,setN]=createSignal(0); const initial = 3; return <button onClick={()=>{initial = n()}}>{initial}</button>}',
    /Assignments are only supported on the draft parameter/);
  const files: Record<string, string> = {
    "state.tsx": "export const limit: number = 1;",
    "main.tsx": 'import { limit } from "./state.tsx"; export function Counter() { return <button onClick={() => { limit = 2 }}>{limit}</button>; }',
  };
  assert.throws(() => loadTsxModules("main.tsx", path => files[path]),
    (e: unknown) => e instanceof TsxError && /Assignments are only supported on the draft parameter/.test(e.message));
});

test("an RX importer reads exported TSX consts but cannot write them (MO-2)", () => {
  const state = "export const limit: number = 1; export const config: { a: number } = { a: 1 };";
  const files = (main: string): Record<string, string> => ({ "state.tsx": state, "main.rx": main });
  const reader = files('import { limit, config } from "./state.tsx"\nexport default component App() { <p>{"" + limit}/{"" + config.a}</p> }');
  const set = loadTsxModules("main.rx", path => reader[path]);
  assert.deepEqual(checkModules(set).diags, []);
  assert.equal(new Runtime(set).step([]).at(-1)!.frame, "1/1");
  for (const write of ["limit := 3", "config.a := 2", "config := { a: 5 }"]) {
    const writer = files('import { limit, config } from "./state.tsx"\naction bump() { ' + write + ' }\nexport default component App() { <button onClick={() => { bump() }}>{"" + limit}</button> }');
    const diags = checkModules(loadTsxModules("main.rx", path => writer[path])).diags;
    assert.ok(diags.some(d => d.code === "WRITE_TO_NON_SOURCE" && d.rule === "MO-2"), write + ": " + JSON.stringify(diags));
  }
});

test("an RX source imported into TSX setup is a tracked read, and its untracked snapshot is not certified total", () => {
  const files = (read: string): Record<string, string> => ({
    "state.rx": "export source count: number := 1",
    "main.tsx": 'import { untrack } from "solid-js";\nimport { count } from "./state.rx";\nexport function Counter() {\n  const initial = ' + read + ';\n  return <p>{initial}</p>;\n}',
  });
  const bare = files("count");
  assert.deepEqual(checkModules(loadTsxModules("main.tsx", path => bare[path])).diags.map(d => d.code + "@" + d.line), ["SNAPSHOT_INITIALIZER@4"]);
  // Another module's value may hold a failure the frontend cannot see, so the eager snapshot is refused.
  const peeked = files("untrack(() => count)");
  assert.throws(() => loadTsxModules("main.tsx", path => peeked[path]),
    (e: unknown) => e instanceof TsxError && /main\.tsx:4:\d+: Setup const initial can fail at mount \(a read of imported count\)/.test(e.message));
});

test("inert pure-helper locals are substituted into a plain fn tail, including under a branch", () => {
  const p = lowerTsx(`const factor: number = 3;
function scale(a: number): number {
  const doubled = a * 2;
  const shifted = doubled + factor;
  return a > 0 ? shifted - 1 : 0;
}
export function Counter() { return <p>{scale(2)}</p>; }`, "main.tsx");
  const fn = p.decls.find(d => d.k === "fn");
  assert.ok(fn?.k === "fn");
  assert.deepEqual(fn.decls, []);
  const shifted: Expr = { k: "bin", op: "+", l: { k: "bin", op: "*", l: id("a"), r: lit(2) }, r: id("factor") };
  assert.deepEqual(fn.tail, { k: "if", c: { k: "bin", op: ">", l: id("a"), r: lit(0) }, t: { k: "bin", op: "-", l: shifted, r: lit(1) }, f: lit(0) });
  assert.deepEqual(codes(p), []);
});

test("pure-helper locals that could fail, suspend, allocate or read state are refused, not substituted", () => {
  const helper = (body: string, extra = "") => extra + "function f(p: { a: number }, n: number): number { " + body + " }\nexport function Counter() { return <p>{f({ a: 1 }, 2)}</p>; }";
  const g = "function g(n: number): number { return n + 1; }\n";
  const cannot = /Pure helper local b cannot be lowered: an RX fn body is one expression/;
  refused(helper("const b = g(n); return b;", g), cannot);
  refused(helper("const b = p.a; return b;"), cannot);
  refused(helper("const b = { v: n }; return b.v;"), cannot);
  refused(helper("const b = n > 0 ? g(n) : 0; return n > 1 ? b : 0;", g), cannot);
  refused(helper("const b = base + n; return b;", "const base: number = g(1);\n" + g), cannot);
  refused(helper("const b = n * 2; return n;"), /Unused pure helper local b/);
});

// Snapshot and inertness facts belong to the resolved binding, not to a spelling shared by unrelated owners.
test("a same-named const in a sibling component does not snapshot a signal read", () => {
  const p = lowerTsx(`import { createSignal, createMemo } from "solid-js";
export function First() { const n = 1; return <p>{n}</p>; }
export function Second() {
  const [n, setN] = createSignal(2);
  const captured = n();
  return <p>{captured}</p>;
}`, "main.tsx");
  const captured = named(component(p, "Second"), "captured");
  assert.deepEqual(captured, { k: "source", name: "captured", init: id("n"), line: 5 });
  assert.deepEqual(codes(p), ["SNAPSHOT_INITIALIZER@5"]);
  assert.deepEqual(named(component(p, "First"), "n"), { k: "source", name: "n", init: lit(1), line: 2 });
});

test("nested owners with a same-named const do not authorize a signal read", () => {
  // A child component mounted in a branch, and an owned helper instantiated by the component.
  const child = "function Child() { const n = 1; return <i>{n}</i>; }";
  const helper = "function useTotal(base: () => number): () => number { const n = 1; const total = createMemo(() => base() + n); return total; }";
  for (const [owner, bind, view] of [
    [child, "", "<Show when={n() > 0}><Child/>{captured}</Show>"],
    [helper, "\n  const total = useTotal(n);", "<p>{captured}/{total()}</p>"],
  ]) {
    const p = lowerTsx('import { createSignal, createMemo, Show } from "solid-js";\n' + owner +
      '\nexport function Counter() {\n  const [n, setN] = createSignal(2);\n  const captured = n();' + bind + '\n  return ' + view + ';\n}', "main.tsx");
    assert.deepEqual(named(component(p), "captured"), { k: "source", name: "captured", init: id("n"), line: 5 });
    assert.deepEqual(codes(p), ["SNAPSHOT_INITIALIZER@5"]);
  }
});

test("an unrelated inert const of the same name does not make a helper's reactive local substitutable", () => {
  refused(`import { createSignal } from "solid-js";
export function First() { const n = 1; return <p>{n}</p>; }
export function Second() {
  const [n, setN] = createSignal(2);
  function f(flag: boolean): number { const x = n(); return flag ? x : 0; }
  return <button onClick={() => setN(n() + 1)}>{f(true)}</button>;
}`, /main\.tsx:5:\d+: Pure helper local x cannot be lowered/);
});

test("a createSignal seed peeks only its own owner's snapshots", () => {
  const p = lowerTsx(`import { createSignal } from "solid-js";
export function First() { const n = 1; const captured = 4; return <p>{n}/{captured}</p>; }
export function Second() {
  const [n, setN] = createSignal(2);
  const captured = n();
  const [copy, setCopy] = createSignal(captured);
  return <button onClick={() => setCopy(copy() + 1)}>{copy()}</button>;
}`, "main.tsx");
  const decls = component(p, "Second");
  assert.deepEqual(named(decls, "captured"), { k: "source", name: "captured", init: id("n"), line: 5 });
  assert.deepEqual(named(decls, "copy"), { k: "source", name: "copy", init: peek(id("captured")), line: 6 });
  assert.ok(codes(p).includes("SNAPSHOT_INITIALIZER@5"));
});

test("legitimate earlier and imported snapshots are still peeked by binding", () => {
  const files: Record<string, string> = {
    "state.tsx": "export const limit: number = 2;",
    "main.tsx": 'import { limit } from "./state.tsx";\nexport function Other() { const total = 9; return <p>{total}</p>; }\nexport function Counter() {\n  const base = 3;\n  const total = base + limit;\n  return <p>{total}</p>;\n}',
  };
  const set = loadTsxModules("main.tsx", path => files[path]);
  assert.deepEqual(checkModules(set).diags, []);
  const total = named(component(set.programs.get("main.tsx")!), "total");
  assert.deepEqual(total, { k: "source", name: "total", init: { k: "bin", op: "+", l: peek(id("base")), r: peek(id("limit")) }, line: 5 });
});

// Eager initializers that could fail cannot keep Solid's routing: native throws during setup, before any boundary inside
// the owner exists, while an RX snapshot holds the failure for its readers. Being read does not authorize them.
const failHead = 'import { untrack, createSignal, createMemo, Show } from "solid-js";\nimport { defineError, raiseFailure, catchFailure, FailureBoundary } from "reactivescript-tsx";\nconst Oops = defineError("Oops", [], () => "oops");\n';
const canFail = (name: string, why: string, line: number) =>
  new RegExp("main\\.tsx:" + line + ":\\d+: " + name + " can fail at mount \\(" + why + "\\): Solid throws during setup, before any boundary inside this owner exists");

test("failing setup snapshots are refused even when read inside an inner boundary, a branch, or through helpers and memos", () => {
  refused(failHead + 'export function Counter() {\n  const captured = untrack(() => raiseFailure(Oops()));\n  return <FailureBoundary classes={[Oops]} fallback={error => <p>caught</p>}><p>{captured}</p></FailureBoundary>;\n}',
    canFail("Setup const captured", "an explicit throw", 5));
  refused(failHead + 'export function Counter() {\n  const [n, setN] = createSignal(0);\n  const captured = untrack(() => raiseFailure(Oops()));\n  return <Show when={n() > 1}><p>{captured}</p></Show>;\n}',
    canFail("Setup const captured", "an explicit throw", 6));
  refused(failHead + 'function boom(n: number): number { return raiseFailure(Oops()); }\nexport function Counter() {\n  const captured = boom(1);\n  return <p>{captured}</p>;\n}',
    canFail("Setup const captured", "an explicit throw", 6));
  refused(failHead + 'export function Counter() {\n  const [n, setN] = createSignal(1);\n  const m = createMemo((): number => n() > 0 ? raiseFailure(Oops()) : 0);\n  const captured = untrack(() => m());\n  return <p>{captured}</p>;\n}',
    canFail("Setup const captured", "an explicit throw", 7));
  // A selective catch is not proved to discharge everything; only a catch-all is.
  refused(failHead + 'export function Counter() {\n  const captured = untrack(() => catchFailure(() => raiseFailure(Oops()), [Oops], error => 0));\n  return <p>{captured}</p>;\n}',
    canFail("Setup const captured", "an explicit throw", 5));
  refused(failHead + 'export function Counter() {\n  const [n, setN] = createSignal(raiseFailure(Oops()));\n  return <p>{n()}</p>;\n}',
    canFail("The eager initializer of n \\(a signal, store, projection or provider seed\\)", "an explicit throw", 5));
});

test("props snapshots are accepted only when every application site in this module passes a total value", () => {
  refused(failHead + 'function Child(props: { value: string | number }) {\n  const captured = untrack(() => props.value);\n  return <FailureBoundary classes={[Oops]} fallback={error => <p>caught</p>}><p>{captured}</p></FailureBoundary>;\n}\nexport function Counter() { return <Child value={raiseFailure(Oops())}/>; }',
    canFail("Setup const captured", "props.value of <Child>, passed an explicit throw", 5));
  refused(failHead + 'export function Counter(props: { value: number }) {\n  const captured = untrack(() => props.value);\n  return <p>{captured}</p>;\n}',
    canFail("Setup const captured", "props of exported component Counter, whose callers in other modules are unknown", 5));
  const safe = lowerTsx(failHead + 'function Child(props: { value: number }) {\n  const captured = untrack(() => props.value);\n  return <p>{captured}</p>;\n}\nexport function Counter() { const [n, setN] = createSignal(1); return <Child value={n() + 1}/>; }', "main.tsx");
  assert.deepEqual(codes(safe), []);
});

test("locally caught, signal and literal snapshots remain accepted", () => {
  const p = lowerTsx(failHead + 'export function Counter() {\n  const [n, setN] = createSignal(1);\n  const caught = untrack(() => catchFailure(() => raiseFailure(Oops()), [Error], error => 0));\n  const current = untrack(() => n());\n  const fixed = 3;\n  return <button onClick={() => setN(n() + 1)}>{caught}/{current}/{fixed}</button>;\n}', "main.tsx");
  assert.deepEqual(codes(p), []);
  const caught = named(component(p), "caught");
  assert.ok(caught?.k === "source" && caught.init.k === "peek" && caught.init.e.k === "catch" && caught.init.e.classes === undefined);
  const rt = new Runtime({ ...p, view: [{ k: "el", tag: "Counter", attrs: [], children: [] }] });
  assert.equal(rt.step([]).at(-1)!.frame, "0/1/3");
});

test("recursive helpers and failing error messages are not certified total in eager initializers", () => {
  // A cycle is not proof of totality; termination is not attempted.
  refused(failHead + 'function count(n: number): number { return n > 0 ? count(n - 1) : 0; }\nexport function Counter() {\n  const captured = count(3);\n  return <p>{captured}</p>;\n}',
    canFail("Setup const captured", "a recursive definition, whose totality is not proved", 6));
  // Constructing a failure evaluates its message.
  refused(failHead + 'function boom(id: number): string { return raiseFailure(Oops()); }\nconst Missing = defineError("Missing", ["id"], (id: number) => boom(id));\nexport function Counter() {\n  const made = Missing(2);\n  return <p>{made.message}</p>;\n}',
    canFail("Setup const made", "an explicit throw", 7));
  const ok = lowerTsx(failHead + 'const Missing = defineError("Missing", ["id"], (id: number) => "missing " + id);\nexport function Counter() {\n  const made = Missing(2);\n  return <p>{made.message}</p>;\n}', "main.tsx");
  assert.deepEqual(codes(ok), []);
});

test("props facts follow the component declaration, even for siblings on one line", () => {
  const pair = (b: string) => failHead + 'function A(props: { value: string | number }) { const captured = untrack(() => props.value); return <p>{captured}</p>; } function B(props: { value: string | number }) { const captured = untrack(() => props.value); return <p>{captured}</p>; } export function Counter() { return <div><A value={1}/><B value={' + b + '}/></div>; }';
  refused(pair("raiseFailure(Oops())"), canFail("Setup const captured", "props.value of <B>, passed an explicit throw", 4));
  assert.deepEqual(codes(lowerTsx(pair("2"), "main.tsx")), []);
});
