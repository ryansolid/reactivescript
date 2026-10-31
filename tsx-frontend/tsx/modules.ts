// Load TSX and RX into the same dependency-ordered module set and checker.
import { parseSync } from "oxc-parser/src-js/index";
import { parseProgram, parseDeclarations, ParseError, type JsDecl } from "./rx/compiler.ts";
import { joinPath, type ModuleSet } from "./rx/compiler.ts";
import type { Program } from "./rx/ast.ts";
import { lowerTsx, TsxError } from "./lower.ts";

/** File extensions are explicit, just as they are for the RX module loader. */
export function loadTsxModules(entry: string, read: (path: string) => string | undefined): ModuleSet {
  entry = joinPath("", entry);
  const programs = new Map<string, Program>();
  const order: string[] = [];
  const diags: ModuleSet["diags"] = [];
  const declarations = new Map<string, JsDecl[]>();
  const state = new Map<string, "busy" | "done">();
  const sources = new Map<string, string | undefined>();
  const sourceOf = (path: string) => {
    if (!sources.has(path)) sources.set(path, read(path));
    return sources.get(path);
  };
  const isModule = (path: string) => /\.(rx|tsx)$/.test(path);
  const jsDeclaration = (path: string, from: string) => {
    if (!from.startsWith(".")) return;
    const key = joinPath(path, from.replace(/\.(m?js|ts)$/, "") + ".d.rx");
    const text = sourceOf(key);
    if (text === undefined) return;
    if (!declarations.has(key)) {
      try { declarations.set(key, parseDeclarations(text)); }
      catch (e) { if (e instanceof ParseError) throw new ParseError(key + ": " + e.message); throw e; }
    }
    return key;
  };
  const visit = (path: string, stack: string[]): void => {
    if (state.get(path) === "done") return;
    const source = sourceOf(path);
    if (source === undefined) return;
    if (!isModule(path)) throw new Error("Expected an explicit .tsx or .rx module: " + path);
    state.set(path, "busy");
    let program: Program | undefined;
    let imports: { from: string; line: number }[];
    if (path.endsWith(".tsx")) {
      const parsed = parseSync(path, source, { sourceType: "module", lang: "tsx" });
      if (parsed.errors.length) {
        const error = parsed.errors[0];
        throw new TsxError(path, source, error.labels[0] ?? { start: 0, end: 0 }, error.message);
      }
      imports = parsed.program.body.flatMap(n => n.type === "ImportDeclaration"
        ? [{ from: n.source.value, line: source.slice(0, n.start).split("\n").length }] : []);
    } else {
      try { program = parseProgram(source); }
      catch (e) { if (e instanceof ParseError) throw new ParseError(path + ": " + e.message); throw e; }
      imports = program.decls.flatMap(d => d.k === "import" ? [{ from: d.from, line: d.line }] : []);
    }
    const modules = new Map<string, { path: string; program: Program }>();
    const jsDeclarations = new Map<string, JsDecl[]>();
    const before = diags.length;
    for (const imp of imports) {
      if (!isModule(imp.from)) {
        const key = jsDeclaration(path, imp.from);
        if (key) jsDeclarations.set(imp.from, declarations.get(key)!);
        continue;
      }
      const to = joinPath(path, imp.from);
      if (state.get(to) === "busy") {
        diags.push({ code: "MODULE_CYCLE", rule: "MO-5", file: path, line: imp.line,
          msg: [...stack, path, to].join(" -> ") + ": modules may not import each other in a cycle" });
      } else if (sourceOf(to) === undefined) {
        diags.push({ code: "MODULE_NOT_FOUND", rule: "MO-6", file: path, line: imp.line,
          msg: "no module " + imp.from + " (from " + path + ")" });
      } else {
        visit(to, [...stack, path]);
        const dependency = programs.get(to);
        if (dependency) modules.set(imp.from, { path: to, program: dependency });
      }
    }
    // Never lower an incomplete graph as though its imports were ordinary JS.
    if (diags.length !== before || imports.some(imp => isModule(imp.from) && !modules.has(imp.from))) {
      state.set(path, "done"); return;
    }
    if (!program) program = lowerTsx(source, path, { modules, declarations: jsDeclarations });
    for (const d of program.decls) {
      if (d.k !== "import") continue;
      if (isModule(d.from)) { d.resolved = joinPath(path, d.from); continue; }
      const key = jsDeclaration(path, d.from);
      if (!key) continue;
      const ds = declarations.get(key)!;
      d.declared = key;
      d.declaredErrors = ds.filter(x => x.kind === "error").map(x => x.name);
      d.declaredPure = ds.filter(x => x.kind === "fn" && x.pure).map(x => x.name);
      d.declaredSide = Object.fromEntries(ds.flatMap(x => x.kind === "fn" && x.side ? [[x.name, x.side]] : []));
    }
    programs.set(path, program);
    state.set(path, "done");
    order.push(path);
  };
  if (sourceOf(entry) === undefined) diags.push({ code: "MODULE_NOT_FOUND", rule: "MO-6", file: entry, line: 1, msg: "no entry module " + entry });
  else visit(entry, []);
  return { entry, programs, order, diags, declarations };
}
