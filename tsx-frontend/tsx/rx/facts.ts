// Paired semantic facts: the pinned checker's resolved model (ref/src/model.ts, CP-6) for a checked module graph, with
// only incidental identity canonicalized. Upstream labels the model unstable and not a shared IR; this file is the one
// place that reads its shape, so a model change breaks here (and in contract tests), not across the package.
//
// Canonicalized: numeric region/symbol/computation ids (replaced by structural keys), source lines, and module file
// names (replaced by the module's position in load order). Preserved: region nesting and kinds, symbol kinds/names and
// question/io flags, every computation in checker walk order with its kind and name, and each read's mode, field and
// probe, each write's op and path flag, each call target, all in their recorded order. Diagnostics keep code and rule.
import { checkModules, type ModuleSet } from "./compiler.ts";
import type { Model } from "#rx/src/model.ts";

export type Facts = {
  diagnostics: string[];
  modules: {
    regions: string[];
    symbols: string[];
    computations: { kind: string; region: string; name?: string; at?: string; in?: string; reads: string[]; writes: string[]; calls: string[] }[];
  }[];
};

function moduleFacts(model: Model, fileKey: (file: string) => string) {
  const regionKey = new Map<number, string>();
  const siblings = new Map<string, number>();
  for (const r of model.regions) {
    const parent = r.parent === undefined ? "" : regionKey.get(r.parent) ?? "?";
    const base = parent + "/" + r.kind + (r.name !== undefined ? ":" + r.name : "");
    const n = siblings.get(base) ?? 0;
    siblings.set(base, n + 1);
    regionKey.set(r.id, base + (n ? "#" + n : ""));
  }
  const symKey = new Map<number, string>();
  for (const s of model.symbols)
    symKey.set(s.id, (regionKey.get(s.region) ?? "?") + "::" + s.kind + ":" + s.name + (s.question ? "?" : "") + (s.io ? "!io" : "") + (s.from ? " from " + fileKey(s.from) : ""));
  const compKey = new Map<number, string>();
  model.computations.forEach((c, i) => compKey.set(c.id, "#" + i + ":" + c.kind));
  const sym = (id: number) => symKey.get(id) ?? "?" + id;
  return {
    regions: model.regions.map(r => regionKey.get(r.id)!),
    symbols: model.symbols.map(s => symKey.get(s.id)!),
    computations: model.computations.map(c => ({
      kind: c.kind,
      region: regionKey.get(c.region) ?? "?",
      ...(c.name !== undefined ? { name: c.name } : {}),
      ...(c.at !== undefined ? { at: c.at } : {}),
      ...(c.in !== undefined ? { in: compKey.get(c.in) ?? "?" } : {}),
      reads: c.reads.map(r => sym(r.sym) + " " + r.mode + (r.field ? "." + r.field : "") + (r.probe ? " " + r.probe : "")),
      writes: c.writes.map(w => sym(w.sym) + " " + w.op + (w.path ? " path" : "")),
      calls: c.calls.map(sym),
    })),
  };
}

/** Checks a loaded module graph with the pinned checker and returns its canonical semantic facts. */
export function semanticFacts(set: ModuleSet): Facts {
  const checked = checkModules(set);
  const order = [...set.order];
  const fileKey = (file: string) => {
    const i = order.indexOf(file);
    return i < 0 ? file : "module#" + i;
  };
  return {
    diagnostics: checked.diags.map(d => d.code + " " + d.rule),
    modules: order.map(file => {
      const model = checked.models.get(file);
      return model ? moduleFacts(model, fileKey) : { regions: [], symbols: [], computations: [] };
    }),
  };
}
