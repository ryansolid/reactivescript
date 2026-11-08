// Compiles every scenario's program to a JS module (ref/compile/emit.ts), imports it, and drives it through the
// scenario's rows against solid-js 2.0. The compiled program is Solid code, so it must show what the oracle shows —
// the spec's frames, or a recorded divergence.
// node --experimental-strip-types --conditions=browser --conditions=development ref/compile/run.ts [filter]
import { SOLID } from "../solid-version.ts";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseScenario, moduleSet, type Scenario } from "../src/scenario.ts";
import { parseProgram, parseStmts } from "../src/parse.ts";
import { checkModules } from "../src/check.ts";
import { compileDynamic, compileDynamicExpr, CompileError } from "./emit.ts";
import { createApp, flush } from "./rt.ts";
import { build } from "./lowered.ts";
import { resetErrorHalt } from "@solidjs/signals";

process.on("unhandledRejection", () => {});
const settle = async () => { await new Promise(r => setTimeout(r, 0)); flush(); await new Promise(r => setTimeout(r, 0)); flush(); };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const outDir = fileURLToPath(new URL("./.out/", import.meta.url)); mkdirSync(outDir, { recursive: true });
let seq = 0, divergent = 0;

async function runTable(sc: Scenario, t: Scenario["tables"][number], base: Scenario["tables"][number] | undefined, lines: string[]): Promise<boolean> {
  let ok = true;
  const src = t.program ?? sc.program;
  let rows = t.rows; let own = 0;
  if (t !== base && base && rows.length && rows[0].instant > 0) { const pre = base.rows.filter(r => r.instant < rows[0].instant); own = pre.length; rows = [...pre, ...rows]; }
  const chains: typeof rows[] = []; for (const r of rows) { if ((r.action === "(effect)" || r.action === "(flush)") && chains.length) chains[chains.length - 1].push(r); else chains.push([r]); }
  resetErrorHalt();
  let entry: string, views: Map<string, string>;
  try {
    const set = moduleSet(sc, src); if (checkModules(set).diags.length) { lines.push(`  ~ ${t.title}: refused by the checker`); return ok; }
    const out = build(sc, src, rows.filter(r => r.action.startsWith("handler")).map(r => r.action.slice(7))); entry = out.entry; views = out.views("universal");
  }
  catch (e) { if (e instanceof CompileError) { lines.push(`  ~ ${t.title}: not compiled — ${e.message}`); return ok; } lines.push(`  ✗ ${t.title}: ${(e as Error).message}`); return false; }
  const dir = `${outDir}${sc.name}.${++seq}/`; mkdirSync(dir, { recursive: true });
  const local = JSON.stringify(fileURLToPath(new URL("./server-functions-local.ts", import.meta.url)));
  for (const [name, js] of views) writeFileSync(dir + name, js.replaceAll('"@solidjs/web/server-functions"', local));   // SF-7b: no network here
  const file = dir + entry;
  const app = createApp();
  let dispose: () => void = () => {};
  try {
    const main = (await import(pathToFileURL(file).href)).default;
    dispose = app.mount(main(app));
    for (const chain of chains) {
      const r = chain[0]; const last = chain[chain.length - 1];
      const logBefore = r.action === "mount" ? 0 : app.log.length;
      try {
        if (r.action === "mount") { flush(); await settle(); }
        else if (r.action.startsWith("handler")) { const body = compileDynamic(parseStmts(r.action.slice(7))); new Function("__rt", "__B", body)(app, app.B); flush(); await settle(); }
        else if (/^(resolve|reject)\s/.test(r.action)) {
          const m = /^(resolve|reject)\s+(\S+)\s+([\s\S]*)$/.exec(r.action)!;
          const v = parseStmts(m[3])[0];
          const value = v.k === "expr" ? new Function("__rt", "__B", `return ${compileDynamicExpr(v.e)};`)(app, app.B) : undefined;
          const key = /^".*"$/.test(m[2]) ? m[2].slice(1, -1) : app.lastKey.get(m[2]);
          if (key === undefined) throw new Error(`${m[2]} has no flight`);
          const f = app.flights.get(key); if (!f) throw new Error(`no flight ${key}`);
          if (m[1] === "reject") f.reject(value instanceof Error ? value : new Error(String(value))); else f.resolve(value);
          await settle();
        } else throw new Error(`unknown action '${r.action}'`);
      } catch (e) { if (e instanceof CompileError) { lines.push(`  ~ ${t.title} instant ${r.instant}: not compiled — ${e.message}`); return ok; } ok = false; lines.push(`  ✗ ${t.title} instant ${r.instant}: ${(e as Error).message}`); return ok; }
      if (app.asyncError) { const e = app.asyncError; app.asyncError = null; if (!r.action.startsWith("reject") && !(e as { panic?: boolean }).panic) { ok = false; lines.push(`  ✗ ${t.title} instant ${r.instant}: action: ${(e as Error).message}`); return ok; } }
      const got = norm(app.frame()); const effects = app.log.slice(logBefore);
      const prefixed = rows.indexOf(r) < own;
      if (prefixed && t.program) continue;
      const div = sc.divergences.find(d => d.runner === "oracle" && d.table === t.title && d.instant === last.instant);
      const want = norm(div ? div.frame : last.frame); const wantEff = chain.flatMap(c => sc.divergences.find(d => d.runner === "oracle" && d.table === t.title && d.instant === c.instant && d.effects)?.effects ?? c.effects);   // a recorded divergence may name the effects Solid runs there
      const effOk = prefixed || effects.join("; ") === wantEff.join("; ");
      if (got === want && effOk) { if (div) divergent++; lines.push(`  ${div ? "≠" : "✓"} ${t.title} instant ${last.instant}: ${got}${effects.length ? "  [" + effects.join("; ") + "]" : ""}`); }
      else { ok = false; lines.push(`  ✗ ${t.title} instant ${last.instant}: expected '${want}' effects [${wantEff.join("; ")}], got '${got}' effects [${effects.join("; ")}]`); }
    }
  } catch (e) { ok = false; lines.push(`  ✗ ${t.title}: ${(e as Error).message}  (${file})`); }
  finally { try { dispose(); } catch {} resetErrorHalt(); }
  return ok;
}

const filter = process.argv[2];
const dir = new URL("../../scenarios/", import.meta.url);
let pass = 0, fail = 0, skip = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith(".md") && f !== "TEMPLATE.md" && !f.startsWith("OPEN-") && (!filter || f.includes(filter))).sort()) {
  const sc = parseScenario(f.replace(/\.md$/, ""), readFileSync(new URL(f, dir), "utf8"), fileURLToPath(dir));
  const lines: string[] = []; let ok = true;
  const base = sc.tables.find(t => t.title === "Frames");
  for (const t of sc.tables) ok = (await runTable(sc, t, base, lines)) && ok;
  if (sc.css !== null) {   // 07 §6b: the program's stylesheet, as TSRX's engine scoped it — hashes renamed h1, h2… in order of appearance
    try {
      const hashes: string[] = []; const css = build(sc, sc.program, []).css.replace(/tsrx-[0-9a-f]{8}/g, h => `h${(hashes.includes(h) ? hashes.indexOf(h) : hashes.push(h) - 1) + 1}`);
      if (norm(css) === norm(sc.css)) lines.push(`  ✓ Scoped CSS: ${norm(css)}`); else { ok = false; lines.push(`  ✗ Scoped CSS: expected '${norm(sc.css)}', got '${norm(css)}'`); }
    } catch (e) { ok = false; lines.push(`  ✗ Scoped CSS: ${(e as Error).message}`); }
  }
  const skipped = lines.some(l => l.includes("~ ")) && !lines.some(l => l.includes("✗"));
  console.log(`${ok ? (skipped ? "SKIP" : "PASS") : "FAIL"} ${sc.name}`); for (const l of lines) console.log(l);
  if (!ok) fail++; else if (skipped) skip++; else pass++;
}
console.log(`\n${pass} pass, ${fail} fail, ${skip} skip; ${divergent} recorded divergence(s) (compiled → ${SOLID})`);
process.exit(fail ? 1 : 0);
