// Abstract syntax for the reference interpreter (spec/02-core.md §1).
// Operators are spelled as in JS; this is a spelling, not surface syntax.

export type Expr =
  | { k: "lit"; v: unknown }
  | { k: "id"; name: string }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "un"; op: string; e: Expr }
  | { k: "pre"; name: string; init?: Expr }
  | { k: "peek"; e: Expr }
  | { k: "await"; e: Expr; init?: Expr; stream?: boolean }     // R-1, R-7; stream: `await*` (ST-6b)
  | { k: "latest"; e: Expr }                                   // R-9 probe
  | { k: "pending"; e: Expr }                                  // R-9 probe (`pending? e`)
  | { k: "if"; c: Expr; t: Expr; f: Expr }
  | { k: "tpl"; parts: (string | Expr)[] }                      // template literal
  | { k: "member"; o: Expr; p: string; opt?: boolean }          // opt: `?.`
  | { k: "index"; o: Expr; i: Expr; opt?: boolean }
  | { k: "call"; f: Expr; args: Expr[] }
  | { k: "arr"; items: Expr[] }
  | { k: "rec"; fields: ({ key: string; v: Expr } | { spread: Expr })[] }
  | { k: "fn"; params: string[]; body: Expr; stmts?: Stmt[] }   // stmts: a statement-bodied arrow (imperative scope, 07 §5)
  | { k: "draft"; seed: Expr; body: Stmt[] }                  // ST-3: the only writes in reactive scope, to `d`
  | { k: "use"; name: string }                                 // RG-7b: the nearest provision above
  | { k: "spread"; e: Expr }                                   // only inside an array literal
  | { k: "omit"; e: Expr; keys: string[] }                      // RG-4b: an object rest, `{ a, ...rest } = e` (the parser's own; Solid's `omit`)
  | { k: "throw"; e: Expr }                                    // R-f-3: a failure; an expression in reactive scope too
  | { k: "catch"; e: Expr; name?: string; classes?: string[]; alt: Expr }
  | { k: "stylemap"; css: string; line?: number }                // 07 CSS-5: `styles = <style>…</style>` — a class map, a constant
  | { k: "serverfn"; params: string[]; ptypes?: (string | undefined)[]; ret?: string; body: Stmt[] };   // 12 SF-1d: `server fn (a) { … }`, an expression — for a wrapper (`GET(server fn …)`)   // R-f-4: `e catch (x: A | B) => alt`; classes absent: every failure

export type Target = { name: string; path: (string | Expr)[]; ctx?: boolean };   // ctx: `use name` — a provided source (RG-7, O-4)

export type Stmt =
  | { k: "write"; target: Target; e: Expr }
  | { k: "let"; name: string; e: Expr; type?: string }
  | { k: "expr"; e: Expr }
  | { k: "optimistic"; target: Target; e: Expr }                // AC-3
  | { k: "refresh"; name: string }                              // AC-4
  | { k: "affects"; name: string }                              // AC-5
  | { k: "action"; body: Stmt[] }                               // AC-1 inline
  | { k: "sif"; c: Expr; t: Stmt[]; f: Stmt[] }                 // imperative `if`
  | { k: "return"; e?: Expr }
  | { k: "try"; body: Stmt[]; catchName?: string; catchClasses?: string[]; handler?: Stmt[]; fin?: Stmt[] }   // AC-7: traditional try/catch/finally in imperative scope
  | { k: "throw"; e: Expr };

export type Param = { name: string; ref: boolean; type?: string };   // E-9; types are TS's, kept as text (07 §2)
export type Decl =
  | { k: "source"; name: string; init: Expr; line: number; question?: boolean; type?: string; exported?: boolean; key?: string }   // question: `source x = e` (ST-5)
  | { k: "eq"; name: string; e: Expr; line: number; deferred?: boolean; key?: string; type?: string; exported?: boolean }   // deferred: declared lag (V-16, D-40); key: ST-4
  | { k: "import"; names: { name: string; alias: string }[]; from: string; pure: boolean; side?: "server" | "client"; line: number; fails?: string[]; resolved?: string; declared?: string; declaredErrors?: string[]; declaredPure?: string[]; declaredSide?: Record<string, "server" | "client"> }   // R-io-4: io unless `pure`; R-f-8: `fails A | B` narrows its rejections; resolved: an `.rx` import's module key (MO-1, set by the loader); declared: a JS import's declaration file (MO-8)
  | { k: "error"; name: string; params: string[]; ptypes?: (string | undefined)[]; msg?: Expr; line: number; exported?: boolean }             // R-f-1: `error NotFound(id) => message`
  | { k: "typedecl"; name: string; line: number; text?: string; exported?: boolean }                                                           // `type T = …`: text only
  | { k: "effect"; inputs: Expr[]; body: Stmt[]; line: number }
  | { k: "fn"; name: string; params: Param[]; decls: Decl[]; tail: Expr; line: number; ret?: string; exported?: boolean }       // body: decls then a value
  | { k: "component"; name: string; props: string; decls: Decl[]; view: Markup[]; line: number; propsType?: string; exported?: boolean; isDefault?: boolean }  // body: decls then a view; isDefault: `export default component App` — the app's entry (MO-1c)
  | { k: "action"; name: string; params: string[]; ptypes?: (string | undefined)[]; body: Stmt[]; line: number; exported?: boolean }                   // AC-1
  | { k: "server"; name: string; params: string[]; ptypes?: (string | undefined)[]; ret?: string; body: Stmt[]; line: number; exported?: boolean }   // 12 SF-1: `server fn f(a) { … }` — the body runs on the server; it is io when its body is
  | { k: "provide"; name: string; e: Expr; line: number }                                        // RG-7a: `name` resolves to a context declaration
  | { k: "context"; name: string; type?: string; source: boolean; dflt?: Expr; line: number; exported?: boolean };   // RG-7: `context theme: Theme = e`; source: `context f: source T` (RG-7c)

export type Markup = (
  | { k: "el"; tag: string; attrs: { name: string; e: Expr }[]; children: Markup[] }
  | { k: "read"; e: Expr }
  | { k: "text"; s: string }
  | { k: "style"; css: string }                                                   // 07 §6b CSS-1: a scoped stylesheet, raw text
  | { k: "mif"; c: Expr; t: Markup[]; tDecls: Decl[]; f: Markup[]; fDecls: Decl[] }
  | { k: "mfor"; name: string; xs: Expr; decls: Decl[]; body: Markup[] }
  | { k: "loading"; on?: Expr; fallback: Markup[]; decls: Decl[]; body: Markup[] }    // H-5/H-6
  | { k: "errored"; fallback: Markup[]; decls: Decl[]; body: Markup[]; errName?: string; classes?: string[] }   // H-12; errName: `fallback(e)`; classes: `fallback(e: A | B)` (R-f-4), absent: every failure
  | { k: "portal"; to?: Expr; decls: Decl[]; body: Markup[] }                     // RG-8: rendered at the end of the document (or `to(e)`), owned here
) & { line?: number };                                                                   // the source line, for diagnostics

export type Program = { decls: Decl[]; view: Markup[]; legacyView?: boolean };   // a reactive block: declarations, then its view. A module's view is `<App />` for its default component (MO-1c); legacyView: markup written at the top level (refused, TOP_LEVEL_MARKUP)
