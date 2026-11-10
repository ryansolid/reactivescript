// Parses scenarios/*.md (the Markdown is the source) and runs them against the runtime.
import { parseProgram, parseStmts, ParseError } from "./parse.ts";
import { Runtime, RuleError, CheckError } from "./runtime.ts";

type Row = { instant: number; action: string; frame: string; effects: string[] };
type Table = { title: string; program: string | null; rows: Row[] };
type Rejected = { rule: string; program: string; handlers: string[]; warn: boolean; types?: boolean };   // types: refused by the type layer (TY, types/run.ts)
export type Divergence = { table: string; instant: number; frame: string; effects?: string[]; runner: "oracle" | "server" | "hydrated"; ruled?: true };   // effects: the effect log Solid gives at that instant, when it differs too   // what Solid 2.0 shows where the spec rules otherwise (the client's, or the server render's)
export type Scenario = { name: string; program: string; tables: Table[]; rejected: Rejected[]; divergences: Divergence[];
  entry: string; modules: Map<string, string>;
  server: Row[];     // 10: `## Server frames` — what a browser shows from the server's stream (ref/ssr/run.ts only)
  before: Row[];
  css: string | null };   // 07 §6b: `## Scoped CSS` — the compiled stylesheet, each scope hash written h1, h2… in order (ref/compile/run.ts only)   // 10 SV-3e: `## Before hydration` — user events on the served page, then `hydrate` (ref/ssr/run.ts only)   // 09: the entry's module key, and the `## Modules` fences (`-- module: ./lib.rx`) by key

const strip = (s: string) => s.replace(/`/g, "").trim();

import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { loadModules, joinPath, type ModuleSet } from "./modules.ts";
import { checkModules, type ModSig, type ExportSig } from "./check.ts";
import { printSignature, parseSignature } from "./signature.ts";

/** MO-9 / CN-4b: each module of a program checked against its imports' printed `.d.rx` — read back in place of their bodies —
 *  gets the verdicts it gets against the bodies, and the text reads back as the signature it was printed from. Null: it holds. */
export function signaturesInPlace(set: ModuleSet): string | null {
  if (set.order.length < 2) return null;
  let full: ReturnType<typeof checkModules>; try { full = checkModules(set); } catch { return null; }
  const norm = (x: ExportSig) => JSON.stringify(x, (k, v) => v instanceof Set ? [...v].sort() : Array.isArray(v) && v.every(y => typeof y === "string") && k !== "params" && k !== "roots" ? [...v].sort() : k === "own" ? [...new Set((v as { cls: string }[]).map(o => o.cls))].sort() : v);
  const back = new Map<string, ModSig>();
  for (const [path, sig] of full.sigs) {
    if (!set.order.includes(path)) continue;
    const text = printSignature(sig); const read = parseSignature(text, path); back.set(path, read);
    for (const [n, x] of sig.exports) { const y = read.exports.get(n); if (!y || norm(x) !== norm(y)) return `${path.split("/").pop()}: ${n} reads back as ${y ? norm(y) : "nothing"}, printed from ${norm(x)}`; }
  }
  const key = (d: { code: string; rule: string; line: number; file?: string }) => `${d.file ?? set.entry}:${d.line} ${d.code} (${d.rule})`;
  for (const path of set.order) {                                       // each module alone, its dependencies by signature
    const alone: ModuleSet = { ...set, programs: new Map([[path, set.programs.get(path)!]]), order: [path], diags: set.diags.filter(d => (d.file ?? set.entry) === path), signatures: new Map([...(set.signatures ?? []), ...[...back].filter(([p]) => p !== path)]) };
    const want = [...new Set(full.diags.filter(d => (d.file ?? set.entry) === path).map(key))].sort().join("; ");
    const got = [...new Set(checkModules(alone).diags.filter(d => (d.file ?? set.entry) === path).map(key))].sort().join("; ");
    if (want !== got) return `${path.split("/").pop()} against its imports' .d.rx: ${got || "no diagnostic"}; against their bodies: ${want || "no diagnostic"}`;
  }
  return null;
}
/** The module set for one of a scenario's programs: the entry is `src`; its `.rx` imports are the `## Modules` fences, else files
 *  beside the entry (a `file:` program). */
export function moduleSet(sc: Scenario, src: string): ModuleSet {
  return loadModules(sc.entry, p => p === sc.entry ? src : sc.modules.get(p) ?? (existsSync(p) ? readFileSync(p, "utf8") : undefined));
}
export function parseScenario(name: string, md: string, baseDir = "."): Scenario {
  const sections = md.split(/^## /m).slice(1).map(s => { const nl = s.indexOf("\n"); return { title: s.slice(0, nl).trim(), body: s.slice(nl + 1) }; });
  const fence = (b: string) => { const m = /```[^\n]*\n([\s\S]*?)```/.exec(b); return m ? m[1] : null; };
  const table = (b: string): Row[] => {
    const lines = b.split("\n").filter(l => l.trim().startsWith("|"));
    if (lines.length < 2) return [];
    const head = lines[0].split("|").map(strip).map(s => s.toLowerCase());
    const col = (n: string) => head.indexOf(n);
    return lines.slice(2).map(l => {
      const cells = l.split("|").map(strip);
      const eff = col("effect") >= 0 ? cells[col("effect")] : "—";
      return { instant: Number(cells[col("instant")]), action: cells[col("action")], frame: cells[col("frame")],
        effects: eff === "—" || eff === "" ? [] : eff.split(";").map(s => s.trim()) };
    });
  };
  let program = ""; let entry = "main.rx"; const modules = new Map<string, string>();
  const tables: Table[] = []; const rejected: Rejected[] = []; const divergences: Divergence[] = []; let server: Row[] = []; let before: Row[] = []; let css: string | null = null;
  for (const s of sections) {
    if (s.title === "Program") { const f = /^file:\s*(\S+)/m.exec(s.body); if (f) entry = resolvePath(baseDir, f[1]); program = f ? readFileSync(entry, "utf8") : (fence(s.body) ?? ""); }   // `file: ../examples/x.rx`: a real program
    else if (s.title === "Modules") {
      for (const m of s.body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) { const [first, ...rest] = m[1].split("\n"); const k = /--\s*module:\s*(\S+)/.exec(first); if (k) modules.set(joinPath("main.rx", k[1]), rest.join("\n")); }
    }
    else if (s.title === "Server frames") server = table(s.body);
    else if (s.title === "Before hydration") before = table(s.body);
    else if (s.title === "Scoped CSS") css = fence(s.body);
    else if (s.title === "Frames") tables.push({ title: "Frames", program: null, rows: table(s.body) });
    else if (s.title.startsWith("Variant")) tables.push({ title: s.title, program: fence(s.body), rows: table(s.body) });
    else if (s.title.startsWith("Divergences")) {
      for (const m of s.body.matchAll(/^- (oracle|server|hydrated) "([^"]*)" instant (\d+): `([^`]*)`(?: effects `([^`]*)`)?/gm)) divergences.push({ runner: m[1] as Divergence["runner"], table: m[2], instant: Number(m[3]), frame: m[4], ...(m[5] !== undefined ? { effects: m[5] === "—" || m[5] === "" ? [] : m[5].split(";").map(x => x.trim()) } : {}) });
    }
    else if (s.title === "Hydration window") {                     // SV-3b: frames of a client that took over before the server answered — ruled, not divergences
      for (const m of s.body.matchAll(/^- "([^"]*)" instant (\d+): `([^`]*)`/gm)) divergences.push({ runner: "hydrated", table: m[1], instant: Number(m[2]), frame: m[3], ruled: true });
    }
    else if (s.title.startsWith("Rejected")) {
      for (const m of s.body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
        const [first, ...rest] = m[1].split("\n");
        const r = /--\s*(reject|warn|types):\s*([\w-]+)/.exec(first);
        if (r) rejected.push({ rule: r[2], warn: r[1] === "warn", types: r[1] === "types", program: rest.filter(l => !l.trim().startsWith("--")).join("\n"),
          handlers: rest.map(l => /--\s*handler:\s*(.*)/.exec(l)?.[1]).filter((x): x is string => !!x) });
      }
    }
  }
  return { name, program, tables, rejected, divergences, entry, modules, server, before, css };
}

export type Result = { ok: boolean; lines: string[] };

export function runScenario(sc: Scenario): Result {
  const lines: string[] = []; let ok = true;
  for (const [title, src] of [["Program", sc.program], ...sc.tables.filter(t => t.program).map(t => [t.title, t.program!]), ...sc.rejected.filter(r => !r.types).map(r => [`rejected(${r.rule})`, r.program])] as [string, string][]) {
    let set: ModuleSet; try { set = moduleSet(sc, src); } catch { continue; }
    if (set.order.length < 2) continue;
    const bad = signaturesInPlace(set);
    if (bad) { ok = false; lines.push(`  ✗ ${title}: signatures in place (MO-9): ${bad}`); } else lines.push(`  ✓ ${title}: checked against its imports' .d.rx as against their bodies (MO-9)`);
  }
  if (!sc.tables.length && sc.program) {                                // a program with nothing to run (MO-9: modules by signature) is still checked
    try { const d = checkModules(moduleSet(sc, sc.program)).diags; if (d.length) { ok = false; lines.push(`  ✗ Program: refused — ${d.map(x => `${x.code} (${x.rule}) line ${x.line}`).join(", ")}`); } else lines.push("  ✓ Program: accepted by the checker"); }
    catch (e) { ok = false; lines.push(`  ✗ Program: ${(e as Error).message}`); }
  }
  const base = sc.tables.find(t => t.title === "Frames");
  for (const t of sc.tables) {
    const src = t.program ?? sc.program;
    let rows = t.rows; let own = 0;
    if (t !== base && base && rows.length && rows[0].instant > 0) { const pre = base.rows.filter(r => r.instant < rows[0].instant); own = pre.length; rows = [...pre, ...rows]; }
    let rt: Runtime;
    try { rt = new Runtime(moduleSet(sc, src)); } catch (e) { ok = false; lines.push(`  ✗ ${t.title}: ${(e as Error).message}`); continue; }
    let pending: { frame: string; effects: string[] }[] = [];
    for (const r of rows) {
      let got: { frame: string; effects: string[] } | undefined;
      try {
        if (r.action === "mount") { pending = rt.step([]); got = pending.shift(); }
        else if ((r.action === "(effect)" || r.action === "(flush)")) got = pending.shift();
        else if (r.action.startsWith("handler")) { pending = rt.handler(parseStmts(r.action.slice(7))); got = pending.shift(); }
        else if (/^(resolve|reject)\s/.test(r.action)) {
          const m = /^(resolve|reject)\s+(\S+)\s+([\s\S]*)$/.exec(r.action)!;
          const valueExpr = parseStmts(m[3])[0]; const value = valueExpr.k === "expr" ? rt.runStmts([valueExpr], (rt as any).virtualScope(), new Map()) : undefined;
          pending = rt.land(m[2], value, m[1] === "reject"); got = pending.shift();
        }
        else throw new Error(`unknown action '${r.action}'`);
      } catch (e) { ok = false; lines.push(`  ✗ ${t.title} instant ${r.instant}: ${(e as Error).message}`); break; }
      if (!got) { ok = false; lines.push(`  ✗ ${t.title} instant ${r.instant}: no instant produced`); break; }
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const frameOk = norm(got.frame) === norm(r.frame);
      const prefixed = rows.indexOf(r) < own;
      const effOk = prefixed || got.effects.join("; ") === r.effects.join("; ");
      if (prefixed && t.program) { continue; }                          // a variant with its own program: prefix rows only drive state
      if (frameOk && effOk) lines.push(`  ✓ ${t.title} instant ${r.instant}: ${norm(got.frame)}${got.effects.length ? "  [" + got.effects.join("; ") + "]" : ""}`);
      else { ok = false; lines.push(`  ✗ ${t.title} instant ${r.instant}: expected frame '${norm(r.frame)}' effects [${r.effects.join("; ")}], got '${norm(got.frame)}' effects [${got.effects.join("; ")}]`); }
    }
    if (pending.length) { ok = false; lines.push(`  ✗ ${t.title}: ${pending.length} unlisted chained instant(s): ${pending.map(p => p.frame).join(" | ")}`); }
  }
  for (const rj of sc.rejected) {
    if (rj.types) continue;                                              // TY: the type layer's, over the projection (types/run.ts)
    if (rj.warn) {
      try {
        const rt = new Runtime(moduleSet(sc, rj.program)); rt.step([]);
        const hit = rt.diagnostics.find(d => d.startsWith(rj.rule));
        if (hit) lines.push(`  ✓ warn(${rj.rule}): ${hit}`); else { ok = false; lines.push(`  ✗ warn(${rj.rule}): no diagnostic (got: ${rt.diagnostics.join(" | ") || "none"})`); }
      } catch (e) { ok = false; lines.push(`  ✗ warn(${rj.rule}): ${(e as Error).message}`); }
      continue;
    }
    try {
      const rt = new Runtime(moduleSet(sc, rj.program));
      rt.step([]);
      // handlers in rejected programs: run any `handler:` comment lines
      for (const m of rj.handlers) rt.handler(parseStmts(m));
      ok = false; lines.push(`  ✗ rejected(${rj.rule}): accepted`);
    } catch (e) {
      if (e instanceof CheckError) {                                     // the checker: any diagnostic may carry the expected rule id or code
        const hit = e.diagnostics.find(d => d.rule === rj.rule || d.code === rj.rule);
        if (hit) lines.push(`  ✓ rejected(${rj.rule}): ${hit.code} (${hit.rule}) line ${hit.line}: ${hit.msg}`);
        else { ok = false; lines.push(`  ✗ rejected(${rj.rule}): got ${e.diagnostics.map(d => `${d.code} (${d.rule})`).join(", ")}: ${e.message}`); }
        continue;
      }
      const rule = e instanceof RuleError ? e.rule : e instanceof ParseError ? (/([A-Z]+-\d+)/.exec(e.message)?.[1] ?? "parse") : "crash";
      if (rule === rj.rule || (e instanceof ParseError && e.code === rj.rule)) lines.push(`  ✓ rejected(${rj.rule}): ${(e as Error).message}`);
      else { ok = false; lines.push(`  ✗ rejected(${rj.rule}): got ${rule}: ${(e as Error).message}`); }
    }
  }
  return { ok, lines };
}
