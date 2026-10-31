import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Errored, Loading, Show, createComponent, createEffect, createMemo, createProjection,
  createRoot, createSignal, flush, onCleanup, type Accessor, type Element,
} from "solid-js";
import { createPrevious } from "reactivescript-tsx";
import { parseProgram, parseStmts } from "./rx/compiler.ts";
import { check } from "./rx/compiler.ts";
import { Runtime } from "./rx/runtime.ts";
import { compile } from "./rx/compiler.ts";
import { lowerViews, STRING_RENDERER } from "./rx/compiler.ts";
import { createApp } from "./rx/runtime.ts";
import { R, serialize } from "./rx/runtime.ts";
import { lowerTsx } from "./lower.ts";
import { traces } from "./test-utils.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function text(read: () => unknown) {
  const node = R.createElement("span");
  R.insert(node, read);
  return node;
}

function mount(view: () => Element, host: ReturnType<typeof R.createElement>) {
  return R.render(() => text(view), host);
}

type Writes = [string, number | boolean][][];
async function assertCore(source: string, writes: Writes, expected: string[], effects: string[] = [], interpreterExpected = expected) {
  const program = parseProgram(source);
  assert.deepEqual(check(program), []);
  const runtime = new Runtime(program);
  try {
    const first = runtime.step([]);
    const frames = [first.at(-1)!.frame], log = first.flatMap(instant => instant.effects);
    for (const instant of writes) {
      const trace = runtime.handler(parseStmts(instant.map(([name, value]) => name + " := " + String(value)).join(";")));
      frames.push(trace.at(-1)!.frame); log.push(...trace.flatMap(instant => instant.effects));
    }
    assert.deepEqual(frames, interpreterExpected, "raw RX interpreter");
    assert.deepEqual(log, effects, "raw RX interpreter effects");
  } finally { runtime.root.dispose(); }
  const out = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(out + "tsx-previous-core-");
  try {
    const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
    const code = lowerViews(new Map([["main.mjs", compile(program)]]), "universal").get("main.mjs")!;
    writeFileSync(dir + "/main.mjs", code.replaceAll(STRING_RENDERER, renderer));
    const module = await import(pathToFileURL(dir + "/main.mjs").href);
    const app = createApp(), dispose = app.mount(module.default(app));
    try {
      flush(); const frames = [app.frame()];
      for (const instant of writes) {
        for (const [name, value] of instant) app.dset(name, [], value);
        flush(); frames.push(app.frame());
      }
      assert.deepEqual(frames, expected, "raw RX compiled");
      assert.deepEqual(app.log, effects, "raw RX compiled effects");
    } finally { dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("native S-core-1 previous values survive equal writes, batching, and hiding the current reader", async () => {
  const expected = ["0 prev 0", "2 prev 0", "2 prev 0", "14 prev 2", "- prev 2", "- prev 14"];
  const effects = ["log(0)", "log(2)", "log(14)", "log(16)"];
  const writes: Writes = [[["count", 1]], [["count", 1]], [["count", 5], ["count", 7]], [["show", false]], [["count", 8]]];
  for (const withEffect of [false, true]) {
    const computed: number[] = [], log: string[] = [];
    const app = createRoot(dispose => {
      const [count, setCount] = createSignal(0), [show, setShow] = createSignal(true);
      const double = createMemo(() => { const n = count(); computed.push(n); return n * 2; });
      const previous = createPrevious(double, () => 0);
      const label = createMemo(() => "prev " + previous());
      if (withEffect) createEffect(() => double(), value => { log.push("log(" + value + ")"); });
      const frame = createMemo(() => (show() ? double() : "-") + " " + label());
      return { dispose, setCount, setShow, frame };
    });
    try {
      flush(); const frames = [app.frame()];
      app.setCount(1); flush(); frames.push(app.frame());
      app.setCount(1); flush(); frames.push(app.frame());
      app.setCount(5); app.setCount(7); flush(); frames.push(app.frame());
      app.setShow(false); flush(); frames.push(app.frame());
      app.setCount(8); flush(); frames.push(app.frame());
      assert.deepEqual(frames, expected);
      assert.deepEqual(computed, [0, 1, 7, 8]);
      assert.deepEqual(log, withEffect ? effects : []);
    } finally { app.dispose(); }
    await assertCore('source count := 0; source show := true; double = count * 2; label = "prev " + pre double -> 0; ' +
      (withEffect ? 'effect (double) {log(double)} ' : '') + 'export default component App() { <p>{show ? double : "-"} {label}</p> }', writes, expected, withEffect ? effects : []);
  }
});

test("a same-setup companion retains history before the previous accessor is first displayed", async () => {
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(0);
    const double = createMemo(() => n() * 2);
    const previous = createPrevious(double, () => 0);
    const frame = createMemo(() => double() + "/" + (n() >= 3 ? previous() : "-"));
    return { dispose, setN, frame };
  });
  const expected = ["0/-", "2/-", "4/-", "6/4", "8/6"];
  try {
    const frames = [app.frame()];
    for (const n of [1, 2, 3, 4]) { app.setN(n); flush(); frames.push(app.frame()); }
    assert.deepEqual(frames, expected);
  } finally { app.dispose(); }
  await assertCore('source n := 0; double = n * 2; export default component App() { <p>{double}/{n >= 3 ? pre double -> 0 : "-"}</p> }',
    [[["n", 1]], [["n", 2]], [["n", 3]], [["n", 4]]], expected);
});

test("a companion created later cannot reconstruct an inherited target's earlier history", () => {
  const target = createRoot(dispose => {
    const [n, setN] = createSignal(0), double = createMemo(() => n() * 2);
    return { dispose, setN, double };
  });
  let disposePrevious = () => {};
  try {
    assert.equal(target.double(), 0);
    target.setN(1); flush(); assert.equal(target.double(), 2);
    target.setN(2); flush(); assert.equal(target.double(), 4);
    const previous = createRoot(dispose => { disposePrevious = dispose; return createPrevious(target.double, () => -1); });
    assert.equal(previous(), -1);
    target.setN(3); flush(); assert.equal(previous(), 4);
  } finally { disposePrevious(); target.dispose(); }
});

test("same-owner Show demand preserves warm history and records the existing cold-target baseline divergence", async t => {
  for (const displayCurrent of [true, false]) {
    const host = R.createElement("main"), computed: number[] = [];
    let setN!: (n: number) => void, setShown!: (shown: boolean) => void;
    const dispose = mount(() => {
      const [n, update] = createSignal(0), [shown, show] = createSignal(false); setN = update; setShown = show;
      const input = createMemo(() => { computed.push(n()); return n() * 2; });
      const previous = createPrevious(input, () => -1);
      return [text(() => displayCurrent ? input() : "-"), "|", createComponent(Show<boolean>, {
        get when() { return shown(); }, fallback: "-", get children() { return text(previous); },
      })];
    }, host);
    const expected = displayCurrent ? ["0|-", "2|-", "4|-", "4|2"] : ["-|-", "-|-", "-|-", "-|2"];
    try {
      flush(); const frames = [serialize(host)];
      setN(1); flush(); frames.push(serialize(host));
      setN(2); flush(); frames.push(serialize(host));
      assert.deepEqual(computed, [0, 1, 2], "pinned Solid eagerly maintains the packet input even when hidden");
      setShown(true); flush(); frames.push(serialize(host));
      assert.deepEqual(frames, expected);
    } finally { dispose(); }
    const interpreted = displayCurrent ? expected : ["-|-", "-|-", "-|-", "-|-1"];
    if (!displayCurrent) t.diagnostic("Existing cold-target demand divergence: native/compiled reveal previous 2; interpreter first demands input on reveal and uses fallback -1.");
    await assertCore('source n := 0; source shown := false; double = n * 2; previous = pre double -> -1; export default component App() { <p>' +
      (displayCurrent ? '{double}' : '-') + '|{shown ? previous : "-"}</p> }',
      [[["n", 1]], [["n", 2]], [["shown", true]]], expected, [], interpreted);
  }
});

test("previous follows original memo equality cuts rather than every upstream write or accessor read", async () => {
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(0);
    const current = createMemo(() => n() >= 2 ? 1 : 0);
    const previous = createPrevious(current, () => -1);
    return { dispose, setN, current, previous };
  });
  const expected = ["0/-1", "0/-1", "1/0", "1/0", "1/0", "0/1"];
  try {
    const frame = () => app.current() + "/" + app.previous();
    const frames = [frame()];
    assert.equal(app.previous(), -1); assert.equal(app.previous(), -1);
    for (const n of [1, 2, 3, 3, 0]) { app.setN(n); flush(); frames.push(frame()); }
    assert.deepEqual(frames, expected);
  } finally { app.dispose(); }
  await assertCore('source n := 0; current = n >= 2 ? 1 : 0; export default component App() { <p>{current}/{pre current -> -1}</p> }',
    [[["n", 1]], [["n", 2]], [["n", 3]], [["n", 3]], [["n", 0]]], expected);
});

test("chained previous accessors equality-cut repeated intermediate answers", async () => {
  const app = createRoot(dispose => {
    const [x, setX] = createSignal(0);
    const previous = createPrevious(x, () => 0), twice = createPrevious(previous, () => -1);
    return { dispose, setX, frame: () => x() + "/" + previous() + "/" + twice() };
  });
  const expected = ["0/0/-1", "1/0/-1", "2/1/0", "3/2/1"];
  try {
    const frames = [app.frame()];
    for (const x of [1, 2, 3]) { app.setX(x); flush(); frames.push(app.frame()); }
    assert.deepEqual(frames, expected);
  } finally { app.dispose(); }
  await assertCore('source x := 0; previous = pre x -> 0; twice = pre previous -> -1; export default component App() { <p>{x}/{previous}/{twice}</p> }',
    [[["x", 1]], [["x", 2]], [["x", 3]]], expected);
  const source = 'import {createSignal} from "solid-js";import {createPrevious} from "reactivescript-tsx";export function Counter(){const [x,setX]=createSignal(0);const previous=createPrevious(x,()=>0);const twice=createPrevious(previous,()=>-1);return <button onClick={()=>setX(x()+1)}>{x()}/{previous()}/{twice()}</button>}';
  await traces(source, lowerTsx(source), expected);
});

test("seeded previous falls back on undefined history values, but never on null", async () => {
  for (const initial of ["undefined", "null"]) {
    const expected = initial === "undefined" ? ["undefined/99", "1/99", "2/1"] : ["null/99", "1/null", "2/1"];
    const source = 'import {createSignal,createMemo} from "solid-js";import {createPrevious} from "reactivescript-tsx";export function Counter(){const [n,setN]=createSignal(0);const current=createMemo(()=>n()===0?' + initial + ':n());const previous=createPrevious(current,()=>99);return <button onClick={()=>setN(n()+1)}>{current()===' + initial + '?"' + initial + '":current()}/{previous()===' + initial + '?"' + initial + '":previous()}</button>}';
    await traces(source, lowerTsx(source), expected);
    await assertCore('source x := ' + initial + '; previous = pre x -> 99; export default component App() { <p>{x == ' + initial + ' ? "' + initial + '" : x}/{previous == ' + initial + ' ? "' + initial + '" : previous}</p> }',
      [[["x", 1]], [["x", 2]]], expected);
  }
});

test("source previous coalesces multiple writes in one handler", async () => {
  const source = 'import {createSignal} from "solid-js";import {createPrevious} from "reactivescript-tsx";export function Counter(){const [x,setX]=createSignal(0);const [step,setStep]=createSignal(0);const previous=createPrevious(x,()=>99);return <button onClick={()=>{if(step()===0)setX(1);else{setX(5);setX(7)}setStep(step()+1)}}>{x()}/{previous()}</button>}';
  const expected = ["0/99", "1/0", "7/1"];
  await traces(source, lowerTsx(source), expected);
  await assertCore('source x := 0; previous = pre x -> 99; export default component App() { <p>{x}/{previous}</p> }', [[["x", 1]], [["x", 5], ["x", 7]]], expected);
});

test("same-setup history can be consumed later, but inherited targets fail closed at setup", async () => {
  const prefix = 'import {createSignal,createMemo,Show} from "solid-js";import {createPrevious} from "reactivescript-tsx";const [n,setN]=createSignal(0);const double=createMemo(()=>n()*2);';
  const tail = 'export function Counter(){const [shown,setShown]=createSignal(false);const [step,setStep]=createSignal(0);return <button onClick={()=>{if(step()===0)setN(1);else if(step()===1)setN(2);else setShown(true);setStep(step()+1)}}>{double()}|<Show when={shown()} fallback="-"><Panel/></Show></button>}';
  const legal = prefix + 'const previous=createPrevious(double,()=>-1);function Panel(){return <span>{previous()}</span>}' + tail;
  await traces(legal, lowerTsx(legal), ["0|-", "2|-", "4|-", "4|2"]);
  const inherited = prefix + 'function Panel(){const previous=createPrevious(double,()=>-1);return <span>{previous()}</span>}' + tail;
  assert.throws(() => lowerTsx(inherited), /same owned setup/);
});

test("unseeded history is undefined and the public overloads preserve accessor result types", () => {
  const app = createRoot(dispose => {
    const [input, setInput] = createSignal(1);
    const previous: Accessor<number | undefined> = createPrevious(input);
    const seeded: Accessor<number> = createPrevious(input, () => 0);
    const optionalFallback: (() => number) | undefined = undefined;
    const optional: Accessor<number | undefined> = createPrevious(input, optionalFallback);
    // @ts-expect-error Unseeded history must not promise a number, or widen to any.
    const invalid: Accessor<number> = createPrevious(input);
    assert.equal(typeof invalid, "function");
    return { dispose, setInput, previous, seeded, optional };
  });
  try {
    assert.equal(app.previous(), undefined); assert.equal(app.optional(), undefined); assert.equal(app.seeded(), 0);
    app.setInput(2); flush(); assert.equal(app.previous(), 1); assert.equal(app.seeded(), 1);
  } finally { app.dispose(); }
});

test("fallbacks are lazy, caller-tracked, and used whenever the previous value is undefined", () => {
  let calls = 0;
  const app = createRoot(dispose => {
    const [input, setInput] = createSignal<number | undefined>(1), [seed, setSeed] = createSignal(10);
    const previous = createPrevious(input, () => { calls++; return seed(); });
    return { dispose, setInput, setSeed, previous };
  });
  let disposeView = () => {};
  try {
    assert.equal(calls, 0); assert.equal(app.previous(), 10); assert.equal(app.previous(), 10); assert.equal(calls, 1);
    const view = createRoot(dispose => { disposeView = dispose; return createMemo(() => app.previous()); });
    assert.equal(view(), 10);
    app.setSeed(11); flush(); assert.equal(view(), 11);
    app.setInput(2); flush(); assert.equal(view(), 1);
    const settledCalls = calls;
    app.setSeed(20); flush(); assert.equal(view(), 1); assert.equal(calls, settledCalls);
    app.setInput(undefined); flush(); assert.equal(view(), 2); assert.equal(calls, settledCalls);
    app.setInput(3); flush(); assert.equal(view(), 20); assert.equal(calls, settledCalls + 1);
    app.setSeed(30); flush(); assert.equal(view(), 30); assert.equal(calls, settledCalls + 2);
  } finally { disposeView(); app.dispose(); }
});

test("null, false, zero and empty-string previous values do not trigger the fallback", () => {
  let fallbacks = 0;
  const app = createRoot(dispose => {
    const [input, setInput] = createSignal<number | boolean | string | null>(0);
    const previous = createPrevious(input, () => { fallbacks++; return "fallback"; });
    return { dispose, setInput, previous };
  });
  try {
    assert.equal(app.previous(), "fallback");
    for (const [next, expected] of [[false, 0], ["", false], [null, ""], [1, null]] as const) {
      app.setInput(next); flush(); assert.equal(app.previous(), expected);
    }
    assert.equal(fallbacks, 1);
  } finally { app.dispose(); }
});

test("failed input attempts are skipped, and successful equal-value recovery advances the companion", () => {
  const host = R.createElement("main"), failure = new Error("failed");
  let setN!: (n: number) => void, setFailed!: (failed: boolean) => void, fallbacks = 0;
  const dispose = mount(() => {
    const [n, update] = createSignal(1), [failed, fail] = createSignal(false); setN = update; setFailed = fail;
    const input = createMemo(() => { if (failed()) throw failure; return n(); });
    const previous = createPrevious(input, () => { fallbacks++; return 0; });
    return createComponent(Errored, {
      fallback(error: Accessor<unknown>) { assert.equal(error(), failure); return "failed"; },
      get children() { return text(previous); },
    });
  }, host);
  try {
    flush(); assert.equal(serialize(host), "0");
    setN(2); flush(); assert.equal(serialize(host), "1");
    setFailed(true); flush(); assert.equal(serialize(host), "failed");
    setN(3); flush(); assert.equal(serialize(host), "failed");
    setFailed(false); flush(); assert.equal(serialize(host), "2");
    setFailed(true); flush(); assert.equal(serialize(host), "failed");
    setFailed(false); flush(); assert.equal(serialize(host), "3");
    setN(4); flush(); assert.equal(serialize(host), "3"); assert.equal(fallbacks, 1);
  } finally { dispose(); }
});

test("authored and raw RX previous recover from failed current inputs with native packet history", async () => {
  const expected = ["0", "1", "failed", "failed", "2", "failed", "3", "3"];
  const source = 'import {createSignal,createMemo,Errored} from "solid-js";import {createPrevious,defineError,raiseFailure} from "reactivescript-tsx";const Failed=defineError("Failed",[],()=>"failed");function Content(props:{n:number;failed:boolean}){const input=createMemo(()=>props.failed?raiseFailure(Failed()):props.n);const previous=createPrevious(input,()=>0);return <span>{previous()}</span>}export function Counter(){const [n,setN]=createSignal(1);const [failed,setFailed]=createSignal(false);const [step,setStep]=createSignal(0);return <button onClick={()=>{if(step()===0)setN(2);else if(step()===1)setFailed(true);else if(step()===2)setN(3);else if(step()===3)setFailed(false);else if(step()===4)setFailed(true);else if(step()===5)setFailed(false);else setN(4);setStep(step()+1)}}><Errored fallback={_error=><span>failed</span>}><Content n={n()} failed={failed()}/></Errored></button>}';
  await traces(source, lowerTsx(source), expected);
  await assertCore('source n := 1; source failed := false; error Failed() => "failed"; input = failed ? throw Failed() : n; previous = pre input -> 0; export default component App() { <p>{previous catch (error) => "failed"}</p> }',
    [[["n", 2]], [["failed", true]], [["n", 3]], [["failed", false]], [["failed", true]], [["failed", false]], [["n", 4]]], expected);
});

test("initial pending bypasses the fallback and starts history only after the first answer", async () => {
  const host = R.createElement("main"), request = deferred<number>(); let fallbacks = 0;
  const dispose = mount(() => {
    const input = createMemo(() => request.promise);
    const previous = createPrevious(input, () => { fallbacks++; return 0; });
    return createComponent(Loading, { fallback: "waiting", get children() { return text(previous); } });
  }, host);
  try {
    flush(); assert.equal(serialize(host), "waiting"); assert.equal(fallbacks, 0);
    request.resolve(1); await request.promise; flush(); await Promise.resolve(); flush();
    assert.equal(serialize(host), "0"); assert.equal(fallbacks, 1);
  } finally { dispose(); }
});

test("pending recomputes skip history until their answer settles", async () => {
  const host = R.createElement("main"), request = deferred<number>();
  let setN!: (n: number) => void, setWaiting!: (waiting: boolean) => void, fallbacks = 0;
  const dispose = mount(() => {
    const [n, update] = createSignal(1), [waiting, wait] = createSignal(false); setN = update; setWaiting = wait;
    const input = createMemo(() => waiting() ? request.promise : n());
    const previous = createPrevious(input, () => { fallbacks++; return 0; });
    return createComponent(Loading, {
      get on() { return waiting(); }, fallback: "waiting", get children() { return text(previous); },
    });
  }, host);
  try {
    flush(); assert.equal(serialize(host), "0");
    setN(2); flush(); assert.equal(serialize(host), "1");
    setWaiting(true); flush(); assert.equal(serialize(host), "waiting"); assert.equal(fallbacks, 1);
    setN(9); flush(); assert.equal(serialize(host), "waiting");
    request.resolve(3); await request.promise; flush(); await Promise.resolve(); flush();
    assert.equal(serialize(host), "2");
    setWaiting(false); flush(); assert.equal(serialize(host), "3");
    setN(10); flush(); assert.equal(serialize(host), "9"); assert.equal(fallbacks, 1);
  } finally { dispose(); }
});

test("previous companions dispose with their target owner and start fresh on remount", () => {
  const host = R.createElement("main"), values: (number | undefined)[] = [];
  let setN!: (n: number) => void, setShown!: (shown: boolean) => void, cleanups = 0;
  const dispose = mount(() => {
    const [n, update] = createSignal(0), [shown, show] = createSignal(true); setN = update; setShown = show;
    const Child = () => {
      const input = createMemo(() => n()), previous = createPrevious(input, () => -1);
      createEffect(() => previous(), value => { values.push(value); }); onCleanup(() => { cleanups++; });
      return text(previous);
    };
    return createComponent(Show<boolean>, {
      get when() { return shown(); }, fallback: "-", get children() { return createComponent(Child, {}); },
    });
  }, host);
  try {
    flush(); assert.equal(serialize(host), "-1");
    setN(1); flush(); assert.equal(serialize(host), "0");
    setShown(false); flush(); assert.equal(serialize(host), "-"); assert.equal(cleanups, 1);
    setN(4); flush(); assert.deepEqual(values, [-1, 0]);
    setShown(true); flush(); assert.equal(serialize(host), "-1");
    setN(5); flush(); assert.equal(serialize(host), "4"); assert.deepEqual(values, [-1, 0, -1, 4]);
  } finally { dispose(); }
  assert.equal(cleanups, 2);
});

test("native S-store-2 projection uses cross-node previous id while untouched paths stay quiet", async () => {
  const log: string[] = [];
  const app = createRoot(dispose => {
    const [id, setId] = createSignal(1), previous = createPrevious(id, () => 0);
    const selected = createProjection<Record<string, boolean>>(draft => {
      draft[String(previous())] = false; draft[String(id())] = true;
    }, {});
    const one = createMemo(() => selected["1"]), two = createMemo(() => selected["2"]);
    createEffect(() => one(), value => { log.push("log(one, " + value + ")"); });
    createEffect(() => two(), value => { log.push("log(two, " + value + ")"); });
    const frame = () => (one() ? "1" : "-") + " " + (two() ? "2" : "-");
    return { dispose, setId, frame };
  });
  const expected = ["1 -", "- 2", "- 2", "- -"];
  const effects = ["log(one, true)", "log(two, undefined)", "log(one, false)", "log(two, true)", "log(two, false)"];
  try {
    flush(); const frames = [app.frame()];
    for (const id of [2, 2, 3]) { app.setId(id); flush(); frames.push(app.frame()); }
    assert.deepEqual(frames, expected); assert.deepEqual(log, effects);
  } finally { app.dispose(); }
  await assertCore('source id := 1; selected = draft(pre selected -> {}) {d[str(pre id -> 0)] := false; d[str(id)] := true} ' +
    'effect (selected["1"]) {log("one", $0)} effect (selected["2"]) {log("two", $0)} ' +
    'export default component App() { <p>{selected["1"] ? "1" : "-"} {selected["2"] ? "2" : "-"}</p> }', [[["id", 2]], [["id", 2]], [["id", 3]]], expected, effects);
});
