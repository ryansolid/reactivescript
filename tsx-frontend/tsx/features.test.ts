import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";
import { traces, snapshotSource } from "./test-utils.ts";
import { lowerTsx, TsxError } from "./lower.ts";
import { parseProgram } from "./rx/compiler.ts";
import { parseDeclarations } from "./rx/compiler.ts";
import { buildTsx } from "./build.ts";
import { loadTsxModules } from "./modules.ts";
import { Runtime } from "./rx/runtime.ts";
import type { Decl } from "./rx/ast.ts";
const fixture = (name: string) =>
  readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");

test("native and emitted async handlers expose pre-await writes and return their Promise result", async () => {
  const source =
    'import {createSignal} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);return <button onClick={async ():Promise<number>=>{setN(1);await 0;setN(2);return 3}}>{n()}</button>}';
  const built = buildTsx(
    "main.tsx",
    (path) => (path === "main.tsx" ? source : undefined),
    { target: "universal", mount: "Counter" },
  );
  const out = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(out + "tsx-async-handler-");
  const renderer = fileURLToPath(
    new URL("./test-renderer.ts", import.meta.url),
  );
  try {
    for (const name of ["native.mts", "main.mjs"]) {
      const code =
        name === "native.mts"
          ? transform(source, {
              filename: "Counter.tsx",
              generate: "universal",
              moduleName: STRING_RENDERER,
            }).code
          : built.files.get(name)!;
      writeFileSync(
        dir + "/" + name,
        code.replaceAll(STRING_RENDERER, renderer),
      );
      const mod = await import(pathToFileURL(dir + "/" + name).href);
      const app = createApp();
      const dispose = app.mount(
        name === "native.mts" ? () => mod.Counter() : mod.default(app),
      );
      try {
        flush();
        assert.equal(app.frame(), "0", name);
        const button = (node: any): any =>
          node.tag === "button"
            ? node
            : node.children?.map(button).find(Boolean);
        const done = button(app.root).props.onClick();
        assert.ok(done instanceof Promise, name + " must return a Promise");
        flush();
        assert.equal(
          app.frame(),
          "1",
          name + " writes before await must not be held",
        );
        assert.equal(await done, 3, name + " must preserve its returned value");
        flush();
        assert.equal(app.frame(), "2", name);
      } finally {
        dispose();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("structured optimistic roots roll back across suspended actions without store conversion", async () => {
  const source =
    'import {createSignal,createOptimistic,action,untrack} from "solid-js";import {request} from "./api";export function Counter(){const [cart,setCart]=createOptimistic([1,2]);const captured=untrack(()=>cart());const [status,setStatus]=createSignal("");const [orders,setOrders]=createSignal(0);const run=action(function*(){setCart([]);setStatus("placing");try{yield request()}catch(error){setStatus("failed")}finally{setOrders(p=>p+1)}});return <button onClick={()=>run()}>{cart().length}/{captured.length}/{status()}/{orders()}</button>}';
  const files: Record<string, string> = {
    "main.tsx": source,
    "api.d.rx": "export fn request(): number",
  };
  const built = buildTsx("main.tsx", (path) => files[path], {
    target: "universal",
    mount: "Counter",
  });
  const expected = ["2/2//0", "0/2//0", "2/2/failed/1"];
  const rt = new Runtime(built.set);
  const interpreted = [rt.step([]).at(-1)!.frame];
  interpreted.push(
    rt
      .handler([
        { k: "expr", e: { k: "call", f: { k: "id", name: "run" }, args: [] } },
      ])
      .at(-1)!.frame,
  );
  interpreted.push(
    rt.land('"request:"', new Error("offline"), true).at(-1)!.frame,
  );
  assert.deepEqual(interpreted, expected, "interpreter");
  const out = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(out + "tsx-optimistic-roots-");
  const renderer = fileURLToPath(
    new URL("./test-renderer.ts", import.meta.url),
  );
  try {
    writeFileSync(
      dir + "/api.mjs",
      "export const request = () => globalThis.__tsxOptimisticRequest();",
    );
    for (const name of ["native.mts", "main.mjs"]) {
      let reject!: (error: Error) => void;
      const request = () =>
        new Promise<number>((_, no) => {
          reject = no;
        });
      (globalThis as any).__tsxOptimisticRequest = request;
      const code =
        name === "native.mts"
          ? transform(source, {
              filename: "Counter.tsx",
              generate: "universal",
              moduleName: STRING_RENDERER,
            }).code.replaceAll('"./api"', '"./api.mjs"')
          : built.files.get(name)!;
      writeFileSync(
        dir + "/" + name,
        code.replaceAll(STRING_RENDERER, renderer),
      );
      const mod = await import(pathToFileURL(dir + "/" + name).href);
      const app = createApp({ api: { request } });
      const dispose = app.mount(
        name === "native.mts" ? () => mod.Counter() : mod.default(app),
      );
      try {
        flush();
        const frames = [app.frame()];
        const button = (node: any): any =>
          node.tag === "button"
            ? node
            : node.children?.map(button).find(Boolean);
        const done = button(app.root).props.onClick();
        flush();
        frames.push(app.frame());
        reject(new Error("offline"));
        await done;
        flush();
        frames.push(app.frame());
        assert.deepEqual(frames, expected, name);
      } finally {
        dispose();
      }
    }
  } finally {
    delete (globalThis as any).__tsxOptimisticRequest;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authored RX effects use tuple samples and run returned cleanup before replacement", async () => {
  const source =
    'import {createSignal} from "solid-js";import {createRxEffect} from "reactivescript-tsx";export function Counter(){const [n,setN]=createSignal(0);const [seen,setSeen]=createSignal(0);const [cleanups,setCleanups]=createSignal(0);createRxEffect([()=>n(),()=>n()*2],(first,second)=>{setSeen(first+second);return ()=>{setCleanups(p=>p+1)}});return <button onClick={()=>setN(n()+1)}>{n()}/{seen()}/{cleanups()}</button>}';
  const rx =
    'export component Counter(){source n := 0;source seen := 0;source cleanups := 0;effect(n,n*2){seen := $0+$1;return ()=>{cleanups := p=>p+1}}<button onClick={()=>{n := n+1}}>{""+n}/{""+seen}/{""+cleanups}</button>}';
  await traces(source, rx, ["0/0/0", "1/3/1", "2/6/2"]);
});

test("authored RX effects filter equal computed inputs without changing Solid effects", async () => {
  const source =
    'import {createSignal} from "solid-js";import {createRxEffect} from "reactivescript-tsx";export function Counter(){const [n,setN]=createSignal(0);const [calls,setCalls]=createSignal(0);createRxEffect([()=>n()%2],sample=>{setCalls(p=>p+1)});return <button onClick={()=>setN(n()+2)}>{n()}/{calls()}</button>}';
  const rx =
    'export component Counter(){source n := 0;source calls := 0;effect(n%2){calls := p=>p+1}<button onClick={()=>{n := n+2}}>{""+n}/{""+calls}</button>}';
  await traces(source, rx, ["0/1", "2/1", "4/1"]);
});

test("RX effects retain tuple samples and default scheduling in the shared AST", () => {
  const source =
    'import {createSignal} from "solid-js";import {createRxEffect} from "reactivescript-tsx";export function Counter(){const [n,setN]=createSignal(0);const [seen,setSeen]=createSignal(0);createRxEffect([()=>n()%2,()=>n()*2],(parity,total)=>{setSeen(parity+total);return ()=>{setSeen(0)}});return <button onClick={()=>setN(n()+1)}>{seen()}</button>}';
  const program = lowerTsx(source);
  const counter = program.decls.find((d) => d.k === "component")!;
  assert.equal(counter.k, "component");
  if (counter.k !== "component") return;
  const effect = counter.decls.find((d) => d.k === "effect")!;
  assert.equal(effect.k, "effect");
  if (effect.k !== "effect") return;
  assert.deepEqual(Object.keys(effect).sort(), ["body", "inputs", "k", "line"]);   // RX's one effect form: no extra fields
  assert.equal(effect.inputs.length, 2);
  assert.deepEqual(effect.body[0], {
    k: "write",
    target: { name: "seen", path: [], ctx: false },
    e: {
      k: "bin",
      op: "+",
      l: { k: "id", name: "$0" },
      r: { k: "id", name: "$1" },
    },
  });
  assert.equal(effect.body[1].k, "return");
  assert.throws(
    () => lowerTsx(source.replace("[()=>n()%2,()=>n()*2]", "()=>n()")),
    /literal array/,
  );
  assert.throws(
    () => lowerTsx(source.replace("(parity,total)", "(parity)")),
    /2 parameter/,
  );
  assert.throws(
    () => lowerTsx(source.replace("return ()=>{setSeen(0)}", "return 1")),
    /only a synchronous zero-argument cleanup or undefined/,
  );
});

test("non-self previous preserves lazy fallback tracking and distinguishes null from undefined", async () => {
  const source =
    'import {createSignal,createMemo} from "solid-js";import {createPrevious} from "reactivescript-tsx";export function Counter(){const [n,setN]=createSignal(0);const [seed,setSeed]=createSignal(10);const [step,setStep]=createSignal(0);const double=createMemo(()=>n()*2);const previous=createPrevious(double,()=>seed());return <button onClick={()=>{if(step()===0)setSeed(20);else if(step()===1)setN(1);else if(step()===2)setSeed(30);else setN(2);setStep(step()+1)}}>{previous()}/{double()}</button>}';
  await traces(source, lowerTsx(source), ["10/0", "20/0", "0/2", "0/2", "2/4"]);
  const nullable =
    'import {createSignal,createMemo} from "solid-js";import {createPrevious} from "reactivescript-tsx";export function Counter(){const [n,setN]=createSignal(0);const current=createMemo(()=>n()===1 ? null : n());const previous=createPrevious(current,()=>-1);return <button onClick={()=>setN(n()+1)}>{previous()}/{current()}</button>}';
  await traces(nullable, lowerTsx(nullable), ["-1/0", "0/", "/2", "2/3"]);
});

test("same-setup previous accessors can be passed into later-mounted owners", async () => {
  const source =
    'import {createSignal,createMemo,Show} from "solid-js";import {createPrevious} from "reactivescript-tsx";function Panel(props:{current:number}){return <span>{props.current}</span>}export function Counter(){const [n,setN]=createSignal(0);const double=createMemo(()=>n()*2);const previous=createPrevious(double,()=>-1);return <button onClick={()=>setN(n()+1)}>{n()}/<Show when={n()>=2} fallback={<span>hidden</span>}><Panel current={previous()}/></Show></button>}';
  await traces(source, lowerTsx(source), [
    "0/hidden",
    "1/hidden",
    "2/2",
    "3/4",
  ]);
});

test("array map preserves result shapes and caller tracking in memos and root updaters", async () => {
  const source =
    'import {createSignal,createStore,createMemo} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);const [rows,setRows]=createStore([1,2]);const records=createMemo(()=>rows.map(value=>({id:value,name:"v"+(value+n())})));const labels=createMemo(()=>rows.map(value=>"n"+(value+n())));const numbers=createMemo(()=>rows.map(value=>value+n()));return <button onClick={()=>{setN(n()+1);setRows(previous=>previous.map(value=>value+1))}}>{records()[0]?.name}/{labels()[1]}/{numbers()[0]}</button>}';
  await traces(source, lowerTsx(source), ["v1/n2/1", "v3/n4/3", "v5/n6/5"]);
});

test("map refuses unsupported callback arities and projection-root snapshots", () => {
  const prefix =
    'import {createSignal,createProjection} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);const projected=createProjection(d=>{d.count=n()},{count:0});';
  for (const expression of [
    "[1].map(item=>projected)",
    "[projected].map(root=>root)",
    "[1].map(item=>({root:projected}))",
  ]) {
    assert.throws(
      () =>
        lowerTsx(prefix + "const snapshot=" + expression + ";return <span/>}"),
      /projection-root proxies require live alias/,
    );
  }
  assert.doesNotThrow(() =>
    lowerTsx(
      prefix +
        "const snapshot=[projected].map(root=>root.count);return <span>{snapshot[0]}</span>}",
    ),
  );
  for (const callback of [
    "()=>1",
    "(item,index)=>item+index",
    "async item=>item",
  ]) {
    assert.throws(
      () =>
        lowerTsx(
          prefix + "const snapshot=[1].map(" + callback + ");return <span/>}",
        ),
      /synchronous arrow with 1 parameter/,
    );
  }
});

test("typed store root updaters compose array spreads and tracked predicates", async () => {
  const source =
    'import {createStore} from "solid-js";export function Counter(){const [rows,setRows]=createStore<number[]>([0,1]);return <button onClick={()=>setRows(previous=>previous.length===3 ? previous.filter(value=>value%2===0) : [...previous,previous.length])}>{rows.length}/{rows.every(value=>value%2===0)?"even":"mixed"}</button>}';
  const rx =
    'export component Counter(){source rows := [0,1];<button onClick={()=>{rows := previous=>previous.length==3 ? filter(previous,value=>value%2==0):[...previous,previous.length]}}>{""+rows.length}/{if every(rows,value=>value%2==0) {{""+"even"}}else{{""+"mixed"}}}</button>}';
  await traces(source, rx, ["2/mixed", "3/mixed", "2/even", "3/even"]);
});

test("module sources and memos share component setup lowering", async () => {
  const tsx =
    'import {createSignal,createMemo} from "solid-js";const [n,setN]=createSignal(0);const doubled=createMemo(()=>n()*2);export function Counter(){return <button onClick={()=>setN(n()+1)}>{n()}/{doubled()}</button>}';
  const rx =
    'source n := 0;doubled = n * 2;export component Counter(){<button onClick={()=>{n := n + 1}}>{"" + n}/{"" + doubled}</button>}';
  await traces(tsx, rx, ["0/0", "1/2", "2/4"]);
});

test("typed generator action arguments are passed through forwarding handlers", async () => {
  const tsx =
    'import {createSignal,action} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);const add=action(function*(step:number){setN(p=>p+step)});return <button onClick={()=>add(2)}>{n()}</button>}';
  const rx =
    'export component Counter(){source n := 0;action add(step){n := p => p + step}<button onClick={()=>{add(2)}}>{"" + n}</button>}';
  await traces(tsx, rx, ["0", "2", "4"]);
  assert.throws(
    () => lowerTsx(tsx.replace("add(2)", "add(true)")),
    /argument.*type/,
  );
  assert.throws(
    () => lowerTsx(tsx.replace("()=>add(2)", "add")),
    /forwarding handler/,
  );
});

test("deferred scalar computations use the shared deferred equation", async () => {
  const tsx =
    'import {createSignal,createDeferred} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);const lag=createDeferred(()=>n()*2);return <button onClick={()=>setN(n()+1)}>{n()}/{lag()}</button>}';
  const rx =
    'export component Counter(){source n := 0;deferred lag = n * 2;<button onClick={()=>{n := n + 1}}>{"" + n}/{"" + lag}</button>}';
  await traces(tsx, rx, ["0/0", "1/2", "2/4"]);
});

test("typed children slots forward live markup without stringification", async () => {
  const tsx =
    'import {createSignal,type JSX} from "solid-js";function Frame(props:{children:JSX.Element}){return <div>{props.children}</div>}function Forward(props:{children:JSX.Element}){return <Frame>{props.children}</Frame>}export function Counter(){const [n,setN]=createSignal(0);return <button onClick={()=>setN(n()+1)}><Forward><span>value {n()}</span></Forward></button>}';
  const rx =
    'component Frame(props: { children: JSX.Element }){<div>{props.children}</div>}component Forward(props: { children: JSX.Element }){<Frame>{props.children}</Frame>}export component Counter(){source n := 0;<button onClick={()=>{n := n + 1}}><Forward><span>value {"" + n}</span></Forward></button>}';
  await traces(tsx, rx, ["value 0", "value 1", "value 2"]);
  assert.throws(
    () =>
      lowerTsx(
        tsx.replace(
          "return <div>{props.children}</div>",
          "const saved=props.children;return <div>{saved}</div>",
        ),
      ),
    /snapshots/,
  );
});

for (const local of [false, true])
  test(
    (local ? "local" : "module") +
      " accessor-returning ref helpers instantiate once",
    async () => {
      const helper =
        "function useDouble(input:()=>number):()=>number{const initial=untrack(()=>input());const doubled=createMemo(()=>input()*2+initial);return doubled}";
      const tsx =
        'import {createSignal,createMemo,untrack} from "solid-js";' +
        (local ? "" : helper) +
        "export function Counter(){" +
        (local ? helper : "") +
        "const [n,setN]=createSignal(1);const result=useDouble(n);return <button onClick={()=>setN(n()+1)}>{n()}/{result()}</button>}";
      const helperRx =
        "fn useDouble(ref input: number): number {source initial := peek(input);doubled = input * 2 + initial;doubled}";
      const rx = parseProgram(
        (local ? "" : helperRx) +
          "export component Counter(){source n := 1;result = useDouble(n);" +
          (local ? helperRx : "") +
          '<button onClick={()=>{n := n + 1}}>{"" + n}/{"" + result}</button>}',
      );
      await traces(tsx, rx, ["1/3", "2/5", "3/7"]);
      assert.throws(
        () => lowerTsx(tsx.replace("useDouble(n)", "useDouble(n())")),
        /original accessor/,
      );
    },
  );

test("keyed projections preserve row snapshots through reorder and replacement", async () => {
  const tsx =
    'import {createSignal,createProjection,For,untrack} from "solid-js";function Row(props:{row:{id:number,value:string}}){const captured=untrack(()=>props.row.value);return <span>{props.row.id}:{props.row.value}/{captured};</span>}export function Counter(){const [n,setN]=createSignal(0);const rows=createProjection(()=>n()%2 ? [{id:2,value:"b"},{id:1,value:"a"}] : [{id:1,value:"A"},{id:2,value:"B"}],[],{key:"id"});return <button onClick={()=>setN(n()+1)}><For each={rows}>{row=><Row row={row}/>}</For></button>}';
  const rx = parseProgram(
    'component Row(props: { row: { id: number; value: string } }){captured = props.row.value;<span>{"" + props.row.id}:{"" + props.row.value}/{"" + captured};</span>}export component Counter(){source n := 0;rows key id = n % 2 ? [{id:2,value:"b"},{id:1,value:"a"}] : [{id:1,value:"A"},{id:2,value:"B"}];<button onClick={()=>{n := n + 1}}>{for row in rows {<Row row={row}/>} }</button>}',
  );
  const row = rx.decls[0];
  if (row.k === "component")
    row.decls = row.decls.map((d) =>
      d.k === "eq" ? snapshotSource(d) : d,
    );
  await traces(tsx, rx, ["1:A/A;2:B/B;", "2:b/B;1:a/A;", "1:A/A;2:B/B;"]);
});

test("exported module signals expose reader and setter aliases through shared modules", () => {
  const files: Record<string, string> = {
    "state.tsx":
      'import {createSignal,createMemo} from "solid-js";export const [count,setCount]=createSignal(0);export const doubled=createMemo(()=>count()*2);',
    "main.tsx":
      'import {count as read,setCount as write,doubled as twice} from "./state.tsx";export function Counter(){return <button onClick={()=>write(read()+1)}>{read()}/{twice()}</button>}',
  };
  const result = buildTsx("main.tsx", (path) => files[path], {
    mount: "Counter",
  });
  const rt = new Runtime(result.set);
  const frames = [rt.step([]).at(-1)!.frame];
  const component = rt.view.items[0] as any;
  const button = component.inst.items[0];
  const click = button.attrs
    .find((a: any) => a.name === "onClick")
    .node.compute(rt);
  for (let i = 0; i < 2; i++) {
    click();
    frames.push(rt.handler([]).at(-1)!.frame);
  }
  assert.deepEqual(frames, ["0/0", "1/2", "2/4"]);
});

test("source context children read and update the original source", async () => {
  const tsx =
    'import {createSignal} from "solid-js";import {createSourceContext,useSourceContext} from "reactivescript-tsx";const Count=createSourceContext<number>();function Reader(){const [n,setN]=useSourceContext(Count);return <button onClick={()=>setN(p=>p+1)}>{n()}</button>}export function Counter(){const [n,setN]=createSignal(0);return <Count value={[n,setN]}><Reader/></Count>}';
  const rx = parseProgram(
    'context Count: source number;component Reader(){n = ()=>use Count;<button onClick={()=>{use Count := p => p + 1}}>{"" + n()}</button>}export component Counter(){source n := 0;component Tsx__tsx0(__tsx1){provide Count = n;<Reader/>}<Tsx__tsx0/>}',
  );
  await traces(tsx, rx, ["0", "1", "2"]);
  const unprovided = tsx
    .replace("<Count value={[n,setN]}><Reader/></Count>", "<Reader/>")
    .replace("{n()}</button>", "unused</button>")
    .replace(" onClick={()=>setN(p=>p+1)}", "");
  assert.throws(
    () =>
      buildTsx(
        "main.tsx",
        (path) => (path === "main.tsx" ? unprovided : undefined),
        { mount: "Counter" },
      ),
    /CONTEXT_NOT_FOUND/,
  );
});

test("structured source contexts read value rows and write the original store paths", async () => {
  const source =
    'import {createStore} from "solid-js";import {createSourceContext,useSourceContext} from "reactivescript-tsx";const Rows=createSourceContext<{value:number}[]>();function Reader(){const [rows,setRows]=useSourceContext(Rows);return <button onClick={()=>setRows(d=>{d[0].value=rows[0]?.value+1})}>{rows[0]?.value+0}</button>}export function Counter(){const [rows,setRows]=createStore([{value:0}]);return <Rows value={[rows,setRows]}><Reader/></Rows>}';
  const rx = parseProgram(
    'context Rows: source ({ value: number })[];component Reader(){rows = ()=>use Rows;<button onClick={()=>{use Rows[0].value := rows()[0]?.value+1}}>{""+(rows()[0]?.value+0)}</button>}export component Counter(){source rows := [{value:0}];component Tsx__tsx0(__tsx1){provide Rows = rows;<Reader/>}<Tsx__tsx0/>}',
  );
  await traces(source, rx, ["0", "1", "2"]);
  assert.throws(
    () => lowerTsx(source.replace("rows[0]?.value+0}", "rows()[0]?.value+0}")),
    /Only known zero-argument accessors/,
  );
});

test("read-only accessor contexts preserve live payloads and default accessors", async () => {
  const tsx =
    'import {createSignal,createContext,useContext} from "solid-js";const Count=createContext<()=>number>(()=>0);function Reader(){const read=useContext(Count);return <span>{read()}</span>}export function Counter(){const [n,setN]=createSignal(1);return <button onClick={()=>setN(n()+1)}><Reader/>/<Count value={n}><Reader/></Count></button>}';
  const rx = parseProgram(
    'context Count: number = () => 0;component Reader(){read = peek(use Count);<span>{"" + read()}</span>}export component Counter(){source n := 1;component Tsx__tsx0(__tsx1: { value: number }){__tsx2 = peek(__tsx1.value);provide Count = __tsx2;<Reader/>}<button onClick={()=>{n := n + 1}}><Reader/>/<Tsx__tsx0 value={()=>n}/></button>}',
  );
  const context = rx.decls[0];
  if (context.k === "context") context.type = "() => number";
  // `read` and the provider's seed are equations over peek: an accessor-typed value is a function captured once.
  for (const decl of rx.decls)
    if (decl.k === "component")
      for (const nested of decl.decls)
        if (nested.k === "component")
          nested.propsType = "{ value: () => number }";
  await traces(tsx, rx, ["0/1", "0/2", "0/3"]);
});

test("default-less contexts require a provider and preserve primitive snapshots", async () => {
  const tsx =
    'import {createSignal,createContext,useContext} from "solid-js";const Count=createContext<number>();function Reader(){const current=useContext(Count);return <span>{current}</span>}export function Counter(){const [n,setN]=createSignal(1);return <button onClick={()=>setN(n()+1)}><Count value={n()}><Reader/></Count></button>}';
  const rx = parseProgram(
    'context Count: number;component Reader(){current = use Count;<span>{"" + current}</span>}export component Counter(){source n := 1;component Tsx__tsx0(__tsx1: { value: number }){__tsx2 = __tsx1.value;provide Count = __tsx2;<Reader/>}<button onClick={()=>{n := n + 1}}><Tsx__tsx0 value={n}/></button>}',
  );
  for (const decl of rx.decls)
    if (decl.k === "component") {
      decl.decls = decl.decls.map((d) =>
        d.k === "eq" ? snapshotSource(d) : d,
      );
      for (const nested of decl.decls)
        if (nested.k === "component")
          nested.decls = nested.decls.map((d) =>
            d.k === "eq"
              ? snapshotSource(d)
              : d,
          );
    }
  await traces(tsx, rx, ["1", "1", "1"]);
  const unprovided = tsx.replace(
    "<Count value={n()}><Reader/></Count>",
    "<Reader/>",
  );
  assert.throws(
    () =>
      buildTsx(
        "main.tsx",
        (path) => (path === "main.tsx" ? unprovided : undefined),
        { mount: "Counter" },
      ),
    /CONTEXT_NOT_FOUND/,
  );
});
for (const boundary of [false, true])
  test(
    "built-in Error filters catch declared failures" +
      (boundary ? " at boundaries" : " in expressions"),
    async () => {
      const prefix =
        'import {createSignal,createMemo} from "solid-js";import {defineError,raiseFailure,catchFailure,FailureBoundary} from "reactivescript-tsx";const Missing=defineError("Missing",["id"],(id:number)=>"missing "+id);export function Counter(){const [n,setN]=createSignal(0);';
      const tsx =
        prefix +
        (boundary
          ? 'const result=createMemo(()=>n()%2 ? raiseFailure(Missing(n())) : "ok");return <button onClick={()=>setN(n()+1)}><FailureBoundary classes={[Error]} fallback={err=><span>{err().message+"/"}</span>}>{result()}</FailureBoundary></button>}'
          : 'const result=createMemo(()=>catchFailure(()=>n()%2 ? raiseFailure(Missing(n())) : "ok",[Error],err=>err.message+"/"));return <button onClick={()=>setN(n()+1)}>{result()}</button>}');
      const rx =
        'error Missing(id) => "missing " + id;export component Counter(){source n := 0;result = ' +
        (boundary
          ? 'n % 2 ? throw Missing(n) : "ok";'
          : '(n % 2 ? throw Missing(n) : "ok") catch (err: Error) => err.message + "/";') +
        "<button onClick={()=>{n := n + 1}}>" +
        (boundary
          ? '{errored fallback(err: Error){<span>{"" + (err.message + "/")}</span>}{{"" + result}}}'
          : '{"" + result}') +
        "</button>}";
      await traces(tsx, rx, ["ok", "missing 1/", "ok", "missing 3/"]);
    },
  );

test("imported failure aliases cannot use reserved Error or Panic identities", () => {
  const errors = parseProgram(
    'export error Missing()=>"missing";export error Other()=>"other";',
  );
  for (const name of ["Error", "Panic"])
    for (const boundary of [false, true]) {
      const source =
        "import {Missing as " +
        name +
        ',Other} from "./errors.rx";import {FailureBoundary} from "reactivescript-tsx";export function Counter(){return ' +
        (boundary
          ? "<FailureBoundary classes={[" +
            name +
            "]} fallback={error=><span/>}><span/></FailureBoundary>"
          : "<button onClick={()=>{try{throw Other()}catch(error){if(error instanceof " +
            name +
            ".cls){return}else{throw error}}}}/>") +
        "}";
      assert.throws(
        () =>
          lowerTsx(source, "aliases.tsx", {
            modules: new Map([
              ["./errors.rx", { path: "errors.rx", program: errors }],
            ]),
          }),
        (error: unknown) => {
          assert.ok(error instanceof TsxError);
          assert.match(
            error.message,
            /Imported failure aliases Error and Panic are reserved/,
          );
          assert.equal(error.start, source.indexOf("Missing as "));
          return true;
        },
      );
    }
});

test("array predicate builtin references reject preceding and later lexical collisions", () => {
  for (const method of ["filter", "every", "map"]) {
    const prefix =
      'import {createStore} from "solid-js";export function Counter(){const [rows,setRows]=createStore([1,2]);';
    const call = "const result=rows." + method + "(item=>item>0);";
    for (const body of [
      "const " + method + "=0;" + call,
      call + "const " + method + "=0;",
      call + "function " + method + "(n:number):number{return n}",
    ]) {
      assert.throws(
        () => lowerTsx(prefix + body + "return <span>{rows.length}</span>}"),
        /Array predicate builtin/,
      );
    }
    const ancestor =
      'import {createStore} from "solid-js";function Child(){const [rows,setRows]=createStore([1,2]);' +
      call +
      "return <span>{rows.length}</span>}const " +
      method +
      "=0;export function Counter(){return <Child/>}";
    assert.throws(() => lowerTsx(ancestor), /Array predicate builtin/);
    const imported =
      "import {token as " +
      method +
      '} from "./api";' +
      prefix +
      call +
      "return <span/>}";
    assert.throws(() => lowerTsx(imported), /Array predicate builtin/);
  }
});

test("authored effect-sample names are reserved in apply scopes and cleanup closures", () => {
  const prefix =
    'import {createSignal} from "solid-js";import {createRxEffect} from "reactivescript-tsx";export function Counter(){const [n,setN]=createSignal(1);const [seen,setSeen]=createSignal(0);createRxEffect([()=>n()],value=>{';
  for (const apply of [
    "const $0=99;return ()=>{setSeen($0)}",
    "return ()=>{const $0=99;setSeen(value)}",
  ]) {
    const source = prefix + apply + "});return <span>{seen()}</span>}";
    assert.throws(() => lowerTsx(source), /reserved for RX effect samples/);
  }
  for (const source of [
    "const $1=1;export function Counter(){return <span/>}",
    "export function Counter(){return <button onClick={($12:number)=>{}}/>}",
    'import {createSignal as $3} from "solid-js";export function Counter(){return <span/>}',
    "function $4(n:number):number{return n}export function Counter(){return <span/>}",
  ])
    assert.throws(() => lowerTsx(source), /reserved for RX effect samples/);
});

test("failure filters distinguish the global Error from shadowed or reserved names", () => {
  for (const name of ["Error", "Panic"])
    assert.throws(
      () =>
        lowerTsx(
          'import {defineError} from "reactivescript-tsx";const ' +
            name +
            '=defineError("' +
            name +
            '",[],()=>"failure");export function Counter(){return <span/>}',
        ),
      /reserved RX identities/,
    );
  assert.throws(
    () =>
      lowerTsx(
        'import {createMemo} from "solid-js";import {catchFailure} from "reactivescript-tsx";const Error=0;export function Counter(){const result=createMemo(()=>catchFailure(()=>1,[Error],()=>0));return <span>{result()}</span>}',
      ),
    /declared failure constructors or the built-in Error/,
  );
});

test("parameterized callback contracts reject mismatched arguments and handlers", () => {
  const source =
    "function Child(props:{onChange:(value:number)=>void}){return <button onClick={()=>props.onChange(1)}>go</button>}export function Counter(){return <Child onChange={(next:number)=>{}}/>}";
  assert.doesNotThrow(() => lowerTsx(source));
  assert.throws(
    () => lowerTsx(source.replace("props.onChange(1)", "props.onChange()")),
    /declared parameter count/,
  );
  assert.throws(
    () =>
      lowerTsx(source.replace("props.onChange(1)", 'props.onChange("wrong")')),
    /declared type/,
  );
  assert.throws(
    () => lowerTsx(source.replace("next:number", "next:string")),
    /Handler parameter does not match/,
  );
  assert.throws(
    () => lowerTsx(source.replace("next:number", "next:number,extra:number")),
    /exceed its declared contract/,
  );
  assert.throws(
    () => lowerTsx(source.replace("next:number", "next?:number")),
    /identifier binding/,
  );
});

test("optimistic roots refuse projection proxies and mixed replacement element types", () => {
  const prefix =
    'import {createSignal,createProjection,createOptimistic} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);const projected=createProjection(d=>{d.count=n()},{count:0});';
  assert.throws(
    () =>
      lowerTsx(
        prefix +
          "const [cart,setCart]=createOptimistic([projected]);return <span/>}",
      ),
    /projection proxies/,
  );
  assert.throws(
    () =>
      lowerTsx(
        prefix +
          "const [cart,setCart]=createOptimistic([{count:0}]);return <button onClick={()=>setCart([projected])}/> }",
      ),
    /projection proxies/,
  );
  assert.throws(
    () =>
      lowerTsx(
        prefix +
          'const [cart,setCart]=createOptimistic([1,2]);return <button onClick={()=>setCart(["wrong"])}/> }',
      ),
    /preserve the signal/,
  );
});

test("server cache invalidation refuses ambiguous Solid and ordinary memo getters", () => {
  const prefix =
    'import {createMemo,refresh} from "solid-js";import {serverFunction} from "reactivescript-tsx";const load=serverFunction("load",function*():Generator<unknown,number,number>{return 1});export function Counter(){const result=createMemo(async ():Promise<number>=>await load());return <button onClick={()=>refresh(result)}>{result()}</button>}';
  assert.throws(
    () => lowerTsx(prefix),
    /Solid refresh cannot invalidate a serverFunction factory cache/,
  );
  assert.throws(
    () =>
      lowerTsx(
        prefix
          .replace("createMemo,refresh", "createMemo")
          .replace("{serverFunction}", "{serverFunction,refresh}"),
      ),
    /Server cache refresh requires an original createServerMemo getter/,
  );
  const source = prefix
    .replace("createMemo,refresh", "createMemo")
    .replace("{serverFunction}", "{serverFunction,createServerMemo,refresh}")
    .replace("result=createMemo(", "result=createServerMemo(");
  const program = lowerTsx(source);
  const counter = program.decls.find((d) => d.k === "component")!;
  assert.equal(counter.k, "component");
  if (counter.k === "component")
    assert.equal(counter.decls.find((d) => d.k === "eq")?.e.k, "await");
  const raw = source.replace(
    "async ():Promise<number>=>await load()",
    "()=>load()",
  );
  const rawCounter = lowerTsx(raw).decls.find((d) => d.k === "component")!;
  if (rawCounter.k === "component")
    assert.equal(rawCounter.decls.find((d) => d.k === "eq")?.e.k, "await");
  assert.throws(
    () => lowerTsx(source.replace("Promise<number>", "Promise<string>")),
    /Memo result does not match/,
  );
  assert.throws(
    () => lowerTsx(raw.replace("()=>load()", "()=>load()+1")),
    /a Promise is not a scalar/,
  );
  assert.throws(
    () => lowerTsx(source.replace("await load()", "await (load()+1)")),
    /a Promise is not a scalar/,
  );
  assert.throws(
    () =>
      lowerTsx(
        source
          .replace(
            "return <button",
            "const wrapped=createServerMemo(()=>result());return <button",
          )
          .replace("refresh(result)", "refresh(wrapped)"),
      ),
    /Server cache refresh requires an original createServerMemo getter/,
  );
});

test("source context forwarding refuses an unestablished writable capability", () => {
  const source =
    'import {createSourceContext,useSourceContext} from "reactivescript-tsx";const C=createSourceContext<number>();function Child(){const [read,set]=useSourceContext(C);return <C value={[read,set]}><span>{read()}</span></C>}export function Counter(){return <Child/>}';
  assert.throws(() => lowerTsx(source), /compatible authoritative value/);
});

test("untyped imperative catch fields do not assume thrown JS values are Errors", async () => {
  const source =
    'import {createSignal} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);const [status,setStatus]=createSignal("idle");return <button onClick={()=>{try{throw n()%2?7:null}catch(error){setN(n()+1);setStatus((error===7?"number":"null")+"/"+error?.message)}}}>{n()}/{status()}</button>}';
  const rx =
    'export component Counter(){source n := 0;source status := "idle";<button onClick={()=>{try{throw n%2?7:null}catch(error){n := n+1;status := (error==7?"number":"null")+"/"+error?.message}}}>{""+n}/{""+status}</button>}';
  await traces(source, rx, [
    "0/idle",
    "1/null/undefined",
    "2/number/undefined",
  ]);
});

test("selective imperative catches preserve payloads, unmatched failures, and finalizers", async () => {
  const source =
    'import {createSignal,action} from "solid-js";import {defineError} from "reactivescript-tsx";const Missing=defineError("Missing",["id"],(id:number)=>"missing "+id);const Offline=defineError("Offline",[],()=>"offline");export function Counter(){const [n,setN]=createSignal(0);const [status,setStatus]=createSignal("idle");const [count,setCount]=createSignal(0);const run=action(function*(step:number){setN(step);try{try{if(step%3===1)throw Missing(step);if(step%3===2)throw Offline();setStatus("ok")}catch(error){if(error instanceof Missing.cls){setStatus(error.message+"/"+error.id)}else{throw error}}}catch(outer){setStatus("outer")}finally{setCount(p=>p+1)}});return <button onClick={()=>run(n()+1)}>{n()}/{status()}/{count()}</button>}';
  const rx =
    'error Missing(id)=>"missing "+id;error Offline()=>"offline";export component Counter(){source n := 0;source status := "idle";source count := 0;action run(step){n := step;try{try{if(step%3==1){throw Missing(step)}if(step%3==2){throw Offline()}status := "ok"}catch(error:Missing){status := error.message+"/"+error.id}}catch(outer){status := "outer"}finally{count := p=>p+1}}<button onClick={()=>{run(n+1)}}>{""+n}/{""+status}/{""+count}</button>}';
  await traces(source, rx, [
    "0/idle/0",
    "1/missing 1/1/1",
    "2/outer/2",
    "3/ok/3",
  ]);
  const unmatched = source.replace(
    '}catch(outer){setStatus("outer")}finally',
    "}finally",
  );
  assert.throws(
    () =>
      buildTsx(
        "main.tsx",
        (path) => (path === "main.tsx" ? unmatched : undefined),
        { mount: "Counter" },
      ),
    /UNCAUGHT_ACTION_FAILURE/,
  );
  assert.throws(
    () =>
      lowerTsx(
        source.replace("else{throw error}", 'else{setStatus("swallowed")}'),
      ),
    /instanceof/,
  );
});

for (const broad of [false, true])
  test(
    broad
      ? "raw Error guards are refused rather than widened to RX catch-all"
      : "selective imperative union guards leave primitive throws unmatched",
    async () => {
      const source =
        'import {createSignal,action} from "solid-js";import {defineError} from "reactivescript-tsx";const Missing=defineError("Missing",["id"],(id:number)=>"missing "+id);const Offline=defineError("Offline",[],()=>"offline");export function Counter(){const [n,setN]=createSignal(0);const [status,setStatus]=createSignal("idle");const run=action(function*(step:number){setN(step);try{try{if(step%3===1)throw Missing(step);if(step%3===2)throw Offline();throw 7}catch(error){if(' +
        (broad
          ? "error instanceof Error"
          : "error instanceof Missing.cls || error instanceof Offline.cls") +
        '){setStatus(error.message)}else{throw error}}}catch(outer){setStatus("outer")}});return <button onClick={()=>run(n()+1)}>{n()}/{status()}</button>}';
      const rx = parseProgram(
        'error Missing(id)=>"missing "+id;error Offline()=>"offline";export component Counter(){source n := 0;source status := "idle";action run(step){n := step;try{try{if(step%3==1){throw Missing(step)}if(step%3==2){throw Offline()}throw 7}catch(error:Missing|Offline){status := error.message}}catch(outer){status := "outer"}}<button onClick={()=>{run(n+1)}}>{""+n}/{""+status}</button>}',
      );
      if (broad) {
        assert.throws(() => lowerTsx(source), /instanceof/);
        return;
      }
      await traces(source, rx, [
        "0/idle",
        "1/missing 1",
        "2/offline",
        "3/outer",
      ]);
    },
  );

test("declared failures preserve fields and filtered catch expressions", async () => {
  const tsx =
    'import {createSignal,createMemo} from "solid-js";import {defineError,raiseFailure,catchFailure} from "reactivescript-tsx";const Missing=defineError("Missing",["id"],(id:number)=>"missing "+id);export function Counter(){const [n,setN]=createSignal(0);const result=createMemo(()=>catchFailure(()=>n()%2 ? raiseFailure(Missing(n())) : "ok",[Missing],err=>err.message+"/"+err.id));return <button onClick={()=>setN(n()+1)}>{result()}</button>}';
  const rx =
    'error Missing(id) => "missing " + id;export component Counter(){source n := 0;result = (n % 2 ? throw Missing(n) : "ok") catch (err: Missing) => err.message + "/" + err.id;<button onClick={()=>{n := n + 1}}>{"" + result}</button>}';
  await traces(tsx, rx, ["ok", "missing 1/1", "ok", "missing 3/3"]);
});

for (const recover of [false, true])
  test(
    "failure boundaries update filtered error accessors" +
      (recover ? " and recover" : ""),
    async () => {
      const tsx =
        'import {createSignal,createMemo} from "solid-js";import {defineError,raiseFailure,FailureBoundary} from "reactivescript-tsx";const Missing=defineError("Missing",["id"],(id:number)=>"missing "+id);const Other=defineError("Other",[],()=>"other");export function Counter(){const [n,setN]=createSignal(0);const result=createMemo(()=>n() ? raiseFailure(Missing(n())) : "ok");return <button onClick={()=>setN(n()+1)}><FailureBoundary classes={[Missing]} fallback={err=><span>{err().message}/{err().id}</span>}><FailureBoundary classes={[Other]} fallback={other=><span>wrong</span>}>{result()}</FailureBoundary></FailureBoundary></button>}';
      const rx =
        'error Missing(id) => "missing " + id;error Other() => "other";export component Counter(){source n := 0;result = n ? throw Missing(n) : "ok";<button onClick={()=>{n := n + 1}}>{errored fallback(err: Missing){<span>{"" + err.message}/{"" + err.id}</span>}{errored fallback(other: Other){<span>wrong</span>}{{"" + result}}}}</button>}';
      await traces(
        recover ? tsx.replace("()=>n() ?", "()=>n()%2 ?") : tsx,
        recover ? rx.replace("result = n ?", "result = n % 2 ?") : rx,
        recover
          ? ["ok", "missing 1/1", "ok", "missing 3/3"]
          : ["ok", "missing 1/1", "missing 2/2", "missing 3/3"],
      );
    },
  );

test("JS call result annotations do not replace declaration purity contracts", () => {
  const source =
    'import {createMemo,Errored} from "solid-js";import {fetchValue as load} from "./api";export function Counter(){const result=createMemo(async ():Promise<number>=>await load(0));return <Errored fallback={<p>failed</p>}><p>{result()}</p></Errored>}';
  const declarations = new Map([
    [
      "./api",
      parseDeclarations("export pure fn fetchValue(n: number): number"),
    ],
  ]);
  const p = lowerTsx(source, "Counter.tsx", { declarations });
  const imp = p.decls[0];
  assert.equal(imp.k, "import");
  if (imp.k === "import") {
    assert.equal(imp.pure, false);
    assert.deepEqual(imp.names, [{ name: "fetchValue", alias: "load" }]);
  }
  const inputs: Record<string, string> = {
    "main.tsx": source,
    "api.d.rx": "export pure fn fetchValue(n: number): number",
  };
  assert.ok(
    buildTsx("main.tsx", (path) => inputs[path], {
      target: "universal",
      mount: "Counter",
    }).files.get("main.mjs"),
  );
  assert.throws(
    () =>
      buildTsx(
        "main.tsx",
        (path) => (path === "main.tsx" ? source : undefined),
        { target: "universal", mount: "Counter" },
      ),
    /IMPURE|pure|io/i,
  );
  assert.throws(
    () =>
      lowerTsx(source.replace(":Promise<number>", ""), "Counter.tsx", {
        declarations,
      }),
    /return annotation/,
  );
});

test("bare JS imports remain usable as imperative calls without inventing result shapes", () => {
  const source =
    'import {notify} from "./api";export function Counter(){return <button onClick={()=>notify(1)}>send</button>}';
  const inputs: Record<string, string> = { "main.tsx": source };
  assert.ok(
    buildTsx("main.tsx", (path) => inputs[path], {
      target: "universal",
      mount: "Counter",
    }).files.get("main.mjs"),
  );
});

test("draft reads that require staged sequential values are explicitly rejected", () => {
  const source =
    'import {createStore} from "solid-js";export function Counter(){const [s,setS]=createStore({n:0});return <button onClick={()=>setS(d=>{d.n+=1;d.n+=1})}>{s.n}</button>}';
  assert.throws(() => lowerTsx(source), /sequential draft semantics/);
  assert.throws(
    () => lowerTsx(source.replace("d.n+=1;d.n+=1", "d.n+=1;d.n=s.n+1")),
    /sequential draft semantics/,
  );
});

test("heterogeneous structured arrays cannot silently borrow the first item shape", () => {
  assert.throws(
    () =>
      lowerTsx(
        "export function Counter(){const rows=[{a:1},{b:2}];return <p>{rows}</p>}",
      ),
    /structured value kinds/,
  );
});

test("typed memo previous values use pre and recompute in the caller's reactive instant", async () => {
  const tsx =
    'import {createSignal,createMemo} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);const total=createMemo((previous:number|undefined)=>(previous??0)+n());return <button onClick={()=>setN(n()+1)}>{n()}/{total()}</button>}';
  const rx =
    'export component Counter(){source n := 0;total = (pre total ?? 0) + n;<button onClick={()=>{n := n + 1}}>{"" + n}/{"" + total}</button>}';
  await traces(tsx, rx, ["0/0", "1/1", "2/3", "3/6", "4/10"]);
});

test("derived scalar signals retain manual overrides until their input changes", async () => {
  const tsx =
    'import {createSignal} from "solid-js";export function Counter(){const [base,setBase]=createSignal(1);const [step,setStep]=createSignal(0);const [draft,setDraft]=createSignal(()=>base()*10);return <button onClick={()=>{setStep(step()+1);if(step()%2===0){setDraft(99)}else{setBase(base()+1)}}}>{base()}/{draft()}</button>}';
  const rx =
    'export component Counter(){source base := 1;source step := 0;source draft = base * 10;<button onClick={()=>{step := step + 1;if (step % 2 == 0) {draft := 99} else {base := base + 1}}}>{"" + base}/{"" + draft}</button>}';
  await traces(tsx, rx, ["1/10", "1/99", "2/20", "2/99", "3/30"]);
});

test("store root aliases remain live while captured nested objects survive path replacement", async () => {
  const tsx =
    'import {createStore,untrack} from "solid-js";export function Counter(){const [s,setS]=createStore({row:{n:0}});const alias=s;const row=untrack(()=>s.row);return <button onClick={()=>setS(d=>{d.row={n:s.row.n+1}})}>{alias.row.n}/{row.n}</button>}';
  const rx = parseProgram(
    // Naming a store reads nothing, so `alias` is the store itself; `row` is a mount snapshot of the nested object.
    'export component Counter(){source s := {row:{n:0}};source row := peek(s.row);<button onClick={()=>{s.row := {n:s.row.n+1}}}>{"" + s.row.n}/{"" + row.n}</button>}',
  );
  await traces(tsx, rx, ["0/0", "1/0", "2/0"]);
});

test("projection aliases and nested captures preserve native replacement identity", async () => {
  const tsx =
    'import {createSignal,createProjection,untrack} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);const projected=createProjection(draft=>{draft.row={n:n()}},{row:{n:0}});const alias=projected;const row=untrack(()=>projected.row);return <button onClick={()=>setN(n()+1)}>{alias.row.n}/{row.n}</button>}';
  const rx = parseProgram(
    'export component Counter(){source n := 0;__tsx0 = {row:{n:0}};projected = draft(pre projected -> __tsx0){d.row := {n:n}};row = projected.row;<button onClick={()=>{n := n + 1}}>{"" + projected.row.n}/{"" + row.n}</button>}',
  );
  const component = rx.decls[0];
  if (component.k === "component")
    component.decls = component.decls.map((d) =>
      d.k === "eq" && d.name !== "projected"
        ? snapshotSource(d)
        : d,
    );
  await traces(tsx, rx, ["0/0", "1/0", "2/0"]);
});

test("structured projection-root snapshots require live alias support", () => {
  const tsx =
    'import {createSignal,createProjection} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);const projected=createProjection(draft=>{draft.row={n:n()}},{row:{n:0}});const box={root:projected};return <button onClick={()=>setN(n()+1)}>{box.root.row.n}</button>}';
  // Native/compiled frames were [0,1,2], while a raw interpreter const stayed [0,0,0].
  for (const expression of [
    "{root:projected}",
    "[projected]",
    "n() ? projected : projected",
  ])
    assert.throws(
      () => lowerTsx(tsx.replace("{root:projected}", expression)),
      /projection-root proxies require live alias/,
    );
});

for (const wrapped of [false, true])
  test(
    "generator action handlers" +
      (wrapped ? " through a forwarding arrow" : " attached directly"),
    async () => {
      const tsx =
        'import {createSignal,action} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);const increment=action(function*(){setN(n()+1)});return <button onClick={' +
        (wrapped ? "()=>increment()" : "increment") +
        "}>{n()}</button>}";
      const rx =
        "export component Counter(){source n := 0;action increment(){n := n + 1}<button onClick={" +
        (wrapped ? "()=>{increment()}" : "increment") +
        '}>{"" + n}</button>}';
      await traces(tsx, rx, ["0", "1", "2", "3"]);
    },
  );

test("actions reject async arrows, delegated yields and untyped JS results", () => {
  const source =
    'import {createSignal,action} from "solid-js";import {request} from "./api";export function Counter(){const [n,setN]=createSignal(0);const run=action(function*(){const next:number=yield request();setN(next)});return <button onClick={run}>{n()}</button>}';
  const p = lowerTsx(source);
  const component = p.decls.find((d) => d.k === "component");
  assert.ok(
    component?.k === "component" &&
      component.decls.some(
        (d) =>
          d.k === "action" &&
          d.body[0].k === "let" &&
          d.body[0].e.k === "await",
      ),
  );
  assert.throws(
    () =>
      lowerTsx(
        source
          .replace("function*()", "async ()=>")
          .replace("yield request()", "await request()"),
      ),
    /synchronous generator/,
  );
  assert.throws(
    () => lowerTsx(source.replace("yield request()", "yield* request()")),
    /non-delegating yields/,
  );
  assert.throws(
    () => lowerTsx(source.replace("next:number", "next")),
    /return annotation/,
  );
});

for (const rejected of [false, true])
  test(
    "interpreter optimistic action " + (rejected ? "rollback" : "truth commit"),
    () => {
      const source =
        'import {createSignal,createOptimistic,action} from "solid-js";import {request} from "./api";export function Counter(){const [truth,setTruth]=createSignal(0);const [count,setCount]=createOptimistic(()=>truth());const [status,setStatus]=createSignal("");const save=action(function*(){setCount(1);setStatus("placing");try{const receipt:number=yield request();setTruth(receipt);setStatus("ok")}catch(error){setStatus("failed")}});return <button onClick={()=>save()}>{count()}/{status()}</button>}';
      const set = loadTsxModules("main.tsx", (path) =>
        path === "main.tsx" ? source : undefined,
      );
      set.programs.get(set.entry)!.view = [
        { k: "el", tag: "Counter", attrs: [], children: [] },
      ];
      const rt = new Runtime(set);
      const frames = [rt.step([]).at(-1)!.frame];
      frames.push(
        rt
          .handler([
            {
              k: "expr",
              e: { k: "call", f: { k: "id", name: "save" }, args: [] },
            },
          ])
          .at(-1)!.frame,
      );
      frames.push(
        rt
          .land('"request:"', rejected ? new Error("offline") : 42, rejected)
          .at(-1)!.frame,
      );
      assert.deepEqual(frames, ["0/", "1/", rejected ? "0/failed" : "42/ok"]);
    },
  );

test("primitive context providers snapshot once in owned regions and do not leak to siblings", async () => {
  const tsx =
    'import {createSignal,createContext,useContext} from "solid-js";const C=createContext(7);export function Counter(){const [n,setN]=createSignal(0);return <button onClick={()=>setN(n()+1)}>{n()}/<C value={n()}><Child/></C>/<C value={100}><Child/></C>/<Child/></button>}function Child(){const current=useContext(C);return <i>{current}</i>}';
  const rx = parseProgram(
    'context C:number = 7;export component Counter(){source n := 0;component Tsx__tsx0(__tsx1:{ value: number }){__tsx2 = __tsx1.value;provide C = __tsx2;<Child/>}component Tsx__tsx3(__tsx4:{ value: number }){__tsx5 = __tsx4.value;provide C = __tsx5;<Child/>}<button onClick={()=>{n := n + 1}}>{"" + n}/<Tsx__tsx0 value={n}/>/<Tsx__tsx3 value={100}/>/<Child/></button>}component Child(){current = use C;<i>{"" + current}</i>}',
  );
  const snapshots = (decls: Decl[]): Decl[] =>
    decls.map((d) =>
      d.k === "component"
        ? { ...d, decls: snapshots(d.decls) }
        : d.k === "eq"
          ? snapshotSource(d)
          : d,
    );
  rx.decls = snapshots(rx.decls);
  await traces(tsx, rx, ["0/0/100/7", "1/0/100/7", "2/0/100/7"]);
});

test("primitive context providers capture the new mount value after Show remounts", async () => {
  const tsx =
    'import {createSignal,createContext,useContext,Show} from "solid-js";const C=createContext(7);export function Counter(){const [n,setN]=createSignal(0);return <button onClick={()=>setN(n()+1)}>{n()}<Show when={n()%3!==0} fallback={<i>off</i>}><C value={n()}><Child/></C></Show>/<Child/></button>}function Child(){const current=useContext(C);return <i>{current}</i>}';
  const rx = parseProgram(
    'context C:number = 7;export component Counter(){source n := 0;component Tsx__tsx0(__tsx1:{ value: number }){__tsx2 = __tsx1.value;provide C = __tsx2;<Child/>}<button onClick={()=>{n := n + 1}}>{"" + n}{if n % 3 != 0 {<Tsx__tsx0 value={n}/>} else {<i>off</i>}}/<Child/></button>}component Child(){current = use C;<i>{"" + current}</i>}',
  );
  const snapshots = (decls: Decl[]): Decl[] =>
    decls.map((d) =>
      d.k === "component"
        ? { ...d, decls: snapshots(d.decls) }
        : d.k === "eq"
          ? snapshotSource(d)
          : d,
    );
  rx.decls = snapshots(rx.decls);
  await traces(tsx, rx, ["0off/7", "11/7", "21/7", "3off/7", "44/7"]);
});

test("context forms outside the tested primitive ownership subset fail explicitly", () => {
  const source =
    'import {createContext,useContext} from "solid-js";const C=createContext(7);export function Counter(){const current=useContext(C);return <p>{current}</p>}';
  assert.throws(
    () => lowerTsx(source.replace("createContext(7)", "createContext()")),
    /explicit primitive type without a default/,
  );
  assert.throws(
    () =>
      lowerTsx(source.replace("createContext(7)", "createContext({value:7})")),
    /primitive literal/,
  );
  assert.throws(
    () => lowerTsx(source.replace("createContext(7)", "createContext(1+2)")),
    /primitive literal/,
  );
  assert.throws(
    () => lowerTsx(source + "function read():number{return useContext(C)}"),
    /dynamic caller ownership/,
  );
});

test("non-keyed Show callback receives a live accessor, not a snapshotted value", async () => {
  const tsx =
    'import {createSignal,Show} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);return <button onClick={()=>setN(n()+1)}>{n()}<Show when={n()%3} fallback={<i>off</i>}>{shown=><i>{shown()}</i>}</Show></button>}';
  const rx =
    'export component Counter(){source n := 0;<button onClick={()=>{n := n + 1}}>{"" + n}{if n % 3 {shown = n % 3; <i>{"" + shown}</i>} else {<i>off</i>}}</button>}';
  await traces(tsx, rx, ["0off", "11", "22", "3off", "41", "52"]);
});

for (const marked of [false, true])
  test(
    "fire-and-forget memo refresh" + (marked ? " with ambient affects" : ""),
    async () => {
      const tsx =
        'import {createMemo,refresh,affects,isPending} from "solid-js";export function Counter(){const total=createMemo((previous:number|undefined)=>(previous??0)+1);return <button onClick={()=>{' +
        (marked ? "affects(total);" : "") +
        'refresh(total)}}>{total()}/{isPending(()=>total())?"pending":"idle"}</button>}';
      const rx =
        "export component Counter(){total = (pre total ?? 0) + 1;<button onClick={()=>{" +
        (marked ? "affects total;" : "") +
        'refresh total}}>{"" + total}/{if pending? total {{"" + "pending"}} else {{"" + "idle"}}}</button>}';
      await traces(tsx, rx, ["1/idle", "2/idle", "3/idle", "4/idle"]);
    },
  );

test("synchronous projection drafts start from an eager seed and retain their previous draft", async () => {
  const tsx =
    'import {createSignal,createProjection} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);const projection=createProjection(draft=>{draft.count=n();draft.sum+=draft.count;},{count:0,sum:0});return <button onClick={()=>setN(n()+1)}>{projection.count}/{projection.sum}</button>}';
  const rx = parseProgram(
    'export component Counter(){source n := 0;__tsx0 = {count:0,sum:0};projection = draft(pre projection -> __tsx0){d.count := n;d.sum := d.sum + d.count};<button onClick={()=>{n := n + 1}}>{"" + projection.count}/{"" + projection.sum}</button>}',
  );
  const component = rx.decls[0];
  if (component.k === "component")
    component.decls = component.decls.map((d) =>
      d.k === "eq" && d.name === "__tsx0"
        ? snapshotSource(d)
        : d,
    );
  await traces(tsx, rx, ["0/0", "1/1", "2/3", "3/6", "4/10"]);
});

test("eager module/component snapshots, pure typed helpers, strings, booleans, null, and untrack", async () => {
  // TSX setup consts are RX snapshot sources: the fixture spells `initial` as `source initial := peek count`, and the typed
  // module constant `factor` is written as an equation and converted.
  const rx = parseProgram(fixture("values.rx"));
  rx.decls = rx.decls.map((d) =>
    d.k === "eq" && d.name === "factor"
      ? snapshotSource(d)
      : d,
  );
  await traces(fixture("values.tsx"), rx, [
    "0/n=0/0/few//",
    "0/n=2/0/few//",
    "0/n=4/0/many//",
    "0/n=6/0/many//",
  ]);
});

test("Solid 2 store drafts, path writes, Show and default value-item For", async () => {
  await traces(fixture("store.tsx"), fixture("store.rx"), [
    "0/2empty",
    "1/3XB",
    "2/4XB",
    "3/5XB",
  ]);
});

test("split compute/apply createRxEffect lowers to RX's one effect form", async () => {
  await traces(fixture("effect.tsx"), parseProgram(fixture("effect.rx")), ["0/0", "1/10", "2/20", "3/30"]);
});

test("plain Solid createEffect is refused instead of being given RX EF-2 semantics", () => {
  const tsx =
    'import {createSignal,createEffect} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);const [seen,setSeen]=createSignal(0);createEffect(()=>n()%2,value=>{setSeen(p=>p+1)});return <button onClick={()=>setN(n()+2)}>{n()}/{seen()}</button>}';
  assert.throws(
    () => lowerTsx(tsx),
    (e: unknown) =>
      e instanceof TsxError &&
      /createEffect is not lowered: ReactiveScript has one effect form with per-input value comparison \(EF-2\)\. Use createRxEffect from reactivescript-ref\/tsx/.test(e.message),
  );
});

test("structured signal identity is not silently changed to store semantics", () => {
  assert.throws(
    () =>
      lowerTsx(
        'import {createSignal} from "solid-js"; export function Counter(){const [state,setState]=createSignal({n:0});return <p>{state().n}</p>}',
      ),
    (e: unknown) => e instanceof TsxError && /identity/.test(e.message),
  );
});

test("Show preserves snapshots for truthy changes and resets them after hiding", async () => {
  const tsx =
    'import {createSignal,Show,untrack} from "solid-js"; export function Counter(){const [n,setN]=createSignal(0);return <button onClick={()=>setN(n()+1)}>{n()}<Show when={n()%3!==0} fallback={<i>off</i>}><Child value={n()}/></Show></button>} function Child(props:{value:number}){const initial=untrack(()=>props.value);return <i>{initial}/{props.value}</i>}';
  const rx = parseProgram(
    'export component Counter(){source n := 0; <button onClick={()=>{n := n + 1}}>{"" + n}{if n % 3 != 0 {<Child value={n}/>} else {<i>off</i>}}</button>} component Child(props:{value:number}){initial = props.value; <i>{"" + initial}/{"" + props.value}</i>}',
  );
  const child = rx.decls.find(
    (d) => d.k === "component" && d.name === "Child",
  )!;
  if (child.k === "component") {
    child.propsType = "{ value: number }";
    child.decls = child.decls.map((d) =>
      d.k === "eq" ? snapshotSource(d) : d,
    );
  }
  await traces(tsx, rx, [
    "0off",
    "11/1",
    "21/2",
    "3off",
    "44/4",
    "54/5",
    "6off",
  ]);
});

test("default For passes values and preserves row snapshots when identities reorder", async () => {
  const tsx =
    'import {createStore,For,untrack} from "solid-js"; export function Counter(){const [s,setS]=createStore({n:0,rows:[10,20]});return <button onClick={()=>setS(d=>{d.rows=s.n%2===0?[20,10]:[10,20];d.n+=1})}>{s.n}:<For each={s.rows}>{row=><Child value={row+s.n}/>}</For></button>} function Child(props:{value:number}){const initial=untrack(()=>props.value);return <i>{initial}/{props.value};</i>}';
  const rx = parseProgram(
    'export component Counter(){source s := {n:0,rows:[10,20]}; <button onClick={()=>{s.rows := s.n % 2 == 0 ? [20,10] : [10,20]; s.n := s.n + 1}}>{"" + s.n}:{for row in s.rows {<Child value={row+s.n}/>}}</button>} component Child(props:{value:number}){initial = props.value; <i>{"" + initial}/{"" + props.value};</i>}',
  );
  const child = rx.decls.find(
    (d) => d.k === "component" && d.name === "Child",
  )!;
  if (child.k === "component") {
    child.propsType = "{ value: number }";
    child.decls = child.decls.map((d) =>
      d.k === "eq" ? snapshotSource(d) : d,
    );
  }
  await traces(tsx, rx, [
    "0:10/10;20/20;",
    "1:20/21;10/11;",
    "2:10/12;20/22;",
    "3:20/23;10/13;",
  ]);
});

test("JSX entities decode strictly without decoding JS string expressions", async () => {
  const tsx =
    'import {createSignal} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);return <button title="A &amp; &#65; &unknown;" onClick={()=>setN(n()+1)}>A &amp; &#65; &#x42; &copy; &unknown; & bare; x&#10;y{"&amp;"}:{n()}</button>}';
  const rx = parseProgram(
    'export component Counter(){source n := 0;<button title={"A & A &unknown;"} onClick={()=>{n := n + 1}}>PLACEHOLDER{"" + "&amp;"}:{"" + n}</button>}',
  );
  const prefix = "A & A B \u00a9 &unknown; & bare; x\ny";
  const counter = rx.decls[0];
  if (
    counter.k === "component" &&
    counter.view[0].k === "el" &&
    counter.view[0].children[0].k === "text"
  )
    counter.view[0].children[0].s = prefix;
  await traces(tsx, rx, [prefix + "&amp;:0", prefix + "&amp;:1"]);
});

for (const [name, authored, expected] of [
  [
    "legacy entities",
    "A &copy &#65 &#x42 &amp &unknown; ",
    "A \u00a9 A B & &unknown; ",
  ],
  ["CRLF tabs and blank lines", "  A   \r\n\t B   \n \n\tC  ", " A B C "],
  ["bare carriage returns", "A\rB", "AB"],
  ["Unicode line separators", "A\u2028 \u2029\tB", "A B"],
  [
    "Unicode whitespace",
    "\u0085A\u00a0\u1680\u2003B\u202f\u205f\u3000",
    " A B ",
  ],
  ["empty continuation lines", " \t\n\t\n ", ""],
  ["BOM is not Rust whitespace", "\ufeffA \ufeff", "\ufeffA \ufeff"],
])
  test("native JSX text normalization: " + name, async () => {
    const tsx =
      'import {createSignal} from "solid-js";export function Counter(){const [n,setN]=createSignal(0);return <button title="&copy &#65 &#x42 &amp &unknown;" onClick={()=>setN(n()+1)}>' +
      authored +
      "{n()}</button>}";
    const rx = parseProgram(
      'export component Counter(){source n := 0;<button title={"\u00a9 A B & &unknown;"} onClick={()=>{n := n + 1}}>PLACEHOLDER{"" + n}</button>}',
    );
    const component = rx.decls[0];
    if (component.k === "component" && component.view[0].k === "el") {
      const children = component.view[0].children;
      if (children[0].k === "text") children[0].s = expected;
      if (!expected) children.shift();
    }
    await traces(tsx, rx, [expected + "0", expected + "1"], {
      title: "\u00a9 A B & &unknown;",
    });
  });
