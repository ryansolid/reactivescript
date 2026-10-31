import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";
import { Runtime } from "./rx/runtime.ts";
import { check } from "./rx/compiler.ts";
import { parseProgram } from "./rx/compiler.ts";
import { buildTsx } from "./build.ts";

const fixtures = [
  {
    name: "S-region-7 structured context registration and cleanup",
    // Native R.render flushes mount effects; the interpreter also exposes the first instant.
    mount: "0 valid",
    frames: ["2 invalid", "a2 invalid", "ae2 valid", "a1 valid", "ae2 valid", "e2 invalid", "1 invalid", "1 invalid", "hidden2 invalid"],
    source: `import {createSignal,createStore,createMemo,Show,type Element} from "solid-js";
import {createSourceContext,useSourceContext,createRxEffect} from "reactivescript-tsx";
const Fields=createSourceContext<{ok:boolean}[]>();
function Form(props:{children:Element}) {
  const initial:{ok:boolean}[]=[];
  const [rows,setRows]=createStore(initial);
  return <Fields value={[rows,setRows]}>{props.children}<p>{rows.length} {rows.every(row=>row.ok)?"valid":"invalid"}</p></Fields>;
}
function Field(props:{value:string}) {
  const [rows,setRows]=useSourceContext(Fields);
  // Store rows keep their identity through the parent array's proxies.
  const [row,setRow]=createStore({ok:false});
  const valid=createMemo(()=>props.value!=="");
  createRxEffect([()=>valid()],ok=>{
    setRow(previous=>{previous.ok=ok;});
    setRows(previous=>[...previous,row]);
    return ()=>{setRows(previous=>previous.filter(entry=>entry!==row));};
  });
  return <i>{props.value}</i>;
}
export function Counter() {
  const [name,setName]=createSignal("");
  const [email,setEmail]=createSignal("");
  const [shown,setShown]=createSignal(true);
  const [step,setStep]=createSignal(0);
  return <Form><button onClick={()=>{
    if(step()===0) setName("a");
    else if(step()===1) setEmail("e");
    else if(step()===2) setShown(false);
    else if(step()===3) setShown(true);
    else if(step()===4) setName("");
    else if(step()===5) setShown(false);
    else if(step()===6) setEmail("hidden");
    else setShown(true);
    setStep(previous=>previous+1);
  }}><Field value={name()}/><Show when={shown()}><Field value={email()}/></Show></button></Form>;
}`,
  },
  {
    name: "Show helper retains live refs, disposes effects, and captures a fresh remount seed",
    frames: ["1/4/1/1/0", "2/6/2/1/1", "2/-/2/0/2", "3/-/2/0/2", "3/10/3/1/2", "4/12/4/1/3", "4/-/4/0/4", "5/-/4/0/4", "5/16/5/1/4"],
    source: `import {createSignal,createMemo,Show,untrack} from "solid-js";
import {createRxEffect} from "reactivescript-tsx";
const [runs,setRuns]=createSignal(0);
const [active,setActive]=createSignal(0);
const [cleanups,setCleanups]=createSignal(0);
function useCounter(base:()=>number,seed:number):()=>number {
  const captured=untrack(()=>base());
  const [local,setLocal]=createSignal(seed);
  const current=createMemo(()=>base());
  createRxEffect([()=>current()],sample=>{
    setLocal(previous=>previous+1);
    setRuns(previous=>previous+1);
    setActive(previous=>previous+1);
    return ()=>{setActive(previous=>previous-1);setCleanups(previous=>previous+1);};
  });
  const value=createMemo(()=>current()+local()+captured);
  return value;
}
function Child(props:{n:number}) {
  const base=createMemo(()=>props.n);
  const value=useCounter(base,props.n);
  return <i>{value()}</i>;
}
export function Counter() {
  const [n,setN]=createSignal(1);
  const [shown,setShown]=createSignal(true);
  const [step,setStep]=createSignal(0);
  return <button onClick={()=>{
    if(step()===0) setN(2);
    else if(step()===1) setShown(false);
    else if(step()===2) setN(3);
    else if(step()===3) setShown(true);
    else if(step()===4) setN(4);
    else if(step()===5) setShown(false);
    else if(step()===6) setN(5);
    else setShown(true);
    setStep(previous=>previous+1);
  }}>{n()}/<Show when={shown()} fallback="-"><Child n={n()}/></Show>/{runs()}/{active()}/{cleanups()}</button>;
}`,
  },
  {
    name: "keyed row helpers survive reorder, dispose on removal, and remount after readdition",
    frames: ["1:31;2:61;|2/2/0", "2:61;1:33;|3/2/1", "1:33;2:61;|3/2/1", "2:61;|3/1/2", "2:63;|4/1/3", "|4/0/4", "|4/0/4", "1:50;2:65;|6/2/4", "2:65;1:50;|6/2/4", "2:65;1:52;|7/2/5"],
    source: `import {createSignal,createStore,createMemo,For,untrack} from "solid-js";
import {createRxEffect} from "reactivescript-tsx";
const [runs,setRuns]=createSignal(0);
const [active,setActive]=createSignal(0);
const [cleanups,setCleanups]=createSignal(0);
function useCounter(base:()=>number,seed:number):()=>number {
  const captured=untrack(()=>base());
  const [local,setLocal]=createSignal(seed);
  const current=createMemo(()=>base());
  createRxEffect([()=>current()],sample=>{
    setLocal(previous=>previous+1);
    setRuns(previous=>previous+1);
    setActive(previous=>previous+1);
    return ()=>{setActive(previous=>previous-1);setCleanups(previous=>previous+1);};
  });
  const value=createMemo(()=>current()+local()+captured);
  return value;
}
function Row(props:{id:number;first:number;tick:number}) {
  const base=createMemo(()=>(props.id===1?props.first:20)+props.tick);
  const value=useCounter(base,props.id===1?props.first:20);
  return <i>{props.id}:{value()};</i>;
}
export function Counter() {
  const [rows,setRows]=createStore([1,2]);
  const [first,setFirst]=createSignal(10);
  const [tick,setTick]=createSignal(0);
  const [step,setStep]=createSignal(0);
  return <button onClick={()=>{
    if(step()===0) {setFirst(11);setRows(ids=>[2,1]);}
    else if(step()===1) setRows(ids=>[1,2]);
    else if(step()===2) setRows(ids=>[2]);
    else if(step()===3) setTick(1);
    else if(step()===4) setRows(ids=>[]);
    else if(step()===5) setTick(2);
    else if(step()===6) {setFirst(15);setRows(ids=>[1,2]);}
    else if(step()===7) setRows(ids=>[2,1]);
    else setFirst(16);
    setStep(previous=>previous+1);
  }}><For each={rows}>{id=><Row id={id} first={first()} tick={tick()}/>}</For>|{runs()}/{active()}/{cleanups()}</button>;
}`,
  },
];

test("functional writes discard transient predicates but retain stored closure provenance", () => {
  const cases = [
    { value: "previous => [...previous, local]", escape: false },
    { value: "previous => filter(previous, entry => entry != local)", escape: false },
    { value: "previous => [...previous, () => local]", escape: true },
    { value: "previous => () => local", escape: true },
    { value: "previous => filter([() => local], entry => true)", escape: true },
    { value: "previous => map([1], entry => () => local)", escape: true },
    { value: "[() => filter([], entry => local)]", escape: true },
    { value: "previous => filter(previous, entry => local)", escape: true, shadow: true },
  ];
  for (const { value, escape, shadow } of cases) {
    const source = "source rows := [1]; source saved := []; export default component App() { {for item in rows {source local := 1; " +
      (shadow ? "fn filter(items, predicate) => predicate; " : "") +
      "<button onClick={() => {saved := " + value + "}}>x</button>}} }";
    const diagnostics = check(parseProgram(source));
    assert.equal(diagnostics.some(d => d.code === "REGION_ESCAPE"), escape, value);
    if (!escape) assert.deepEqual(diagnostics, [], value);
  }
});

for (const fixture of fixtures) {
  for (const native of [true, false]) {
    test((native ? "native: " : "compiled/interpreter: ") + fixture.name, async () => {
      const out = fileURLToPath(new URL("../.out/", import.meta.url));
      mkdirSync(out, { recursive: true });
      const dir = mkdtempSync(out + "tsx-owned-lifetimes-");
      const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
      try {
        const built = native ? undefined : buildTsx("main.tsx", path => path === "main.tsx" ? fixture.source : undefined, { target: "universal", mount: "Counter" });
        const files = built?.files ?? new Map([["native.mts", transform(fixture.source, { filename: "main.tsx", generate: "universal", moduleName: STRING_RENDERER }).code]]);
        for (const [name, code] of files) writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
        const mod = await import(pathToFileURL(dir + "/" + (built?.entry ?? "native.mts")).href);
        const app = createApp();
        const dispose = app.mount(native ? () => mod.Counter() : mod.default(app));
        const settle = async () => { flush(); await Promise.resolve(); flush(); };
        const button = (node: any): any => node.tag === "button" ? node : node.children?.map(button).find(Boolean);
        try {
          await settle();
          const frames = [app.frame()];
          for (let i = 1; i < fixture.frames.length; i++) {
            const click = button(app.root)?.props.onClick;
            assert.equal(typeof click, "function", "the authored child button must remain live");
            click(); await settle(); frames.push(app.frame());
          }
          assert.deepEqual(frames, fixture.frames);
        } finally { dispose(); flush(); }
        if (built) {
          const rt = new Runtime(built.set);
          try {
            const mounted = rt.step([]);
            if (fixture.mount !== undefined) assert.equal(mounted[0].frame, fixture.mount, "interpreter before registration effects");
            const frames = [mounted.at(-1)!.frame];
            const button = (items: any[]): any => {
              for (const item of items) {
                if (item.k === "el" && item.tag === "button") return item;
                const nested = item.children ?? item.inst?.items ?? item.node?.value?.items ?? item.committed?.inst?.items ?? item.committedRows?.flatMap((row: any) => row.inst.items) ?? [];
                const hit = button(nested); if (hit) return hit;
              }
            };
            for (let i = 1; i < fixture.frames.length; i++) {
              const handler = button(rt.view.items)?.attrs.find((attr: any) => attr.name === "onClick")?.node;
              assert.ok(handler, "interpreter must retain the authored child handler");
              handler.compute(rt)(); frames.push(rt.handler([]).at(-1)!.frame);
            }
            assert.deepEqual(frames, fixture.frames, "interpreter");
          } finally { rt.root.dispose(); }
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
