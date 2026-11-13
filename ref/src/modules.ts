// 09-modules: a program is a set of `.rx` modules. The loader resolves each `.rx` import to a path, parses every module once,
// and orders them dependencies first (MO-1). A cycle is refused (MO-5): signatures are computed in that order.
import { parseProgram, parseDeclarations, ParseError, type JsDecl } from "./parse.ts";
import type { Program } from "./ast.ts";
import type { Diagnostic } from "./errors.ts";
import type { ModSig } from "./check.ts";
import { parseSignature, SignatureError } from "./signature.ts";

export type ModuleSet = { entry: string; programs: Map<string, Program>; order: string[]; diags: Diagnostic[]; declarations?: Map<string, JsDecl[]>; signatures?: Map<string, ModSig> };   // declarations: MO-8, by `.d.rx` path; signatures: MO-9, by `.rx` path

export const isRx = (from: string) => /\.rx$/.test(from);

/** POSIX-style join and normalisation, for module keys (no file system involved). */
export function joinPath(fromFile: string, rel: string): string {
  const base = fromFile.split("/").slice(0, -1);
  const parts = rel.startsWith("/") ? [] : base;
  for (const seg of rel.split("/")) { if (seg === "" || seg === ".") continue; if (seg === "..") { if (parts.length && parts[parts.length - 1] !== "..") parts.pop(); else parts.push(".."); } else parts.push(seg); }
  return (rel.startsWith("/") ? "/" : "") + parts.join("/");
}

/** MO-10c: the file a package import resolves to, as a bundler finds it — `node_modules` up from the importer, the package's
 *  `exports` (a subpath, then the first of its conditions that a Solid build sets, in the package's order; `*` patterns),
 *  else `module` or `main`. Its declaration is beside it: the same name, `.d.rx`. */
const CONDITIONS = new Set(["solid", "browser", "import", "default"]);
export function packageDeclaration(fromFile: string, spec: string, read: (path: string) => string | undefined): string | undefined {
  const seg = spec.split("/"); const n = spec.startsWith("@") ? 2 : 1; if (seg.length < n || seg.slice(0, n).some(x => !x)) return undefined;
  const pkg = seg.slice(0, n).join("/"); const sub = seg.length > n ? "./" + seg.slice(n).join("/") : ".";
  const dirs = fromFile.split("/").slice(0, -1);
  for (let i = dirs.length; i >= (fromFile.startsWith("/") ? 1 : 0); i--) {
    const root = [...dirs.slice(0, i), "node_modules", pkg].join("/"); const pj = read(root + "/package.json"); if (pj === undefined) continue;
    let json: any; try { json = JSON.parse(pj); } catch { return undefined; }
    const pick = (t: unknown): string | undefined => {
      if (typeof t === "string") return t;
      if (Array.isArray(t)) { for (const x of t) { const r = pick(x); if (r) return r; } return undefined; }
      if (t && typeof t === "object") { for (const [k, v] of Object.entries(t)) if (CONDITIONS.has(k)) { const r = pick(v); if (r) return r; } }
      return undefined;
    };
    let target: string | undefined;
    const ex = json.exports;
    if (ex !== undefined) {
      const map: Record<string, unknown> | null = typeof ex === "object" && ex && !Array.isArray(ex) && Object.keys(ex).some(k => k.startsWith(".")) ? ex : null;
      if (!map) target = sub === "." ? pick(ex) : undefined;
      else if (sub in map) target = pick(map[sub]);
      else for (const [k, v] of Object.entries(map)) { const star = k.indexOf("*"); if (star < 0) continue; const pre = k.slice(0, star), post = k.slice(star + 1); if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) { const t = pick(v); if (t) target = t.split("*").join(sub.slice(pre.length, sub.length - post.length)); break; } }
    } else target = sub === "." ? (typeof json.module === "string" ? json.module : typeof json.main === "string" ? json.main : "./index.js") : sub;
    if (!target) return undefined;
    return joinPath(root + "/package.json", target).replace(/\.(m?js|cjs|jsx|ts|tsx)$/, "") + ".d.rx";
  }
  return undefined;
}

/** Load `entry` and everything it imports from `.rx`. `read` returns a module's source, or undefined when there is none. */
export function loadModules(entry: string, read: (path: string) => string | undefined): ModuleSet {
  const programs = new Map<string, Program>(); const order: string[] = []; const diags: Diagnostic[] = []; const declarations = new Map<string, JsDecl[]>(); const signatures = new Map<string, ModSig>();
  const state = new Map<string, "busy" | "done">();
  const visit = (path: string, stack: string[]) => {
    if (state.get(path) === "done") return;
    const src = read(path);
    if (src === undefined) return;                                    // reported at the import that names it
    let p: Program;
    try { p = parseProgram(src); } catch (e) { if (e instanceof ParseError) throw Object.assign(new ParseError(`${path}: ${e.message}`), { code: e.code }); throw e; }
    programs.set(path, p); state.set(path, "busy");
    for (const d of p.decls) {
      const pkgDts = d.k === "import" && !isRx(d.from) && !d.from.startsWith(".") && !d.from.startsWith("/") ? packageDeclaration(path, d.from, read) : undefined;   // MO-10c
      if (d.k === "import" && !isRx(d.from) && (d.from.startsWith(".") || pkgDts)) {             // MO-8: a JS module with a declaration file beside it
        const dts = pkgDts ?? joinPath(path, d.from.replace(/\.(m?js|ts)$/, "") + ".d.rx");
        if (!declarations.has(dts)) { const src = read(dts); if (src !== undefined) { try { declarations.set(dts, parseDeclarations(src)); } catch (e) { if (e instanceof ParseError) throw Object.assign(new ParseError(`${dts}: ${e.message}`), { code: e.code }); throw e; } } }
        const ds = declarations.get(dts);
        if (ds) { d.declared = dts; d.declaredErrors = ds.filter(x => x.kind === "error").map(x => x.name); d.declaredPure = ds.filter(x => x.kind === "fn" && x.pure).map(x => x.name); d.declaredSide = Object.fromEntries(ds.flatMap(x => x.kind === "fn" && x.side ? [[x.name, x.side]] : [])); }
        continue;
      }
      if (d.k !== "import" || !isRx(d.from)) continue;
      const to = joinPath(path, d.from); d.resolved = to;
      if (state.get(to) === "busy") { diags.push({ code: "MODULE_CYCLE", rule: "MO-5", line: d.line, file: path, msg: `${[...stack, path].slice(stack.indexOf(to) >= 0 ? stack.indexOf(to) : 0).concat(to).join(" → ")}: modules may not import each other in a cycle (signatures are computed dependencies first)` }); continue; }
      if (state.get(to) !== "done" && !signatures.has(to) && read(to) === undefined) {   // MO-9: no body — its signature, read in place
        const sig = read(to.replace(/\.rx$/, ".d.rx"));
        if (sig !== undefined) { try { signatures.set(to, parseSignature(sig, to)); } catch (e) { if (e instanceof SignatureError) throw new ParseError(e.message); throw e; } continue; }
      }
      if (signatures.has(to)) continue;
      if (state.get(to) !== "done" && read(to) === undefined) { diags.push({ code: "MODULE_NOT_FOUND", rule: "MO-6", line: d.line, file: path, msg: `no module ${d.from} (from ${path})` }); continue; }
      visit(to, [...stack, path]);
    }
    state.set(path, "done"); order.push(path);
  };
  visit(entry, []);
  return { entry, programs, order, diags, declarations, signatures };
}

/** One program with no `.rx` imports — the common case, and every scenario before 09. */
export function singleModule(p: Program, entry = "main.rx"): ModuleSet { return { entry, programs: new Map([[entry, p]]), order: [entry], diags: [] }; }
