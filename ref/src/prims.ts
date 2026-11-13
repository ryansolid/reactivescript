// MO-10: the scenario prelude's Solid library, `./prims` (declared by a `prims.d.rx` beside the program). Two bodies of the
// same primitives: in .rx, for the interpreter, which has no Solid to run; and in Solid, for the runners that lower onto it
// (oracle, compiled, server; `compile/prims-solid.ts`), so the accessor protocol itself is what they run.
import { parseProgram } from "./parse.ts";
import type { Decl } from "./ast.ts";
export { primsSolid } from "../compile/prims-solid.ts";

/** What the interpreter instantiates: a primitive as the .rx it means. */
export const PRIM_RX = `
fn createToggle(initial) {
  source v := initial
  action set(x) { v := x }
  [v, set]
}
fn createShout(ref s) {
  out = \`\${s}!\`
  out
}
`;
let rx: Map<string, Extract<Decl, { k: "fn" }>> | null = null;
export function primRx(name: string): Extract<Decl, { k: "fn" }> | undefined {
  rx ??= new Map(parseProgram(PRIM_RX).decls.filter((d): d is Extract<Decl, { k: "fn" }> => d.k === "fn").map(d => [d.name, d]));
  return rx.get(name);
}
export const isPrims = (from: string) => /(^|\/)prims(\.js)?$/.test(from);
