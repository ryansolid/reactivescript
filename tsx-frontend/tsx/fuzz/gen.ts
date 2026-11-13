// Differential fuzzer, milestone 1: one seeded, deterministic abstract program, emitted as a pair of genuine Solid
// TSX and handwritten-style RX for the same program. Only verified-subset features: numeric signals, memos, a store
// list with draft writes, Show/For, a child component with a value prop and a callback, an explicit generator action
// with an optimistic write and a controllable flight, and functional setters.

export type Ex =
  | { k: "lit"; v: number }
  | { k: "sig"; name: string }          // a signal accessor: s<i>, or the action's guess / fails
  | { k: "memo"; name: string }
  | { k: "field"; i: number }           // store.f<i>: record fields, never absent (indexed array reads may be)
  | { k: "self" }                       // the previous value inside a functional setter
  | { k: "bin"; op: "+" | "-" | "*"; l: Ex; r: Ex }
  | { k: "cond"; c: Cmp; t: Ex; f: Ex };
export type Cmp = { op: "<" | ">" | "==="; l: Ex; r: Ex };
export type Write =
  | { k: "set"; sig: string; e: Ex; functional: boolean }
  | { k: "field"; i: number; e: Ex }    // setStore((d) => { d.f<i> = e }), e may read d.f<i>
  | { k: "row"; i: number; e: Ex };     // setStore((d) => { d.rows[i].n = e }), e does not read the array
export type Handler = { writes: Write[]; amount?: number };   // amount: the handler then calls the action with it
export type Node =
  | { k: "text"; e: Ex }
  | { k: "button"; h: Handler }
  | { k: "child"; value: Ex; h: Handler }
  | { k: "show"; c: Cmp; then: Node[]; fallback: Node[] }
  | { k: "rows" };
export type Prog = {
  sigs: { name: string; init: number }[];
  store: { fields: number[]; rows: number[] } | null;   // numeric fields f<i>, and the n of each row
  action: { target: string } | null;    // adds guess = createOptimistic(() => target()), fails, and save(amount)
  memos: { name: string; e: Ex }[];
  view: Node[];
};
export type Step = { k: "click"; n: number } | { k: "answer"; amount: number; value: number; fail: boolean };
export type Case = { seed: number; prog: Prog; script: Step[] };

/** mulberry32: small, seeded, deterministic. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)],
  };
}

export function generate(seed: number): Case {
  const r = rng(seed);
  const sigs = Array.from({ length: 1 + r.int(3) }, (_, i) => ({ name: "s" + i, init: r.int(7) - 2 }));
  const store = r.chance(0.5)
    ? { fields: Array.from({ length: 1 + r.int(2) }, () => r.int(6)), rows: Array.from({ length: 2 + r.int(2) }, () => r.int(6)) }
    : null;
  const action = r.chance(0.5) ? { target: r.pick(sigs).name } : null;
  const readable = [...sigs.map(s => s.name), ...(action ? ["guess", "fails"] : [])];
  const memos: Prog["memos"] = [];
  const ex = (depth: number, cond: boolean, memoNames: string[]): Ex => {
    const leaf = (): Ex => {
      const options: (() => Ex)[] = [() => ({ k: "lit", v: r.int(7) - 2 }), () => ({ k: "sig", name: r.pick(readable) })];
      if (memoNames.length) options.push(() => ({ k: "memo", name: r.pick(memoNames) }));
      if (store) options.push(() => ({ k: "field", i: r.int(store.fields.length) }));
      return r.pick(options)();
    };
    if (depth <= 0 || r.chance(0.35)) return leaf();
    if (cond && r.chance(0.25))
      return { k: "cond", c: cmp(depth - 1, memoNames), t: ex(depth - 1, false, memoNames), f: ex(depth - 1, false, memoNames) };
    return { k: "bin", op: r.pick(["+", "-", "*"] as const), l: ex(depth - 1, false, memoNames), r: ex(depth - 1, false, memoNames) };
  };
  const cmp = (depth: number, memoNames: string[]): Cmp =>
    ({ op: r.pick(["<", ">", "==="] as const), l: reading(ex(depth, false, memoNames), memoNames), r: ex(depth, false, memoNames) });
  // Displays and memos must read something: a bare literal would lower to static text.
  const reading = (e: Ex, memoNames: string[]): Ex =>
    reads(e) ? e : { k: "bin", op: "+", l: { k: "sig", name: r.pick(readable) }, r: e };
  for (let i = r.int(3); i > 0; i--) {
    const names = memos.map(m => m.name);
    memos.push({ name: "m" + memos.length, e: reading(ex(2, true, names), names) });
  }
  const memoNames = memos.map(m => m.name);
  const amounts = [1, 2, 3];
  const handler = (): Handler => {
    const writes: Write[] = [];
    const written = new Set<string>();
    const writtenFields = new Set<number>();
    // Within one handler a source this change already wrote is not read again (AC-1d STALE_OWN_READ refuses it).
    const pure = (depth: number): Ex => {
      const leaf = (): Ex => {
        const live = sigs.map(s => s.name).filter(n => !written.has(n));
        const options: (() => Ex)[] = [() => ({ k: "lit", v: r.int(7) - 2 })];
        if (live.length) options.push(() => ({ k: "sig", name: r.pick(live) }));
        if (store && writtenFields.size < store.fields.length) {
          const fields = store.fields.map((_, i) => i).filter(i => !writtenFields.has(i));
          options.push(() => ({ k: "field", i: r.pick(fields) }));
        }
        return r.pick(options)();
      };
      if (depth <= 0 || r.chance(0.5)) return leaf();
      return { k: "bin", op: r.pick(["+", "-", "*"] as const), l: pure(depth - 1), r: pure(depth - 1) };
    };
    // A handler either calls the action (after at most one write) or performs one or two writes.
    const calls = !!action && r.chance(0.45);
    const count = calls ? (r.chance(0.3) ? 1 : 0) : 1 + r.int(2);
    for (let i = 0; i < count; i++) {
      if (store && r.chance(0.3)) {
        const free = store.fields.map((_, j) => j).filter(j => !writtenFields.has(j));
        if (r.chance(0.5) && free.length) {
          const field = r.pick(free);
          const e = r.chance(0.5) ? { k: "bin" as const, op: "+" as const, l: { k: "field" as const, i: field }, r: pure(1) } : pure(1);
          writes.push({ k: "field", i: field, e });
          writtenFields.add(field);
        } else writes.push({ k: "row", i: r.int(store.rows.length), e: pure(1) });
        continue;
      }
      const free = sigs.map(s => s.name).filter(n => !written.has(n));
      if (!free.length) break;
      const sig = r.pick(free);
      const functional = r.chance(0.5);
      const e = functional ? { k: "bin" as const, op: r.pick(["+", "-", "*"] as const), l: { k: "self" as const }, r: pure(1) } : pure(1);
      writes.push({ k: "set", sig, e, functional });
      written.add(sig);
    }
    if (calls || !writes.length) return action ? { writes, amount: r.pick(amounts) } : { writes: [{ k: "set", sig: sigs[0].name, e: { k: "lit", v: 1 }, functional: false }] };
    return { writes };
  };
  const node = (depth: number): Node => {
    const kinds = ["text", "button", "child", "button", ...(depth < 1 ? ["show"] : []), ...(store ? ["rows"] : [])];
    const kind = r.pick(kinds);
    if (kind === "text") return { k: "text", e: reading(ex(2, false, memoNames), memoNames) };
    if (kind === "button") return { k: "button", h: handler() };
    if (kind === "child") return { k: "child", value: ex(1, false, memoNames), h: handler() };
    if (kind === "rows") return { k: "rows" };
    return {
      k: "show", c: cmp(1, memoNames),
      then: Array.from({ length: 1 + r.int(2) }, () => node(depth + 1)),
      fallback: [{ k: "text", e: reading(ex(1, false, memoNames), memoNames) }],
    };
  };
  const view: Node[] = Array.from({ length: 2 + r.int(4) }, () => node(0));
  if (action) view.push({ k: "text", e: { k: "sig", name: "guess" } }, { k: "text", e: { k: "sig", name: "fails" } });
  if (!buttons(view)) view.push({ k: "button", h: handler() });
  const script: Step[] = [];
  const total = buttons(view);
  for (let i = 3 + r.int(8); i > 0; i--) {
    if (action && r.chance(0.35))
      script.push({ k: "answer", amount: r.pick(amounts), value: 1 + r.int(5), fail: r.chance(0.35) });
    else script.push({ k: "click", n: r.int(total) });
  }
  return { seed, prog: { sigs, store, action, memos, view }, script };
}

export const reads = (e: Ex): boolean =>
  e.k === "sig" || e.k === "memo" || e.k === "field" ||
  (e.k === "bin" && (reads(e.l) || reads(e.r))) || (e.k === "cond" && (reads(e.c.l) || reads(e.c.r) || reads(e.t) || reads(e.f)));
const mentions = (e: Ex, k: Ex["k"]): boolean =>
  e.k === k || (e.k === "bin" && (mentions(e.l, k) || mentions(e.r, k))) ||
  (e.k === "cond" && (mentions(e.c.l, k) || mentions(e.c.r, k) || mentions(e.t, k) || mentions(e.f, k)));
export const buttons = (nodes: Node[]): number =>
  nodes.reduce((n, x) => n + (x.k === "button" || x.k === "child" ? 1 : x.k === "show" ? buttons(x.then) + buttons(x.fallback) : 0), 0);

/** Every name an expression or the view reads exists, so a reduced program stays well formed. */
export function wellFormed(p: Prog): boolean {
  const sigNames = new Set([...p.sigs.map(s => s.name), ...(p.action ? ["guess", "fails"] : [])]);
  if (p.action && !p.sigs.some(s => s.name === p.action!.target)) return false;
  const memoSeen = new Set<string>();
  const ok = (e: Ex, self = false): boolean => {
    switch (e.k) {
      case "lit": return true;
      case "sig": return sigNames.has(e.name);
      case "memo": return memoSeen.has(e.name);
      case "field": return !!p.store && e.i < p.store.fields.length;
      case "self": return self;
      case "bin": return ok(e.l, self) && ok(e.r, self);
      case "cond": return ok(e.c.l, self) && ok(e.c.r, self) && ok(e.t, self) && ok(e.f, self);
    }
  };
  for (const m of p.memos) { if (!ok(m.e) || !reads(m.e)) return false; memoSeen.add(m.name); }
  const handlerOk = (h: Handler) => (h.amount === undefined || !!p.action) && (h.writes.length > 0 || h.amount !== undefined) &&
    h.writes.every(w => w.k === "set" ? p.sigs.some(s => s.name === w.sig) && ok(w.e, w.functional)
      : !!p.store && w.i < (w.k === "field" ? p.store.fields : p.store.rows).length && ok(w.e) && (w.k === "field" || !mentions(w.e, "field")));
  const nodeOk = (n: Node): boolean => n.k === "text" ? ok(n.e) && reads(n.e) : n.k === "button" ? handlerOk(n.h)
    : n.k === "child" ? ok(n.value) && handlerOk(n.h) : n.k === "rows" ? !!p.store
    : ok(n.c.l) && ok(n.c.r) && n.then.length > 0 && n.fallback.length > 0 && n.then.every(nodeOk) && n.fallback.every(nodeOk);
  return p.view.length > 0 && p.view.every(nodeOk);
}

// ---------------------------------------------------------------- emitters

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
type Ctx = { tsx: boolean; self?: string; draft?: string; fresh: () => string };
const lit = (v: number) => (v < 0 ? "(" + v + ")" : String(v));
function expr(e: Ex, c: Ctx): string {
  switch (e.k) {
    case "lit": return lit(e.v);
    case "sig": case "memo": return c.tsx ? e.name + "()" : e.name;
    case "field": return (c.tsx && c.draft ? c.draft : "store") + ".f" + e.i;
    case "self": return c.self!;
    case "bin": return "(" + expr(e.l, c) + " " + e.op + " " + expr(e.r, c) + ")";
    case "cond": return "(" + compare(e.c, c) + " ? " + expr(e.t, c) + " : " + expr(e.f, c) + ")";
  }
}
const compare = (k: Cmp, c: Ctx) => "(" + expr(k.l, c) + " " + (c.tsx ? k.op : k.op === "===" ? "==" : k.op) + " " + expr(k.r, c) + ")";

function write(w: Write, c: Ctx): string {
  if (w.k === "row" || w.k === "field") {
    const path = w.k === "row" ? ".rows[" + w.i + "].n" : ".f" + w.i;
    if (!c.tsx) return "store" + path + " := " + expr(w.e, c) + ";";
    const d = c.fresh();
    return "setStore((" + d + ") => { " + d + path + " = " + expr(w.e, { ...c, draft: d }) + "; });";
  }
  if (w.functional) {
    const v = c.fresh();
    return c.tsx ? "set" + cap(w.sig) + "((" + v + ") => " + expr(w.e, { ...c, self: v }) + ");"
      : w.sig + " := " + v + " => " + expr(w.e, { ...c, self: v }) + ";";
  }
  return c.tsx ? "set" + cap(w.sig) + "(" + expr(w.e, c) + ");" : w.sig + " := " + expr(w.e, c) + ";";
}
const handlerText = (h: Handler, c: Ctx) =>
  "() => { " + [...h.writes.map(w => write(w, c)), ...(h.amount !== undefined ? ["save(" + h.amount + ");"] : [])].join(" ") + " }";

function nodes(ns: Node[], c: Ctx, label: { n: number }): string {
  return ns.map(n => {
    switch (n.k) {
      case "text": return "<span>{" + (c.tsx ? "" : '"" + ') + expr(n.e, c) + "}</span>";
      case "button": return "<button onClick={" + handlerText(n.h, c) + "}>b" + label.n++ + "</button>";
      case "child": label.n++; return "<Child value={" + expr(n.value, c) + "} onBump={" + handlerText(n.h, c) + "} />";
      case "rows": {
        const row = c.fresh();
        return c.tsx ? "<For each={store.rows}>{(" + row + ") => <u>{" + row + ".n}</u>}</For>"
          : "{for " + row + " in store.rows { <u>{\"\" + " + row + ".n}</u> }}";
      }
      case "show": {
        const then = "<b>" + nodes(n.then, c, label) + "</b>", fallback = "<i>" + nodes(n.fallback, c, label) + "</i>";
        return c.tsx ? "<Show when={" + compare(n.c, c) + "} fallback={" + fallback + "}>" + then + "</Show>"
          : "{if " + compare(n.c, c) + " { " + then + " } else { " + fallback + " }}";
      }
    }
  }).join("\n      ");
}
const uses = (ns: Node[], k: Node["k"]): boolean => ns.some(n => n.k === k || (n.k === "show" && (uses(n.then, k) || uses(n.fallback, k))));

export function emitTsx(p: Prog): string {
  let i = 0;
  const c: Ctx = { tsx: true, fresh: () => "v" + i++ };
  const imports = ["createSignal", ...(p.memos.length ? ["createMemo"] : []), ...(p.store ? ["createStore"] : []),
    ...(p.action ? ["createOptimistic", "action"] : []), ...(uses(p.view, "show") ? ["Show"] : []), ...(uses(p.view, "rows") ? ["For"] : [])];
  const body = [
    ...p.sigs.map(s => "const [" + s.name + ", set" + cap(s.name) + "] = createSignal(" + s.init + ");"),
    ...(p.store ? ["const [store, setStore] = createStore(" + "{ " + [...p.store.fields.map((n, j) => "f" + j + ": " + n), "rows: [" + p.store.rows.map((n, j) => "{ id: " + (j + 1) + ", n: " + n + " }").join(", ") + "]"].join(", ") + " }" + ");"] : []),
    ...(p.action ? [
      "const [guess, setGuess] = createOptimistic(() => " + p.action.target + "());",
      "const [fails, setFails] = createSignal(0);",
    ] : []),
    ...p.memos.map(m => "const " + m.name + " = createMemo(() => " + expr(m.e, c) + ");"),
    ...(p.action ? [
      "const save = action(function* (amount: number) {",
      "  setGuess((guessed) => guessed + amount);",
      "  try {",
      "    const got: number = yield request(amount);",
      "    set" + cap(p.action.target) + "((current) => current + got);",
      "  } catch (error) {",
      "    setFails((count) => count + 1);",
      "  }",
      "});",
    ] : []),
  ];
  const view = nodes(p.view, c, { n: 0 });
  return [
    "import { " + imports.join(", ") + ' } from "solid-js";',
    ...(p.action ? ['import { request } from "./api";'] : []),
    "",
    "export default function App() {",
    ...body.map(l => "  " + l),
    "  return (",
    "    <section>",
    "      " + view,
    "    </section>",
    "  );",
    "}",
    ...(uses(p.view, "child") ? ["", "function Child(props: { value: number; onBump: () => void }) {",
      "  return <button onClick={() => props.onBump()}>{props.value}</button>;", "}"] : []),
  ].join("\n") + "\n";
}

export function emitRx(p: Prog): string {
  let i = 0;
  const c: Ctx = { tsx: false, fresh: () => "v" + i++ };
  const body = [
    ...p.sigs.map(s => "source " + s.name + " := " + s.init + ";"),
    ...(p.store ? ["source store := " + "{ " + [...p.store.fields.map((n, j) => "f" + j + ": " + n), "rows: [" + p.store.rows.map((n, j) => "{ id: " + (j + 1) + ", n: " + n + " }").join(", ") + "]"].join(", ") + " }" + ";"] : []),
    ...(p.action ? ["source guess = " + p.action.target + ";", "source fails := 0;"] : []),
    ...p.memos.map(m => m.name + " = " + expr(m.e, c) + ";"),
    ...(p.action ? [
      "action save(amount: number) {",
      "  optimistic guess := guessed => guessed + amount;",
      "  try {",
      "    let got = await request(amount);",
      "    " + p.action.target + " := current => current + got;",
      "  } catch (error) {",
      "    fails := count => count + 1;",
      "  }",
      "}",
    ] : []),
  ];
  const view = nodes(p.view, c, { n: 0 });
  return [
    ...(p.action ? ['import { request } from "./api";', ""] : []),
    "export default component App() {",
    ...body.map(l => "  " + l),
    "  <section>",
    "      " + view,
    "  </section>",
    "}",
    ...(uses(p.view, "child") ? ["", "component Child(props: { value: number; onBump: action catches(nothing) }) {",
      '  <button onClick={() => { props.onBump() }}>{"" + props.value}</button>', "}"] : []),
  ].join("\n") + "\n";
}
