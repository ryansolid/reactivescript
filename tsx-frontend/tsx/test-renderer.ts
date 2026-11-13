// The pinned Solid compiler passes static props to createElement. The shared reference
// string renderer currently ignores that argument; bridge it only in this test harness.
export * from "./rx/string-renderer.ts";
import { createElement as base, setProp } from "./rx/string-renderer.ts";
export function createElement(tag: string, props: Record<string, unknown> = {}) {
  const node = base(tag);
  for (const [name, value] of Object.entries(props)) setProp(node, name, value);
  return node;
}
