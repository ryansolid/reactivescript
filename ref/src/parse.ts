// Hand-rolled scanner/parser for the abstract syntax (spec/02-core.md §1).
import type { Decl, Expr, Markup, Param, Program, Stmt, Target } from "./ast.ts";

/** A parse error; `code` names the habit it looks like when `hint` recognises one (guide/diagnostics.md), else `PARSE`. */
export class ParseError extends Error { code = "PARSE"; }

const JS_APIS = /\b(useState|useReducer|useMemo|useCallback|useEffect|useRef|createSignal|createMemo|createEffect|createStore|createResource|createAsync)\s*\(/;
/** What a parse failure at `i` most likely meant, when the line reads like JavaScript, React or Solid: `[code, text]`.
 *  `src/parse.rs` `hint` is the same function. */
export function hint(src: string, i: number, msg: string): [string, string] | null {
  const rest = src.slice(i);
  const at = rest.length && !/^\s*$/.test(rest.split("\n")[0]) ? i : src.slice(0, i).trimEnd().length - 1;
  const p = Math.max(0, at);
  const lineStart = (k: number) => src.slice(0, k).lastIndexOf("\n") + 1;
  const line = src.slice(lineStart(p), (src.indexOf("\n", p) + 1 || src.length + 1) - 1).trim();
  const before = src.slice(lineStart(i), i);
  const name = /([A-Za-z_$][A-Za-z0-9_$.]*)\s*$/.exec(before)?.[1] ?? "x";
  if (msg.startsWith("W-2") && rest.startsWith(":=") && /=>\s*[A-Za-z_$][A-Za-z0-9_$.]*\s*$/.test(before))
    return ["REACTIVE_WRITE_IN_OWNED_SCOPE", `an arrow that writes takes a braced body, \`() => { ${name} := … }\`: an expression-bodied arrow is a pure function (SC-3)`];
  if (/^(\+\+|--|(\*\*|\|\||&&|\?\?|[-+*\/%])=|=(?![=>]))/.test(rest))
    return ["ASSIGNMENT", `a source is written with \`:=\`, as a statement in a handler or action: \`${name} := ${name} + 1\`, or \`${name} := v => v + 1\` (W-1, W-6); .rx has no \`=\`, \`+=\` or \`++\` on state`];
  if (/^(export\s+)?(default\s+)?(async\s+)?function\b/.test(line))
    return ["JS_FUNCTION", "`function` is not .rx: a pure function is `fn f(x) => …`, one that writes or awaits is `action f(x) { … }`, one that renders is `component F(props) { … }`"];
  const local = /^(const|let|var)\b/.exec(line);
  if (local)
    return ["JS_LOCAL", `\`${local[1]}\` declares a local only in a handler or action body: in a component or at a module's top level, state is \`source x := …\` and a value computed from others is an equation, \`x = …\``];
  if (/^return\b/.test(line))
    return ["JS_RETURN", "a component has no `return`: its body is declarations, then its markup"];
  const api = JS_APIS.exec(line);
  if (api)
    return ["JS_API", `\`${api[1]}\` is not .rx: state is \`source x := …\`, a value computed from others is \`x = …\`, a side effect is \`effect (x) { … }\``];
  return null;
}
let viewAt = 0;
/** The offset where a program's view begins (after its last declaration) — for tools that edit programs. */
export function viewStart(src: string): number { parseProgram(src); return viewAt; }

class Cursor {
  i = 0;
  src: string;
  constructor(src: string) { this.src = src; }
  get line() { return this.src.slice(0, this.i).split("\n").length; }
  eof() { return this.i >= this.src.length; }
  peek(n = 0) { return this.src[this.i + n] ?? ""; }
  ws(newlines = true) {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) this.i++;
      else if (c === "/" && this.peek(1) === "/") { while (!this.eof() && this.peek() !== "\n") this.i++; }
      else if (c === "/" && this.peek(1) === "*") { const j = this.src.indexOf("*/", this.i + 2); this.i = j < 0 ? this.src.length : j + 2; }
      else break;
    }
  }
  startsWith(s: string) { return this.src.startsWith(s, this.i); }
  eat(s: string) { if (this.startsWith(s)) { this.i += s.length; return true; } return false; }
  expect(s: string) { if (!this.eat(s)) this.fail(`expected '${s}'`); }
  fail(msg: string): never {
    const h = hint(this.src, this.i, msg);
    const near = this.src.slice(this.i, this.i + 20).split("\n")[0];
    const e = new ParseError(`line ${this.line}: ${msg} ${near.trim() ? `near '${near}'` : "at the end of the line"}${h ? ` — ${h[1]}` : ""}`);
    if (h) e.code = h[0];
    throw e;
  }
  ident(): string | null {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.src.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }
  tagName(): string | null {                                          // JSX names: `my-element`, `data-id`, `on:click`
    const m = /^[A-Za-z_$][A-Za-z0-9_$:.-]*/.exec(this.src.slice(this.i));
    if (!m) return null; this.i += m[0].length; return m[0];
  }
  peekIdent(): string | null {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.src.slice(this.i));
    return m ? m[0] : null;
  }
  keyword(k: string) {
    const save = this.i;
    if (this.ident() === k && !/[A-Za-z0-9_$]/.test(this.peek())) return true;
    this.i = save; return false;
  }
}

/** A TypeScript type, kept as text: balanced up to a depth-0 stop (`=`, `:=`, `,`, `)`, `=>`, `{` when `braceStops`). 07 §2. */
/** A type's text, up to where the declaration goes on. `=>` inside brackets is a function type, as it is anywhere in a
 *  type alias (`arrows`); elsewhere at the top it starts a body (`fn f(): T => …`). */
function parseType(c: Cursor, braceStops = false, arrows = false): string {
  const start = c.i; let depth = 0;
  while (!c.eof()) {
    const ch = c.peek();
    if (c.startsWith("=>") && (depth > 0 || arrows)) { c.i += 2; continue; }
    if (depth === 0) {
      if (c.startsWith("//") || c.startsWith("=>") || c.startsWith(":=") || ch === "=" || ch === "," || ch === ")" || ch === ";" || ch === "\n" || (braceStops && ch === "{")) break;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    c.i++;
  }
  const t = c.src.slice(start, c.i).trim(); if (!t) c.fail("type"); return t;
}
/** `x: T key k = …` (ST-4): the type ends where the key begins (found by the type layer: the key was read as type text). */
function splitKey(type: string | undefined): { type?: string; key?: string } { const m = type ? /^([\s\S]*?)\s+key\s+([A-Za-z_$][\w$]*)$/.exec(type) : null; return m ? { type: m[1], key: m[2] } : { type }; }
function optType(c: Cursor, braceStops = false): string | undefined { c.ws(false); if (c.peek() === ":" && c.peek(1) !== "=") { c.i++; c.ws(); return parseType(c, braceStops); } return undefined; }

/** R-f: `A | B` — error class names. `Error` (or TS's `unknown`/`any`) is every failure: undefined. */
function parseClasses(c: Cursor): string[] | undefined {
  const out: string[] = [];
  for (;;) { c.ws(); out.push(c.ident() ?? c.fail("error class")); c.ws(false); if (c.peek() === "|" && c.peek(1) !== "|") { c.i++; continue; } break; }
  return out.some(n => n === "Error" || n === "unknown" || n === "any") ? undefined : out;
}

const KEYWORDS = new Set(["source", "effect", "component", "ref", "await", "latest", "loading", "errored", "fallback", "on", "deferred", "action", "guess", "refresh", "affects", "if", "else", "pre", "peek", "fn", "let", "for", "in", "true", "false", "undefined", "null", "provide", "context", "use", "import", "export", "from", "pure", "return", "type", "interface", "try", "catch", "finally", "throw", "portal"]);

export function parseProgram(src: string): Program {
  const c = new Cursor(src);
  const decls: Decl[] = [];
  c.ws();
  while (!c.eof() && looksLikeDecl(c)) { decls.push(parseDecl(c)); c.ws(); c.eat(";"); c.ws(); }
  viewAt = c.i;
  const view = parseMarkup(c, null);
  c.ws();
  if (!c.eof()) c.fail("expected a declaration or markup");
  const dflt = decls.filter(d => d.k === "component" && d.isDefault);
  if (dflt.length > 1) c.fail("two default components: a module has one entry");
  if (view.length === 0 && dflt.length) return { decls, view: [{ k: "el", tag: (dflt[0] as { name: string }).name, attrs: [], children: [], line: dflt[0].line }] };   // MO-1c: the mounted view is the default component, applied
  return { decls, view, legacyView: view.length > 0 };
}

/** MO-8: a declaration file (`api.d.rx`) for a JS module — what each export is, in rows: `export pure fn f(a) rejects(A | B)`,
 *  `export fn g(a)` (io: dirty is the default, R-io-4), `export error NotFound` (a JS class that is an error class), `export type T`. */
export type JsDecl =
  | { kind: "fn"; name: string; pure: boolean; params: string[]; rejects?: string[]; line: number; side?: "server" | "client"; ptypes?: (string | undefined)[]; ret?: string }   // side: 12 SF-5; types: text, for TY (types/)
  | { kind: "error"; name: string; line: number }
  | { kind: "type"; name: string; line: number; text?: string };
export function parseDeclarations(src: string): JsDecl[] {
  const c = new Cursor(src); const out: JsDecl[] = [];
  for (;;) {
    c.ws(); if (c.eof()) return out;
    const line = c.line;
    if (!c.keyword("export")) c.fail("a declaration file declares exports: `export pure fn …`, `export fn …`, `export error …`, `export type …`");
    c.ws();
    if (c.startsWith("type") || c.startsWith("interface")) { const t0 = c.i; c.keyword("type") || c.keyword("interface"); c.ws(); const name = c.ident() ?? c.fail("type name"); c.ws(); if (c.eat("=")) { c.ws(); parseType(c, false, true); } else if (c.startsWith("{")) { let depth = 0; do { if (c.peek() === "{") depth++; if (c.peek() === "}") depth--; c.i++; } while (!c.eof() && depth); } out.push({ kind: "type", name, line, text: c.src.slice(t0, c.i) }); continue; }
    if (c.keyword("error")) { c.ws(); const name = c.ident() ?? c.fail("error class name"); out.push({ kind: "error", name, line }); continue; }
    const side = c.keyword("server") ? "server" as const : c.keyword("client") ? "client" as const : undefined; c.ws();   // 12 SF-5: runs on one side only
    const pure = c.keyword("pure"); c.ws();
    if (!c.keyword("fn")) c.fail("fn");
    c.ws(); const name = c.ident() ?? c.fail("fn name"); c.ws(); c.expect("("); c.ws();
    const params: string[] = []; const ptypes: (string | undefined)[] = [];
    while (!c.startsWith(")")) { params.push(c.ident() ?? c.fail("param")); ptypes.push(optType(c)); c.ws(); if (!c.eat(",")) break; c.ws(); }
    c.expect(")");
    const save = c.i; c.ws(false); let ret: string | undefined;
    if (c.peek() === ":" ) { c.i++; c.ws(); const t = c.src.slice(c.i).split("\n")[0]; const r = /\brejects\(/.exec(t); ret = (r ? t.slice(0, r.index) : t).replace(/\/\/.*$/, "").trim() || undefined; c.i += r ? r.index : t.length; } else c.i = save;
    c.ws(false); let rejects: string[] | undefined;
    if (c.keyword("rejects")) { c.ws(); c.expect("("); rejects = parseClasses(c) ?? ["Error"]; c.ws(); c.expect(")"); }
    out.push({ kind: "fn", name, pure, params, rejects, line, ptypes, ret, ...(side ? { side } : {}) });
  }
}

function parseDecl(c: Cursor): Decl {
  c.ws();
  const line = c.line;
  if (c.keyword("export")) { c.ws();
    if (c.keyword("default")) { c.ws(); const d = parseDecl(c); if (d.k !== "component") c.fail("export default: only a component is a module's default export (the app's entry, MO-1c)"); d.exported = true; d.isDefault = true; return d; }
    const d = parseDecl(c); if (d.k === "import" || d.k === "effect" || d.k === "provide") c.fail("export of a non-declaration"); (d as { exported?: boolean }).exported = true; return d; }
  if (c.keyword("import")) {                                           // 07 §1: `import pure? { a, b as c } from "m"` / `import X from "m"`
    c.ws(); const side = /^(server|client)\s+(pure\b|\{)/.test(c.src.slice(c.i)) ? (c.keyword("server") ? "server" as const : (c.keyword("client"), "client" as const)) : undefined; c.ws();   // 12 SF-5: `import server pure { q }`
    const pure = c.keyword("pure"); c.ws();
    const names: { name: string; alias: string }[] = [];
    if (c.eat("{")) { c.ws(); while (!c.startsWith("}")) { const name = c.ident() ?? c.fail("import name"); c.ws(); let alias = name; if (c.keyword("as")) { c.ws(); alias = c.ident() ?? c.fail("alias"); c.ws(); } names.push({ name, alias }); if (!c.eat(",")) break; c.ws(); } c.expect("}"); }
    else { const name = c.ident() ?? c.fail("import name"); names.push({ name: "default", alias: name }); }
    c.ws(); if (!c.keyword("from")) c.fail("from"); c.ws();
    const from = parsePrimary(c); if (from.k !== "lit" || typeof from.v !== "string") c.fail("module path");
    const save = c.i; c.ws(false);
    const sd = side ? { side } : {};
    if (c.keyword("fails")) { c.ws(); const fails = parseClasses(c) ?? ["Error"]; return { k: "import", names, from: from.v, pure, line, fails, ...sd }; }   // R-f-8
    c.i = save;
    return { k: "import", names, from: from.v, pure, line, ...sd };
  }
  if (/^error\s+[A-Z]/.test(c.src.slice(c.i))) {                     // R-f-1: `error NotFound(id: number) => \`no user ${id}\``
    c.keyword("error"); c.ws(); const name = c.ident() ?? c.fail("error class name"); c.ws(false);
    const params: string[] = []; const ptypes: (string | undefined)[] = [];
    if (c.eat("(")) { c.ws(); while (!c.startsWith(")")) { params.push(c.ident() ?? c.fail("field")); ptypes.push(optType(c)); c.ws(); if (!c.eat(",")) break; c.ws(); } c.expect(")"); }
    const save = c.i; c.ws(false);
    if (c.eat("=>")) { c.ws(); return { k: "error", name, params, ptypes, msg: parseExpr(c), line }; }
    c.i = save;
    return { k: "error", name, params, ptypes, line };
  }
  if (/^(type|interface)\b/.test(c.src.slice(c.i))) {                // a TS type declaration: kept as text, not a binding
    const t0 = c.i; c.keyword("type") || c.keyword("interface");
    c.ws(); const name = c.ident() ?? c.fail("type name"); c.ws();
    if (c.eat("=")) { c.ws(); parseType(c, false, true); } else { c.expect("{"); let depth = 1; while (!c.eof() && depth) { if (c.peek() === "{") depth++; if (c.peek() === "}") depth--; c.i++; } }
    return { k: "typedecl", name, line, text: c.src.slice(t0, c.i) };
  }
  if (c.keyword("source")) {
    c.ws(); const name = c.ident() ?? c.fail("source name"); const tk = splitKey(optType(c)); const type = tk.type; c.ws();
    let key: string | undefined = tk.key;
    if (/^key\s+[A-Za-z_$][\w$]*\s*(=|:=)[^=>]/.test(c.src.slice(c.i))) { c.keyword("key"); c.ws(); key = c.ident() ?? c.fail("key name"); c.ws(); }   // ST-4a on a source
    if (c.eat(":=")) { c.ws(); return { k: "source", name, init: parseExpr(c), line, type, key }; }
    c.expect("="); c.ws();
    return { k: "source", name, init: parseExpr(c), line, question: true, type, key };   // ST-5: a source with a standing question
  }
  if (c.keyword("effect")) {
    c.ws(); c.expect("("); c.ws();
    const inputs: Expr[] = [];
    while (!c.startsWith(")")) { inputs.push(parseExpr(c)); c.ws(); if (!c.eat(",")) break; c.ws(); }
    c.expect(")"); c.ws();
    return { k: "effect", inputs, body: parseBlock(c), line };
  }
  if (c.keyword("deferred")) {
    c.ws(); const name = c.ident() ?? c.fail("deferred name"); const type = optType(c); c.ws(); c.expect("="); c.ws();
    return { k: "eq", name, e: parseExpr(c), line, deferred: true, type };
  }
  if (c.keyword("action")) {
    c.ws(); const name = c.ident() ?? c.fail("action name"); c.ws(); c.expect("("); c.ws();
    const params: string[] = []; const ptypes: (string | undefined)[] = [];
    while (!c.startsWith(")")) { params.push(c.ident() ?? c.fail("param")); ptypes.push(optType(c)); c.ws(); if (!c.eat(",")) break; c.ws(); }
    c.expect(")"); c.ws();
    return { k: "action", name, params, ptypes, body: parseBlock(c), line };
  }
  if (/^server\s+(fn|action)\b/.test(c.src.slice(c.i))) {             // 12 SF-1: `server fn f(a) { … }`
    c.keyword("server"); c.ws(); if (c.keyword("action")) c.fail("`server fn` (SF-1: one form — it is io when its body is; there is no `server action`)"); c.keyword("fn");
    c.ws(); const name = c.ident() ?? c.fail("server function name"); c.ws(); c.expect("("); c.ws();
    const params: string[] = []; const ptypes: (string | undefined)[] = [];
    while (!c.startsWith(")")) { params.push(c.ident() ?? c.fail("param")); ptypes.push(optType(c)); c.ws(); if (!c.eat(",")) break; c.ws(); }
    c.expect(")"); const ret = optType(c, true); c.ws();
    return { k: "server", name, params, ptypes, ret, body: parseBlock(c), line };
  }
  if (c.keyword("context")) {                                         // RG-7: `context name: [source] Type [= default]`
    c.ws(); const name = c.ident() ?? c.fail("context name"); c.ws(false);
    let type: string | undefined; let source = false;
    if (c.peek() === ":" && c.peek(1) !== "=") { c.i++; c.ws(); source = c.keyword("source"); c.ws(); type = parseType(c); }
    const save = c.i; c.ws(false);
    if (c.peek() === "=" && c.peek(1) !== "=" && c.peek(1) !== ">") { c.i++; c.ws(); return { k: "context", name, type, source, dflt: parseExpr(c), line }; }
    c.i = save;
    return { k: "context", name, type, source, line };
  }
  if (c.keyword("provide")) { c.ws(); const name = c.ident() ?? c.fail("provide name"); c.ws(); c.expect("="); c.ws(); return { k: "provide", name, e: parseExpr(c), line }; }
  if (c.keyword("fn")) {
    c.ws(); const name = c.ident() ?? c.fail("fn name"); c.ws(); c.expect("("); c.ws();
    const params: Param[] = [];
    while (!c.startsWith(")")) { const ref = c.keyword("ref"); c.ws(); const pname = c.ident() ?? c.fail("param"); const type = optType(c); params.push({ name: pname, ref, type }); c.ws(); if (!c.eat(",")) break; c.ws(); }
    c.expect(")"); const ret = optType(c, true); c.ws();
    if (c.eat("=>")) { c.ws(); return { k: "fn", name, params, decls: [], tail: parseExpr(c), line, ret }; }
    c.expect("{");
    const decls: Decl[] = [];
    for (;;) { c.ws(); if (!looksLikeDecl(c)) break; decls.push(parseDecl(c)); c.ws(); c.eat(";"); }
    c.ws(); const tail = parseExpr(c); c.ws(); c.expect("}");
    return { k: "fn", name, params, decls, tail, line, ret };
  }
  if (c.keyword("component")) {
    c.ws(); const name = c.ident() ?? c.fail("component name"); c.ws(); c.expect("("); c.ws();
    const props = c.peek() === ")" ? "props" : (c.ident() ?? c.fail("props name")); const propsType = optType(c); c.ws(); c.expect(")"); c.ws(); c.expect("{");   // `component C()`: no props (found by S-ai2-tracker)
    const { decls, body } = parseBlockBody(c);
    return { k: "component", name, props, decls, view: body, line, propsType };
  }
  const save = c.i;
  const name = c.ident();
  c.ws(false);
  let key: string | undefined; let type: string | undefined;
  if (name && !KEYWORDS.has(name)) { const tk = splitKey(optType(c)); type = tk.type; key = tk.key; c.ws(false); }
  if (name && !KEYWORDS.has(name) && /^key\s+[A-Za-z_$][\w$]*\s*=[^=>]/.test(c.src.slice(c.i))) { c.keyword("key"); c.ws(); key = c.ident() ?? c.fail("key name"); c.ws(false); }   // ST-4: `x key k = e`
  if (name && !KEYWORDS.has(name) && c.peek() === "=" && c.peek(1) !== "=" && c.peek(1) !== ">") {
    c.i++; c.ws();
    return { k: "eq", name, e: parseExpr(c), line, key, type };
  }
  c.i = save;
  if (c.peekIdent() && /^[A-Za-z_$][A-Za-z0-9_$.\[\]]*\s*:=/.test(c.src.slice(c.i)))
    c.fail("W-2: write in reactive scope (no statement position)");
  c.fail("declaration");
}

export function parseBlock(c: Cursor): Stmt[] {
  c.ws(); c.expect("{"); c.ws();
  const out: Stmt[] = [];
  while (!c.startsWith("}")) { out.push(parseStmt(c)); c.ws(); c.eat(";"); c.ws(); }
  c.expect("}");
  return out;
}

export function parseStmts(src: string): Stmt[] {
  const c = new Cursor(src);
  const out: Stmt[] = [];
  c.ws();
  while (!c.eof()) { out.push(parseStmt(c)); c.ws(); c.eat(";"); c.ws(); }
  return out;
}

function parseStmt(c: Cursor): Stmt {
  c.ws();
  if (c.keyword("guess")) {
    c.ws(); const name = c.ident() ?? c.fail("target"); const path: Target["path"] = [];
    for (;;) { if (c.eat(".")) path.push(c.ident() ?? c.fail("member")); else if (c.eat("[")) { c.ws(); path.push(parseExpr(c)); c.ws(); c.expect("]"); } else break; }
    c.ws(); c.expect(":="); c.ws(); return { k: "optimistic", target: { name, path }, e: parseExpr(c) };
  }
  if (c.keyword("refresh")) { c.ws(); return { k: "refresh", name: c.ident() ?? c.fail("name") }; }
  if (c.keyword("affects")) { c.ws(); return { k: "affects", name: c.ident() ?? c.fail("name") }; }
  if (c.keyword("action")) { c.ws(); return { k: "action", body: parseBlock(c) }; }
  if (c.keyword("let") || c.keyword("const")) { c.ws(); const name = c.ident() ?? c.fail("let name"); const type = optType(c); c.ws(); c.expect("="); c.ws(); return { k: "let", name, e: parseExpr(c), type }; }
  if (c.keyword("try")) {                                              // AC-7
    c.ws(); const body = parseBlock(c); c.ws();
    let catchName: string | undefined, handler: Stmt[] | undefined, fin: Stmt[] | undefined;
    let catchClasses: string[] | undefined;
    if (c.keyword("catch")) { c.ws(); if (c.eat("(")) { c.ws(); catchName = c.ident() ?? c.fail("catch name"); c.ws(false); if (c.eat(":")) catchClasses = parseClasses(c); c.ws(); c.expect(")"); } c.ws(); handler = parseBlock(c); c.ws(); }
    if (c.keyword("finally")) { c.ws(); fin = parseBlock(c); }
    if (!handler && !fin) c.fail("catch or finally");
    return { k: "try", body, catchName, catchClasses, handler, fin };
  }
  if (c.keyword("throw")) { c.ws(); return { k: "throw", e: parseExpr(c) }; }
  if (c.keyword("return")) { c.ws(false); if (c.peek() === "}" || c.peek() === ";" || c.peek() === "\n" || c.eof()) return { k: "return" }; return { k: "return", e: parseExpr(c) }; }
  if (c.keyword("if")) {                                               // imperative `if (c) { … } else { … }`
    c.ws(); c.expect("("); c.ws(); const cond = parseExpr(c); c.ws(); c.expect(")"); c.ws();
    const t = c.peek() === "{" ? parseBlock(c) : [parseStmt(c)]; c.ws();
    let f: Stmt[] = [];
    if (c.keyword("else")) { c.ws(); f = c.peek() === "{" ? parseBlock(c) : [parseStmt(c)]; }
    return { k: "sif", c: cond, t, f };
  }
  // write?  target := expr
  const save = c.i;
  let name = c.ident();
  let ctx = false;
  if (name === "use") { c.ws(); name = c.ident() ?? c.fail("provision name"); ctx = true; }   // `use p := e`: a write through a provision (O-4, RG-7)
  if (name && (!KEYWORDS.has(name) || ctx)) {
    const path: Target["path"] = [];
    for (;;) {
      if (c.eat(".")) path.push(c.ident() ?? c.fail("member"));
      else if (c.eat("[")) { c.ws(); path.push(parseExpr(c)); c.ws(); c.expect("]"); }
      else break;
    }
    c.ws(false);
    if (c.eat(":=")) { c.ws(); return { k: "write", target: { name, path, ctx }, e: parseExpr(c) }; }
  }
  c.i = save;
  return { k: "expr", e: parseExpr(c) };
}

// ---- expressions ----
/** An expression, with any trailing `catch (x: A | B) => alt` (R-f-4): looser than every operator, so the conditional's arms stop before it. */
export function parseExpr(c: Cursor): Expr {
  let e = parseExprNoCatch(c);
  for (;;) {
    const save = c.i; c.ws();
    if (!c.keyword("catch")) { c.i = save; return e; }
    c.ws(); let name: string | undefined, classes: string[] | undefined;
    if (c.eat("(")) { c.ws(); name = c.ident() ?? c.fail("catch name"); c.ws(false); if (c.eat(":")) classes = parseClasses(c); c.ws(); c.expect(")"); c.ws(); }
    c.expect("=>"); c.ws();
    e = { k: "catch", e, name, classes, alt: parseExprNoCatch(c) };
  }
}
function parseExprNoCatch(c: Cursor): Expr {
  c.ws();
  if (c.startsWith("draft") && /^draft\s*\(/.test(c.src.slice(c.i)) && (() => {   // ST-3: `draft(e) { d.k := v }` — contextual: only with a block after the parens
    let i = c.i + 5, depth = 0; while (i < c.src.length) { const ch = c.src[i]; if (ch === "(") depth++; else if (ch === ")") { depth--; if (depth === 0) break; } i++; }
    return /^\s*\{/.test(c.src.slice(i + 1));
  })()) {
    c.keyword("draft"); c.ws(); c.expect("("); c.ws(); const seed = parseExpr(c); c.ws(); c.expect(")"); c.ws();
    return { k: "draft", seed, body: parseBlock(c) };
  }
  {                                                                   // 07 §3: TS arrow functions, verbatim — `x => e`, `(a, b) => e`
    const save = c.i; const params: string[] = []; let ok = false;
    if (c.peek() === "(") { c.i++; c.ws(); ok = true; while (!c.startsWith(")")) { const id = c.ident(); if (!id) { ok = false; break; } params.push(id); c.ws(); if (!c.eat(",")) break; c.ws(); } if (ok && c.eat(")")) { c.ws(false); ok = c.startsWith("=>"); } else ok = false; }
    else { const id = c.ident(); if (id && !KEYWORDS.has(id)) { params.push(id); c.ws(false); ok = c.startsWith("=>"); } }
    if (ok) {
      c.expect("=>"); c.ws();
      if (c.peek() === "{") {                                        // `=> { … }`: a statement body (imperative scope) unless it reads as a record literal
        const at = c.i;
        try { const stmts = parseBlock(c); if (stmts.some(st => !(st.k === "expr" && st.e.k === "id"))) return { k: "fn", params, body: { k: "lit", v: undefined }, stmts }; } catch (e) { if (!(e instanceof ParseError)) throw e; }
        c.i = at;
      }
      return { k: "fn", params, body: parseExpr(c) };
    }
    c.i = save;
  }
  if (c.keyword("fn")) {
    c.ws(); c.expect("("); c.ws(); const params: string[] = [];
    while (!c.startsWith(")")) { params.push(c.ident() ?? c.fail("param")); c.ws(); if (!c.eat(",")) break; c.ws(); }
    c.expect(")"); c.ws(); c.expect("=>"); c.ws();
    return { k: "fn", params, body: parseExpr(c) };
  }
  const cond = parseBin(c, 0);
  c.ws(false);
  if (c.startsWith(":=")) c.fail("W-2: write in reactive scope (no statement position)");   // U: the grammar has no position for a write here
  if (c.peek() === "?" && c.peek(1) !== ".") {                         // E-11: `c ? a : b`, TS verbatim (ruled 2026-10-22: the only spelling)
    c.i++; c.ws(); const t = parseExprNoCatch(c); c.ws(); c.expect(":"); c.ws(); const f = parseExprNoCatch(c);
    return { k: "if", c: cond, t, f };
  }
  return cond;
}

const LEVELS: string[][] = [["??"], ["||"], ["&&"], ["===", "!==", "==", "!="], ["<=", ">=", "<", ">"], ["+", "-"], ["*", "/", "%"]];
const OP_ALIAS: Record<string, string> = { "===": "==", "!==": "!=" };
function parseBin(c: Cursor, lvl: number): Expr {
  if (lvl >= LEVELS.length) return parseUnary(c);
  let l = parseBin(c, lvl + 1);
  for (;;) {
    c.ws(false);
    const op = LEVELS[lvl].find(o => c.startsWith(o) && !(o === "-" && c.peek(1) === ">"));
    if (!op) return l;
    c.i += op.length; c.ws();
    l = { k: "bin", op: OP_ALIAS[op] ?? op, l, r: parseBin(c, lvl + 1) };
  }
}
function parseUnary(c: Cursor): Expr {
  c.ws();
  if (c.eat("!")) return { k: "un", op: "!", e: parseUnary(c) };
  if (c.peek() === "-" && c.peek(1) !== ">") { c.i++; return { k: "un", op: "-", e: parseUnary(c) }; }
  if (c.keyword("pre")) {
    c.ws(); const name = c.ident() ?? c.fail("pre name"); c.ws(false);
    if (c.eat("->")) { c.ws(); return { k: "pre", name, init: parseUnary(c) }; }
    return { k: "pre", name };
  }
  if (c.keyword("peek")) { c.ws(); return { k: "peek", e: parseUnary(c) }; }
  if (c.keyword("await")) {
    const stream = c.eat("*"); c.ws(); const e = parseUnary(c); c.ws(false);   // `await*`: the latest answer of a stream (ST-6b)
    if (c.eat("->")) { c.ws(); return { k: "await", e, init: parseUnary(c), stream }; }
    return { k: "await", e, stream };
  }
  if (c.keyword("latest")) { c.ws(); return { k: "latest", e: parseUnary(c) }; }
  if (c.keyword("throw")) { c.ws(); return { k: "throw", e: parseUnary(c) }; }   // R-f-3: a throw expression (TC39's shape)
  if (c.keyword("use")) { c.ws(); return { k: "use", name: c.ident() ?? c.fail("context name") }; }
  if (c.startsWith("pending?")) { c.i += 8; c.ws(); return { k: "pending", e: parseUnary(c) }; }
  return parsePostfix(c);
}
function parsePostfix(c: Cursor): Expr {
  let e = parsePrimary(c);
  for (;;) {
    if (c.eat("?.")) { if (c.peek() === "[") { c.i++; c.ws(); const i = parseExpr(c); c.ws(); c.expect("]"); e = { k: "index", o: e, i, opt: true }; } else e = { k: "member", o: e, p: c.ident() ?? c.fail("member"), opt: true }; }
    else if (c.eat(".")) e = { k: "member", o: e, p: c.ident() ?? c.fail("member") };
    else if (c.peek() === "[") { c.i++; c.ws(); const i = parseExpr(c); c.ws(); c.expect("]"); e = { k: "index", o: e, i }; }
    else if (c.peek() === "(") {
      c.i++; c.ws(); const args: Expr[] = [];
      while (!c.startsWith(")")) { args.push(parseExpr(c)); c.ws(); if (!c.eat(",")) break; c.ws(); }
      c.expect(")"); e = { k: "call", f: e, args };
    } else return e;
  }
}
function parsePrimary(c: Cursor): Expr {
  c.ws();
  if (/^<style\b/.test(c.src.slice(c.i))) {                           // 07 CSS-5: a stylesheet as a value — its class map
    const line = c.line; c.i += "<style".length; c.ws(); if (!c.eat(">")) c.fail("CSS-5: a class map is `<style>…</style>`, with no attributes");
    const end = c.src.indexOf("</style>", c.i); if (end < 0) c.fail("expected </style>");
    const css = c.src.slice(c.i, end); c.i = end + "</style>".length; return { k: "stylemap", css, line };
  }
  if (/^server\s+fn\s*\(/.test(c.src.slice(c.i))) {                   // 12 SF-1d: an anonymous server fn, for whatever wraps it
    c.keyword("server"); c.ws(); c.keyword("fn"); c.ws(); c.expect("("); c.ws();
    const params: string[] = []; const ptypes: (string | undefined)[] = [];
    while (!c.startsWith(")")) { params.push(c.ident() ?? c.fail("param")); ptypes.push(optType(c)); c.ws(); if (!c.eat(",")) break; c.ws(); }
    c.expect(")"); const ret = optType(c, true); c.ws();
    return { k: "serverfn", params, ptypes, ret, body: parseBlock(c) };
  }
  const ch = c.peek();
  if (ch === "`") {                                                   // template literal
    c.i++; const parts: (string | Expr)[] = []; let s = "";
    while (!c.eof() && c.peek() !== "`") {
      if (c.startsWith("${")) { c.i += 2; if (s) parts.push(s); s = ""; c.ws(); parts.push(parseExpr(c)); c.ws(); c.expect("}"); continue; }
      if (c.peek() === "\\") c.i++;
      s += c.peek(); c.i++;
    }
    c.expect("`"); if (s || !parts.length) parts.push(s); return { k: "tpl", parts };
  }
  if (ch === '"' || ch === "'") {
    c.i++; let s = "";
    while (!c.eof() && c.peek() !== ch) { if (c.peek() === "\\") { c.i++; } s += c.peek(); c.i++; }
    c.expect(ch); return { k: "lit", v: s };
  }
  const num = /^\d[\d_]*(\.\d+)?/.exec(c.src.slice(c.i));
  if (num) { c.i += num[0].length; return { k: "lit", v: Number(num[0].replace(/_/g, "")) }; }
  if (c.eat("(")) { c.ws(); const e = parseExpr(c); c.ws(); c.expect(")"); return e; }
  if (c.eat("[")) {
    c.ws(); const items: Expr[] = [];
    while (!c.startsWith("]")) { if (c.eat("...")) { c.ws(); items.push({ k: "spread", e: parseExpr(c) }); } else items.push(parseExpr(c)); c.ws(); if (!c.eat(",")) break; c.ws(); }
    c.expect("]"); return { k: "arr", items };
  }
  if (c.eat("{")) {
    c.ws(); const fields: ({ key: string; v: Expr } | { spread: Expr })[] = [];
    while (!c.startsWith("}")) {
      if (c.eat("...")) { c.ws(); fields.push({ spread: parseExpr(c) }); c.ws(); if (!c.eat(",")) break; c.ws(); continue; }
      const key = c.ident() ?? (c.peek() === '"' || c.peek() === "'" ? String((parsePrimary(c) as { v: unknown }).v) : c.fail("field")); c.ws();
      if (c.eat(":")) { c.ws(); fields.push({ key, v: parseExpr(c) }); } else fields.push({ key, v: { k: "id", name: key } });
      c.ws(); if (!c.eat(",")) break; c.ws();
    }
    c.expect("}"); return { k: "rec", fields };
  }
  if (c.keyword("true")) return { k: "lit", v: true };
  if (c.keyword("false")) return { k: "lit", v: false };
  if (c.keyword("undefined")) return { k: "lit", v: undefined };
  if (c.keyword("null")) return { k: "lit", v: null };
  const id = c.ident();
  if (id) return { k: "id", name: id };
  c.fail("expression");
}

// ---- markup ----
// Markup continues until `closeTag` is seen (or end of input for top level).
function parseMarkup(c: Cursor, closeTag: string | null): Markup[] {
  const out: Markup[] = [];
  const inElement = closeTag !== null && closeTag !== "}";
  let broke = false;   // JSX whitespace (07: elements are JSX): whitespace that holds a line break is not text — except between two text runs, which it joins with one space
  for (;;) {
    if (inElement) {
      let s = ""; while (!c.eof() && " \t\r\n".includes(c.peek())) { s += c.peek(); c.i++; }
      broke = s.includes("\n");
      if (s && !broke && !c.startsWith(`</${closeTag}>`) && out.length) out.push({ k: "text", s: " " });   // same-line whitespace between nodes is a space
    } else c.ws();
    if (c.eof()) { if (closeTag !== null) c.fail(`expected </${closeTag}>`); return out; }
    if (closeTag !== null && closeTag !== "}" && c.startsWith(`</${closeTag}>`)) { c.i += closeTag.length + 3; return out; }   // `""` is a fragment's close tag
    if (closeTag === "}" && c.startsWith("}")) { c.i++; return out; }
    const line = c.line;                                             // for diagnostics: the line a reader or an application is on
    if (c.startsWith("<")) { out.push({ ...parseElement(c), line }); continue; }
    if (c.startsWith("{")) {
      c.i++; c.ws();
      const ctl = parseControl(c);                                   // `{if …}` / `{for …}` / `{loading …}` inside an element
      if (ctl) { c.ws(); c.expect("}"); out.push({ ...ctl, line }); continue; }
      const e = parseExpr(c); c.ws(); c.expect("}"); out.push({ k: "read", e, line }); continue;
    }
    if (!inElement) { const ctl = parseControl(c); if (ctl) { out.push({ ...ctl, line }); continue; } }
    if (closeTag === null && looksLikeDecl(c)) c.fail("declaration after markup: a block is declarations, then its view");
    // text up to < { } or newline; a line's trailing whitespace is not text (JSX)
    let s = "";
    while (!c.eof() && !"<{}\n".includes(c.peek())) { s += c.peek(); c.i++; }
    if (c.peek() === "\n" || c.eof()) s = s.replace(/[ \t\r]+$/, "");
    if (!inElement) {
      // outside an element, bare text is not markup: a block is declarations, then markup
      if (s.trim() === "") { if (c.peek() === "\n") c.i++; continue; }
      if (s.includes(":=")) c.fail("W-2: write in reactive scope (no statement position)");
      c.fail("expected a declaration or markup");
    }
    if (broke && out.length && out[out.length - 1].k === "text") out.push({ k: "text", s: " " });   // text on two lines: one space between
    if (s) out.push({ k: "text", s });
  }
}
/** Control forms of a view: `if c { … } else { … }`, `for x in e { … }`, `loading … { … }`. Bare at block level, braced inside elements. */
function parseControl(c: Cursor): Markup | null {
  const save = c.i;
  if (c.keyword("if")) {
    c.ws(); const cond = parseExpr(c); c.ws();
    if (!c.startsWith("{")) { c.i = save; return null; }              // `if … then …` is an expression (E-11)
    c.expect("{");
      const t = parseBlockBody(c); c.ws();
      let f: { decls: Decl[]; body: Markup[] } = { decls: [], body: [] };
      if (c.keyword("else")) { c.ws(); c.expect("{"); f = parseBlockBody(c); }
      return { k: "mif", c: cond, t: t.body, tDecls: t.decls, f: f.body, fDecls: f.decls };
  }
  if (c.keyword("loading")) {
      c.ws(); let on: Expr | undefined;
      if (c.keyword("on")) { c.ws(); c.expect("("); c.ws(); on = parseExpr(c); c.ws(); c.expect(")"); c.ws(); }
      if (!c.keyword("fallback")) c.fail("fallback"); c.ws(); c.expect("{");
      const fallback = parseMarkup(c, "}"); c.ws(); c.expect("{");
      const { decls, body } = parseBlockBody(c);
      return { k: "loading", on, fallback, decls, body };
  }
  if (c.keyword("portal")) {                                         // RG-8: `portal { … }` / `portal to(e) { … }`
      c.ws(); let to: Expr | undefined;
      if (c.keyword("to")) { c.ws(); c.expect("("); c.ws(); to = parseExpr(c); c.ws(); c.expect(")"); c.ws(); }
      c.expect("{"); const { decls, body } = parseBlockBody(c);
      return { k: "portal", to, decls, body };
  }
  if (c.keyword("errored")) {
      c.ws(); if (!c.keyword("fallback")) c.fail("fallback"); c.ws(false);
      let errName: string | undefined;
      let classes: string[] | undefined;
      if (c.eat("(")) { c.ws(); errName = c.ident() ?? c.fail("error name"); c.ws(false); if (c.eat(":")) classes = parseClasses(c); c.ws(); c.expect(")"); }   // `fallback(e)` / `fallback(e: A | B)` (R-f-4)
      c.ws(); c.expect("{");
      const fallback = parseMarkup(c, "}"); c.ws(); c.expect("{");
      const { decls, body } = parseBlockBody(c);
      return { k: "errored", fallback, decls, body, errName, classes };
  }
  if (c.keyword("for")) {
      c.ws(); const name = c.ident() ?? c.fail("for name"); c.ws();
      if (!c.keyword("in")) c.fail("in"); c.ws(); const xs = parseExpr(c); c.ws(); c.expect("{");
      const { decls, body } = parseBlockBody(c);
      return { k: "mfor", name, xs, decls, body };
  }
  return null;
}
/** A reactive block body: declarations, then markup, up to the closing `}` (03: any block is decls then view). */
function parseBlockBody(c: Cursor): { decls: Decl[]; body: Markup[] } {
  const decls: Decl[] = [];
  for (;;) {
    c.ws();
    if (!looksLikeDecl(c)) break;
    decls.push(parseDecl(c)); c.ws(); c.eat(";");
  }
  return { decls, body: parseMarkup(c, "}") };
}
function looksLikeDecl(c: Cursor) {
  const save = c.i; c.ws();
  const r = c.startsWith("source ") || c.startsWith("effect") || c.startsWith("fn ") || c.startsWith("component ") || c.startsWith("deferred ") || c.startsWith("action ") || c.startsWith("provide ") || c.startsWith("context ") || c.startsWith("import ") || c.startsWith("export ") || c.startsWith("type ") || c.startsWith("interface ") || /^error\s+[A-Z]/.test(c.src.slice(c.i)) || /^server\s+(fn|action)\b/.test(c.src.slice(c.i)) ||
    (() => { const id = c.ident(); c.ws(false); if (!id || KEYWORDS.has(id)) return false; if (c.peek() === ":" && c.peek(1) !== "=") return true; const ok = (c.peek() === "=" && c.peek(1) !== "=") || /^key\s+[A-Za-z_$][\w$]*\s*=[^=>]/.test(c.src.slice(c.i)); return ok; })();
  c.i = save; return r;
}
function parseElement(c: Cursor): Markup {
  c.expect("<");
  if (c.eat(">")) return { k: "el", tag: "", attrs: [], children: parseMarkup(c, "") };   // fragment `<>…</>`
  const tag = c.tagName() ?? c.fail("tag");
  if (tag === "style") {                                               // 07 §6b CSS-1: a stylesheet is raw text — no `{…}` holes exist
    c.ws(); if (!c.eat(">")) c.fail(c.src.slice(c.i).startsWith("ref") ? "CSS-5: a class map is a declaration, `styles = <style>…</style>` — TSRX's `<style ref={styles}>` assigns into a variable, and a name here is bound once, by its declaration" : "CSS-1: a <style> takes no attributes: `<style>…</style>`");
    const end = c.src.indexOf("</style>", c.i); if (end < 0) c.fail("expected </style>");
    const css = c.src.slice(c.i, end); c.i = end + "</style>".length;
    return { k: "style", css };
  }
  const attrs: { name: string; e: Expr }[] = [];
  for (;;) {
    c.ws();
    if (c.eat("/>")) return { k: "el", tag, attrs, children: [] };
    if (c.eat(">")) break;
    const name = c.tagName() ?? c.fail("attr"); c.ws(false);
    if (!c.eat("=")) { attrs.push({ name, e: { k: "lit", v: true } }); continue; }   // boolean attribute
    c.ws();
    if (c.eat("{")) { c.ws(); attrs.push({ name, e: parseExpr(c) }); c.ws(); c.expect("}"); }
    else attrs.push({ name, e: parsePrimary(c) });
  }
  const children = parseMarkup(c, tag);
  return { k: "el", tag, attrs, children };
}
