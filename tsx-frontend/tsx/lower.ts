// A deliberately bounded Solid TSX spelling for the existing ReactiveScript AST.
// Explicit Node entry: Solid tests use the browser condition, which otherwise selects Oxc's WASM build.
import {
  parseSync,
  type Node,
  type Span,
  type Function as OxcFunction,
} from "oxc-parser/src-js/index";
import {
  entryView,
  type Program,
  type Decl,
  type Expr,
  type Markup,
  type Stmt,
} from "./rx/ast.ts";
import { actionInference } from "./rx/infer.ts";
import type { JsDecl } from "./rx/compiler.ts";
import { decodeHTML } from "entities";

export class TsxError extends Error {
  filename: string;
  line: number;
  column: number;
  start: number;
  end: number;
  constructor(filename: string, source: string, span: Span, message: string) {
    const before = source.slice(0, span.start);
    const line = before.split("\n").length;
    const column = span.start - before.lastIndexOf("\n");
    super(filename + ":" + line + ":" + column + ": " + message);
    this.name = "TsxError";
    this.filename = filename;
    this.line = line;
    this.column = column;
    this.start = span.start;
    this.end = span.end;
  }
}

export type LowerOptions = {
  modules?: Map<string, { path: string; program: Program }>;
  declarations?: Map<string, JsDecl[]>;
};

/** A bounded TSX spelling of executable RX. Kinds below only guard supported value/call/render forms. */
import { verifySyntax } from "./subset.ts";

export function lowerTsx(
  source: string,
  filename = "input.tsx",
  options: LowerOptions = {},
): Program {
  const fail = (n: Span, message: string): never => {
    const semantic =
      message.includes("issues/20") ||
      message.startsWith("createEffect") ||
      message.startsWith("createSignal with");
    throw new TsxError(
      filename,
      source,
      n,
      semantic || message.startsWith("outside the verified subset:")
        ? message
        : "outside the verified subset: " + message,
    );
  };
  const parsed = parseSync(filename, source, {
    sourceType: "module",
    lang: "tsx",
  });
  if (parsed.errors.length) {
    const e = parsed.errors[0];
    fail(e.labels[0] ?? { start: 0, end: 0 }, e.message);
  }
  verifySyntax(parsed.program, fail);
  const line = (n: Span) => source.slice(0, n.start).split("\n").length;
  type Shape = {
    kind:
      | "number"
      | "string"
      | "boolean"
      | "null"
      | "undefined"
      | "scalar"
      | "record"
      | "array"
      | "view"
      | "accessor"
      | "callback";
    fields?: Map<string, Shape>;
    item?: Shape;
    params?: Shape[];
    maybe?: boolean;
  };
  type Value = { e: Expr; shape: Shape };
  type Binding = {
    kind: "value" | "accessor" | "store";
    shape: Shape;
    name?: string;
    e?: Expr;

    optimistic?: boolean;

    props?: boolean; // a component's props: reads are tracked in Solid

    actionParams?: Shape[];
  };
  type Scope = {
    bindings: Map<string, Binding>;
    setters: Map<string, string>;
    names: Set<string>;
    helpers: Map<string, Fn>;

    action?: boolean;
    returnShape?: Shape;
  };
  type Fn = {
    fn?: OxcFunction;
    exported?: boolean;
    component: boolean;
    props: string;
    fields: Map<string, Shape>;
    params: { name: string; shape: Shape; type?: string; ref?: boolean }[];

    ret?: Shape;
    refs: { tag: string; node: Span }[];
    propsType?: string;
    decls?: Decl[];
  };
  const scalar = (s: Shape) =>
    !["record", "array", "callback", "view", "accessor"].includes(s.kind);
  const merge = (a: Shape, b: Shape): Shape =>
    a.kind === b.kind && (scalar(a) || (matches(a, b) && matches(b, a)))
      ? { ...a, ...(a.maybe || b.maybe ? { maybe: true } : {}) }
      : scalar(a) && scalar(b)
        ? { kind: "scalar" }
        : fail(
            parsed.program,
            "Mixed structured value kinds need an explicit supported shape",
          );
  const matches = (actual: Shape, expected: Shape): boolean =>
    expected.kind === "scalar"
      ? scalar(actual)
      : actual.kind === expected.kind &&
        (expected.kind === "record"
          ? [...expected.fields!].every(
              ([key, type]) =>
                !!actual.fields?.has(key) &&
                matches(actual.fields.get(key)!, type),
            )
          : expected.kind === "callback"
            ? (actual.params?.length ?? 0) <= (expected.params?.length ?? 0) &&
              (actual.params ?? []).every((param, i) =>
                matches(expected.params![i], param),
              )
            : expected.kind === "array" || expected.kind === "accessor"
              ? matches(actual.item!, expected.item!)
              : true);
  const handlerName = (s: string) => /^on[A-Z]/.test(s);
  const viewTypes = new Set<string>();
  const readType = (n: Node): Shape => {
    if (
      n.type === "TSTypeReference" &&
      !n.typeArguments &&
      n.typeName.type === "Identifier" &&
      viewTypes.has(n.typeName.name)
    )
      return { kind: "view" };
    if (
      n.type === "TSTypeReference" &&
      !n.typeArguments &&
      n.typeName.type === "TSQualifiedName" &&
      n.typeName.left.type === "Identifier" &&
      n.typeName.left.name === "JSX" &&
      n.typeName.right.name === "Element"
    )
      return { kind: "view" };
    if (n.type === "TSNumberKeyword") return { kind: "number" };
    if (n.type === "TSStringKeyword") return { kind: "string" };
    if (n.type === "TSBooleanKeyword") return { kind: "boolean" };
    if (n.type === "TSUndefinedKeyword" || n.type === "TSVoidKeyword")
      return { kind: "undefined" };
    if (n.type === "TSLiteralType") {
      if (n.literal.type === "Literal")
        return {
          kind:
            n.literal.value === null
              ? "null"
              : (typeof n.literal.value as "number" | "string" | "boolean"),
        };
    }
    if (n.type === "TSUnionType") return n.types.map(readType).reduce(merge);
    if (n.type === "TSArrayType")
      return { kind: "array", item: readType(n.elementType) };
    if (
      n.type === "TSFunctionType" &&
      !n.typeParameters &&
      n.returnType.typeAnnotation.type === "TSVoidKeyword"
    ) {
      const params = n.params.map((param) => {
        if (
          param.type !== "Identifier" ||
          param.optional ||
          !param.typeAnnotation
        )
          return fail(
            n,
            "Callback parameters require explicit required value types",
          );
        return readType(param.typeAnnotation.typeAnnotation);
      });
      return { kind: "callback", ...(params.length ? { params } : {}) };
    }
    if (n.type === "TSFunctionType" && !n.params.length && !n.typeParameters)
      return { kind: "accessor", item: readType(n.returnType.typeAnnotation) };
    if (n.type === "TSTypeLiteral") {
      const fields = new Map<string, Shape>();
      for (const field of n.members) {
        if (
          field.type !== "TSPropertySignature" ||
          field.computed ||
          field.optional ||
          field.readonly ||
          field.key.type !== "Identifier" ||
          !field.typeAnnotation
        )
          return fail(
            field,
            "Object contracts require explicit, required identifier properties",
          );
        const key = field.key.name;
        if (["__proto__", "ref"].includes(key) || fields.has(key))
          return fail(field, "Reserved or duplicate prop: " + key);
        const type = readType(field.typeAnnotation.typeAnnotation);
        if (key === "children" && type.kind !== "view")
          return fail(
            field,
            "Component children require an explicit JSX.Element slot contract",
          );
        fields.set(key, type);
      }
      return { kind: "record", fields };
    }
    return fail(
      n,
      "Unsupported type: use explicit primitive, scalar union, array, object, or () => void contracts",
    );
  };
  const printType = (s: Shape): string =>
    s.kind === "callback"
      ? s.params?.length
        ? "(" +
          s.params
            .map((param, i) => "arg" + i + ": " + printType(param))
            .join(", ") +
          ") => void"
        : "action catches(nothing)"
      : s.kind === "scalar"
        ? "number | string | boolean | null | undefined"
        : s.kind === "array"
          ? "(" + printType(s.item!) + ")[]"
          : s.kind === "record"
            ? "{ " +
              [...s.fields!]
                .map(([key, type]) => key + ": " + printType(type))
                .join("; ") +
              " }"
            : s.kind === "view"
              ? "JSX.Element"
              : s.kind === "accessor"
                ? "() => " + printType(s.item!)
                : s.kind;

  const authoredBindings = new Set<string>();
  const arrayBuiltins = new Set<string>();
  const bind = (n: Node, names: Set<string>, annotation = false): string => {
    if (
      n.type !== "Identifier" ||
      (!annotation && n.typeAnnotation) ||
      n.optional ||
      n.decorators?.length
    )
      return fail(n, "Expected an identifier binding");
    if (/^\$[0-9]+$/.test(n.name))
      return fail(
        n,
        "Bindings named $<digits> are reserved for RX effect samples",
      );
    if (arrayBuiltins.has(n.name))
      return fail(
        n,
        "Array predicate builtin collides with an authored binding: " + n.name,
      );
    if (names.has(n.name))
      return fail(n, "Duplicate or shadowed binding: " + n.name);
    names.add(n.name);
    authoredBindings.add(n.name);
    return n.name;
  };
  const arrow = (
    n: Node,
    count = 0,
  ): import("oxc-parser").ArrowFunctionExpression => {
    if (
      n.type !== "ArrowFunctionExpression" ||
      n.async ||
      n.params.length !== count ||
      n.typeParameters ||
      n.returnType
    )
      return fail(
        n,
        "Expected a synchronous arrow with " + count + " parameter(s)",
      );
    return n;
  };
  const hasLexicalAwait = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(hasLexicalAwait);
    const n = node as Node;
    if (
      [
        "ArrowFunctionExpression",
        "FunctionExpression",
        "FunctionDeclaration",
      ].includes(n.type)
    )
      return false;
    return (
      n.type === "AwaitExpression" || Object.values(node).some(hasLexicalAwait)
    );
  };
  // Temporary TSX boundary while https://github.com/ryansolid/reactivescript/issues/20 is open: an authored ordinary
  // async callback is refused at its async node, never lowered or silently converted to an action. This covers
  // callbacks only; async computations are refused by the subset boundary.
  const asyncIssue = "https://github.com/ryansolid/reactivescript/issues/20";
  const asyncCallback = (n: Span): never =>
    fail(
      n,
      "Ordinary async callbacks are refused for now (" +
        asyncIssue +
        "): wrap the work in action(function* () { ... yield request(); ... }) and use yield instead of await. This opts into action semantics, which hold the action's writes until it completes; it is not a semantics-preserving rewrite of the async callback",
    );
  const asyncAction = (n: Span): never =>
    fail(
      n,
      "Actions take a synchronous generator, not an async function or async generator (" +
        asyncIssue +
        "): write action(function* () { ... yield request(); ... }) and use yield instead of await",
    );
  const functions = new Map<string, Fn>();
  const primitives = new Map<string, string>();
  const jsFunctions = new Map<string, number | undefined>();

  const moduleNames = new Set<string>();
  const moduleScope: Scope = {
    bindings: new Map(),
    setters: new Map(),
    names: moduleNames,
    helpers: functions,
  };
  const result: Program = { decls: [], view: [] };

  let declarationsStarted = false;
  /** The module's `export default function Name` component: its entry (upstream MO-1c). */
  let defaultComponent: string | undefined;
  const collectFunction = (
    fn: OxcFunction,
    exported: boolean,
    names: Set<string>,
    into = functions,
  ) => {
    // A named async function inside a component is a stored callback, refused with the same guidance whatever its name.
    if (fn.async && into !== functions) return asyncCallback(fn);
    if (
      !fn.id ||
      !fn.body ||
      fn.async ||
      fn.generator ||
      fn.declare ||
      fn.typeParameters
    )
      return fail(fn, "Expected a named synchronous component or pure helper");
    const name = bind(fn.id, names);
    const component = /^[A-Z]/.test(name);
    const meta: Fn = {
      fn,
      exported,
      component,
      props: "props",
      fields: new Map(),
      params: [],
      refs: [],
    };
    if (component) {
      if (fn.returnType || fn.params.length > 1)
        return fail(
          fn,
          "Components take zero parameters or one inline-typed props identifier",
        );
      if (fn.params.length) {
        const p = fn.params[0];
        if (
          p.type !== "Identifier" ||
          p.optional ||
          p.decorators?.length ||
          p.typeAnnotation?.typeAnnotation.type !== "TSTypeLiteral"
        )
          return fail(
            p,
            "Props require an identifier with an inline object type; no destructuring or inferred props",
          );
        const type = readType(p.typeAnnotation.typeAnnotation);
        meta.props = p.name;
        meta.fields = type.fields!;
        meta.propsType = printType(type);
        for (const field of p.typeAnnotation.typeAnnotation.members)
          if (
            field.type === "TSPropertySignature" &&
            field.key.type === "Identifier"
          ) {
            const key = field.key.name;
            if (meta.fields.get(key)!.kind === "view" && key !== "children")
              return fail(
                field,
                "JSX.Element contracts currently support only component children slots",
              );
            if (meta.fields.get(key)!.kind === "accessor")
              return fail(
                field.typeAnnotation!.typeAnnotation,
                "Accessor props require a separate contract and are currently unsupported",
              );
            if (
              (meta.fields.get(key)!.kind === "callback") !==
              handlerName(key)
            )
              return fail(
                field,
                "Only on[A-Z] props may be callbacks, and handler-named props must be () => void",
              );
          }
      }
    }
    into.set(name, meta);
  };
  for (const item of parsed.program.body) {
    if (item.type === "ImportDeclaration") {
      if (
        declarationsStarted ||
        item.importKind === "type" ||
        item.phase ||
        item.attributes.length ||
        !item.specifiers.length
      )
        return fail(item, "named value imports before declarations");
      const names: { name: string; alias: string }[] = [];
      for (const spec of item.specifiers) {
        if (
          spec.type !== "ImportSpecifier" ||
          spec.importKind === "type" ||
          spec.imported.type !== "Identifier"
        )
          return fail(spec, "named value import");
        const local = bind(spec.local, moduleNames),
          imported = spec.imported.name;
        if (item.source.value === "solid-js") {
          primitives.set(local, imported);
          continue;
        }
        const declarations = options.declarations?.get(
          String(item.source.value),
        );
        const contract = declarations?.find((d) => d.name === imported);
        if (declarations && !contract)
          return fail(spec, "JS declaration file does not export " + imported);
        if (contract && contract.kind !== "fn")
          return fail(spec, "only JS function imports are supported");
        jsFunctions.set(local, contract?.params.length);
        names.push({ name: imported, alias: local });
      }
      if (names.length)
        result.decls.push({
          k: "import",
          names,
          from: String(item.source.value),
          pure: false,
          line: line(item),
        });
      continue;
    }
    declarationsStarted = true;
    if (item.type === "ExportDefaultDeclaration") {
      const dd = item.declaration;
      if (
        dd.type !== "FunctionDeclaration" ||
        !dd.id ||
        !/^[A-Z]/.test(dd.id.name)
      )
        return fail(
          item,
          "export default: only a named uppercase component function is a module's default export (the app's entry, MO-1c)",
        );
      if (defaultComponent)
        return fail(item, "A module has one default component");
      defaultComponent = dd.id.name;
      collectFunction(dd, true, moduleNames);
      continue;
    }
    const exported = item.type === "ExportNamedDeclaration";
    const d = exported ? item.declaration : item;
    if (
      exported &&
      (item.source || item.specifiers.length || item.exportKind === "type")
    )
      return fail(item, "Only inline named exports are supported");
    if (d?.type === "FunctionDeclaration")
      collectFunction(d, exported, moduleNames);
    else
      return fail(
        item,
        "Expected component/helper functions or eager const declarations",
      );
  }
  let generated = 0;
  const fresh = () => {
    let n: string;
    do {
      n = "__tsx" + generated++;
    } while (moduleNames.has(n) || source.includes(n));
    return n;
  };
  const copy = (s: Scope): Scope => ({
    bindings: new Map(s.bindings),
    setters: new Map(s.setters),
    names: new Set(s.names),
    helpers: new Map(s.helpers),

    action: s.action,
    returnShape: s.returnShape,
  });

  const value = (n: Node, scope: Scope, expected?: Shape): Value => {
    if (n.type === "YieldExpression") {
      if (
        !scope.action ||
        n.delegate ||
        !n.argument ||
        n.argument.type !== "CallExpression" ||
        n.argument.callee.type !== "Identifier" ||
        !jsFunctions.has(n.argument.callee.name)
      )
        return fail(
          n,
          "Actions currently support only non-delegating yields of imported JS calls",
        );
      const inner = copy(scope);
      const v = value(n.argument, inner, expected);
      return { e: { k: "await", e: v.e }, shape: v.shape };
    }
    if (n.type === "ParenthesizedExpression") {
      const inner = copy(scope);
      return value(n.expression, inner, expected);
    }

    if (
      n.type === "Literal" &&
      (n.value === null ||
        ["number", "string", "boolean"].includes(typeof n.value))
    ) {
      if (typeof n.value === "number" && !Number.isFinite(n.value))
        return fail(
          n,
          "Overflowed numeric literals cannot be represented by RX's literal emitter",
        );
      return {
        e: { k: "lit", v: n.value },
        shape: {
          kind:
            n.value === null
              ? "null"
              : (typeof n.value as "number" | "string" | "boolean"),
        },
      };
    }
    if (n.type === "Identifier") {
      if (n.name === "undefined" && !scope.bindings.has(n.name))
        return { e: { k: "lit", v: undefined }, shape: { kind: "undefined" } };
      const b = scope.bindings.get(n.name);
      if (
        b?.kind === "accessor" &&
        expected?.kind === "accessor" &&
        matches(b.shape, expected.item!)
      )
        return {
          e: {
            k: "fn",
            params: [],
            body: b.e ?? { k: "id", name: b.name ?? n.name },
          },
          shape: expected,
        };
      if (!b || b.kind === "accessor")
        return fail(
          n,
          b
            ? "Accessor values must be called, not implicitly read"
            : "Unknown value: " + n.name,
        );
      return {
        e: b.e ?? { k: "id", name: b.name ?? n.name },
        shape: b.shape,
      };
    }
    if (n.type === "UnaryExpression" && ["!", "+", "-"].includes(n.operator)) {
      const v = value(n.argument, scope);
      if (n.operator !== "!" && v.shape.kind !== "number")
        return fail(n, "Unary numeric operators require known numeric values");
      return {
        e: n.operator === "+" ? v.e : { k: "un", op: n.operator, e: v.e },
        shape: { kind: n.operator === "!" ? "boolean" : "number" },
      };
    }
    if (n.type === "BinaryExpression" || n.type === "LogicalExpression") {
      if (
        ![
          "+",
          "-",
          "*",
          "/",
          "%",
          "===",
          "!==",
          "<",
          ">",
          "<=",
          ">=",
          "&&",
          "||",
          "??",
        ].includes(n.operator)
      )
        return fail(
          n,
          "Operator is not equivalent across RX execution paths: " + n.operator,
        );
      const l = value(n.left, scope),
        r = value(n.right, scope);
      if (
        !["&&", "||", "??"].includes(n.operator) &&
        (!scalar(l.shape) || !scalar(r.shape))
      )
        return fail(
          n,
          "Structured values cannot be coerced or compared implicitly",
        );
      const op =
        n.operator === "===" ? "==" : n.operator === "!==" ? "!=" : n.operator;
      const shape = ["&&", "||", "??"].includes(op)
        ? merge(l.shape, r.shape)
        : ["==", "!=", "<", ">", "<=", ">="].includes(op)
          ? { kind: "boolean" as const }
          : {
              kind:
                n.operator === "+" &&
                (l.shape.kind === "string" || r.shape.kind === "string")
                  ? ("string" as const)
                  : ("number" as const),
            };
      return {
        e: { k: "bin", op, l: l.e, r: r.e },
        shape,
      };
    }
    if (n.type === "ConditionalExpression") {
      const c = value(n.test, scope),
        t = value(n.consequent, scope, expected),
        f = value(n.alternate, scope, expected);
      return {
        e: { k: "if", c: c.e, t: t.e, f: f.e },
        shape:
          t.e.k === "throw"
            ? f.shape
            : f.e.k === "throw"
              ? t.shape
              : merge(t.shape, f.shape),
      };
    }
    if (n.type === "ArrayExpression") {
      const items = n.elements.map((i): Value => {
        if (!i) return fail(n, "Array holes are unsupported");
        if (i.type === "SpreadElement") {
          const v = value(i.argument, scope);
          if (v.shape.kind !== "array")
            return fail(i, "Array spreads require a known array value");
          return {
            e: { k: "spread", e: v.e },
            shape: v.shape.item!,
          };
        }
        return value(i, scope);
      });
      return {
        e: { k: "arr", items: items.map((v) => v.e) },

        shape: {
          kind: "array",
          item: items.length
            ? items.map((v) => v.shape).reduce(merge)
            : expected?.kind === "array"
              ? expected.item
              : { kind: "scalar" },
        },
      };
    }
    if (n.type === "ObjectExpression") {
      const fields = new Map<string, Shape>();
      const items: { key: string; v: Expr }[] = [];
      for (const p of n.properties) {
        if (
          p.type !== "Property" ||
          p.computed ||
          p.method ||
          p.kind !== "init" ||
          p.key.type !== "Identifier" ||
          ["__proto__", "constructor", "prototype"].includes(p.key.name)
        )
          return fail(
            p,
            "Only plain identifier data properties are supported; no spreads/getters/methods/prototype keys",
          );
        if (fields.has(p.key.name)) return fail(p, "Duplicate object property");
        const v = value(p.value, scope);
        fields.set(p.key.name, v.shape);
        items.push({ key: p.key.name, v: v.e });
      }
      return {
        e: { k: "rec", fields: items },
        shape: { kind: "record", fields },
      };
    }
    if (n.type === "MemberExpression") {
      const o = value(n.object, scope);
      if (o.shape.maybe && !n.optional)
        return fail(n, "Possibly absent values require optional member access");
      if (!n.computed && n.property.type === "Identifier") {
        const key = n.property.name;
        const shape = o.shape.fields
          ? o.shape.fields?.get(key)
          : ["array", "string"].includes(o.shape.kind) && key === "length"
            ? { kind: "number" as const }
            : undefined;
        if (!shape) return fail(n, "Unknown or unsupported member: " + key);
        return {
          e: {
            k: "member",
            o: o.e,
            p: key,
            ...(n.optional ? { opt: true } : {}),
          },
          shape: { ...shape, maybe: o.shape.maybe },
        };
      }
      if (n.computed && o.shape.kind === "array") {
        const i = value(n.property, scope);
        if (i.shape.kind !== "number")
          return fail(n.property, "Array indices must be numeric");
        return {
          e: {
            k: "index",
            o: o.e,
            i: i.e,
            ...(n.optional ? { opt: true } : {}),
          },
          shape: { ...o.shape.item!, maybe: true },
        };
      }
      return fail(n, "Computed record access is unsupported");
    }

    if (n.type === "CallExpression" && !n.optional && !n.typeArguments) {
      if (
        n.callee.type === "MemberExpression" &&
        !n.callee.computed &&
        !n.callee.optional &&
        n.callee.property.type === "Identifier" &&
        ["filter", "every", "map", "findIndex"].includes(n.callee.property.name)
      ) {
        // findIndex lowers to RX's predicate indexOf(xs, f), which both RX runtimes define as xs.findIndex(f).
        const method =
          n.callee.property.name === "findIndex"
            ? "indexOf"
            : n.callee.property.name;
        const array = value(n.callee.object, scope);
        if (array.shape.kind !== "array" || n.arguments.length !== 1)
          return fail(
            n,
            "Array predicates require one callback and a known array value",
          );
        if (authoredBindings.has(method))
          return fail(n, "Array predicate builtin is shadowed: " + method);
        arrayBuiltins.add(method);
        const fn = arrow(n.arguments[0], 1),
          inner = copy(scope);
        const item = bind(fn.params[0], inner.names);
        inner.bindings.set(item, {
          kind: "value",
          shape: array.shape.item!,
        });
        const body = fn.body;
        const predicate = value(body, inner);
        if (method !== "map" && !scalar(predicate.shape))
          return fail(
            body,
            "Array predicates currently require a supported scalar result",
          );
        return {
          e: {
            k: "call",
            f: { k: "id", name: method },
            args: [array.e, { k: "fn", params: [item], body: predicate.e }],
          },
          shape:
            method === "every"
              ? { kind: "boolean" }
              : method === "indexOf"
                ? { kind: "number" }
                : method === "map"
                  ? { kind: "array", item: predicate.shape }
                  : array.shape,
        };
      }
      if (n.callee.type === "Identifier") {
        const name = n.callee.name;
        const b = scope.bindings.get(name);

        if (b?.kind === "accessor" && !n.arguments.length)
          return {
            e: b.e ?? { k: "id", name: b.name ?? name },
            shape: b.shape,
          };
        if (b?.shape.kind === "accessor" && !n.arguments.length)
          return {
            e: {
              k: "call",
              f: b.e ?? { k: "id", name: b.name ?? name },
              args: [],
            },
            shape: b.shape.item!,
          };

        if (jsFunctions.has(name)) {
          if (!expected)
            return fail(
              n,
              "JS function results require an explicit supported TS return annotation; declarations do not retain result shapes",
            );
          const arity = jsFunctions.get(name);
          if (arity !== undefined && arity !== n.arguments.length)
            return fail(
              n,
              "JS call argument count does not match its declaration",
            );
          return {
            e: {
              k: "call",
              f: { k: "id", name },
              args: n.arguments.map((a) => value(a, scope).e),
            },
            shape: expected,
          };
        }
      }
      return fail(
        n,
        "Only known zero-argument accessors, supported Solid probes, and explicitly typed pure helpers may be called here",
      );
    }
    if (
      (n.type === "ArrowFunctionExpression" ||
        n.type === "FunctionExpression") &&
      n.async
    )
      return asyncCallback(n);
    return fail(n, "Unsupported value expression: " + n.type);
  };
  /** A read Solid tracks (an accessor, a store, props) outside untrack; closures read nothing now. */
  const target = (
    n: Node,
    scope: Scope,
    drafts: Map<string, string>,
  ): { name: string; path: (string | Expr)[]; ctx: boolean } => {
    const path: (string | Expr)[] = [];
    let root = n;
    while (root.type === "MemberExpression" && !root.optional) {
      if (root.computed) {
        const index = value(root.property, scope);
        if (index.shape.kind !== "number")
          return fail(root.property, "Draft array indices must be numeric");
        path.unshift(index.e);
      } else if (root.property.type === "Identifier")
        path.unshift(root.property.name);
      else return fail(root, "Unsupported write path");
      root = root.object;
    }
    if (root.type !== "Identifier" || !drafts.has(root.name) || !path.length)
      return fail(
        n,
        "Assignments are only supported on the draft parameter of createStore",
      );
    const name = drafts.get(root.name)!;
    return {
      name,
      path,
      ctx: false,
    };
  };
  const statements = (
    nodes: Node[],
    scope: Scope,
    drafts = new Map<string, string>(),
  ): Stmt[] =>
    nodes.flatMap((n) => {
      if (n.type === "ExpressionStatement")
        return actionExpr(n.expression, scope, drafts);
      if (n.type === "VariableDeclaration") {
        if (n.declarations.length !== 1 || n.declare)
          return fail(n, "Use one imperative local binding per declaration");
        const d = n.declarations[0];
        if (!d.init || d.id.type !== "Identifier")
          return fail(d, "Imperative locals require initialized identifiers");
        const expected = d.id.typeAnnotation
          ? readType(d.id.typeAnnotation.typeAnnotation)
          : undefined;
        const local = copy(scope);
        const v = value(d.init, local, expected);
        if (expected && !matches(v.shape, expected))
          return fail(
            d,
            "Imperative local initializer does not match its annotation",
          );
        const name = bind(d.id, scope.names, true);
        scope.bindings.set(name, { kind: "value", shape: v.shape });
        return [{ k: "let", name, e: v.e }];
      }

      if (n.type === "ReturnStatement") {
        const v = n.argument
          ? value(n.argument, scope, scope.returnShape)
          : undefined;

        if (
          scope.returnShape &&
          !matches(v?.shape ?? { kind: "undefined" }, scope.returnShape)
        )
          return fail(
            n,
            "Return value does not match its explicit result contract",
          );
        return [{ k: "return", ...(v ? { e: v.e } : {}) }];
      }

      if (n.type === "TryStatement") {
        const inner = copy(scope);
        let catchName: string | undefined;
        let caught = n.handler?.body.body;
        if (n.handler?.param) {
          catchName = bind(n.handler.param, inner.names);
          inner.bindings.set(catchName, {
            kind: "value",
            // Untyped JS failures may be primitives; these fields can be undefined, not guaranteed strings.
            shape: {
              kind: "scalar",
              fields: new Map([
                ["name", { kind: "scalar" }],
                ["message", { kind: "scalar" }],
              ]),
            },
          });
        }
        return [
          {
            k: "try",
            body: statements(n.block.body, copy(scope), drafts),
            ...(n.handler
              ? {
                  catchName,
                  handler: statements(caught!, inner, drafts),
                }
              : {}),
            ...(n.finalizer
              ? { fin: statements(n.finalizer.body, copy(scope), drafts) }
              : {}),
          },
        ];
      }
      return fail(n, "Unsupported imperative statement: " + n.type);
    });
  const actionExpr = (
    n: Node,
    scope: Scope,
    drafts = new Map<string, string>(),
  ): Stmt[] => {
    if (n.type === "YieldExpression")
      return [{ k: "expr", e: value(n, scope, { kind: "undefined" }).e }];
    if (
      n.type === "AssignmentExpression" &&
      ["=", "+=", "-=", "*=", "/=", "%="].includes(n.operator)
    ) {
      const t = target(n.left, scope, drafts);
      const rhs = value(n.right, scope);
      let shape: Shape | undefined = scope.bindings.get(t.name)?.shape;
      for (const part of t.path)
        shape =
          typeof part === "string" && shape?.kind === "record"
            ? shape.fields?.get(part)
            : typeof part !== "string" && shape?.kind === "array"
              ? shape.item
              : undefined;
      if (!shape || !matches(rhs.shape, shape))
        return fail(
          n,
          "Draft assignment must preserve the declared property shape",
        );
      const e: Expr =
        n.operator === "="
          ? rhs.e
          : {
              k: "bin",
              op: n.operator[0],
              l: value(n.left, scope).e,
              r: rhs.e,
            };
      return [{ k: "write", target: t, e }];
    }
    if (n.type === "CallExpression" && !n.optional && !n.typeArguments) {
      const factory = n.callee;
      if (
        factory.type === "CallExpression" &&
        factory.callee.type === "Identifier" &&
        primitives.get(factory.callee.name) === "action"
      ) {
        const fn = factory.arguments[0];
        if (
          (fn?.type === "FunctionExpression" ||
            fn?.type === "ArrowFunctionExpression") &&
          fn.async
        )
          return asyncAction(fn);
        if (
          factory.optional ||
          factory.typeArguments ||
          factory.arguments.length !== 1 ||
          n.arguments.length ||
          fn?.type !== "FunctionExpression" ||
          !fn.generator ||
          fn.async ||
          fn.params.length ||
          fn.typeParameters ||
          fn.returnType
        )
          return fail(
            n,
            "Inline actions require an immediately invoked zero-argument synchronous generator",
          );
        const inner = copy(scope);
        inner.action = true;

        inner.returnShape = undefined;
        return [{ k: "action", body: statements(fn.body!.body, inner) }];
      }

      if (n.callee.type === "Identifier" && jsFunctions.has(n.callee.name)) {
        const arity = jsFunctions.get(n.callee.name);
        if (arity !== undefined && arity !== n.arguments.length)
          return fail(
            n,
            "JS call argument count does not match its declaration",
          );
        return [
          {
            k: "expr",
            e: {
              k: "call",
              f: { k: "id", name: n.callee.name },
              args: n.arguments.map((a) => value(a, scope).e),
            },
          },
        ];
      }
      if (n.callee.type === "Identifier" && scope.setters.has(n.callee.name)) {
        const name = scope.setters.get(n.callee.name)!;
        const b = scope.bindings.get(name)!;
        if (n.arguments.length !== 1)
          return fail(n, "Setters take exactly one value or supported updater");
        const argument = n.arguments[0];
        if (b.kind === "store") {
          const fn = arrow(
            argument,
            argument.type === "ArrowFunctionExpression" &&
              argument.params.length === 0 &&
              argument.body.type !== "BlockStatement"
              ? 0
              : 1,
          );
          const inner = copy(scope);
          const param = fn.params.length
            ? bind(fn.params[0], inner.names)
            : undefined;
          if (fn.body.type !== "BlockStatement")
            return fail(fn, "store root replacement");
          if (!param)
            return fail(
              fn,
              "Store draft blocks require one explicit draft parameter",
            );
          inner.bindings.set(param, {
            kind: "value",
            name,
            shape: b.shape,
          });
          const written = new Set<string>();
          const checkReads = (node: unknown): void => {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node)) {
              node.forEach(checkReads);
              return;
            }
            const expr = node as Node;
            if (expr.type === "MemberExpression") {
              let root: Node = expr;
              let key: string | undefined;
              while (root.type === "MemberExpression") {
                key =
                  !root.computed && root.property.type === "Identifier"
                    ? root.property.name
                    : undefined;
                if (root.computed) checkReads(root.property);
                root = root.object;
              }
              if (
                root.type === "Identifier" &&
                [param, name].includes(root.name)
              ) {
                if (written.has("*") || (key ? written.has(key) : written.size))
                  fail(
                    expr,
                    "Draft reads after a write to the same field need sequential draft semantics; split this update",
                  );
                return;
              }
            }
            if (
              expr.type === "Identifier" &&
              [param, name].includes(expr.name) &&
              written.size
            )
              fail(expr, "Reading a whole draft after writes is unsupported");
            if (expr.type === "CallExpression" && written.size)
              fail(
                expr,
                "Calls after draft writes may observe staged values and are unsupported",
              );
            Object.values(node).forEach(checkReads);
          };
          for (const node of fn.body.body) {
            if (
              node.type !== "ExpressionStatement" ||
              node.expression.type !== "AssignmentExpression"
            )
              return fail(
                node,
                "Store draft blocks currently support straight-line assignments only",
              );
            const assignment = node.expression;
            checkReads(assignment.right);
            if (assignment.operator !== "=") checkReads(assignment.left);
            const path = target(
              assignment.left,
              inner,
              new Map([[param, name]]),
            ).path;
            written.add(typeof path[0] === "string" ? path[0] : "*");
          }
          return statements(fn.body.body, inner, new Map([[param, name]]));
        }
        let e: Expr;
        if (argument.type === "ArrowFunctionExpression") {
          const fn = arrow(argument, 1);
          const inner = copy(scope);
          const param = bind(fn.params[0], inner.names);
          inner.bindings.set(param, { kind: "value", shape: b.shape });
          const v = value(
            fn.body,
            inner,
            fn.body.type === "ArrayExpression" ? b.shape : undefined,
          );

          if (!matches(v.shape, b.shape))
            return fail(
              fn.body,
              "Updater must preserve the signal's supported value type",
            );
          e = { k: "fn", params: [param], body: v.e };
        } else {
          const v = value(
            argument,
            scope,
            argument.type === "ArrayExpression" ? b.shape : undefined,
          );

          if (!matches(v.shape, b.shape))
            return fail(
              argument,
              "Setter must preserve the signal's supported value type",
            );
          e = v.e;
        }
        return [
          {
            k: b.optimistic ? "optimistic" : "write",
            target: { name: b.name ?? name, path: [], ctx: false },
            e,
          },
        ];
      }
      if (n.callee.type === "Identifier") {
        const binding = scope.bindings.get(n.callee.name);
        const params = binding?.actionParams;
        if (params) {
          if (params.length !== n.arguments.length)
            return fail(
              n,
              "Action arguments must match its declared parameters",
            );
          const args = n.arguments.map((arg, i) =>
            value(arg, scope, params[i]),
          );
          if (args.some((arg, i) => !matches(arg.shape, params[i])))
            return fail(n, "Action argument does not match its declared type");
          return [
            {
              k: "expr",
              e: {
                k: "call",
                f: { k: "id", name: n.callee.name },
                args: args.map((arg) => arg.e),
              },
            },
          ];
        }
      }
      if (
        n.callee.type === "MemberExpression" ||
        (n.callee.type === "Identifier" &&
          scope.bindings.get(n.callee.name)?.shape.kind === "callback")
      ) {
        const f = value(n.callee, scope);
        if (f.shape.kind === "callback") {
          const params = f.shape.params ?? [];
          if (n.arguments.length !== params.length)
            return fail(
              n,
              "Callback arguments must match the declared parameter count",
            );
          const args = n.arguments.map((arg, i) =>
            value(arg, scope, params[i]),
          );
          if (args.some((arg, i) => !matches(arg.shape, params[i])))
            return fail(
              n,
              "Callback argument does not match its declared type",
            );
          return [
            {
              k: "expr",
              e: { k: "call", f: f.e, args: args.map((arg) => arg.e) },
            },
          ];
        }
      }
    }
    return fail(
      n,
      "Expected a setter, declared callback, or draft assignment; arbitrary imperative calls are unsupported",
    );
  };
  const handler = (n: Node, scope: Scope, expected?: Shape): Expr => {
    // A Solid action used directly as a callback can share RX's inferred-arrow shape, but only if AC-1b agrees.
    const explicitAction =
      n.type === "CallExpression" &&
      n.callee.type === "Identifier" &&
      primitives.get(n.callee.name) === "action";
    if (n.type === "CallExpression" && explicitAction) {
      const fn = n.arguments[0];
      if (
        n.optional ||
        n.typeArguments ||
        n.arguments.length !== 1 ||
        fn?.type !== "FunctionExpression" ||
        !fn.generator ||
        fn.async
      )
        return fail(
          n,
          "Inline action callbacks require a synchronous generator",
        );
      n = fn;
    }
    if (
      n.type === "Identifier" &&
      scope.bindings.get(n.name)?.actionParams?.length
    )
      return fail(
        n,
        "Parameterized actions require a zero-argument forwarding handler with explicit arguments",
      );
    if (n.type === "MemberExpression" || n.type === "Identifier") {
      const v = value(n, scope);
      if (v.shape.kind === "callback") {
        if (expected && !matches(v.shape, expected))
          return fail(
            n,
            "Forwarded callback does not match its declared parameter contract",
          );
        return v.e;
      }
      return fail(n, "Only callback members can be forwarded as handlers");
    }
    if (
      (n.type === "ArrowFunctionExpression" ||
        n.type === "FunctionExpression") &&
      n.async
    )
      return asyncCallback(n);
    if (
      (n.type !== "ArrowFunctionExpression" &&
        n.type !== "FunctionExpression") ||
      (n.type === "FunctionExpression" && !explicitAction) ||
      n.typeParameters ||
      (n.returnType && n.returnType.typeAnnotation.type !== "TSVoidKeyword")
    )
      return fail(
        n,
        "Handlers require supported typed arrow parameters; synchronous result annotations must be void",
      );
    const fn = n;
    if (expected && fn.params.length > (expected.params?.length ?? 0))
      return fail(fn, "Callback parameters exceed its declared contract");
    if (!expected && fn.params.length > 1)
      return fail(
        fn,
        "Intrinsic handlers currently support one typed event parameter",
      );
    const inner = copy(scope);
    inner.action = explicitAction;
    inner.returnShape = undefined;
    const params = fn.params.map((param, i) => {
      if (param.type !== "Identifier")
        return fail(param, "Handler parameters require identifier bindings");
      const type = param.typeAnnotation
        ? readType(param.typeAnnotation.typeAnnotation)
        : expected?.params?.[i];
      if (!type)
        return fail(
          param,
          "Event parameters require an explicit inline supported value type",
        );
      if (expected?.params?.[i] && !matches(expected.params[i], type))
        return fail(
          param,
          "Handler parameter does not match its callback contract",
        );
      const name = bind(param, inner.names, true);
      inner.bindings.set(name, { kind: "value", shape: type });
      return name;
    });
    const body = fn.body ?? fail(fn, "A callback needs a body");
    const stmts =
      body.type === "BlockStatement"
        ? statements(body.body, inner)
        : actionExpr(body, inner);
    // Inferred actions (pinned upstream AC-1b): a plain Solid callback is never an action, but upstream infers one
    // from the lowered body. Ordinary async callbacks are refused above (issue #20); this guard still refuses any
    // lowered body whose writes upstream would hold (AC-1c) while Solid applies them at once. Other inferred actions
    // (refresh/affects) are left to the shared checker and are covered by the differential suites.
    const inferred = actionInference(stmts);
    if (explicitAction && !inferred.trigger)
      return fail(
        fn,
        "Inline action callbacks need an AC-1b trigger; otherwise use a named action",
      );
    if (!explicitAction && inferred.held.length)
      return fail(
        fn,
        "Solid applies " +
          inferred.held.join(", ") +
          " immediately, before the await, but ReactiveScript infers this callback as an action (AC-1b: " +
          inferred.why +
          ") and holds that write until the body ends (AC-1c); write after the await, or wrap the callback in action(...) to hold it deliberately",
      );
    return {
      k: "fn",
      params,
      body: { k: "lit", v: undefined },
      stmts,
    };
  };
  const display = (v: Value, at: Span): Markup[] => {
    if (v.shape.kind === "view") return [{ k: "read", e: v.e, line: line(at) }];
    if (
      v.shape.kind === "record" ||
      v.shape.kind === "callback" ||
      v.shape.kind === "accessor"
    )
      return fail(at, "Plain objects/functions are not Solid JSX children");
    if (v.shape.kind === "array") {
      const name = fresh();
      return [
        {
          k: "mfor",
          name,
          xs: v.e,
          decls: [],
          body: display({ e: { k: "id", name }, shape: v.shape.item! }, at),
          line: line(at),
        },
      ];
    }
    if (
      ["boolean", "null", "undefined"].includes(v.shape.kind) &&
      !v.shape.maybe
    )
      return [
        {
          k: "read",
          e: {
            k: "if",
            c: v.e,
            t: { k: "lit", v: "" },
            f: { k: "lit", v: "" },
          },
          line: line(at),
        },
      ];
    let e: Expr = { k: "bin", op: "+", l: { k: "lit", v: "" }, r: v.e };
    if (v.shape.kind === "scalar" || v.shape.maybe) {
      const omitted = [true, false, null, undefined]
        .map(
          (x) =>
            ({ k: "bin", op: "==", l: v.e, r: { k: "lit", v: x } }) as Expr,
        )
        .reduce((l, r) => ({ k: "bin", op: "||", l, r }));
      e = { k: "if", c: omitted, t: { k: "lit", v: "" }, f: e };
    }
    return [{ k: "read", e, line: line(at) }];
  };
  const text = (raw: string): string => {
    // Rust char::is_whitespace, used by Solid's trim_jsx_text, is not JS \s.
    const whitespace =
      /[\u0009-\u000d \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
    let s = raw.replace(/\r/g, "");
    if (s.includes("\n"))
      s = s
        .split("\n")
        .map((line, i) =>
          i
            ? line.replace(new RegExp("^" + whitespace.source + "+"), "")
            : line,
        )
        .filter((line) => [...line].some((c) => !whitespace.test(c)))
        .join(" ");
    return s.replace(new RegExp(whitespace.source + "+", "g"), " ");
  };
  const markup = (n: Node, scope: Scope, owner: Fn): Markup[] => {
    if (n.type === "ParenthesizedExpression")
      return markup(n.expression, scope, owner);
    if (n.type === "JSXFragment")
      return n.children.flatMap((c) => markup(c, scope, owner));
    if (n.type === "JSXText") {
      const s = decodeHTML(text(n.value));
      return s ? [{ k: "text", s, line: line(n) }] : [];
    }
    if (n.type === "JSXExpressionContainer")
      return n.expression.type === "JSXEmptyExpression"
        ? []
        : markup(n.expression, scope, owner);
    if (n.type === "ArrayExpression")
      return n.elements.flatMap((e) =>
        e
          ? markup(e, scope, owner)
          : fail(n, "JSX arrays cannot contain holes"),
      );
    if (n.type === "ConditionalExpression")
      return [
        {
          k: "mif",
          c: value(n.test, scope).e,
          t: markup(n.consequent, scope, owner),
          tDecls: [],
          f: markup(n.alternate, scope, owner),
          fDecls: [],
          line: line(n),
        },
      ];
    if (n.type === "LogicalExpression" && n.operator === "&&") {
      const c = value(n.left, scope);
      return [
        {
          k: "mif",
          c: c.e,
          t: markup(n.right, scope, owner),
          tDecls: [],
          f: display(c, n.left),
          fDecls: [],
          line: line(n),
        },
      ];
    }
    if (n.type !== "JSXElement") return display(value(n, scope), n);
    const opening = n.openingElement;
    if (opening.name.type !== "JSXIdentifier" || opening.typeArguments)
      return fail(
        opening,
        "Only intrinsic or named component JSX is supported",
      );
    const tag = opening.name.name;
    const primitive = primitives.get(tag);
    const attrs = new Map<string, { node: Node; at: Span }>();
    for (const a of opening.attributes) {
      if (a.type !== "JSXAttribute" || a.name.type !== "JSXIdentifier")
        return fail(a, "JSX spreads/namespaces are unsupported");
      const key = a.name.name;
      if (attrs.has(key)) return fail(a, "Duplicate JSX attribute: " + key);
      const quoted =
        a.value?.type === "Literal" && typeof a.value.value === "string"
          ? { ...a.value, value: decodeHTML(a.value.value) }
          : a.value;
      attrs.set(key, {
        node:
          a.value?.type === "JSXExpressionContainer"
            ? a.value.expression
            : (quoted ?? {
                type: "Literal",
                value: true,
                start: a.start,
                end: a.end,
                raw: "true",
              }),
        at: a,
      });
    }

    if (primitive === "Show") {
      const when = attrs.get("when");
      if (
        !when ||
        [...attrs.keys()].some((k) => !["when", "fallback"].includes(k))
      )
        return fail(
          opening,
          "Show supports when and optional fallback, without keyed mode",
        );
      const condition = value(when.node, scope);
      const children = n.children.filter(
        (c) =>
          (c.type !== "JSXText" || text(c.value)) &&
          (c.type !== "JSXExpressionContainer" ||
            c.expression.type !== "JSXEmptyExpression"),
      );
      const callback =
        children.length === 1 &&
        children[0].type === "JSXExpressionContainer" &&
        children[0].expression.type === "ArrowFunctionExpression"
          ? children[0].expression
          : undefined;
      const inner = copy(scope);
      const tDecls: Decl[] = [];
      if (callback) {
        const fn = arrow(callback, 1),
          name = bind(fn.params[0], inner.names);
        inner.bindings.set(name, { kind: "accessor", shape: condition.shape });
        tDecls.push({ k: "eq", name, e: condition.e, line: line(callback) });
      }
      return [
        {
          k: "mif",
          c: condition.e,
          t: callback
            ? markup(callback.body, inner, owner)
            : n.children.flatMap((c) => markup(c, scope, owner)),
          tDecls,
          f: attrs.has("fallback")
            ? markup(attrs.get("fallback")!.node, scope, owner)
            : [],
          fDecls: [],
          line: line(n),
        },
      ];
    }
    if (primitive === "For") {
      const each = attrs.get("each");
      if (
        !each ||
        [...attrs.keys()].some((k) => !["each", "fallback"].includes(k))
      )
        return fail(
          opening,
          "For supports each and optional fallback with default identity keying",
        );
      const xs = value(each.node, scope);
      if (xs.shape.kind !== "array")
        return fail(each.node, "For each must have a known array shape");
      const children = n.children.filter(
        (c) => c.type !== "JSXText" || text(c.value),
      );
      if (
        children.length !== 1 ||
        children[0].type !== "JSXExpressionContainer"
      )
        return fail(n, "For requires one item => JSX child callback");
      const fn = arrow(children[0].expression, 1);
      const inner = copy(scope);
      const name = bind(fn.params[0], inner.names);
      inner.bindings.set(name, { kind: "value", shape: xs.shape.item! });
      if (fn.body.type === "BlockStatement")
        return fail(
          fn.body,
          "For callbacks currently require expression bodies",
        );
      const loop: Markup = {
        k: "mfor",
        name,
        xs: xs.e,
        decls: [],
        body: markup(fn.body, inner, owner),
        line: line(n),
      };
      return attrs.has("fallback")
        ? [
            {
              k: "mif",
              c: {
                k: "bin",
                op: ">",
                l: { k: "member", o: xs.e, p: "length" },
                r: { k: "lit", v: 0 },
              },
              t: [loop],
              tDecls: [],
              f: markup(attrs.get("fallback")!.node, scope, owner),
              fDecls: [],
              line: line(n),
            },
          ]
        : [loop];
    }
    if (primitive)
      return fail(
        opening,
        "This imported Solid control is not lowered yet: " + primitive,
      );
    const child = scope.helpers.get(tag);
    if (!child && !/^[a-z][a-z0-9-]*$/.test(tag))
      return fail(opening, "Unknown component: " + tag);
    if (child && !child.component)
      return fail(opening, "Pure helpers are not components");
    if (child) {
      if (
        child.fields.get("children")?.kind !== "view" &&
        n.children.some((c) => c.type !== "JSXText" || text(c.value))
      )
        return fail(
          n.children[0],
          "Component children need a view contract, which is not supported yet",
        );
      owner.refs.push({ tag, node: opening });
    }
    const out: { name: string; e: Expr }[] = [];
    for (const [key, a] of attrs) {
      if (["children", "ref", "__proto__"].includes(key))
        return fail(a.at, "Reserved JSX attribute: " + key);
      const expected = child?.fields.get(key);
      if (child && !expected)
        return fail(a.at, "Unknown component prop: " + key);
      if (handlerName(key))
        out.push({ name: key, e: handler(a.node, scope, expected) });
      else {
        const v = value(a.node, scope);
        if (expected && !matches(v.shape, expected))
          return fail(
            a.node,
            "Component prop does not match its declared type",
          );
        if (!child && !scalar(v.shape))
          return fail(
            a.node,
            "Intrinsic attributes currently require primitive values",
          );
        out.push({ name: key, e: v.e });
      }
    }
    if (child)
      for (const key of child.fields.keys())
        if (key !== "children" && !attrs.has(key))
          return fail(opening, "Missing required prop: " + key);
    return [
      {
        k: "el",
        tag,
        attrs: out,
        children:
          child && child.fields.get("children")?.kind !== "view"
            ? []
            : n.children.flatMap((c) => markup(c, scope, owner)),
        line: line(n),
      },
    ];
  };
  const setup = (nodes: Node[], scope: Scope): Decl[] => {
    const decls: Decl[] = [];
    for (const node of nodes) {
      if (node.type === "FunctionDeclaration") continue;
      if (
        node.type !== "VariableDeclaration" ||
        node.kind !== "const" ||
        node.declarations.length !== 1 ||
        node.declare
      )
        return fail(
          node,
          "Component setup supports const bindings and two-callback createRxEffect calls",
        );
      const d = node.declarations[0],
        call = d.init;
      const primitive =
        call?.type === "CallExpression" && call.callee.type === "Identifier"
          ? primitives.get(call.callee.name)
          : undefined;
      if (
        ![
          "createSignal",
          "createOptimistic",
          "createMemo",
          "createStore",
          "action",
        ].includes(primitive ?? "")
      )
        return fail(node, "setup binding");
      if (
        !call ||
        call.type !== "CallExpression" ||
        call.optional ||
        call.arguments.length !== 1 ||
        call.typeArguments ||
        d.definite
      )
        return fail(
          d,
          "reactive primitives require one argument without options or type arguments",
        );
      if (primitive === "action") {
        const fn = call.arguments[0];
        if (
          (fn.type === "FunctionExpression" ||
            fn.type === "ArrowFunctionExpression") &&
          fn.async
        )
          return asyncAction(fn);
        if (
          fn.type !== "FunctionExpression" ||
          !fn.generator ||
          fn.async ||
          fn.typeParameters ||
          fn.returnType
        )
          return fail(
            fn,
            "Actions require a synchronous generator function without type parameters or a return annotation",
          );
        const name = bind(d.id, scope.names),
          inner = copy(scope);
        inner.action = true;
        const params = fn.params.map((param) => {
          if (param.type !== "Identifier" || !param.typeAnnotation)
            return fail(
              param,
              "Action parameters require explicit supported value types",
            );
          const shape = readType(param.typeAnnotation.typeAnnotation);
          const name = bind(param, inner.names, true);
          inner.bindings.set(name, { kind: "value", shape });
          return { name, shape };
        });
        scope.bindings.set(name, {
          kind: "value",
          shape: { kind: "callback" },
          actionParams: params.map((param) => param.shape),
        });
        decls.push({
          k: "action",
          name,
          params: params.map((param) => param.name),
          body: statements(fn.body!.body, inner),
          line: line(node),
        });
      } else if (primitive === "createMemo") {
        const memo = arrow(call.arguments[0]);
        const body =
          memo.body.type === "BlockStatement" &&
          memo.body.body.length === 1 &&
          memo.body.body[0].type === "ReturnStatement"
            ? memo.body.body[0].argument
            : memo.body;
        if (!body) return fail(memo, "memo without a value");
        const expected = memo.returnType
          ? readType(memo.returnType.typeAnnotation)
          : undefined;
        const v = value(body, scope, expected);
        if (expected && !matches(v.shape, expected))
          return fail(body, "memo result annotation");
        const name = bind(d.id, scope.names);
        scope.bindings.set(name, { kind: "accessor", shape: v.shape });
        decls.push({ k: "eq", name, e: v.e, line: line(node) });
      } else {
        if (
          d.id.type !== "ArrayPattern" ||
          d.id.elements.length !== 2 ||
          !d.id.elements[0] ||
          !d.id.elements[1] ||
          d.id.typeAnnotation ||
          d.id.optional
        )
          return fail(d.id, "signals/stores require [read, write] bindings");
        const initializer = call.arguments[0];
        const question =
          primitive === "createOptimistic" &&
          initializer.type === "ArrowFunctionExpression";
        const v = value(
          question ? arrow(initializer).body : initializer,
          scope,
        );
        if (primitive === "createSignal" && !scalar(v.shape))
          return fail(
            initializer,
            "createSignal with an object/array is not lowered: RX gives structured sources store semantics; use createStore instead",
          );
        if (
          primitive === "createStore" &&
          !["record", "array"].includes(v.shape.kind)
        )
          return fail(initializer, "store seed must be a record or array");
        const read = bind(d.id.elements[0], scope.names),
          write = bind(d.id.elements[1], scope.names);
        scope.bindings.set(read, {
          kind: primitive === "createStore" ? "store" : "accessor",
          shape: v.shape,
          optimistic: primitive === "createOptimistic",
        });
        scope.setters.set(write, read);
        decls.push({
          k: "source",
          name: read,
          init:
            primitive === "createOptimistic" && !question
              ? { k: "peek", e: v.e }
              : v.e,
          ...(primitive === "createOptimistic" ? { question: true } : {}),
          line: line(node),
        });
      }
    }
    return decls;
  };
  for (const [name, meta] of functions) {
    if (!meta.fn) continue;
    if (!meta.component) {
      return fail(meta.fn, "setup helper");
    }
    const fn = meta.fn;
    const scope = copy(moduleScope);
    const decls: Decl[] = [];
    if (meta.component) {
      if (scope.names.has(meta.props))
        return fail(fn.params[0] ?? fn, "Props cannot shadow a module binding");
      scope.names.add(meta.props);
      scope.bindings.set(meta.props, {
        kind: "value",
        shape: { kind: "record", fields: meta.fields },
        props: true,
      });
    }
    const nodes = fn.body!.body;
    const ret = nodes.at(-1);
    if (!ret || ret.type !== "ReturnStatement" || !ret.argument)
      return fail(fn, "Functions must end with one value/JSX return");
    decls.push(...setup(nodes.slice(0, -1), scope));
    meta.decls = decls;
    result.decls.push({
      k: "component",
      name,
      props: meta.props,
      propsType: meta.propsType,
      decls,
      view: markup(ret.argument, scope, meta),
      line: line(fn),
      ...(meta.exported ? { exported: true } : {}),
      ...(name === defaultComponent ? { isDefault: true } : {}),
    });
  }
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (name: string): void => {
    if (done.has(name)) return;
    visiting.add(name);
    for (const ref of functions.get(name)!.refs) {
      if (visiting.has(ref.tag))
        fail(ref.node, "Recursive component composition is unsupported");
      visit(ref.tag);
    }
    visiting.delete(name);
    done.add(name);
  };
  for (const name of functions.keys()) visit(name);
  // JavaScript's temporal dead zone: an eager initializer (a setup const, a signal or store seed) runs at its declaration,
  // so it cannot read a binding initialized at or after it — directly, through a helper it calls or an equation it reads,
  // or in a closure it captures. RX sources have no such ordering, so the frontend refuses it instead of accepting it.
  const temporalDeadZone = (decls: Decl[]) => {
    const order = new Map<string, number>();
    decls.forEach((d, i) => {
      if (d.k === "source" && !d.question) order.set(d.name, i);
    });
    const bodies = new Map<string, unknown[]>();
    for (const d of decls)
      if (d.k === "fn") bodies.set(d.name, [d.tail, d.decls]);
      else if (d.k === "eq") bodies.set(d.name, [d.e]);
    decls.forEach((d, i) => {
      if (d.k !== "source" || d.question) return;
      const seen = new Set<string>();
      const visit = (x: unknown): string | undefined => {
        if (Array.isArray(x)) {
          for (const y of x) {
            const hit = visit(y);
            if (hit) return hit;
          }
          return;
        }
        if (!x || typeof x !== "object") return;
        const o = x as { k?: string; name?: unknown };
        if ((o.k === "id" || o.k === "pre") && typeof o.name === "string") {
          const at = order.get(o.name);
          if (at !== undefined && at >= i) return o.name;
          if (bodies.has(o.name) && !seen.has(o.name)) {
            seen.add(o.name);
            return visit(bodies.get(o.name));
          }
          return;
        }
        return visit(Object.values(x));
      };
      const hit = visit(d.init);
      if (hit) {
        const offset = source
          .split("\n")
          .slice(0, d.line - 1)
          .reduce((n, l) => n + l.length + 1, 0);
        fail(
          { start: offset, end: offset },
          d.name +
            " reads " +
            hit +
            " before its initialization (JavaScript's temporal dead zone); declare " +
            hit +
            " first",
        );
      }
    });
    for (const d of decls)
      if (d.k === "component" || d.k === "fn") temporalDeadZone(d.decls);
  };
  temporalDeadZone(result.decls);
  if (defaultComponent) {
    const entry = result.decls.find(
      (d) => d.k === "component" && d.name === defaultComponent,
    );
    if (!entry)
      return fail(parsed.program, "default export must be a component");
    result.view = entryView(defaultComponent, entry.line);
  }
  return result;
}
