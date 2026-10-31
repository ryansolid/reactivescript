// Real-browser adoption test, separate from the fast TSX suite.
import { runtimeFiles } from "./rx/runtime.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { chromium } from "playwright";
import { transform } from "@solidjs/compiler";
import { buildTsx } from "./build.ts";

const scenarios = [
  {
    name: "async-handler", frames: ["0/0", "4/1", "44/2", "444/3"], hydrationCalls: 0,
    // Temporary TSX boundary (https://github.com/ryansolid/reactivescript/issues/20): the authored TSX leg proves the
    // refusal of its ordinary async callback instead of building; the native and RX legs still stream, hydrate, click.
    tsxRefused: /Ordinary async callbacks are refused for now \(https:\/\/github\.com\/ryansolid\/reactivescript\/issues\/20\): wrap the work in action\(function\* \(\) \{ \.\.\. yield request\(\); \.\.\. \}\)/,
    rx: 'import pure {fetchValue} from "./api"; export component Counter() { source n := 0; source runs := 0; <button onClick={() => { n := 1; let result = await fetchValue(n); n := result; runs := previous => previous + 1 }}>{"" + n}/{"" + runs}</button> }',
    tsx: 'import {createSignal} from "solid-js"; import {fetchValue} from "./api"; export function Counter() { const [n,setN]=createSignal(0); const [runs,setRuns]=createSignal(0); return <button onClick={async()=>{setN(1); const result:number=await fetchValue(n()); setN(result); setRuns(previous=>previous+1);}}>{n()}/{runs()}</button>; }',
  },
  {
    name: "input-events", frames: ["empty", "one", "two", "three"], hydrationCalls: 0,
    rx: 'component Field(props) { <input value={props.value} onInput={(event) => { props.onValue(event.currentTarget.value) }}/> } export component Counter() { source note := "empty"; <Field value={note} onValue={(next) => { note := next }}/><button>{note}</button> }',
    tsx: 'import { createSignal } from "solid-js"; function Field(props: {value: string; onValue: (next: string) => void}) { return <input value={props.value} onInput={(event: {currentTarget: {value: string}}) => props.onValue(event.currentTarget.value)}/>; } export function Counter() { const [note,setNote] = createSignal("empty"); return <><Field value={note()} onValue={(next: string) => setNote(next)}/><button>{note()}</button></>; }',
  },
  {
    name: "branch-remount", frames: ["0:0/0", "1:1/0", "2:hidden", "3:3/3"], hydrationCalls: 0,
    rx: 'component Child(props: {n: number}) { source initial := peek(props.n); <span>{"" + props.n}/{"" + initial}</span> } export component Counter() { source n := 0; <button onClick={() => { n := n + 1 }}>{"" + n}:{if n % 3 != 2 { <Child n={n}/> } else { <span>hidden</span> }}</button> }',
    tsx: 'import { createSignal, Show, untrack } from "solid-js"; function Child(props: {n: number}) { const initial = untrack(() => props.n); return <span>{props.n}/{initial}</span>; } export function Counter() { const [n,setN] = createSignal(0); return <button onClick={() => setN(n()+1)}>{n()}:<Show when={n()%3 !== 2} fallback={<span>hidden</span>}><Child n={n()}/></Show></button>; }',
  },
  {
    name: "keyed-rows", frames: ["1:A/A;2:B/B;", "2:b/B;1:a/A;", "1:A/A;2:B/B;", "2:b/B;1:a/A;"], hydrationCalls: 0,
    rx: 'component Row(props: {row: {id: number; value: string}}) { source initial := peek(props.row.value); <span>{"" + props.row.id}:{"" + props.row.value}/{"" + initial};</span> } export component Counter() { source n := 0; rows key id = n % 2 ? [{id:2,value:"b"},{id:1,value:"a"}] : [{id:1,value:"A"},{id:2,value:"B"}]; <button onClick={() => { n := n + 1 }}>{for row in rows { <Row row={row}/> }}</button> }',
    tsx: 'import { createSignal, createProjection, For, untrack } from "solid-js"; function Row(props: {row: {id: number; value: string}}) { const initial = untrack(() => props.row.value); return <span>{props.row.id}:{props.row.value}/{initial};</span>; } export function Counter() { const [n,setN] = createSignal(0); const rows = createProjection(() => n()%2 ? [{id:2,value:"b"},{id:1,value:"a"}] : [{id:1,value:"A"},{id:2,value:"B"}], [], {key:"id"}); return <button onClick={() => setN(n()+1)}><For each={rows}>{row => <Row row={row}/>}</For></button>; }',
  },
  {
    name: "counter", frames: ["4", "6", "8", "10"], hydrationCalls: 0,
    rx: 'export component Counter() { source n := 2; doubled = n * 2; <button onClick={() => { n := n + 1 }}>{"" + doubled}</button> }',
    tsx: 'import { createSignal, createMemo } from "solid-js"; export function Counter() { const [n, setN] = createSignal(2); const doubled = createMemo(() => n() * 2); return <button onClick={() => setN(n() + 1)}>{doubled()}</button>; }',
  },
  {
    name: "async", frames: ["4", "14", "24", "34"], hydrationCalls: 1,
    rx: 'import pure { fetchValue } from "./api"; export component Counter() { source n := 0; result = await fetchValue(n); errored fallback { <p>failed</p> } { loading fallback { <p>waiting</p> } { <button onClick={() => { n := n + 1 }}>{"" + result}</button> } } }',
    tsx: 'import { createSignal, createMemo, Loading, Errored } from "solid-js"; import { fetchValue } from "./api"; export function Counter() { const [n,setN] = createSignal(0); const result = createMemo(async (): Promise<number> => await fetchValue(n())); return <Errored fallback={err => <p>failed</p>}><Loading fallback={<p>waiting</p>}><button onClick={() => setN(n()+1)}>{result()}</button></Loading></Errored>; }',
  },
  {
    name: "two-input-effect", frames: ["0/0", "1/2", "2/3", "3/4"], hydrationCalls: 0,
    // A direct second input makes the apply rerun on every change of n (EF-2 compares each input).
    rx: 'export component Counter() { source n := 0; source runs := 0; effect(n > 2, n) { runs := p => p + 1 } <button onClick={() => { n := n + 1 }}>{"" + n}/{"" + runs}</button> }',
    tsx: 'import { createSignal } from "solid-js"; import { createRxEffect } from "reactivescript-tsx"; export function Counter() { const [n,setN] = createSignal(0); const [runs,setRuns] = createSignal(0); createRxEffect([() => n() > 2, () => n()], (flag, value) => { setRuns(previous => previous + 1); }); return <button onClick={() => setN(n()+1)}>{n()}/{runs()}</button>; }',
  },
  {
    name: "rx-effect", frames: ["0/initial", "1/#error", "2/false", "3/false"], hydrationCalls: 0,
    rx: 'error Boom(); export component Counter() { source n := 0; source last := "initial"; value = n == 1 ? throw Boom() : false; effect(value) { last := "" + $0 } <button onClick={() => { n := n + 1 }}>{"" + n}/{last}</button> }',
    tsx: 'import { createSignal, createMemo } from "solid-js"; import { createRxEffect, defineError, raiseFailure } from "reactivescript-tsx"; const Boom = defineError("Boom", [], () => "boom"); export function Counter() { const [n,setN] = createSignal(0); const [last,setLast] = createSignal("initial"); const value = createMemo(() => n() === 1 ? raiseFailure(Boom()) : false); createRxEffect([() => value()], answer => { setLast("" + answer); }); return <button onClick={() => setN(n()+1)}>{n()}/{last()}</button>; }',
  },
  {
    name: "stream", frames: ["4", "15", "25", "35"], hydrationCalls: 1,
    rx: 'import pure { fetchValue } from "./api"; export component Counter() { source n := 0; value = await* fetchValue(n); errored fallback { <p>failed</p> } { loading fallback { <p>waiting</p> } { <button onClick={() => { n := n + 1 }}>{"" + value}</button> } } }',
    tsx: 'import { createSignal, createMemo, Loading, Errored } from "solid-js"; import { fetchValue } from "./api"; export function Counter() { const [n,setN] = createSignal(0); const value = createMemo((): AsyncIterable<number> => fetchValue(n())); return <Errored fallback={error => <p>failed</p>}><Loading fallback={<p>waiting</p>}><button onClick={() => setN(n()+1)}>{value()}</button></Loading></Errored>; }',
  },
  {
    name: "context", frames: ["0/0", "1/0", "2/0", "3/0"], hydrationCalls: 0,
    rx: 'context Theme: number = 7; export component Counter() { source n := 0; provide Theme = 0; <button onClick={() => { n := n + 1 }}>{"" + n}/{"" + use Theme}</button> }',
    tsx: 'import { createSignal, createContext, useContext } from "solid-js"; const Theme = createContext(7); function Value() { const theme = useContext(Theme); return <span>{theme}</span>; } export function Counter() { const [n,setN] = createSignal(0); return <Theme value={n()}><button onClick={() => setN(n()+1)}>{n()}/<Value/></button></Theme>; }',
  },
  {
    name: "source-context", frames: ["0", "1", "2", "3"], hydrationCalls: 0,
    rx: 'context Count: source number; component Reader() { <button onClick={() => { use Count := use Count + 1 }}>{"" + use Count}</button> } export component Counter() { source count := 0; provide Count = count; <Reader/> }',
    tsx: 'import { createSignal } from "solid-js"; import { createSourceContext, useSourceContext } from "reactivescript-tsx"; const Count = createSourceContext<number>(); function Reader() { const [count,setCount] = useSourceContext(Count); return <button onClick={() => setCount(count()+1)}>{count()}</button>; } export function Counter() { const [count,setCount] = createSignal(0); return <Count value={[count,setCount]}><Reader/></Count>; }',
  },
  {
    name: "typed-failure", frames: ["0/ok", "1/ok", "2/missing 2"], hydrationCalls: 0,
    rx: 'error Missing(id) => "missing " + id; export component Counter() { source n := 0; value = n < 2 ? "ok" : throw Missing(n); <button onClick={() => { n := n + 1 }}>{"" + n}/{errored fallback(e: Missing) { <span>{e.message}</span> } { <span>{value}</span> }}</button> }',
    tsx: 'import { createSignal, createMemo } from "solid-js"; import { defineError, raiseFailure, FailureBoundary } from "reactivescript-tsx"; const Missing = defineError("Missing", ["id"], (id: number) => "missing " + id); export function Counter() { const [n,setN] = createSignal(0); const value = createMemo((): string => n() < 2 ? "ok" : raiseFailure(Missing(n()))); return <button onClick={() => setN(n()+1)}>{n()}/<FailureBoundary classes={[Missing]} fallback={error => <span>{error().message}</span>}><span>{value()}</span></FailureBoundary></button>; }',
  },
  {
    // hydrationCalls records a shared limitation, not a goal: on the old pin both syntaxes re-invoked the loader's JS
    // API once during hydration. At reactivescript aa85cbde both syntaxes reuse the streamed server answer (0 calls).
    name: "server-loader", frames: ["4", "14", "24", "34"], hydrationCalls: 0,
    rx: 'import pure { fetchValue } from "./api"; server fn load(n) { let value = await fetchValue(n); return value } export component Counter() { source n := 0; value = await load(n); errored fallback { <p>failed</p> } { loading fallback { <p>waiting</p> } { <button onClick={() => { n := n + 1 }}>{"" + value}</button> } } }',
    tsx: 'import { createSignal, createMemo, Loading, Errored } from "solid-js"; import { serverFunction } from "reactivescript-tsx"; import { fetchValue } from "./api"; const load = serverFunction("load", function* (n: number): Generator<unknown, number, number> { const value: number = yield fetchValue(n); return value; }); export function Counter() { const [n,setN] = createSignal(0); const value = createMemo(async (): Promise<number> => await load(n())); return <Errored fallback={error => <p>failed</p>}><Loading fallback={<p>waiting</p>}><button onClick={() => setN(n()+1)}>{value()}</button></Loading></Errored>; }',
  },
  {
    name: "server-factories", frames: ["4/5", "5/6", "6/7", "7/8"], hydrationCalls: 0,
    rx: 'component Left(props: {n: number}) { server fn load(x) { return x + 4 } answer = await load(props.n); <span>{"" + answer}/</span> } component Right(props: {n: number}) { server fn load(x) { return x + 5 } answer = await load(props.n); <span>{"" + answer}</span> } export component Counter() { source n := 0; <button onClick={() => { n := n + 1 }}>{errored fallback { <span>failed</span> } { loading fallback { <span>waiting</span> } { <Left n={n}/><Right n={n}/> } }}</button> }',
    tsx: 'import { createSignal, createMemo, Loading, Errored } from "solid-js"; import { serverFunction } from "reactivescript-tsx"; function Left(props: {n: number}) { const load = serverFunction("load", function* (x: number): Generator<unknown, number, unknown> { return x + 4; }); const answer = createMemo(async (): Promise<number> => await load(props.n)); return <span>{answer()}/</span>; } function Right(props: {n: number}) { const load = serverFunction("load", function* (x: number): Generator<unknown, number, unknown> { return x + 5; }); const answer = createMemo(async (): Promise<number> => await load(props.n)); return <span>{answer()}</span>; } export function Counter() { const [n,setN] = createSignal(0); return <button onClick={() => setN(n()+1)}><Errored fallback={<span>failed</span>}><Loading fallback={<span>waiting</span>}><Left n={n()}/><Right n={n()}/></Loading></Errored></button>; }',
  },
];

for (const scenario of scenarios) for (const syntax of (["rx-effect", "server-factories", "async-handler"].includes(scenario.name) ? ["rx", "tsx", "native"] : ["rx", "tsx"]) as ("rx" | "tsx" | "native")[]) test(syntax + " " + scenario.name + (syntax === "tsx" && scenario.tsxRefused ? " is refused at its authored async callback (issue #20)" : " streams HTML, adopts the same DOM on hydration, then updates on clicks"), async () => {
  const source = syntax === "native" ? scenario.tsx : scenario[syntax], expectedFrames = scenario.frames;
  if (syntax === "tsx" && scenario.tsxRefused) {
    for (const target of ["ssr", "dom"] as const)
      assert.throws(() => buildTsx("Counter.tsx", path => path === "Counter.tsx" ? source : path === "api.d.rx" ? "export pure fn fetchValue(n: number): number" : undefined, { target, mount: "Counter" }), scenario.tsxRefused);
    return;
  }
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "tsx-browser-");
  try {
    for (const target of ["ssr", "dom"] as const) {
      mkdirSync(dir + "/" + target);
      if (syntax === "native") {
        const code = transform(source, { filename: "Counter.tsx", generate: target, hydratable: true, moduleName: "@solidjs/web" }).code.replaceAll('"./api"', '"./api.mjs"');
        writeFileSync(dir + "/" + target + "/main.mts", code);
        writeFileSync(dir + "/" + target + "/api.mjs", "export const fetchValue = value => globalThis.__browserLoad(value);");
        continue;
      }
      const input = "Counter." + syntax;
      const result = buildTsx(input, path => path === input ? source : path === "api.d.rx" ? "export pure fn fetchValue(n: number): number" : undefined, { target, mount: "Counter" });
      for (const [name, code] of result.files) writeFileSync(dir + "/" + target + "/" + name, code);
    }
    const serverRuntime = runtimeFiles.server;
    const clientRuntime = runtimeFiles.web;
    const server = [
      "import { createApp, generateHydrationScript } from " + JSON.stringify(serverRuntime) + ";",
      syntax === "native" ? 'import { Counter } from "./ssr/main.mts";' : 'import main from "./ssr/main.mjs";',
      scenario.name === "stream"
        ? "const app = createApp({api: {fetchValue: async function* (value) { yield value * 10 + 4; yield value * 10 + 5; }}});"
        : "const app = createApp({api: {fetchValue: value => Promise.resolve(value * 10 + 4)}});",
      "let html = '';",
      "await new Promise(resolve => { app.stream(" + (syntax === "native" ? "() => Counter()" : "main(app)") + ", { write: chunk => { html += chunk; }, end: resolve }); });",
      "process.stdout.write(JSON.stringify({html, script: generateHydrationScript()}));",
    ].join("\n");
    writeFileSync(dir + "/server.mjs", server);
    const rendered = spawnSync(process.execPath, ["--experimental-strip-types", "--conditions=development", dir + "/server.mjs"], { encoding: "utf8", timeout: 15000 });
    assert.equal(rendered.status, 0, rendered.stderr);
    const payload = JSON.parse(rendered.stdout);
    const entry = [
      "import { createApp, flush } from " + JSON.stringify(clientRuntime) + ";",
      syntax === "native" ? 'import { Counter } from "./dom/main.mts";' : 'import main from "./dom/main.mjs";',
      scenario.name === "stream"
        ? 'window.__clientCalls = 0; const app = createApp({root: document.getElementById("app"), api: {fetchValue: async function* (value) { window.__clientCalls++; yield value * 10 + 4; yield value * 10 + 5; }}});'
        : scenario.name === "async-handler"
        ? 'window.__clientCalls = 0; globalThis.__browserLoad = value => { window.__clientCalls++; return new Promise(resolve => { window.__release = () => resolve(value * 10 + 4); }); }; const app = createApp({root: document.getElementById("app"), api: {fetchValue: globalThis.__browserLoad}});'
        : 'window.__clientCalls = 0; const app = createApp({root: document.getElementById("app"), api: {fetchValue: value => { window.__clientCalls++; return Promise.resolve(value * 10 + 4); }}});',
      "app.mount(" + (syntax === "native" ? "() => Counter()" : "main(app)") + ", true); flush(); window.__hydrated = true;",
    ].join("\n");
    writeFileSync(dir + "/client.mjs", entry);
    const bundle = buildSync({ entryPoints: [dir + "/client.mjs"], bundle: true, write: false,
      platform: "browser", format: "iife", conditions: ["browser", "development"], tsconfigRaw: "{}", logLevel: "silent" }).outputFiles[0].text;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setContent('<!doctype html><html><head>' + payload.script + '</head><body><div id="app">' + payload.html + '</div></body></html>');
      assert.equal(await page.locator("button").textContent(), expectedFrames[0]);
      await page.evaluate(() => { (window as any).__serverButton = document.querySelector("button"); });
      await page.addScriptTag({ content: bundle });
      assert.deepEqual(errors, [], "hydration must not raise browser errors");
      assert.equal(await page.evaluate(() => (window as any).__hydrated), true);
      // The current RX runtime invokes a direct JS API once during hydration too.
      assert.equal(await page.evaluate(() => (window as any).__clientCalls), scenario.hydrationCalls, "TSX must retain the RX hydration baseline");
      assert.equal(await page.evaluate(() => (window as any).__serverButton === document.querySelector("button")), true, "hydration must adopt rather than replace the server DOM");
      if (scenario.name === "stream") await page.waitForFunction(() => document.querySelector("button")?.textContent === "5");
      for (const [index, expected] of expectedFrames.slice(1).entries()) {
        if (scenario.name === "input-events") await page.locator("input").fill(expected);
        else await page.locator("button").click();
        if (scenario.name === "async-handler") {
          await page.waitForFunction(text => document.querySelector("button")?.textContent === text, "1/" + index);
          assert.equal(await page.evaluate(() => (window as any).__clientCalls), index + 1);
          await page.evaluate(() => (window as any).__release());
        }
        try { await page.waitForFunction(text => document.querySelector("button")?.textContent === text, expected); }
        catch (error) {
          assert.equal(await page.locator("button").textContent(), expected, syntax + " " + scenario.name + ": " + errors.join(", "));
          throw error;
        }
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
