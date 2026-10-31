// One-off migration aid (upstream MO-1c): finds string/template literals in test files that are RX programs with
// top-level markup and proposes the current spelling: the same declarations, with the view wrapped in
// `export default component App() { … }`. Prints a JSON list of insertions; they are reviewed and applied by patch.
// Candidates are literals in RX positions only: values of "*.rx" file keys, direct parseProgram(...) arguments, and
// initializers of consts named rx/source/main. Each is parsed in a worker with a timeout, because upstream
// parseProgram does not terminate on some inputs (docs/UPSTREAM-ISSUES.md); those are reported as skipped.
// Usage: node --experimental-strip-types scripts/find-legacy-rx-views.ts tsx/a.test.ts ...
import { readFileSync } from "node:fs";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { parseSync } from "oxc-parser/src-js/index";
import { parseProgram, viewStart } from "../tsx/rx/compiler.ts";

if (!isMainThread) {
  parentPort!.on("message", (text: string) => {
    let legacy = false, at = -1;
    try { legacy = !!parseProgram(text).legacyView; if (legacy) at = viewStart(text); } catch { legacy = false; }
    parentPort!.postMessage({ legacy, at });
  });
} else {
  type Piece = { start: number; raw: string; cooked: string };
  type Candidate = { file: string; line: number; pieces: Piece[]; joined: string };
  const PH = "__tsx_placeholder";
  const positions = new WeakSet<object>();
  const mark = (v: unknown) => { if (v && typeof v === "object") positions.add(v); };
  const candidates: Candidate[] = [];
  for (const file of process.argv.slice(2)) {
    const source = readFileSync(file, "utf8");
    const ast = parseSync(file, source, { sourceType: "module", lang: "ts" }).program;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      const n = node as { type?: string; start: number; end: number; value?: unknown; quasis?: { start: number; end: number; value: { raw: string; cooked: string } }[] };
      const any = node as Record<string, any>;
      if (any.type === "Property" && any.key?.type === "Literal" && typeof any.key.value === "string" && any.key.value.endsWith(".rx")) mark(any.value);
      if (any.type === "CallExpression" && any.callee?.type === "Identifier" && any.callee.name === "parseProgram") mark(any.arguments?.[0]);
      if (any.type === "VariableDeclarator" && any.id?.type === "Identifier" && ["rx", "main"].includes(any.id.name)) mark(any.init);
      let pieces: Piece[] | undefined;
      if (n.type === "Literal" && typeof n.value === "string") pieces = [{ start: n.start + 1, raw: source.slice(n.start + 1, n.end - 1), cooked: n.value }];
      if (n.type === "TemplateLiteral" && n.quasis) pieces = n.quasis.map(q => ({ start: q.start, raw: q.value.raw, cooked: q.value.cooked }));
      if (pieces) {
        const joined = pieces.map(p => p.cooked).join(PH);
        if (positions.has(node as object) && joined.includes("<")) candidates.push({ file, line: source.slice(0, n.start).split("\n").length, pieces, joined });
      }
      for (const value of Object.values(node)) if (value && typeof value === "object") visit(value);
    };
    visit(ast);
  }
  // RX-position literals are whole programs; run under an outer time guard (perl alarm) in case one still hangs.
  const ask = (text: string): { legacy: boolean; at: number } | "timeout" => {
    if (process.env.TRACE) process.stderr.write(JSON.stringify(text.slice(0, 100)) + "\n");
    try { const p = parseProgram(text); return { legacy: !!p.legacyView, at: p.legacyView ? viewStart(text) : -1 }; } catch { return { legacy: false, at: -1 }; }
  };
  const inserts: { file: string; at: number; text: string }[] = [];
  const skipped: { file: string; line: number; why: string }[] = [];
  for (const c of candidates) {
    const answer = ask(c.joined);
    if (answer === "timeout") { skipped.push({ file: c.file, line: c.line, why: "upstream parseProgram did not terminate" }); continue; }
    if (!answer.legacy) continue;
    const locate = (offset: number): number | undefined => {
      let base = 0;
      for (const p of c.pieces) {
        if (offset <= base + p.cooked.length) return p.raw === p.cooked ? p.start + offset - base : undefined;
        base += p.cooked.length + PH.length;
      }
    };
    const a = locate(answer.at), b = locate(c.joined.trimEnd().length);
    if (a === undefined || b === undefined) skipped.push({ file: c.file, line: c.line, why: "escapes or expression at the view boundary" });
    else inserts.push({ file: c.file, at: a, text: "export default component App() { " }, { file: c.file, at: b, text: " }" });
  }
  console.log(JSON.stringify({ candidates: candidates.length, inserts, skipped }));
}
