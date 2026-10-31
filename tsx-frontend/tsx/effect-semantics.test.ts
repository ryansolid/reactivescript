import { test } from "node:test";
import { runtimeFiles } from "./rx/runtime.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRoot, createSignal, createMemo, createEffect } from "solid-js";
import type { Decl, Expr, Markup, Program, Stmt } from "./rx/ast.ts";
import { check } from "./rx/compiler.ts";
import { Runtime } from "./rx/runtime.ts";
import { compile } from "./rx/compiler.ts";
import { lowerViews, STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";

type Options = { memo?: boolean; cleanup?: boolean; previous?: boolean; pending?: boolean; errors?: boolean; fresh?: boolean; initial?: number; lifecycle?: boolean };
type Step = { n: number } | { land: boolean };
type Trace = { frames: string[]; log: string[]; phases: string[][] };
type Packet = "none" | "identity";
const steps: Step[] = [1, 2, 3, 4].map(n => ({ n }));
const every = ["0/1", "1/2", "2/3", "3/4", "4/5"];
const changed = ["0/1", "1/1", "2/1", "3/2", "4/2"];
const id = (name: string): Expr => ({ k: "id", name });
const lit = (v: unknown): Expr => ({ k: "lit", v });
const member = (o: Expr, p: string): Expr => ({ k: "member", o, p });
const call = (name: string, ...args: Expr[]): Expr => ({ k: "call", f: id(name), args });
const bin = (op: string, l: Expr, r: Expr): Expr => ({ k: "bin", op, l, r });
const log = (...args: Expr[]): Stmt => ({ k: "expr", e: call("log", ...args) });
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); flush(); await new Promise(resolve => setTimeout(resolve, 0)); flush(); };

async function native(options: Options = {}, changes = steps): Promise<Trace> {
  const events: string[] = [];
  const record = (...xs: unknown[]) => events.push(`log(${xs.map(String).join(", ")})`);
  let land!: (value: boolean) => void;
  const waiting = new Promise<boolean>(resolve => { land = resolve; });
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(options.initial ?? 0);
    const [runs, setRuns] = createSignal(0);
    let last: unknown = null;
    const threshold = createMemo(() => n() > 2);
    const [question] = createSignal(() => n() === 1 ? waiting : n() > 2);
    const compute = (previous: unknown) => {
      if (options.errors && n() === 1) throw new Error("boom");
      if (options.pending) return question();
      if (options.previous) return ((previous as number | undefined) ?? 0) + n();
      const value = options.memo ? threshold() : n() > 2;
      return options.fresh ? { value } : value;
    };
    const apply = (value: unknown, previous?: unknown) => {
      if (options.fresh) { record("apply", (value as { value: boolean }).value, value === last); last = value; }
      else if (options.previous) record("apply", value, previous); else record("apply", value);
      if (options.previous) setRuns(value as number); else setRuns(p => p + 1);
      if (options.cleanup) return () => record("cleanup", value);
    };
    createEffect(compute, apply);
    if (options.lifecycle) {
      createEffect(n, value => { record("sibling", value); return () => record("sibling-cleanup", value); });
      createRoot(() => {
        for (const label of ["child-a", "child-b"])
          createEffect(n, value => { record(label, value); return () => record(label + "-cleanup", value); });
      });
    }
    return { dispose, setN, frame: () => `${n()}/${runs()}` };
  });
  try {
    flush(); await settle();
    const frames = [app.frame()]; const phases = [[...events]];
    for (const change of changes) {
      if ("n" in change) app.setN(change.n); else land(change.land);
      flush(); await settle(); frames.push(app.frame()); phases.push([...events]);
    }
    return { frames, log: events, phases };
  } finally { app.dispose(); }
}

function program(packet: Packet, options: Options = {}): Program {
  const decls: Decl[] = [
    { k: "source", name: "n", init: lit(options.initial ?? 0), line: 1 },
    { k: "source", name: "runs", init: lit(0), line: 2 },
  ];
  const threshold = bin(">", id("n"), lit(2));
  let compute = threshold;
  if (options.memo) { decls.push({ k: "eq", name: "threshold", e: threshold, line: 3 }); compute = id("threshold"); }
  if (options.pending) {
    decls.push({ k: "import", names: [{ name: "fetch", alias: "fetch" }], from: "./prelude", pure: true, fails: [], line: 3 });
    decls.push({ k: "eq", name: "question", line: 4, e: { k: "await", e: { k: "if",
      c: bin("==", id("n"), lit(1)), t: call("fetch", lit("pending")), f: threshold,
    } } });
    compute = id("question");
  }
  if (options.errors) {
    decls.push({ k: "error", name: "Boom", params: [], msg: lit("boom"), line: 3 });
    compute = { k: "if", c: bin("==", id("n"), lit(1)), t: { k: "throw", e: call("Boom") }, f: compute };
  }
  const previous = member({ k: "pre", name: "packet", init: { k: "rec", fields: [{ key: "value", v: lit(undefined) }] } }, "value");
  if (options.previous) compute = bin("+", bin("??", previous, lit(0)), id("n"));
  if (options.fresh) {
    decls.push({ k: "source", name: "last", init: lit(null), line: 5 });
    compute = { k: "rec", fields: [{ key: "value", v: compute }] };
  }
  let input: Expr = packet === "none" ? compute : { k: "rec", fields: [
    { key: "value", v: compute },
    ...(options.previous ? [{ key: "previous", v: previous }] : []),
    ...(packet === "identity" ? [{ key: "token", v: { k: "fn", params: [], body: lit(undefined) } as Expr }] : []),
  ] };
  if (options.previous) { decls.push({ k: "eq", name: "packet", e: input, line: 5 }); input = id("packet"); }
  const value = packet === "none" ? id("$0") : member(id("$0"), "value");
  const body: Stmt[] = [{ k: "let", name: "value", e: value }];
  if (options.fresh) {
    body.push(log(lit("apply"), member(id("value"), "value"), bin("==", id("value"), id("last"))));
    body.push({ k: "write", target: { name: "last", path: [] }, e: id("value") });
  }
  else if (options.previous) body.push(log(lit("apply"), id("value"), member(id("$0"), "previous")));
  else body.push(log(lit("apply"), id("value")));
  body.push({ k: "write", target: { name: "runs", path: [] }, e: options.previous ? id("value") : { k: "fn", params: ["p"], body: bin("+", id("p"), lit(1)) } });
  if (options.cleanup) body.push({ k: "return", e: { k: "fn", params: [], body: lit(undefined), stmts: [log(lit("cleanup"), id("value"))] } });
  decls.push({ k: "effect", inputs: [input], body, line: 6 });
  if (options.lifecycle) {
    const effect = (label: string): Decl => ({ k: "effect", inputs: [id("n")], line: 7, body: [
      { k: "let", name: "value", e: id("$0") }, log(lit(label), id("value")),
      { k: "return", e: { k: "fn", params: [], body: lit(undefined), stmts: [log(lit(label + "-cleanup"), id("value"))] } },
    ] });
    decls.push(effect("sibling"), { k: "component", name: "Child", props: "props", decls: [effect("child-a"), effect("child-b")], view: [], line: 8 });
  }
  return { decls, view: [{ k: "read", e: id("n") }, { k: "text", s: "/" }, { k: "read", e: id("runs") },
    ...(options.lifecycle ? [{ k: "el" as const, tag: "Child", attrs: [], children: [] }] : []),
  ] };
}

async function backends(p: Program, changes = steps): Promise<{ interpreter: Trace; compiled: Trace }> {
  assert.deepEqual(check(p), []);
  const rt = new Runtime(p);
  const interpreted = [rt.step([]).at(-1)!.frame]; const phases = [[...rt.log]];
  for (const change of changes) {
    const frames = "n" in change ? rt.step([{ node: rt.findNode("n")!, path: [], value: change.n }]) : rt.land("question", change.land);
    interpreted.push(frames.at(-1)!.frame); phases.push([...rt.log]);
  }
  rt.root.dispose(); rt.step([]);
  const interpreter = { frames: interpreted, log: rt.log, phases };
  const out = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(out + "effect-semantics-");
  const renderer = runtimeFiles.stringRenderer;
  try {
    const code = lowerViews(new Map([["main.mjs", compile(p)]]), "universal").get("main.mjs")!;
    const path = dir + "/main.mjs";
    writeFileSync(path, code.replaceAll(STRING_RENDERER, renderer));
    const mod = await import(pathToFileURL(path).href);
    const app = createApp(); const dispose = app.mount(mod.default(app));
    try {
      flush(); await settle(); const frames = [app.frame()]; const phases = [[...app.log]];
      for (const change of changes) {
        if ("n" in change) app.dset("n", [], change.n); else app.flights.get("pending")!.resolve(change.land);
        flush(); await settle(); frames.push(app.frame()); phases.push([...app.log]);
      }
      return { interpreter, compiled: { frames, log: app.log, phases } };
    } finally { dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("plain Solid effects rerun for equal computes while RX effects keep EF-2 filtering", async () => {
  const expected = await native();
  assert.deepEqual(expected.frames, every);
  const actual = await backends(program("none"));
  assert.deepEqual(actual.interpreter.frames, changed);
  assert.deepEqual(actual.compiled.frames, changed);
});

test("RX effects over a memo equality cut match Solid's effect", async () => {
  const expected = await native({ memo: true });
  assert.deepEqual(expected.frames, changed);
  const actual = await backends(program("none", { memo: true }));
  assert.deepEqual(actual.interpreter, expected);
  assert.deepEqual(actual.compiled, expected);
});

test("RX effect disposal follows Solid's reverse ownership order across sibling and nested effects", async () => {
  const options = { cleanup: true, lifecycle: true };
  const expected = await native(options);
  const actual = await backends(program("none", options));
  // EF-2 skips Solid's equal-value reruns, so only the disposal order is compared.
  const order = ["log(child-b-cleanup, 4)", "log(child-a-cleanup, 4)", "log(sibling-cleanup, 4)", "log(cleanup, true)"];
  assert.deepEqual(expected.log.slice(-4), order);
  assert.deepEqual(actual.interpreter.log.slice(-4), order);
  assert.deepEqual(actual.compiled.log.slice(-4), order);
});

test("a compute previous parameter uses a named packet equation, not the previous apply result", async () => {
  const expected = await native({ previous: true, cleanup: true });
  assert.deepEqual(expected.frames, ["0/0", "1/1", "2/3", "3/6", "4/10"]);
  const actual = await backends(program("identity", { previous: true, cleanup: true }));
  assert.deepEqual(actual.interpreter, expected);
  assert.deepEqual(actual.compiled, expected);
});

test("RX effects retain cleanup through pending and suppress equal recovery, as Solid does", async () => {
  const changes: Step[] = [{ n: 1 }, { land: false }, { n: 2 }];
  const options = { pending: true, cleanup: true };
  const expected = await native(options, changes);
  const actual = await backends(program("none", options), changes);
  assert.deepEqual(expected.frames, ["0/1", "1/1", "1/1", "2/1"]);
  assert.deepEqual(actual.interpreter, expected);
  assert.deepEqual(actual.compiled, expected);
  assert.deepEqual(expected.phases[1], ["log(apply, false)"]);
  assert.deepEqual(actual.interpreter.phases[1], expected.phases[1]);
});

test("RX effects apply changed async answers once after pending, as Solid does", async () => {
  const changes: Step[] = [{ n: 1 }, { land: true }, { n: 2 }];
  const options = { pending: true, cleanup: true };
  const expected = await native(options, changes);
  const actual = await backends(program("none", options), changes);
  assert.deepEqual(actual.interpreter, expected);
  assert.deepEqual(actual.compiled, expected);
});

test("RX effects apply the first async answer after mounting pending, as Solid does", async () => {
  const changes: Step[] = [{ land: false }, { n: 2 }];
  const options = { pending: true, cleanup: true, initial: 1 };
  const expected = await native(options, changes);
  const actual = await backends(program("none", options), changes);
  assert.deepEqual(actual.interpreter, expected); assert.deepEqual(actual.compiled, expected);
});

test("ordinary RX effects still deliver compute errors as answers", async () => {
  const actual = await backends(program("none", { errors: true }), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(actual.interpreter.frames, ["0/1", "1/2", "2/3"]);
  assert.deepEqual(actual.compiled, actual.interpreter);
});

for (const nested of [false, true]) test(`${nested ? "nested filtered" : "matching"} boundary payloads update without remounting fallback snapshots and state`, async () => {
  const error = member(id("props"), "error");
  const fallback: Decl = { k: "component", name: "Fallback", props: "props", line: 4, decls: [
    { k: "source", name: "captured", init: { k: "peek", e: member(error, "id") }, line: 5 },   // a mount snapshot (E-4)
    { k: "source", name: "local", init: lit(10), line: 6 },
    { k: "effect", inputs: [id("captured")], line: 7, body: [
      log(lit("enter"), id("captured")),
      { k: "write", target: { name: "local", path: [] }, e: { k: "fn", params: ["p"], body: bin("+", id("p"), lit(1)) } },
      { k: "return", e: { k: "fn", params: [], body: lit(undefined), stmts: [log(lit("leave"), id("captured"))] } },
    ] },
  ], view: [
    { k: "read", e: member(error, "id") }, { k: "text", s: "/" },
    { k: "read", e: id("captured") }, { k: "text", s: "/" }, { k: "read", e: id("local") },
  ] };
  const result: Expr = { k: "if", c: id("n"), t: { k: "throw", e: call("Missing", id("n")) }, f: lit("ok") };
  const content: Markup[] = [{ k: "read", e: id("result") }];
  const p: Program = { decls: [
    { k: "error", name: "Missing", params: ["id"], msg: bin("+", lit("Missing "), id("id")), line: 1 },
    { k: "error", name: "Denied", params: [], msg: lit("Denied"), line: 1 },
    { k: "source", name: "n", init: lit(0), line: 2 },
    { k: "eq", name: "result", e: nested ? { k: "if", c: bin("==", id("n"), lit(4)), t: { k: "throw", e: call("Denied") }, f: result } : result, line: 3 },
    fallback,
  ], view: [{
    k: "errored", classes: ["Missing"], errName: "err", decls: [],
    fallback: [{ k: "el", tag: "Fallback", attrs: [{ name: "error", e: id("err") }], children: [] }],
    body: nested ? [{ k: "errored", classes: ["Denied"], errName: "other", decls: [], body: content, fallback: [{ k: "read", e: member(id("other"), "message") }] }] : content,
  }] };
  const changes = (nested ? [1, 2, 0, 4, 5] : [1, 2, 0, 3]).map(n => ({ n }));
  const actual = await backends(p, changes);
  assert.deepEqual(actual.interpreter.frames, nested ? ["ok", "1/1/11", "2/1/11", "ok", "Denied", "5/5/11"] : ["ok", "1/1/11", "2/1/11", "ok", "3/3/11"]);
  assert.deepEqual(actual.interpreter.log, nested ? ["log(enter, 1)", "log(leave, 1)", "log(enter, 5)", "log(leave, 5)"] : ["log(enter, 1)", "log(leave, 1)", "log(enter, 3)", "log(leave, 3)"]);
  assert.deepEqual(actual.compiled, actual.interpreter);
});
