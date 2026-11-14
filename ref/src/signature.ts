// MO-3 / MO-9: a module's signature as `.d.rx` text, and that text read back. A signature is what an importer is checked
// against (CN-4b), so the text is the whole of it: an importer checked against a printed `.d.rx` gets the verdicts it gets
// against the module's body (`ref/run.ts` checks this for every scenario with modules). One export per line:
//
//   export source products: pending fails(Error) = …        a question (ST-5); `:= …` a plain source
//   export discount: pending fails(Error)                   an equation; `io` when bound to an io value
//   export pure fn qtyOf(id) rejects(Offline) instantiates  a fn (`ref` params; RG-6); `rejects(…)` absent: none
//   export server fn add(id) rejects(Error)                 12 SF-1 (`server pure fn` when no io)
//   export action setCoupon
//   export error NotFound(id)
//   export type Product
//   export context theme: source pending Theme = …          rows, then the written type; `= …` a default
//   export component Panel(props: { title; children: catches(Error) provides(./theme.rx#theme) }) fails(Error) uses(./theme.rx#theme, loading) shape(roots section; children-at section)
//
// A prop field: bare (rendered, discharges nothing), `catches(A | B)` / `catches(*)`, `provides(…)` (children), `unrendered`
// (only an action reads it), `action save catches(…)` (an action reads it). `uses(loading)` is SV-7b's need for a `loading`
// above a reader of a client question. `retains(onPick: module, onFocus: ./form.rx#fields)` names the props the component
// stores where they outlive it (O-3) — in its module's sources, or through a provision above it — so a closure passed for one
// is checked at the application. Context keys are paths relative to the signature's own module.
import type { ModSig, ExportSig, CompSig } from "./check.ts";
import { EMPTY_SHAPE, type Shape } from "./content.ts";

type Catch = Set<string> | "all";
const HOLD = "$hold";
const cls = (c: Catch) => c === "all" ? "*" : c.size ? [...c].sort().join(" | ") : "nothing";
const rows = (r: string[], fails: string[]) => [...["io", "pending", "lane"].filter(x => r.includes(x)), ...(fails.length ? [`fails(${[...fails].sort().join(" | ")})`] : [])].join(" ");
const dir = (p: string) => p.split("/").slice(0, -1).join("/");
/** O-3: the props a component stores where they outlive it, and where. */
const retainsText = (file: string, st?: Record<string, string[]>) => {
  const xs = Object.entries(st ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([f, ts]) => ts.map(t => `${f === "*" ? "...props" : f}: ${t === "module" ? t : relKey(file, t)}`));
  return xs.length ? ` retains(${xs.join(", ")})` : "";
};
/** A context key relative to the module whose signature names it (`./theme.rx#theme`). */
function relKey(from: string, key: string): string {
  if (key === HOLD) return "loading";
  const [path, name] = [key.slice(0, key.lastIndexOf("#")), key.slice(key.lastIndexOf("#") + 1)];
  const a = dir(from).split("/").filter(Boolean), b = path.split("/").filter(Boolean); let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i; const rel = (up ? "../".repeat(up) : "./") + b.slice(i).join("/");
  return `${path.startsWith("/") === from.startsWith("/") ? rel : path}#${name}`;
}
function absKey(from: string, rel: string): string {
  if (rel === "loading") return HOLD;
  const [path, name] = [rel.slice(0, rel.lastIndexOf("#")), rel.slice(rel.lastIndexOf("#") + 1)];
  if (!path.startsWith(".")) return rel;
  const parts = dir(from).split("/"); const lead = from.startsWith("/") ? "/" : "";
  const out = parts.filter(Boolean);
  for (const seg of path.split("/")) { if (seg === "." || seg === "") continue; if (seg === "..") out.pop(); else out.push(seg); }
  return `${lead}${out.join("/")}#${name}`;
}
function shapeText(s: Shape | undefined): string {
  if (!s) return "";
  const parts = [...(s.roots.length ? [`roots ${s.roots.join(" ")}`] : []), ...(s.closesP ? ["closes-p"] : []), ...(s.a ? ["a"] : []), ...(s.form ? ["form"] : []), ...s.childrenAt.map(c => `children-at ${c.join(" ")}`)];
  return parts.length ? ` shape(${parts.join("; ")})` : "";
}

function line(file: string, name: string, x: ExportSig): string {
  switch (x.kind) {
    case "source": { const r = rows(x.rows, x.fails); return `export source ${name}${r ? `: ${r}` : ""} ${x.question ? "=" : ":="} …`; }
    case "eq": { const r = rows(x.io ? ["io", ...x.rows] : x.rows, x.fails); return `export ${name}${r ? `: ${r}` : ""}`; }
    case "fn": { const r = rows(x.rows, x.fails); return `export pure fn ${name}(${x.params.map(p => (p.ref ? "ref " : "") + p.name + ((p as { type?: string }).type ? `: ${(p as { type?: string }).type}` : "")).join(", ")})${r ? `: ${r}` : ""}${x.rejects.length ? ` rejects(${x.rejects.join(" | ")})` : ""}${x.instantiating ? " instantiates" : ""}`; }
    case "server": return `export server ${x.io ? "" : "pure "}fn ${name}(${x.params.join(", ")})${x.rejects.length ? ` rejects(${[...x.rejects].sort().join(" | ")})` : ""}`;
    case "action": return `export action ${name}`;
    case "errclass": return `export error ${name}(${x.params.join(", ")})`;
    case "type": return `export type ${name}`;
    case "context": { const t = [x.source ? "source" : "", rows(x.rows, x.fails), x.type ?? ""].filter(Boolean).join(" "); return `export context ${name}${t ? `: ${t}` : ""}${x.dflt ? " = …" : ""}`; }
    case "comp": {
      const s = x.sig;
      const props = Object.entries(s.props).map(([f, v]) => {
        const parts: string[] = [];
        if (!v.rendered) parts.push("unrendered");
        else {
          if (!(v.f instanceof Set && v.f.size === 0)) parts.push(`catches(${cls(v.f)})`);
          if (!(v.p instanceof Set && v.p.size === 0)) parts.push(`provides(${v.p === "all" ? "*" : [...v.p].map(k => relKey(file, k)).join(", ")})`);
        }
        if (v.action) parts.push(`action ${v.action.name} catches(${cls(v.action.f)})`);
        return `${f === "*" ? "...props" : f}${parts.length ? `: ${parts.join(" ")}` : ""}`;
      });
      const own = [...new Set(s.own.map(o => o.cls))];
      return `export component ${name}(props: ${props.length ? `{ ${props.join("; ")} }` : "{}"})${own.length ? ` fails(${own.sort().join(" | ")})` : ""}${s.requires.length ? ` uses(${s.requires.map(k => relKey(file, k)).join(", ")})` : ""}${retainsText(file, s.stored)}${shapeText(s.shape)}`;
    }
  }
}

export function printSignature(sig: ModSig): string {
  const out = [`// ${sig.file.split("/").pop()} — signature (09-modules MO-3). Sources are read-only to importers (MO-2).`];
  for (const [n, x] of sig.exports) out.push(line(sig.file, n, x));
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- reading it back (MO-9)
export class SignatureError extends Error { name = "SignatureError"; }
const ROW = /^(io|pending|lane|fails\(([^)]*)\))$/;
const classesOf = (s: string): string[] => s.split("|").map(x => x.trim()).filter(x => x && x !== "nothing");
const catchOf = (s: string): Catch => s.trim() === "*" ? "all" : new Set(classesOf(s));
/** Split on `sep` outside parentheses and braces. */
function split(s: string, sep: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const ch of s) { if ("({[<".includes(ch)) depth++; if (")}]>".includes(ch)) depth--; if (ch === sep && depth === 0) { out.push(cur); cur = ""; } else cur += ch; }
  if (cur.trim()) out.push(cur); return out.map(x => x.trim()).filter(Boolean);
}
/** Leading row words; the rest of the text (a context's type). */
function rowWords(s: string): { rows: string[]; fails: string[]; rest: string } {
  const words = split(s, " "); const rows: string[] = []; let fails: string[] = []; let i = 0;
  for (; i < words.length; i++) { const m = ROW.exec(words[i]); if (!m) break; if (m[2] !== undefined) fails = classesOf(m[2]); else rows.push(m[1]); }
  return { rows, fails, rest: words.slice(i).join(" ") };
}
/** SV-7d's words, `roots p div; closes-p; children-at div` (MO-9b; a JS component's, MO-11a). */
export function contentShapeOf(s: string | undefined): Shape {
  if (!s) return { ...EMPTY_SHAPE, roots: [], childrenAt: [] };
  const sh: Shape = { roots: [], closesP: false, a: false, form: false, childrenAt: [] };
  for (const p of s.split(";").map(x => x.trim()).filter(Boolean)) {
    const [w, ...rest] = p.split(/\s+/);
    if (w === "roots") sh.roots = rest; else if (w === "closes-p") sh.closesP = true; else if (w === "a") sh.a = true; else if (w === "form") sh.form = true;
    else if (w === "children-at") sh.childrenAt.push(rest); else throw new SignatureError(`shape: ${p}`);
  }
  return sh;
}

/** A `.d.rx` printed for (or written as) an `.rx` module's signature, read in place of the module. `file` is the `.rx`
 *  module's path: context keys are its, and relative keys resolve against it. */
export function parseSignature(src: string, file: string): ModSig {
  const exports = new Map<string, ExportSig>();
  src.split("\n").forEach((raw, i) => {
    const t = raw.replace(/\s\/\/.*$/, "").replace(/^\/\/.*$/, "").trim(); if (!t) return;
    const fail = (msg: string): never => { throw new SignatureError(`${file.replace(/\.rx$/, ".d.rx")}:${i + 1}: ${msg}: ${t}`); };
    let m: RegExpExecArray | null;
    if (!t.startsWith("export ")) fail("a signature declares exports");
    const s = t.slice(7).trim();
    if ((m = /^type\s+([A-Za-z_$][\w$]*)/.exec(s))) { exports.set(m[1], { kind: "type" }); return; }
    if ((m = /^action\s+([A-Za-z_$][\w$]*)$/.exec(s))) { exports.set(m[1], { kind: "action" }); return; }
    if ((m = /^error\s+([A-Za-z_$][\w$]*)\s*(?:\(([^)]*)\))?$/.exec(s))) { exports.set(m[1], { kind: "errclass", params: (m[2] ?? "").split(",").map(x => x.trim()).filter(Boolean) }); return; }
    if ((m = /^source\s+([A-Za-z_$][\w$]*)\s*(?::(?!=)\s*(.*?))?\s*(:?=)\s*…$/.exec(s))) { const r = rowWords(m[2] ?? ""); if (r.rest) fail("a source's rows"); exports.set(m[1], { kind: "source", question: m[3] === "=", rows: r.rows, fails: r.fails }); return; }
    if ((m = /^server\s+(pure\s+)?fn\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:rejects\(([^)]*)\))?$/.exec(s))) { exports.set(m[2], { kind: "server", io: !m[1], params: m[3].split(",").map(x => x.trim()).filter(Boolean), rejects: classesOf(m[4] ?? "") }); return; }
    if ((m = /^pure\s+fn\s+([A-Za-z_$][\w$]*)\s*\((.*?)\)\s*(?::\s*((?:(?:io|pending|lane|fails\([^)]*\))\s*)*))?\s*(?:rejects\(([^)]*)\))?\s*(instantiates)?$/.exec(s))) {
      const params = split(m[2], ",").map(p0 => { const ref = /^ref\s/.test(p0); const p = ref ? p0.slice(4).trim() : p0; const c = p.indexOf(":"); return { name: (c < 0 ? p : p.slice(0, c)).trim(), ref, ...(c < 0 ? {} : { type: p.slice(c + 1).trim() }) }; });
      const r = rowWords(m[3] ?? ""); if (r.rest) fail("a fn's rows");
      exports.set(m[1], { kind: "fn", params, instantiating: !!m[5], rows: r.rows, fails: r.fails, rejects: classesOf(m[4] ?? "") }); return;
    }
    if ((m = /^context\s+([A-Za-z_$][\w$]*)\s*(?::\s*(.*?))?\s*(=\s*…)?$/.exec(s))) {
      let body = (m[2] ?? "").trim(); const source = /^source\b/.test(body); if (source) body = body.slice(6).trim();
      const r = rowWords(body);
      exports.set(m[1], { kind: "context", key: `${file}#${m[1]}`, source, dflt: !!m[3], rows: r.rows, fails: r.fails, ...(r.rest ? { type: r.rest } : {}) }); return;
    }
    if ((m = /^component\s+([A-Za-z_$][\w$]*)\s*\(props:\s*(\{.*?\}|\{\})\)(.*)$/.exec(s))) {
      const sig: CompSig = { own: [], requires: [], props: {}, shape: undefined };
      for (const f of split(m[2].slice(1, -1), ";")) {
        const [fname0, spec = ""] = f.includes(":") ? [f.slice(0, f.indexOf(":")).trim(), f.slice(f.indexOf(":") + 1).trim()] : [f.trim(), ""];
        const fname = fname0 === "...props" ? "*" : fname0;
        const v: CompSig["props"][string] = { f: new Set(), p: new Set(), rendered: true };
        const a = /\baction\s+([A-Za-z_$][\w$]*)\s+catches\(([^)]*)\)/.exec(spec); if (a) v.action = { f: catchOf(a[2]), name: a[1] };
        const rest = a ? spec.replace(a[0], "") : spec;
        if (/\bunrendered\b/.test(rest)) { v.rendered = false; v.f = "all"; v.p = "all"; }
        const c = /\bcatches\(([^)]*)\)/.exec(rest); if (c) v.f = catchOf(c[1]);
        const p = /\bprovides\(([^)]*)\)/.exec(rest); if (p) v.p = p[1].trim() === "*" ? "all" : new Set(p[1].split(",").map(k => absKey(file, k.trim())).filter(Boolean));
        sig.props[fname] = v;
      }
      const tail = m[3];
      const fl = /\bfails\(([^)]*)\)/.exec(tail); if (fl) sig.own = classesOf(fl[1]).map(c => ({ cls: c, what: `${m![1]}'s root`, at: file.split("/").pop() }));
      const us = /\buses\(([^)]*)\)/.exec(tail); if (us) sig.requires = us[1].split(",").map(k => absKey(file, k.trim()));
      const so = /\bretains\(([^)]*)\)/.exec(tail); if (so) { sig.stored = {}; for (const x of split(so[1], ",")) { const i = x.indexOf(":"); const f0 = x.slice(0, i).trim(); const f = f0 === "...props" ? "*" : f0; const t = x.slice(i + 1).trim(); (sig.stored[f] ??= []).push(t === "module" ? t : absKey(file, t)); } }   // O-3
      sig.shape = contentShapeOf(/\bshape\(([^)]*)\)/.exec(tail)?.[1]);
      exports.set(m[1], { kind: "comp", sig }); return;
    }
    if ((m = /^([A-Za-z_$][\w$]*)\s*(?::\s*(.*))?$/.exec(s))) { const r = rowWords(m[2] ?? ""); if (r.rest) fail("an equation's rows"); exports.set(m[1], { kind: "eq", rows: r.rows.filter(x => x !== "io"), fails: r.fails, io: r.rows.includes("io") }); return; }
    fail("not an export");
  });
  return { file, exports };
}
