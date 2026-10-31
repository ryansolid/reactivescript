import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTsx } from "./build.ts";
import { CheckError } from "./rx/compiler.ts";

const build = (files: Record<string, string>) => buildTsx("main.tsx", path => files[path], { mount: "Counter" });
const rejects = (code: string) => (error: unknown) => error instanceof CheckError && error.diagnostics.some(d => d.code === code);

const failures = {
  "types.tsx": 'import { defineError } from "reactivescript-tsx"; export const Missing = defineError("Missing", ["id"], (id: number) => "missing " + id); export const Offline = defineError("Offline", [], () => "offline");',
  "reader.rx": 'import { Missing } from "./types.tsx"; export component Reader() { value = throw Missing(1); <p>{value}</p> }',
  "main.tsx": 'import { FailureBoundary } from "reactivescript-tsx"; import { Missing as Lost } from "./types.tsx"; import { Reader } from "./reader.rx"; export function Counter() { return <FailureBoundary classes={[Lost]} fallback={error => <p>missing</p>}><Reader/></FailureBoundary>; }',
};

test("typed failure identities cross TSX exports, RX imports, and TSX boundary aliases", () => {
  const result = build(failures);
  assert.ok(result.set.programs.get("types.tsx")!.decls.some(d => d.k === "error" && d.name === "Missing" && d.exported));
  assert.ok(result.files.has(result.entry));
});

test("a typed TSX boundary does not discharge a different imported error class", () => {
  assert.throws(() => build({ ...failures, "main.tsx": failures["main.tsx"].replace("Missing as Lost", "Offline as Lost") }), rejects("UNHANDLED_FAILURE"));
});

test("a caller boundary cannot discharge failures read later by a child action", () => {
  const files = {
    "child.tsx": 'import {action} from "solid-js"; export function Child(props:{value:number}) { const go=action(function*(){const snapshot=props.value;}); return <button onClick={()=>go()}>go</button>; }',
    "main.tsx": 'import {createMemo,Errored} from "solid-js"; import {defineError,raiseFailure} from "reactivescript-tsx"; import {Child} from "./child.tsx"; const Broken=defineError("Broken",[],()=>"broken"); export function Counter(){const value=createMemo(()=>true?raiseFailure(Broken()):0);return <Errored fallback={<p>failed</p>}><Child value={value()}/></Errored>;}',
  };
  assert.throws(() => build(files), rejects("UNCAUGHT_ACTION_FAILURE"));
  assert.ok(build({ ...files, "child.tsx": files["child.tsx"].replace("const snapshot=props.value;", "try {const snapshot=props.value;} catch {}") }));
});

test("content-model signatures cross both module frontends before emission", () => {
  for (const entry of ["tsx", "rx"]) for (const dependency of ["tsx", "rx"]) {
    const source = entry === "tsx"
      ? 'import {Row} from "./row.EXT"; export function Counter(){return <table><Row/></table>;}'
      : 'import {Row} from "./row.EXT"; export component Counter(){<table><Row/></table>}';
    const files = {
      ["main." + entry]: source.replace("EXT", dependency),
      ["row." + dependency]: dependency === "tsx"
        ? 'export function Row(){return <tr><td>cell</td></tr>;}'
        : 'export component Row(){<tr><td>cell</td></tr>}',
    };
    const emit = (inputs: Record<string, string>) => buildTsx("main." + entry, path => inputs[path], { mount: "Counter" });
    assert.throws(() => emit(files), rejects("CONTENT_MODEL"));
    assert.ok(emit({ ...files, ["main." + entry]: files["main." + entry].replace("<Row/>", "<tbody><Row/></tbody>") }));
  }
});

const contexts = {
  "context.tsx": 'import { createSourceContext } from "reactivescript-tsx"; export const Count = createSourceContext<number>();',
  "reader.tsx": 'import { useSourceContext } from "reactivescript-tsx"; import { Count as Current } from "./context.tsx"; export function Reader() { const [count,setCount] = useSourceContext(Current); return <button onClick={() => setCount(count()+1)}>{count()}</button>; }',
  "main.tsx": 'import { createSignal } from "solid-js"; import { Count as Current } from "./context.tsx"; import { Reader } from "./reader.tsx"; export function Counter() { const [count,setCount] = createSignal(0); return <Current value={[count,setCount]}><Reader/></Current>; }',
};

test("source-context aliases retain their writable provision contract across modules", () => {
  const result = build(contexts);
  assert.ok(result.set.programs.get("context.tsx")!.decls.some(d => d.k === "context" && d.source && !d.dflt));
});

test("required source contexts are checked where the imported component is rendered", () => {
  assert.throws(() => build({ ...contexts, "main.tsx": 'import { Reader } from "./reader.tsx"; export function Counter() { return <Reader/>; }' }), rejects("CONTEXT_NOT_FOUND"));
});

test("a source-context provider cannot combine a reader with a different source's writer", () => {
  assert.throws(() => build({ ...contexts, "main.tsx": contexts["main.tsx"].replace('const [count,setCount] = createSignal(0);', 'const [count,setCount] = createSignal(0); const [other,setOther] = createSignal(0);').replace('value={[count,setCount]}', 'value={[count,setOther]}') }), /same source|matching source|same signal/);
});

const server = {
  "loaders.tsx": 'import { serverFunction } from "reactivescript-tsx"; import { lookup } from "./api"; export const load = serverFunction("load", function* (id: number): Generator<unknown, number, number> { const value: number = yield lookup(id); return value + 1; });',
  "api.d.rx": 'export server pure fn lookup(id: number): number',
  "main.tsx": 'import { createMemo, Loading, Errored } from "solid-js"; import { load as read } from "./loaders.tsx"; export function Counter() { const value = createMemo(async (): Promise<number> => await read(1)); return <Errored fallback={error => <p>failed</p>}><Loading fallback={<p>waiting</p>}><p>{value()}</p></Loading></Errored>; }',
};

test("TSX server loaders retain side contracts and imported aliases in the shared compiler", () => {
  const result = build(server);
  // Upstream SF-1 has one server declaration (no fn/action kind); whether it is io is inferred from its body.
  assert.ok(result.set.programs.get("loaders.tsx")!.decls.some(d => d.k === "server" && d.exported && !("kind" in d)));
});

test("an IO declaration does not become pure inside a TSX server loader", () => {
  // Pinned upstream SF-1: a server fn is io when its body calls io, and an io call in reactive scope is refused
  // (IO-2 IO_IN_REACTIVE); the old pin refused the loader body itself (SERVER_FN_IO). Either way it is not pure.
  assert.throws(() => build({ ...server, "api.d.rx": 'export server fn lookup(id: number): number' }), rejects("IO_IN_REACTIVE"));
});

test("server generators cannot capture component state", () => {
  assert.throws(() => build({ "main.tsx": 'import { createSignal } from "solid-js"; import { serverFunction } from "reactivescript-tsx"; export function Counter() { const [count,setCount] = createSignal(0); const load = serverFunction("load", function* (): Generator<unknown, number, unknown> { return count(); }); return <p>blocked</p>; }' }), rejects("SERVER_CAPTURE"));
});
