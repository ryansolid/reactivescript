import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadModules } from "./rx/compiler.ts";
import { checkModules } from "./rx/compiler.ts";
import { printSignature } from "./rx/compiler.ts";
import { Runtime } from "./rx/runtime.ts";
import { compileModules } from "./rx/compiler.ts";
import { lowerViews, STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";

const types = 'export error Missing(id) => "missing"';
const reader = 'import { Missing as Absent } from "./types.rx"; export value = throw Absent(1); export component Reader() { <p>{value}</p> }';

function checked(files: Record<string, string>) {
  const set = loadModules("main.rx", path => files[path]);
  return { set, ...checkModules(set) };
}

async function trace(files: Record<string, string>, expected: string) {
  const { set, diags } = checked(files);
  assert.deepEqual(diags, []);
  assert.equal(new Runtime(set).step([]).at(-1)!.frame, expected);
  const built = compileModules(set);
  const output = lowerViews(built.files, "universal");
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "failure-identities-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  try {
    for (const [name, text] of output) writeFileSync(dir + "/" + name, text.replaceAll(STRING_RENDERER, renderer));
    const module = await import(pathToFileURL(dir + "/" + built.entry).href);
    const app = createApp();
    const dispose = app.mount(module.default(app));
    try { flush(); assert.equal(app.frame(), expected); } finally { dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("RX imported component failures and aliased boundaries share declaration identity", async () => {
  const files = {
    "types.rx": types,
    "reader.rx": reader,
    "main.rx": 'import { Missing as Lost } from "./types.rx"; import { Reader } from "./reader.rx"; export default component App() { errored fallback(e: Lost) { <p>{e.message}</p> } { <Reader/> } }',
  };
  const { diags, sigs } = checked(files);
  assert.deepEqual(diags, []);
  const error = sigs.get("types.rx")!.exports.get("Missing")!;
  const component = sigs.get("reader.rx")!.exports.get("Reader")!;
  const value = sigs.get("reader.rx")!.exports.get("value")!;
  assert.equal(error.kind, "errclass");
  assert.equal(component.kind, "comp");
  assert.equal(value.kind, "eq");
  if (error.kind !== "errclass" || component.kind !== "comp" || value.kind !== "eq") return;
  assert.deepEqual(value.fails, [error.key]);
  assert.deepEqual(component.sig.own.map(x => x.cls), [error.key]);
  assert.match(printSignature(sigs.get("reader.rx")!), /fails\(Missing\)/);
  assert.doesNotMatch(printSignature(sigs.get("reader.rx")!), /types\.rx#|Absent/);
  await trace(files, "missing");
});

test("RX expression catches resolve aliases from a value signature", async () => {
  await trace({
    "types.rx": types,
    "reader.rx": reader,
    "main.rx": 'import { Missing as Lost } from "./types.rx"; import { value } from "./reader.rx"; export default component App() { <p>{value catch (e: Lost) => "caught"}</p> }',
  }, "caught");
});

test("RX component prop and children catch summaries retain class identity", async () => {
  const { sigs, diags } = checked({
    "types.rx": types,
    "safe.rx": 'import { Missing as Absent } from "./types.rx"; export component Safe(props) { errored fallback(e: Absent) { <p>safe</p> } { {props.children} } }',
    "main.rx": 'import { Missing as Lost } from "./types.rx"; import { Safe } from "./safe.rx"; value = throw Lost(1); export default component App() { <Safe><p>{value}</p></Safe> }',
  });
  assert.deepEqual(diags, []);
  assert.match(printSignature(sigs.get("safe.rx")!), /children: catches\(Missing\)/);
  await trace({
    "types.rx": types,
    "safe.rx": 'import { Missing as Absent } from "./types.rx"; export component Safe(props) { <p>{props.text catch (e: Absent) => "safe"}</p> }',
    "main.rx": 'import { Missing as Lost } from "./types.rx"; import { Safe } from "./safe.rx"; value = throw Lost(1); export default component App() { <Safe text={value}/> }',
  }, "safe");
});

test("same-named classes in separate RX modules do not discharge each other", async () => {
  const files = {
    "types.rx": types,
    "other.rx": types,
    "reader.rx": reader,
    "main.rx": 'import { Missing } from "./other.rx"; import { Reader } from "./reader.rx"; export default component App() { errored fallback(e: Missing) { <p>wrong</p> } { <Reader/> } }',
  };
  const { diags } = checked(files);
  assert.deepEqual(diags.map(d => d.code), ["UNHANDLED_FAILURE"]);
  assert.match(diags[0].msg, /can fail with Missing/);
  assert.doesNotMatch(diags[0].msg, /types\.rx#/);
  await trace({ ...files, "main.rx": 'import { Missing } from "./other.rx"; import { Reader } from "./reader.rx"; export default component App() { errored fallback(e: Error) { <p>outer</p> } { errored fallback(e: Missing) { <p>wrong</p> } { <Reader/> } } }' }, "outer");
});

test("nested shadowed RX error declarations have distinct identities", async () => {
  const decls = 'error Missing(); component Reader() { error Missing(); value = throw Missing(); <p>{value}</p> }';
  const body = 'export default component App() { errored fallback(e: Missing) { <p>wrong</p> } { <Reader/> } }';
  assert.deepEqual(checked({ "main.rx": decls + body }).diags.map(d => d.code), ["UNHANDLED_FAILURE"]);
  await trace({ "main.rx": decls + 'errored fallback(e: Error) { <p>outer</p> } { ' + body + " }" }, "outer");
});

test("same class imported under two aliases matches typed action catches and rethrows", () => {
  const { diags } = checked({
    "types.rx": types,
    "main.rx": 'import { Missing as First, Missing as Second } from "./types.rx"; action run() { try { try { throw First(1) } catch (e: Second) { throw e } } catch (e: First) { } } export default component App() { <button onClick={() => { run() }}>run</button> }',
  });
  assert.deepEqual(diags, []);
});

test("RX rethrows retain every identity from a union catch", () => {
  const { diags } = checked({
    "types.rx": types + "; export error Other()",
    "main.rx": 'import { Missing as Lost, Other as Else } from "./types.rx"; source choose := true; value = choose ? throw Lost(1) : throw Else(); result = value catch (e: Lost | Else) => throw e; export default component App() { <p>{result catch (e: Lost | Else) => "caught"}</p> }',
  });
  assert.deepEqual(diags, []);
});

test("JS fails clauses and exported fn rejection rows resolve forward RX aliases", () => {
  const { diags, sigs } = checked({
    "types.rx": types,
    "request.rx": 'import pure { fetch } from "./api" fails Absent; import { Missing as Absent } from "./types.rx"; export fn request() => fetch("item")',
    "main.rx": 'import { Missing as Lost } from "./types.rx"; import { request } from "./request.rx"; value = await request(); export default component App() { <p>{value catch (e: Lost) => "caught"}</p> }',
  });
  assert.deepEqual(diags, []);
  assert.match(printSignature(sigs.get("request.rx")!), /rejects\(Missing\)/);
  assert.doesNotMatch(printSignature(sigs.get("request.rx")!), /types\.rx#|Absent/);
});

test("server function and action signatures print parameters and readable rejection identities", () => {
  const { diags, sigs } = checked({
    "types.rx": types,
    // Pinned SF-1: one `server fn` form (the old `server action` spelling is gone); the printer marks purity itself.
    "main.rx": 'import { Missing as Lost } from "./types.rx"; export server fn read(id) { throw Lost(id) } export server fn save(id, next) { throw Lost(next) } export server fn ping() { return 1 }',
  });
  assert.deepEqual(diags, []);
  const text = printSignature(sigs.get("main.rx")!);
  assert.deepEqual(text.trimEnd().split("\n").slice(1), [
    // Readable identities name the declared class (Missing), never the importer's local alias (Lost).
    "export server pure fn read(id) rejects(Error | Missing)",
    "export server pure fn save(id, next) rejects(Error | Missing)",
    "export server pure fn ping() rejects(Error)",
  ]);
  assert.doesNotMatch(text, /types\.rx#|Lost|undefined/);
});

test("declared JS errors match aliases and declaration-local rejects through RX signatures", () => {
  const files = {
    "api.d.rx": "export error Missing\nexport pure fn query() rejects(Missing)\n",
    "request.rx": 'import { query } from "./api.js"; export fn request() => query()',
    "main.rx": 'import { Missing as Lost } from "./api.js"; import { request } from "./request.rx"; value = await request(); export default component App() { <p>{value catch (e: Lost) => "caught"}</p> }',
  };
  assert.deepEqual(checked(files).diags, []);
  assert.deepEqual(checked({ ...files, "main.rx": 'import { Missing as First, Missing as Second } from "./api.js"; value = throw First(1); export default component App() { <p>{value catch (e: Second) => "caught"}</p> }' }).diags, []);
  assert.deepEqual(checked({ ...files, "other.d.rx": "export error Missing\n", "main.rx": 'import { Missing } from "./other.js"; import { request } from "./request.rx"; value = await request(); export default component App() { <p>{value catch (e: Missing) => "wrong"}</p> }' }).diags.map(d => d.code), ["UNHANDLED_FAILURE"]);
});

test("unknown JS promise defaults remain Error and declared io calls stay io", () => {
  const main = 'import { Missing as Lost } from "./types.rx"; import pure { query } from "./unknown.js"; value = await query(); export default component App() { <p>{value catch (e: Lost) => "wrong"}</p> }';
  const { diags } = checked({ "types.rx": types, "main.rx": main });
  assert.deepEqual(diags.map(d => d.code), ["UNHANDLED_FAILURE"]);
  assert.match(diags[0].msg, /can fail with Error/);
  assert.deepEqual(checked({ "types.rx": types, "main.rx": main.replace("e: Lost", "e: Error") }).diags, []);
  const io = checked({
    "api.d.rx": "export error Missing\nexport fn query() rejects(Missing)\n",
    "main.rx": 'import { query, Missing as Lost } from "./api.js"; value = await query(); export default component App() { <p>{value catch (e: Lost) => "caught"}</p> }',
  }).diags;
  assert.ok(io.some(d => d.code === "IO_IN_REACTIVE"));
  assert.ok(!io.some(d => d.code === "UNHANDLED_FAILURE"));
});

test("Panic boundaries do not discharge declared failure identities", () => {
  const { diags } = checked({
    "types.rx": types,
    "reader.rx": reader,
    "main.rx": 'import { Reader } from "./reader.rx"; export default component App() { errored fallback(e: Panic) { <p>panic</p> } { <Reader/> } }',
  });
  assert.deepEqual(diags.map(d => d.code), ["UNHANDLED_FAILURE"]);
});

test("written fails annotations and context contracts resolve imported class identities", () => {
  const files = {
    "types.rx": types,
    "context.rx": 'import { Missing as Absent } from "./types.rx"; export context result: fails(Absent) string',
    "main.rx": 'import { Missing as Lost } from "./types.rx"; import { result } from "./context.rx"; value: fails(Lost) string = throw Lost(1); provide result = value; export default component App() { <p>{use result catch (e: Lost) => "caught"}</p> }',
  };
  assert.deepEqual(checked(files).diags, []);
  const wrong = checked({ ...files, "other.rx": types, "main.rx": 'import { Missing as Lost } from "./other.rx"; import { result } from "./context.rx"; value = throw Lost(1); provide result = value; export default component App() { <p>{use result catch (e: Error) => "caught"}</p> }' }).diags;
  assert.deepEqual(wrong.map(d => d.code), ["ROW_NARROWER_THAN_INFERRED"]);
});
