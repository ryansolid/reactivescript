import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { lowerTsx } from "./lower.ts";
import { parseProgram } from "./rx/compiler.ts";
import { check } from "./rx/compiler.ts";
import { Runtime } from "./rx/runtime.ts";
import { compile } from "./rx/compiler.ts";
import { lowerViews, STRING_RENDERER } from "./rx/compiler.ts";
import { createApp, flush } from "./rx/runtime.ts";
import type { Decl, Expr, Program } from "./rx/ast.ts";
import { entryView } from "./rx/ast.ts";
import { singleModule } from "./rx/compiler.ts";
import { semanticFacts } from "./rx/facts.ts";

const refers = (x: unknown): boolean =>
  Array.isArray(x)
    ? x.some(refers)
    : !!x &&
      typeof x === "object" &&
      (["id", "use", "pre"].includes((x as { k?: string }).k ?? "") ||
        Object.values(x).some(refers));
/** The RX form of a TSX setup const: a never-written snapshot source, `source x := peek(e)` (E-4). Write the
 *  equation `x = e` in RX test text and convert it here. */
export function snapshotSource(d: Extract<Decl, { k: "eq" }>): Decl {
  const init: Expr = d.e.k === "peek" || !refers(d.e) ? d.e : { k: "peek", e: d.e };
  return { k: "source", name: d.name, init, line: d.line, ...(d.type ? { type: d.type } : {}) };
}

/** Paired equivalence is judged on the pinned checker's canonical semantic facts (tsx/rx/facts.ts), not on the raw
 *  AST shape: upstream's parser representation (for example `legacyView: false`) is not part of the contract. */
const facts = (p: Program) => semanticFacts(singleModule(p));
const mounted = (p: Program): Program => ({ ...p, view: entryView("Counter", 1) });

export async function traces(
  tsx: string,
  rx: string | Program,
  expected: string[],
  props: Record<string, unknown> = {},
) {
  const p = lowerTsx(tsx, "Counter.tsx");
  const handwritten = typeof rx === "string" ? parseProgram(rx) : rx;
  assert.deepEqual(p.view, [], "module exports must not auto-mount");
  assert.deepEqual(facts(p), facts(handwritten));
  assert.deepEqual(check(p), []);
  assert.deepEqual(check(mounted(p)), []);
  assert.deepEqual(check(mounted(handwritten)), []);
  const rt = new Runtime(mounted(p));
  const interpreted = [rt.step([]).at(-1)!.frame];
  const find = (items: any[]): any => {
    for (const item of items) {
      if (item.k === "el" && item.tag === "button") return item;
      const nested =
        item.children ??
        item.inst?.items ??
        item.committed?.inst?.items ??
        item.committedRows?.flatMap((r: any) => r.inst.items) ??
        (item.k === "loading" || item.k === "errored"
          ? (item.committedFallback ? item.fallback : item.content).items
          : []);
      const hit = find(nested);
      if (hit) return hit;
    }
  };
  for (let i = 1; i < expected.length; i++) {
    const node = find(rt.view.items)?.attrs.find(
      (a: any) => a.name === "onClick",
    )?.node;
    assert.ok(
      node,
      "interpreter must expose the actual authored button handler",
    );
    const click = node.compute(rt);
    assert.equal(typeof click, "function");
    click();
    interpreted.push(rt.handler([]).at(-1)!.frame);
  }
  const out = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(out + "tsx-");
  const renderer = fileURLToPath(
    new URL("./test-renderer.ts", import.meta.url),
  );
  try {
    const native = transform(tsx, {
      filename: "Counter.tsx",
      generate: "universal",
      moduleName: STRING_RENDERER,
    }).code;
    const modules = lowerViews(
      new Map([
        ["adapted.mjs", compile(mounted(p))],
        ["handwritten.mjs", compile(mounted(handwritten))],
      ]),
      "universal",
    );
    // The Solid compiler lowers JSX but preserves inline TS types; Node strips those in .mts.
    modules.set("native.mts", native);
    const all: string[][] = [];
    for (const [name, code] of modules) {
      const path = dir + "/" + name;
      writeFileSync(path, code.replaceAll(STRING_RENDERER, renderer));
      const mod = await import(pathToFileURL(path).href);
      const app = createApp();
      const dispose = app.mount(
        name === "native.mts" ? () => mod.Counter() : mod.default(app),
      );
      try {
        flush();
        const frames = [app.frame()];
        const button = (node: any): any =>
          node.tag === "button"
            ? node
            : node.children?.map(button).find(Boolean);
        for (const [key, value] of Object.entries(props))
          assert.equal(
            button(app.root)?.props[key],
            value,
            name + " attribute " + key,
          );
        for (let i = 1; i < expected.length; i++) {
          const el = button(app.root);
          assert.equal(
            typeof el?.props.onClick,
            "function",
            name + " must attach a click handler",
          );
          el.props.onClick();
          flush();
          frames.push(app.frame());
        }
        assert.deepEqual(frames, expected, name);
        all.push(frames);
      } finally {
        dispose();
      }
    }
    assert.deepEqual(
      all[0],
      all[2],
      "adapted TSX and original native Solid must agree",
    );
    assert.deepEqual(
      all[1],
      all[2],
      "handwritten RX and original native Solid must agree",
    );
    assert.deepEqual(interpreted, expected, "interpreter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
