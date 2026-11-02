// R-f-11 (taken by default 2026-11-02): a failure that surfaces in another section's `errored` region. The same pass as
// compiler/src/foreign.rs, over the resolved model (model.ts), after every module is checked: a question whose equation
// awaits outside a `catch`, or calls a non-`io` import, can fail (R-6); its failure flows through equations and props (call site → `props.field`) and
// stops at an equation with a `catch` (R-f-4); a reader shows it in its nearest `errored` regions over the static
// application tree (R-f-5). Error: question F surfaces in region B, B is neither inside nor around another region where
// F surfaces, and B also shows a question G that neither depends on F nor F on it — B is another section's boundary.
import type { Model } from "./model.ts";
import type { Diagnostic } from "./errors.ts";
import type { Program } from "./ast.ts";

/** Lines of equations (and questions) whose expression has a `catch` / an `await` in it. */
export function eqLines(p: Program, kind: "catch" | "await"): Set<number> {
  const out = new Set<number>();
  const has = (x: unknown): boolean => {
    if (!x || typeof x !== "object") return false;
    if (Array.isArray(x)) return x.some(has);
    if ((x as { k?: string }).k === kind) return true;
    return Object.values(x).some(has);
  };
  const walk = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const o = x as { k?: string; e?: unknown; init?: unknown; question?: boolean; line?: number };
    if (o.k === "eq" && typeof o.line === "number" && o.e && has(o.e)) out.add(o.line);
    if (o.k === "source" && o.question && typeof o.line === "number" && o.init && has(o.init)) out.add(o.line);
    Object.values(o).forEach(walk);
  };
  walk(p);
  return out;
}

type Key = string;   // `${module} ${symbol}` or `${module} ${symbol} ${field}`
type RKey = string;  // `${module} ${region}`
type C = Model["computations"][number];

export function foreignFailures(models: Map<string, Model>, catches: Map<string, Set<number>>, awaits: Map<string, Set<number>>): Diagnostic[] {
  const files = [...models.keys()]; const ms = [...models.values()];
  const regions = new Map<RKey, Model["regions"][number]>();
  const syms = new Map<string, Model["symbols"][number]>();
  const comps: [number, C][] = [];
  ms.forEach((m, mi) => { for (const r of m.regions) regions.set(`${mi} ${r.id}`, r); for (const s of m.symbols) syms.set(`${mi} ${s.id}`, s); for (const c of m.computations) comps.push([mi, c]); });
  const compProps = new Map<string, [number, number]>();
  for (const [k, s] of syms) if (s.kind === "props") { const mi = Number(k.split(" ")[0]); const r = regions.get(`${mi} ${s.region}`); if (r) compProps.set(r.name ?? "", [mi, s.id]); }
  const rkeys = [...regions.keys()].sort((a, b) => { const [a0, a1] = a.split(" ").map(Number), [b0, b1] = b.split(" ").map(Number); return a0 - b0 || a1 - b1; });
  const callSites = new Map<string, RKey[]>();
  for (const k of rkeys) { const r = regions.get(k)!; if (r.kind === "children") { const n = r.name ?? ""; if (!callSites.has(n)) callSites.set(n, []); callSites.get(n)!.push(k); } }
  const parents = (k: RKey): RKey[] => {
    const r = regions.get(k)!; const mi = k.split(" ")[0];
    if (r.kind === "component" && callSites.has(r.name ?? "")) return callSites.get(r.name ?? "")!;
    return r.parent !== undefined ? [`${mi} ${r.parent}`] : [];
  };
  const ancestors = (k: RKey): Set<RKey> => { const out = new Set<RKey>(); const todo = [k]; while (todo.length) { const x = todo.pop()!; if (!out.has(x)) { out.add(x); todo.push(...parents(x)); } } return out; };
  const nearestErrored = (k: RKey): RKey[] => {
    const out: RKey[] = []; const seen = new Set<RKey>(); const todo = [k];
    while (todo.length) { const x = todo.pop()!; if (seen.has(x) || !regions.has(x)) continue; seen.add(x); if (regions.get(x)!.kind === "errored") { if (!out.includes(x)) out.push(x); } else todo.push(...parents(x)); }
    return out;
  };
  const keyOf = (mi: number, sid: number, field?: string) => field === undefined ? `${mi} ${sid}` : `${mi} ${sid} ${field}`;
  const defnList: [number, number, number][] = [];   // module, symbol, computation index
  comps.forEach(([mi, c], ci) => {
    if ((c.kind === "memo" || c.kind === "question") && c.name !== undefined)
      for (const s of ms[mi].symbols) if (s.name === c.name && (s.kind === "eq" || s.kind === "source") && s.line === c.line) defnList.push([mi, s.id, ci]);
  });
  defnList.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const defn = new Map<Key, number>(defnList.map(([mi, sid, ci]) => [keyOf(mi, sid), ci]));
  const tracked = (mi: number, c: C): Key[] => c.reads.filter(r => r.mode === "tracked").map(r => syms.get(`${mi} ${r.sym}`)?.kind === "props" ? keyOf(mi, r.sym, r.field) : keyOf(mi, r.sym));
  const roots = new Map<Key, Set<Key>>();
  const rootsOf = (k: Key) => { if (!roots.has(k)) roots.set(k, new Set()); return roots.get(k)!; };
  for (const [k, ci] of defn) {
    const [mi, c] = comps[ci];
    const fetches = c.calls.some(x => { const s = syms.get(`${mi} ${x}`); return !!s && s.kind === "import" && !s.io; });
    const awaitsHere = !!awaits.get(files[mi])?.has(c.line) && !catches.get(files[mi])?.has(c.line);
    if (fetches || awaitsHere) rootsOf(k).add(k);
  }
  const targets: [number, Key[]][] = [];
  comps.forEach(([mi, c], ci) => {
    if (c.kind === "prop") {
      const at = c.at ?? ""; const sp = at.indexOf(" "); const comp = sp < 0 ? at : at.slice(0, sp); const field = sp < 0 ? "" : at.slice(sp + 1);
      const p = compProps.get(comp); if (p) targets.push([ci, [keyOf(p[0], p[1], field)]]);
    } else {
      const ts = [...defn].filter(([, d]) => d === ci).map(([k]) => k);
      if (ts.length && !catches.get(files[mi])?.has(c.line)) targets.push([ci, ts]);
    }
  });
  for (let changed = true; changed;) {
    changed = false;
    for (const [ci, ts] of targets) {
      const [mi, c] = comps[ci]; const acc = new Set<Key>();
      for (const k of tracked(mi, c)) for (const r of roots.get(k) ?? []) acc.add(r);
      for (const t of ts) { const e = rootsOf(t); for (const r of acc) if (!e.has(r)) { e.add(r); changed = true; } }
    }
  }
  const deps = (r: Key): Set<Key> => new Set([...(roots.get(r) ?? [])].filter(x => x !== r));
  const name = (k: Key) => { const [mi, sid] = k.split(" "); return syms.get(`${mi} ${sid}`)?.name ?? ""; };
  const surf = new Map<Key, Map<RKey, [number, number, string]>>();
  const inB = new Map<RKey, Set<Key>>();
  for (const [mi, c] of comps) {
    if (c.kind !== "reader" && c.kind !== "memo" && c.kind !== "question") continue;
    const bs = nearestErrored(`${mi} ${c.region}`); if (!bs.length) continue;
    for (const k of tracked(mi, c)) {
      const rs = roots.get(k); if (!rs) continue;
      const parts = k.split(" "); const what = parts.length > 2 ? `${name(k)}.${parts.slice(2).join(" ")}` : name(k);
      for (const r of rs) for (const b of bs) {
        if (!surf.has(r)) surf.set(r, new Map()); const places = surf.get(r)!;
        const e = places.get(b); if (!e || e[0] > mi || (e[0] === mi && e[1] > c.line)) places.set(b, [mi, c.line, what]);
        if (!inB.has(b)) inB.set(b, new Set()); inB.get(b)!.add(r);
      }
    }
  }
  const out: Diagnostic[] = [];
  for (const [root, places] of surf) {
    const bs = [...places.keys()]; const anc = new Map(bs.map(b => [b, ancestors(b)]));
    for (const b of bs) {
      if (!bs.some(a => a !== b && !anc.get(b)!.has(a) && !anc.get(a)!.has(b))) continue;
      const mine = deps(root);
      const guards = [...inB.get(b)!].filter(g => g !== root && !deps(g).has(root) && !mine.has(g)).map(name);
      if (!guards.length) continue;
      const [mi, line, what] = places.get(b)!;
      const [rmi, rsid] = root.split(" ").map(Number);
      const rline = syms.get(`${rmi} ${rsid}`)?.line ?? 0; const rfile = files[rmi].split("/").pop() ?? "";
      const via = what === name(root) ? "" : ` (read here through \`${what}\`)`;
      const msg = `\`${name(root)}\` (asked at ${rfile}:${rline}) can fail${via}, and this read is inside the \`errored\` region that shows the failures of \`${guards.join("`, `")}\`: when \`${name(root)}\` fails, this section shows its error as its own and this section's retry does not ask it again. Catch it where it is read here (\`… catch (e) => …\`), or read it only inside its own \`errored\` region`;
      if (!out.some(d => d.line === line && d.file === files[mi] && d.msg === msg)) out.push({ code: "FOREIGN_FAILURE", rule: "R-f-11", line, msg, file: files[mi] });
    }
  }
  return out;
}
