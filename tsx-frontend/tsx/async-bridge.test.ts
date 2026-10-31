import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { buildTsx } from "./build.ts";
import { STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";

const baseSource = 'import { createSignal, createMemo, Loading, Errored, isPending, latest } from "solid-js"; import { fetchValue } from "./api"; export function Counter() { const [n,setN] = createSignal(0); const result = createMemo(async (): Promise<number> => await fetchValue(n())); return <Errored fallback={err => <p>failed</p>}><Loading fallback={<p>waiting</p>}><div><button onClick={() => setN(n()+1)}>{result()}</button><span>{isPending(() => result()) ? "pending" : "idle"}</span><span>{latest(() => n())}</span></div></Loading></Errored>; }';

for (const explicitOn of [false, true]) test("async equations, JS contracts, failures and probes match native Solid" + (explicitOn ? " with Loading on" : ""), async () => {
  const source = explicitOn ? baseSource.replace("<Loading fallback", "<Loading on={n()} fallback") : baseSource;
  const inputs: Record<string, string> = { "main.tsx": source, "api.d.rx": "export pure fn fetchValue(n: number): number" };
  const native = transform(source, { filename: "Counter.tsx", generate: "universal", moduleName: STRING_RENDERER }).code.replaceAll('"./api"', '"./api.mjs"');
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "tsx-async-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  try {
    writeFileSync(dir + "/api.mjs", "export const fetchValue = value => globalThis.__tsxLoad(value);");
    const traces: string[][] = [];
    for (const name of ["native.mts", "main.mjs"]) {
      const code = name === "native.mts" ? native
        : buildTsx("main.tsx", path => inputs[path], { target: "universal", mount: "Counter" }).files.get(name)!;
      const flights = new Map<number, { promise: Promise<number>; resolve: (value: number) => void; reject: (error: Error) => void }>();
      const load = (key: number) => {
        let flight = flights.get(key);
        if (!flight) {
          let resolve!: (value: number) => void; let reject!: (error: Error) => void;
          const promise = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
          flight = { promise, resolve, reject }; flights.set(key, flight);
        }
        return flight.promise;
      };
      (globalThis as any).__tsxLoad = load;
      writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
      const module = await import(pathToFileURL(dir + "/" + name).href);
      const app = createApp({ api: { fetchValue: load } });
      const dispose = app.mount(name === "native.mts" ? () => module.Counter() : module.default(app));
      const settle = async () => { for (let i = 0; i < 3; i++) { await new Promise<void>(resolve => setImmediate(resolve)); flush(); } };
      try {
        await settle(); const frames = [app.frame()];
        assert.ok(flights.has(0), name + " must start the initial question");
        flights.get(0)!.resolve(0); await settle(); frames.push(app.frame());
        const button = (node: any): any => node.tag === "button" ? node : node.children?.map(button).find(Boolean);
        button(app.root).props.onClick(); await settle(); frames.push(app.frame());
        assert.ok(flights.has(1)); flights.get(1)!.resolve(10); await settle(); frames.push(app.frame());
        button(app.root).props.onClick(); await settle(); frames.push(app.frame());
        assert.ok(flights.has(2)); flights.get(2)!.reject(new Error("offline")); await settle(); frames.push(app.frame());
        assert.deepEqual(frames, explicitOn ? ["waiting", "0idle0", "waiting", "10idle1", "waiting", "failed"] : ["waiting", "0idle0", "0pending1", "10idle1", "10pending2", "failed"], name);
        traces.push(frames);
      } finally { dispose(); delete (globalThis as any).__tsxLoad; }
    }
    assert.deepEqual(traces[0], traces[1]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
