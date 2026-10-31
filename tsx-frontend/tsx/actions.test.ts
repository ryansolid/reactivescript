import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { buildTsx } from "./build.ts";
import { loadTsxModules } from "./modules.ts";
import { STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";
import { checkModules } from "./rx/compiler.ts";

const source = `import { createSignal, createOptimistic, action } from "solid-js";
import { request } from "./api";
export function Counter() {
  const [truth, setTruth] = createSignal(0);
  const [count, setCount] = createOptimistic(() => truth());
  const [status, setStatus] = createSignal("");
  const [orders, setOrders] = createSignal(0);
  const save = action(function*() {
    setCount(1);
    setStatus("placing");
    try {
      const receipt: number = yield request();
      setTruth(receipt);
      setStatus("ok");
    } catch (e) {
      setStatus("failed");
    } finally {
      setOrders(p => p + 1);
    }
  });
  return <button onClick={() => save()}>{count()}/{status()}/{orders()}</button>;
}`;
const inputs: Record<string, string> = {
  "main.tsx": source,
  "api.d.rx": "export fn request(): number",
};
const expected = ["0//0", "1//0", "0/failed/1", "1/failed/1", "42/ok/2"];

for (const name of ["native.mts", "main.mjs"]) {
  test((name === "native.mts" ? "native Solid" : "lowered TSX") +
    " generator actions hold status writes, roll back optimistic failure, and commit success", async t => {
    const code = name === "native.mts"
      ? transform(source, { filename: "Counter.tsx", generate: "universal", moduleName: STRING_RENDERER }).code
        .replaceAll('"./api"', '"./api.mjs"')
      : buildTsx("main.tsx", path => inputs[path], { target: "universal", mount: "Counter" }).files.get(name)!;
    const root = fileURLToPath(new URL("../.out/", import.meta.url));
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(root + "tsx-actions-");
    const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
    const flights: { resolve: (value: number) => void; reject: (error: Error) => void }[] = [];
    const request = () => {
      let resolve!: (value: number) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
      flights.push({ resolve, reject });
      return promise;
    };
    (globalThis as any).__tsxActionRequest = request;
    try {
      writeFileSync(dir + "/api.mjs", "export const request = () => globalThis.__tsxActionRequest();");
      writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
      const mod = await import(pathToFileURL(dir + "/" + name).href);
      const app = createApp({ api: { request } });
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
        assert.equal(flights.length, 0, "request must only run when the action is invoked");
        const button = (node: any): any => node.tag === "button" ? node : node.children?.map(button).find(Boolean);

        const failed = button(app.root).props.onClick();
        await settle(); frames.push(app.frame());
        assert.equal(flights.length, 1);
        flights[0].reject(new Error("offline"));
        await failed; await settle(); frames.push(app.frame());

        const saved = button(app.root).props.onClick();
        await settle(); frames.push(app.frame());
        assert.equal(flights.length, 2);
        flights[1].resolve(42);
        await saved; await settle(); frames.push(app.frame());

        t.diagnostic(name + " frames: " + JSON.stringify(frames));
        assert.deepEqual(frames, expected, name);
      } finally { dispose(); }
    } finally {
      delete (globalThis as any).__tsxActionRequest;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const handled of [true, false]) {
  test(handled ? "handled generator action failures pass the core checker"
    : "unhandled generator action failures require core UNCAUGHT_ACTION_FAILURE", () => {
    const authored = handled ? source : source.replace(' catch (e) {\n      setStatus("failed");\n    }', "");
    if (!handled) assert.notEqual(authored, source);
    const files: Record<string, string> = { ...inputs, "main.tsx": authored };
    const set = loadTsxModules("main.tsx", path => files[path]);
    assert.deepEqual(set.diags, [], "frontend must accept authored generator action syntax");
    const diagnostics = checkModules(set).diags;
    if (handled) assert.deepEqual(diagnostics, []);
    else assert.deepEqual(diagnostics.map(({ code, rule, file }) => ({ code, rule, file })), [
      { code: "UNCAUGHT_ACTION_FAILURE", rule: "R-f-6", file: "main.tsx" },
    ]);
  });
}
