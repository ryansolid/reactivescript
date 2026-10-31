import { test } from "node:test";
import { runtimeFiles } from "./rx/runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEffect, createMemo, createRoot, createSignal, flush } from "solid-js";
import { createRxEffect, RX_ERROR } from "./effects.ts";
import { parseProgram } from "./rx/compiler.ts";
import { check } from "./rx/compiler.ts";
import { Runtime } from "./rx/runtime.ts";
import { compile } from "./rx/compiler.ts";
import { lowerViews, STRING_RENDERER } from "./rx/compiler.ts";
import { createApp } from "./rx/runtime.ts";

const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 0)); flush();
  await new Promise(resolve => setTimeout(resolve, 0)); flush();
};

test("RX effects equality-filter direct inputs without disposing their cleanup", () => {
  const events: string[] = [];
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(0);
    createRxEffect([() => n() > 2], value => {
      events.push(`apply ${value}`);
      return () => { events.push(`cleanup ${value}`); };
    });
    return { dispose, setN };
  });
  try {
    flush();
    for (const n of [1, 2]) { app.setN(n); flush(); }
    assert.deepEqual(events, ["apply false"]);
    app.setN(3); flush();
    app.setN(4); flush();
    assert.deepEqual(events, ["apply false", "cleanup false", "apply true"]);
  } finally { app.dispose(); }
  assert.deepEqual(events, ["apply false", "cleanup false", "apply true", "cleanup true"]);
});

test("RX effects isolate synchronous and upstream errors per input and recover", async () => {
  const values: unknown[][] = [];
  const events: string[] = [];
  const phases: string[][] = [];
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(0);
    const upstream = createMemo(() => { if (n() === 2 || n() === 3) throw new Error(`upstream ${n()}`); return n(); });
    createRxEffect([() => { if (n() === 1 || n() === 3) throw new Error(`direct ${n()}`); return n(); }, upstream, () => "healthy"], (...answer) => {
      values.push(answer); events.push(`log(apply, ${answer.map(String).join(", ")})`);
      return () => { events.push(`log(cleanup, ${answer.map(String).join(", ")})`); };
    });
    return { dispose, setN };
  });
  try {
    flush(); phases.push([...events]);
    for (const n of [1, 2, 3, 0]) { app.setN(n); flush(); phases.push([...events]); }
    assert.deepEqual(values, [[0, 0, "healthy"], [RX_ERROR, 1, "healthy"], [2, RX_ERROR, "healthy"], [RX_ERROR, RX_ERROR, "healthy"], [0, 0, "healthy"]]);
    assert.equal(String(RX_ERROR), "#error");
    assert.equal(values[1][0], values[3][0]);
    assert.equal(values[2][1], values[3][1]);
  } finally { app.dispose(); }
  phases.push([...events]);
  assert.equal(events.at(-1), "log(cleanup, 0, 0, healthy)");
  const actual = await rxTraces(`error Boom(n) => "boom"; source n := 0;
    left = n == 1 || n == 3 ? throw Boom(n) : n;
    right = n == 2 || n == 3 ? throw Boom(n) : n;
    effect(left, right, "healthy") { let a = $0; let b = $1; let c = $2; log("apply", a, b, c); return () => { log("cleanup", a, b, c); }; }`, [1, 2, 3, 0]);
  assert.deepEqual(actual.compiled, phases);
  assert.deepEqual(actual.interpreter, phases);
});

test("consecutive RX error answers compare equal and retain cleanup", () => {
  const events: string[] = [];
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(0);
    createRxEffect([() => { if (n() > 0) throw new Error(String(n())); return 0; }], value => {
      events.push(`apply ${value}`); return () => { events.push(`cleanup ${value}`); };
    });
    return { dispose, setN };
  });
  try {
    flush();
    for (const n of [1, 2, 3]) { app.setN(n); flush(); }
    assert.deepEqual(events, ["apply 0", "cleanup 0", "apply #error"]);
    app.setN(0); flush();
    assert.deepEqual(events, ["apply 0", "cleanup 0", "apply #error", "cleanup #error", "apply 0"]);
  } finally { app.dispose(); }
});

for (const answer of [false, true, "reject"] as const) test(`RX effects preserve cleanup through pending then ${answer}`, async () => {
  const events: string[] = [];
  let resolve!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const waiting = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(0);
    const value = createMemo(() => n() === 1 ? waiting : false);
    createRxEffect([value, () => "healthy"], (next, healthy) => {
      events.push(`apply ${next}/${healthy}`);
      return () => { events.push(`cleanup ${next}/${healthy}`); };
    });
    return { dispose, setN };
  });
  try {
    flush(); await settle();
    app.setN(1); flush(); await settle();
    assert.deepEqual(events, ["apply false/healthy"]);
    if (answer === "reject") reject(new Error("async failure")); else resolve(answer);
    await settle();
    const expected = answer === "reject" ? "#error" : String(answer);
    assert.deepEqual(events, answer === false ? ["apply false/healthy"] : ["apply false/healthy", "cleanup false/healthy", `apply ${expected}/healthy`]);
    app.setN(2); flush(); await settle();
    assert.equal(events.at(-1), "apply false/healthy");
  } finally { app.dispose(); }
  assert.equal(events.at(-1), "cleanup false/healthy");
});

test("RX effects skip a pending mount, including an earlier errored input", async () => {
  const values: unknown[][] = [];
  let resolve!: (value: number) => void;
  const waiting = new Promise<number>(yes => { resolve = yes; });
  const dispose = createRoot(dispose => {
    const pending = createMemo(() => waiting);
    createRxEffect([() => { throw new Error("first"); }, pending], (...answer) => { values.push(answer); });
    return dispose;
  });
  try {
    flush(); await settle();
    assert.deepEqual(values, []);
    resolve(7); await settle();
    assert.deepEqual(values, [[RX_ERROR, 7]]);
  } finally { dispose(); }
});

test("RX effects do not flatten array/function answers and compare inputs with Object.is", () => {
  const values: unknown[][] = [];
  const fn = () => { throw new Error("function answers must not be called"); };
  const array = [fn];
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(0);
    createRxEffect([() => { n(); return array; }, () => fn, () => n() === 0 ? NaN : n() === 1 ? NaN : n() === 2 ? 0 : -0], (...answer) => { values.push(answer); });
    return { dispose, setN };
  });
  try {
    flush();
    for (const n of [1, 2, 3]) { app.setN(n); flush(); }
    assert.deepEqual(values, [[array, fn, NaN], [array, fn, 0], [array, fn, -0]]);
  } finally { app.dispose(); }
});

test("RX input equations are cached independently, including function and array allocations", async () => {
  const events: string[] = [];
  let arrays = 0, functions = 0;
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(0);
    createRxEffect([() => n() > 2, () => { arrays++; return [7]; }, () => { functions++; return () => 7; }], (value, array, fn) => {
      assert.ok(Array.isArray(array)); assert.ok(typeof fn === "function");
      events.push(`log(${value}, ${array[0]}, ${fn()})`);
    });
    return { dispose, setN };
  });
  const native: string[][] = [];
  try {
    flush(); native.push([...events]);
    for (const n of [1, 2, 3, 4]) { app.setN(n); flush(); native.push([...events]); }
    assert.equal(arrays, 1); assert.equal(functions, 1);
  } finally { app.dispose(); }
  native.push([...events]);
  const expected = [["log(false, 7, 7)"], ["log(false, 7, 7)"], ["log(false, 7, 7)"], ["log(false, 7, 7)", "log(true, 7, 7)"], ["log(false, 7, 7)", "log(true, 7, 7)"], ["log(false, 7, 7)", "log(true, 7, 7)"]];
  const actual = await rxTraces(`source n := 0; effect(n > 2, [7], () => 7) { log($0, $1[0], $2()); }`, [1, 2, 3, 4]);
  assert.deepEqual(native, expected);
  assert.deepEqual(actual.interpreter, expected);
  assert.deepEqual(actual.compiled, expected);
});

test("RX effects retain cleanup when pending is disposed and never apply a late landing", async () => {
  const events: string[] = [];
  let resolve!: (value: boolean) => void;
  const waiting = new Promise<boolean>(yes => { resolve = yes; });
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(0);
    createRxEffect([() => n() === 1 ? waiting : false], value => {
      events.push(`apply ${value}`); return () => { events.push(`cleanup ${value}`); };
    });
    return { dispose, setN };
  });
  try {
    flush(); app.setN(1); flush(); await settle();
    assert.deepEqual(events, ["apply false"]);
  } finally { app.dispose(); }
  resolve(true); await settle();
  assert.deepEqual(events, ["apply false", "cleanup false"]);
});

for (const other of [0, 1]) test(`a pending RX tuple compares every input with its last received tuple (${other})`, async () => {
  const events: string[] = [];
  let resolve!: (value: boolean) => void;
  const waiting = new Promise<boolean>(yes => { resolve = yes; });
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(0);
    const [other, setOther] = createSignal(0);
    createRxEffect([() => n() === 1 ? waiting : false, other], (a, b) => {
      events.push(`apply ${a}/${b}`); return () => { events.push(`cleanup ${a}/${b}`); };
    });
    return { dispose, setN, setOther };
  });
  try {
    flush(); app.setN(1); flush(); app.setOther(1); flush(); app.setOther(other); flush();
    assert.deepEqual(events, ["apply false/0"]);
    resolve(false); await settle();
    assert.deepEqual(events, other === 0 ? ["apply false/0"] : ["apply false/0", "cleanup false/0", "apply false/1"]);
  } finally { app.dispose(); }
  assert.equal(events.at(-1), `cleanup false/${other}`);
});

test("native RX effects compute but never apply or allocate client boundaries during SSR", () => {
  const script = `import { createRoot, flush } from "solid-js";
    import { createRxEffect } from ${JSON.stringify(new URL("./effects.ts", import.meta.url).href)};
    const events = [];
    const dispose = createRoot(dispose => {
      createRxEffect([() => { events.push("compute"); throw new Error("boom"); }, () => 7], () => { events.push("apply"); return () => { events.push("cleanup"); }; });
      return dispose;
    });
    flush(); dispose(); console.log(JSON.stringify(events));`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--conditions=development", "--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), ["compute"]);
});

test("RX apply reads are untracked, zero-input effects mount once, and native effects stay native", () => {
  const snapshots: number[] = [];
  const native: boolean[] = [];
  let mounts = 0;
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(0);
    const [other, setOther] = createSignal(0);
    createRxEffect([], () => { mounts++; });
    createRxEffect([() => n() > 2], () => { snapshots.push(other()); });
    createEffect(() => n() > 2, value => { native.push(value); });
    return { dispose, setN, setOther };
  });
  try {
    flush();
    app.setOther(5); flush();
    for (const n of [1, 2, 3, 4]) { app.setN(n); flush(); }
    assert.equal(mounts, 1);
    assert.deepEqual(snapshots, [0, 5]);
    assert.deepEqual(native, [false, false, false, true, true]);
  } finally { app.dispose(); }
});

test("RX effect cleanup follows reverse sibling and nested ownership, even after equal inputs", async () => {
  const events: string[] = [];
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(0);
    const effect = (label: string) => createRxEffect([() => n() > 2], value => {
      events.push(`log(apply, ${label}, ${value})`);
      return () => { events.push(`log(cleanup, ${label}, ${value})`); };
    });
    effect("first"); effect("second");
    createRoot(() => { effect("child-a"); effect("child-b"); });
    return { dispose, setN };
  });
  flush(); const phases = [[...events]]; app.setN(1); flush(); phases.push([...events]);
  app.dispose();
  phases.push([...events]);
  assert.deepEqual(events.slice(-4), ["log(cleanup, child-b, false)", "log(cleanup, child-a, false)", "log(cleanup, second, false)", "log(cleanup, first, false)"]);
  const effect = (label: string) => `effect(n > 2) { let value = $0; log("apply", "${label}", value); return () => { log("cleanup", "${label}", value); }; }`;
  const actual = await rxTraces(`source n := 0;
    component Child() { ${effect("child-a")} ${effect("child-b")} }
    ${effect("first")} ${effect("second")} export default component App() { <Child/> }`, [1]);
  assert.deepEqual(actual.compiled, phases);
  assert.deepEqual(actual.interpreter, phases);
});

type Step = number | { land: boolean } | { reject: string };
async function rxTraces(source: string, steps: Step[]) {
  const program = parseProgram(source);
  assert.deepEqual(check(program), []);
  const rt = new Runtime(program);
  rt.step([]);
  const interpreter = [[...rt.log]];
  for (const step of steps) {
    if (typeof step === "number") rt.step([{ node: rt.findNode("n")!, path: [], value: step }]);
    else if ("land" in step) rt.land("question", step.land);
    else rt.land("question", step.reject, true);
    interpreter.push([...rt.log]);
  }
  rt.root.dispose(); rt.step([]); interpreter.push([...rt.log]);
  const out = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(out + "rx-effects-");
  try {
    const renderer = runtimeFiles.stringRenderer;
    const code = lowerViews(new Map([["main.mjs", compile(program)]]), "universal").get("main.mjs")!;
    const path = dir + "/main.mjs";
    writeFileSync(path, code.replaceAll(STRING_RENDERER, renderer));
    const mod = await import(pathToFileURL(path).href);
    const app = createApp(); const dispose = app.mount(mod.default(app));
    const compiled: string[][] = [];
    try {
      flush(); await settle(); compiled.push([...app.log]);
      for (const step of steps) {
        if (typeof step === "number") app.dset("n", [], step);
        else {
          const flight = app.flights.get("question");
          assert.ok(flight, "authored RX question must be pending");
          if ("land" in step) flight.resolve(step.land); else flight.reject(new Error(step.reject));
        }
        flush(); await settle(); compiled.push([...app.log]);
      }
    } finally { dispose(); flush(); }
    compiled.push([...app.log]);
    return { interpreter, compiled };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("authored RX and native RX effects retain cleanup on equal direct computes", async () => {
  const expected = [["log(apply, false)"], ["log(apply, false)"], ["log(apply, false)"], ["log(apply, false)", "log(cleanup, false)", "log(apply, true)"], ["log(apply, false)", "log(cleanup, false)", "log(apply, true)"], ["log(apply, false)", "log(cleanup, false)", "log(apply, true)", "log(cleanup, true)"]];
  const actual = await rxTraces(`source n := 0;
    effect(n > 2) { let value = $0; log("apply", value); return () => { log("cleanup", value); }; }`, [1, 2, 3, 4]);
  assert.deepEqual(actual.interpreter, expected);
  assert.deepEqual(actual.compiled, expected);
});

test("authored RX effects deliver per-input error answers and filter consecutive errors", async () => {
  const actual = await rxTraces(`error Boom(n) => "boom";
    source n := 0;
    left = n > 0 ? throw Boom(n) : 0;
    effect(left, "healthy") { let value = $0; let other = $1; log("apply", value, other); return () => { log("cleanup", value, other); }; }`, [1, 2, 0]);
  const initial = ["log(apply, 0, healthy)"];
  const failed = [...initial, "log(cleanup, 0, healthy)", "log(apply, #error, healthy)"];
  const recovered = [...failed, "log(cleanup, #error, healthy)", "log(apply, 0, healthy)"];
  const expected = [initial, failed, failed, recovered, [...recovered, "log(cleanup, 0, healthy)"]];
  assert.deepEqual(actual.compiled, expected);
  assert.deepEqual(actual.interpreter, expected);
});

test("RX effect errors are opaque answers for string coercion and equality", async () => {
  const values: unknown[][] = [];
  const dispose = createRoot(dispose => {
    const input = () => { throw new Error("boom"); };
    createRxEffect([input, input], (a, b) => { values.push([String(a), a === b]); });
    return dispose;
  });
  try { flush(); assert.deepEqual(values, [["#error", true]]); } finally { dispose(); }
  const actual = await rxTraces(`error Boom() => "boom";
    source n := 0;
    failed = throw Boom();
    effect(failed, failed) { log("" + $0, $0 == $1); }`, []);
  const expected = [["log(#error, true)"], ["log(#error, true)"]];
  assert.deepEqual(actual.compiled, expected);
  assert.deepEqual(actual.interpreter, expected);
});

for (const answer of [false, true, "reject"] as const) test(`authored RX pending then ${answer} preserves the native RX lifecycle`, async () => {
  const actual = await rxTraces(`source n := 0;
    question = n == 1 ? await fetch("question") : false;
    effect(question, "healthy") { let value = $0; let other = $1; log("apply", value, other); return () => { log("cleanup", value, other); }; }`, [1, answer === "reject" ? { reject: "boom" } : { land: answer }, 2]);
  const initial = ["log(apply, false, healthy)"];
  const landed = answer === false ? initial : [...initial, "log(cleanup, false, healthy)", `log(apply, ${answer === "reject" ? "#error" : answer}, healthy)`];
  const recovered = answer === false ? initial : [...landed, `log(cleanup, ${answer === "reject" ? "#error" : answer}, healthy)`, "log(apply, false, healthy)"];
  const expected = [initial, initial, landed, recovered, [...recovered, "log(cleanup, false, healthy)"]];
  assert.deepEqual(actual.interpreter, expected);
  assert.deepEqual(actual.compiled, expected);
});
