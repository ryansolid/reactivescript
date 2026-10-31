import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { buildTsx } from "./build.ts";
import { STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";
import { Runtime } from "./rx/runtime.ts";

type Row = { id: number; name: string };
type Step = { click: true } | { query: number; rows: Row[] } | { query: number; error: string };
type Sample = { frame: string; effects: string[] };
const sample = (frame: string, ...effects: string[]): Sample => ({ frame, effects });
const record = (kind: string, id: number, name: string) => `log(${kind}, ${id}, ${name})`;
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise<void>(resolve => setImmediate(resolve)); flush(); } };
const button = (node: any): any => node.tag === "button" ? node : node.children?.map(button).find(Boolean);

function interpretedButton(items: any[]): any {
  for (const item of items) {
    if (item.k === "el" && item.tag === "button") return item;
    const nested = item.children ?? item.inst?.items ?? item.committed?.inst?.items
      ?? item.committedRows?.flatMap((row: any) => row.inst.items)
      ?? ((item.k === "loading" || item.k === "errored") ? (item.committedFallback ? item.fallback : item.content)?.items : []);
    const found = interpretedButton(nested ?? []); if (found) return found;
  }
}

async function trace(source: string, steps: Step[], engine: "native" | "compiled" | "interpreter"): Promise<Sample[]> {
  const files: Record<string, string> = {
    "main.tsx": source,
    "api.d.rx": "export pure fn fetchRows(query: number): { id: number; name: string }[]\nexport fn log(kind: string, id: number, name: string)\n",
  };
  if (engine === "interpreter") {
    const built = buildTsx("main.tsx", path => files[path], { mount: "Counter" });
    const runtime = new Runtime(built.set);
    const out = [sample(runtime.step([]).at(-1)!.frame, ...runtime.log)];
    for (const step of steps) {
      const start = runtime.log.length;
      let frame: string;
      if ("click" in step) {
        const node = interpretedButton(runtime.view.items)?.attrs.find((attr: any) => attr.name === "onClick")?.node;
        assert.ok(node, "interpreter must execute the authored handler");
        const handler = node.compute(runtime); assert.equal(typeof handler, "function"); handler(); frame = runtime.handler([]).at(-1)!.frame;
      } else frame = runtime.land(JSON.stringify("fetchRows:" + step.query), "rows" in step ? step.rows : new Error(step.error), "error" in step).at(-1)!.frame;
      out.push(sample(frame, ...runtime.log.slice(start)));
    }
    return out;
  }
  const root = fileURLToPath(new URL("../.out/", import.meta.url)); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "keyed-async-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  const requests = new Map<number, { resolve: (rows: Row[]) => void; reject: (error: Error) => void }>();
  const fetchRows = (query: number) => new Promise<Row[]>((resolve, reject) => { assert.ok(!requests.has(query), "one request per query"); requests.set(query, { resolve, reject }); });
  const app = createApp({ api: { fetchRows } });
  (globalThis as any).__keyedAsyncFetch = fetchRows;
  (globalThis as any).__keyedAsyncLog = (...args: unknown[]) => app.log.push(`log(${args.map(String).join(", ")})`);
  try {
    writeFileSync(dir + "/api.mjs", "export const fetchRows = query => globalThis.__keyedAsyncFetch(query); export const log = (...args) => globalThis.__keyedAsyncLog(...args);");
    let entry: string;
    if (engine === "native") {
      entry = "native.mts";
      const code = transform(source, { filename: "main.tsx", generate: "universal", moduleName: STRING_RENDERER }).code.replaceAll('"./api"', '"./api.mjs"');
      writeFileSync(dir + "/" + entry, code.replaceAll(STRING_RENDERER, renderer));
    } else {
      const built = buildTsx("main.tsx", path => files[path], { target: "universal", mount: "Counter" });
      entry = built.entry;
      for (const [name, code] of built.files) writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
    }
    const module = await import(pathToFileURL(dir + "/" + entry).href);
    const dispose = app.mount(engine === "native" ? () => module.Counter() : module.default(app));
    try {
      await settle(); const out = [sample(app.frame(), ...app.log)];
      for (const step of steps) {
        const start = app.log.length;
        if ("click" in step) { const handler = button(app.root)?.props.onClick; assert.equal(typeof handler, "function"); handler(); }
        else { const request = requests.get(step.query); assert.ok(request, engine + " must ask query " + step.query); if ("rows" in step) request.resolve(step.rows); else request.reject(new Error(step.error)); }
        await settle(); out.push(sample(app.frame(), ...app.log.slice(start)));
      }
      return out;
    } finally { dispose(); }
  } finally { delete (globalThis as any).__keyedAsyncFetch; delete (globalThis as any).__keyedAsyncLog; rmSync(dir, { recursive: true, force: true }); }
}

const imports = 'import { createSignal, createStore, createMemo, createProjection, For, Loading, Errored, isPending, untrack } from "solid-js"; import { createRxEffect } from "reactivescript-tsx"; import { fetchRows, log } from "./api";';
const rowComponent = 'function Row(props: { row: { id: number; name: string } }) { const id: number = untrack(() => props.row.id); const initial: string = untrack(() => props.row.name); createRxEffect([() => props.row.name], name => { log("run", id, name); return () => { log("cleanup", id, name); }; }); return <i>{id}:{props.row.name}/{initial};</i>; }';
const syncSource = imports + rowComponent + 'export function Counter() { const [rows, setRows] = createStore([{ id: 1, name: "a" }, { id: 2, name: "b" }]); const [step, setStep] = createSignal(0); const view = createProjection(() => rows.map(row => ({ id: row.id, name: row.name + "!" })), [], { key: "id" }); return <button onClick={() => { if (step() === 0) setRows(() => [{ id: 1, name: "a" }, { id: 2, name: "B" }]); else if (step() === 1) setRows(() => [{ id: 2, name: "B" }, { id: 1, name: "a" }]); else if (step() === 2) setRows(() => [{ id: 2, name: "B" }, { id: 3, name: "c" }]); else if (step() === 3) setRows(() => [{ id: 1, name: "aa" }, { id: 3, name: "c" }, { id: 2, name: "B" }]); else if (step() === 4) setRows(() => []); else if (step() === 5) setRows(() => [{ id: 2, name: "bb" }]); else setRows(() => []); setStep(previous => previous + 1); }}><For each={view}>{row => <Row row={row}/>}</For></button>; }';

test("S-store-3 structured keyed replacements preserve rows, quiet reorders, and dispose removed effects", async () => {
  const steps: Step[] = Array.from({ length: 7 }, () => ({ click: true }));
  const expected = [
    sample("1:a!/a!;2:b!/b!;", record("run", 1, "a!"), record("run", 2, "b!")),
    sample("1:a!/a!;2:B!/b!;", record("cleanup", 2, "b!"), record("run", 2, "B!")),
    sample("2:B!/b!;1:a!/a!;"),
    sample("2:B!/b!;3:c!/c!;", record("cleanup", 1, "a!"), record("run", 3, "c!")),
    sample("1:aa!/aa!;3:c!/c!;2:B!/b!;", record("run", 1, "aa!")),
    sample("", record("cleanup", 1, "aa!"), record("cleanup", 3, "c!"), record("cleanup", 2, "B!")),
    sample("2:bb!/bb!;", record("run", 2, "bb!")), sample("", record("cleanup", 2, "bb!")),
  ];
  for (const engine of ["native", "compiled", "interpreter"] as const) assert.deepEqual(await trace(syncSource, steps, engine), expected, engine);
});

const asyncStart = imports + rowComponent + 'export function Counter() { const [query, setQuery] = createSignal(0); const raw = createMemo(async (): Promise<{ id: number; name: string }[]> => await fetchRows(query())); const view = createProjection(() => raw(), [], { key: "id" }); return <div><button onClick={() => setQuery(previous => previous + 1)}></button><Errored fallback={error => <p>error:{error().message}</p>}><Loading fallback={<p>loading</p>}>';
const asyncRows = '<For each={view}>{row => <Row row={row}/>}</For>';
const asyncEnd = "</Loading></Errored></div>; }";
const asyncSource = asyncStart + '<section>{raw().length} {isPending(() => raw()) ? "pending" : "idle"}|' + asyncRows + "</section>" + asyncEnd;

test("async structured keyed replacements retain matching rows and suppress obsolete answers", async () => {
  const steps: Step[] = [
    { query: 0, rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }] }, { click: true },
    { query: 1, rows: [{ id: 2, name: "B" }, { id: 1, name: "a" }] }, { click: true },
    { query: 2, rows: [{ id: 2, name: "B" }, { id: 3, name: "c" }] }, { click: true },
    { query: 3, error: "offline" }, { click: true }, { click: true },
    { query: 5, rows: [{ id: 3, name: "C" }, { id: 2, name: "BB" }, { id: 4, name: "d" }] },
    { query: 4, rows: [{ id: 9, name: "stale" }] }, { click: true },
    { query: 6, rows: [{ id: 4, name: "d" }, { id: 3, name: "C" }, { id: 2, name: "BB" }] },
    { click: true }, { query: 7, rows: [] }, { click: true }, { click: true },
    { query: 9, rows: [{ id: 2, name: "new" }] }, { query: 8, error: "obsolete" },
  ];
  const expected = [
    sample("loading"), sample("2 idle|1:a/a;2:b/b;", record("run", 1, "a"), record("run", 2, "b")),
    sample("2 pending|1:a/a;2:b/b;"),
    sample("2 idle|2:B/b;1:a/a;", record("cleanup", 2, "b"), record("run", 2, "B")),
    sample("2 pending|2:B/b;1:a/a;"),
    sample("2 idle|2:B/b;3:c/c;", record("cleanup", 1, "a"), record("run", 3, "c")),
    sample("2 pending|2:B/b;3:c/c;"), sample("error:offline"), sample("error:offline"), sample("error:offline"),
    sample("3 idle|3:C/c;2:BB/b;4:d/d;", record("run", 4, "d"), record("cleanup", 3, "c"), record("run", 3, "C"), record("cleanup", 2, "B"), record("run", 2, "BB")),
    sample("3 idle|3:C/c;2:BB/b;4:d/d;"), sample("3 pending|3:C/c;2:BB/b;4:d/d;"),
    sample("3 idle|4:d/d;3:C/c;2:BB/b;"), sample("3 pending|4:d/d;3:C/c;2:BB/b;"),
    sample("0 idle|", record("cleanup", 4, "d"), record("cleanup", 3, "C"), record("cleanup", 2, "BB")),
    sample("0 pending|"), sample("0 pending|"),
    sample("1 idle|2:new/new;", record("run", 2, "new")), sample("1 idle|2:new/new;"),
  ];
  for (const engine of ["native", "compiled", "interpreter"] as const) assert.deepEqual(await trace(asyncSource, steps, engine), expected, engine);
});

test("async keyed row retention is isolated per projection with overlapping keys", async () => {
  const source = imports + rowComponent + `export function Counter() {
    const [leftQuery, setLeftQuery] = createSignal(0);
    const [rightQuery, setRightQuery] = createSignal(10);
    const [step, setStep] = createSignal(0);
    const leftRaw = createMemo(async (): Promise<{ id: number; name: string }[]> => await fetchRows(leftQuery()));
    const rightRaw = createMemo(async (): Promise<{ id: number; name: string }[]> => await fetchRows(rightQuery()));
    const left = createProjection(() => leftRaw(), [], { key: "id" });
    const right = createProjection(() => rightRaw(), [], { key: "id" });
    return <div><button onClick={() => { if (step() === 0) setLeftQuery(1); else setRightQuery(11); setStep(previous => previous + 1); }}></button>
      <Errored fallback={error => <p>error:{error().message}</p>}>
      <Loading fallback={<p>left-loading</p>}><section>{leftRaw().length}|<For each={left}>{row => <Row row={row}/>}</For></section></Loading>
      <Loading fallback={<p>right-loading</p>}><section>{rightRaw().length}|<For each={right}>{row => <Row row={row}/>}</For></section></Loading>
      </Errored>
    </div>;
  }`;
  const steps: Step[] = [
    { query: 0, rows: [{ id: 1, name: "left" }] }, { query: 10, rows: [{ id: 1, name: "right" }] },
    { click: true }, { query: 1, rows: [{ id: 1, name: "LEFT" }] }, { click: true }, { query: 11, rows: [{ id: 1, name: "RIGHT" }] },
  ];
  const expected = [
    sample("left-loadingright-loading"), sample("1|1:left/left;right-loading", record("run", 1, "left")),
    sample("1|1:left/left;1|1:right/right;", record("run", 1, "right")), sample("1|1:left/left;1|1:right/right;"),
    sample("1|1:LEFT/left;1|1:right/right;", record("cleanup", 1, "left"), record("run", 1, "LEFT")),
    sample("1|1:LEFT/left;1|1:right/right;"),
    sample("1|1:LEFT/left;1|1:RIGHT/right;", record("cleanup", 1, "right"), record("run", 1, "RIGHT")),
  ];
  for (const engine of ["native", "compiled", "interpreter"] as const) assert.deepEqual(await trace(source, steps, engine), expected, engine);
});

test("DV-8 baseline: a projection-only reader retains rows and swallows later pending and failure", async () => {
  // This is the recorded limit, not a parity claim: spec/05-holds.md DV-8 and
  // oracle/repros/dv8-projection.mjs. The visible raw summary in the test above
  // legitimately reads the memo; this test separately pins the bare projection.
  const source = asyncStart + '<section>{view.length} {isPending(() => view.length) ? "pending" : "idle"}|' + asyncRows + "</section>" + asyncEnd;
  const steps: Step[] = [{ query: 0, rows: [] }, { click: true }, { query: 1, rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }] }, { click: true }, { query: 2, error: "offline" }];
  const rows = sample("2 idle|1:a/a;2:b/b;", record("run", 1, "a"), record("run", 2, "b"));
  const nativeExpected = [sample("loading"), sample("0 idle|"), sample("0 idle|"), rows, sample(rows.frame), sample(rows.frame)];
  for (const engine of ["native", "compiled"] as const) assert.deepEqual(await trace(source, steps, engine), nativeExpected, engine + " recorded DV-8");
  assert.deepEqual(await trace(source, steps, "interpreter"), [sample("loading"), sample("0 idle|"), sample("0 pending|"), rows, sample("2 pending|1:a/a;2:b/b;"), sample("error:offline")], "interpreter rules-derived behavior");
});
