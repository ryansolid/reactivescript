// solid-yield's explicit generator dialect (as a syntax design only) as a third ReactiveScript frontend, spike. A
// yield module is lowered directly onto the pinned RX AST: component(function*) is a component, $signal / $store a
// source, $optimistic an optimistic question source, $memo an equation, $event a plain handler, view(function*) the
// component's markup with each yield* hole a read, For / Show regions. Only a small subset is accepted; every other
// form is refused with its own diagnostic at its yield source. It reaches upstream only through tsx/rx/ and keeps
// its own small helpers, so it does not depend on the TSX lowering. See docs/YIELD.md.
// Explicit Node entry, as elsewhere: the browser condition the Solid tests use would select Oxc's WASM build.
import { parseSync } from "oxc-parser/src-js/index";
import { decodeHTML } from "entities";
import { entryView, type Decl, type Expr, type Markup, type Program, type Stmt } from "../tsx/rx/ast.ts";
import { joinPath, parseDeclarations, parseProgram, type JsDecl, type ModuleSet } from "../tsx/rx/compiler.ts";

type N = any;
export class YieldError extends Error {
  filename: string; line: number; column: number; start: number; end: number;
  constructor(filename: string, source: string, at: { start: number; end: number }, message: string) {
    const before = source.slice(0, at.start);
    const line = before.split("\n").length, column = at.start - before.lastIndexOf("\n");
    super(filename + ":" + line + ":" + column + ": " + message);
    this.filename = filename; this.line = line; this.column = column; this.start = at.start; this.end = at.end;
  }
}

const SUBSET = new Set(["component", "view", "$signal", "$memo", "$event", "$optimistic", "$store", "attempt", "For", "Show"]);
const LATER: Record<string, string> = {
  $effect: "effects are not in the yield subset yet",
  $cleanup: "cleanups are not in the yield subset yet",
  $optimisticStore: "an optimistic store (Solid's createOptimisticStore) has no RX lowering here",
  $projection: "projections are not in the yield subset yet",
  createContext: "contexts are not in the yield subset yet",
  Loading: "Loading needs async sources, which the yield subset does not lower",
  Errored: "Errored and typed failures are not in the yield subset yet",
  Switch: "Switch/Match are not in the yield subset yet", Match: "Switch/Match are not in the yield subset yet",
  Repeat: "Repeat is not in the yield subset yet", lazy: "lazy components are not in the yield subset",
  refresh: "refresh needs a question source, which the yield subset does not lower",
  raise: "raise and typed failures are not in the yield subset yet", Failure: "typed failures are not in the yield subset yet",
  until: "until is not in the yield subset", foreign: "foreign hand-offs are not in the yield subset",
};
const BUILTIN: Record<string, string> = { filter: "filter", map: "map", every: "every", findIndex: "indexOf" };
const OPS: Record<string, string> = { "===": "==", "!==": "!=", "+": "+", "-": "-", "*": "*", "/": "/", "%": "%", "<": "<", ">": ">", "<=": "<=", ">=": ">=", "&&": "&&", "||": "||" };

/** What a name is bound to. A read (yield*) of an accessor is its id; of a store, a prop or a row item, a path. */
type B =
  | { k: "accessor" } | { k: "path"; name?: string } | { k: "value"; name?: string } | { k: "js" }
  | { k: "setter"; target: string; optimistic: boolean; store: boolean }
  | { k: "event"; params: string[]; handler: Expr }
  | { k: "local"; e: Expr }
  | { k: "draft"; store: string }
  | { k: "waited" };
type Scope = Map<string, B>;

/** Solid's JSX text rule (trim_jsx_text; Rust char::is_whitespace, not JS \s), so frames match native Solid. */
const WHITESPACE = /[\u0009-\u000d \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const jsxText = (raw: string): string => {
  let s = raw.replace(/\r/g, "");
  if (s.includes("\n"))
    s = s.split("\n").map((line, i) => (i ? line.replace(new RegExp("^" + WHITESPACE.source + "+"), "") : line))
      .filter(line => [...line].some(c => !WHITESPACE.test(c))).join(" ");
  return s.replace(new RegExp(WHITESPACE.source + "+", "g"), " ");
};

export function lowerYield(source: string, filename = "main.tsx"): Program {
  const parsed = parseSync(filename, source, { sourceType: "module", lang: "tsx" });
  const fail = (n: { start: number; end: number }, message: string): never => { throw new YieldError(filename, source, n, message); };
  if (parsed.errors.length) {
    const e = parsed.errors[0] as N;
    fail({ start: e.labels?.[0]?.start ?? 0, end: e.labels?.[0]?.end ?? 0 }, e.message);
  }
  const program = parsed.program as N;
  const line = (n: N) => source.slice(0, n.start).split("\n").length;
  const text = (n: N) => source.slice(n.start, n.end);
  let nextLocal = 0;
  const fresh = (): string => {
    let name: string;
    do { name = "__yieldLocal" + nextLocal++; } while (source.includes(name));
    return name;
  };
  const callee = (n: N): string | undefined => (n?.type === "CallExpression" && n.callee.type === "Identifier" ? n.callee.name : undefined);
  const isYield = (n: N) => n?.type === "YieldExpression" && n.delegate;
  const strip = (n: N): N => (n?.type === "ParenthesizedExpression" ? strip(n.expression) : n);
  const routine = (n: N, what: string): N => {
    if (n?.type !== "FunctionExpression" || !n.generator) fail(n ?? program, what + " takes a function* routine");
    if (n.async) fail(n, "routines are function*, never async (solid-yield refuses async routines too)");
    return n;
  };
  const only = (fn: N, what: string): N => {
    const body = fn.body.body;
    if (body.length !== 1 || body[0].type !== "ReturnStatement" || !body[0].argument) fail(fn, what);
    return body[0].argument;
  };

  // ---------------------------------------------------------------- expressions
  const read = (n: N, scope: Scope): Expr => {
    const arg = strip(n.argument);
    let root = arg;
    while (root.type === "MemberExpression" && !root.computed) root = root.object;
    if (root.type !== "Identifier") return fail(n, "yield* reads a source, a store path, a prop or a row: unsupported operand");
    const b = scope.get(root.name);
    if (!b) return fail(n, "yield* of an unknown source: " + root.name);
    if (b.k === "waited")
      return fail(n, "after an attempt an event's read may see the value from before the call (solid-yield's transaction), where RX reads it as it stands after the wait: read before the attempt");
    if (b.k === "accessor" && root === arg) return { k: "id", name: root.name };
    if (b.k === "path") return expr(arg, scope, true);
    if (b.k === "local" && root === arg) return b.e;
    return fail(n, b.k === "event" ? "an event is bound in a view or called with yield* evt(…) in an event, not read"
      : b.k === "setter" ? "a setter is delegated to in an event, yield* set(v), not read" : "yield* of a plain value: " + root.name);
  };
  const fn1 = (n: N, scope: Scope): Expr => {
    // an array builtin's callback: (x) => e
    if (n?.type !== "ArrowFunctionExpression" || n.async || n.params.length !== 1 || n.params[0].type !== "Identifier" || n.body.type === "BlockStatement")
      return fail(n ?? program, "an array builtin takes one (item) => expression callback");
    const raw = n.params[0].name, name = scope.has(raw) ? fresh() : raw;
    const inner: Scope = new Map(scope); inner.set(raw, { k: "value", name });
    return { k: "fn", params: [name], body: expr(n.body, inner) };
  };
  const expr = (raw: N, scope: Scope, inPath = false): Expr => {
    const n = strip(raw);
    switch (n.type) {
      case "YieldExpression":
        if (!n.delegate) return fail(n, "a plain yield is not a yield-dialect read; use yield*");
        return read(n, scope);
      case "Literal":
        if (n.regex || typeof n.value === "bigint") return fail(n, "unsupported literal");
        return { k: "lit", v: n.value };
      case "Identifier": {
        if (n.name === "undefined") return { k: "lit", v: undefined };
        const b = scope.get(n.name);
        if (!b) return fail(n, "unknown name: " + n.name);
        if (b.k === "local") return b.e;
        if (b.k === "draft") return { k: "id", name: b.store };
        if (b.k === "value" || (inPath && b.k === "path")) return { k: "id", name: b.name ?? n.name };
        if (b.k === "js") return { k: "id", name: n.name };
        if (b.k === "waited") return fail(n, "after an attempt, read sources before the attempt");
        return fail(n, b.k === "accessor" || b.k === "path" ? "a source is read with yield*: yield* " + n.name : "not a value here: " + n.name);
      }
      case "MemberExpression": {
        if (n.optional) return fail(n, "optional chaining is not in the yield subset");
        const o = expr(n.object, scope, inPath);
        if (n.computed) return { k: "index", o, i: expr(n.property, scope) };
        return { k: "member", o, p: n.property.name };
      }
      case "BinaryExpression": case "LogicalExpression":
        if (!OPS[n.operator]) return fail(n, "operator " + n.operator + " is not in the yield subset");
        return { k: "bin", op: OPS[n.operator], l: expr(n.left, scope), r: expr(n.right, scope) };
      case "UnaryExpression":
        if (!["!", "-"].includes(n.operator)) return fail(n, "operator " + n.operator + " is not in the yield subset");
        if (n.operator === "-" && n.argument.type === "Literal" && typeof n.argument.value === "number") return { k: "lit", v: -n.argument.value };
        return { k: "un", op: n.operator, e: expr(n.argument, scope) };
      case "ConditionalExpression":
        return { k: "if", c: expr(n.test, scope), t: expr(n.consequent, scope), f: expr(n.alternate, scope) };
      case "ArrayExpression":
        return { k: "arr", items: n.elements.map((e: N) => (e && e.type !== "SpreadElement" ? expr(e, scope) : fail(e ?? n, "holes and spreads are not in the yield subset"))) };
      case "ObjectExpression":
        return { k: "rec", fields: n.properties.map((p: N) => (p.type === "Property" && !p.computed && !p.method && p.key.type === "Identifier"
          ? { key: p.key.name, v: expr(p.value, scope) } : fail(p, "object literals take plain named properties here"))) };
      case "CallExpression": {
        const c = n.callee;
        if (c.type === "MemberExpression" && !c.computed && BUILTIN[c.property.name] && n.arguments.length === 1)
          return { k: "call", f: { k: "id", name: BUILTIN[c.property.name] }, args: [expr(c.object, scope, inPath), fn1(n.arguments[0], scope)] };
        if (c.type === "Identifier" && scope.get(c.name)?.k === "js") return { k: "call", f: { k: "id", name: c.name }, args: n.arguments.map((a: N) => expr(a, scope)) };
        if (c.type === "Identifier" && LATER[c.name]) return fail(n, LATER[c.name]);
        return fail(n, "only array builtins (filter, map, every, findIndex) and imported functions are called in expressions here");
      }
      case "FunctionExpression": case "ArrowFunctionExpression":
        return fail(n, n.generator || n.async ? "nested routines are not in the yield subset here" : "functions are values only as array-builtin callbacks here");
      case "JSXElement": case "JSXFragment": return fail(n, "JSX belongs to a view");
      case "TemplateLiteral": return fail(n, "template literals are not in the yield subset yet");
      default: return fail(n, "unsupported expression: " + n.type);
    }
  };

  // ---------------------------------------------------------------- events
  const events = (ss: N[], scope: Scope): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      if (s.type === "ExpressionStatement" && isYield(s.expression)) {
        const call = strip(s.expression.argument);
        if (call.type !== "CallExpression") fail(s, "an event statement delegates to a write or an event call: yield* set(v) or yield* evt(x)");
        const c = call.callee;
        const b = c.type === "Identifier" ? scope.get(c.name) : undefined;
        if (b?.k === "setter") { out.push(...write(call, b, scope)); continue; }
        if (b?.k === "event" || (c.type === "MemberExpression" && !c.computed && c.object.type === "Identifier" && c.object.name === "props")) {
          // Name a local arrow before calling it, as a handwritten RX handler would. The emitter expects a callable,
          // not an unparenthesized arrow in callee position. Fresh names also keep repeated calls distinct.
          const name = b?.k === "event" ? fresh() : undefined;
          if (b?.k === "event") out.push({ k: "let", name: name!, e: b.handler });
          out.push({ k: "expr", e: { k: "call", f: name ? { k: "id", name } : { k: "member", o: { k: "id", name: "props" }, p: c.property.name }, args: call.arguments.map((a: N) => expr(a, scope)) } });
          continue;
        }
        fail(call, "only a setter, a local $event or a Handler prop is called from an event");
      }
      if (s.type === "ExpressionStatement" && scope.get(callee(s.expression) ?? "")?.k === "setter")
        fail(s, "a setter returns a receipt: the write happens only at yield* set(v) (solid-yield's UNYIELDED_WRITE); a bare call writes nothing there, so it is refused rather than lowered as a write");
      if (s.type === "VariableDeclaration" && s.declarations.length === 1 && isYield(s.declarations[0].init) && callee(strip(s.declarations[0].init.argument)) === "attempt") {
        // const r = yield* attempt(() => call(…), function* () { absorbing handler }); if (r !== undefined) { … }
        //   ⇒ try { let r = await call(…); … } catch (error) { handler }
        const d = s.declarations[0], att = strip(d.init.argument), [thunk, handler] = att.arguments;
        if (d.id.type !== "Identifier") fail(d.id, "bind the attempt's result to a name");
        if (thunk?.type !== "ArrowFunctionExpression" || thunk.params.length || thunk.body.type !== "CallExpression") fail(thunk ?? att, "attempt(() => call(…), …) takes a thunk that makes one call");
        if (handler?.type !== "FunctionExpression" || !handler.generator || handler.params.length)
          fail(handler ?? att, "only an absorbing handler, function* () { … }, is in the yield subset: typed failures are not");
        const next = ss[i + 1];
        const guarded = next?.type === "IfStatement" && !next.alternate && next.test.type === "BinaryExpression" && next.test.operator === "!==" &&
          next.test.left.type === "Identifier" && next.test.left.name === d.id.name && next.test.right.type === "Identifier" && next.test.right.name === "undefined";
        if (!guarded || i + 2 !== ss.length)
          fail(s, "after the attempt, the event continues only inside if (" + d.id.name + " !== undefined) { … }, as its last statement");
        const waited: Scope = new Map([...scope].map(([k, v]) => [k, v.k === "accessor" || (v.k === "path" && k !== "props") ? { k: "waited" } : v] as [string, B]));
        const success: Scope = new Map(waited); success.set(d.id.name, { k: "value" });
        out.push({
          k: "try",
          body: [{ k: "let", name: d.id.name, e: { k: "await", e: expr(thunk.body, scope) } },
            ...events(next.consequent.type === "BlockStatement" ? next.consequent.body : [next.consequent], success)],
          catchName: "error",
          handler: events(handler.body.body, waited),
        });
        i++;
        continue;
      }
      if (s.type === "TryStatement") fail(s, "try/catch is not a yield routine form (solid-yield's no-try-catch); use attempt");
      if (s.type === "ThrowStatement") fail(s, "throw is not a yield routine form (solid-yield's UNTYPED_THROW)");
      fail(s, "this statement form is not in the yield event subset");
    }
    return out;
  };
  const write = (call: N, b: Extract<B, { k: "setter" }>, scope: Scope): Stmt[] => {
    if (call.arguments.length !== 1) fail(call, "a setter takes one value or updater");
    const arg = strip(call.arguments[0]);
    const target = (path: (string | Expr)[]) => ({ name: b.target, path, ctx: false });
    if (b.store) {
      // yield* setStore((draft) => { draft.a.b = e; … }): straight-line path writes
      if (arg.type !== "ArrowFunctionExpression" || arg.params.length !== 1 || arg.params[0].type !== "Identifier" || arg.body.type !== "BlockStatement")
        return fail(arg, "a store is written through a draft: yield* setStore((draft) => { draft.path = value; })");
      const inner: Scope = new Map(scope); inner.set(arg.params[0].name, { k: "draft", store: b.target });
      return arg.body.body.map((s: N): Stmt => {
        const a = s.type === "ExpressionStatement" ? s.expression : undefined;
        if (a?.type !== "AssignmentExpression" || a.operator !== "=") return fail(s, "draft blocks hold straight-line assignments");
        const path: (string | Expr)[] = [];
        let x = a.left;
        while (x.type === "MemberExpression") { path.unshift(x.computed ? expr(x.property, inner) : x.property.name); x = x.object; }
        if (x.type !== "Identifier" || x.name !== arg.params[0].name) return fail(a.left, "a draft assignment writes a path of the draft");
        return { k: "write", target: target(path), e: expr(a.right, inner) };
      });
    }
    if (arg.type === "ArrowFunctionExpression") {
      // a functional write: yield* setX((v) => e)
      if (arg.params.length !== 1 || arg.params[0].type !== "Identifier" || arg.body.type === "BlockStatement" || arg.async) return fail(arg, "a functional write is (v) => expression");
      const inner: Scope = new Map(scope); inner.set(arg.params[0].name, { k: "value" });
      return [{ k: b.optimistic ? "optimistic" : "write", target: target([]), e: { k: "fn", params: [arg.params[0].name], body: expr(arg.body, inner) } }];
    }
    return [{ k: b.optimistic ? "optimistic" : "write", target: target([]), e: expr(arg, scope) }];
  };

  // ---------------------------------------------------------------- views
  const props = (n: N): Map<string, N> => {
    if (n?.type !== "ObjectExpression") fail(n ?? program, "a call takes an object of props");
    const m = new Map<string, N>();
    for (const p of n.properties) {
      if (p.type !== "Property" || p.computed || p.key.type !== "Identifier" || p.method) fail(p, "props are plain named properties");
      m.set(p.key.name, p.value);
    }
    return m;
  };
  const input = (v: N, scope: Scope): Expr => {
    // a control or prop input: a source or path, a hole function* () { return e; }, or a value
    if (v.type === "FunctionExpression" && v.generator) return expr(only(v, "a hole is function* () { return e; }"), scope);
    if (isYield(v)) return fail(v, "a yield* in a call's arguments reads in the caller and re-creates the child (solid-yield's no-read-in-prop)");
    if (v.type === "Identifier" && scope.get(v.name)?.k === "accessor") return { k: "id", name: v.name };
    if (v.type === "Identifier" && scope.get(v.name)?.k === "path") return { k: "id", name: v.name };
    return expr(v, scope);
  };
  const lazy = (n: N, scope: Scope): Markup[] => markup(only(routine(n, "a lazy view"), "a lazy view has no body: function* () { return <…/>; }"), scope);
  const hole = (n: N, scope: Scope): Markup[] => {
    const arg = strip(n.argument), name = callee(arg), at = line(n);
    if (name && LATER[name]) fail(arg, LATER[name]);
    if (name === "Show") {
      const p = props(arg.arguments[0]);
      for (const k of p.keys()) if (!["when", "fallback", "children"].includes(k)) fail(p.get(k), "Show takes when, fallback and children here");
      if (!p.has("when") || !p.has("children")) fail(arg, "Show needs when and children");
      if (p.get("children").params?.length) fail(p.get("children"), "Show's row form (a child taking the value) is not in the yield subset");
      const fb = p.get("fallback");
      const fallback: Markup[] = !fb ? [] : fb.type === "Literal" && typeof fb.value === "string" ? [{ k: "text", s: fb.value, line: line(fb) }] : lazy(fb, scope);
      return [{ k: "mif", c: input(p.get("when"), scope), t: lazy(p.get("children"), scope), tDecls: [], f: fallback, fDecls: [], line: at } as Markup];
    }
    if (name === "For") {
      const p = props(arg.arguments[0]);
      for (const k of p.keys()) if (!["each", "children"].includes(k)) fail(p.get(k), "For takes each and children here");
      const row = routine(p.get("children"), "For's row");
      if (row.params.length !== 1 || row.params[0].type !== "Identifier") fail(row, "a For row takes its item: function* (item) { … } (the index is not in the subset)");
      const ret = only(row, "a row returns its view, with no row-owned state in the yield subset");
      if (callee(ret) !== "view") fail(ret, "a row returns its view: return view(function* () { return <…/>; })");
      const raw = row.params[0].name, name = scope.has(raw) ? fresh() : raw;
      const inner: Scope = new Map(scope); inner.set(raw, { k: "path", name });
      const body = markup(only(routine(ret.arguments[0], "view"), "a view has no body: return <…/>"), inner);
      return [{ k: "mfor", name, xs: input(p.get("each"), scope), decls: [], body, line: at } as Markup];
    }
    if (name && components.has(name)) {
      const p = arg.arguments.length ? props(arg.arguments[0]) : new Map<string, N>();
      const attrs = [...p].map(([k, v]) => {
        if (k === "children") fail(v, "children of yield components are not in the subset");
        const ev = v.type === "Identifier" ? scope.get(v.name) : undefined;
        if (ev?.k === "event") return { name: k, e: ev.handler };
        return { name: k, e: input(v, scope) };
      });
      return [{ k: "el", tag: name, attrs, children: [], line: at } as Markup];
    }
    if (name && /^[A-Z]/.test(name)) return fail(arg, "unknown component or flow control: " + name);
    return display(n, scope);
  };
  const display = (n: N, scope: Scope): Markup[] => {
    // a hole showing a value; a conditional hole is a region with a branch each, as JSX's ternary child is
    const e = strip(n);
    if (e.type === "ConditionalExpression")
      return [{ k: "mif", c: expr(e.test, scope), t: display(e.consequent, scope), tDecls: [], f: display(e.alternate, scope), fDecls: [], line: line(e) } as Markup];
    return [{ k: "read", e: { k: "bin", op: "+", l: { k: "lit", v: "" }, r: expr(e, scope) }, line: line(e) }];
  };
  const markup = (raw: N, scope: Scope): Markup[] => {
    const n = strip(raw);
    if (n.type === "JSXFragment") return n.children.flatMap((c: N) => markup(c, scope));
    if (n.type === "JSXText") { const s = decodeHTML(jsxText(n.value)); return s ? [{ k: "text", s, line: line(n) }] : []; }
    if (n.type === "JSXExpressionContainer") {
      const e = n.expression;
      if (e.type === "JSXEmptyExpression") return [];
      if (isYield(e) && callee(strip(e.argument))) return hole(e, scope);
      return display(e, scope);
    }
    if (n.type !== "JSXElement") return fail(n, "a view returns JSX");
    const open = n.openingElement;
    if (open.name.type !== "JSXIdentifier") fail(open, "namespaced and member tags are not in the yield subset");
    if (/^[A-Z]/.test(open.name.name)) fail(open, "a yield component is called in a hole, {yield* " + open.name.name + "({ … })}, never tagged (solid-yield's no-component-tag)");
    const attrs = open.attributes.map((a: N) => {
      if (a.type !== "JSXAttribute") return fail(a, "spread props are not in the yield subset");
      const key = a.name.type === "JSXIdentifier" ? a.name.name : "";
      const v = a.value?.type === "JSXExpressionContainer" ? a.value.expression : undefined;
      if (!/^on[A-Z]/.test(key) || !isYield(v)) return fail(a, "only event bindings, onX={yield* evt}, are in the yield subset's attributes");
      const target = strip(v.argument);
      const b = target.type === "Identifier" ? scope.get(target.name) : undefined;
      if (b?.k !== "event") return fail(target, "an event prop binds a local $event: onClick={yield* evt}");
      if (b.params.length) return fail(target, "a bound event receives the DOM event; events with parameters are only called from events in the yield subset");
      return { name: key, e: b.handler };
    });
    return [{ k: "el", tag: open.name.name, attrs, children: n.children.flatMap((c: N) => markup(c, scope)), line: line(n) }];
  };

  // ---------------------------------------------------------------- types
  const aliases = new Map<string, N>();
  const type = (t: N): string => {
    if (t.type === "TSTypeReference" && t.typeName.type === "Identifier") {
      const name = t.typeName.name, args = t.typeArguments?.params ?? [];
      if (name === "Source") return type(args[0]);
      if (name === "Handler") {
        if (args[0]?.type !== "TSTupleType") fail(t, "Handler takes a tuple of argument types, Handler<[T]>");
        return "(" + args[0].elementTypes.map((e: N, i: number) => "arg" + i + ": " + type(e)).join(", ") + ") => void";
      }
      if (aliases.has(name)) return type(aliases.get(name));
    }
    if (t.type === "TSTypeLiteral")
      return "{ " + t.members.map((m: N) => (m.type === "TSPropertySignature" && m.key.type === "Identifier" && !m.optional && m.typeAnnotation
        ? m.key.name + ": " + type(m.typeAnnotation.typeAnnotation) : fail(m, "Props members are required named properties with a type"))).join("; ") + " }";
    if (["TSNumberKeyword", "TSStringKeyword", "TSBooleanKeyword"].includes(t.type)) return text(t);
    return fail(t, "unsupported prop type: " + text(t));
  };

  // ---------------------------------------------------------------- components
  const components = new Map<string, N>();
  const componentOf = (init: N): N | undefined => (callee(init) === "component" ? init.arguments[0] : undefined);
  const module: Scope = new Map();
  for (const s of program.body) {
    const decl = s.type === "ExportNamedDeclaration" ? s.declaration : s;
    if (s.type === "ExportDefaultDeclaration" && componentOf(s.declaration)?.id) components.set(componentOf(s.declaration).id.name, componentOf(s.declaration));
    if (decl?.type === "VariableDeclaration")
      for (const d of decl.declarations) if (componentOf(d.init) && d.id.type === "Identifier") components.set(d.id.name, componentOf(d.init));
    if (decl?.type === "TSTypeAliasDeclaration") aliases.set(decl.id.name, decl.typeAnnotation);
  }
  const component = (fn: N, name: string, exported: boolean, isDefault: boolean): Decl => {
    routine(fn, "component");
    if (fn.id?.name !== name) fail(fn, "a component's routine is named after it: component(function* " + name + "(…) { … })");
    if (fn.params.length > 1) fail(fn.params[1], "a component takes one props parameter");
    const scope: Scope = new Map(module);
    let propsType: string | undefined;
    if (fn.params.length) {
      const p = fn.params[0];
      if (p.type !== "Identifier" || p.name !== "props" || !p.typeAnnotation) fail(p, "the props parameter is props: Props<{ … }>");
      const t = p.typeAnnotation.typeAnnotation;
      if (t.type !== "TSTypeReference" || t.typeName.name !== "Props") fail(t, "the props parameter's type is Props<{ … }>");
      propsType = type(t.typeArguments.params[0]);
      scope.set("props", { k: "path" });
    }
    const decls: Decl[] = [];
    const body = fn.body.body;
    for (const s of body.slice(0, -1)) {
      if (s.type !== "VariableDeclaration" || s.kind !== "const" || s.declarations.length !== 1) fail(s, "a setup only creates: const … = yield* $signal(…), $memo(…), $event(…), …");
      const d = s.declarations[0];
      const init = isYield(d.init) ? strip(d.init.argument) : d.init;
      const what = callee(init);
      if (what && LATER[what]) fail(init, LATER[what]);
      if (what === "$event") {
        if (isYield(d.init)) fail(d.init, "an $event is created without yield*: const evt = $event(function* (…) { … })");
        if (d.id.type !== "Identifier") fail(d.id, "an $event is bound to a name");
        const ev = routine(init.arguments[0], "$event");
        const names: string[] = ev.params.map((q: N) => (q.type === "Identifier" && q.typeAnnotation ? q.name : fail(q, "event parameters need explicit types")));
        // The handler may be used inside another event or a row. Do not let their parameters capture its reads.
        const params = names.map(q => scope.has(q) ? fresh() : q);
        const inner: Scope = new Map(scope);
        names.forEach((q, i) => inner.set(q, { k: "value", name: params[i] }));
        // Keep the body in the handler: RX alone infers actions (AC-1b). Forwarding to a child passes this same arrow.
        const handler: Expr = { k: "fn", params, body: { k: "lit", v: undefined }, stmts: events(ev.body.body, inner) };
        scope.set(d.id.name, { k: "event", params, handler });
        continue;
      }
      if (!isYield(d.init)) fail(d.init ?? d, "a setup creates with yield*: const … = yield* $signal(…)");
      if (!what) fail(d.init, "a setup never reads (solid-yield's READ_IN_SETUP): read in a hole, a $memo or an $event");
      if (what === "$signal" || what === "$optimistic" || what === "$store") {
        if (d.id.type !== "ArrayPattern" || d.id.elements.length !== 2 || d.id.elements.some((e: N) => e?.type !== "Identifier"))
          fail(d.id, "bind the source and its setter: const [x, setX] = yield* " + what + "(…)");
        if (init.arguments.length !== 1) fail(init, what + " takes one initial value here (options are not in the subset)");
        const v = init.arguments[0];
        if (v.type === "FunctionExpression" || v.type === "ArrowFunctionExpression") fail(v, what + " with a derived body is not in the yield subset");
        const [get, set] = d.id.elements.map((e: N) => e.name);
        const value = expr(v, new Map());
        scope.set(get, what === "$store" ? { k: "path" } : { k: "accessor" });
        scope.set(set, { k: "setter", target: get, optimistic: what === "$optimistic", store: what === "$store" });
        decls.push(what === "$optimistic"
          ? ({ k: "source", name: get, init: { k: "peek", e: value }, question: true, line: line(s) } as Decl)
          : ({ k: "source", name: get, init: value, line: line(s) } as Decl));
        continue;
      }
      if (what === "$memo") {
        if (d.id.type !== "Identifier" || init.arguments.length !== 1) fail(d, "const m = yield* $memo(function* () { … }) (options are not in the subset)");
        const memo = routine(init.arguments[0], "$memo");
        // const locals bound to reads, then one return; the locals are substituted into the return
        const inner: Scope = new Map(scope);
        const ss = memo.body.body;
        for (const x of ss.slice(0, -1)) {
          const v = x.type === "VariableDeclaration" && x.kind === "const" && x.declarations.length === 1 ? x.declarations[0] : undefined;
          if (!v || v.id.type !== "Identifier" || !isYield(v.init)) fail(x, "a memo body binds reads (const x = yield* source) and returns one expression");
          if (callee(strip(v.init.argument)) === "attempt") fail(v.init, "async memos (attempt in $memo) are not in the yield subset");
          inner.set(v.id.name, { k: "local", e: read(v.init, scope) });
        }
        const ret = ss.at(-1);
        if (ret?.type !== "ReturnStatement" || !ret.argument) fail(memo, "a memo body ends with one return");
        if (isYield(ret.argument) && callee(strip(ret.argument.argument)) === "attempt") fail(ret.argument, "async memos (attempt in $memo) are not in the yield subset");
        scope.set(d.id.name, { k: "accessor" });
        decls.push({ k: "eq", name: d.id.name, e: expr(ret.argument, inner), line: line(s) } as Decl);
        continue;
      }
      fail(init, "not a setup operation in the yield subset: " + what);
    }
    const ret = body.at(-1);
    if (ret?.type !== "ReturnStatement" || callee(ret.argument) !== "view") fail(ret ?? fn, "a setup returns its view: return view(function* () { return <…/>; })");
    const view = routine(ret.argument.arguments[0], "view");
    const vret = only(view, "a view has no body: return <…/>; no if, no early return, no local computation (solid-yield's READ_IN_VIEW)");
    return { k: "component", name, props: "props", ...(propsType ? { propsType } : {}), decls, view: markup(vret, scope), line: line(fn), exported, ...(isDefault ? { isDefault } : {}) } as Decl;
  };

  // ---------------------------------------------------------------- module
  const decls: Decl[] = [];
  let entry: { name: string; line: number } | undefined;
  for (const s of program.body) {
    if (s.type === "ImportDeclaration") {
      if (s.source.value === "solid-yield") {
        if (s.importKind === "type") continue;
        for (const spec of s.specifiers) {
          if (spec.importKind === "type") continue;
          const name = spec.imported?.name ?? spec.local.name;
          if (LATER[name]) fail(spec, LATER[name]);
          if (!SUBSET.has(name)) fail(spec, "not in the yield subset: " + name);
          if (spec.local.name !== name) fail(spec, "aliased solid-yield imports are not in the subset");
        }
        continue;
      }
      if (s.importKind === "type" || s.specifiers.some((x: N) => x.type !== "ImportSpecifier" || x.importKind === "type"))
        fail(s, "imports of other modules are named value imports here");
      const names = s.specifiers.map((x: N) => ({ name: x.imported.name, alias: x.local.name }));
      for (const x of names) module.set(x.alias, { k: "js" });
      decls.push({ k: "import", names, from: s.source.value, pure: false, line: line(s) } as Decl);
      continue;
    }
    if (s.type === "TSTypeAliasDeclaration") continue;
    if (s.type === "ExportDefaultDeclaration") {
      const fn = componentOf(s.declaration);
      if (!fn?.id) fail(s, "export default component(function* Name() { … })");
      decls.push(component(fn, fn.id.name, true, true));
      entry = { name: fn.id.name, line: line(fn) };
      continue;
    }
    const decl = s.type === "ExportNamedDeclaration" ? s.declaration : s;
    if (decl?.type === "VariableDeclaration" && decl.declarations.length === 1 && componentOf(decl.declarations[0].init)) {
      const d = decl.declarations[0];
      decls.push(component(componentOf(d.init), d.id.name, s.type === "ExportNamedDeclaration", false));
      continue;
    }
    fail(s, "module statements are imports, type aliases and components in the yield subset");
  }
  return { decls, view: entry ? entryView(entry.name, entry.line) : [] } as Program;
}

/** A yield entry and its .rx / .d.rx dependencies as one checked RX module set (no TSX lowering involved). */
export function loadYieldModules(entry: string, read: (path: string) => string | undefined): ModuleSet {
  entry = joinPath("", entry);
  const programs = new Map<string, Program>();
  const order: string[] = [];
  const diags: ModuleSet["diags"] = [];
  const declarations = new Map<string, JsDecl[]>();
  const visit = (path: string): void => {
    if (programs.has(path)) return;
    const source = read(path);
    if (source === undefined) { diags.push({ code: "MODULE_NOT_FOUND", rule: "MO-6", file: path, line: 1, msg: "no module " + path }); return; }
    const program = path.endsWith(".rx") ? parseProgram(source) : lowerYield(source, path);
    for (const d of program.decls) {
      if (d.k !== "import") continue;
      if (/\.(rx|tsx)$/.test(d.from)) { d.resolved = joinPath(path, d.from); visit(d.resolved); continue; }
      const key = joinPath(path, d.from.replace(/\.(m?js|ts)$/, "") + ".d.rx");
      const text = read(key);
      if (text === undefined) continue;
      if (!declarations.has(key)) declarations.set(key, parseDeclarations(text));
      const ds = declarations.get(key)!;
      d.declared = key;
      d.declaredErrors = ds.filter(x => x.kind === "error").map(x => x.name);
      d.declaredPure = ds.filter(x => x.kind === "fn" && x.pure).map(x => x.name);
      d.declaredSide = Object.fromEntries(ds.flatMap(x => (x.kind === "fn" && x.side ? [[x.name, x.side]] : [])));
    }
    programs.set(path, program);
    order.push(path);
  };
  visit(entry);
  return { entry, programs, order, diags, declarations };
}
