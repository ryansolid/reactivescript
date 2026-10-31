// Fast contracts for the moving-foundation layout: the import boundary, the pinned stack, and the upstream
// representations the adapter constructs or reads. A failure here is adapter/type/API breakage, not a paired
// behavior mismatch; scripts/canary.sh runs these first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, parseProgram, parseStmts, singleModule } from "./rx/compiler.ts";
import { entryView, serverDecl, selectEntry } from "./rx/ast.ts";
import { semanticFacts } from "./rx/facts.ts";
import { actionInference } from "./rx/infer.ts";
import { lowerTsx, TsxError } from "./lower.ts";

const here = new URL(".", import.meta.url);
const root = new URL("..", import.meta.url);

test("only tsx/rx/ imports the upstream checkout", () => {
  const banned = ["#" + "rx/", "../" + "src/", "../" + "compile/", "upstream" + "/ref/"];
  const files = (readdirSync(here, { recursive: true }) as string[])
    .filter(f => /\.(ts|tsx|mjs)$/.test(f) && !f.startsWith("rx/") && !f.startsWith("fixtures/"));
  assert.ok(files.length > 20);
  for (const f of files) {
    const text = readFileSync(new URL(f, here), "utf8");
    for (const b of banned) assert.ok(!text.includes(b), f + " reaches upstream directly (" + b + ")");
  }
});

test("pinned stack: reactivescript, its ref/SOLID_NEXT and the Solid checkout agree" + (process.env.RX_CANARY ? " (canary: pins not enforced)" : " with pins.json"), () => {
  const pins = JSON.parse(readFileSync(new URL("pins.json", root), "utf8"));
  // In-tree: this package is tsx-frontend/ inside the reactivescript repository, whose HEAD is the branch commit.
  const repo = fileURLToPath(new URL("../", root));
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const solidNext = readFileSync(repo + "ref/SOLID_NEXT", "utf8").trim();
  assert.equal(git(repo + "../solid-next", "rev-parse", "HEAD"), solidNext, "the Solid checkout is upstream's ref/SOLID_NEXT");
  if (!process.env.RX_CANARY) {
    assert.equal(solidNext, pins.solid.commit);
    const pin = pins.reactivescript.commit;
    assert.doesNotThrow(() => git(repo, "merge-base", "--is-ancestor", pin, "HEAD"), "the pinned commit is an ancestor of HEAD");
    // Committed and uncommitted changes to tracked files, plus untracked files, relative to the pin.
    const differing = [
      ...git(repo, "diff", "--name-only", pin, "--").split("\n"),
      ...git(repo, "ls-files", "--others", "--exclude-standard").split("\n"),
    ].filter(Boolean);
    assert.ok(differing.some(f => f.startsWith("tsx-frontend/")), "the comparison sees this package's own files");
    assert.deepEqual(differing.filter(f => !f.startsWith("tsx-frontend/")), [], "nothing outside tsx-frontend/ differs from the pin");
  }
});

test("entry representation: the adapter's default-component entry is what upstream's parser produces (MO-1c)", () => {
  const parsed = parseProgram("export default component App() { <p>x</p> }");
  assert.equal(parsed.legacyView, undefined);
  assert.deepEqual(parsed.view, entryView("App", 1));
  const c = parsed.decls[0];
  assert.ok(c.k === "component" && c.isDefault && c.exported);
  const selected = parseProgram("export component App() { <p>x</p> }");
  selectEntry(selected, "App");
  assert.deepEqual(selected.view, parsed.view);
  assert.deepEqual(selected.decls, parsed.decls);
});

test("server representation: one server declaration kind, io inferred by the checker (SF-1)", () => {
  const [parsed] = parseProgram("server fn load(a) { return a }").decls;
  assert.equal(parsed.k, "server");
  assert.ok(!("kind" in parsed), "no server fn/action split");
  const built = serverDecl("load", ["a"], parseStmts("return a"), 1);
  for (const key of Object.keys(built)) assert.ok(key in parsed, "upstream server decls still carry " + key);
  assert.deepEqual({ ...built, body: undefined }, { k: parsed.k, name: (parsed as any).name, params: (parsed as any).params, body: undefined, line: parsed.line });
});

test("model contract: canonical facts keep read modes, writes and region nesting", () => {
  const facts = semanticFacts(singleModule(parseProgram(
    'export default component App() { source n := 0; d = n * 2; s = peek(n); <button onClick={() => { n := n + 1 }}>{"" + d + s}</button> }')));
  assert.deepEqual(facts.diagnostics, []);
  const m = facts.modules[0];
  assert.ok(m.regions.some(r => r.endsWith("/component:App")));
  const reads = m.computations.flatMap(c => c.reads);
  assert.ok(reads.some(r => r.endsWith("::source:n tracked")));
  assert.ok(reads.some(r => r.endsWith("::source:n snapshot")));
  assert.ok(m.computations.some(c => c.kind === "handler" && c.writes.some(w => w.endsWith("::source:n write"))));
});

// Temporary TSX boundary while https://github.com/ryansolid/reactivescript/issues/20 is open: every authored ordinary
// async callback is refused at its async node, never lowered or converted to an action, with explicit guidance.
const ASYNC_ISSUE = "https://github.com/ryansolid/reactivescript/issues/20";
const ASYNC_CALLBACK = "Ordinary async callbacks are refused for now (" + ASYNC_ISSUE + "): wrap the work in action(function* () { ... yield request(); ... }) and use yield instead of await. This opts into action semantics, which hold the action's writes until it completes; it is not a semantics-preserving rewrite of the async callback";
const ASYNC_ACTION = "Actions take a synchronous generator, not an async function or async generator (" + ASYNC_ISSUE + "): write action(function* () { ... yield request(); ... }) and use yield instead of await";
const refusedAt = (source: string, at: string, message: string) => {
  assert.ok(source.includes(at), "the authored refusal site exists: " + at);
  assert.throws(() => lowerTsx(source, "authored.tsx"), (error: unknown) => {
    assert.ok(error instanceof TsxError);
    assert.equal(error.start, source.indexOf(at), "refused at the authored async node");
    assert.equal(error.message.slice(error.message.indexOf(": ") + 2), message);
    return true;
  });
};

test("inferred-action contract: upstream AC-1b/AC-1c facts; the frontend refuses that callback as ordinary async (issue #20)", () => {
  const [decl] = parseProgram("source n := 0").decls;
  assert.equal(decl.k, "source");
  assert.deepEqual(actionInference(parseStmts("n := 1; let v = await f(); n := v")), { trigger: "write+await", why: "it writes and awaits", held: ["n"] });
  assert.deepEqual(actionInference(parseStmts("let v = await f(); n := v")).held, []);
  assert.equal(actionInference(parseStmts("n := 1")).trigger, null);
  const source = `import { createSignal } from "solid-js";
import { request } from "./api";
export default function Counter() {
  const [n, setN] = createSignal(0);
  return <button onClick={async () => {
    setN(1);
    const result: number = await request();
    setN(result);
  }}>{n()}</button>;
}`;
  // Formerly refused only for its held pre-await write; now refused for being an ordinary async callback.
  refusedAt(source, "async () =>", ASYNC_CALLBACK);
});

const asyncHead = 'import { createSignal, createMemo, action } from "solid-js";\nimport { createRxEffect } from "reactivescript-tsx";\nimport { request } from "./api";\n';
const asyncCounter = (setup: string, view: string, child = "() => props.onChange(2)") => asyncHead +
  "function Child(props: { onChange: (value: number) => void }) { return <button onClick={" + child + "}/>; }\n" +
  "export function Counter() {\n  const [n, setN] = createSignal(0);\n  " + setup + "\n  return " + view + ";\n}";
const onClick = (handler: string) => asyncCounter("", "<button onClick={" + handler + "}>{n()}</button>");
const untouched = "<button onClick={() => setN(1)}>{n()}</button>";

test("ordinary async callbacks are refused at their authored async node on every resolved callback route (issue #20)", () => {
  const routes: [string, string][] = [
    [onClick("async () => { setN(1); const result: number = await request(); setN(result); }"), "async () =>"],
    [onClick("async () => { const result: number = await request(); setN(result); }"), "async () =>"],
    [onClick("async () => { await request(); }"), "async () =>"],
    [onClick("async () => { setN(1); }"), "async () =>"],
    [onClick("async () => setN(1)"), "async () =>"],
    [onClick("async () => await request()"), "async () =>"],
    [onClick("async (mode: number) => { if (mode === 0) return 7; if (mode === 1) throw 1; const answer: number = await 8; return answer; }"), "async (mode"],
    [onClick("async (): Promise<number> => { const result: number = await request(); return result; }"), "async ():"],
    // Contextual void callback prop, and a child forwarding its callback prop through an async arrow.
    [asyncCounter("", "<Child onChange={async (next: number) => { const result: number = await request(next); }}/>"), "async (next"],
    [asyncCounter("", "<Child onChange={(next: number) => setN(next)}/>", "async () => { await props.onChange(2); }"), "async () =>"],
    // Stored callbacks: a const arrow, a nested function declaration, and an async closure inside a sync handler.
    [asyncCounter("const save = async () => { const result: number = await request(); setN(result); };", "<button onClick={() => save()}>{n()}</button>"), "async () =>"],
    [asyncCounter("async function save() { const result: number = await request(); setN(result); }", untouched), "async function save"],
    [onClick("() => { const later = async () => { const result: number = await request(); return result; }; return 7; }"), "async () =>"],
    // Setup callbacks: an effect apply callback and its returned cleanup.
    [asyncCounter("createRxEffect([() => n()], async (value: number) => { await request(); });", untouched), "async (value"],
    [asyncCounter("createRxEffect([() => n()], (value: number) => { return async () => { await request(); }; });", untouched), "async () =>"],
  ];
  for (const [source, at] of routes) refusedAt(source, at, ASYNC_CALLBACK);
});

test("actions refuse async functions and async generators with synchronous-generator guidance (issue #20)", () => {
  const body = "{ const result: number = yield request(); setN(result); }";
  refusedAt(onClick("() => { action(async function* () " + body + ")(); }"), "async function*", ASYNC_ACTION);
  refusedAt(onClick("() => { action(async () => { const result: number = await request(); setN(result); })(); }"), "async () =>", ASYNC_ACTION);
  const declared = (fn: string) => asyncCounter("const save = action(" + fn + ");", "<button onClick={() => save()}>{n()}</button>");
  refusedAt(declared("async function* () " + body), "async function*", ASYNC_ACTION);
  refusedAt(declared("async function () { const result: number = await request(); setN(result); }"), "async function (", ASYNC_ACTION);
  refusedAt(declared("async () => { const result: number = await request(); setN(result); }"), "async () =>", ASYNC_ACTION);
});

test("explicit generator actions and async memo/server computations stay accepted beside the refusal (issue #20)", () => {
  const body = "{ try { const result: number = yield request(); setN(result); } catch (error) { setN(-1); } }";
  const declared = asyncCounter("const save = action(function* () " + body + ");", "<button onClick={() => save()}>{n()}</button>");
  const inline = onClick("() => { action(function* () " + body + ")(); }");
  for (const source of [declared, inline]) {
    const program = lowerTsx(source);
    assert.deepEqual(check(program), []);
    const counter = program.decls.find(d => d.k === "component" && d.name === "Counter");
    assert.ok(counter?.k === "component");
    const handler = counter.view[0].k === "el" ? counter.view[0].attrs.find(a => a.name === "onClick")?.e : undefined;
    const action = source === declared ? counter.decls.find(d => d.k === "action") : handler?.k === "fn" ? handler.stmts?.[0] : undefined;
    assert.ok(action?.k === "action", "the explicit generator lowers to an action");
    const attempt = action.body[0];
    assert.ok(attempt.k === "try" && attempt.body[0].k === "let");
    assert.equal(attempt.body[0].e.k, "await", "yield lowers to the action body's await");
  }
  // Async computations are not callbacks: they keep their own routes and are not swept up by the refusal.
  assert.doesNotThrow(() => lowerTsx(asyncCounter("const value = createMemo(async (): Promise<number> => await request(n()));", "<button onClick={() => setN(1)}>{value()}</button>")));
  assert.doesNotThrow(() => lowerTsx('import { serverFunction, createServerMemo } from "reactivescript-tsx";\nexport function Counter() {\n  const load = serverFunction("load", function* (n: number): Generator<unknown, number, number> { return n + 1; });\n  const value = createServerMemo(async () => await load(0));\n  return <span>{value()}</span>;\n}'));
});

test("async callbacks are refused whatever their name; nested synchronous components keep their own refusal (issue #20)", () => {
  const asyncSave = "async function Save() { const result: number = await request(); setN(result); }";
  refusedAt(asyncCounter(asyncSave, "<button onClick={() => Save()}>{n()}</button>"), "async function Save", ASYNC_CALLBACK);
  refusedAt(asyncCounter("async function Save() { await request(); }", "<button onClick={Save}>{n()}</button>"), "async function Save", ASYNC_CALLBACK);
  refusedAt(asyncCounter("const Save = async () => { await request(); };", "<button onClick={() => Save()}>{n()}</button>"), "async () =>", ASYNC_CALLBACK);
  refusedAt(asyncCounter("function Badge() { return <i>x</i>; }", untouched), "function Badge",
    "Nested component declarations are unsupported; use module components");
});
