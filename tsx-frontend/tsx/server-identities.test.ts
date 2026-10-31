import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { createMemo, createRoot, getOwner } from "@solidjs/signals";
import { serverFunction } from "./primitives.ts";
import { buildTsx } from "./build.ts";
import { STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";
import { Runtime } from "./rx/runtime.ts";
import { compile, lowerViews, parseProgram } from "./rx/compiler.ts";

const imports = 'import { createSignal, action, Loading, Errored, untrack } from "solid-js"; import { serverFunction, serverAction, createServerMemo, refresh } from "reactivescript-tsx";';
const boundary = (body: string) => '<Errored fallback={error => <p>failed</p>}><Loading fallback={<p>waiting</p>}>' + body + "</Loading></Errored>";
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise<void>(resolve => setImmediate(resolve)); flush(); } };
const buttons = (node: any): any[] => node.tag === "button" ? [node] : (node.children ?? []).flatMap(buttons);

async function differential(source: string, expected: string[], options: {
  clicks?: number[];
  api?: () => Record<string, (...args: any[]) => unknown>;
  declarations?: string;
  interpreted?: boolean;
} = {}) {
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "server-identities-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  const primitives = fileURLToPath(new URL("./primitives.ts", import.meta.url));
  const inputs: Record<string, string> = { "main.tsx": source };
  if (options.declarations) inputs["api.d.rx"] = options.declarations;
  const all: string[][] = [];
  try {
    for (const target of ["native", "compiled"]) {
      const api = options.api?.() ?? {};
      (globalThis as any).__serverIdentityApi = api;
      writeFileSync(dir + "/api.mjs", Object.keys(api).map(name => `export const ${name} = (...args) => globalThis.__serverIdentityApi.${name}(...args);`).join("\n"));
      let entry: string;
      if (target === "native") {
        entry = "native.mts";
        const code = transform(source, { filename: "main.tsx", generate: "universal", moduleName: STRING_RENDERER }).code
          .replaceAll('"reactivescript-tsx"', JSON.stringify(primitives)).replaceAll('"./api"', '"./api.mjs"');
        writeFileSync(dir + "/" + entry, code.replaceAll(STRING_RENDERER, renderer));
      } else {
        const built = buildTsx("main.tsx", path => inputs[path], { target: "universal", mount: "Counter" });
        entry = built.entry;
        for (const [name, code] of built.files) writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
        if (options.interpreted) assert.equal(new Runtime(built.set).step([]).at(-1)!.frame, expected[0], "interpreter");
      }
      const module = await import(pathToFileURL(dir + "/" + entry).href);
      const app = createApp({ api });
      const dispose = app.mount(target === "native" ? () => module.Counter() : module.default(app));
      try {
        await settle();
        const frames = [app.frame()];
        for (const index of options.clicks ?? []) {
          const button = buttons(app.root)[index];
          assert.equal(typeof button?.props.onClick, "function", target + " authored handler " + index);
          button.props.onClick(); await settle(); frames.push(app.frame());
        }
        assert.deepEqual(frames, expected, target);
        all.push(frames);
      } finally { dispose(); }
    }
    assert.deepEqual(all[1], all[0], "compiled must agree with the native helper trace");
  } finally { delete (globalThis as any).__serverIdentityApi; rmSync(dir, { recursive: true, force: true }); }
}

test("same-named server factories in distinct components do not share loader answers", async () => {
  const source = imports + 'function Left() { const load = serverFunction("load", function*(n: number): Generator<unknown, number, number> { return n + 1; }); const value = createServerMemo(async () => await load(0)); return <span>{value()}</span>; } function Right() { const load = serverFunction("load", function*(n: number): Generator<unknown, number, number> { return n + 2; }); const value = createServerMemo(async () => await load(0)); return <span>{value()}</span>; } export function Counter() { return ' + boundary("<div><Left/>/<Right/></div>") + "; }";
  await differential(source, ["1/2"], { interpreted: true });
});

test("instances of one component keep server arguments and loader caches separate", async () => {
  // A setup snapshot is an RX source, which a server body cannot name (SF-3): it is passed as an argument instead.
  const source = imports + 'function Item(props: { offset: number; n: number }) { const offset = untrack(() => props.offset); const load = serverFunction("load", function*(n: number, at: number): Generator<unknown, number, number> { return n + at; }); const value = createServerMemo(() => load(props.n, offset)); return <span>{value()}</span>; } export function Counter() { const [n, setN] = createSignal(0); return ' + boundary('<button onClick={() => setN(n() + 1)}><Item offset={4} n={n()}/>/<Item offset={5} n={n()}/></button>') + "; }";
  await differential(source, ["4/5", "5/6", "6/7", "7/8"], { clicks: [0, 0, 0] });
  const captured = source
    .replace("function*(n: number, at: number): Generator<unknown, number, number> { return n + at; }", "function*(n: number): Generator<unknown, number, number> { return n + offset; }")
    .replace("load(props.n, offset)", "load(props.n)");
  assert.throws(
    () => buildTsx("main.tsx", path => path === "main.tsx" ? captured : undefined, { mount: "Counter" }),
    /SERVER_CAPTURE \(SF-3\) main\.tsx:1: a server function's body names offset, a source/,
  );
});

const tickApi = () => {
  const counts = new Map<string, number>();
  return { tick(offset: number, n: number) { const key = offset + ":" + n; const count = counts.get(key) ?? 0; counts.set(key, count + 1); return offset + n * 10 + count; } };
};

test("refresh uses the actual getter after argument changes and cached argument reuse", async () => {
  const source = imports + 'import { tick } from "./api"; function Item(props: { offset: number }) { const offset = untrack(() => props.offset); const [n, setN] = createSignal(0); const load = serverFunction("load", function*(input: number, at: number): Generator<unknown, number, number> { return tick(at, input); }); const result = createServerMemo(() => load(n(), offset)); return <div><button onClick={() => setN(1 - n())}>{result()}</button><button onClick={() => refresh(result)}></button></div>; } export function Counter() { return ' + boundary("<div><Item offset={4}/>/<Item offset={5}/></div>") + "; }";
  await differential(source, ["4/5", "14/5", "14/15", "15/15", "16/15", "16/16", "4/16", "5/16", "5/5", "5/6"], {
    clicks: [0, 2, 1, 1, 3, 0, 1, 2, 3], api: tickApi, declarations: "export server pure fn tick(offset: number, n: number): number",
  });
});

test("same-named server actions in different instances remain fresh requests", async () => {
  const source = imports + 'import { tick } from "./api"; function Item(props: { offset: number }) { const offset = untrack(() => props.offset); const run = serverAction("run", function*(n: number, at: number): Generator<unknown, number, number> { return tick(at, n); }); const [result, setResult] = createSignal(0); const click = action(function*() { try { const answer: number = yield run(0, offset); setResult(answer); } catch (error) { setResult(-1); } }); return <button onClick={() => click()}>{result()}</button>; } export function Counter() { return ' + boundary("<div><Item offset={4}/>/<Item offset={5}/></div>") + "; }";
  await differential(source, ["0/0", "4/0", "5/0", "5/5", "5/6"], { clicks: [0, 0, 1, 1], api: tickApi, declarations: "export server pure fn tick(offset: number, n: number): number" });
});

for (const factory of ["serverFunction", "serverAction"]) test(factory + " detaches initial, rejection and continuation steps from the client owner", async () => {
  const read = factory === "serverFunction" ? 'const value = createServerMemo(() => load());' : 'const [value, setValue] = createSignal(0); const click = action(function*() { try { const answer: number = yield load(); setValue(answer); } catch (error) { setValue(-1); } });';
  const view = factory === "serverFunction" ? "<p>{value()}</p>" : '<button onClick={() => click()}>{value()}</button>';
  const source = imports + 'import { owned, rejected, resolved } from "./api"; export function Counter() { const load = ' + factory + '("load", function*(): Generator<unknown, number, number> { const startOwned: boolean = owned(); const before = startOwned ? 1000 : 0; try { yield rejected(); } catch (error) { const caughtOwned: boolean = owned(); const caught = caughtOwned ? 100 : 0; const result: number = yield resolved(); const resumedOwned: boolean = owned(); return before + caught + result + (resumedOwned ? 10 : 0); } return 999; }); ' + read + " return " + boundary(view) + "; }";
  await differential(source, factory === "serverFunction" ? ["7"] : ["0", "7"], {
    clicks: factory === "serverFunction" ? [] : [0],
    declarations: "export server pure fn owned(): boolean\nexport server pure fn rejected(): number\nexport server pure fn resolved(): number",
    api: () => ({ owned: () => { assert.equal(Boolean(getOwner()), false, "API must be detached"); return false; }, rejected: () => Promise.reject(new Error("offline")), resolved: () => Promise.resolve(7) }),
  });
});

/** The compiled bridge for `server fn name(…) { body }` exactly as the pinned emitter builds it (emit.ts SF-7a: a
 *  module-level "use server" function running the body through serverCall, called through serverRef). Called in
 *  reactive scope a server fn is a question (one flight per argument key); called imperatively, a new request (SF-2). */
type App = ReturnType<typeof createApp>;
const compiledServerFn = (app: App, name: string, gen: (...a: any[]) => Generator<unknown, unknown, unknown>) =>
  app.serverRef(name, (...a: unknown[]) => app.serverCall(name, gen, a)) as (...a: unknown[]) => { first: Promise<unknown> };
/** Runs f as the body of a computation, so server fn calls in it are questions. */
function asQuestion<T>(f: () => T): T {
  return createRoot(() => { let value!: T; const memo = createMemo(() => { value = f(); return 0; }); memo(); return value; });
}
async function compiledFrame(source: string): Promise<string> {
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "server-keys-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  try {
    const file = lowerViews(new Map([["main.mjs", compile(parseProgram(source))]]), "universal").get("main.mjs")!;
    writeFileSync(dir + "/main.mjs", file.replaceAll(STRING_RENDERER, renderer));
    const mod = await import(pathToFileURL(dir + "/main.mjs").href);
    const app = createApp();
    const dispose = app.mount(mod.default(app));
    try { await settle(); return app.frame(); } finally { dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("server loader keys preserve wire argument types, delimiters and numeric edge cases", async () => {
  const args: unknown[][] = [[1], ["1"], ["a,b", "c"], ["a", "b,c"], [undefined], ["undefined"], [NaN], [null], [Infinity], [-Infinity], [-0], [0], [{ a: undefined }], [{}], [[undefined]], [[]], [Array(1)], [{ a: 1, b: 2 }]];
  {
    let calls = 0;
    const load = serverFunction("load", function*(..._args: unknown[]) { return calls++; });
    const requests = args.map(values => load(...values));
    assert.deepEqual(await Promise.all(requests), args.map((_, i) => i), "native");
    args.forEach((values, i) => assert.equal(load(...values), requests[i], "equivalent arguments reuse their request"));
    assert.equal(load({ b: 2, a: 1 }), requests.at(-1), "record insertion order is not request identity");
    await assert.rejects(load(() => 1), /WIRE_VALUE/, "validation must precede the cache lookup");
  }
  {
    const app = createApp();
    let calls = 0;
    const load = compiledServerFn(app, "load", function*(..._args: unknown[]) { return calls++; });
    const requests = asQuestion(() => args.map(values => load(...values)));
    assert.deepEqual(await Promise.all(requests.map(r => r.first)), args.map((_, i) => i), "compiled questions: one request per distinct argument list");
    asQuestion(() => args.forEach((values, i) => assert.equal(load(...values), requests[i], "equivalent arguments reuse their question")));
    asQuestion(() => assert.equal(load({ b: 2, a: 1 }), requests.at(-1), "record insertion order is not question identity"));
    await assert.rejects(asQuestion(() => load(() => 1)).first, /WIRE_VALUE/, "validation must precede the cache lookup");
    assert.notEqual(load(1), load(1), "imperative calls are new requests (SF-2)");
  }
  const program = 'server fn load(x) { return x === 1 ? "number" : "string" } server fn first(x, y) { return x } a = await load(1); b = await load("1"); c = await first("a,b", "c"); d = await first("a", "b,c"); export default component App() { errored fallback(e) { <p>failed</p> } { <p>{a}/{b}/{c}/{d}</p> } }';
  assert.equal(new Runtime(parseProgram(program)).step([]).at(-1)!.frame, "number/string/a,b/a", "interpreter server-only keying");
  assert.equal(await compiledFrame(program), "number/string/a,b/a", "compiled server-only keying");
});

test("server fns with the same name in distinct modules keep distinct question identities", async () => {
  const app = createApp();
  const gate: { resolve?: (n: number) => void } = {};
  const answer = new Promise<number>(resolve => { gate.resolve = resolve; });
  const left = compiledServerFn(app, "load", function*(n: number) { const value = (yield answer) as number; return value + n + 1; });
  const right = compiledServerFn(app, "load", function*(n: number) { const value = (yield answer) as number; return value + n + 2; });
  const [first, second] = asQuestion(() => [left(3), right(3)]);
  assert.notEqual(first, second, "two server fns named load are two questions");
  asQuestion(() => { assert.equal(left(3), first); assert.equal(right(3), second); });
  gate.resolve!(7);
  assert.deepEqual(await Promise.all([first.first, second.first]), [11, 12]);
});

test("server setup is detached too; loaders reuse and actions never reuse requests", async () => {
  for (const native of [true, false]) {
    const app = createApp();
    const phases: string[] = [];
    const body = () => {
      assert.equal(Boolean(getOwner()), false, "generator setup"); phases.push("setup");
      return (function*(): Generator<unknown, number, number> {
        assert.equal(Boolean(getOwner()), false, "initial next"); phases.push("next");
        try { yield Promise.reject(new Error("offline")); } catch { assert.equal(Boolean(getOwner()), false, "throw"); phases.push("throw"); }
        const value = yield Promise.resolve(7);
        assert.equal(Boolean(getOwner()), false, "resumed next"); phases.push("resume"); return value;
      })();
    };
    const run = createRoot(dispose => {
      if (native) {
        const load = serverFunction("load", body);
        const first = load(); assert.equal(load(), first, "a loader reuses its argument flight");
        return { first, dispose };
      }
      const load = compiledServerFn(app, "load", body as () => Generator<unknown, unknown, unknown>);
      const first = asQuestion(() => load());
      asQuestion(() => assert.equal(load(), first, "a loader question reuses its argument flight"));
      return { first: first.first, dispose };
    });
    try { assert.equal(await run.first, 7); assert.deepEqual(phases, ["setup", "next", "throw", "resume"]); } finally { run.dispose(); }
    const crashBody = function*() { throw undefined; };
    const crash = native ? serverFunction("crash", crashBody) : compiledServerFn(app, "crash", crashBody);
    const crashed = crash() as unknown;
    await assert.rejects(native ? crashed as Promise<unknown> : (crashed as { first: Promise<unknown> }).first, /Internal Server Error/, "undeclared throws remain transport failures");
  }
  const app = createApp();
  const action = compiledServerFn(app, "run", function*() { return 1; });
  assert.notEqual(action(), action(), "imperative server calls (actions) always allocate a new request");
});
