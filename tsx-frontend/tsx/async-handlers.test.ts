import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { buildTsx } from "./build.ts";
import { parseProgram } from "./rx/compiler.ts";
import { check } from "./rx/compiler.ts";
import { Runtime } from "./rx/runtime.ts";
import { compile } from "./rx/compiler.ts";
import { lowerViews, STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";

type Step = {
  before: string;
  after: string;
  result?: unknown;
  failure?: string;
  held?: boolean;
  args?: unknown[];
  microtasks?: string[];
  land?: { value?: unknown; failure?: string };
};
type Driver = {
  invoke: (...args: unknown[]) => unknown;
  frame: () => string;
  land: (answer: NonNullable<Step["land"]>) => void;
  dispose: () => void;
  held?: () => boolean;
};
const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>(done => setImmediate(done));
    flush();
  }
};

async function compare(t: TestContext, source: string, rx: string, initial: string, steps: Step[],
  options: { async?: boolean; authored?: boolean; refused?: { rx: RegExp; tsx: RegExp }; tsxRefused?: RegExp } = {}) {
  const isAsync = options.async ?? true;
  const out = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(out + "tsx-async-handlers-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  const exercise = async (driver: Driver) => {
    try {
      assert.equal(driver.frame(), initial);
      for (const step of steps) {
        const returned = driver.invoke(...(step.args ?? []));
        assert.equal(returned instanceof Promise, isAsync, "actual callback return must preserve async versus sync");
        const outcome = Promise.resolve(returned).then(value => ({ value }), error => ({ failure: error.message }));
        assert.equal(driver.frame(), step.before, "before-await writes must form their own frame");
        if (isAsync && driver.held) assert.equal(driver.held(), false, "ordinary callbacks must not hold their writes");
        if (step.held !== undefined && driver.held) assert.equal(driver.held(), step.held);
        if (step.land) {
          await settle();
          assert.equal(driver.frame(), step.before, "pending callbacks must leave before-await writes visible");
          assert.doesNotThrow(() => driver.land(step.land!));
          if (isAsync) assert.equal(driver.frame(), step.before, "a flight answer must queue, not synchronously run, its continuation");
        }
        for (const frame of step.microtasks ?? []) {
          await Promise.resolve();
          assert.equal(driver.frame(), frame);
        }
        assert.deepEqual(await outcome, step.failure ? { failure: step.failure } : { value: step.result });
        await settle();
        assert.equal(driver.frame(), step.after, "callback completion must include its finalizers");
        if (step.held && driver.held) assert.equal(driver.held(), false, "completion must release the action's hold");
      }
    } finally { driver.dispose(); }
  };
  const interpreted = (program: ConstructorParameters<typeof Runtime>[0]): Driver => {
    const rt = new Runtime(program);
    rt.step([]);
    const button = (items: any[]): any => {
      for (const item of items) {
        if (item.k === "el" && item.tag === "button") return item;
        const found = button(item.children ?? item.inst?.items ?? []);
        if (found) return found;
      }
    };
    return {
      invoke: (...args) => {
        const node = button(rt.view.items)?.attrs.find((attr: any) => attr.name === "onClick")?.node;
        assert.ok(node, "must invoke the actual interpreter event handler");
        return node.compute(rt)(...args);
      },
      frame: () => rt.handler([]).at(-1)!.frame,
      land: answer => { rt.land('"request:value"', answer.failure ? new Error(answer.failure) : answer.value, !!answer.failure); },
      dispose: () => rt.root.dispose(),
      held: () => rt.holdOpen,
    };
  };
  const rendered = async (name: string, code: string, native = false): Promise<Driver> => {
    writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
    const mod = await import(pathToFileURL(dir + "/" + name).href);
    const app = createApp();
    (globalThis as any).__tsxAsyncHandlerRequest = (...args: unknown[]) => (app.api("request")(...args) as any).first;
    const dispose = app.mount(native ? () => mod.Counter() : mod.default(app));
    const button = (node: any): any => node.tag === "button" ? node : node.children?.map(button).find(Boolean);
    await settle();
    return {
      invoke: (...args) => {
        const callback = button(app.root)?.props.onClick;
        assert.equal(typeof callback, "function", "must invoke the actual rendered event handler");
        return callback(...args);
      },
      frame: () => { flush(); return app.frame(); },
      land: answer => {
        const flight = app.flights.get("request:value");
        assert.ok(flight, "the callback must have asked the authored request");
        if (answer.failure) flight.reject(new Error(answer.failure)); else flight.resolve(answer.value);
      },
      dispose,
    };
  };
  try {
    let nativeProven = false;
    await t.test("native Solid", async () => {
      const native = transform(source, { filename: "Counter.tsx", generate: "universal", moduleName: STRING_RENDERER }).code
        .replaceAll('"./api"', '"data:text/javascript,export const request=(...args)=>globalThis.__tsxAsyncHandlerRequest(...args)"');
      await exercise(await rendered("native.mts", native, true));
      nativeProven = true;
    });
    assert.equal(nativeProven, true, "prove native expectations before compiling RX or TSX");
    // Every backend leg is registered whatever the pinned checker answers, so coverage stays accountable. With
    // `refused`, the pinned upstream cannot express the native behavior proven above (AC-1b/AC-1c: a plain callback
    // that writes and awaits is an inferred action whose pre-await writes are held): each leg then proves that exact
    // refusal (RX: the shared checker's diagnostics; TSX: the frontend's refusal at the authored callback).
    // `tsxRefused` refuses only the authored TSX (the temporary async-callback boundary, issue #20): the handwritten
    // RX legs still execute against the native behavior, so their results stay visible.
    const refusedRx = () => assert.match(check(parseProgram(rx)).map(d => d.code).join(" "), options.refused!.rx,
      "the pinned checker refuses the handwritten RX spelling of this behavior");
    const checkedRx = () => { const program = parseProgram(rx); assert.deepEqual(check(program), []); return program; };
    await t.test("compiled handwritten RX", async () => {
      if (options.refused) return refusedRx();
      const code = lowerViews(new Map([["handwritten.mjs", compile(checkedRx())]]), "universal").get("handwritten.mjs")!;
      await exercise(await rendered("handwritten.mjs", code));
    });
    await t.test("interpreted handwritten RX", () => options.refused ? refusedRx() : exercise(interpreted(checkedRx())));
    if (options.authored !== false) {
      const build = () => buildTsx("main.tsx", path => path === "main.tsx" ? source
        : path === "api.d.rx" ? "export fn request(key: string): number" : undefined, { mount: "Counter" });
      const tsxRefusal = options.refused?.tsx ?? options.tsxRefused;
      const refusedTsx = () => assert.throws(build, tsxRefusal!, "the frontend refuses the authored TSX");
      await t.test("compiled authored TSX", async () => {
        if (tsxRefusal) return refusedTsx();
        const built = build();
        await exercise(await rendered(built.entry, built.files.get(built.entry)!));
      });
      await t.test("interpreted authored TSX", () => tsxRefusal ? refusedTsx() : exercise(interpreted(build().set)));
    }
  } finally {
    delete (globalThis as any).__tsxAsyncHandlerRequest;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The temporary TSX boundary (https://github.com/ryansolid/reactivescript/issues/20): every authored ordinary async
 *  callback is refused at its async node with explicit generator-action guidance, whatever its body does. */
const ASYNC_CALLBACK = /Ordinary async callbacks are refused for now \(https:\/\/github\.com\/ryansolid\/reactivescript\/issues\/20\): wrap the work in action\(function\* \(\) \{ \.\.\. yield request\(\); \.\.\. \}\) and use yield instead of await/;
/** Unsupported at the pin (README: inferred actions): Solid applies a plain async callback's pre-await writes at once;
 *  upstream AC-1b infers the RX spelling as an action and refuses the held write (AC-1c); the frontend refuses the
 *  TSX as an ordinary async callback (ASYNC_CALLBACK). */
const PRE_AWAIT_WRITE = { rx: /HELD_WRITE/, tsx: ASYNC_CALLBACK };
const source = `import { createSignal } from "solid-js";
import { request } from "./api";
export function Counter() {
  const [n, setN] = createSignal(0);
  const [snapshot, setSnapshot] = createSignal(-1);
  const [finalized, setFinalized] = createSignal(0);
  return <button onClick={async () => {
    const before = n();
    setN(1);
    setSnapshot(before);
    try {
      const result: number = await request("value");
      setN(result);
      return result + before;
    } finally {
      setFinalized(value => value + 1);
    }
  }}>{n()}/{snapshot()}/{finalized()}</button>;
}`;
const rx = `import { request } from "./api";
source n = 0; source snapshot = -1; source finalized = 0;export default component App() { 
<button onClick={() => {
  let before = n; n := 1; snapshot := before;
  try {
    let result = await request("value");
    n := result;
    return result + before;
  } finally { finalized := finalized + 1; }
}}>{n}/{snapshot}/{finalized}</button> }`;

test("non-held async callbacks expose fresh and cached before-await frames and return values", t =>
  compare(t, source, rx, "0/-1/0", [
    { before: "1/0/0", after: "42/0/1", result: 42, land: { value: 42 } },
    { before: "1/42/1", after: "42/42/2", result: 84 },
  ], { refused: PRE_AWAIT_WRITE }));

test("fresh and cached callback rejections reject their promises after finally without throwing from land", t =>
  compare(t, source, rx, "0/-1/0", [
    { before: "1/0/0", after: "1/0/1", failure: "offline", land: { failure: "offline" } },
    { before: "1/1/1", after: "1/1/2", failure: "offline" },
  ], { refused: PRE_AWAIT_WRITE }));

for (const failed of [false, true]) {
  test("async callback " + (failed ? "catch recovery" : "return") + " survives an awaited finalizer", t =>
    compare(t, `import { createSignal } from "solid-js";
import { request } from "./api";
export function Counter() {
  const [n, setN] = createSignal(0);
  const [finalized, setFinalized] = createSignal(0);
  return <button onClick={async () => {
    setN(1);
    try {
      const result: number = await request("value");
      setN(result);
      return result;
    } catch (error) {
      setN(-1);
      return 7;
    } finally {
      await 0;
      setFinalized(value => value + 1);
    }
  }}>{n()}/{finalized()}</button>;
}`, `import { request } from "./api";
source n = 0; source finalized = 0;
export default component App() { <button onClick={() => {
  n := 1;
  try { let result = await request("value"); n := result; return result; }
  catch (error) { n := -1; return 7; }
  finally { await 0; finalized := finalized + 1; }
}}>{n}/{finalized}</button> }`, "0/0", [
      { before: "1/0", after: (failed ? "-1" : "42") + "/1", result: failed ? 7 : 42,
        land: failed ? { failure: "offline" } : { value: 42 } },
      { before: "1/1", after: (failed ? "-1" : "42") + "/2", result: failed ? 7 : 42 },
    ], { refused: PRE_AWAIT_WRITE }));
}

test("plain-value awaits suspend and an awaited finalizer can override the return", t =>
  compare(t, `import { createSignal } from "solid-js";
export function Counter() {
  const [stage, setStage] = createSignal("idle");
  return <button onClick={async () => {
    setStage("before");
    try {
      const result: number = await 8;
      setStage("body");
      return result;
    } finally {
      const done: number = await 9;
      setStage("finally");
      return done;
    }
  }}>{stage()}</button>;
}`, `source stage = "idle";
export default component App() { <button onClick={() => {
  stage := "before";
  try { let result = await 8; stage := "body"; return result; }
  finally { let done = await 9; stage := "finally"; return done; }
}}>{stage}</button> }`, "idle", [
    { before: "before", microtasks: ["body"], after: "finally", result: 9 },
  ], { refused: PRE_AWAIT_WRITE }));

test("lexically async callbacks return promises even when returning or throwing before the await", t =>
  compare(t, `import { defineError } from "reactivescript-tsx";
const Early = defineError("Early", [], () => "early");
export function Counter() {
  return <button onClick={async (mode: number) => {
    if (mode === 0) return 7;
    if (mode === 1) throw Early();
    const answer: number = await 8;
    return answer;
  }}>ready</button>;
}`, `error Early() => "early";
export default component App() { <button onClick={(mode) => {
  if (mode == 0) return 7;
  if (mode == 1) throw Early();
  let answer = await 8; return answer;
}}>ready</button> }`, "ready", [
    { args: [0], before: "ready", after: "ready", result: 7 },
    { args: [1], before: "ready", after: "ready", failure: "early" },
    { args: [2], before: "ready", after: "ready", result: 8 },
  ], { tsxRefused: ASYNC_CALLBACK }));

test("handwritten RX callbacks assimilate native promise arguments and returned promises", t =>
  compare(t, `import { createSignal } from "solid-js";
export function Counter() {
  const [n, setN] = createSignal(0);
  return <button onClick={async (answer: Promise<number>) => {
    setN(1);
    const result: number = await answer;
    setN(result);
    return answer;
  }}>{n()}</button>;
}`, `source n = 0;
export default component App() { <button onClick={(answer) => { n := 1; let result = await answer; n := result; return answer; }}>{n}</button> }`,
  "0", [{ args: [Promise.resolve(8)], before: "1", after: "8", result: 8 }], { authored: false, refused: PRE_AWAIT_WRITE }));

test("awaits in nested RX closures do not turn their outer callback async", t =>
  compare(t, `import { request } from "./api";
export function Counter() {
  return <button onClick={() => {
    const later = async () => { const result: number = await request("value"); return result; };
    return 7;
  }}>ready</button>;
}`, `import { request } from "./api";
export default component App() { <button onClick={() => { let later = () => { let result = await request("value"); return result; }; return 7; }}>ready</button> }`,
  "ready", [{ before: "ready", after: "ready", result: 7 }], { async: false, authored: false }));

test("an RX callback launching an inline held action stays synchronous", t =>
  compare(t, `import { createSignal, action } from "solid-js";
import { request } from "./api";
export function Counter() {
  const [n, setN] = createSignal(0);
  return <button onClick={() => {
    action(function*() {
      try { const result: number = yield request("value"); setN(result); }
      catch (error) { setN(-1); }
    })();
  }}>{n()}</button>;
}`, `import { request } from "./api"; source n = 0;
export default component App() { <button onClick={() => { action {
  try { let result = await request("value"); n := result; } catch (error) { n := -1; }
} }}>{n}</button> }`, "0", [{ before: "0", after: "42", land: { value: 42 } }], { async: false, authored: false }));

test("the direct scenario handler API retains synchronous frame arrays across flights", () => {
  // The control program writes before its await, which the pinned checker refuses (PRE_AWAIT_WRITE); the scenario
  // handler API is exercised on the supported spelling, which writes only after the await and catches the failure.
  assert.match(check(parseProgram(rx)).map(d => d.code).join(" "), PRE_AWAIT_WRITE.rx);
  const program = parseProgram(`import { request } from "./api";
source n = 0; source finalized = 0;
export default component App() { <button onClick={() => {
  try { let result = await request("value"); n := result; } catch (error) { n := -1; } finally { finalized := finalized + 1; }
}}>{n}/{finalized}</button> }`);
  assert.deepEqual(check(program), []);
  const app = program.decls.find(d => d.k === "component" && d.isDefault);
  if (!app || app.k !== "component") throw new Error("the RX program's entry is its default component (MO-1c)");
  const button = app.view[0];
  assert.equal(button.k, "el");
  if (button.k !== "el") return;
  const callback = button.attrs[0].e;
  assert.equal(callback.k, "fn");
  if (callback.k !== "fn") return;
  const rt = new Runtime(program);
  try {
    assert.equal(rt.step([]).at(-1)!.frame, "0/0");
    const frames = rt.handler(callback.stmts!);
    assert.ok(Array.isArray(frames));
    assert.equal(frames.at(-1)!.frame, "0/0", "nothing is written before the await");
    assert.equal(rt.holdOpen, true, "the body writes and awaits, so it is an inferred action (AC-1b) holding while its flight is out");
    assert.equal(rt.land('"request:value"', 42).at(-1)!.frame, "42/1");
    assert.equal(rt.holdOpen, false, "the action's hold ends with its body");
  } finally { rt.root.dispose(); }
});

for (const optimistic of [false, true]) {
  const source = `import { createSignal, createOptimistic, action, latest, isPending } from "solid-js";
import { request } from "./api";
export function Counter() {
  const [n, setN] = createSignal(0);
  const [draft, setDraft] = createSignal(() => 0);
  const [status, setStatus] = createSignal("idle");
  const [finalized, setFinalized] = createSignal(0);
  ${optimistic ? "const [overlay, setOverlay] = createOptimistic(() => draft());" : ""}
  const save = action(function*() {
    ${optimistic ? "setOverlay(10);" : ""}
    try {
      const result: number = yield request("value");
      setN(result);
      setDraft(result);
      setStatus("ok");
    } catch (error) {
      setStatus("failed");
    } finally {
      setFinalized(value => value + 1);
    }
  });
  return <button onClick={() => {
    setN(1);
    setDraft(1);
    setStatus("placing");
    save();
  }}>{n()}/{draft()}/{status()}/{finalized()}|{latest(() => n())}/{latest(() => draft())}|{isPending(() => n()) ? "pending" : "idle"}/{isPending(() => draft()) ? "pending" : "idle"}${optimistic ? "|{overlay()}" : ""}</button>;
}`;
  const rx = `import { request } from "./api";
source n := 0; source draft = 0; source status := "idle"; source finalized := 0;
${optimistic ? "source overlay = draft;" : ""}
export default component App() { <button onClick={() => {
  n := 1; draft := 1; status := "placing";
  action {
    ${optimistic ? "optimistic overlay := 10;" : ""}
    try { let result = await request("value"); n := result; draft := result; status := "ok"; }
    catch (error) { status := "failed"; }
    finally { finalized := finalized + 1; }
  }
}}>{n}/{draft}/{status}/{finalized}|{latest n}/{latest draft}|{pending? n ? "pending" : "idle"}/{pending? draft ? "pending" : "idle"}${optimistic ? "|{overlay}" : ""}</button> }`;
  for (const failed of [false, true]) {
    test("synchronous callback pre-writes join an inline held action through " + (failed ? "failure" : "success") +
      (optimistic ? " with an optimistic overlay" : ""), t => {
      const value = failed ? 1 : 42;
      return compare(t, source, rx, "0/0/idle/0|0/0|idle/idle" + (optimistic ? "|0" : ""), [
        { before: "0/0/idle/0|1/1|pending/pending" + (optimistic ? "|10" : ""),
          after: `${value}/${value}/${failed ? "failed" : "ok"}/1|${value}/${value}|idle/idle` + (optimistic ? "|" + value : ""),
          held: true, land: failed ? { failure: "offline" } : { value: 42 } },
      ], { async: false });
    });
  }
}
