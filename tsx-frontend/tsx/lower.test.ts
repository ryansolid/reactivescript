import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lowerTsx, TsxError } from "./lower.ts";
import { check } from "./rx/compiler.ts";
import { traces } from "./test-utils.ts";
import { compile } from "./rx/compiler.ts";

const fixture = (name: string) =>
  readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
const counter = fixture("counter.tsx");
const rxCounter = fixture("counter.rx");
const composition = fixture("composition.tsx");

test("counter: existing AST, checker, compiler and native Solid agree through four clicks", async () => {
  await traces(counter, rxCounter, ["0", "2", "4", "6", "8"]);
});

test("declaration and JSX lines remain authored, and non-exported components stay non-exported", () => {
  const component = lowerTsx(counter).decls[0];
  assert.equal(component.k, "component");
  if (component.k !== "component") return;
  assert.equal(component.line, 3);
  assert.deepEqual(
    component.decls.map((d) => d.line),
    [4, 5],
  );
  assert.equal(component.view[0].line, 6);
  const local = lowerTsx("function Empty() { return <div/>; }");
  assert.ok(local.decls[0].k === "component");
  assert.notEqual(local.decls[0].exported, true);
  assert.deepEqual(check(local), []);
  assert.deepEqual(local.view, []);
});

test("import aliases, chained memos, signed initialization, nested text, and block handler", async () => {
  const tsx = counter
    .replace(
      "createSignal, createMemo",
      "createSignal as signal, createMemo as memo",
    )
    .replace("= createSignal(0)", "= signal(-2)")
    .replace("= createMemo", "= memo")
    .replace(
      "  return",
      "  const total = memo(() => doubled() + count());\n  return",
    )
    .replace("() => setCount(count() + 1)", "() => { setCount(count() + 1); }")
    .replace("{doubled()}</button>", "value: <span>{total()}</span>!</button>");
  const rx = rxCounter
    .replace("count := 0", "count := -2")
    .replace("  <button", "  total = doubled + count;\n  <button")
    .replace(
      '{"" + doubled}</button>',
      'value: <span>{"" + total}</span>!</button>',
    );
  await traces(tsx, rx, [
    "value: -6!",
    "value: -3!",
    "value: 0!",
    "value: 3!",
    "value: 6!",
  ]);
});

test("numeric JSX conversion preserves Infinity, NaN, negative Infinity, and signed zero", async () => {
  for (const [expr, rxExpr, expected] of [
    [
      "1 / count()",
      "1 / count",
      ["Infinity", "1", "0.5", "0.3333333333333333"],
    ],
    ["0 / count()", "0 / count", ["NaN", "0", "0", "0"]],
    [
      "-1 / count()",
      "-1 / count",
      ["-Infinity", "-1", "-0.5", "-0.3333333333333333"],
    ],
    ["-0 * count()", "-0 * count", ["0", "0", "0", "0"]],
  ] as const) {
    await traces(
      counter.replace("count() * 2", expr),
      rxCounter.replace("count * 2", rxExpr),
      [...expected],
    );
  }
});

test("typed function-form stores retain structured question-source semantics", () => {
  const prefix =
    'import {createStore,createSignal} from "solid-js";import {fetchState} from "./api";export function Counter(){const [id,setId]=createSignal(1);const [state,setState]=createStore(';
  const suffix =
    ");return <button onClick={()=>setState(d=>{d.a=5})}>{state.a}/{state.b}</button>}";
  for (const compute of [
    "():{a:number;b:number}=>({a:id(),b:2})",
    "():{a:number;b:number}=>{return {a:id(),b:2}}",
    "async ():Promise<{a:number;b:number}>=>await fetchState(id())",
    "async ():Promise<{a:number;b:number}>=>{return await fetchState(id())}",
  ]) {
    const program = lowerTsx(prefix + compute + suffix);
    assert.deepEqual(
      check(program).map((d) => d.code),
      compute.startsWith("async") ? ["IO_IN_REACTIVE"] : [],
    );
    const component = program.decls.find((d) => d.k === "component")!;
    if (component.k !== "component") return assert.fail("missing component");
    const source = component.decls.find(
      (d) => d.k === "source" && d.name === "state",
    );
    assert.ok(source && source.k === "source");
    assert.equal(source.question, true);
    // ST-1: structure is the type, which the frontend writes; the emitter lowers the question as a store from it.
    assert.equal(source.type, "{ a: number; b: number }");
    if (!compute.startsWith("async"))
      assert.match(
        compile({ ...program, view: [{ k: "el", tag: "Counter", attrs: [], children: [] }] }),
        /__rt\.qsource\("state",[^\n]*structured: true/,
      );
    assert.equal(source.init.k, compute.startsWith("async") ? "await" : "rec");
  }
  for (const compute of [
    "()=>({a:1,b:2})",
    "(n:number):{a:number;b:number}=>({a:n,b:2})",
    "async ()=>await fetchState(id())",
    "async ():Promise<{a:number;b:number}>=>fetchState(id())",
    "():{a:number;b:number}=>{const a=1;return {a,b:2}}",
    "():number=>1",
  ])
    assert.throws(
      () => lowerTsx(prefix + compute + suffix),
      /Function-form stores|function-form stores/,
    );
  assert.throws(
    () =>
      lowerTsx(prefix + '():{a:number;b:number}=>({a:"wrong",b:2})' + suffix),
    /Store computation does not match/,
  );
});

test("only function-form stores retain native standing-question invalidation", () => {
  for (const operation of ["refresh", "affects"]) {
    const source =
      "import {createStore," +
      operation +
      '} from "solid-js";export function Counter(){const [state,setState]=createStore(():{a:number}=>({a:1}));return <button onClick={()=>' +
      operation +
      "(state)}>{state.a}</button>}";
    const program = lowerTsx(source);
    assert.deepEqual(check(program), []);
    assert.throws(
      () => lowerTsx(source.replace("():{a:number}=>({a:1})", "{a:1}")),
      /not a static store/,
    );
  }
});

test("createPrevious lowers non-self history with a lazy matching fallback", () => {
  const source =
    'import {createSignal,createMemo} from "solid-js";import {createPrevious} from "reactivescript-tsx";export function Counter(){const [n,setN]=createSignal(0);const double=createMemo(()=>n()*2);const previous=createPrevious(double,()=>n()+10);return <button onClick={()=>setN(n()+1)}>{previous()}</button>}';
  const program = lowerTsx(source);
  assert.deepEqual(check(program), []);
  const component = program.decls.find((d) => d.k === "component")!;
  if (component.k !== "component") return assert.fail("missing component");
  const previous = component.decls.find(
    (d) => d.k === "eq" && d.name === "previous",
  );
  assert.deepEqual(previous && previous.k === "eq" && previous.e, {
    k: "pre",
    name: "double",
    init: {
      k: "bin",
      op: "+",
      l: { k: "id", name: "n" },
      r: { k: "lit", v: 10 },
    },
  });
  assert.doesNotThrow(() => lowerTsx(source.replace("double,()=>n()+10", "n")));
  assert.throws(
    () =>
      lowerTsx(
        source
          .replace("double,()=>n()+10", "double")
          .replace(
            "return <button",
            "const snapshot:number=previous();return <button",
          ),
      ),
    /Const initializer does not match/,
  );
  assert.doesNotThrow(() =>
    lowerTsx(
      source
        .replace("{previous()}", "{previous() === undefined ? 0 : previous()}")
        .replace("double,()=>n()+10", "double"),
    ),
  );
  for (const input of [
    "previous",
    "()=>double()",
    "double()",
    "42",
    "missing",
  ]) {
    assert.throws(
      () => lowerTsx(source.replace("double,()=>n()+10", input)),
      /createPrevious requires an original known local source or memo accessor/,
    );
  }
  assert.throws(
    () => lowerTsx(source.replace("()=>n()+10", '()=>"wrong"')),
    /fallback must match/,
  );
  assert.throws(
    () => lowerTsx(source.replace("()=>n()+10", "async ()=>0")),
    /synchronous arrow/,
  );
  assert.throws(
    () => lowerTsx(source.replace("()=>n()+10", "value=>0")),
    /synchronous arrow/,
  );
  assert.throws(
    () =>
      lowerTsx(
        source.replace("const double=createMemo(()=>n()*2)", "const double=3"),
      ),
    /original known local source or memo/,
  );
  assert.throws(
    () =>
      lowerTsx(
        source
          .replace(
            "createSignal,createMemo",
            "createSignal,createMemo,createStore",
          )
          .replace(
            "const double=createMemo(()=>n()*2)",
            "const [double,setDouble]=createStore({n:0})",
          ),
      ),
    /original known local source or memo/,
  );
});

test("createPrevious cannot construct inherited history in another owned setup", () => {
  const imports =
    'import {createSignal,createMemo} from "solid-js";import {createPrevious} from "reactivescript-tsx";';
  const moduleTarget =
    "const [n,setN]=createSignal(0);const double=createMemo(()=>n()*2);";
  for (const target of ["n", "double"])
    assert.throws(
      () =>
        lowerTsx(
          imports +
            moduleTarget +
            "function Panel(){const previous=createPrevious(" +
            target +
            ",()=>-1);return <span>{previous()}</span>}export function Counter(){return <Panel/>}",
        ),
      /same owned setup/,
    );
  assert.throws(
    () =>
      lowerTsx(
        imports +
          "function usePrevious(current:()=>number):()=>number{const previous=createPrevious(current,()=>-1);return previous}export function Counter(){const [n,setN]=createSignal(0);const previous=usePrevious(n);return <span>{previous()}</span>}",
      ),
    /createPrevious requires/,
  );
  assert.throws(
    () =>
      lowerTsx(
        imports +
          "function useCurrent():()=>number{const [n,setN]=createSignal(0);return n}export function Counter(){const current=useCurrent();const previous=createPrevious(current,()=>-1);return <span>{previous()}</span>}",
      ),
    /createPrevious requires/,
  );
  assert.throws(
    () =>
      lowerTsx(
        imports +
          "function Panel(props:{current:()=>number}){const previous=createPrevious(props.current,()=>-1);return <span>{previous()}</span>}export function Counter(){const [n,setN]=createSignal(0);return <Panel current={n}/>}",
      ),
    /Accessor props require a separate contract/,
  );
  assert.doesNotThrow(() =>
    lowerTsx(
      imports +
        moduleTarget +
        "const previous=createPrevious(double,()=>0);const older=createPrevious(previous,()=>-1);function Panel(){return <span>{previous()}/{older()}</span>}export function Counter(){return <Panel/>}",
    ),
  );
});

test("createPrevious refuses imported getters without companion memo ownership", () => {
  const dependency = lowerTsx(
    'import {createSignal} from "solid-js";export const [read,setRead]=createSignal(0)',
  );
  assert.throws(
    () =>
      lowerTsx(
        'import {read} from "./source.tsx";import {createPrevious} from "reactivescript-tsx";export function Counter(){const previous=createPrevious(read,()=>0);return <span>{previous()}</span>}',
        "main.tsx",
        {
          modules: new Map([
            ["./source.tsx", { path: "source.tsx", program: dependency }],
          ]),
        },
      ),
    /original known local source or memo/,
  );
});

// Temporary TSX boundary (https://github.com/ryansolid/reactivescript/issues/20): an authored ordinary async callback
// is refused at its async node with guidance to opt into an explicit generator action; it is never lowered or
// silently converted to an action.
const asyncCallbackRefused = (source: string, at: string) => (error: unknown) => {
  assert.ok(error instanceof TsxError);
  assert.equal(error.start, source.indexOf(at));
  assert.match(error.message, /Ordinary async callbacks are refused for now \(https:\/\/github\.com\/ryansolid\/reactivescript\/issues\/20\)/);
  assert.match(error.message, /wrap the work in action\(function\* \(\) \{ \.\.\. yield request\(\); \.\.\. \}\) and use yield instead of await/);
  assert.match(error.message, /opts into action semantics, which hold the action's writes until it completes; it is not a semantics-preserving rewrite/);
  return true;
};

test("ordinary async block handlers are refused at the async arrow with or without pre-await writes; explicit generator actions lower (issue #20)", () => {
  const held =
    'import {createSignal} from "solid-js";import {request} from "./api";export function Counter(){const [n,setN]=createSignal(0);return <button onClick={async (event:{target:{value:string}}):Promise<number>=>{setN(1);const result:number=await request(event.target.value);setN(result);return result+1}}>{n()}</button>}';
  assert.throws(() => lowerTsx(held), asyncCallbackRefused(held, "async (event"));
  // Without the pre-await write this body used to lower and was then inferred as an action upstream (AC-1b); it is
  // refused the same way now instead of gaining held action semantics.
  const source = held.replace("setN(1);", "");
  for (const variant of [
    source,
    source.replace("Promise<number>", "Promise<string>"),
    source.replace(
      "const result:number=await request(event.target.value)",
      "let result:number=(await request(event.target.value))",
    ),
    source.replace(
      "const result:number=await request(event.target.value);setN(result);return result+1",
      "await request(event.target.value);return 2",
    ),
  ])
    assert.throws(() => lowerTsx(variant), asyncCallbackRefused(variant, "async (event"));
  // The suggested opt-in: an explicit generator action, whose yield lowers to the action body's await.
  const explicit =
    'import {createSignal, action} from "solid-js";import {request} from "./api";export function Counter(){const [n,setN]=createSignal(0);const save=action(function*(value:string){try{const result:number=yield request(value);setN(result)}catch(error){setN(-1)}});return <button onClick={(event:{target:{value:string}})=>save(event.target.value)}>{n()}</button>}';
  const program = lowerTsx(explicit);
  assert.deepEqual(check(program), []);
  const counter = program.decls.find((d) => d.k === "component")!;
  assert.equal(counter.k, "component");
  if (counter.k !== "component") return;
  const save = counter.decls.find((d) => d.k === "action")!;
  assert.equal(save.k, "action");
  if (save.k !== "action") return;
  assert.deepEqual(save.params, ["value"]);
  const attempt = save.body[0];
  assert.equal(attempt.k, "try");
  if (attempt.k !== "try") return;
  assert.deepEqual(attempt.body.map((s) => s.k), ["let", "write"]);
  assert.equal(attempt.body[0].k === "let" && attempt.body[0].e.k, "await");
});

test("async implementations of contextual void callback props are refused at the async arrow (issue #20)", () => {
  const source =
    'import {request} from "./api";function Child(props:{onChange:(value:number)=>void}){return <button onClick={()=>props.onChange(2)}/>}export function Counter(){return <Child onChange={async next=>{const result:number=await request(next);return result}}/>}';
  assert.throws(() => lowerTsx(source), asyncCallbackRefused(source, "async next"));
  const sync = source.replace(
    "async next=>{const result:number=await request(next);return result}",
    "(next:number)=>{}",
  );
  assert.doesNotThrow(() => lowerTsx(sync));
  for (const forward of [
    "onClick={async ()=>{await props.onChange(2)}}",
    "onClick={async ()=>{const result:number=await props.onChange(2)}}",
    "onClick={async ()=>{const result=await props.onChange(2);return result}}",
    "onClick={async ()=>props.onChange(2)}",
  ]) {
    const variant = sync.replace("onClick={()=>props.onChange(2)}", forward);
    assert.throws(() => lowerTsx(variant), asyncCallbackRefused(variant, "async ()"));
  }
});

test("async handlers are refused before any await-position or body rule, for every body shape (issue #20)", () => {
  const wrap = (handler: string) =>
    'import {createSignal} from "solid-js";import {request} from "./api";export function Counter(){const [n,setN]=createSignal(0);return <button onClick={' +
    handler +
    "}>{n()}</button>}";
  for (const handler of [
    // Formerly lowered shapes, including await-then-write, awaits without writes, and early return/throw.
    "async ()=>{const result:number=await request();setN(result)}",
    "async ()=>{await request()}",
    "async (mode:number)=>{if(mode===0)return 7;if(mode===1)throw 1;const answer:number=await 8;return answer}",
    // Formerly refused by narrower rules, which no longer apply.
    "async ()=>{setN(await request())}",
    "async ()=>{if(await request())setN(1)}",
    "async ()=>{return await request()}",
    "async ()=>{const result:number=1+(await request())}",
    "async ()=>{throw await request()}",
    "async ()=>{setN(1);return 2}",
    "async ()=>{var result:number=await request()}",
    "async ()=>{const result=await request()}",
    "async ()=>setN(1)",
    "async ()=>await request()",
  ]) {
    const source = wrap(handler);
    assert.throws(() => lowerTsx(source), asyncCallbackRefused(source, "async ("));
  }
  const optimistic = wrap("async ()=>{setN(1);await request()}").replaceAll("createSignal", "createOptimistic");
  assert.throws(() => lowerTsx(optimistic), asyncCallbackRefused(optimistic, "async ("));
});

const rejected: [string, string, string][] = [
  [
    "destructured props parameter",
    composition.replace("CounterButton(incoming:", "CounterButton({ value }:"),
    "{ value }",
  ],
  [
    "named props type",
    composition.replace(
      "incoming: { direct: number; value: number; onIncrement: () => void }",
      "incoming: Props",
    ),
    "incoming: Props",
  ],
  [
    "optional prop contract",
    composition.replace("direct: number;", "direct?: number;"),
    "direct?:",
  ],
  [
    "readonly prop contract",
    composition.replace("direct: number;", "readonly direct: number;"),
    "readonly direct:",
  ],
  [
    "optional callback parameter contract",
    composition.replace(
      "onIncrement: () => void",
      "onIncrement: (delta?: number) => void",
    ),
    "(delta?:",
  ],
  [
    "callback return contract",
    composition.replace("onIncrement: () => void", "onIncrement: () => number"),
    "() => number",
  ],
  [
    "callback outside handler naming",
    composition.replace("onIncrement: () => void", "increment: () => void"),
    "increment:",
  ],
  [
    "numeric handler-named prop",
    composition.replace("direct: number;", "onValue: number;"),
    "onValue:",
  ],
  [
    "reserved children prop",
    composition.replace("direct: number;", "children: number;"),
    "children:",
  ],
  [
    "reserved ref prop",
    composition.replace("direct: number;", "ref: number;"),
    "ref:",
  ],
  [
    "reserved prototype prop",
    composition.replace("direct: number;", "__proto__: number;"),
    "__proto__:",
  ],
  [
    "duplicate prop contract",
    composition.replace("direct: number;", "direct: number; direct: number;"),
    "direct: number; value:",
  ],
  [
    "unknown component prop",
    composition.replace("direct={count()}", "unknown={count()}"),
    "unknown=",
  ],
  [
    "missing component prop",
    composition.replace("direct={count()} ", ""),
    "<CounterButton",
  ],
  [
    "accessor passed as numeric prop",
    composition.replace("direct={count()}", "direct={count}"),
    "count}",
  ],
  [
    "callback passed as numeric prop",
    composition.replace("direct={count()}", "direct={() => setCount(123)}"),
    "() => setCount(123)",
  ],
  [
    "numeric prop called as accessor",
    composition.replace(
      "direct={incoming.direct}",
      "direct={incoming.direct()}",
    ),
    "incoming.direct()",
  ],
  [
    "unknown prop read",
    composition.replace("incoming.value * 2", "incoming.unknown * 2"),
    "incoming.unknown",
  ],
  [
    "computed prop read",
    composition.replace("incoming.value * 2", 'incoming["value"] * 2'),
    'incoming["value"]',
  ],
  [
    "callback used as numeric value",
    composition.replace("incoming.value * 2", "incoming.onIncrement * 2"),
    "incoming.onIncrement *",
  ],
  [
    "callback invoked in memo",
    composition.replace("incoming.value * 2", "incoming.onIncrement()"),
    "incoming.onIncrement()",
  ],
  [
    "numeric prop invoked as callback",
    composition.replace("props.onIncrement()", "props.value()"),
    "props.value()",
  ],
  [
    "callback called with arguments",
    composition.replace("props.onIncrement()", "props.onIncrement(1)"),
    "props.onIncrement(1)",
  ],
  [
    "assignment to numeric props",
    composition.replace("props.onIncrement()", "props.value = 3"),
    "props.value =",
  ],
  [
    "setter passed as callback",
    composition.replace(
      "onIncrement={() => setCount(count() + 1)}",
      "onIncrement={setCount}",
    ),
    "setCount}",
  ],
  [
    "eager callback invocation",
    composition.replace(
      "onIncrement={() => setCount(count() + 1)}",
      "onIncrement={setCount(123)}",
    ),
    "setCount(123)",
  ],
  [
    "local prop destructuring",
    composition.replace(
      "const [count, setCount] = createSignal(10);",
      "const { value } = incoming;",
    ),
    "{ value }",
  ],
  [
    "component spread",
    composition.replace(
      "<CounterButton direct=",
      "<CounterButton {...incoming} direct=",
    ),
    "{...incoming}",
  ],
  [
    "duplicate component attribute",
    composition.replace(
      "direct={count()}",
      "direct={count()} direct={doubled()}",
    ),
    "direct={doubled()}",
  ],
  [
    "component children",
    composition.replace(
      "onIncrement={incoming.onIncrement} />",
      "onIncrement={incoming.onIncrement}>hello</Button>",
    ),
    "hello",
  ],
  [
    "unknown forwarded callback",
    composition.replace(
      "onIncrement={incoming.onIncrement}",
      "onIncrement={incoming.onUnknown}",
    ),
    "incoming.onUnknown",
  ],
  [
    "props import shadowing",
    composition.replace(
      "CounterButton(incoming:",
      "CounterButton(createSignal:",
    ),
    "createSignal:",
  ],
  [
    "duplicate component binding",
    composition + "\nfunction Button() { return <div/>; }",
    "Button() { return",
  ],
  [
    "direct recursive composition",
    composition + "\nfunction Recursive() { return <Recursive/>; }",
    "<Recursive/>",
  ],
  [
    "indirect recursive composition",
    composition +
      "\nfunction A() { return <B/>; } function B() { return <A/>; }",
    "<A/>",
  ],
  [
    "sibling local binding leakage",
    composition.replace("{props.local}</button>", "{count()}</button>"),
    "count()}</button>",
  ],
  [
    "accessor value is not a read",
    counter.replace("{doubled()}", "{doubled}"),
    "doubled}",
  ],
  [
    "memo cannot use accessor value",
    counter.replace("count() * 2", "count * 2"),
    "count *",
  ],
  [
    "unknown accessor",
    counter.replace("count() * 2", "other() * 2"),
    "other()",
  ],
  [
    "accessor arguments",
    counter.replace("count() * 2", "count(1) * 2"),
    "count(1)",
  ],
  [
    "async component",
    counter.replace("export function", "export async function"),
    "async function",
  ],
  [
    "async memo",
    counter.replace("createMemo(()", "createMemo(async ()"),
    "async ()",
  ],
  [
    "async expression handler",
    counter.replace("onClick={()", "onClick={async ()"),
    "async ()",
  ],
  [
    "signal options",
    counter.replace("createSignal(0)", "createSignal(0, { equals: false })"),
    "[count",
  ],
  [
    "memo options",
    counter.replace("count() * 2)", "count() * 2, 0)"),
    "doubled =",
  ],
  [
    "external reactive primitive without a supported value contract",
    counter.replace('from "solid-js"', 'from "other"'),
    "[count",
  ],
  [
    "extra import",
    counter.replace("createSignal,", "createRoot, createSignal,"),
    "createRoot",
  ],
  [
    "namespace import",
    counter.replace("{ createSignal, createMemo }", "* as Solid"),
    "* as Solid",
  ],
  ["type import", counter.replace("import {", "import type {"), "import type"],
  [
    "arbitrary call",
    counter.replace("setCount(count() + 1)", "console.log(count())"),
    "console.log",
  ],
  [
    "untyped handler parameter",
    counter.replace("onClick={()", "onClick={(event)"),
    "event)",
  ],
  [
    "untyped previous-value memo parameter",
    counter.replace("createMemo(()", "createMemo((previous)"),
    "previous)",
  ],
  ["untyped props", counter.replace("Counter()", "Counter(props)"), "props)"],
  [
    "local import shadow",
    counter.replace("[count, setCount]", "[createSignal, setCount]"),
    "createSignal, setCount",
  ],
  ["mutable binding", counter.replace("const [", "let ["), "let ["],
  [
    "generic call",
    counter.replace("createSignal(0)", "createSignal<number>(0)"),
    "[count",
  ],
  [
    "overflowing numeric literal",
    counter.replace("createSignal(0)", "createSignal(1e999)"),
    "1e999",
  ],
  [
    "typed binding",
    counter.replace("const doubled =", "const doubled: () => number ="),
    "doubled:",
  ],
  [
    // A default component is the module's entry (upstream MO-1c, see paired.test.ts); other default exports are refused.
    "non-component default export",
    counter.replace("export function Counter", "export default function counter"),
    "export default",
  ],
  ["object JSX", counter.replace("{doubled()}", "{{ value: 1 }}"), "{ value"],
  [
    "unknown component JSX",
    counter.replace("{doubled()}", "<Child/>"),
    "<Child",
  ],
  [
    "spread attribute",
    counter.replace("onClick=", "{...attrs} onClick="),
    "{...attrs}",
  ],
];
for (const [name, source, authored] of rejected) {
  test("rejects " + name + " at an authored location", () => {
    assert.throws(
      () => lowerTsx(source, "authored.tsx"),
      (error: unknown) => {
        assert.ok(error instanceof TsxError);
        assert.equal(error.filename, "authored.tsx");
        assert.equal(error.start, source.indexOf(authored));
        assert.ok(error.end > error.start);
        assert.match(error.message, /^authored.tsx:[0-9]+:[0-9]+: /);
        const before = source.slice(0, error.start);
        assert.equal(error.line, before.split("\n").length);
        assert.equal(error.column, before.length - before.lastIndexOf("\n"));
        return true;
      },
    );
  });
}

test("parser failures have authored locations, including UTF-16 offsets after non-ASCII text", () => {
  const source = "// \u{1f3b5}\n" + counter.replace("{doubled()}", "{doubled}");
  assert.throws(
    () => lowerTsx(source, "unicode.tsx"),
    (error: unknown) => {
      assert.ok(error instanceof TsxError);
      assert.equal(error.start, source.indexOf("doubled}"));
      return true;
    },
  );
  assert.throws(
    () => lowerTsx("export function Counter( {", "broken.tsx"),
    TsxError,
  );
});
