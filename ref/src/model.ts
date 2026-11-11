// The resolved model (spec/11 CP-6, issue #1): what the checker resolved, as facts a lowering or another analysis consumes
// instead of recognising source spellings. Compile-time only. Not a stable format: it is the vocabulary of facts the Rust
// crate's model is diffed against (ref/crate.ts), not an IR anyone else depends on yet.
//
//   regions       the lexical regions (03): the program, each component, each branch, row, boundary and instantiating fn
//   symbols       every name a declaration binds, except constants (`let`, parameters, row bindings): sources, equations,
//                 props, fns, actions, components, imports, error classes, contexts, server fns
//   computations  where reads happen: an equation's memo, a source's question or seed, a reader of a view, a prop's
//                 argument, an effect's two halves, a handler, an action body, a server fn body, a provision
//
// A read is of a reactive symbol (a source, an equation, props, a context through `use`) and carries its mode:
//   tracked   reactive scope (SC-1): the computation depends on it
//   snapshot  imperative scope (SC-2), `peek` (E-5), a source's seed (E-4), a value parameter's argument (E-10)
//   pre       `pre x` (C-2): the previous instant's value
// and `probe: "latest" | "pending"` under `latest` / `pending?` (R-9, R-12). A write is `x := e` (W-1), `guess`
// (AC-3), `refresh` (AC-4) or `affects` (AC-5); `use p := e` writes the context's provided source (RG-7c). A call names a
// fn, an action, a server fn or a JS import called by name.

export type ReadMode = "tracked" | "snapshot" | "pre";
export type Read = { sym: number; mode: ReadMode; field?: string; probe?: "latest" | "pending" };
export type Write = { sym: number; op: "write" | "optimistic" | "refresh" | "affects"; path?: true };
export type RegionKind = "program" | "component" | "imported" | "fn" | "then" | "else" | "for" | "loading" | "portal" | "errored" | "children";
export type CompKind = "memo" | "deferred" | "keyed" | "question" | "seed" | "reader" | "prop" | "handler" | "effect" | "apply" | "action" | "server" | "fn" | "provide" | "default";
export type ModelRegion = { id: number; kind: RegionKind; parent?: number; name?: string };
export type ModelSymbol = { id: number; name: string; kind: string; region: number; line: number; question?: boolean; io?: true; from?: string };
export type Computation = { id: number; kind: CompKind; region: number; line: number; name?: string; at?: string; in?: number; reads: Read[]; writes: Write[]; calls: number[] };
export type Model = { file: string; regions: ModelRegion[]; symbols: ModelSymbol[]; computations: Computation[] };

const READ_KINDS = new Set(["source", "eq", "props", "context"]);
const CALL_KINDS = new Set(["fn", "action", "server", "import"]);
type SymLike = { kind: string; name: string; region: { id: number }; line: number; question?: boolean; io?: boolean; imported?: string };

/** Filled by the checker during its walk (check.ts): symbols as they are bound, computations as the walk enters them. */
export class ModelBuilder {
  regions: ModelRegion[] = [];
  private syms: SymLike[] = [];
  private ids = new Map<SymLike, number>();
  computations: Computation[] = [];
  private cur: Computation | null = null;
  snap = 0;                                                             // inside `peek`, a seed, an E-10 argument
  probe: "latest" | "pending" | undefined;

  region(id: number, kind: RegionKind, parent: { id: number } | null, name?: string) { this.regions.push({ id, kind, ...(parent ? { parent: parent.id } : {}), ...(name !== undefined ? { name } : {}) }); }
  sym(s: SymLike) { if (s.kind === "value" || this.ids.has(s)) return; this.ids.set(s, this.syms.length); this.syms.push(s); }
  within(kind: CompKind, region: { id: number }, line: number, info: { name?: string; at?: string }, f: () => void) {
    const c: Computation = { id: this.computations.length, kind, region: region.id, line, ...(info.name !== undefined ? { name: info.name } : {}), ...(info.at !== undefined ? { at: info.at } : {}), ...(this.cur ? { in: this.cur.id } : {}), reads: [], writes: [], calls: [] };
    this.computations.push(c);
    const save = this.cur, snap = this.snap, probe = this.probe; this.cur = c; this.snap = 0; this.probe = undefined;
    try { f(); } finally { this.cur = save; this.snap = snap; this.probe = probe; }
  }
  read(s: SymLike, imperative: boolean, pre = false, field?: string) {
    const id = this.ids.get(s); if (!this.cur || id === undefined || !READ_KINDS.has(s.kind)) return;
    const r: Read = { sym: id, mode: pre ? "pre" : imperative || this.snap > 0 ? "snapshot" : "tracked", ...(field !== undefined ? { field } : {}), ...(this.probe ? { probe: this.probe } : {}) };
    if (!this.cur.reads.some(x => x.sym === r.sym && x.mode === r.mode && x.field === r.field && x.probe === r.probe)) this.cur.reads.push(r);
  }
  write(s: SymLike | undefined, op: Write["op"], path = false) {
    const id = s && this.ids.get(s); if (!this.cur || id === undefined) return;
    if (!this.cur.writes.some(x => x.sym === id && x.op === op && !!x.path === path)) this.cur.writes.push({ sym: id, op, ...(path ? { path: true as const } : {}) });
  }
  call(s: SymLike | undefined) { const id = s && this.ids.get(s); if (!this.cur || id === undefined || !CALL_KINDS.has(s!.kind) || this.cur.calls.includes(id)) return; this.cur.calls.push(id); }
  build(file: string): Model {
    return { file, regions: this.regions,
      symbols: this.syms.map((s, id) => ({ id, name: s.name, kind: s.kind, region: s.region.id, line: s.line, ...(s.kind === "source" ? { question: !!s.question } : {}), ...(s.io ? { io: true as const } : {}), ...(s.imported ? { from: s.imported } : {}) })),
      computations: this.computations };
  }
}
