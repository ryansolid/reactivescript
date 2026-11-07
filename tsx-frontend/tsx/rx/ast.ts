// The upstream AST types the lowering constructs. Ordinary expression/statement nodes are built inline by lower.ts;
// module entry helpers keep upstream representation changes at this boundary.
import type { Decl, Expr, Markup, Program, Stmt, Param } from "#rx/src/ast.ts";
export type { Decl, Expr, Markup, Program, Stmt, Param };

/** MO-1c: a module's mounted view is its default component, applied with no props. */
export function entryView(component: string, line: number): Markup[] {
  return [{ k: "el", tag: component, attrs: [], children: [], line }];
}

/** Selects an exported component of an entry module as the app's entry, in the same representation upstream's parser
 *  gives `export default component` (MO-1c). Refuses a module that already has an entry or no such component. */
export function selectEntry(program: Program, component: string): void {
  const target = program.decls.find(d => d.k === "component" && d.name === component && d.exported);
  if (!target || target.k !== "component") throw new Error("No exported component " + component + " in the entry module");
  const current = program.decls.find(d => d.k === "component" && d.isDefault);
  if (current && current !== target) throw new Error("The entry module already has a default component " + (current as { name: string }).name);
  if (program.view.length && !current) throw new Error("Cannot select a component in a module that already has a view");
  target.isDefault = true;
  program.view = entryView(component, target.line);
}
