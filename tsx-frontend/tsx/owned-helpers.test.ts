import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { buildTsx } from "./build.ts";
import { STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";
import { Runtime } from "./rx/runtime.ts";

async function compare(t: TestContext, source: string, expected: string[]) {
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "tsx-owned-helpers-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  let nativeFrames: string[] = [];
  try {
    for (const name of ["native.mts", "main.mjs"]) {
      const built = name === "main.mjs"
        ? buildTsx("main.tsx", path => path === "main.tsx" ? source : undefined, { target: "universal", mount: "Counter" })
        : undefined;
      const code = built ? built.files.get(name)!
        : transform(source, { filename: "Counter.tsx", generate: "universal", moduleName: STRING_RENDERER }).code;
      writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
      const mod = await import(pathToFileURL(dir + "/" + name).href);
      const app = createApp();
      const dispose = app.mount(name === "native.mts" ? () => mod.Counter() : mod.default(app));
      const settle = async () => {
        for (let i = 0; i < 3; i++) {
          await new Promise<void>(done => setImmediate(done));
          flush();
        }
      };
      try {
        await settle();
        const frames = [app.frame()];
        const button = (node: any): any => node.tag === "button" ? node : node.children?.map(button).find(Boolean);
        for (let i = 1; i < expected.length; i++) {
          const el = button(app.root);
          assert.equal(typeof el?.props.onClick, "function", name + " must render the authored button, not stringify it");
          el.props.onClick();
          await settle();
          frames.push(app.frame());
        }
        t.diagnostic(name + " frames: " + JSON.stringify(frames));
        assert.deepEqual(frames, expected, name);
        if (name === "native.mts") nativeFrames = frames;
        else assert.deepEqual(frames, nativeFrames, "compiled TSX must match native Solid");
      } finally { dispose(); }

      if (built) {
        const rt = new Runtime(built.set);
        try {
          const frames = [rt.step([]).at(-1)!.frame];
          const button = (items: any[]): any => {
            for (const item of items) {
              if (item.k === "el" && item.tag === "button") return item;
              const nested = item.children ?? item.inst?.items ?? item.node?.value?.items ?? [];
              const found = button(nested);
              if (found) return found;
            }
          };
          for (let i = 1; i < expected.length; i++) {
            const handler = button(rt.view.items)?.attrs.find((attr: any) => attr.name === "onClick")?.node;
            assert.ok(handler, "interpreter must render the authored button handler through child slots");
            const click = handler.compute(rt);
            assert.equal(typeof click, "function");
            click();
            frames.push(rt.handler([]).at(-1)!.frame);
          }
          t.diagnostic("interpreter frames: " + JSON.stringify(frames));
          assert.deepEqual(frames, nativeFrames, "interpreter must match native Solid");
        } finally { rt.root.dispose(); }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("accessor-returning helpers keep ref arguments live and snapshot value arguments and locals", async t => {
  await compare(t, `import { createSignal, createMemo, untrack } from "solid-js";
function useCounter(base: () => number, seed: number): () => number {
  const captured = untrack(() => base());
  const value = createMemo(() => base() + seed + captured);
  return value;
}
export function Counter() {
  const [n, setN] = createSignal(1);
  const value = useCounter(n, n());
  return <button onClick={() => setN(n() + 1)}>{n()}/{value()}</button>;
}`, ["1/3", "2/4", "3/5", "4/6"]);
});

test("accessor-returning helpers retain owned signal and effect state across ref updates", async t => {
  await compare(t, `import { createSignal, createMemo } from "solid-js";
import { createRxEffect } from "reactivescript-tsx";
function useCounter(base: () => number, seed: number): () => number {
  const [local, setLocal] = createSignal(seed);
  createRxEffect([() => base()], n => { setLocal(p => p + 1); });
  const value = createMemo(() => base() + local());
  return value;
}
export function Counter() {
  const [n, setN] = createSignal(1);
  const value = useCounter(n, n());
  return <button onClick={() => setN(n() + 1)}>{n()}/{value()}</button>;
}`, ["1/3", "2/5", "3/7", "4/9"]);
});

test("Solid Element children render caller-owned live nodes instead of stringifying them", async t => {
  await compare(t, `import { type Element, createSignal } from "solid-js";
function Frame(props: { children: Element }) {
  return <div>{props.children}</div>;
}
export function Counter() {
  const [n, setN] = createSignal(0);
  return <Frame><button onClick={() => setN(n() + 1)}>{n()}</button></Frame>;
}`, ["0", "1", "2", "3"]);
});
