// The code generator: a checked Program → an ES module per .rx module: the reactive lowering as __rt calls, the views as
// JSX, which Solid's own compiler then lowers for the target (compile/jsx.ts).
// Lexical scopes become JS scopes: every region is a JS function, every declaration a `const`. Names are mangled
// (`v$x` the value or accessor, `w$x` a source's writer, `p$x` a companion `pre` memo). The decisions are the
// oracle's (ref/oracle/lower.ts); this file only makes them at compile time.
import type { Decl, Expr, Markup, Program, Stmt } from "../src/ast.ts";
import { singleModule, type ModuleSet } from "../src/modules.ts";
import { nonTailAwaits, viewReaders } from "../src/awaits.ts";
import { inferredAction } from "../src/infer.ts";
import { transform } from "@solidjs/compiler";
import { unwrapServer } from "../src/check.ts";
import { isPrims } from "../src/prims.ts";
import type { Shape } from "../src/parse.ts";

export class CompileError extends Error { name = "CompileError"; }
type FnDecl = Extract<Decl, { k: "fn" }>;
type Kind = "acc" | "src" | "val" | "fn" | "ifn" | "jfn" | "act" | "comp";
type Bind = { kind: Kind; js: string; w?: string; fn?: FnDecl; prev?: string; client?: boolean; refs?: boolean[]; shape?: Shape; inst?: string };   // MO-10: jfn, a declared JS primitive (refs, shape); inst: an instance's raw result   // client: `client` JS (12 SF-5b)

class Env {
  vars = new Map<string, Bind>(); parent: Env | null;
  constructor(parent: Env | null) { this.parent = parent; }
  lookup(n: string): Bind | undefined { return this.vars.get(n) ?? this.parent?.lookup(n); }
  /** The declaring frame of `n` (for companion `pre` memos). */
  frame(n: string): Env | undefined { return this.vars.has(n) ? this : this.parent?.frame(n); }
}
type Ctx = { imp: boolean; gen?: boolean; async?: boolean; tail?: boolean; self?: string; effect?: boolean; dyn?: boolean };

const BUILTINS = new Set(["len", "str", "map", "filter", "sum", "fail", "fetch", "every", "indexOf"]);
const isHandler = (a: string) => /^on[A-Z:]/.test(a);
const J = (v: unknown) => v === undefined ? "undefined" : JSON.stringify(v);
const mg = (n: string) => `v$${n}`;
const cm = (n: string) => `V$${n}`;   // a component: an uppercase JSX tag
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

// ---------------------------------------------------------------- usage analysis (the oracle's walkers, at compile time)
type Usage = { optimistic: Set<string>; paths: Set<string>; prevOf: Set<string> };
function usage(p: Program | Program[], extra: Stmt[][] = []): Usage {
  const u: Usage = { optimistic: new Set(), paths: new Set(), prevOf: new Set() };
  const seen = new WeakSet<object>();
  const walk = (x: unknown, selfName?: string): void => {
    if (!x || typeof x !== "object" || seen.has(x as object)) return; seen.add(x as object);
    if (Array.isArray(x)) { x.forEach(y => walk(y, selfName)); return; }
    const o = x as Record<string, any>;
    if (o.k === "optimistic") u.optimistic.add(o.target.name);
    if ((o.k === "write" || o.k === "optimistic") && o.target.path.length) u.paths.add(o.target.name);
    if (o.k === "pending" && (o.e.k === "member" || o.e.k === "index")) { let y = o.e; while (y.k === "member" || y.k === "index") y = y.o; if (y.k === "id") u.paths.add(y.name); }
    if (o.k === "pre" && o.name !== selfName) u.prevOf.add(o.name);
    const nextSelf = (o.k === "eq" || o.k === "source") ? o.name : selfName;
    for (const v of Object.values(o)) walk(v, nextSelf);
  };
  walk(p); walk(extra);
  return u;
}
/** Free names of an expression, for ordering declarations (JS consts have a temporal dead zone; memos compute eagerly). */
function deps(e: unknown, self: string, out = new Set<string>()): Set<string> {
  if (!e || typeof e !== "object") return out;
  if (Array.isArray(e)) { e.forEach(x => deps(x, self, out)); return out; }
  const o = e as Record<string, any>;
  if (o.k === "id") out.add(o.name);
  if (o.k === "pre" && o.name !== self) out.add(o.name);
  if (o.k === "write" || o.k === "optimistic") out.add(o.target.name);
  for (const [k, v] of Object.entries(o)) if (k !== "k") deps(v, self, out);
  return out;
}

// ---------------------------------------------------------------- the module
export function compile(p: Program, opts: { extraStmts?: Stmt[][] } = {}): string { return compileModules(singleModule(p), opts).files.get("main.mjs")!; }

/** 09 MO-1: one ES module per `.rx` module. A dependency's module is a factory over the app (`__rt.module` runs it once per app,
 *  the first time an importer instantiates — inside the mounted root, so its state is owned there); the entry's is `main`. */
export function compileModules(set: ModuleSet, opts: { extraStmts?: Stmt[][] } = {}): { files: Map<string, string>; entry: string; css: string } {
  // MO-9: a module known by its signature is compiled on its own; its module is beside it, `x.rx` → `x.mjs`
  const out = (path: string) => path === set.entry ? "main.mjs" : set.order.includes(path) ? `m${set.order.indexOf(path)}.mjs` : `${path.split("/").pop()!.replace(/\.rx$/, "")}.mjs`;
  const g = new Gen(usage([...set.programs.values()], opts.extraStmts), { set, out });
  const files = new Map<string, string>();
  for (const path of set.order) {
    const p = set.programs.get(path)!; g.beginModule(path, p.decls);
    const deps = [...new Set(p.decls.flatMap(d => d.k === "import" && d.resolved ? [d.resolved] : []))];
    const head = `// compiled by ReactiveScript ref/compile from ${path.split("/").pop()} — do not edit\n${deps.map(d => `import ${g.depVar(d)} from "./${out(d)}";`).join("\n")}${deps.length ? "\n" : ""}`;
    if (path === set.entry) { const body = g.block(p.decls, p.view, new Env(null), 2, undefined, true); files.set(out(path), `${head}${g.top.join("\n")}${g.top.length ? "\n" : ""}export default function main(__rt) {\n  const __B = __rt.B;\n  return () => {\n${body}\n  };\n}\n`); }
    else {
      const exported = p.decls.filter(d => (d as { exported?: boolean }).exported && "name" in d && d.k !== "typedecl").map(d => (d as { name: string }).name);
      const isComp = (n: string) => p.decls.some(d => d.k === "component" && d.name === n);
      const body = g.block(p.decls, [], new Env(null), 1, `{ ${exported.map(n => `${J(n)}: ${isComp(n) ? cm(n) : mg(n)}`).join(", ")} }`);
      files.set(out(path), `${head}${g.top.join("\n")}${g.top.length ? "\n" : ""}export default function module(__rt) {\n  const __B = __rt.B;\n${body}\n}\n`);
    }
  }
  return { files, entry: out(set.entry), css: g.css.join("\n") };   // CSS-4: the modules' stylesheets, beside their JavaScript
}
/** Handler rows and resolve values in scenarios: statements over names looked up at run time (rt.lookup). */
export function compileDynamic(stmts: Stmt[]): string { const g = new Gen(usage({ decls: [], view: [] }, [stmts])); const env = new Env(null); return inferredAction(stmts) ? g.stmts([{ k: "action", body: stmts }], env, { imp: true, dyn: true }, 0) : g.stmts(stmts, env, { imp: true, dyn: true }, 0); }   // AC-1b: a handler row is a handler's body
export function compileDynamicExpr(e: Expr): string { const g = new Gen(usage({ decls: [], view: [] })); return g.expr(e, new Env(null), { imp: true, dyn: true }); }

class Gen {
  u: Usage;
  file = "main.rx"; css: string[] = [];
  top: string[] = [];                                   // module-level code: hoisted server functions and the module's error classes
  serverNames = new Map<string, string>();              // a module-level server fn → its hoisted function
  private modDecls: Decl[] = [];
  private sfSeq = 0;
  /** Begin a module: what a hoisted server function may name at module level (SF-3: imports, error classes, server fns). */
  beginModule(path: string, decls: Decl[]) {
    this.file = path; this.top = []; this.modDecls = decls; this.serverNames = new Map();
    for (const d of decls) if (d.k === "server" || (d.k === "eq" && unwrapServer(d.e))) this.serverNames.set(d.name, `sf$${d.name}`);
    // a package's JS (\`@solidjs/web/server-functions\`): a real import at module level, where a hoisted server fn's wrappers are
    for (const d of decls) if (d.k === "import" && !d.resolved && !d.from.startsWith(".")) {
      const names = d.names.filter(n => !BUILTINS.has(n.name) && n.name !== "log");
      if (names.length) this.top.push(`import { ${names.map(n => `${n.name} as w$${n.alias}`).join(", ")} } from ${J(d.from)};`);
    }
  }
  /** 12 SF-7a: a server fn as Solid's \`"use server"\` function at module level — it may name only its parameters, its locals
   *  and module-level bindings, which SF-3 makes always possible: every name a body may use is a module-level import, error
   *  class or server fn, bound here from the calling app. Solid's \`transformDirectives\` then extracts it (server build) or
   *  replaces it with a reference (browser build). */
  /** SF-1d: a wrapped server fn — the wrapper calls kept around it at module level, where Solid's directive pass finds it. */
  private serverWrapped(name: string, e: Expr): string {
    const f = this.serverNames.get(name)!;
    const chain = (x: Expr): string => {
      if (x.k === "serverfn") return this.serverHoist({ name, params: x.params, body: x.body }, true);
      if (x.k === "call" && x.f.k === "id") {
        const imp = this.modDecls.find(d => d.k === "import" && !d.resolved && !d.from.startsWith(".") && d.names.some(n => n.alias === (x.f as { name: string }).name));
        if (!imp) throw new CompileError(`${name}: a server fn's wrapper is a package's function (here, ${x.f.name})`);
        return `w$${x.f.name}(${x.args.map(a => unwrapServer(a) ? chain(a) : a.k === "lit" ? J(a.v) : (() => { throw new CompileError(`${name}: a wrapper's other arguments are literals`); })()).join(", ")})`;
      }
      throw new CompileError(`${name}: not a wrapped server fn`);
    };
    this.top.push(`const ${f} = ${chain(e)};`);
    return f;
  }
  private serverHoist(d: { name: string; params: string[]; body: Stmt[] }, expression = false): string {
    const f = this.serverNames.get(d.name) && !expression && !this.top.some(t => t.includes(`function ${this.serverNames.get(d.name)}(`)) ? this.serverNames.get(d.name)! : `sf$${d.name}$${this.sfSeq++}`;
    const env = new Env(null); const pre: string[] = [];
    for (const x of this.modDecls) {
      if (x.k === "import" && !x.resolved) for (const { name, alias } of x.names) {
        if (name === "log" || BUILTINS.has(name)) continue;
        if (!x.from.startsWith(".")) { env.vars.set(alias, { kind: "val", js: `w$${alias}` }); continue; }   // a package's: module level
        env.vars.set(alias, { kind: "val", js: mg(alias) });
        pre.push(`const ${mg(alias)} = ${x.declaredErrors?.includes(name) ? `__rt.jsError(${J(name)})` : `__rt.api(${J(name)})`};`);
      }
      if (x.k === "error") { env.vars.set(x.name, { kind: "val", js: mg(x.name) }); pre.push(`const ${mg(x.name)} = g$${x.name}(__rt);`); }
      if (x.k === "server" || (x.k === "eq" && unwrapServer(x.e))) env.vars.set(x.name, { kind: "val", js: this.serverNames.get(x.name)! });
      if (x.k === "fn" && !x.params.some(p => p.ref) && !x.decls.length) env.vars.set(x.name, { kind: "fn", js: mg(x.name), fn: x });   // a value fn (SF-3: it reads nothing reactive)
    }
    for (const x of this.modDecls) if (x.k === "fn" && env.vars.get(x.name)?.fn === x) pre.push(this.fn(x, env, 0));   // declared again inside: the body is extracted with it (found by S-app-notes)
    const body = this.stmts(d.body, this.params(env, d.params), { imp: true, gen: true }, 2);
    const fn = `async function ${f}(...__a) {\n  "use server";\n  const __rt = globalThis.__rx_app; const __B = __rt.B;\n  ${pre.join("\n  ")}\n  return __rt.serverCall(${J(d.name)}, function* (${d.params.map(mg).join(", ")}) {\n${body}\n  }, __a);\n}`;
    if (expression) return fn;
    this.top.push(fn);
    return f;
  }
  private styleHash: string | null = null;   // CSS-2: the scope class of the view being emitted
  mods?: { set: ModuleSet; out: (path: string) => string };
  constructor(u: Usage, mods?: { set: ModuleSet; out: (path: string) => string }) { this.u = u; this.mods = mods; }
  private modIndex(path: string) { const { order, signatures } = this.mods!.set; return [...order, ...(signatures?.keys() ?? [])].indexOf(path); }
  depVar(path: string) { return `__m${this.modIndex(path)}`; }
  /** An imported name's binding, from the exporting module's declaration (MO-3: a source is read-only here, so an accessor). */
  private importBind(path: string, name: string, alias: string): Bind {
    const sig = this.mods!.set.programs.has(path) ? undefined : this.mods!.set.signatures?.get(path)?.exports.get(name);
    if (sig) switch (sig.kind) {                                                             // MO-9: the kind is the signature's
      case "fn": return { kind: sig.instantiating || sig.params.some(p => p.ref) ? "ifn" : "fn", js: mg(alias), fn: { k: "fn", name, params: sig.params, decls: [], tail: { k: "lit", v: undefined } } as unknown as FnDecl };
      case "comp": return { kind: "comp", js: cm(alias) };
      case "action": return { kind: "act", js: mg(alias) };
      case "source": case "eq": return { kind: "acc", js: mg(alias) };
      default: return { kind: "val", js: mg(alias) };
    }
    const d = this.mods!.set.programs.get(path)?.decls.find(x => "name" in x && (x as { name: string }).name === name) as Decl | undefined;
    const js = mg(alias);
    if (!d) return { kind: "val", js };
    switch (d.k) {
      case "fn": return { kind: d.params.some(p => p.ref) || d.decls.length ? "ifn" : "fn", js, fn: d };
      case "component": return { kind: "comp", js: cm(alias) };
      case "action": return { kind: "act", js };
      case "source": case "eq": return { kind: "acc", js };
      default: return { kind: "val", js };
    }
  }

  // ---- blocks: a region's declarations, then its view ----
  block(decls: Decl[], view: Markup[], env: Env, ind: number, exportsTail?: string, styleRoot = false): string {
    const pad = " ".repeat(ind * 2);
    const prevHash = this.styleHash;
    if (styleRoot) this.styleHash = this.style(view);   // a component's view (or the program's) has its own scope; a branch keeps its view's
    try { return this.block0(decls, view, env, ind, exportsTail); } finally { this.styleHash = prevHash; }
  }
  /** 07 §6b: a view's <style> through TSRX's engine (Solid's compiler): the view's elements as a TSRX fragment — HTML
   *  elements with their static attributes, components with the children passed to them, and every region (a branch, a
   *  loop body, a boundary) as an expression TSRX matches conservatively, as it does its own control flow. Its scoped
   *  stylesheet joins the module's; its hash is the view's scope class. */
  /** 07 CSS-5: a style expression through TSRX's engine — its class map literal; its stylesheet joins the module's. */
  private classMap(css: string, line?: number): string {
    let r: { code: string; css?: string };
    try { r = transform(`export const __s = <style>${css}</style>;`, { filename: this.file.replace(/\.rx$/, "") + `.${line ?? 0}.tsrx`, generate: "dom" }) as typeof r; }
    catch (e) { throw new CompileError(`<style> (line ${line ?? "?"}): ${(e as Error).message}`); }
    const m = /export const __s = (\{[\s\S]*?\});/.exec(r.code); if (!m) throw new CompileError(`<style> (line ${line ?? "?"}): no class map`);
    if (r.css) this.css.push(r.css);
    return `Object.freeze(${m[1]})`;
  }
  private style(view: Markup[]): string | null {
    const st = view.find(m => m.k === "style") as Extract<Markup, { k: "style" }> | undefined; if (!st) return null;
    const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const tree = (ms: Markup[]): string => ms.map(m => {
      switch (m.k) {
        case "text": case "style": return "";
        case "read": return "{0}";
        case "el": {
          if (m.tag === "") return `<>${tree(m.children)}</>`;
          const attrs = m.attrs.filter(a => !isHandler(a.name) && a.name !== "...").map(a => a.e.k === "lit" && typeof a.e.v === "string" ? ` ${a.name}="${esc(a.e.v)}"` : a.e.k === "lit" && a.e.v === true ? ` ${a.name}` : ` ${a.name}={0}`).join("") + (m.attrs.some(a => a.name === "...") ? " {...0}" : "");
          return VOID_TAGS.has(m.tag) ? `<${m.tag}${attrs} />` : `<${m.tag}${attrs}>${tree(m.children)}</${m.tag}>`;
        }
        case "mif": return `{(<>${tree(m.t)}</>)}{(<>${tree(m.f)}</>)}`;
        case "mfor": return `{(<>${tree(m.body)}</>)}`;
        case "loading": case "errored": return `{(<>${tree(m.fallback)}</>)}{(<>${tree(m.body)}</>)}`;
      }
    }).join("");
    const src = `export const __view = () => <><style>${st.css}</style>${tree(view)}</>;`;
    let r: { css?: string; cssHash?: string | null };
    try { r = transform(src, { filename: this.file.replace(/\.rx$/, "") + ".tsrx", generate: "dom" }) as typeof r; }
    catch (e) { throw new CompileError(`<style> (line ${st.line ?? "?"}): ${(e as Error).message}`); }
    if (!r.cssHash) return null;
    this.css.push(r.css ?? ""); return r.cssHash;
  }
  private block0(decls: Decl[], view: Markup[], env: Env, ind: number, exportsTail?: string): string {
    const pad = " ".repeat(ind * 2);
    const out: string[] = [`${pad}const __o = __rt.owner();`];
    // MO-1: each .rx dependency instantiated (once per app), its exports bound by name
    for (const d of decls) if (d.k === "import" && d.resolved) {
      const iv = `__i${this.modIndex(d.resolved)}`;
      if (!out.some(l => l.includes(`const ${iv} =`))) out.push(`${pad}const ${iv} = __rt.module(${J(this.mods!.out(d.resolved))}, ${this.depVar(d.resolved)});`);
      for (const { name, alias } of d.names) {
        if (this.mods!.set.programs.get(d.resolved)?.decls.some(x => x.k === "typedecl" && x.name === name) || this.mods!.set.signatures?.get(d.resolved)?.exports.get(name)?.kind === "type") continue;   // a type binds nothing
        const ib = this.importBind(d.resolved, name, alias); env.vars.set(alias, ib); out.push(`${pad}const ${ib.js} = ${iv}[${J(name)}];`);
      }
    }
    // names first: hoisted functions and components; every other declaration is a const
    for (const d of decls) {
      if (d.k === "import" && d.resolved) continue;
      if (d.k === "import") for (const { name, alias } of d.names) { const x = d.declared ? this.mods?.set.declarations?.get(d.declared)?.find(y => y.name === name) : undefined; env.vars.set(alias, x?.kind === "fn" && x.instantiates ? { kind: "jfn", js: mg(alias), refs: x.refs ?? [], shape: x.shape ?? "value" } : { kind: "val", js: mg(alias), client: d.side === "client" || d.declaredSide?.[name] === "client" }); }   // MO-10a
      if (d.k === "fn") env.vars.set(d.name, { kind: d.params.some(p => p.ref) || d.decls.length ? "ifn" : "fn", js: mg(d.name), fn: d });
      if (d.k === "component") env.vars.set(d.name, { kind: "comp", js: cm(d.name) });
      if (d.k === "action") env.vars.set(d.name, { kind: "act", js: mg(d.name) });
      if (d.k === "server") env.vars.set(d.name, { kind: "val", js: mg(d.name) });
      if (d.k === "error" || d.k === "context") env.vars.set(d.name, { kind: "val", js: mg(d.name) });
      if (d.k === "source") env.vars.set(d.name, { kind: "src", js: mg(d.name), w: `w$${d.name}`, prev: this.u.prevOf.has(d.name) ? `p$${d.name}` : undefined });
      if (d.k === "eq" && unwrapServer(d.e)) { env.vars.set(d.name, { kind: "val", js: mg(d.name) }); continue; }   // SF-1d: a server fn, not an accessor
      if (d.k === "eq") { const jf = d.e.k === "call" && d.e.f.k === "id" ? env.lookup(d.e.f.name) : undefined; env.vars.set(d.name, { kind: "acc", js: mg(d.name), w: this.guessedEq(d) ? `w$${d.name}` : undefined, prev: this.u.prevOf.has(d.name) ? `p$${d.name}` : undefined, ...(jf?.kind === "jfn" ? { inst: `r$${d.name}`, shape: jf.shape } : {}) }); }
    }
    for (const d of decls) if (d.k === "import" && !d.resolved) for (const { name, alias } of d.names) {
      const v = !d.from.startsWith(".") && !BUILTINS.has(name) && name !== "log" ? `w$${alias}` : name === "log" ? "__B.log" : d.declaredErrors?.includes(name) ? `__rt.jsError(${J(name)})` : BUILTINS.has(name) ? `__B.${name}` : d.from.endsWith("/api") ? `__rt.api(${J(name)})` : isPrims(d.from) ? `__rt.prim(${J(name)})` : null;   // MO-10: the prelude's Solid primitives
      if (!v) throw new CompileError(`${name} from "${d.from}" is not in the scenario prelude`);
      out.push(`${pad}const ${mg(alias)} = ${v};\n${pad}__rt.reg(${J(alias)}, { value: ${mg(alias)} });`);
    }
    for (const d of decls) if (d.k === "error") {
      const inner = this.params(env, d.params); const make = `__rt.errorClass(${J(d.name)}, ${J(d.params)}, (${d.params.map(mg).join(", ")}) => ${d.msg ? this.expr(d.msg, inner, { imp: false }) : J(d.name)})`;
      if (env.parent) { out.push(`${pad}const ${mg(d.name)} = ${make};   // R-f-1`); continue; }
      // a module's error class is the module's, created once (by whichever app asks first): a server function's body,
      // hoisted to module level (SF-7a), throws the class an action's catch tests
      this.top.push(`let c$${d.name};\nfunction g$${d.name}(__rt) { const __B = __rt.B; return c$${d.name} ??= ${make}; }`);
      out.push(`${pad}const ${mg(d.name)} = g$${d.name}(__rt);   // R-f-1`);
    }
    for (const d of decls) if (d.k === "context") out.push(`${pad}const ${mg(d.name)} = __rt.context(${J(d.name)}, ${d.dflt ? `() => ${this.expr(d.dflt, env, { imp: false })}` : "null"});   // RG-7: the declaration is the context's identity\n${pad}__rt.reg(${J(d.name)}, { value: ${mg(d.name)} });`);
    for (const d of decls) if (d.k === "fn") out.push(this.fn(d, env, ind));
    for (const d of decls) if (d.k === "component") out.push(this.component(d, env, ind));
    for (const d of decls) if (d.k === "action") out.push(`${pad}const ${mg(d.name)} = __rt.action(function* (${d.params.map(mg).join(", ")}) {\n${this.stmts(d.body, this.params(env, d.params), { imp: true, gen: true }, ind + 1)}\n${pad}});\n${pad}__rt.reg(${J(d.name)}, { value: ${mg(d.name)} });`);
    for (const d of decls) if (d.k === "eq" && unwrapServer(d.e)) { const f = this.serverWrapped(d.name, d.e); out.push(`${pad}const ${mg(d.name)} = __rt.serverRef(${J(d.name)}, ${f});   // 12 SF-1d: a wrapped server fn, at module level`); }
    for (const d of decls) if (d.k === "server") { const f = this.serverHoist(d); out.push(`${pad}const ${mg(d.name)} = __rt.serverRef(${J(d.name)}, ${f});   // 12 SF-7a: the call site's (question or request); the function is module-level`); }
    // values in dependency order (E-7: equations are unordered in the source; C-1 makes this a DAG)
    const vals = decls.filter(d => d.k === "source" || (d.k === "eq" && !unwrapServer(d.e)) || d.k === "provide");
    const key = (d: Decl) => d.k === "provide" ? `provide:${d.name}` : (d as { name: string }).name;
    const local = new Set(vals.filter(d => d.k !== "provide").map(d => (d as { name: string }).name));
    const done = new Set<string>(); const order: Decl[] = []; const busy = new Set<string>();
    const visit = (d: Decl) => {
      const k = key(d); if (done.has(k) || busy.has(k)) return; busy.add(k);
      const self = d.k === "provide" ? "" : (d as { name: string }).name;
      for (const n of deps(d.k === "eq" ? d.e : d.k === "source" ? d.init : d.e, self)) if (local.has(n) && n !== self) { const t = vals.find(x => x.k !== "provide" && (x as { name: string }).name === n); if (t) visit(t); }
      busy.delete(k); done.add(k); order.push(d);
    };
    vals.forEach(visit);
    for (const d of order) out.push(this.value(d, env, ind));
    for (const d of decls) if (d.k === "effect") {
      const inner = new Env(env);
      out.push(...this.hoistAll(d.inputs, env, pad));
      out.push(`${pad}__rt.effect(${d.inputs.length}, () => [${d.inputs.map(i => this.expr(i, env, { imp: false })).join(", ")}], ($p) => __rt.untrack(() => {\n${this.stmts(d.body, inner, { imp: true, effect: true }, ind + 1, true)}\n${pad}}));   // SC-2: the apply reads σ, untracked`);
    }
    if (!exportsTail) out.push(...this.hoistAll(viewReaders(view), env, pad));
    out.push(exportsTail ? `${pad}return ${exportsTail};` : `${pad}return ${this.markup(view, env, ind)};`);
    return out.join("\n");
  }
  private params(env: Env, ps: string[]) { const e = new Env(env); for (const p of ps) e.vars.set(p, { kind: "val", js: mg(p) }); return e; }

  private value(d: Decl, env: Env, ind: number): string {
    const pad = " ".repeat(ind * 2);
    if (d.k === "provide") {
      const b = d.e.k === "id" ? env.lookup(d.e.name) : undefined;
      const hoisted = b?.kind === "src" ? "" : this.hoistAll([d.e], env, pad).map(x => x + "\n").join("");
      const entry = b?.kind === "src" ? `{ get: ${b.js}, w: ${b.w} }` : `{ get: __rt.memo(null, () => ${this.expr(d.e, env, { imp: false })}) }`;
      return `${hoisted}${pad}__rt.provide(${this.ref(d.name, env, { imp: false })}, ${entry});`;
    }
    const b = env.vars.get((d as { name: string }).name)!;
    const hoist = d.k === "source" && d.question ? this.hoist(d.name, d.init, env, pad) : d.k === "eq" && d.e.k !== "draft" ? this.hoist(d.name, d.e, env, pad) : "";
    if (hoist) return hoist + "\n" + this.value1(d, env, ind, b);
    return this.value1(d, env, ind, b);
  }
  /** 07 §3 / R-1: each `await` that is not the equation's result is its own async memo, asked only while the conditions that
   *  reach it hold (E-11, ref/src/awaits.ts); the equation reads it where the `await` was. */
  private hoisted = new Map<Expr, string>(); private hoistSeq = 0;
  private hoist(name: string | null, e: Expr, env: Env, pad: string, tail = true): string {
    return nonTailAwaits(e, tail).map(h => {
      const v = `a$${name ?? ""}$${this.hoistSeq++}`;
      const guards = h.guards.map(g => { const x = this.expr(g.e, env, { imp: false }); return g.nullish ? `(${x}) == null` : g.neg ? `!(${x})` : `(${x})`; });
      const body0 = this.expr(h.node.e, env, { imp: false, tail: true }); const body = h.node.stream ? body0 : `__rt.awaited(${body0})`;
      this.hoisted.set(h.node, v);
      const lv = h.node.init ? `__rt.firstPaint(() => ${this.expr(h.node.init, env, { imp: false })})` : "undefined";
      return `${pad}const ${v} = __rt.memo(${J(name)}, () => ${guards.length ? `(${guards.join(" && ")}) ? ${body} : undefined` : body}, ${this.clientCall(h.node.e, env) ? `__rt.clientQuestion(${lv})` : lv});${name ? `\n${pad}__rt.hoisted(${J(name)}, ${v});` : ""}`;
    }).join("\n");
  }
  private hoistAll(es: Expr[], env: Env, pad: string): string[] { return es.map(x => this.hoist(null, x, env, pad, false)).filter(Boolean); }
  /** An equation a guess sits over (AC-3): not deferred, not a draft, not a wrapped server fn. */
  private guessedEq(d: Extract<Decl, { k: "eq" }>): boolean { return this.u.optimistic.has(d.name) && !d.deferred && d.e.k !== "draft" && !unwrapServer(d.e); }
  private value1(d: Decl, env: Env, ind: number, b: Bind): string {
    const pad = " ".repeat(ind * 2);
    const prev = b.prev ? `\n${pad}const ${b.prev} = __rt.pre(${b.js});` : "";
    if (d.k === "source") {
      if (!d.question) return `${pad}const [${b.js}, ${b.w}] = __rt.source(${J(d.name)}, __rt.untrack(() => ${this.expr(d.init, env, { imp: false })}));\n${pad}__rt.reg(${J(d.name)}, { get: ${b.js}, w: ${b.w} });${prev}`;
      const lv = this.loadingValue(d.init, env);
      const mode = `{ optimistic: ${this.u.optimistic.has(d.name)}, structured: ${this.u.paths.has(d.name)} }`;
      return `${pad}const [${b.js}, ${b.w}] = __rt.question(${J(d.name)}, (__prev) => ${this.expr(d.init, env, { imp: false, tail: true, self: d.name })}, ${lv}, ${mode}${d.key ? `, ${J(d.key)}` : ""});\n${pad}__rt.reg(${J(d.name)}, { get: ${b.js}, w: ${b.w} });${prev}`;
    }
    if (d.k !== "eq") throw new CompileError("unreachable");
    if (this.guessedEq(d)) {                                                                   // AC-3 over an equation: createOptimistic(fn) / createOptimisticStore(fn, seed) — derived, its setter only guesses
      const lv = this.loadingValue(d.e, env);
      const mode = `{ optimistic: true, structured: ${this.u.paths.has(d.name) || !!d.key}, derived: true }`;
      return `${pad}const [${b.js}, ${b.w}] = __rt.question(${J(d.name)}, (__prev) => ${this.expr(d.e, env, { imp: false, tail: true, self: d.name })}, ${lv}, ${mode}${d.key ? `, ${J(d.key)}` : ""});\n${pad}__rt.reg(${J(d.name)}, { get: ${b.js}, w: ${b.w} });${prev}`;
    }
    const reg = `\n${pad}__rt.reg(${J(d.name)}, { get: ${b.js} });${prev}`;
    if (d.e.k === "draft") {                                                                   // ST-3
      const seed = d.e.seed; if (seed.k !== "pre" || seed.name !== d.name || !seed.init) throw new CompileError("a draft's seed must be `pre self -> seed`");
      const inner = new Env(env); inner.vars.set("d", { kind: "val", js: "v$d" });
      return `${pad}const ${b.js} = __rt.draft(__rt.untrack(() => ${this.expr(seed.init, env, { imp: false })}), (v$d) => {\n${this.draftBody(d.e.body, inner, ind + 1)}\n${pad}});${reg}`;
    }
    if (d.e.k === "call" && d.e.f.k === "id" && env.lookup(d.e.f.name)?.kind === "ifn") return `${pad}const ${b.js} = ${this.instantiate(d.e, env)};${reg}`;   // RG-6
    const fx = this.foreign(d, env, b, pad); if (fx !== null) return `${fx}${reg}`;
    if (d.key) return `${pad}const ${b.js} = __rt.keyed(${J(d.name)}, ${J(d.key)}, () => ${this.expr(d.e, env, { imp: false, tail: true })});${reg}`;
    if (d.e.k === "catch" && !d.deferred) {                                                    // R-f-4 over a tail await: the flight is an inner memo, read through a boundary
      const c = d.e; const inner = new Env(env); if (c.name) inner.vars.set(c.name, { kind: "val", js: mg(c.name) });
      return `${pad}const i$${d.name} = __rt.memo(${J(d.name)}, (__prev) => ${this.expr(c.e, env, { imp: false, tail: true, self: d.name })}, ${this.loadingValue(c.e, env)});\n${pad}const ${b.js} = __rt.catchMemo(() => i$${d.name}(), (__e) => __rt.isA(__e, ${this.classes(c.classes, env)}), (${c.name ? mg(c.name) : "__e"}) => ${this.expr(c.alt, inner, { imp: false })});${reg}`;
    }
    const fn = d.deferred ? "deferred" : "memo";
    return `${pad}const ${b.js} = __rt.${fn}(${J(d.name)}, (__prev) => ${this.expr(d.e, env, { imp: false, tail: true, self: d.name })}, ${this.loadingValue(d.e, env)});${reg}`;
  }
  /** SV-7b: a call into `client` JS — awaited, a client question: Solid's `ssrSource: "client"`, never asked on the server. */
  private clientCall(e: Expr, env: Env): boolean { const f = e.k === "catch" ? e.e : e; return f.k === "call" && f.f.k === "id" && !!env.lookup(f.f.name)?.client; }
  private tailClient(e: Expr, env: Env): boolean {
    let hit = false;
    const walk = (x: unknown): void => { if (hit || !x || typeof x !== "object") return; if (Array.isArray(x)) { x.forEach(walk); return; } const o = x as Record<string, any>; if (o.k === "fn") return; if (o.k === "await" && !this.hoisted.has(o as Expr) && this.clientCall(o.e, env)) { hit = true; return; } Object.values(o).forEach(walk); };
    walk(e); return hit;
  }
  private loadingValue(e: Expr, env: Env): string {                                            // R-7: the first paint of an `await … -> v`; SV-7b: a client question's ssrSource
    const lv = this.loadingValue0(e, env); return this.tailClient(e, env) ? `__rt.clientQuestion(${lv})` : lv;
  }
  private loadingValue0(e: Expr, env: Env): string {
    let init: Expr | undefined;
    const walk = (x: unknown): void => { if (init || !x || typeof x !== "object") return; if (Array.isArray(x)) { x.forEach(walk); return; } const o = x as Record<string, any>; if (o.k === "fn") return; if (o.k === "await" && o.init) { init = o.init; return; } Object.values(o).forEach(walk); };
    walk(e);
    return init ? `__rt.firstPaint(() => ${this.expr(init, env, { imp: false })})` : "undefined";
  }
  private draftBody(ss: Stmt[], env: Env, ind: number): string {
    const pad = " ".repeat(ind * 2);
    return ss.map(s => {
      if (s.k === "let") { env.vars.set(s.name, { kind: "val", js: mg(s.name) }); return `${pad}const ${mg(s.name)} = ${this.expr(s.e, env, { imp: false })};`; }
      if (s.k === "expr") return `${pad}${this.expr(s.e, env, { imp: false })};`;
      if (s.k === "write") { const path = s.target.path.map(p => typeof p === "string" ? J(p) : this.expr(p, env, { imp: false })); const last = path.pop()!; return `${pad}{ let __t = v$d; ${path.map(k => `__t = (__t[${k}] ??= {});`).join(" ")} __t[${last}] = ${this.expr(s.e, env, { imp: false })}; }`; }
      throw new CompileError(`${s.k} in a draft block`);
    }).join("\n");
  }
  private fn(d: FnDecl, env: Env, ind: number): string {
    const pad = " ".repeat(ind * 2);
    const inner = new Env(env);
    for (const p of d.params) inner.vars.set(p.name, { kind: p.ref ? "acc" : "val", js: mg(p.name) });
    if (!d.params.some(p => p.ref) && !d.decls.length) return `${pad}function ${mg(d.name)}(${d.params.map(p => mg(p.name)).join(", ")}) { return ${this.expr(d.tail, inner, { imp: false })}; }`;
    // an instantiating fn (RG-6): called once, returns the accessor of its tail
    const body = this.block(d.decls, [], inner, ind + 1).split("\n").filter(l => !/^\s*return null;$/.test(l)).join("\n");
    const tb = d.tail.k === "id" ? inner.lookup(d.tail.name) : undefined;
    const tail = tb && (tb.kind === "acc" || tb.kind === "src") ? tb.js : `__rt.memo(null, () => ${this.expr(d.tail, inner, { imp: false })})`;
    return `${pad}function ${mg(d.name)}(${d.params.map(p => mg(p.name)).join(", ")}) {\n${body}\n${pad}  return ${tail};\n${pad}}`;
  }
  /** MO-10: `x = f(…)` over a declared primitive — called once (RG-6), a ref argument as an accessor, a value one untracked;
   *  and `y = x[i]` / `x.k` over its result. A `ref` part is bound to the accessor itself, any other part to its value. */
  private foreign(d: Extract<Decl, { k: "eq" }>, env: Env, b: Bind, pad: string): string | null {
    const e = d.e;
    const part = (r: string, p: Shape) => p === "ref" ? r : `() => ${r}`;
    if (e.k === "call" && e.f.k === "id") {
      const f = env.lookup(e.f.name); if (f?.kind !== "jfn") return null;
      const args = e.args.map((a, i) => {
        if (!f.refs![i]) return `__rt.untrack(() => ${this.expr(a, env, { imp: false })})`;
        if (a.k === "id") { const ab = env.lookup(a.name); if (ab && (ab.kind === "acc" || ab.kind === "src")) return ab.js; }
        return `__rt.memo(null, () => ${this.expr(a, env, { imp: false })})`;
      });
      const r = b.inst!; const sh = f.shape!;
      const whole = typeof sh === "string" ? part(r, sh) : `__rt.memo(null, () => ${"items" in sh ? `[${sh.items.map((p, i) => p === "ref" ? `${r}[${i}]()` : `${r}[${i}]`).join(", ")}]` : `({ ${sh.fields.map(([k, p]) => `${J(k)}: ${p === "ref" ? `${r}[${J(k)}]()` : `${r}[${J(k)}]`}`).join(", ")} })`})`;
      return `${pad}const ${r} = ${f.js}(${args.join(", ")});\n${pad}const ${b.js} = ${whole};`;
    }
    if ((e.k === "index" && e.i.k === "lit") || e.k === "member") {
      const ob = e.o.k === "id" ? env.lookup(e.o.name) : undefined; const sh = ob?.shape; if (!ob?.inst || !sh || typeof sh !== "object") return null;
      const key = e.k === "index" ? (e.i as { v: any }).v : e.p;
      const p = "items" in sh ? sh.items[key] : sh.fields.find(f => f[0] === key)?.[1]; if (!p) return null;
      return `${pad}const ${b.js} = ${part(`${ob.inst}[${J(key)}]`, p)};`;
    }
    return null;
  }
  private instantiate(call: Extract<Expr, { k: "call" }>, env: Env): string {
    const b = env.lookup((call.f as { name: string }).name)!; const f = b.fn!;
    const args = f.params.map((p, i) => {
      const a = call.args[i]; if (!a) return "undefined";
      if (p.ref) { if (a.k === "id") { const b = env.lookup(a.name); if (b && (b.kind === "acc" || b.kind === "src")) return b.js; } return `__rt.memo(null, () => ${this.expr(a, env, { imp: false })})`; }
      return `__rt.untrack(() => ${this.expr(a, env, { imp: false })})`;
    });
    return `${b.js}(${args.join(", ")})`;
  }
  private component(d: Extract<Decl, { k: "component" }>, env: Env, ind: number): string {
    const pad = " ".repeat(ind * 2);
    const inner = new Env(env); inner.vars.set(d.props, { kind: "val", js: mg(d.props) });
    return `${pad}function ${cm(d.name)}(${mg(d.props)}) {\n${this.block(d.decls, d.view, inner, ind + 1, undefined, true)}\n${pad}}`;
  }

  // ---- expressions ----
  expr(e: Expr, env: Env, ctx: Ctx): string {
    const sub: Ctx = { ...ctx, tail: false };
    const go = (x: Expr) => this.expr(x, env, sub);
    switch (e.k) {
      case "lit": return J(e.v);
      case "id": return this.ref(e.name, env, ctx);
      case "pre": {
        const init = e.init ? this.expr(e.init, env, sub) : "undefined";
        if (ctx.self === e.name) return `__rt.preOr(__prev, () => ${init})`;            // the equation's own: the memo's previous value
        const b = env.lookup(e.name); if (!b?.prev) throw new CompileError(`pre ${e.name}: no companion memo`);
        return `__rt.preOr(${b.prev}(), () => ${init})`;
      }
      case "peek": return `__rt.untrack(() => ${go(e.e)})`;
      case "await": {
        if (this.hoisted.has(e)) return `${this.hoisted.get(e)}()`;
        if (ctx.imp) return ctx.gen ? `(yield __rt.awaited(${go(e.e)}))` : ctx.async ? `(await __rt.awaited(${go(e.e)}))` : go(e.e);
        if (!ctx.tail) throw new CompileError("`await` outside an equation's result position is not lowered yet");
        return e.stream ? go(e.e) : `__rt.awaited(${go(e.e)})`;                                      // the memo returns the flight (R-1): a stream for `await*`, else its one answer
      }
      case "latest": return `__rt.latest(() => ${this.expr(e.e, env, { ...ctx, imp: false })})`;   // R-12: Solid's latest — of a value that never had one it throws, in a handler too (S-solid-28)
      case "pending": return `__rt.isPending(() => ${go(e.e)})`;
      case "if": return `(${go(e.c)} ? ${this.expr(e.t, env, ctx)} : ${this.expr(e.f, env, ctx)})`;
      case "throw": return `__rt.throw(${go(e.e)})`;                                          // R-f-3
      case "catch": {                                                                           // R-f-4: over a sync value, or the tail await's promise/stream
        if (ctx.imp && this.hasAwait(e.e)) throw new CompileError("`await … catch` inside an expression of imperative scope (AWAIT_IN_EXPRESSION, AC-1)");
        const inner = new Env(env); if (e.name) inner.vars.set(e.name, { kind: "val", js: mg(e.name) });
        return `__rt.${ctx.imp ? "tryCatch" : "catchRead"}(() => ${this.expr(e.e, env, sub)}, (__e) => __rt.isA(__e, ${this.classes(e.classes, env)}), (${e.name ? mg(e.name) : "__e"}) => ${this.expr(e.alt, inner, sub)})`;
      }
      case "tpl": return `(${e.parts.map(p => typeof p === "string" ? J(p) : `__rt.fmt(${go(p)})`).join(" + ") || '""'})`;
      case "member": return `${go(e.o)}?.${e.p}`;
      case "index": return `${go(e.o)}?.[${go(e.i)}]`;
      case "stylemap": return this.classMap(e.css, e.line);                                  // 07 CSS-5
      case "call": {
        if (e.f.k === "id" && e.f.name === "until" && !env.lookup("until") && e.args[0]?.k === "fn") { const p = e.args[0]; return `__rt.until(() => ${this.expr(p.body, env, { imp: false, dyn: ctx.dyn })})`; }   // AC-6: Solid's until; the predicate is reactive scope
        if (e.f.k === "id" && (e.f.name === "onSettled" || e.f.name === "onFlush") && !env.lookup(e.f.name)) return `__rt.${e.f.name}(${e.args.map(go).join(", ")})`;   // EF-7, EF-8: Solid's own
        if (e.f.k === "member") return `${go(e.f.o)}?.${e.f.p}(${e.args.map(go).join(", ")})`;
        return `${go(e.f)}(${e.args.map(go).join(", ")})`;
      }
      case "arr": return `[${e.items.map(i => i.k === "spread" ? `...${go(i.e)}` : go(i)).join(", ")}]`;
      case "rec": return `({ ${e.fields.map(f => "spread" in f ? `...${go(f.spread)}` : `${J(f.key)}: ${go(f.v)}`).join(", ")} })`;
      case "fn": {
        const inner = this.params(env, e.params); const ps = e.params.map(mg).join(", ");
        if (e.stmts && inferredAction(e.stmts)) return `(${ps}) => __rt.action(function* () {\n${this.stmts(e.stmts, inner, { imp: true, gen: true, dyn: ctx.dyn, effect: ctx.effect }, 1)}\n})()`;   // AC-1b: an inferred action lowers as `action { … }` does, to Solid's action()
        if (e.stmts) { const async = this.hasAwait(e.stmts); return `${async ? "async " : ""}(${ps}) => {\n${this.stmts(e.stmts, inner, { imp: true, async, dyn: ctx.dyn, effect: ctx.effect }, 0)}\n}`; }
        return `(${ps}) => ${this.expr(e.body, inner, { imp: ctx.imp, dyn: ctx.dyn, effect: ctx.effect })}`;
      }
      case "use": return `__rt.useGet(${this.ref(e.name, env, { imp: false, dyn: ctx.dyn })}, __o)`;
      case "bin": {
        if (e.op === "==") return `__rt.eq(${go(e.l)}, ${go(e.r)})`;
        if (e.op === "!=") return `!__rt.eq(${go(e.l)}, ${go(e.r)})`;
        return `(${go(e.l)} ${e.op} ${go(e.r)})`;
      }
      case "un": return `(${e.op}${go(e.e)})`;
      case "draft": throw new CompileError("a draft is an equation's whole expression");
      case "spread": throw new CompileError("spread outside an array literal");
      case "omit": return `__rt.omit(${[go(e.e), ...e.keys.map(k => J(k))].join(", ")})`;   // RG-4b: Solid's live view
    }
  }
  private ref(name: string, env: Env, ctx: Ctx): string {
    if (ctx.effect && /^\$\d+$/.test(name)) return `$p[${name.slice(1)}]`;
    const b = env.lookup(name);
    if (!b) {
      if (BUILTINS.has(name)) return `__B.${name}`;
      if (ctx.dyn) return name === "log" ? "__B.log" : ctx.imp ? `__rt.dget(${J(name)})` : `__rt.dget(${J(name)}, true)`;
      if (name === "log" && ctx.imp) return "__B.log";
      throw new CompileError(`unbound ${name}`);
    }
    if (b.kind === "acc" || b.kind === "src") return ctx.imp ? `__rt.snapshot(${b.js})` : `${b.js}()`;
    if (b.kind === "comp") throw new CompileError(`component ${name} used as a value`);
    return b.js;
  }
  /** R-f-4: error class names → a JS array of their values; `undefined`: every failure. */
  private classes(names: string[] | undefined, env: Env): string { return names ? `[${names.map(n => n === "Error" ? "Error" : n === "Panic" ? "__rt.PANIC" : this.ref(n, env, { imp: false })).join(", ")}]` : "undefined"; }
  private hasAwait(ss: unknown): boolean { const s = JSON.stringify(ss); return s.includes('"k":"await"'); }

  // ---- imperative scope ----
  stmts(ss: Stmt[], env0: Env, ctx: Ctx, ind: number, returnLast = false): string {
    const env = new Env(env0); const pad = " ".repeat(ind * 2);
    const out: string[] = [];
    ss.forEach((s, i) => {
      const e = (x: Expr) => this.expr(x, env, { ...ctx, tail: false });
      const c = (s.k === "let" || s.k === "expr") && s.e.k === "catch" && s.e.e.k === "await" ? s.e : null;
      if (c && (s.k === "let" || s.k === "expr")) {                                             // AC-1 / R-f-4: a statement-level `await … catch` is a try around the await
        const v = s.k === "let" ? mg(s.name) : null; const set = (x: string) => `${pad}  ${v ? `${v} = ` : ""}${x};`;
        const h = new Env(env); if (c.name) h.vars.set(c.name, { kind: "val", js: mg(c.name) });
        const ev = c.name ? mg(c.name) : "__e";
        out.push(`${v ? `${pad}let ${v};\n` : ""}${pad}try {\n${set(e(c.e))}\n${pad}} catch (${ev}) {\n${pad}  if (!__rt.isA(${ev}, ${this.classes(c.classes, env)})) throw ${ev};\n${set(this.expr(c.alt, h, { ...ctx, tail: false }))}\n${pad}}`);
        if (v) env.vars.set(s.name, { kind: "val", js: v });
        return;
      }
      switch (s.k) {
        case "let": out.push(`${pad}let ${mg(s.name)} = ${e(s.e)};`); env.vars.set(s.name, { kind: "val", js: mg(s.name) }); break;
        case "expr": out.push(`${pad}${returnLast && i === ss.length - 1 ? "return " : ""}${e(s.e)};`); break;
        case "return": out.push(`${pad}return${s.e ? " " + e(s.e) : ""};`); break;
        case "throw": out.push(`${pad}throw ${e(s.e)};`); break;
        case "write": case "optimistic": {
          const keys = `[${s.target.path.map(p => typeof p === "string" ? J(p) : e(p)).join(", ")}]`;
          const v = e(s.e);
          if (ctx.dyn && !s.target.ctx && !env.lookup(s.target.name)) { out.push(`${pad}__rt.dset(${J(s.target.name)}, ${keys}, ${v}, ${s.k === "optimistic"});`); break; }
          let w: string;
          if (s.target.ctx) w = `__rt.use(${this.ref(s.target.name, env, { imp: false, dyn: ctx.dyn })}, __o).w`;
          else { const b = env.lookup(s.target.name); if (!b?.w) throw new CompileError(`W-1: ${s.target.name} is not a source`); w = b.w; }
          out.push(`${pad}${s.k === "optimistic" ? `${w}.guess(${v}${s.target.path.length ? `, ${keys}` : ""})` : s.target.path.length ? `${w}.path(${keys}, ${v})` : `${w}.set(${v})`};`);
          break;
        }
        case "refresh": { const b = env.lookup(s.name); out.push(`${pad}__rt.refresh(${J(s.name)}, ${b ? b.js : `__rt.lookup(${J(s.name)}).get`});`); break; }
        case "affects": { const b = env.lookup(s.name); out.push(`${pad}__rt.affects(${b ? b.js : `__rt.lookup(${J(s.name)}).get`});`); break; }
        case "action": out.push(`${pad}__rt.action(function* () {\n${this.stmts(s.body, env, { imp: true, gen: true, dyn: ctx.dyn }, ind + 1)}\n${pad}})();`); break;
        case "sif": out.push(`${pad}if (${e(s.c)}) {\n${this.stmts(s.t, env, ctx, ind + 1)}\n${pad}} else {\n${this.stmts(s.f, env, ctx, ind + 1)}\n${pad}}`); break;
        case "try": {
          let t = `${pad}try {\n${this.stmts(s.body, env, ctx, ind + 1)}\n${pad}}`;
          if (s.handler) { const h = new Env(env); if (s.catchName) h.vars.set(s.catchName, { kind: "val", js: mg(s.catchName) }); const v = s.catchName ? mg(s.catchName) : "__e"; t += ` catch (${v}) {\n${s.catchClasses ? `${pad}  if (!__rt.isA(${v}, ${this.classes(s.catchClasses, env)})) throw ${v};   // R-f-6: a typed catch rethrows other classes\n` : ""}${this.stmts(s.handler, h, ctx, ind + 1)}\n${pad}}`; }
          if (s.fin) t += ` finally {\n${this.stmts(s.fin, env, ctx, ind + 1)}\n${pad}}`;
          out.push(t); break;
        }
      }
    });
    return out.join("\n");
  }

  // ---- views: JSX, which Solid's compiler (@solidjs/compiler) lowers for the DOM, the server and the test renderer ----
  /** A view: a fragment of children. Text is a string child; `{e}` is `{__rt.show(e)}` (a value is formatted, a view is
   *  inserted); control flow is Solid's components. What is a hole, a scope or a memo is the compiler's to decide. */
  markup(ms: Markup[], env: Env, ind: number): string { return ms.length ? `<>${ms.map(m => this.child(m, env, ind)).join("")}</>` : "null"; }   // an empty view is null, not `<></>` (an empty array loses its slot in the universal renderer: DV-13)
  /** A region's body as a child: its declarations, then its view (a function body, so it is owned where it is called). */
  private regionFn(decls: Decl[], view: Markup[], env: Env, ind: number, param = "", bind?: (e: Env) => string): string {
    const pad = " ".repeat(ind * 2);
    const inner = new Env(env); const pre = bind ? bind(inner) : "";
    return `(${param}) => {\n${pre}${this.block(decls, view, inner, ind + 1)}\n${pad}}`;
  }
  private region(decls: Decl[], view: Markup[], env: Env, ind: number): string { return `{(${this.regionFn(decls, view, env, ind)})()}`; }
  private attr(name: string, e: Expr, env: Env): string { return name === "..." ? `{...${this.expr(e, env, { imp: false })}}` : `${name}={${this.expr(e, env, { imp: isHandler(name) })}}`; }   // 07 §4: a spread is Solid's
  private child(m: Markup, env: Env, ind: number): string {
    const re: Ctx = { imp: false };
    const pad = " ".repeat((ind + 1) * 2);
    switch (m.k) {
      case "text": return `{${J(m.s)}}`;
      case "style": return "";                                                                 // CSS-4: removed; the stylesheet is the module's
      case "read": return `{__rt.show(${this.expr(m.e, env, re)})}`;
      case "el": {
        if (m.tag === "") return this.markup(m.children, env, ind);
        if (/^[A-Z]/.test(m.tag)) {
          const b = env.lookup(m.tag); if (b?.kind !== "comp") throw new CompileError(`unknown component ${m.tag}`);
          const attrs = m.attrs.map(a => " " + this.attr(a.name, a.e, env)).join("");
          return m.children.length ? `<${b.js}${attrs}>${m.children.map(c => this.child(c, env, ind + 1)).join("")}</${b.js}>` : `<${b.js}${attrs} children={[]} />`;
        }
        let attrs = m.attrs.map(a => " " + (a.name === "class" && this.styleHash ? `class={${a.e.k === "lit" && typeof a.e.v === "string" ? J(`${a.e.v} ${this.styleHash}`) : `__rt.scopedClass(${this.expr(a.e, env, { imp: false })}, ${J(this.styleHash)})`}}` : this.attr(a.name, a.e, env))).join("");
        if (this.styleHash && !m.attrs.some(a => a.name === "class")) attrs += ` class=${J(this.styleHash)}`;   // CSS-2: every HTML element of the view
        return VOID_TAGS.has(m.tag) ? `<${m.tag}${attrs} />` : `<${m.tag}${attrs}>${m.children.map(c => this.child(c, env, ind + 1)).join("")}</${m.tag}>`;
      }
      case "mif": {
        const narrowed = m.c.k === "id" ? env.lookup(m.c.name) : undefined;
        const t = this.regionFn(m.tDecls, m.t, env, ind + 1, "__item", e => { if (m.c.k === "id" && narrowed && (narrowed.kind === "acc" || narrowed.kind === "src")) { e.vars.set(m.c.name, { kind: "acc", js: `n$${m.c.name}`, w: narrowed.w }); return `${pad}  const n$${m.c.name} = __item;\n`; } return ""; });
        return `<Show when={${this.expr(m.c, env, re)}} fallback={(${this.regionFn(m.fDecls, m.f, env, ind + 1)})()}>{${t}}</Show>`;
      }
      case "mfor": {
        const body = this.regionFn(m.decls, m.body, env, ind + 1, mg(m.name), e => { e.vars.set(m.name, { kind: "val", js: mg(m.name) }); return ""; });
        return `<For each={${this.expr(m.xs, env, re)}}>{${body}}</For>`;
      }
      case "loading": {
        const on = m.on ? ` on={${this.expr(m.on, env, re)}}` : "";
        return `<Loading${on} fallback={${this.markup(m.fallback, env, ind + 1)}}>${this.region(m.decls, m.body, env, ind + 1)}</Loading>`;
      }
      case "portal": {                                                                          // RG-8: Solid's Portal (the web's, or the test renderer's)
        const to = m.to ? ` mount={${this.expr(m.to, env, re)}}` : "";
        return `<__rt.Portal${to}>${this.region(m.decls, m.body, env, ind + 1)}</__rt.Portal>`;
      }
      case "errored": {
        const fbEnv = new Env(env); if (m.errName) fbEnv.vars.set(m.errName, { kind: "acc", js: mg(m.errName) });
        const fallback = `fallback={(${m.errName ? mg(m.errName) : "__err"}) => ${this.markup(m.fallback, fbEnv, ind + 1)}}`;
        const body = this.region(m.decls, m.body, env, ind + 1);
        return m.classes ? `<__rt.TypedErrored classes={${this.classes(m.classes, env)}} ${fallback}>${body}</__rt.TypedErrored>` : `<Errored ${fallback}>${body}</Errored>`;   // R-f-4: a typed boundary passes other classes up
      }
    }
  }
}
