// Syntax boundary for the tested frontend. Run before lowering so removed features cannot fall through as JS.
import type { Node, Span } from "oxc-parser/src-js/index";

type Ast = { type: string; start: number; end: number; [key: string]: any };
const ISSUE = "https://github.com/ryansolid/reactivescript/issues/20";
export const ASYNC_CALLBACK =
  "Ordinary async callbacks are refused for now (" +
  ISSUE +
  "): wrap the work in action(function* () { ... yield request(); ... }) and use yield instead of await. This opts into action semantics, which hold the action's writes until it completes; it is not a semantics-preserving rewrite of the async callback";
export const ASYNC_ACTION =
  "Actions take a synchronous generator, not an async function or async generator (" +
  ISSUE +
  "): write action(function* () { ... yield request(); ... }) and use yield instead of await";
const PRIMITIVES = new Set([
  "createSignal",
  "createStore",
  "createMemo",
  "createOptimistic",
  "action",
  "Show",
  "For",
]);
const NODES = new Set([
  "Program",
  "ImportDeclaration",
  "ImportSpecifier",
  "Identifier",
  "Literal",
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "BlockStatement",
  "VariableDeclaration",
  "VariableDeclarator",
  "ArrayPattern",
  "ArrayExpression",
  "ObjectExpression",
  "Property",
  "CallExpression",
  "MemberExpression",
  "ParenthesizedExpression",
  "BinaryExpression",
  "LogicalExpression",
  "UnaryExpression",
  "ConditionalExpression",
  "TemplateLiteral",
  "TemplateElement",
  "ExpressionStatement",
  "AssignmentExpression",
  "ReturnStatement",
  "TryStatement",
  "CatchClause",
  "YieldExpression",
  "JSXFragment",
  "JSXOpeningFragment",
  "JSXClosingFragment",
  "JSXElement",
  "JSXOpeningElement",
  "JSXClosingElement",
  "JSXIdentifier",
  "JSXAttribute",
  "JSXExpressionContainer",
  "JSXText",
  "JSXEmptyExpression",
  "TSTypeAnnotation",
  "TSTypeLiteral",
  "TSPropertySignature",
  "TSNumberKeyword",
  "TSStringKeyword",
  "TSBooleanKeyword",
  "TSVoidKeyword",
  "TSFunctionType",
  "TSArrayType",
]);

export function verifySyntax(
  program: Node,
  fail: (at: Span, message: string) => never,
): void {
  const imports = new Map<string, string>();
  const tree = program as Ast;
  for (const n of tree.body)
    if (n.type === "ImportDeclaration" && n.source.value === "solid-js")
      for (const s of n.specifiers)
        if (s.type === "ImportSpecifier")
          imports.set(s.local.name, s.imported.name);
  const primitive = (n: Ast | undefined) =>
    n?.type === "CallExpression" && n.callee.type === "Identifier"
      ? imports.get(n.callee.name)
      : undefined;
  const children = (n: Ast, visit: (n: Ast, parent: Ast) => void) => {
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child, n);
      } else if (value && typeof value === "object" && value.type)
        visit(value, n);
    }
  };
  // Give the semantic async guidance even inside a form that is otherwise outside the subset.
  const asyncs = (n: Ast, parent?: Ast): void => {
    if (n.async) {
      const p = primitive(parent);
      if (p === "action") fail(n, ASYNC_ACTION);
      if (["createMemo", "createStore"].includes(p ?? ""))
        fail(n, "outside the verified subset: async computations");
      fail(n, ASYNC_CALLBACK);
    }
    children(n, asyncs);
  };
  asyncs(tree);
  const outside = (n: Ast, construct: string): never =>
    fail(n, "outside the verified subset: " + construct);
  const seed = (n: Ast): boolean =>
    n.type === "Literal" ||
    (n.type === "UnaryExpression" && seed(n.argument)) ||
    (n.type === "ObjectExpression" &&
      n.properties.every(
        (p: Ast) =>
          p.type === "Property" && !p.computed && !p.method && seed(p.value),
      )) ||
    (n.type === "ArrayExpression" &&
      n.elements.every((e: Ast | null) => e && seed(e)));
  const setup = (fn: Ast) => {
    for (const n of fn.body.body.slice(0, -1)) {
      if (n.type === "FunctionDeclaration") outside(n, "nested function");
      if (
        n.type !== "VariableDeclaration" ||
        n.declarations.some(
          (d: Ast) =>
            ![
              "createSignal",
              "createMemo",
              "createStore",
              "createOptimistic",
              "action",
            ].includes(primitive(d.init) ?? ""),
        )
      )
        outside(n, "setup binding or statement");
    }
  };
  const walk = (n: Ast, parent?: Ast): void => {
    if (!NODES.has(n.type)) outside(n, n.type);
    if (n.type === "ImportDeclaration") {
      if (n.source.value === "solid-js") {
        for (const s of n.specifiers)
          if (!PRIMITIVES.has(s.imported?.name)) {
            if (s.imported?.name === "createEffect")
              fail(
                s,
                "createEffect is not lowered: ReactiveScript has one effect form with per-input value comparison (EF-2). Effects are outside the verified subset",
              );
            outside(s, s.imported?.name ?? "import");
          }
      } else if (
        n.source.value === "reactivescript-tsx" ||
        /\.(tsx|rx)$/.test(n.source.value)
      )
        outside(n, "frontend helper or component-module import");
    }
    if (
      n.type === "VariableDeclaration" &&
      (parent?.type === "Program" || parent?.type === "ExportNamedDeclaration")
    )
      outside(n, "module setup");
    if (n.type === "FunctionDeclaration") {
      if (!/^[A-Z]/.test(n.id?.name ?? "")) outside(n, "setup helper");
      setup(n);
    }
    if (
      n.type === "FunctionExpression" &&
      !(n.generator && primitive(parent) === "action")
    )
      outside(n, "function expression");
    if (n.type === "TryStatement" && n.finalizer)
      outside(n.finalizer, "finally");
    if (n.type === "CallExpression") {
      const p = primitive(n);
      if (
        ["createSignal", "createStore"].includes(p ?? "") &&
        (!n.arguments[0] || !seed(n.arguments[0]))
      )
        outside(n, "non-literal signal/store seed");
      if (
        p === "createMemo" &&
        (n.arguments.length !== 1 || n.arguments[0]?.params?.length !== 0)
      )
        outside(n, "memo options or previous value");
      if (
        p === "createStore" &&
        n.arguments[0]?.type !== "ObjectExpression" &&
        n.arguments[0]?.type !== "ArrayExpression"
      )
        outside(n, "derived store");
      if (
        n.callee.type === "MemberExpression" &&
        !["map", "filter", "findIndex"].includes(n.callee.property?.name) &&
        !/^on[A-Z]/.test(n.callee.property?.name ?? "")
      )
        outside(n, "method call");
    }
    children(n, walk);
  };
  walk(tree);
}
