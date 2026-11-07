// Differential fuzzer runner: one generated case, five legs (native Solid, compiled TSX, compiled RX, interpreted TSX,
// interpreted RX), canonical facts (TSX vs RX), and exact frames for the generated event and flight script.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { loadTsxModules } from "../modules.ts";
import { semanticFacts } from "../rx/facts.ts";
import { checkModules, compileModules, lowerViews, STRING_RENDERER, type ModuleSet } from "../rx/compiler.ts";
import { createApp, flush, Runtime } from "../rx/runtime.ts";
import { buttons, emitRx, emitTsx, wellFormed, type Case, type Handler, type Node, type Step } from "./gen.ts";

export const LEGS = ["native", "compiled TSX", "compiled RX", "interpreted TSX", "interpreted RX"] as const;
export type Leg = (typeof LEGS)[number];
export type Outcome =
  | { status: "ok"; traces: Record<Leg, string[]> }
  | { status: "divergent"; classes: string[]; traces: Record<Leg, string[]>; facts: boolean }
  | { status: "generator-bug"; where: string; message: string };

const API = "export fn request(n: number): number";
const renderer = fileURLToPath(new URL("../test-renderer.ts", import.meta.url));
const tmpRoot = fileURLToPath(new URL("../../.out/fuzz/tmp/", import.meta.url));

function load(name: string, text: string): ModuleSet {
  const files: Record<string, string> = { [name]: text, "api.d.rx": API };
  const set = loadTsxModules(name, path => files[path]);
  if (set.diags.length) throw new Error(set.diags.map(d => d.code + ": " + d.msg).join("; "));
  const checked = checkModules(set).diags;
  if (checked.length) throw new Error(checked.map(d => d.code + " (" + d.file + ":" + d.line + "): " + d.msg).join("; "));
  return set;
}

type Driver = { frame: () => string; click: (n: number) => string; answer: (s: Extract<Step, { k: "answer" }>) => string; settle: () => Promise<void>; dispose: () => void };
async function trace(driver: Driver, script: Step[]): Promise<string[]> {
  try {
    const out = ["init|" + driver.frame()];
    for (const step of script) {
      const mark = step.k === "click" ? driver.click(step.n) : driver.answer(step);
      await driver.settle();
      out.push(mark + "|" + driver.frame());
    }
    return out;
  } finally { driver.dispose(); }
}

function interpreted(set: ModuleSet): Driver {
  const rt = new Runtime(set);
  let frame = rt.step([]).at(-1)!.frame;
  const found = (items: any[]): any[] => items.flatMap((item: any) => item.k === "el" && item.tag === "button" ? [item]
    : found(item.children ?? item.inst?.items ?? item.committed?.inst?.items ?? item.committedRows?.flatMap((r: any) => r.inst.items) ?? []));
  return {
    frame: () => frame,
    click: n => {
      const button = found(rt.view.items)[n];
      if (!button) return "nobutton";
      button.attrs.find((a: any) => a.name === "onClick").node.compute(rt)();
      frame = rt.handler([]).at(-1)!.frame;
      return "click";
    },
    answer: s => {
      const f = rt.flights.get("request:" + s.amount);
      if (!f || f.state !== "pending") return "skip";
      frame = rt.land('"request:' + s.amount + '"', s.fail ? new Error("offline") : s.value, s.fail).at(-1)!.frame;
      return "answer";
    },
    settle: async () => {},
    dispose: () => rt.root.dispose(),
  };
}

async function rendered(files: Map<string, string>, entry: string, native: boolean, script: Step[]): Promise<string[]> {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(tmpRoot + "leg-");
  try {
    for (const [name, code] of files) writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
    const mod = await import(pathToFileURL(dir + "/" + entry).href);
    const app = createApp();
    // Native Solid imports ./api as plain JS; it reaches the same controllable flights as the compiled RX.
    (globalThis as any).__fuzzRequest = (...args: unknown[]) => (app.api("request")(...args) as any).first;
    const buttons = (node: any): any[] => node?.tag === "button" ? [node] : (node?.children ?? []).flatMap(buttons);
    let frame = "";
    const settle = async () => {
      for (let i = 0; i < 3; i++) { await new Promise<void>(done => setImmediate(done)); flush(); }
      frame = app.frame();
    };
    const dispose = app.mount(native ? () => mod.default() : mod.default(app));
    await settle();
    return await trace({
      frame: () => frame, settle, dispose,
      click: n => { const b = buttons(app.root)[n]; if (!b) return "nobutton"; b.props.onClick(); return "click"; },
      answer: s => {
        const f = app.flights.get("request:" + s.amount) as any;
        if (!f || f.started) return "skip";
        if (s.fail) f.reject(new Error("offline")); else f.resolve(s.value);
        return "answer";
      },
    }, script);
  } finally {
    delete (globalThis as any).__fuzzRequest;
    rmSync(dir, { recursive: true, force: true });
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const crashing = async (run: () => Promise<string[]>): Promise<string[]> => {
  try { return await run(); } catch (e) { return ["CRASH " + String((e as Error).message).split("\n")[0]]; }
};

/** Which legs disagree decides the class: TSX-derived vs RX-derived on one backend is the adapter; the interpreter vs
 *  the compiler on the handwritten RX is upstream; the compiled handwritten RX vs native Solid is a semantics
 *  difference or a bug. */
export function classify(t: Record<Leg, string[]>, facts: boolean): string[] {
  const out: string[] = [];
  if (!facts) out.push("adapter: facts");
  if (!same(t["compiled TSX"], t["compiled RX"]) || !same(t["interpreted TSX"], t["interpreted RX"])) out.push("adapter: frames");
  if (!same(t["compiled RX"], t["interpreted RX"])) out.push("upstream: interpreter vs compiled");
  if (!same(t["compiled RX"], t.native)) out.push("semantics: RX vs native");
  return out;
}

export async function runCase(c: Case): Promise<Outcome & { tsx: string; rx: string }> {
  const tsx = emitTsx(c.prog), rx = emitRx(c.prog);
  let tsxSet: ModuleSet, rxSet: ModuleSet, native: string;
  try { tsxSet = load("App.tsx", tsx); } catch (e) { return { status: "generator-bug", where: "TSX", message: String((e as Error).message), tsx, rx }; }
  try { rxSet = load("App.rx", rx); } catch (e) { return { status: "generator-bug", where: "RX", message: String((e as Error).message), tsx, rx }; }
  try {
    native = transform(tsx, { filename: "App.tsx", generate: "universal", moduleName: STRING_RENDERER }).code
      .replaceAll('"./api"', '"data:text/javascript,export const request=(...args)=>globalThis.__fuzzRequest(...args)"');
  } catch (e) { return { status: "generator-bug", where: "Solid compiler", message: String((e as Error).message), tsx, rx }; }
  const facts = same(semanticFacts(tsxSet), semanticFacts(rxSet));
  const compiled = (set: ModuleSet) => { const built = compileModules(set); return rendered(lowerViews(built.files, "universal"), built.entry, false, c.script); };
  const traces = {
    native: await crashing(() => rendered(new Map([["native.mts", native]]), "native.mts", true, c.script)),
    "compiled TSX": await crashing(() => compiled(tsxSet)),
    "compiled RX": await crashing(() => compiled(rxSet)),
    "interpreted TSX": await crashing(() => trace(interpreted(tsxSet), c.script)),
    "interpreted RX": await crashing(() => trace(interpreted(rxSet), c.script)),
  } as Record<Leg, string[]>;
  const classes = classify(traces, facts);
  return classes.length ? { status: "divergent", classes, traces, facts, tsx, rx } : { status: "ok", traces, tsx, rx };
}

// ---------------------------------------------------------------- reducer

/** The static position of a node's buttons in emission order (a Show's then before its fallback), and their count. */
function span(view: Node[], target: Node): [number, number] {
  let o = 0;
  const walk = (ns: Node[]): boolean => {
    for (const n of ns) {
      if (n === target) return true;
      if (n.k === "button" || n.k === "child") o++;
      if (n.k === "show" && (walk(n.then) || walk(n.fallback))) return true;
    }
    return false;
  };
  walk(view);
  return [o, buttons([target])];
}

/** Smaller variants of a case: drop a script step, a view node, a handler write, a memo, a signal, the store, the
 *  action, or inline a Show's branch. Ill-formed variants are discarded before running. */
function variants(c: Case): Case[] {
  const out: Case[] = [];
  const clone = (): Case => structuredClone(c);
  c.script.forEach((_, i) => { const v = clone(); v.script.splice(i, 1); out.push(v); });
  const lists = (ns: Node[], at: (v: Case) => Node[]) => {
    ns.forEach((n, i) => {
      const v = clone(); at(v).splice(i, 1); out.push(v);
      // The same removal with the script's static click indices shifted past the removed buttons.
      const s = clone(); const [o, k] = span(s.prog.view, at(s)[i]); at(s).splice(i, 1);
      if (k) {
        s.script = s.script.filter(x => !(x.k === "click" && x.n >= o && x.n < o + k)).map(x => (x.k === "click" && x.n >= o + k ? { ...x, n: x.n - k } : x));
        out.push(s);
      }
      if (n.k === "show") {
        const inline = clone(); at(inline).splice(i, 1, ...n.then); out.push(inline);
        lists(n.then, v2 => (at(v2)[i] as Extract<Node, { k: "show" }>).then);
      }
      if (n.k === "button" || n.k === "child") {
        const h = (v2: Case) => (at(v2)[i] as { h: Handler }).h;
        n.h.writes.forEach((_, j) => { const w = clone(); h(w).writes.splice(j, 1); out.push(w); });
        if (n.h.amount !== undefined && n.h.writes.length) { const w = clone(); h(w).writes = []; out.push(w); }
      }
    });
  };
  lists(c.prog.view, v => v.prog.view);
  c.prog.memos.forEach((_, i) => { const v = clone(); v.prog.memos.splice(i, 1); out.push(v); });
  c.prog.sigs.forEach((_, i) => { const v = clone(); v.prog.sigs.splice(i, 1); out.push(v); });
  if (c.prog.store) {
    const v = clone(); v.prog.store = null; out.push(v);
    if (c.prog.store.rows.length > 1) { const w = clone(); w.prog.store!.rows.pop(); out.push(w); }
    if (c.prog.store.fields.length > 1) { const w = clone(); w.prog.store!.fields.pop(); out.push(w); }
  }
  if (c.prog.action) { const v = clone(); v.prog.action = null; out.push(v); }
  return out.filter(v => wellFormed(v.prog));
}

/** Greedy reduction: keep the first smaller variant whose outcome has the same classes, until none does. */
export async function reduce(c: Case, classes: string[], budget = 400): Promise<{ reduced: Case; runs: number }> {
  let best = c, runs = 0;
  const key = JSON.stringify([...classes].sort());
  for (let progress = true; progress && runs < budget;) {
    progress = false;
    for (const v of variants(best)) {
      if (++runs > budget) break;
      const o = await runCase(v);
      if (o.status === "divergent" && JSON.stringify([...o.classes].sort()) === key) { best = v; progress = true; break; }
    }
  }
  return { reduced: best, runs };
}
