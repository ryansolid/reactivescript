// Runs scenarios/*.md against the real Solid 2.0 runtime through the lowering in lower.ts.
// node --experimental-strip-types --conditions=browser --conditions=development ref/oracle/run.ts [filter]
import { SOLID } from "../solid-version.ts";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseScenario, moduleSet, type Scenario } from "../src/scenario.ts";
import { inferredAction } from "../src/infer.ts";
import { parseProgram, parseStmts } from "../src/parse.ts";
import { Oracle, flush, resetErrorHalt, Unsupported } from "./lower.ts";
const isUnsupported = (e: unknown) => (e as Error)?.name === "Unsupported" || (Unsupported.last !== "" && String((e as Error)?.message ?? e).includes(Unsupported.last));

process.on("unhandledRejection", () => {});   // a rejected flight nobody awaits (an `errored` scenario) is not a runner failure
const settle = async () => { await new Promise(r => setTimeout(r, 0)); flush(); await new Promise(r => setTimeout(r, 0)); flush(); };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

async function runTable(sc: Scenario, t: Scenario["tables"][number], base: Scenario["tables"][number] | undefined, lines: string[]): Promise<boolean> {
  let ok = true;
  const src = t.program ?? sc.program;
  let rows = t.rows; let own = 0;
  if (t !== base && base && rows.length && rows[0].instant > 0) { const pre = base.rows.filter(r => r.instant < rows[0].instant); own = pre.length; rows = [...pre, ...rows]; }
  // chains: a row followed by its `(effect)` and `(flush)` rows (EF-8) is one step here
  const chains: typeof rows[] = []; for (const r of rows) { if ((r.action === "(effect)" || r.action === "(flush)") && chains.length) chains[chains.length - 1].push(r); else chains.push([r]); }
  let o: Oracle;
  resetErrorHalt(); (await import("./lower.ts")).resetScopes(); Unsupported.last = "";
  const handlerStmts = rows.filter(r => r.action.startsWith("handler")).map(r => { try { return parseStmts(r.action.slice(7)); } catch { return []; } });
  try { o = new Oracle(moduleSet(sc, src), handlerStmts); } catch (e) { if (isUnsupported(e)) { lines.push(`  ~ ${t.title}: unsupported — ${(e as Error).message}`); return ok; } lines.push(`  ✗ ${t.title}: ${(e as Error).message}`); return false; }
  const scope = (o as any);
  try {
    for (const chain of chains) {
      const r = chain[0]; const last = chain[chain.length - 1];
      const logBefore = r.action === "mount" ? 0 : o.log.length;   // effects' first runs happen inside render()
      try {
        if (r.action === "mount") { flush(); await settle(); }
        else if (r.action.startsWith("handler")) { const body = parseStmts(r.action.slice(7)); const stmts = inferredAction(body) ? [{ k: "action" as const, body }] : body; o.runStmts(stmts, rootScope(o), new Map()); flush(); await settle(); }   // AC-1b: a handler row is a handler's body
        else if (/^(resolve|reject)\s/.test(r.action)) {
          const m = /^(resolve|reject)\s+(\S+)\s+([\s\S]*)$/.exec(r.action)!;
          const valueExpr = parseStmts(m[3])[0];
          const value = valueExpr.k === "expr" ? o.ev(valueExpr.e, rootScope(o)) : undefined;
          const key = /^".*"$/.test(m[2]) ? m[2].slice(1, -1) : o.lastKey.get(m[2]);
          if (key === undefined) throw new Error(`${m[2]} has no flight`);
          const f = o.flights.get(key); if (!f) throw new Error(`no flight ${key}`);
          if (m[1] === "reject") f.reject(value instanceof Error ? value : new Error(String(value))); else f.resolve(value);
          await settle();
        } else throw new Error(`unknown action '${r.action}'`);
      } catch (e) { if (isUnsupported(e)) { lines.push(`  ~ ${t.title} instant ${r.instant}: unsupported — ${(e as Error).message}`); return ok; } ok = false; lines.push(`  ✗ ${t.title} instant ${r.instant}: ${(e as Error).message}`); return ok; }
      if (o.asyncError) { const e = o.asyncError; o.asyncError = null; if (isUnsupported(e)) { lines.push(`  ~ ${t.title} instant ${r.instant}: unsupported — ${(e as Error).message}`); return ok; } if (!r.action.startsWith("reject") && !(e as { panic?: boolean }).panic) { ok = false; lines.push(`  ✗ ${t.title} instant ${r.instant}: action: ${(e as Error).message}`); return ok; } }
      const got = norm(o.frame()); const effects = o.log.slice(logBefore);
      const prefixed = rows.indexOf(r) < own;
      if (prefixed && t.program) continue;
      const div = sc.divergences.find(d => d.runner === "oracle" && d.table === t.title && d.instant === last.instant);
      const want = norm(div ? div.frame : last.frame); const wantEff = chain.flatMap(c => sc.divergences.find(d => d.runner === "oracle" && d.table === t.title && d.instant === c.instant && d.effects)?.effects ?? c.effects);   // a recorded divergence may name the effects Solid runs there
      const effOk = prefixed || effects.join("; ") === wantEff.join("; ");
      if (got === want && effOk) { if (div) divergent++; lines.push(`  ${div ? "≠" : "✓"} ${t.title} instant ${last.instant}: ${got}${effects.length ? "  [" + effects.join("; ") + "]" : ""}${div ? `   (spec: '${norm(last.frame)}')` : ""}`); }
      else { ok = false; lines.push(`  ✗ ${t.title} instant ${last.instant}: expected '${want}' effects [${wantEff.join("; ")}], got '${got}' effects [${effects.join("; ")}]`); }
    }
  } finally { try { o.dispose(); } catch {} resetErrorHalt(); }
  return ok;
}
function rootScope(o: Oracle) { return (o as any).rootScope; }

const filter = process.argv[2];
const dir = new URL("../../scenarios/", import.meta.url);
let pass = 0, fail = 0, skip = 0, divergent = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith(".md") && f !== "TEMPLATE.md" && !f.startsWith("OPEN-") && (!filter || f.includes(filter))).sort()) {
  const sc = parseScenario(f.replace(/\.md$/, ""), readFileSync(new URL(f, dir), "utf8"), fileURLToPath(dir));
  const lines: string[] = []; let ok = true;
  const base = sc.tables.find(t => t.title === "Frames");
  for (const t of sc.tables) ok = (await runTable(sc, t, base, lines)) && ok;
  const unsupported = lines.some(l => l.includes("~ ")) && !lines.some(l => l.includes("✗"));
  console.log(`${ok ? (unsupported ? "SKIP" : "PASS") : "FAIL"} ${sc.name}`); for (const l of lines) console.log(l);
  if (!ok) fail++; else if (unsupported) skip++; else pass++;
}
console.log(`\n${pass} pass, ${fail} fail, ${skip} skip; ${divergent} recorded divergence(s) (oracle: ${SOLID})`);
process.exit(fail ? 1 : 0);
