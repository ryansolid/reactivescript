import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { buildTsx } from "./build.ts";
import { STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";
import { Runtime } from "./rx/runtime.ts";

type Interaction = {
  tag: string;
  event: string;
  args?: unknown[];
  result?: unknown;
  failure?: { name: string; message: string; value: number };
};
const click: Interaction = { tag: "button", event: "onClick" };

async function compare(t: TestContext, source: string, steps: Interaction[], expected: string[]) {
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "tsx-callbacks-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  const build = () => buildTsx("main.tsx", path => path === "main.tsx" ? source : undefined,
    { target: "universal", mount: "Counter" });
  const invoke = (callback: any, step: Interaction) => {
    assert.equal(typeof callback, "function", "must invoke the actual authored " + step.event);
    if (step.failure) assert.throws(() => callback(...(step.args ?? [])), step.failure);
    else {
      const result = callback(...(step.args ?? []));
      if ("result" in step) assert.equal(result, step.result);
    }
  };
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise<void>(done => setImmediate(done));
      flush();
    }
  };
  const render = async (name: string, code: string, native: boolean) => {
    writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
    const mod = await import(pathToFileURL(dir + "/" + name).href);
    const app = createApp();
    const dispose = app.mount(native ? () => mod.Counter() : mod.default(app));
    const find = (node: any, tag: string): any => node.tag === tag
      ? node : node.children?.map((child: any) => find(child, tag)).find(Boolean);
    try {
      await settle();
      const frames = [app.frame()];
      for (const step of steps) {
        invoke(find(app.root, step.tag)?.props[step.event], step);
        await settle();
        frames.push(app.frame());
      }
      return frames;
    } finally { dispose(); }
  };
  try {
    let nativeFrames: string[] | undefined;
    await t.test("native Solid", async () => {
      const code = transform(source, { filename: "Counter.tsx", generate: "universal", moduleName: STRING_RENDERER }).code;
      const frames = await render("native.mts", code, true);
      assert.deepEqual(frames, expected);
      nativeFrames = frames;
      t.diagnostic("native frames: " + JSON.stringify(frames));
    });
    assert.ok(nativeFrames, "prove the native expectation before adapting TSX");
    await t.test("compiled TSX", async () => {
      const built = build();
      assert.deepEqual(await render(built.entry, built.files.get(built.entry)!, false), nativeFrames);
    });
    await t.test("interpreter", () => {
      const rt = new Runtime(build().set);
      const find = (items: any[], tag: string): any => {
        for (const item of items) {
          if (item.k === "el" && item.tag === tag) return item;
          const found = find(item.children ?? item.inst?.items ?? item.node?.value?.items ?? [], tag);
          if (found) return found;
        }
      };
      try {
        const frames = [rt.step([]).at(-1)!.frame];
        for (const step of steps) {
          const node = find(rt.view.items, step.tag)?.attrs.find((attr: any) => attr.name === step.event)?.node;
          assert.ok(node, "interpreter must expose the authored " + step.event);
          invoke(node.compute(rt), step);
          frames.push(rt.handler([]).at(-1)!.frame);
        }
        assert.deepEqual(frames, nativeFrames);
      } finally { rt.root.dispose(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("inline typed onInput receives the actual event target value", async t => {
  await compare(t, `import { createSignal } from "solid-js";
export function Counter() {
  const [note, setNote] = createSignal("initial");
  return <><input onInput={(event: { target: { value: string } }) => {
    setNote(event.target.value);
  }}/><p>{note()}</p></>;
}`, [
    { tag: "input", event: "onInput", args: [{ target: { value: "alpha" } }] },
    { tag: "input", event: "onInput", args: [{ target: { value: "" } }] },
    { tag: "input", event: "onInput", args: [{ target: { value: "omega" } }] },
  ], ["initial", "alpha", "", "omega"]);
});

test("parameterized component callbacks forward numbers through a child and relay", async t => {
  await compare(t, `import { createSignal } from "solid-js";
function Button(props: { value: number; onChange: (next: number) => void }) {
  return <button onClick={() => props.onChange(props.value + 2)}>{props.value}</button>;
}
function Relay(props: { value: number; onChange: (next: number) => void }) {
  return <Button value={props.value} onChange={props.onChange}/>;
}
export function Counter() {
  const [count, setCount] = createSignal(0);
  const [calls, setCalls] = createSignal(0);
  return <><span>{calls()}/</span><Relay value={count()} onChange={(next: number) => {
    setCount(next);
    setCalls(n => n + 1);
  }}/></>;
}`, [click, click, click], ["0/0", "1/2", "2/4", "3/6"]);
});

test("forwarded event callback props preserve the payload across child and parent", async t => {
  await compare(t, `import { createSignal } from "solid-js";
function Input(props: { onInput: (event: { target: { value: string } }) => void }) {
  return <input onInput={props.onInput}/>;
}
function Relay(props: { onInput: (event: { target: { value: string } }) => void }) {
  return <Input onInput={props.onInput}/>;
}
export function Counter() {
  const [note, setNote] = createSignal("initial");
  return <><Relay onInput={(event: { target: { value: string } }) => {
    setNote(event.target.value);
  }}/><output>{note()}</output></>;
}`, [
    { tag: "input", event: "onInput", args: [{ target: { value: "forwarded" } }] },
    { tag: "input", event: "onInput", args: [{ target: { value: "again" } }] },
  ], ["initial", "forwarded", "again"]);
});

test("ordinary callback try catch finally handles success, failure, and early return", async t => {
  await compare(t, `import { createSignal } from "solid-js";
export function Counter() {
  const [count, setCount] = createSignal(0);
  const [status, setStatus] = createSignal("idle");
  const [finalized, setFinalized] = createSignal(0);
  return <button onClick={() => {
    const next = count() + 1;
    setCount(next);
    try {
      if (next === 2) throw "blocked";
      if (next === 3) return;
      setStatus("ok");
    } catch (error) {
      setStatus("caught");
    } finally {
      setFinalized(n => n + 1);
    }
  }}>{count()}/{status()}/{finalized()}</button>;
}`, [click, click, click, click], ["0/idle/0", "1/ok/1", "2/caught/2", "3/caught/3", "4/ok/4"]);
});

// These are synchronous callbacks, not actions; no failure-row type notation is needed.
test("a child catches its parent callback failure and still runs finally", async t => {
  await compare(t, `import { createSignal } from "solid-js";
import { defineError } from "reactivescript-tsx";
const Broken = defineError("Broken", ["value"], (value: number) => "broken " + value);
function Button(props: { onSave: () => void }) {
  const [status, setStatus] = createSignal("idle");
  const [finalized, setFinalized] = createSignal(0);
  return <button onClick={() => {
    try {
      props.onSave();
      setStatus("returned");
    } catch (error) {
      setStatus("caught");
    } finally {
      setFinalized(n => n + 1);
    }
  }}>{status()}/{finalized()}</button>;
}
export function Counter() {
  const [attempts, setAttempts] = createSignal(0);
  return <><span>{attempts()}/</span><Button onSave={() => {
    setAttempts(n => n + 1);
    throw Broken(7);
  }}/></>;
}`, [click, click], ["0/idle/0", "1/caught/1", "2/caught/2"]);
});

test("callback rethrows reach the event caller with their payload after both finalizers", async t => {
  await compare(t, `import { createSignal } from "solid-js";
import { defineError } from "reactivescript-tsx";
const Broken = defineError("Broken", ["value"], (value: number) => "broken " + value);
function Button(props: { onSave: () => void }) {
  const [status, setStatus] = createSignal("idle");
  const [finalized, setFinalized] = createSignal(0);
  return <button onClick={() => {
    try {
      props.onSave();
      setStatus("returned");
    } catch (error) {
      setStatus("rethrow");
      throw error;
    } finally {
      setFinalized(n => n + 1);
    }
  }}>{status()}/{finalized()}</button>;
}
export function Counter() {
  const [attempts, setAttempts] = createSignal(0);
  const [finalized, setFinalized] = createSignal(0);
  return <><span>{attempts()}/{finalized()}/</span><Button onSave={() => {
    setAttempts(n => n + 1);
    try {
      throw Broken(7);
    } finally {
      setFinalized(n => n + 1);
    }
  }}/></>;
}`, [
    { ...click, failure: { name: "Broken", message: "broken 7", value: 7 } },
    { ...click, failure: { name: "Broken", message: "broken 7", value: 7 } },
  ], ["0/0/idle/0", "1/1/rethrow/1", "2/2/rethrow/2"]);
});

test("nested finalizers preserve completions unless their own return or throw overrides them", async t => {
  await compare(t, `import { createSignal } from "solid-js";
import { defineError } from "reactivescript-tsx";
const Broken = defineError("Broken", ["value"], (value: number) => "broken " + value);
export function Counter() {
  const [attempts, setAttempts] = createSignal(0);
  const [trace, setTrace] = createSignal("");
  return <button onClick={() => {
    const next = attempts() + 1;
    setAttempts(next);
    try {
      try {
        if (next < 3) return "body";
        throw Broken(next);
      } finally {
        setTrace(v => v + "inner>");
      }
    } finally {
      setTrace(v => v + "outer;");
      if (next === 2) return "override";
      if (next === 3) return "recovered";
      if (next === 5) throw Broken(50);
    }
  }}>{attempts()}/{trace()}</button>;
}`, [
    { ...click, result: "body" },
    { ...click, result: "override" },
    { ...click, result: "recovered" },
    { ...click, failure: { name: "Broken", message: "broken 4", value: 4 } },
    { ...click, failure: { name: "Broken", message: "broken 50", value: 50 } },
  ], [
    "0/",
    "1/inner>outer;",
    "2/inner>outer;inner>outer;",
    "3/inner>outer;inner>outer;inner>outer;",
    "4/inner>outer;inner>outer;inner>outer;inner>outer;",
    "5/inner>outer;inner>outer;inner>outer;inner>outer;inner>outer;",
  ]);
});
