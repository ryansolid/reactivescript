// A deliberately bounded Solid TSX spelling for the existing ReactiveScript AST.
// Explicit Node entry: Solid tests use the browser condition, which otherwise selects Oxc's WASM build.
import {
  parseSync,
  type Node,
  type Span,
  type ArrowFunctionExpression,
  type JSXElement,
  type Function as OxcFunction,
} from "oxc-parser/src-js/index";
import { entryView, serverDecl, type Program, type Decl, type Expr, type Markup, type Stmt } from "./rx/ast.ts";
import { actionInference } from "./rx/infer.ts";
import type { JsDecl } from "./rx/compiler.ts";
import { decodeHTML } from "entities";

/** E-9: a fn with ref params or declarations is instantiating (an owned region). */
const instantiating = (d: Extract<Decl, { k: "fn" }>) =>
  d.params.some((p) => p.ref) || d.decls.length > 0;
/** Frontend-only analysis, never part of the RX AST or signatures: the exports of a lowered TSX module that are immutable
 *  TSX values (setup consts). RX sees ordinary equations or `source x := …` exports; a TSX importer reads these bare,
 *  as values, rather than as accessors, and has no setter for them. */
const immutableExports = new WeakMap<Program, Set<string>>();

export class TsxError extends Error {
  filename: string;
  line: number;
  column: number;
  start: number;
  end: number;
  constructor(filename: string, source: string, span: Span, message: string) {
    const before = source.slice(0, span.start);
    const line = before.split("\n").length;
    const column = before.length - before.lastIndexOf("\n");
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
export function lowerTsx(
  source: string,
  filename = "input.tsx",
  options: LowerOptions = {},
): Program {
  const fail = (n: Span, message: string): never => {
    throw new TsxError(filename, source, n, message);
  };
  const parsed = parseSync(filename, source, {
    sourceType: "module",
    lang: "tsx",
  });
  if (parsed.errors.length) {
    const e = parsed.errors[0];
    fail(e.labels[0] ?? { start: 0, end: 0 }, e.message);
  }
  const line = (n: Span) => source.slice(0, n.start).split("\n").length;
  // Snapshot and inertness facts are carried on the resolved Binding (`snapshot`, `inert`), never by spelling: owners,
  // branches and helpers each resolve names through their own scope.
  /** Literals, allowed names, and operators, conditionals and templates over them: no call, member access, allocation,
   *  reactive read or await, so evaluating it again or later cannot change count, order, identity or failure timing. */
  const inertWith = (x: unknown, ok: (name: string) => boolean): boolean => {
    if (Array.isArray(x)) return x.every((y) => inertWith(y, ok));
    if (!x || typeof x !== "object") return true;
    const o = x as { k?: string; name?: unknown };
    if (o.k === "lit") return true;
    if (o.k === "id") return typeof o.name === "string" && ok(o.name);
    if (o.k === "peek" || o.k === "un" || o.k === "bin" || o.k === "if" || o.k === "tpl")
      return Object.entries(x).every(([key, y]) => key === "k" || key === "op" || inertWith(y, ok));
    return false;
  };
  /** Authored spans of setup consts, for diagnostics raised after lowering. */
  const constSpans = new WeakMap<Decl, Span>();
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
  type Value = { e: Expr; shape: Shape; capturesProjection?: boolean };
  type Binding = {
    kind: "value" | "accessor" | "store";
    shape: Shape;
    name?: string;
    e?: Expr;
    derivedStore?: boolean;
    storeQuestion?: boolean;
    capturesProjection?: boolean;
    serverQuestion?: boolean;
    serverMemo?: boolean;
    previousTarget?: boolean;
    optimistic?: boolean;
    ctx?: boolean;
    props?: boolean;   // a component's props: reads are tracked in Solid
    snapshot?: boolean;   // a setup const (or imported TSX const): a never-written eager snapshot, read untracked
    inert?: boolean;   // a snapshot whose initializer is inert (see inertWith)
    failure?: { params: string[]; shapes: Shape[]; result: Shape };
    actionParams?: Shape[];
    server?: {
      kind: "fn" | "action";
      params: Shape[];
      result: Shape;
      unknownResult?: boolean;
    };
  };
  type Scope = {
    bindings: Map<string, Binding>;
    setters: Map<string, string>;
    names: Set<string>;
    helpers: Map<string, Fn>;
    contextReads?: boolean;
    action?: boolean;
    returnShape?: Shape;
    effect?: boolean;
    serverCall?: Node;
  };
  type Fn = {
    fn?: OxcFunction;
    exported?: boolean;
    component: boolean;
    props: string;
    fields: Map<string, Shape>;
    params: { name: string; shape: Shape; type?: string; ref?: boolean }[];
    returnsAccessor?: boolean;
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
  const typeText = (text: string, at: Span): Shape => {
    const p = parseSync(
      "contract.tsx",
      "function Contract(value: " +
        text.replaceAll("action catches(nothing)", "() => void") +
        ") {}",
      { lang: "tsx", sourceType: "module" },
    );
    if (p.errors.length)
      return fail(at, "Unsupported imported type contract: " + text);
    const fn = p.program.body[0];
    if (
      fn.type !== "FunctionDeclaration" ||
      fn.params[0]?.type !== "Identifier" ||
      !fn.params[0].typeAnnotation
    )
      return fail(at, "Unsupported imported contract");
    // Imported contracts have synthetic offsets; report failures at the authored import instead.
    try {
      return readType(fn.params[0].typeAnnotation.typeAnnotation);
    } catch {
      return fail(at, "Unsupported imported type contract: " + text);
    }
  };
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
  // callbacks only; async memo, function-form store and server computations keep their own routes.
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
  const contexts = new Map<string, Shape>();
  const sourceContexts = new Set<string>();
  const moduleNames = new Set<string>();
  const moduleScope: Scope = {
    bindings: new Map(),
    setters: new Map(),
    names: moduleNames,
    helpers: functions,
  };
  const result: Program = { decls: [], view: [] };
  const constants: {
    node: Extract<Node, { type: "VariableDeclaration" }>;
    exported: boolean;
  }[] = [];
  let declarationsStarted = false;
  /** The module's `export default function Name` component: its entry (upstream MO-1c). */
  let defaultComponent: string | undefined;
  /** Untracked captures of structured store objects. RX has only a value snapshot (peek); Solid returns the live
   *  proxy. They agree only while nothing updates the captured object in place, which is checked after lowering. */
  const structuredCaptures: { store: string; path: string[]; at: Span; derived: boolean }[] = [];
  const collectFunction = (
    fn: OxcFunction,
    exported: boolean,
    names: Set<string>,
    into = functions,
  ) => {
    // A named async function inside a component is a stored callback, refused with the same guidance whatever its name.
    if (fn.async && into !== functions)
      return asyncCallback(fn);
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
    } else {
      for (const p of fn.params) {
        if (
          p.type !== "Identifier" ||
          p.optional ||
          p.decorators?.length ||
          !p.typeAnnotation
        )
          return fail(p, "Pure helper parameters require explicit value types");
        const annotation = p.typeAnnotation.typeAnnotation;
        const ref =
          annotation.type === "TSFunctionType" &&
          !annotation.params.length &&
          !annotation.typeParameters;
        const shape = readType(
          ref ? annotation.returnType.typeAnnotation : annotation,
        );
        meta.params.push({
          name: p.name,
          shape,
          type: printType(shape),
          ref,
        });
      }
      if (!fn.returnType)
        return fail(fn, "Pure helpers require an explicit return type");
      const annotation = fn.returnType.typeAnnotation;
      meta.returnsAccessor =
        annotation.type === "TSFunctionType" &&
        !annotation.params.length &&
        !annotation.typeParameters;
      meta.ret = readType(
        meta.returnsAccessor && annotation.type === "TSFunctionType"
          ? annotation.returnType.typeAnnotation
          : annotation,
      );
      if (!meta.returnsAccessor && meta.params.some((p) => p.ref))
        return fail(
          fn,
          "Accessor parameters currently require an accessor-returning setup helper",
        );
      if (meta.ret.kind === "callback")
        return fail(fn.returnType, "Helpers cannot return callbacks");
    }
    into.set(name, meta);
  };
  for (const item of parsed.program.body) {
    if (item.type === "ImportDeclaration") {
      if (
        item.importKind === "type" &&
        item.source.value === "solid-js" &&
        item.specifiers.length &&
        item.specifiers.every(
          (spec) =>
            spec.type === "ImportSpecifier" &&
            spec.imported.type === "Identifier" &&
            ["Element", "JSX"].includes(spec.imported.name),
        )
      ) {
        for (const spec of item.specifiers)
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported.type === "Identifier" &&
            spec.imported.name === "Element"
          )
            viewTypes.add(spec.local.name);
        continue;
      }
      if (
        declarationsStarted ||
        item.importKind === "type" ||
        item.phase ||
        item.attributes.length ||
        !item.specifiers.length
      )
        return fail(item, "Use named value imports before declarations");
      const dep = options.modules?.get(String(item.source.value));
      const names: { name: string; alias: string }[] = [];
      for (const spec of item.specifiers) {
        if (
          spec.type === "ImportSpecifier" &&
          spec.importKind === "type" &&
          item.source.value === "solid-js" &&
          spec.imported.type === "Identifier" &&
          ["Element", "JSX"].includes(spec.imported.name)
        ) {
          if (spec.imported.name === "Element") viewTypes.add(spec.local.name);
          continue;
        }
        if (
          spec.type !== "ImportSpecifier" ||
          spec.importKind === "type" ||
          spec.imported.type !== "Identifier"
        )
          return fail(spec, "Only named value imports are supported");
        const local = bind(spec.local, moduleNames);
        const imported = spec.imported.name;
        if (item.source.value === "reactivescript-tsx") {
          if (
            ![
              "defineError",
              "raiseFailure",
              "catchFailure",
              "FailureBoundary",
              "createSourceContext",
              "useSourceContext",
              "serverFunction",
              "serverAction",
              "createServerMemo",
              "createPrevious",
              "createRxEffect",
              "refresh",
            ].includes(imported)
          )
            return fail(spec, "Unsupported ReactiveScript helper: " + imported);
          primitives.set(
            local,
            imported === "refresh" ? "extensionRefresh" : imported,
          );
          continue;
        }
        if (item.source.value === "solid-js") {
          if (
            ![
              "createSignal",
              "createOptimistic",
              "createMemo",
              "createDeferred",
              "createStore",
              "createProjection",
              "createContext",
              "useContext",
              "refresh",
              "affects",
              "action",
              "untrack",
              "latest",
              "isPending",
              "Show",
              "For",
              "Loading",
              "Errored",
              "createEffect",
            ].includes(imported)
          )
            return fail(spec, "Unsupported Solid import: " + imported);
          primitives.set(local, imported);
          continue;
        }
        if (!dep) {
          const declarations = options.declarations?.get(
            String(item.source.value),
          );
          const contract = declarations?.find((d) => d.name === imported);
          if (declarations && !contract)
            return fail(
              spec,
              "JS declaration file does not export " + imported,
            );
          if (contract && contract.kind !== "fn")
            return fail(
              spec,
              "Only declared JS function imports are supported in this batch",
            );
          jsFunctions.set(local, contract?.params.length);
          names.push({ name: imported, alias: local });
          continue;
        }
        const d = dep.program.decls.find(
          (d) =>
            "exported" in d && d.exported && "name" in d && d.name === imported,
        );
        if (!d) return fail(spec, "Dependency does not export " + imported);
        if (d.k === "component") {
          const type = d.propsType
            ? typeText(d.propsType, spec)
            : { kind: "record" as const, fields: new Map<string, Shape>() };
          if (type.kind !== "record")
            return fail(
              spec,
              "Imported component needs an object prop contract",
            );
          functions.set(local, {
            component: true,
            props: d.props,
            fields: type.fields!,
            params: [],
            propsType: d.propsType,
            refs: [],
          });
        } else if (d.k === "fn") {
          if (!d.ret || d.params.some((p) => !p.type))
            return fail(
              spec,
              "Imported helper needs explicit value parameters/return type and a pure expression body",
            );
          functions.set(local, {
            component: false,
            props: "props",
            fields: new Map(),
            params: d.params.map((p) => ({
              name: p.name,
              shape: typeText(p.type!, spec),
              type: p.type,
              ref: p.ref,
            })),
            ret: typeText(d.ret, spec),
            returnsAccessor: d.params.some((p) => p.ref) || d.decls.length > 0,
            refs: [],
          });
        } else if (d.k === "error") {
          if (["Error", "Panic"].includes(local))
            return fail(
              spec,
              "Imported failure aliases Error and Panic are reserved RX identities",
            );
          const shapes: Shape[] = d.params.map(() => ({ kind: "scalar" }));
          const result: Shape = {
            kind: "record",
            fields: new Map([
              ["name", { kind: "string" }],
              ["message", { kind: "string" }],
              ...d.params.map((param, i): [string, Shape] => [
                param,
                shapes[i],
              ]),
            ]),
          };
          moduleScope.bindings.set(local, {
            kind: "value",
            shape: { kind: "callback" },
            failure: { params: d.params, shapes, result },
          });
        } else if (d.k === "action") {
          moduleScope.bindings.set(local, {
            kind: "value",
            shape: { kind: "callback" },
            actionParams: d.params.map(() => ({ kind: "scalar" })),
          });
        } else if (d.k === "server") {
          // Upstream infers whether a server fn is io from its body; an imported RX server fn carries no authored
          // loader/action intent, so it is callable as a loader and the shared checker refuses io in reactive scope.
          moduleScope.bindings.set(local, {
            kind: "value",
            shape: { kind: "callback" },
            server: {
              kind: "fn",
              params: d.params.map(() => ({ kind: "scalar" })),
              result: { kind: "scalar" },
              unknownResult: true,
            },
          });
        } else if (d.k === "context") {
          if (!d.type)
            return fail(
              spec,
              "Imported contexts require an explicit read-only primitive contract; writable contexts are unsupported",
            );
          const shape = typeText(d.type, spec);
          if (
            ![
              "number",
              "string",
              "boolean",
              "null",
              "scalar",
              "accessor",
            ].includes(shape.kind)
          )
            return fail(
              spec,
              "Imported contexts currently require a primitive value shape",
            );
          contexts.set(local, shape);
          if (d.source) sourceContexts.add(local);
        } else if ((d.k === "source" || d.k === "eq") && d.type) {
          const shape = typeText(d.type, spec);
          // A TSX setup const is exported as a never-written snapshot source; its readers see a plain value.
          const plain =
            dep.path.endsWith(".tsx") &&
            !!immutableExports.get(dep.program)?.has(d.name);
          const store =
            !plain &&
            dep.path.endsWith(".tsx") &&
            ((d.k === "source" && ["record", "array"].includes(shape.kind)) ||
              (d.k === "eq" && (d.key !== undefined || d.e.k === "draft")));
          moduleScope.bindings.set(local, {
            kind: store
              ? "store"
              : dep.path.endsWith(".tsx") && !plain
                ? "accessor"
                : "value",
            shape,
            ...(plain ? { snapshot: true } : {}),
            ...(d.k === "eq" && ["await", "catch"].includes(d.e.k)
              ? { serverQuestion: true }
              : {}),
            ...(store && d.k === "eq" ? { derivedStore: true } : {}),
          });
        } else
          return fail(
            spec,
            "Imported value needs an explicit supported type contract",
          );
        names.push({ name: imported, alias: local });
      }
      if (names.length)
        result.decls.push({
          k: "import",
          names,
          from: String(item.source.value),
          pure: false,
          ...(dep ? { resolved: dep.path } : {}),
          line: line(item),
        });
      continue;
    }
    declarationsStarted = true;
    if (item.type === "ExportDefaultDeclaration") {
      const dd = item.declaration;
      if (dd.type !== "FunctionDeclaration" || !dd.id || !/^[A-Z]/.test(dd.id.name))
        return fail(
          item,
          "export default: only a named uppercase component function is a module's default export (the app's entry, MO-1c)",
        );
      if (defaultComponent) return fail(item, "A module has one default component");
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
    else if (d?.type === "VariableDeclaration")
      constants.push({ node: d, exported });
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
    contextReads: s.contextReads,
    action: s.action,
    returnShape: s.returnShape,
    effect: s.effect,
    serverCall: s.serverCall,
  });
  const serverQuestion = (expression: unknown, scope: Scope): boolean => {
    if (!expression || typeof expression !== "object") return false;
    if (Array.isArray(expression))
      return expression.some((item) => serverQuestion(item, scope));
    const e = expression as Expr;
    if (e.k === "id" && scope.bindings.get(e.name)?.serverQuestion) return true;
    if (
      e.k === "call" &&
      e.f.k === "id" &&
      scope.bindings.get(e.f.name)?.server?.kind === "fn"
    )
      return true;
    return Object.values(expression).some((item) =>
      serverQuestion(item, scope),
    );
  };
  const failureClasses = (node: Node, scope: Scope): string[] | undefined => {
    if (node.type === "Identifier" && node.name === "undefined") return;
    if (node.type !== "ArrayExpression")
      return fail(
        node,
        "Failure classes require a literal array of declared constructors or undefined",
      );
    const classes = node.elements.map((item) => {
      if (
        item?.type !== "Identifier" ||
        (!(item.name === "Error" && !scope.names.has("Error")) &&
          !scope.bindings.get(item.name)?.failure)
      )
        return fail(
          item ?? node,
          "Failure classes must name declared failure constructors or the built-in Error",
        );
      return scope.bindings.get(item.name)?.name ?? item.name;
    });
    return node.elements.some(
      (item) =>
        item?.type === "Identifier" &&
        item.name === "Error" &&
        !scope.names.has("Error"),
    )
      ? undefined
      : classes;
  };
  const failureShape = (classes: string[] | undefined, scope: Scope): Shape => {
    if (!classes)
      return {
        kind: "scalar",
        fields: new Map([
          ["name", { kind: "scalar" }],
          ["message", { kind: "scalar" }],
        ]),
      };
    const shapes = classes.map(
      (name) =>
        [...scope.bindings.entries()].find(
          ([local, b]) => (b.name ?? local) === name && b.failure,
        )?.[1].failure!.result,
    );
    const fields = new Map(shapes?.[0]?.fields ?? []);
    for (const shape of shapes?.slice(1) ?? [])
      for (const [key, type] of fields) {
        const other = shape?.fields?.get(key);
        if (!other || !matches(type, other) || !matches(other, type))
          fields.delete(key);
      }
    return { kind: "record", fields };
  };
  const value = (n: Node, scope: Scope, expected?: Shape): Value => {
    if (n.type === "YieldExpression") {
      if (
        !scope.action ||
        n.delegate ||
        !n.argument ||
        n.argument.type !== "CallExpression" ||
        n.argument.callee.type !== "Identifier" ||
        !(
          jsFunctions.has(n.argument.callee.name) ||
          scope.bindings.get(n.argument.callee.name)?.server
        )
      )
        return fail(
          n,
          "Actions currently support only non-delegating yields of imported JS calls",
        );
      const inner = copy(scope);
      inner.serverCall = n.argument;
      const v = value(n.argument, inner, expected);
      return { e: { k: "await", e: v.e }, shape: v.shape };
    }
    if (n.type === "ParenthesizedExpression") {
      const inner = copy(scope);
      if (scope.serverCall === n) inner.serverCall = n.expression;
      return value(n.expression, inner, expected);
    }
    if (n.type === "AwaitExpression") {
      const inner = copy(scope);
      inner.serverCall = n.argument;
      const v = value(n.argument, inner, expected);
      return { e: { k: "await", e: v.e }, shape: v.shape };
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
        capturesProjection: b.derivedStore || b.capturesProjection,
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
        capturesProjection: l.capturesProjection || r.capturesProjection,
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
        capturesProjection: t.capturesProjection || f.capturesProjection,
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
            capturesProjection: v.capturesProjection,
          };
        }
        return value(i, scope);
      });
      return {
        e: { k: "arr", items: items.map((v) => v.e) },
        capturesProjection: items.some((v) => v.capturesProjection),
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
      let capturesProjection = false;
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
        capturesProjection ||= !!v.capturesProjection;
        fields.set(p.key.name, v.shape);
        items.push({ key: p.key.name, v: v.e });
      }
      return {
        e: { k: "rec", fields: items },
        shape: { kind: "record", fields },
        capturesProjection,
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
          capturesProjection:
            o.capturesProjection &&
            !(o.e.k === "id" && scope.bindings.get(o.e.name)?.derivedStore),
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
          capturesProjection:
            o.capturesProjection &&
            !(o.e.k === "id" && scope.bindings.get(o.e.name)?.derivedStore),
        };
      }
      return fail(n, "Computed record access is unsupported");
    }
    if (n.type === "ChainExpression") return value(n.expression, scope);
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
          capturesProjection:
            array.capturesProjection &&
            !(
              array.e.k === "id" &&
              scope.bindings.get(array.e.name)?.derivedStore
            ),
        });
        const body = fn.body;
        let predicate: Value;
        const compared =
          body.type === "BinaryExpression" &&
          ["===", "!=="].includes(body.operator) &&
          body.left.type === "Identifier" &&
          body.left.name === item &&
          body.right.type === "Identifier"
            ? scope.bindings.get(body.right.name)
            : undefined;
        if (
          body.type === "BinaryExpression" &&
          compared?.kind === "store" &&
          !compared.derivedStore &&
          !scalar(array.shape.item!) &&
          matches(compared.shape, array.shape.item!)
        ) {
          predicate = {
            e: {
              k: "bin",
              op: body.operator === "===" ? "==" : "!=",
              l: { k: "id", name: item },
              r: value(body.right, scope).e,
            },
            shape: { kind: "boolean" },
          };
        } else predicate = value(body, inner);
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
          capturesProjection:
            method === "map"
              ? !scalar(predicate.shape) && predicate.capturesProjection
              : method === "filter" && array.capturesProjection,
        };
      }
      if (n.callee.type === "Identifier") {
        const name = n.callee.name;
        const b = scope.bindings.get(name);
        if (b?.server) {
          if (scope.serverCall !== n)
            return fail(
              n,
              "Server results require await, yield, or a directly returned memo call; a Promise is not a scalar value",
            );
          if (n.arguments.length !== b.server.params.length)
            return fail(
              n,
              "Server call arguments must match the declared parameters",
            );
          const args = n.arguments.map((arg, i) =>
            value(arg, scope, b.server!.params[i]),
          );
          if (args.some((arg, i) => !matches(arg.shape, b.server!.params[i])))
            return fail(
              n,
              "Server argument does not match its declared value type",
            );
          return {
            e: {
              k: "call",
              f: { k: "id", name },
              args: args.map((arg) => arg.e),
            },
            shape: b.server.unknownResult
              ? (expected ?? b.server.result)
              : b.server.result,
          };
        }
        if (b?.failure) {
          if (n.arguments.length !== b.failure.params.length)
            return fail(
              n,
              "Failure constructor arguments must match the declared fields",
            );
          const args = n.arguments.map((arg, i) =>
            value(arg, scope, b.failure!.shapes[i]),
          );
          if (args.some((arg, i) => !matches(arg.shape, b.failure!.shapes[i])))
            return fail(
              n,
              "Failure constructor argument does not match its field type",
            );
          return {
            e: {
              k: "call",
              f: { k: "id", name: b.name ?? name },
              args: args.map((arg) => arg.e),
            },
            shape: b.failure.result,
          };
        }
        if (b?.kind === "accessor" && !n.arguments.length)
          return {
            e: b.e ?? { k: "id", name: b.name ?? name },
            shape: b.shape,
            capturesProjection: b.capturesProjection,
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
        const primitive = primitives.get(name);
        if (primitive === "raiseFailure" && n.arguments.length === 1) {
          const error = value(n.arguments[0], scope);
          return {
            e: { k: "throw", e: error.e },
            shape: expected ?? { kind: "scalar" },
          };
        }
        if (primitive === "catchFailure" && n.arguments.length === 3) {
          const compute = arrow(n.arguments[0]);
          const classes = failureClasses(n.arguments[1], scope);
          const fallback = arrow(n.arguments[2], 1);
          const inner = copy(scope);
          const error = bind(fallback.params[0], inner.names);
          inner.bindings.set(error, {
            kind: "value",
            shape: failureShape(classes, scope),
          });
          const result = value(compute.body, scope, expected);
          const alt = value(
            fallback.body,
            inner,
            expected ?? (result.e.k === "throw" ? undefined : result.shape),
          );
          return {
            e: {
              k: "catch",
              e: result.e,
              name: error,
              classes,
              alt: alt.e,
            },
            shape:
              result.e.k === "throw"
                ? alt.shape
                : merge(result.shape, alt.shape),
          };
        }
        if (
          primitive === "useContext" &&
          n.arguments.length === 1 &&
          n.arguments[0].type === "Identifier"
        ) {
          if (scope.contextReads === false)
            return fail(
              n,
              "Context reads inside pure helpers require dynamic caller ownership and are unsupported",
            );
          const context = n.arguments[0].name,
            shape = contexts.get(context);
          if (sourceContexts.has(context))
            return fail(
              n,
              "Source contexts must be read with useSourceContext, not useContext",
            );
          if (!shape)
            return fail(
              n.arguments[0],
              "useContext requires a known module context",
            );
          return { e: { k: "use", name: context }, shape };
        }
        if (
          ["untrack", "latest", "isPending"].includes(primitive ?? "") &&
          n.arguments.length === 1
        ) {
          const fn = arrow(n.arguments[0]);
          const v = value(fn.body, scope);
          const readsStore = (x: unknown): boolean =>
            Array.isArray(x)
              ? x.some(readsStore)
              : !!x &&
                typeof x === "object" &&
                (((x as { k?: string }).k === "id" &&
                  scope.bindings.get((x as { name: string }).name)?.kind === "store") ||
                  Object.values(x).some(readsStore));
          if (primitive === "untrack" && !scalar(v.shape) && readsStore(v.e)) {
            const path: string[] = [];
            let root: Expr = v.e;
            while (root.k === "member" && !root.opt) {
              path.unshift(root.p);
              root = root.o;
            }
            const store = root.k === "id" ? scope.bindings.get(root.name) : undefined;
            if (root.k !== "id" || store?.kind !== "store")
              return fail(
                n,
                "untrack of a structured value of a derived or computed store is unsupported: Solid returns the live store proxy, which shows answers reconciled into it in place, but the RX spelling, peek, snapshots the value at this instant; untrack a primitive field, or read the store path where it is used",
              );
            structuredCaptures.push({ store: root.name, path, at: n, derived: !!store.derivedStore });
          }
          return {
            e: {
              k:
                primitive === "untrack"
                  ? "peek"
                  : primitive === "latest"
                    ? "latest"
                    : "pending",
              e: v.e,
            },
            shape: primitive === "isPending" ? { kind: "boolean" } : v.shape,
            capturesProjection: v.capturesProjection,
          };
        }
        const f = scope.helpers.get(name);
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
        if (
          f &&
          !f.returnsAccessor &&
          !f.component &&
          f.ret &&
          f.params.length === n.arguments.length
        ) {
          const args = n.arguments.map((a) => value(a, scope));
          args.forEach((a, i) => {
            if (!matches(a.shape, f.params[i].shape))
              fail(
                n.arguments[i],
                "Helper argument does not match its explicit type",
              );
          });
          return {
            e: { k: "call", f: { k: "id", name }, args: args.map((v) => v.e) },
            shape: f.ret,
            capturesProjection: args.some((arg) => arg.capturesProjection),
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
  const tracked = (x: unknown, scope: Scope): boolean => {
    if (Array.isArray(x)) return x.some((y) => tracked(y, scope));
    if (!x || typeof x !== "object") return false;
    const o = x as { k?: string; name?: string };
    if (o.k === "peek" || o.k === "fn") return false;
    if (o.k === "id") {
      const b = scope.bindings.get(o.name!);
      return b?.kind === "accessor" || b?.kind === "store" || !!b?.props;
    }
    return Object.values(x).some((y) => tracked(y, scope));
  };
  const refers = (x: unknown): boolean =>
    Array.isArray(x)
      ? x.some(refers)
      : !!x &&
        typeof x === "object" &&
        (["id", "use", "pre"].includes((x as { k?: string }).k ?? "") ||
          Object.values(x).some(refers));
  /** Reads of earlier setup snapshots (and context lookups, which Solid does not track) inside another eager initializer
   *  are untracked, as they are in TSX. Every other read is left as written: a read Solid tracks is never peeked here. */
  const peekSnapshots = (e: Expr, scope: Scope): Expr => {
    const go = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(go);
      if (!x || typeof x !== "object") return x;
      const o = x as { k?: string; name?: string };
      if (o.k === "peek" || o.k === "fn") return x;
      if (o.k === "id" && scope.bindings.get(o.name!)?.snapshot)
        return { k: "peek", e: x };
      if (o.k === "use") return { k: "peek", e: x };
      return Object.fromEntries(
        Object.entries(x).map(([key, v]) => [key, go(v)]),
      );
    };
    return go(e) as Expr;
  };
  const constant = (
    node: Extract<Node, { type: "VariableDeclaration" }>,
    scope: Scope,
    exported = false,
  ): Decl | undefined => {
    if (node.kind !== "const" || node.declarations.length !== 1 || node.declare)
      return fail(node, "Use one const identifier binding per declaration");
    const d = node.declarations[0];
    if (!d.init || d.definite || d.id.type !== "Identifier")
      return fail(
        d,
        "Eager constants require one initialized identifier; no destructuring",
      );
    const annotated = d.id.typeAnnotation
      ? readType(d.id.typeAnnotation.typeAnnotation)
      : undefined;
    const v = value(d.init, scope, annotated);
    if (v.shape.kind === "callback" || v.shape.kind === "view")
      return fail(
        d.init,
        "Callback snapshots are unsupported; forward callbacks explicitly",
      );
    const type = annotated ?? v.shape;
    if (!matches(v.shape, type))
      return fail(d.id, "Const initializer does not match its type");
    const name = bind(d.id, scope.names, true);
    let initializer = d.init;
    while (initializer.type === "ParenthesizedExpression")
      initializer = initializer.expression;
    const root =
      initializer.type === "Identifier"
        ? scope.bindings.get(initializer.name)
        : undefined;
    if (initializer.type === "Identifier" && root?.kind === "store") {
      // Naming a store reads nothing: native keeps the same live proxy, so the alias is the store binding itself
      // (a snapshot source would freeze its current object).
      scope.bindings.set(name, {
        ...root,
        shape: type,
        name: root.name ?? initializer.name,
      });
      return;
    }
    if (v.capturesProjection && !scalar(type))
      return fail(
        d.init,
        "Structured snapshots containing projection-root proxies require live alias semantics; alias the projection root directly",
      );
    // A setup const is evaluated once, eagerly. RX's eager form is a source snapshot (E-4): `untrack(() => e)` is already
    // `peek(e)`, and reads of earlier setup snapshots are peeked. Any other read stays exactly as written, so a read Solid
    // tracks (accessor, store, props, an RX import) reaches the shared checker outside peek and is reported as
    // SNAPSHOT_INITIALIZER at this line (DV-6) — write it inside untrack. No setter is bound, so the source is never written.
    const init = peekSnapshots(v.e, scope);
    // An async value read at mount (including one imported from another module, which the block-level check below cannot
    // see) is refused by its resolved binding.
    const asyncRead = (x: unknown): boolean => {
      if (Array.isArray(x)) return x.some(asyncRead);
      if (!x || typeof x !== "object") return false;
      const o = x as { k?: string; name?: string };
      if (o.k === "fn") return false;
      if (o.k === "await") return true;
      if (o.k === "id") {
        const b = scope.bindings.get(o.name!);
        return !!(b?.serverQuestion || b?.serverMemo);
      }
      return Object.values(x).some(asyncRead);
    };
    if (asyncRead(v.e))
      return fail(
        d.init,
        "Setup const " +
          name +
          " reads an async value at mount; Solid refuses untracked async reads there (PENDING_ASYNC_UNTRACKED_READ). Read it in JSX or a memo",
      );
    const inert = inertWith(init, (n) => !!scope.bindings.get(n)?.inert);
    scope.bindings.set(name, {
      kind: "value",
      shape: type,
      snapshot: true,
      ...(inert ? { inert: true } : {}),
    });
    if (type.kind === "accessor" && !tracked(v.e, scope))
      // A function value (an accessor-typed context read, a closure) is an equation over the snapshot: it reads nothing
      // tracked and never changes. A source would hold it as a signal value, where JS cannot tell a stored function from
      // a compute or updater.
      return {
        k: "eq",
        name,
        e: init,
        line: line(node),
        ...(d.id.typeAnnotation ? { type: printType(type) } : {}),
        ...(exported ? { exported: true } : {}),
      };
    const snapshot: Decl = {
      k: "source",
      name,
      init,
      line: line(node),
      ...(d.id.typeAnnotation ? { type: printType(type) } : {}),
      ...(exported ? { exported: true } : {}),
    };
    constSpans.set(snapshot, d);
    return snapshot;
  };
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
        "Assignments are only supported on the draft parameter of createStore/createProjection",
      );
    const name = drafts.get(root.name)!,
      binding = scope.bindings.get(name);
    return {
      name: binding?.ctx ? binding.name! : name,
      path,
      ctx: !!binding?.ctx,
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
        if (
          n.declarations.length !== 1 ||
          n.declare
        )
          return fail(
            n,
            "Use one imperative local binding per declaration",
          );
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
      if (n.type === "IfStatement")
        return [
          {
            k: "sif",
            c: value(n.test, scope).e,
            t: statements(
              n.consequent.type === "BlockStatement"
                ? n.consequent.body
                : [n.consequent],
              copy(scope),
              drafts,
            ),
            f: n.alternate
              ? statements(
                  n.alternate.type === "BlockStatement"
                    ? n.alternate.body
                    : [n.alternate],
                  copy(scope),
                  drafts,
                )
              : [],
          },
        ];
      if (n.type === "ReturnStatement") {
        if (n.argument?.type === "ArrowFunctionExpression") {
          if (n.argument.async) return asyncCallback(n.argument);
          arrow(n.argument);
          if (scope.returnShape && scope.returnShape.kind !== "callback")
            return fail(
              n,
              "Returned cleanup does not match the declared result contract",
            );
          const cleanup = copy(scope);
          cleanup.effect = false;
          cleanup.returnShape = undefined;
          return [{ k: "return", e: handler(n.argument, cleanup) }];
        }
        const v = n.argument
          ? value(n.argument, scope, scope.returnShape)
          : undefined;
        if (scope.effect && v && v.shape.kind !== "undefined")
          return fail(
            n,
            "Effect apply callbacks may return only a synchronous zero-argument cleanup or undefined",
          );
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
      if (n.type === "ThrowStatement")
        return [{ k: "throw", e: value(n.argument, scope).e }];
      if (n.type === "TryStatement") {
        const inner = copy(scope);
        let catchName: string | undefined;
        let catchClasses: string[] | undefined;
        let caught = n.handler?.body.body;
        if (n.handler?.param) {
          catchName = bind(n.handler.param, inner.names);
          const guard =
            caught?.length === 1 && caught[0].type === "IfStatement"
              ? caught[0]
              : undefined;
          const test = guard?.test;
          const alternate =
            guard?.alternate?.type === "BlockStatement"
              ? guard.alternate.body
              : guard?.alternate
                ? [guard.alternate]
                : [];
          const rethrow =
            alternate.length === 1 && alternate[0].type === "ThrowStatement"
              ? alternate[0].argument
              : undefined;
          const filters = (test: Node): string[] | undefined => {
            if (test.type === "ParenthesizedExpression")
              return filters(test.expression);
            if (test.type === "LogicalExpression" && test.operator === "||") {
              const left = filters(test.left),
                right = filters(test.right);
              return left && right ? [...left, ...right] : undefined;
            }
            if (
              test.type !== "BinaryExpression" ||
              test.operator !== "instanceof" ||
              test.left.type !== "Identifier" ||
              test.left.name !== catchName
            )
              return;
            const ctor = test.right;
            if (
              ctor.type === "MemberExpression" &&
              !ctor.computed &&
              !ctor.optional &&
              ctor.object.type === "Identifier" &&
              ctor.property.type === "Identifier" &&
              ctor.property.name === "cls"
            ) {
              const binding = scope.bindings.get(ctor.object.name);
              if (binding?.failure) return [binding.name ?? ctor.object.name];
            }
          };
          if (
            test &&
            rethrow?.type === "Identifier" &&
            rethrow.name === catchName
          )
            catchClasses = filters(test);
          if (catchClasses) {
            caught =
              guard!.consequent.type === "BlockStatement"
                ? guard!.consequent.body
                : [guard!.consequent];
          }
          inner.bindings.set(catchName, {
            kind: "value",
            // Untyped JS failures may be primitives; these fields can be undefined, not guaranteed strings.
            shape: catchClasses
              ? failureShape(catchClasses, scope)
              : {
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
                  ...(catchClasses ? { catchClasses } : {}),
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
      let shape: Shape | undefined = t.ctx
        ? contexts.get(t.name)
        : scope.bindings.get(t.name)?.shape;
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
        inner.effect = false;
        inner.returnShape = undefined;
        return [{ k: "action", body: statements(fn.body!.body, inner) }];
      }
      if (
        n.callee.type === "Identifier" &&
        ["refresh", "extensionRefresh", "affects"].includes(
          primitives.get(n.callee.name) ?? "",
        )
      ) {
        if (n.arguments.length !== 1 || n.arguments[0].type !== "Identifier")
          return fail(
            n,
            "Invalidation calls currently require one original accessor or store binding, without property paths",
          );
        const name = n.arguments[0].name,
          binding = scope.bindings.get(name);
        if (!binding || !["accessor", "store"].includes(binding.kind))
          return fail(
            n.arguments[0],
            "Invalidation targets must be known original reactive bindings, not read values or wrappers",
          );
        if (binding.ctx)
          return fail(
            n.arguments[0],
            "Invalidation through a context reader requires source-capability targeting and is unsupported",
          );
        if (
          binding.kind === "store" &&
          !binding.storeQuestion &&
          !binding.derivedStore
        )
          return fail(
            n.arguments[0],
            "Store invalidation requires an original function-form createStore standing question, not a static store",
          );
        if (
          primitives.get(n.callee.name) === "refresh" &&
          binding.serverQuestion
        )
          return fail(
            n,
            "Solid refresh cannot invalidate a serverFunction factory cache; use createServerMemo and refresh from reactivescript-ref/tsx",
          );
        if (
          primitives.get(n.callee.name) === "extensionRefresh" &&
          binding.serverQuestion &&
          !binding.serverMemo
        )
          return fail(
            n,
            "Server cache refresh requires an original createServerMemo getter; ordinary or imported async memo cache ownership is not established",
          );
        return [
          {
            k:
              primitives.get(n.callee.name) === "affects"
                ? "affects"
                : "refresh",
            name: binding.name ?? name,
          },
        ];
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
          if (fn.body.type !== "BlockStatement") {
            if (b.storeQuestion)
              return fail(
                n,
                "Root updates of a function-form createStore are unsupported: ReactiveScript lowers a structured standing question with path writes only; update fields in a draft block",
              );
            if (param)
              inner.bindings.set(param, { kind: "value", shape: b.shape });
            const v = value(fn.body, inner, b.shape);
            if (!matches(v.shape, b.shape))
              return fail(
                fn.body,
                "Store updater must preserve its supported root shape",
              );
            if (v.capturesProjection)
              return fail(
                fn.body,
                "Store root updaters containing projection proxies require unsupported live identity semantics",
              );
            return [
              {
                k: "write",
                target: {
                  name: b.ctx ? b.name! : name,
                  path: [],
                  ctx: !!b.ctx,
                },
                e: { k: "fn", params: param ? [param] : [], body: v.e },
              },
            ];
          }
          if (!param)
            return fail(
              fn,
              "Store draft blocks require one explicit draft parameter",
            );
          inner.bindings.set(param, {
            kind: "value",
            name,
            shape: b.shape,
            ...(b.ctx ? { e: b.e } : {}),
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
          if (b.optimistic && v.capturesProjection && !scalar(v.shape))
            return fail(
              fn.body,
              "Optimistic roots containing projection proxies require unsupported live identity semantics",
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
          if (b.optimistic && v.capturesProjection && !scalar(v.shape))
            return fail(
              argument,
              "Optimistic roots containing projection proxies require unsupported live identity semantics",
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
            target: { name: b.name ?? name, path: [], ctx: b.ctx ?? false },
            e,
          },
        ];
      }
      if (n.callee.type === "Identifier") {
        const binding = scope.bindings.get(n.callee.name);
        const params =
          binding?.actionParams ??
          (binding?.server?.kind === "action"
            ? binding.server.params
            : undefined);
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
      n.type !== "ArrowFunctionExpression" ||
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
    inner.action = false;
    inner.effect = false;
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
    const stmts =
      fn.body.type === "BlockStatement"
        ? statements(fn.body.body, inner)
        : actionExpr(fn.body, inner);
    // Inferred actions (pinned upstream AC-1b): a plain Solid callback is never an action, but upstream infers one
    // from the lowered body. Ordinary async callbacks are refused above (issue #20); this guard still refuses any
    // lowered body whose writes upstream would hold (AC-1c) while Solid applies them at once. Other inferred actions
    // (refresh/affects) are left to the shared checker and are covered by the differential suites.
    const inferred = actionInference(stmts);
    if (inferred.held.length)
      return fail(
        fn,
        "Solid applies " + inferred.held.join(", ") + " immediately, before the await, but ReactiveScript infers this callback as an action (AC-1b: " + inferred.why + ") and holds that write until the body ends (AC-1c); write after the await, or wrap the callback in action(...) to hold it deliberately",
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
    if (contexts.has(tag)) {
      const payload = attrs.get("value"),
        shape = contexts.get(tag)!;
      if (!payload || attrs.size !== 1)
        return fail(
          opening,
          "Context providers require only a value attribute",
        );
      if (sourceContexts.has(tag)) {
        const tuple = payload.node;
        if (
          tuple.type !== "ArrayExpression" ||
          tuple.elements.length !== 2 ||
          tuple.elements[0]?.type !== "Identifier" ||
          tuple.elements[1]?.type !== "Identifier"
        )
          return fail(
            payload.at,
            "Source context providers require the canonical [read, set] tuple",
          );
        const [read, write] = tuple.elements;
        const binding = scope.bindings.get(read.name);
        if (
          scope.setters.get(write.name) !== read.name ||
          binding?.kind !== (scalar(shape) ? "accessor" : "store") ||
          binding.optimistic ||
          binding.ctx ||
          !matches(binding.shape, shape)
        )
          return fail(
            payload.at,
            "Source context read and setter must refer to the same source with a compatible authoritative value",
          );
        if (!owner.decls)
          return fail(
            n,
            "Source context providers require an owned component region",
          );
        const name = "Tsx" + fresh();
        owner.decls.push({
          k: "component",
          name,
          props: fresh(),
          decls: [
            {
              k: "provide",
              name: tag,
              e: binding.e ?? { k: "id", name: binding.name ?? read.name },
              line: line(n),
            },
          ],
          view: n.children.flatMap((c) => markup(c, scope, owner)),
          line: line(n),
        });
        return [{ k: "el", tag: name, attrs: [], children: [], line: line(n) }];
      }
      const v = value(payload.node, scope, shape);
      if (!matches(v.shape, shape))
        return fail(
          payload.at,
          "Context provider value must match its primitive context shape",
        );
      const name = "Tsx" + fresh(),
        props = fresh(),
        seed = fresh();
      if (!owner.decls)
        return fail(n, "Context providers require an owned component region");
      owner.decls.push({
        k: "component",
        name,
        props,
        propsType: "{ value: " + printType(shape) + " }",
        decls: [
          // The provider snapshots props.value once at setup (E-4), as the native provider does. An accessor-typed value
          // is a function, captured by an equation over `peek` (a source cannot hold a function as a value).
          shape.kind === "accessor"
            ? {
                k: "eq",
                name: seed,
                e: {
                  k: "peek",
                  e: { k: "member", o: { k: "id", name: props }, p: "value" },
                },
                line: line(n),
              }
            : {
                k: "source",
                name: seed,
                init: {
                  k: "peek",
                  e: { k: "member", o: { k: "id", name: props }, p: "value" },
                },
                line: line(n),
              },
          {
            k: "provide",
            name: tag,
            e: { k: "id", name: seed },
            line: line(n),
          },
        ],
        view: n.children.flatMap((c) => markup(c, scope, owner)),
        line: line(n),
      });
      return [
        {
          k: "el",
          tag: name,
          attrs: [{ name: "value", e: v.e }],
          children: [],
          line: line(n),
        },
      ];
    }
    if (
      primitive === "Loading" ||
      primitive === "Errored" ||
      primitive === "FailureBoundary"
    ) {
      if (
        [...attrs.keys()].some(
          (k) =>
            k !== "fallback" &&
            !(primitive === "FailureBoundary" && k === "classes") &&
            !(primitive === "Loading" && k === "on"),
        )
      )
        return fail(opening, "Boundaries currently support only fallback");
      const classes =
        primitive === "FailureBoundary" && attrs.has("classes")
          ? failureClasses(attrs.get("classes")!.node, scope)
          : undefined;
      const fallback = attrs.get("fallback");
      const inner = copy(scope);
      let fallbackNode = fallback?.node;
      let errName: string | undefined;
      if (
        primitive !== "Loading" &&
        fallbackNode?.type === "ArrowFunctionExpression"
      ) {
        const fn = arrow(fallbackNode, 1);
        errName = bind(fn.params[0], inner.names);
        // Solid passes an error accessor. Its unknown payload is intentionally not renderable.
        inner.bindings.set(errName, {
          kind: "accessor",
          shape: failureShape(classes, scope),
        });
        fallbackNode = fn.body;
      } else if (
        primitive === "FailureBoundary" ||
        (primitive === "Errored" && !fallbackNode)
      )
        return fail(opening, "Errored requires fallback");
      const body = n.children.flatMap((c) => markup(c, scope, owner));
      const renderedFallback = fallbackNode
        ? markup(fallbackNode, inner, owner)
        : [];
      return primitive === "Loading"
        ? [
            {
              k: "loading",
              ...(attrs.has("on")
                ? { on: value(attrs.get("on")!.node, scope).e }
                : {}),
              fallback: renderedFallback,
              decls: [],
              body,
              line: line(n),
            },
          ]
        : [
            {
              k: "errored",
              fallback: renderedFallback,
              decls: [],
              body,
              ...(errName ? { errName } : {}),
              ...(classes ? { classes } : {}),
              line: line(n),
            },
          ];
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
  const helper = (name: string, meta: Fn, outer: Scope): Decl => {
    const fn = meta.fn!,
      scope = copy(outer),
      decls: Decl[] = [];
    scope.contextReads = false;
    for (const p of meta.params) {
      if (scope.names.has(p.name))
        return fail(
          fn,
          "Helper parameters cannot shadow outer bindings or each other",
        );
      scope.names.add(p.name);
      scope.bindings.set(p.name, {
        kind: p.ref ? "accessor" : "value",
        shape: p.shape,
      });
    }
    const nodes = fn.body!.body,
      ret = nodes.at(-1);
    if (!ret || ret.type !== "ReturnStatement" || !ret.argument)
      return fail(fn, "Pure helpers must end with a return expression");
    // A pure RX fn is one expression (E-9): a local can only be substituted into the tail. That is sound only when
    // evaluating its initializer at each use (or not at all, in an untaken branch) is unobservable, so a local must be
    // inert (literals, parameters, earlier locals, inert module consts, and operators over them). Any other initializer
    // — a call, member access, record/array, reactive read — is refused; capture and unused locals are refused below.
    const locals: { name: string; at: Node; e: Expr }[] = [];
    const mark = (name: string) => "\u0000local:" + name;
    const helperParams = new Set(meta.params.map((p) => p.name));
    if (meta.returnsAccessor) decls.push(...setup(nodes.slice(0, -1), scope));
    else
      for (const node of nodes.slice(0, -1)) {
        if (
          node.type !== "VariableDeclaration" ||
          node.kind !== "const" ||
          node.declarations.length !== 1 ||
          node.declare
        )
          return fail(
            node,
            "Pure helper setup supports one const identifier binding per declaration only",
          );
        const d = node.declarations[0];
        if (!d.init || d.definite || d.id.type !== "Identifier")
          return fail(
            d,
            "Pure helper locals require one initialized identifier; no destructuring",
          );
        let initializer = d.init;
        while (initializer.type === "ParenthesizedExpression")
          initializer = initializer.expression;
        const root =
          initializer.type === "Identifier"
            ? scope.bindings.get(initializer.name)
            : undefined;
        const annotated = d.id.typeAnnotation
          ? readType(d.id.typeAnnotation.typeAnnotation)
          : undefined;
        const v = value(d.init, scope, annotated);
        if (v.shape.kind === "callback" || v.shape.kind === "view")
          return fail(
            d.init,
            "Callback snapshots are unsupported; forward callbacks explicitly",
          );
        const type = annotated ?? v.shape;
        if (!matches(v.shape, type))
          return fail(d.id, "Const initializer does not match its type");
        if (
          !(initializer.type === "Identifier" && root?.kind === "store") &&
          !inertWith(
            v.e,
            (n) =>
              helperParams.has(n) ||
              !!scope.bindings.get(n)?.inert ||
              locals.some((l) => mark(l.name) === n),
          )
        )
          return fail(
            d.init,
            "Pure helper local " +
              d.id.name +
              " cannot be lowered: an RX fn body is one expression, so a local is substituted at its uses, which is only sound for inert initializers (literals, parameters, earlier locals, inert module consts, and operators over them). This initializer could fail, suspend, allocate or read reactive state; write it in the return expression or compute it in the caller",
          );
        const local = bind(d.id, scope.names, true);
        if (initializer.type === "Identifier" && root?.kind === "store") {
          // Naming a store reads nothing: native keeps the same live proxy, so alias the store binding itself.
          scope.bindings.set(local, {
            ...root,
            shape: type,
            name: root.name ?? initializer.name,
          });
          continue;
        }
        scope.bindings.set(local, {
          kind: "value",
          shape: type,
          e: { k: "id", name: mark(local) },
          ...(v.capturesProjection ? { capturesProjection: true } : {}),
        });
        locals.push({ name: local, at: d, e: v.e });
      }
    const returned =
      ret.argument.type === "Identifier"
        ? scope.bindings.get(ret.argument.name)
        : undefined;
    if (meta.returnsAccessor && returned?.kind !== "accessor")
      return fail(
        ret,
        "Setup helpers must return an original accessor binding, not its current value",
      );
    const v: Value =
      meta.returnsAccessor && returned
        ? {
            e: returned.e ?? {
              k: "id",
              name:
                returned.name ??
                (ret.argument as Extract<Node, { type: "Identifier" }>).name,
            },
            shape: returned.shape,
          }
        : value(ret.argument, scope, meta.ret);
    if (!matches(v.shape, meta.ret!))
      return fail(
        ret.argument,
        "Helper return does not match its explicit type",
      );
    const used = new Set<string>();
    const names = (x: unknown, out = new Set<string>()): Set<string> => {
      if (Array.isArray(x)) x.forEach((y) => names(y, out));
      else if (x && typeof x === "object") {
        const o = x as { k?: string; name?: unknown };
        const local =
          o.k === "id" && typeof o.name === "string"
            ? locals.find((l) => mark(l.name) === o.name)
            : undefined;
        if (local) names(local.e, out);
        else {
          if ((o.k === "id" || o.k === "pre") && typeof o.name === "string")
            out.add(o.name);
          Object.values(x).forEach((y) => names(y, out));
        }
      }
      return out;
    };
    const binders = (x: unknown, out = new Set<string>()): Set<string> => {
      if (Array.isArray(x)) x.forEach((y) => binders(y, out));
      else if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        if (o.k === "fn") (o.params as string[]).forEach((p) => out.add(p));
        if ((o.k === "catch" || o.k === "let") && typeof o.name === "string")
          out.add(o.name);
        if (o.k === "try" && typeof o.catchName === "string")
          out.add(o.catchName);
        if (o.k === "draft") out.add("d");
        Object.values(o).forEach((y) => binders(y, out));
      }
      return out;
    };
    const substitute = (x: Expr): Expr => {
      const go = (y: unknown, bound: Set<string>): unknown => {
        if (Array.isArray(y)) return y.map((z) => go(z, bound));
        if (!y || typeof y !== "object") return y;
        const o = y as Record<string, unknown>;
        const local =
          o.k === "id" && typeof o.name === "string"
            ? locals.find((l) => mark(l.name) === o.name)
            : undefined;
        if (local) {
          used.add(local.name);
          const captured = [...names(local.e)].find((n) => bound.has(n));
          if (captured)
            return fail(
              local.at,
              "Pure helper local " +
                local.name +
                " cannot be substituted under the inner binding " +
                captured +
                "; rename the inner binding",
            );
          return go(local.e, bound);
        }
        const inner =
          o.k === "fn" || o.k === "catch" || o.k === "draft" || o.k === "try"
            ? new Set([...bound, ...binders([y])])
            : bound;
        return Object.fromEntries(
          Object.entries(o).map(([key, z]) => [key, go(z, inner)]),
        );
      };
      const out = go(x, new Set()) as Expr;
      for (const l of [...locals].reverse())
        if (!used.has(l.name))
          return fail(
            l.at,
            "Unused pure helper local " +
              l.name +
              ": TSX evaluates it eagerly (it could throw or suspend), and a pure RX fn has only its tail; use it or remove it",
          );
      return out;
    };
    return {
      k: "fn",
      name,
      params: meta.params.map((p) => ({
        name: p.name,
        ref: p.ref ?? false,
        type: p.type,
      })),
      decls,
      tail: substitute(v.e),
      ret: printType(meta.ret!),
      line: line(fn),
      ...(meta.exported ? { exported: true } : {}),
    };
  };
  const setup = (nodes: Node[], scope: Scope, props?: string): Decl[] => {
    const decls: Decl[] = [];
    for (const node of nodes) {
      if (node.type === "FunctionDeclaration") continue;
      if (
        node.type === "ExpressionStatement" &&
        node.expression.type === "CallExpression" &&
        node.expression.callee.type === "Identifier" &&
        ["createEffect", "createRxEffect"].includes(
          primitives.get(node.expression.callee.name) ?? "",
        )
      ) {
        const call = node.expression;
        if (primitives.get(node.expression.callee.name) === "createEffect")
          return fail(
            call,
            "createEffect is not lowered: ReactiveScript has one effect form with per-input value comparison (EF-2). Use createRxEffect from reactivescript-ref/tsx",
          );
        if (call.arguments.length !== 2 || call.optional || call.typeArguments)
          return fail(
            call,
            "Effects require input computations and an apply callback, without options",
          );
        const input = call.arguments[0];
        if (
          input.type !== "ArrayExpression" ||
          input.elements.some((item) => !item || item.type === "SpreadElement")
        )
          return fail(
            input,
            "createRxEffect requires a literal array of zero-argument input callbacks",
          );
        const values = input.elements.map((input) =>
          value(arrow(input!).body, scope),
        );
        const applyNode = call.arguments[1];
        if (applyNode.type === "ArrowFunctionExpression" && applyNode.async)
          return asyncCallback(applyNode);
        const apply = arrow(applyNode, values.length);
        if (apply.body.type !== "BlockStatement")
          return fail(
            apply.body,
            "Effect apply callbacks require an explicit block returning undefined or a cleanup; setter results are not valid cleanup values",
          );
        const inner = copy(scope);
        inner.effect = true;
        apply.params.forEach((param, i) => {
          const p = bind(param, inner.names, true);
          if (
            param.type === "Identifier" &&
            param.typeAnnotation &&
            !matches(
              values[i].shape,
              readType(param.typeAnnotation.typeAnnotation),
            )
          )
            return fail(
              param,
              "Effect sample parameter does not match its input",
            );
          inner.bindings.set(p, {
            kind: "value",
            shape: values[i].shape,
            name: "$" + i,
          });
        });
        decls.push({
          k: "effect",
          inputs: values.map((v) => v.e),
          body:
            apply.body.type === "BlockStatement"
              ? statements(apply.body.body, inner)
              : actionExpr(apply.body, inner),
          line: line(node),
        });
        continue;
      }
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
      const factory =
        call?.type === "CallExpression" && call.callee.type === "Identifier"
          ? scope.helpers.get(call.callee.name)
          : undefined;
      if (
        factory?.returnsAccessor &&
        call?.type === "CallExpression" &&
        call.callee.type === "Identifier"
      ) {
        if (
          call.optional ||
          call.typeArguments ||
          call.arguments.length !== factory.params.length
        )
          return fail(
            d,
            "Setup helper calls require their declared arguments without options or type arguments",
          );
        const args = call.arguments.map((arg, i) => {
          const param = factory.params[i];
          const binding =
            arg.type === "Identifier"
              ? scope.bindings.get(arg.name)
              : undefined;
          if (param.ref) {
            if (
              arg.type !== "Identifier" ||
              binding?.kind !== "accessor" ||
              !matches(binding.shape, param.shape)
            )
              return fail(
                arg,
                "Ref helper arguments must be compatible original accessor bindings",
              );
            return (
              binding.e ?? { k: "id" as const, name: binding.name ?? arg.name }
            );
          }
          const v = value(arg, scope, param.shape);
          if (!matches(v.shape, param.shape))
            return fail(
              arg,
              "Helper argument does not match its declared type",
            );
          // Only owned helper calls snapshot value arguments; ordinary pure calls keep caller tracking.
          return { k: "peek" as const, e: v.e };
        });
        const name = bind(d.id, scope.names);
        scope.bindings.set(name, { kind: "accessor", shape: factory.ret! });
        decls.push({
          k: "eq",
          name,
          e: { k: "call", f: { k: "id", name: call.callee.name }, args },
          line: line(node),
        });
        continue;
      }
      if (
        (primitive === "serverFunction" || primitive === "serverAction") &&
        call?.type === "CallExpression"
      ) {
        const [label, fn] = call.arguments;
        if (
          d.id.type !== "Identifier" ||
          call.optional ||
          call.typeArguments ||
          call.arguments.length !== 2 ||
          label.type !== "Literal" ||
          label.value !== d.id.name ||
          fn.type !== "FunctionExpression" ||
          !fn.generator ||
          fn.async ||
          fn.typeParameters ||
          !fn.body
        )
          return fail(
            d,
            "Server helpers require a matching literal name and synchronous typed generator function",
          );
        const annotation = fn.returnType?.typeAnnotation;
        if (
          annotation?.type !== "TSTypeReference" ||
          annotation.typeName.type !== "Identifier" ||
          annotation.typeName.name !== "Generator" ||
          annotation.typeArguments?.params.length !== 3
        )
          return fail(
            fn,
            "Server generators require an explicit Generator<unknown, Result, Resume> return contract",
          );
        const result = readType(annotation.typeArguments.params[1]);
        const name = bind(d.id, scope.names);
        const inner = copy(scope);
        inner.action = true;
        inner.contextReads = false;
        inner.returnShape = result;
        const params = fn.params.map((param) => {
          if (param.type !== "Identifier" || !param.typeAnnotation)
            return fail(
              param,
              "Server parameters require explicit supported value types",
            );
          const shape = readType(param.typeAnnotation.typeAnnotation);
          const name = bind(param, inner.names, true);
          inner.bindings.set(name, { kind: "value", shape });
          return { name, shape };
        });
        if (fn.body.body.at(-1)?.type !== "ReturnStatement")
          return fail(
            fn,
            "Server generators must end with an explicit result return",
          );
        const kind = primitive === "serverFunction" ? "fn" : "action";
        scope.bindings.set(name, {
          kind: "value",
          shape: { kind: "callback" },
          server: { kind, params: params.map((param) => param.shape), result },
        });
        decls.push(
          serverDecl(
            name,
            params.map((param) => param.name),
            statements(fn.body.body, inner),
            line(node),
          ),
        );
        continue;
      }
      if (primitive === "useSourceContext" && call?.type === "CallExpression") {
        if (
          scope.contextReads === false ||
          call.optional ||
          call.typeArguments ||
          call.arguments.length !== 1 ||
          call.arguments[0].type !== "Identifier" ||
          !sourceContexts.has(call.arguments[0].name) ||
          d.id.type !== "ArrayPattern" ||
          d.id.elements.length !== 2
        )
          return fail(
            d,
            "useSourceContext requires a declared source context and [read, set] bindings in owned setup",
          );
        const context = call.arguments[0].name;
        const read = bind(d.id.elements[0] ?? d.id, scope.names),
          write = bind(d.id.elements[1] ?? d.id, scope.names);
        // Capture the reader without reading its value, but retain the required-provider contract: an equation whose
        // value is a closure is constant, so no snapshot is involved.
        decls.push({
          k: "eq",
          name: read,
          e: { k: "fn", params: [], body: { k: "use", name: context } },
          line: line(node),
        });
        scope.bindings.set(read, {
          kind: scalar(contexts.get(context)!) ? "accessor" : "store",
          shape: contexts.get(context)!,
          name: context,
          e: { k: "call", f: { k: "id", name: read }, args: [] },
          ctx: true,
        });
        scope.setters.set(write, read);
        continue;
      }
      if (primitive === "defineError" && call?.type === "CallExpression") {
        if (
          d.id.type !== "Identifier" ||
          call.optional ||
          call.typeArguments ||
          call.arguments.length !== 3
        )
          return fail(
            d,
            "defineError requires an identifier and name, fields, typed message callback",
          );
        const [label, fields, message] = call.arguments;
        if (["Error", "Panic"].includes(d.id.name))
          return fail(
            d.id,
            "Failure constructor names Error and Panic are reserved RX identities",
          );
        if (
          label.type !== "Literal" ||
          label.value !== d.id.name ||
          fields.type !== "ArrayExpression"
        )
          return fail(
            d,
            "Failure name must equal its binding name and fields must be a literal string array",
          );
        const params = fields.elements.map((field) => {
          if (
            field?.type !== "Literal" ||
            typeof field.value !== "string" ||
            !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field.value) ||
            [
              "name",
              "message",
              "stack",
              "__proto__",
              "constructor",
              "prototype",
            ].includes(field.value)
          )
            return fail(
              field ?? fields,
              "Failure fields require distinct safe identifier strings",
            );
          return field.value;
        });
        if (new Set(params).size !== params.length)
          return fail(fields, "Duplicate failure field");
        const fn = arrow(message, params.length);
        const inner = copy(scope);
        const shapes = fn.params.map((param, i) => {
          if (param.type !== "Identifier" || !param.typeAnnotation)
            return fail(
              param,
              "Failure message parameters require explicit supported types",
            );
          const shape = readType(param.typeAnnotation.typeAnnotation);
          const name = bind(param, inner.names, true);
          inner.bindings.set(name, { kind: "value", shape, name: params[i] });
          return shape;
        });
        const msg = value(fn.body, inner);
        if (msg.shape.kind !== "string")
          return fail(message, "Failure messages must return a string");
        const name = bind(d.id, scope.names);
        const result: Shape = {
          kind: "record",
          fields: new Map([
            ["name", { kind: "string" }],
            ["message", { kind: "string" }],
            ...params.map((param, i): [string, Shape] => [param, shapes[i]]),
          ]),
        };
        scope.bindings.set(name, {
          kind: "value",
          shape: { kind: "callback" },
          failure: { params, shapes, result },
        });
        decls.push({ k: "error", name, params, msg: msg.e, line: line(node) });
        continue;
      }
      if (
        ![
          "createSignal",
          "createOptimistic",
          "createMemo",
          "createServerMemo",
          "createPrevious",
          "createDeferred",
          "createStore",
          "createProjection",
          "action",
        ].includes(primitive ?? "")
      ) {
        const lowered = constant(node, scope);
        if (lowered) decls.push(lowered);
        continue;
      }
      if (
        !call ||
        call.type !== "CallExpression" ||
        call.optional ||
        (call.arguments.length !== (primitive === "createProjection" ? 2 : 1) &&
          !(
            ["createMemo", "createServerMemo", "createPrevious"].includes(
              primitive ?? "",
            ) && call.arguments.length === 2
          ) &&
          !(primitive === "createProjection" && call.arguments.length === 3)) ||
        (call.typeArguments &&
          !(
            primitive === "createStore" &&
            call.typeArguments.params.length === 1
          )) ||
        d.definite
      )
        return fail(
          d,
          "Reactive primitives take one argument, without options/type arguments",
        );
      if (primitive === "createPrevious") {
        const input = call.arguments[0];
        const binding =
          input.type === "Identifier"
            ? scope.bindings.get(input.name)
            : undefined;
        if (
          input.type !== "Identifier" ||
          !binding?.previousTarget ||
          binding.kind !== "accessor" ||
          binding.name ||
          binding.e ||
          (d.id.type === "Identifier" && input.name === d.id.name)
        )
          return fail(
            input,
            "createPrevious requires an original known local source or memo accessor; self-cycles, store roots, imported getters, values, and arbitrary callbacks are unsupported",
          );
        // Module setup is lowered one declaration at a time.
        if (
          !(scope === moduleScope ? result.decls : decls).some(
            (d) => (d.k === "source" || d.k === "eq") && d.name === input.name,
          )
        )
          return fail(
            input,
            "createPrevious requires an earlier source or memo in the same owned setup; inherited targets cannot recover earlier history",
          );
        const fallback = call.arguments[1];
        const init = fallback
          ? value(arrow(fallback).body, scope, binding.shape)
          : undefined;
        if (init && !matches(init.shape, binding.shape))
          return fail(
            fallback,
            "createPrevious fallback must match the input value shape",
          );
        const name = bind(d.id, scope.names);
        scope.bindings.set(name, {
          kind: "accessor",
          shape: init
            ? binding.shape
            : merge(binding.shape, { kind: "undefined" }),
          previousTarget: true,
          capturesProjection:
            binding.capturesProjection || init?.capturesProjection,
        });
        decls.push({
          k: "eq",
          name,
          e: { k: "pre", name: input.name, ...(init ? { init: init.e } : {}) },
          line: line(node),
        });
        continue;
      }
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
      } else if (primitive === "createProjection") {
        if (call.arguments.length === 3) {
          const fn = arrow(call.arguments[0]);
          const seed = call.arguments[1],
            options = call.arguments[2];
          if (
            seed.type !== "ArrayExpression" ||
            seed.elements.length ||
            options.type !== "ObjectExpression" ||
            options.properties.length !== 1
          )
            return fail(
              d,
              "Keyed projections require an empty array seed and one literal key option",
            );
          const option = options.properties[0];
          if (
            option.type !== "Property" ||
            option.computed ||
            option.method ||
            option.kind !== "init" ||
            option.key.type !== "Identifier" ||
            option.key.name !== "key" ||
            option.value.type !== "Literal" ||
            typeof option.value.value !== "string"
          )
            return fail(
              options,
              "Keyed projections require {key: fieldNameLiteral}",
            );
          const v = value(fn.body, scope);
          const key = option.value.value;
          const field = v.shape.item?.fields?.get(key);
          if (
            v.shape.kind !== "array" ||
            !field ||
            !["number", "string"].includes(field.kind) ||
            field.maybe
          )
            return fail(
              fn.body,
              "Keyed projections require record rows with a known number/string key field",
            );
          const name = bind(d.id, scope.names);
          scope.bindings.set(name, {
            kind: "store",
            shape: v.shape,
            derivedStore: true,
          });
          decls.push({ k: "eq", name, e: v.e, key, line: line(node) });
          continue;
        }
        const fn = arrow(call.arguments[0], 1);
        if (fn.body.type !== "BlockStatement")
          return fail(
            fn.body,
            "Projections require a synchronous draft-assignment block and explicit seed",
          );
        if (scope.names.has("d"))
          return fail(
            fn,
            "Projection drafts reserve the existing RX draft binding d",
          );
        const seed = value(call.arguments[1], scope);
        if (!["record", "array"].includes(seed.shape.kind))
          return fail(
            call.arguments[1],
            "Projection seeds need a supported record or array shape",
          );
        const name = bind(d.id, scope.names),
          seedName = fresh();
        // Solid reads the seed once, untracked, at setup: an RX snapshot source (E-4).
        decls.push({
          k: "source",
          name: seedName,
          init:
            seed.e.k === "peek" || !refers(seed.e)
              ? seed.e
              : { k: "peek", e: seed.e },
          line: line(node),
        });
        const inner = copy(scope),
          param = bind(fn.params[0], inner.names);
        inner.bindings.set(param, {
          kind: "value",
          name: "d",
          shape: seed.shape,
        });
        inner.bindings.set("d", { kind: "value", shape: seed.shape });
        const drafts = new Map([[param, "d"]]);
        if (
          fn.body.body.some(
            (node) =>
              node.type !== "ExpressionStatement" ||
              node.expression.type !== "AssignmentExpression",
          )
        )
          return fail(
            fn.body,
            "Projection bodies currently support straight-line assignments only",
          );
        const body = statements(fn.body.body, inner, drafts);
        decls.push({
          k: "eq",
          name,
          e: {
            k: "draft",
            seed: { k: "pre", name, init: { k: "id", name: seedName } },
            body,
          },
          line: line(node),
        });
        scope.bindings.set(name, {
          kind: "store",
          shape: seed.shape,
          derivedStore: true,
        });
      } else if (
        primitive === "createMemo" ||
        primitive === "createDeferred" ||
        primitive === "createServerMemo"
      ) {
        const memo = call.arguments[0];
        if (
          memo.type !== "ArrowFunctionExpression" ||
          memo.params.length > 1 ||
          (primitive === "createDeferred" && memo.params.length) ||
          memo.typeParameters
        )
          return fail(
            memo,
            "Memos require at most one previous-value parameter and no type parameters",
          );
        let body =
          memo.body.type === "BlockStatement" &&
          memo.body.body.length === 1 &&
          memo.body.body[0].type === "ReturnStatement"
            ? memo.body.body[0].argument
            : memo.body;
        if (!body) return fail(memo.body, "Memo must return a value");
        while (body.type === "ParenthesizedExpression") body = body.expression;
        if (memo.async && body.type !== "AwaitExpression")
          return fail(
            memo,
            "Async memos currently require a single returned await expression",
          );
        if (!memo.async && body.type === "AwaitExpression")
          return fail(body, "await requires an async memo");
        let expected: Shape | undefined;
        let stream = false;
        let implicitAsync =
          body.type === "CallExpression" &&
          body.callee.type === "Identifier" &&
          !!scope.bindings.get(body.callee.name)?.server;
        if (memo.returnType) {
          const annotation = memo.returnType.typeAnnotation;
          if (
            memo.async ||
            (annotation.type === "TSTypeReference" &&
              annotation.typeName.type === "Identifier" &&
              annotation.typeName.name === "Promise")
          ) {
            if (
              annotation.type !== "TSTypeReference" ||
              annotation.typeName.type !== "Identifier" ||
              annotation.typeName.name !== "Promise" ||
              annotation.typeArguments?.params.length !== 1
            )
              return fail(
                annotation,
                "Async memo result annotations must be Promise<T>",
              );
            expected = readType(annotation.typeArguments.params[0]);
            implicitAsync = !memo.async;
          } else if (
            annotation.type === "TSTypeReference" &&
            annotation.typeName.type === "Identifier" &&
            annotation.typeName.name === "AsyncIterable" &&
            annotation.typeArguments?.params.length === 1
          ) {
            expected = readType(annotation.typeArguments.params[0]);
            stream = true;
          } else expected = readType(annotation);
        }
        const name = bind(d.id, scope.names);
        const inner = copy(scope);
        if (implicitAsync) inner.serverCall = body;
        if (memo.params.length) {
          if (memo.async || stream || implicitAsync)
            return fail(
              memo,
              "Previous-value async memos require additional lifetime semantics and are unsupported",
            );
          const p = memo.params[0];
          if (p.type !== "Identifier" || (!p.typeAnnotation && !expected))
            return fail(
              p,
              "Previous-value parameters need a primitive parameter or memo return annotation",
            );
          const shape = p.typeAnnotation
            ? readType(p.typeAnnotation.typeAnnotation)
            : expected!;
          if (!scalar(shape))
            return fail(
              p,
              "Previous-value parameters currently support primitive values only",
            );
          const previous = bind(p, inner.names, true);
          inner.bindings.set(previous, {
            kind: "value",
            shape,
            e: { k: "pre", name },
          });
        }
        const v = value(body, inner, expected);
        if (expected && !matches(v.shape, expected))
          return fail(body, "Memo result does not match its annotation");
        const request = v.e.k === "await" ? v.e.e : v.e;
        scope.bindings.set(name, {
          kind: "accessor",
          shape: v.shape,
          capturesProjection: v.capturesProjection,
          previousTarget: true,
          serverQuestion: serverQuestion(v.e, scope),
          serverMemo:
            primitive === "createServerMemo" &&
            request.k === "call" &&
            request.f.k === "id" &&
            scope.bindings.get(request.f.name)?.server?.kind === "fn",
        });
        let expression: Expr =
          stream || implicitAsync
            ? {
                k: "await",
                e: v.e,
                ...(stream ? { stream: true as const } : {}),
              }
            : v.e;
        if (call.arguments.length === 2) {
          const options = call.arguments[1];
          if (
            options.type !== "ObjectExpression" ||
            options.properties.length !== 1
          )
            return fail(
              d,
              "Memo options currently support only an explicit loadingValue literal",
            );
          const option = options.properties[0];
          if (
            option.type !== "Property" ||
            option.computed ||
            option.method ||
            option.kind !== "init" ||
            option.key.type !== "Identifier" ||
            option.key.name !== "loadingValue" ||
            expression.k !== "await"
          )
            return fail(
              d,
              "Memo options currently support only loadingValue on an async or stream memo",
            );
          const seed = value(option.value, scope);
          if (
            !matches(seed.shape, v.shape) ||
            !(seed.e.k === "lit" || (seed.e.k === "un" && seed.e.e.k === "lit"))
          )
            return fail(
              option.value,
              "Memo loadingValue currently requires a matching primitive literal, optionally signed",
            );
          expression = { ...expression, init: seed.e };
        }
        decls.push({
          k: "eq",
          name,
          e: expression,
          ...(primitive === "createDeferred" ? { deferred: true } : {}),
          line: line(node),
        });
      } else {
        if (
          d.id.type !== "ArrayPattern" ||
          d.id.elements.length !== 2 ||
          !d.id.elements[0] ||
          !d.id.elements[1] ||
          d.id.typeAnnotation ||
          d.id.optional
        )
          return fail(
            d.id,
            "Signals/stores require exactly [read, write] bindings",
          );
        const initializer = call.arguments[0];
        const seedType =
          primitive === "createStore" && call.typeArguments
            ? readType(call.typeArguments.params[0])
            : undefined;
        const question =
          ["createSignal", "createOptimistic", "createStore"].includes(
            primitive ?? "",
          ) && initializer.type === "ArrowFunctionExpression";
        let body: Node = initializer;
        let resultType = seedType;
        if (question && primitive === "createStore") {
          if (initializer.params.length || initializer.typeParameters)
            return fail(
              initializer,
              "Function-form stores require zero-argument computations without type parameters",
            );
          body = initializer.body;
          if (
            body.type === "BlockStatement" &&
            body.body.length === 1 &&
            body.body[0].type === "ReturnStatement" &&
            body.body[0].argument
          )
            body = body.body[0].argument;
          while (body.type === "ParenthesizedExpression")
            body = body.expression;
          if (
            body.type === "BlockStatement" ||
            (initializer.async && body.type !== "AwaitExpression") ||
            (!initializer.async && hasLexicalAwait(body)) ||
            (body.type === "AwaitExpression" && hasLexicalAwait(body.argument))
          )
            return fail(
              initializer,
              "Function-form stores require a single returned value or async tail await",
            );
          const annotation = initializer.returnType?.typeAnnotation;
          if (initializer.async) {
            if (
              annotation?.type !== "TSTypeReference" ||
              annotation.typeName.type !== "Identifier" ||
              annotation.typeName.name !== "Promise" ||
              annotation.typeArguments?.params.length !== 1
            )
              return fail(
                initializer,
                "Async function-form stores require an explicit Promise<T> result annotation",
              );
            resultType = readType(annotation.typeArguments.params[0]);
          } else if (annotation) resultType = readType(annotation);
          if (!resultType || !["record", "array"].includes(resultType.kind))
            return fail(
              initializer,
              "Function-form stores require an explicit supported record or array result contract",
            );
        } else if (question) body = arrow(initializer).body;
        const v = value(body, scope, resultType);
        if (
          question &&
          primitive === "createStore" &&
          resultType &&
          !matches(v.shape, resultType)
        )
          return fail(
            initializer,
            "Store computation does not match its explicit value contract",
          );
        if (seedType && !matches(v.shape, seedType))
          return fail(
            initializer,
            "Store seed does not match its explicit value contract",
          );
        if (primitive === "createSignal" && !scalar(v.shape))
          return fail(
            call.arguments[0],
            "Structured createSignal identity cannot be represented by RX's auto-store sources; use createStore",
          );
        if (
          primitive === "createOptimistic" &&
          !scalar(v.shape) &&
          !["record", "array"].includes(v.shape.kind)
        )
          return fail(
            initializer,
            "Optimistic roots require supported primitive, record, or array values",
          );
        if (
          primitive === "createOptimistic" &&
          v.capturesProjection &&
          !scalar(v.shape)
        )
          return fail(
            initializer,
            "Optimistic roots containing projection proxies require unsupported live identity semantics",
          );
        if (
          primitive === "createStore" &&
          !["record", "array"].includes(v.shape.kind)
        )
          return fail(
            call.arguments[0],
            "createStore requires a known object/array seed",
          );
        const read = bind(d.id.elements[0], scope.names),
          write = bind(d.id.elements[1], scope.names);
        scope.bindings.set(read, {
          kind: primitive === "createStore" ? "store" : "accessor",
          shape: seedType ?? v.shape,
          previousTarget: primitive !== "createStore",
          ...(question && primitive === "createStore"
            ? {
                storeQuestion: true,
                serverQuestion: serverQuestion(v.e, scope),
              }
            : {}),
          ...(primitive === "createOptimistic" ? { optimistic: true } : {}),
        });
        scope.setters.set(write, read);
        const reactive = (e: unknown): boolean => {
          if (!e || typeof e !== "object") return false;
          if ("k" in e && e.k === "lit") return false;
          if (
            "k" in e &&
            e.k === "id" &&
            "name" in e &&
            typeof e.name === "string"
          )
            return (
              e.name === props ||
              ["accessor", "store"].includes(
                scope.bindings.get(e.name)?.kind ?? "",
              )
            );
          return Object.values(e).some((x) =>
            Array.isArray(x) ? x.some(reactive) : reactive(x),
          );
        };
        decls.push({
          k: "source",
          name: read,
          init:
            !question && (primitive === "createOptimistic" || reactive(v.e))
              ? { k: "peek", e: v.e }
              : question
                ? v.e
                : peekSnapshots(v.e, scope),
          ...(question || primitive === "createOptimistic"
            ? { question: true }
            : {}),
          // ST-1: structure is the type. A function-form store's type text is an object/array type, which the emitter
          // lowers as a structured question even before (or without) a path write.
          ...(question && primitive === "createStore"
            ? { type: printType(resultType ?? seedType ?? v.shape) }
            : {}),
          line: line(node),
        });
      }
    }
    return decls;
  };
  for (const d of constants) {
    const declarator = d.node.declarations[0],
      call = declarator?.init;
    if (
      call?.type === "CallExpression" &&
      call.callee.type === "Identifier" &&
      primitives.get(call.callee.name) === "createSourceContext"
    ) {
      if (
        d.node.kind !== "const" ||
        d.node.declarations.length !== 1 ||
        call.optional ||
        call.arguments.length ||
        call.typeArguments?.params.length !== 1
      )
        return fail(
          d.node,
          "Source contexts require createSourceContext<T>() with one supported value contract",
        );
      const shape = readType(call.typeArguments.params[0]);
      const supported = (s: Shape): boolean =>
        scalar(s) ||
        (s.kind === "record" && [...s.fields!.values()].every(supported)) ||
        (s.kind === "array" && supported(s.item!));
      if (!supported(shape))
        return fail(
          call,
          "Source contexts require primitive, record, or array value contracts without callbacks",
        );
      const name = bind(declarator.id, moduleNames);
      contexts.set(name, shape);
      sourceContexts.add(name);
      result.decls.push({
        k: "context",
        name,
        type: printType(shape),
        source: true,
        line: line(d.node),
        ...(d.exported ? { exported: true } : {}),
      });
      continue;
    }
    if (
      call?.type === "CallExpression" &&
      call.callee.type === "Identifier" &&
      primitives.get(call.callee.name) === "createContext"
    ) {
      if (
        d.node.kind !== "const" ||
        d.node.declarations.length !== 1 ||
        call.optional ||
        (call.typeArguments && call.typeArguments.params.length !== 1) ||
        call.arguments.length > 1 ||
        (!call.arguments.length && !call.typeArguments)
      )
        return fail(
          d.node,
          "Contexts require a primitive literal/default accessor or an explicit primitive type without a default",
        );
      const contract = call.typeArguments
        ? readType(call.typeArguments.params[0])
        : undefined;
      let initial: Value;
      const argument = call.arguments[0];
      if (!argument) {
        if (
          !contract ||
          !(
            scalar(contract) ||
            (contract.kind === "accessor" && scalar(contract.item!))
          )
        )
          return fail(
            call,
            "Default-less contexts currently require a primitive or primitive accessor contract",
          );
        initial = { e: { k: "lit", v: undefined }, shape: contract };
      } else if (argument.type === "ArrowFunctionExpression") {
        const fn = arrow(argument);
        const v = value(fn.body, moduleScope);
        if (v.e.k !== "lit" || !scalar(v.shape))
          return fail(
            fn.body,
            "Context default accessors currently require a primitive literal body",
          );
        initial = {
          e: { k: "fn", params: [], body: v.e },
          shape: { kind: "accessor", item: v.shape },
        };
      } else initial = value(argument, moduleScope);
      if (
        !["lit", "fn"].includes(initial.e.k) ||
        !["number", "string", "boolean", "null", "scalar", "accessor"].includes(
          initial.shape.kind,
        ) ||
        (argument && contract && !matches(initial.shape, contract))
      )
        return fail(
          argument ?? call,
          "Context defaults currently require a non-undefined primitive literal",
        );
      const name = bind(declarator.id, moduleNames);
      const shape = argument ? (contract ?? initial.shape) : initial.shape;
      contexts.set(name, shape);
      result.decls.push({
        k: "context",
        name,
        type: printType(shape),
        source: false,
        ...(argument ? { dflt: initial.e } : {}),
        line: line(d.node),
        ...(d.exported ? { exported: true } : {}),
      });
    } else {
      const ids =
        declarator.id.type === "ArrayPattern"
          ? declarator.id.elements
          : [declarator.id];
      const names = new Set(
        ids.flatMap((id) => (id?.type === "Identifier" ? [id.name] : [])),
      );
      result.decls.push(
        ...setup([d.node], moduleScope).map((decl) => {
          if (!d.exported || !("name" in decl) || !names.has(decl.name))
            return decl;
          const binding = moduleScope.bindings.get(decl.name);
          const exportedDecl: Decl = {
            ...decl,
            exported: true,
            ...(binding && ["source", "eq"].includes(decl.k)
              ? { type: printType(binding.shape) }
              : {}),
          } as Decl;
          const span = constSpans.get(decl);
          if (span) constSpans.set(exportedDecl, span);   // the setup-const fact follows the Decl, not its spelling
          return exportedDecl;
        }),
      );
      if (d.exported && declarator.id.type === "ArrayPattern") {
        const [read, write] = declarator.id.elements;
        if (
          read?.type === "Identifier" &&
          write?.type === "Identifier" &&
          moduleScope.setters.get(write.name) === read.name
        ) {
          const binding = moduleScope.bindings.get(read.name)!;
          const param = fresh();
          result.decls.push({
            k: "action",
            name: write.name,
            params: [param],
            body: [
              {
                k: binding.optimistic ? "optimistic" : "write",
                target: { name: read.name, path: [], ctx: false },
                e: { k: "id", name: param },
              },
            ],
            line: line(d.node),
            exported: true,
          });
        }
      }
    }
  }
  for (const [name, meta] of functions) {
    if (!meta.fn) continue;
    if (!meta.component) {
      result.decls.push(helper(name, meta, moduleScope));
      continue;
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
    for (const node of nodes.slice(0, -1))
      if (node.type === "FunctionDeclaration") {
        // An async declaration is a callback, refused as one before the nested-component check (issue #20).
        if (node.async) return asyncCallback(node);
        if (!node.id || /^[A-Z]/.test(node.id.name))
          return fail(
            node,
            "Nested component declarations are unsupported; use module components",
          );
        collectFunction(node, false, scope.names, scope.helpers);
      }
    decls.push(...setup(nodes.slice(0, -1), scope, meta.props));
    for (const node of nodes.slice(0, -1))
      if (node.type === "FunctionDeclaration" && node.id)
        decls.push(
          helper(node.id.name, scope.helpers.get(node.id.name)!, scope),
        );
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
  immutableExports.set(
    result,
    new Set(
      result.decls.flatMap((d) =>
        (d.k === "eq" || d.k === "source") &&
        d.exported &&
        !!moduleScope.bindings.get(d.name)?.snapshot
          ? [d.name]
          : [],
      ),
    ),
  );
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
          constSpans.get(d) ?? { start: offset, end: offset },
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
  // Eager setup consts that RX could not observe the way Solid does. Solid evaluates them at mount: an untracked async
  // read is an error there (PENDING_ASYNC_UNTRACKED_READ), and a failing initializer throws to the boundary above the
  // component even if nothing reads it. An RX snapshot source holds a pending value or failure and surfaces it only at its
  // readers, so these are refused rather than lowered with different timing.
  const bodiesByName = new Map<string, unknown[]>();
  const collect = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(collect);
    if (!x || typeof x !== "object") return;
    const d = x as Decl;
    if (d.k === "eq") bodiesByName.set(d.name, [...(bodiesByName.get(d.name) ?? []), d.e]);
    if (d.k === "fn") bodiesByName.set(d.name, [...(bodiesByName.get(d.name) ?? []), d.tail]);
    if (d.k === "source" && d.question) bodiesByName.set(d.name, [...(bodiesByName.get(d.name) ?? []), d.init]);
    Object.values(x).forEach(collect);
  };
  collect(result.decls);
  const awaits = (x: unknown, seen = new Set<string>()): boolean => {
    if (Array.isArray(x)) return x.some((y) => awaits(y, seen));
    if (!x || typeof x !== "object") return false;
    const o = x as { k?: string; name?: unknown };
    if (o.k === "await") return true;
    if (o.k === "fn") return false;
    if (o.k === "id" && typeof o.name === "string") {
      if (seen.has(o.name) || !bodiesByName.has(o.name)) return false;
      seen.add(o.name);
      return awaits(bodiesByName.get(o.name), seen);
    }
    return Object.values(x).some((y) => awaits(y, seen));
  };
  const inert = (x: unknown): boolean => {
    if (Array.isArray(x)) return x.every(inert);
    if (!x || typeof x !== "object") return true;
    const { k, name } = x as { k?: string; name?: string };
    if (k === "id") return !bodiesByName.has(name!);   // an equation or question could fail when read
    if (k && !["lit", "peek", "arr", "rec", "tpl", "bin", "un", "if", "spread", "fn"].includes(k)) return false;
    return k === "fn" || Object.values(x).every(inert);
  };
  const mentions = (x: unknown, name: string, self: unknown): boolean => {
    if (x === self) return false;
    if (Array.isArray(x)) return x.some((y) => mentions(y, name, self));
    if (!x || typeof x !== "object") return false;
    const o = x as { k?: string; name?: unknown; target?: { name: string } };
    if ((o.k === "id" || o.k === "pre") && o.name === name) return true;
    if (o.target?.name === name) return true;
    return Object.values(x).some((y) => mentions(y, name, self));
  };
  const snapshot = (owner: unknown, d: Decl): void => {
    if (d.k === "source" && !d.question && constSpans.has(d)) {
      const at = constSpans.get(d)!;
      if (awaits(d.init))
        fail(
          at,
          "Setup const " +
            d.name +
            " reads an async value at mount; Solid refuses untracked async reads there (PENDING_ASYNC_UNTRACKED_READ). Read it in JSX or a memo",
        );
      if (!d.exported && !inert(d.init) && !mentions(owner, d.name, d))
        fail(
          at,
          "Unused setup const " +
            d.name +
            ": TSX evaluates it eagerly at mount (it could throw), but an RX snapshot that nothing reads is never observed; use it or remove it",
        );
    }
  };
  const blocks = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(blocks);
    if (!x || typeof x !== "object") return;
    for (const v of Object.values(x))
      if (Array.isArray(v) && v.some((y) => y && typeof y === "object" && (y as Decl).k === "source"))
        v.forEach((y) => {
          const d = y as Decl;
          if (d && d.k === "source") snapshot(x, d);
        });
    Object.values(x).forEach(blocks);
  };
  blocks(result);
  // Eager initializers (setup consts; signal, store, projection and provider seeds) run at their declaration in Solid, so a
  // failure throws during setup, to the boundary above the owner, before any boundary inside it exists. An RX
  // `source x := e` holds the failure and raises it at its readers (R-f-2): perhaps inside an inner boundary, in an untaken
  // branch or in a closure, so the AST cannot carry Solid's routing. Such initializers are refused unless a catch inside
  // the initializer discharges every failure: only a catch-all (`catch` without classes) counts, since a selective catch
  // cannot be proved to cover what it guards without class inference. "Could fail" is decided conservatively from this
  // module's lowered
  // declarations, resolved lexically (never by spelling across owners): an explicit throw; a call of a helper whose tail
  // could fail, of a JS import not declared to reject nothing, of a server function, action or callback value; a read of
  // an equation or question whose expression could fail; a read of a non-snapshot import; and a props field unless every
  // application site in this module passes a value that cannot fail (an exported component's callers are unknown).
  type FEnv = { vars: Map<string, FEntry>; parent?: FEnv };
  type FEntry =
    | { k: "decl"; d: Decl; env: FEnv; imported?: string }
    | { k: "value" }
    | { k: "props"; c: Extract<Decl, { k: "component" }> };
  type Fails = { f: boolean; why?: string };
  const noFails = (): Fails => ({ f: false });
  const anyFails = (why: string): Fails => ({ f: true, why });
  const join = (a: Fails, b: Fails): Fails => (a.f ? a : b.f ? b : a);
  const failing = (r: Fails) => r.f;
  const lookupF = (env: FEnv | undefined, n: string): FEntry | undefined => {
    for (let e = env; e; e = e.parent) {
      const x = e.vars.get(n);
      if (x) return x;
    }
  };
  const scopeOf = (decls: Decl[], parent: FEnv | undefined, extra: [string, FEntry][] = []): FEnv => {
    const env: FEnv = { vars: new Map(extra), parent };
    for (const d of decls)
      if (d.k === "import") for (const { name, alias } of d.names) env.vars.set(alias, { k: "decl", d, env, imported: name });
      else if (d.k !== "provide" && "name" in d && typeof d.name === "string") env.vars.set(d.name, { k: "decl", d, env });
    return env;
  };
  const sites = new Map<Decl, { attrs: { name: string; e: Expr }[]; env: FEnv }[]>();
  const eager: { d: Extract<Decl, { k: "source" }>; env: FEnv }[] = [];
  const walkDecls = (decls: Decl[], env: FEnv): void => {
    for (const d of decls) {
      if (d.k === "source" && !d.question) eager.push({ d, env });
      if (d.k === "component") {
        const inner = scopeOf(d.decls, env, [[d.props, { k: "props", c: d }]]);
        walkDecls(d.decls, inner);
        walkView(d.view, inner);
      }
      if (d.k === "fn") {
        const inner = scopeOf(d.decls, env, d.params.map((p): [string, FEntry] => [p.name, { k: "value" }]));
        walkDecls(d.decls, inner);
      }
    }
  };
  const walkView = (view: Markup[], env: FEnv): void => {
    for (const m of view) {
      if (m.k === "el") {
        const target = lookupF(env, m.tag);
        if (target?.k === "decl" && target.d.k === "component")
          sites.set(target.d, [...(sites.get(target.d) ?? []), { attrs: m.attrs, env }]);
        walkView(m.children, env);
      } else if (m.k === "mif") {
        const t = scopeOf(m.tDecls, env), f = scopeOf(m.fDecls, env);
        walkDecls(m.tDecls, t); walkView(m.t, t);
        walkDecls(m.fDecls, f); walkView(m.f, f);
      } else if (m.k === "mfor") {
        const inner = scopeOf(m.decls, env, [[m.name, { k: "value" }]]);
        walkDecls(m.decls, inner); walkView(m.body, inner);
      } else if (m.k === "loading" || m.k === "errored") {
        const inner = scopeOf(m.decls, env);
        walkDecls(m.decls, inner); walkView(m.body, inner);
        walkView(m.fallback, m.k === "errored" && m.errName ? scopeOf([], env, [[m.errName, { k: "value" }]]) : env);
      }
    }
  };
  const moduleEnv = scopeOf(result.decls, undefined);
  walkDecls(result.decls, moduleEnv);
  walkView(result.view, moduleEnv);
  const memo = new Map<object, Fails>();
  const once = (key: object, compute: () => Fails): Fails => {
    const known = memo.get(key);
    if (known) return known;
    // A cycle (a recursive helper, mutually recursive definitions) is not proof of totality: its unbounded evaluation
    // would fail at the reader, so an in-progress definition counts as possibly failing.
    memo.set(key, anyFails("a recursive definition, whose totality is not proved"));
    const r = compute();
    memo.set(key, r);
    return r;
  };
  const jsRejects = (entry: Extract<FEntry, { k: "decl" }>): string[] | undefined => {
    if (entry.d.k !== "import") return;
    const from = entry.d.from, name = entry.imported;
    const js = options.declarations?.get(from)?.find((x) => x.name === name);
    return js?.kind === "fn" ? (js.rejects ?? ["Error"]) : js?.kind === "error" ? [] : undefined;
  };
  const propsFails = (c: Extract<Decl, { k: "component" }>, field?: string): Fails =>
    once(sitesKey(c, field), () => {
      if (c.exported) return anyFails("props of exported component " + c.name + ", whose callers in other modules are unknown");
      let r = noFails();
      for (const site of sites.get(c) ?? [])
        for (const attr of site.attrs)
          if (field === undefined || attr.name === field) {
            const got = fails(attr.e, site.env);
            if (failing(got)) return { f: got.f, why: "props." + attr.name + " of <" + c.name + ">, passed " + (got.why ?? "a value that could fail") };
            r = join(r, got);
          }
      return r;
    });
  // Props facts belong to the component declaration itself, never to its spelling or line.
  const siteKeys = new WeakMap<Decl, Map<string, object>>();
  const sitesKey = (c: Decl, field?: string) => {
    let byField = siteKeys.get(c);
    if (!byField) siteKeys.set(c, (byField = new Map()));
    const k = field === undefined ? "*" : "." + field;
    if (!byField.has(k)) byField.set(k, {});
    return byField.get(k)!;
  };
  const declFails = (entry: Extract<FEntry, { k: "decl" }>, name: string): Fails => {
    const d = entry.d;
    if (d.k === "eq") return once(d, () => fails(d.e, entry.env));
    if (d.k === "source" && d.question) return once(d, () => fails(d.init, entry.env));
    if (d.k === "import") {
      const dep = options.modules?.get(d.from);
      if (dep && immutableExports.get(dep.program)?.has(entry.imported!)) return noFails();
      if (jsRejects(entry)?.length === 0) return noFails();
      return anyFails("a read of imported " + name);
    }
    // Other eager sources are checked themselves; functions, classes, contexts and components are values.
    return noFails();
  };
  const fails = (x: unknown, env: FEnv): Fails => {
    if (Array.isArray(x)) return x.reduce((r: Fails, y) => join(r, fails(y, env)), noFails());
    if (!x || typeof x !== "object") return noFails();
    const o = x as Expr;
    switch (o.k) {
      case "fn":
      case "lit":
        return noFails();
      case "throw":
        return anyFails("an explicit throw");
      case "catch": {
        const inner = fails(o.e, env);
        const alt = fails(o.alt, o.name ? scopeOf([], env, [[o.name, { k: "value" }]]) : env);
        return o.classes ? join(inner, alt) : alt;   // only a catch-all discharges
      }
      case "id": {
        if (o.name === "undefined") return noFails();
        const entry = lookupF(env, o.name);
        if (!entry) return anyFails("a read of " + o.name);
        if (entry.k === "value") return noFails();
        if (entry.k === "props") return propsFails(entry.c);
        return declFails(entry, o.name);
      }
      case "member": {
        if (o.o.k === "id") {
          const entry = lookupF(env, o.o.name);
          if (entry?.k === "props") return propsFails(entry.c, o.p);
        }
        const base = fails(o.o, env);
        return o.o.k === "index" && !o.opt ? join(base, anyFails("a member of a possibly missing element")) : base;
      }
      case "call": {
        const args = fails(o.args, env);
        if (o.f.k !== "id") return join(args, anyFails("a call of a computed function"));
        const entry = lookupF(env, o.f.name);
        const name = o.f.name;
        if (!entry && arrayBuiltins.has(name))
          // An array builtin runs its callbacks now: their bodies count, with their parameters as plain values.
          return o.args.reduce(
            (r: Fails, a) =>
              join(r, a.k === "fn" ? fails(a.stmts ?? a.body, scopeOf([], env, a.params.map((n): [string, FEntry] => [n, { k: "value" }]))) : noFails()),
            args,
          );
        if (entry?.k === "decl") {
          const d = entry.d;
          if (d.k === "error")
            // Constructing a failure evaluates its message, with the constructor's parameters as plain values.
            return join(
              args,
              d.msg ? once(d, () => fails(d.msg, scopeOf([], entry.env, d.params.map((n): [string, FEntry] => [n, { k: "value" }])))) : noFails(),
            );
          if (d.k === "fn")
            return join(args, once(d, () => fails(d.tail, scopeOf(d.decls, entry.env, d.params.map((p): [string, FEntry] => [p.name, { k: "value" }])))));
          if (d.k === "import") {
            const rejects = jsRejects(entry);
            if (rejects?.length === 0) return args;
            return join(args, anyFails("a call of " + name + ", which can reject"));
          }
        }
        return join(args, anyFails("a call of " + name));
      }
      case "use": {
        const entry = lookupF(env, o.name);
        return entry?.k === "decl" && entry.d.k === "context" && entry.d.dflt ? fails(entry.d.dflt, entry.env) : noFails();
      }
      case "await":
        return anyFails("an await");
      default:
        return Object.values(o).reduce((r: Fails, y) => join(r, typeof y === "object" ? fails(y, env) : noFails()), noFails());
    }
  };
  // A bare reactive read (outside peek) is the shared checker's SNAPSHOT_INITIALIZER; this gate does not pre-empt it.
  const bareReactive = (x: unknown, env: FEnv): boolean => {
    if (Array.isArray(x)) return x.some((y) => bareReactive(y, env));
    if (!x || typeof x !== "object") return false;
    const o = x as { k?: string; name?: string };
    if (o.k === "peek" || o.k === "fn") return false;
    if (o.k === "id" && o.name) {
      const entry = lookupF(env, o.name);
      if (entry?.k === "props") return true;
      if (entry?.k !== "decl") return false;
      if (entry.d.k === "eq" || entry.d.k === "source") return true;
      return entry.d.k === "import" && jsRejects(entry) === undefined;
    }
    return Object.values(x).some((y) => bareReactive(y, env));
  };
  for (const { d, env } of eager) {
    if (bareReactive(d.init, env)) continue;
    const r = fails(d.init, env);
    if (!failing(r)) continue;
    const offset = source.split("\n").slice(0, d.line - 1).reduce((n, l) => n + l.length + 1, 0);
    const at = constSpans.get(d) ?? { start: offset, end: offset };
    fail(
      at,
      (constSpans.has(d) ? "Setup const " + d.name : "The eager initializer of " + d.name + " (a signal, store, projection or provider seed)") +
        " can fail at mount (" + (r.why ?? "a failure") + "): Solid throws during setup, before any boundary inside this owner exists, but an RX snapshot source holds the failure and raises it at its readers (possibly inside an inner boundary, an untaken branch or a closure). Catch every failure in the initializer with catchFailure, or read it in JSX or a memo",
    );
  }
  for (const capture of structuredCaptures) {
    let inside = false;
    let projection = false;
    const walk = (x: unknown, draft?: string): void => {
      if (inside || !x || typeof x !== "object") return;
      if (Array.isArray(x)) return x.forEach((y) => walk(y, draft));
      const o = x as { k?: string; name?: string; e?: { k?: string; body?: unknown; seed?: unknown }; target?: { name: string; path: unknown[] } };
      if (o.k === "eq" && o.name === capture.store && o.e?.k === "draft") {
        projection = true;
        walk(o.e.seed, draft);
        return walk(o.e.body, "d");
      }
      const t = o.target;
      if (t && (t.name === capture.store || (draft && t.name === draft)) && t.path.length > capture.path.length &&
          capture.path.every((p, i) => t.path[i] === p)) {
        inside = true;
        return;
      }
      for (const y of Object.values(x)) walk(y, draft);
    };
    walk(result.decls);
    // A derived store other than a projection reconciles each new answer into the existing objects (in place); a
    // projection's recomputation is its draft statements, which the scan above already checked.
    if (capture.derived && !projection)
      return fail(
        capture.at,
        "untrack of a structured value of a derived or computed store is unsupported: Solid returns the live store proxy, which shows answers reconciled into it in place, but the RX spelling, peek, snapshots the value at this instant; untrack a primitive field, or read the store path where it is used",
      );
    if (inside)
      return fail(
        capture.at,
        "untrack of a structured store value that is later written inside is unsupported: the write updates the captured object in place, which Solid's live proxy shows, but the RX spelling, peek, snapshots the value at this instant; untrack a primitive field, or read the store path where it is used",
      );
  }
  if (defaultComponent) {
    const entry = result.decls.find((d) => d.k === "component" && d.name === defaultComponent);
    if (!entry)
      return fail(parsed.program, "export default " + defaultComponent + " must be a component (a function returning JSX)");
    result.view = entryView(defaultComponent, entry.line);
  }
  return result;
}
