import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { buildTsx } from "./build.ts";
import { STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";

for (const fixture of [
  {
    name: "async memo loading values",
    api: "fetchValue",
    memo: "createMemo(async (): Promise<number> => await fetchValue(n()), { loadingValue: -1 })",
    stream: false,
    expected: [
      "next|-1|idle|-1|0",
      "next|0|idle|0|0",
      "next|0|pending|0|1",
      "next|10|idle|10|1",
    ],
  },
  {
    name: "direct async iterable memo generations",
    api: "fetchValues",
    memo: "createMemo((): AsyncIterable<number> => fetchValues(n()))",
    stream: true,
    expected: [
      "waiting",
      "next|0|idle|0|0",
      "next|1|idle|1|0",
      "next|1|pending|1|1",
      "next|1|pending|1|1",
      "next|10|idle|10|1",
      "next|11|idle|11|1",
    ],
  },
]) {
  test(`${fixture.name} match native Solid`, async t => {
    const source = `
import { createSignal, createMemo, Loading, Errored, isPending, latest } from "solid-js";
import { ${fixture.api} } from "./api";
export function Counter() {
  const [n, setN] = createSignal(0);
  const result = ${fixture.memo};
  return <Errored fallback={err => <p>failed</p>}>
    <Loading fallback={<p>waiting</p>}>
      <div>
        <button onClick={() => setN(n() + 1)}>next|</button>
        <span>{result()}</span>
        <span>{isPending(() => result()) ? "|pending|" : "|idle|"}</span>
        <span>{latest(() => result())}</span>
        <span>|{latest(() => n())}</span>
      </div>
    </Loading>
  </Errored>;
}`;
    const inputs: Record<string, string> = {
      "main.tsx": source,
      "api.d.rx": `export pure fn ${fixture.api}(n: number): number`,
    };
    const native = transform(source, {
      filename: "Counter.tsx", generate: "universal", moduleName: STRING_RENDERER,
    }).code.replaceAll('"./api"', '"./api.mjs"');
    const root = fileURLToPath(new URL("../.out/", import.meta.url));
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(root + "tsx-async-stream-");
    const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
    try {
      writeFileSync(dir + "/api.mjs", `export const ${fixture.api} = value => globalThis.__tsxAsyncStream(value);`);
      const traces: string[][] = [];
      for (const name of ["native.mts", "main.mjs"]) {
        await t.test(name === "native.mts" ? "native Solid" : "emitted RX", async () => {
          if (name === "main.mjs") assert.equal(traces.length, 1, "verify the native baseline before compiling RX");
          const code = name === "native.mts" ? native
            : buildTsx("main.tsx", path => inputs[path], { target: "universal", mount: "Counter" }).files.get(name)!;
          const flights = new Map<number, {
            value: Promise<number> | AsyncIterable<number>;
            send: (value: number) => void;
            returns: number;
          }>();
          const load = (key: number) => {
            let flight = flights.get(key);
            if (!flight) {
              let send!: (value: number) => void;
              const value = fixture.stream ? {
                [Symbol.asyncIterator]() {
                  return {
                    next: () => new Promise<IteratorResult<number>>(resolve => {
                      send = value => resolve({ value, done: false });
                    }),
                    return: () => {
                      flights.get(key)!.returns++;
                      return Promise.resolve({ value: undefined, done: true as const });
                    },
                  };
                },
              } : new Promise<number>(resolve => { send = resolve; });
              flight = { value, send: value => send(value), returns: 0 };
              flights.set(key, flight);
            }
            return flight.value;
          };
          (globalThis as any).__tsxAsyncStream = load;
          writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
          const module = await import(pathToFileURL(dir + "/" + name).href);
          const app = createApp({ api: { [fixture.api]: load } });
          const dispose = app.mount(name === "native.mts" ? () => module.Counter() : module.default(app));
          const settle = async () => {
            for (let i = 0; i < 3; i++) {
              await new Promise<void>(resolve => setImmediate(resolve));
              flush();
            }
          };
          const frames: string[] = [];
          try {
            await settle();
            frames.push(app.frame());
            assert.ok(flights.has(0), name + " must start the initial question");
            flights.get(0)!.send(0); await settle(); frames.push(app.frame());
            if (fixture.stream) {
              flights.get(0)!.send(1); await settle(); frames.push(app.frame());
            }
            const button = (node: any): any => node.tag === "button" ? node : node.children?.map(button).find(Boolean);
            button(app.root).props.onClick(); await settle(); frames.push(app.frame());
            assert.ok(flights.has(1), name + " must start the refreshed question");
            if (fixture.stream) {
              assert.equal(flights.get(0)!.returns, 1, name + " must cancel the superseded iterator");
              // Deliver a late step even after return(), to exercise the generation guard.
              flights.get(0)!.send(999); await settle(); frames.push(app.frame());
            }
            flights.get(1)!.send(10); await settle(); frames.push(app.frame());
            if (fixture.stream) {
              flights.get(1)!.send(11); await settle(); frames.push(app.frame());
            }
            assert.deepEqual(frames, fixture.expected, name);
            if (fixture.stream) assert.equal(flights.get(1)!.returns, 0, name + " must keep the current iterator open");
          } finally {
            dispose();
            delete (globalThis as any).__tsxAsyncStream;
          }
          if (fixture.stream) {
            assert.deepEqual([...flights.values()].map(flight => flight.returns), [1, 1], name + " must close each iterator exactly once");
          }
          traces.push(frames);
        });
      }
      if (traces.length === 2) assert.deepEqual(traces[1], traces[0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
