// 06 AC-1b…AC-1e: what the compiler reads off an imperative body. Which arrows are actions without the keyword (AC-1b), and
// the checks every imperative run gets: a plain write an action holds across an `await` (HELD_WRITE, AC-1c), a read of a
// source the same change already wrote (STALE_OWN_READ, AC-1d), and a write after an `await` computed from the same source
// as read before it (STALE_WRITE_BACK, AC-1e). Solid sees none of them: a TypeScript body's promises and reads are not
// visible to it, which is why it asks for `action(function* …)` and lets a stale read or a lost update through.
import type { Expr, Stmt } from "./ast.ts";

export type Trigger = "optimistic" | "affects" | "write+await";
type Fn = Extract<Expr, { k: "fn" }>;
type Closures = Map<string, Fn>;

/** AC-1: a run suspends only at a statement-level `await` (`await e`, `let v = await e`, either with a `catch`). */
export const stmtAwait = (s: Stmt): boolean => (s.k === "let" || s.k === "expr") && (s.e.k === "await" || (s.e.k === "catch" && s.e.e.k === "await"));

/** The local closures a body's own statements call by name: `let f = () => { … }`, statement-bodied, not an action of its own. */
const closureOf = (s: Stmt): Fn | null => s.k === "let" && s.e.k === "fn" && s.e.stmts && !inferredAction(s.e.stmts) ? s.e : null;
const calledClosure = (e: Expr, cl: Closures): Fn | null => e.k === "call" && e.f.k === "id" && cl.has(e.f.name) ? cl.get(e.f.name)! : null;

/** AC-1b: why an arrow's body is an action — it guesses, declares `affects`, or both writes a source and awaits — or null for
 *  a plain run. Its own statements only: not the bodies of closures in it (each is inferred on its own), not an inline
 *  `action { … }` (its own run), but through the local closures it calls (a call runs the closure's writes in this run). */
export function inferredAction(stmts: Stmt[]): Trigger | null {
  let guess: Trigger | null = null, write = false, wait = false;
  const seen = new Set<Fn>();
  const go = (ss: Stmt[], cl: Closures): void => {
    const local = new Map(cl);
    for (const s of ss) {
      const c = closureOf(s); if (c) local.set((s as { name: string }).name, c); else if (s.k === "let") local.delete(s.name);
      const called = (s.k === "expr" || s.k === "let") ? calledClosure(s.e, local) : null;
      if (called && !seen.has(called)) { seen.add(called); go(called.stmts!, local); }
      switch (s.k) {
        case "optimistic": guess ??= "optimistic"; break;
        case "affects": guess ??= "affects"; break;
        case "write": write = true; break;
        case "let": case "expr": if (stmtAwait(s)) wait = true; break;
        case "sif": go(s.t, local); go(s.f, local); break;
        case "try": go(s.body, local); if (s.handler) go(s.handler, local); if (s.fin) go(s.fin, local); break;
      }
    }
  };
  go(stmts, new Map());
  return guess ?? (write && wait ? "write+await" : null);
}
export const triggerText = (t: Trigger): string => t === "write+await" ? "it writes and awaits" : `it has \`${t === "optimistic" ? "guess" : t}\``;

export type Finding = { code: "HELD_WRITE" | "STALE_OWN_READ" | "STALE_WRITE_BACK"; name: string };
type Path = string[];                                                   // keys from the source; "*" a computed key
type Dep = { k: string; path: Path; epoch: number };                    // AC-1e: a source read, and the awaits passed when it was read
// taint: the source reads each local's value was computed from; epoch: the awaits passed on this path (the most, after a merge)
type State = { written: Map<string, Path[]>; held: Set<string>; dead: boolean; taint: Map<string, Dep[]>; epoch: number };
const clone = (s: State): State => ({ written: new Map([...s.written].map(([k, v]) => [k, [...v]])), held: new Set(s.held), dead: s.dead, taint: new Map([...s.taint].map(([k, v]) => [k, [...v]])), epoch: s.epoch });
const merge = (...ss: State[]): State => {
  const live = ss.filter(s => !s.dead); if (!live.length) return { ...clone(ss[0]), dead: true };
  const out: State = { written: new Map(), held: new Set(), dead: false, taint: new Map(), epoch: 0 };
  for (const s of live) {
    for (const [k, v] of s.written) out.written.set(k, [...(out.written.get(k) ?? []), ...v]); s.held.forEach(h => out.held.add(h));
    for (const [k, v] of s.taint) out.taint.set(k, [...(out.taint.get(k) ?? []), ...v]); out.epoch = Math.max(out.epoch, s.epoch);
  }
  return out;
};
const overlaps = (a: Path, b: Path): boolean => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i] && a[i] !== "*" && b[i] !== "*") return false; return true; };

/** AC-1c, AC-1d and AC-1e over one imperative run. `action`: the body is one change across its awaits (AC-1); a plain run's change
 *  ends at each `await` (07 §5). `inferred`: an action by AC-1b, the only kind HELD_WRITE applies to — a declared `action`
 *  holds an early write on purpose (a transition: `action go() { id := 2; await prefetch() }`, S-solid-20). `bound`: the
 *  run's parameters. In source order, per path: a plain write that reaches an `await` in an inferred action is HELD_WRITE;
 *  a read of a source this change wrote, at an overlapping key, is STALE_OWN_READ; a plain write after an `await` whose value comes from a read of the same source (at an overlapping key) taken before that `await`, directly or through a local, is STALE_WRITE_BACK. A guess is not a held write (it shows now, H-11) but is a write a read does not see (H-10). A
 *  functional write (`x := v => …`, W-6) reads nothing now; a closure's body runs later, unless it is a local closure called
 *  here; `pending?` and `latest` are probes, not snapshots. Each finding once per name. */
export function runFindings(stmts: Stmt[], action: boolean, bound: string[] = [], inferred = false): Finding[] {
  const out: Finding[] = []; const said = new Set<string>();
  const report = (code: Finding["code"], name: string) => { const k = code + name; if (!said.has(k)) { said.add(k); out.push({ code, name }); } };
  const key = (name: string, ctx?: boolean) => (ctx ? "use " : "") + name;
  const walk = (ss: Stmt[], st: State, shadow: Set<string>, cl: Closures, depth: Set<Fn>): State => {
    const sh = new Set(shadow); const local = new Map(cl);
    const read = (e: Expr): void => {
      const path: Path = []; let x = e;
      while (x.k === "member" || x.k === "index") { if (x.k === "member") path.unshift(x.p); else { path.unshift(x.i.k === "lit" && typeof x.i.v === "string" ? x.i.v : "*"); read(x.i); } x = x.o; }
      if ((x.k === "id" && !sh.has(x.name)) || x.k === "use") {
        const k = key(x.name, x.k === "use"); const ws = st.written.get(k);
        if (ws?.some(w => overlaps(w, path))) report("STALE_OWN_READ", k);
        return;
      }
      if (x !== e) { read(x); return; }
      switch (x.k) {
        case "fn": case "serverfn": case "draft": case "pending": case "latest": case "lit": case "pre": case "peek": case "stylemap": return;
        case "call": {
          const c = calledClosure(x, local);
          x.args.forEach(read);
          if (c) { if (!depth.has(c)) { const inner = new Set(sh); c.params.forEach(p => inner.add(p)); const after = walk(c.stmts!, { ...clone(st), dead: false }, inner, local, new Set([...depth, c])); st.written = after.written; st.held = after.held; st.epoch = after.epoch; } return; }
          read(x.f); return;
        }
        default:
          for (const v of Object.values(x as object)) {
            if (Array.isArray(v)) v.forEach(y => { if (y && typeof y === "object") { if ("k" in y) read(y as Expr); else if ("v" in y) read((y as { v: Expr }).v); else if ("spread" in y) read((y as { spread: Expr }).spread); } });
            else if (v && typeof v === "object" && "k" in (v as object)) read(v as Expr);
          }
      }
    };
    // AC-1e: the source reads a value is computed from now — read directly (at this epoch) or through a local's taint. A
    // closure's body runs later; an awaited answer is the server's, not a snapshot of a source.
    const deps = (e: Expr, out: Dep[] = []): Dep[] => {
      const path: Path = []; let x = e;
      while (x.k === "member" || x.k === "index") { if (x.k === "member") path.unshift(x.p); else { path.unshift(x.i.k === "lit" && typeof x.i.v === "string" ? x.i.v : "*"); deps(x.i, out); } x = x.o; }
      if (x.k === "id" && sh.has(x.name)) { out.push(...(st.taint.get(x.name) ?? [])); return out; }
      if (x.k === "id" || x.k === "use") { out.push({ k: key(x.name, x.k === "use"), path, epoch: st.epoch }); return out; }
      if (x !== e) return deps(x, out);
      switch (x.k) {
        case "fn": case "serverfn": case "draft": case "pending": case "latest": case "lit": case "pre": case "peek": case "stylemap": case "await": return out;
        default:
          for (const v of Object.values(x as object)) {
            if (Array.isArray(v)) v.forEach(y => { if (y && typeof y === "object") { if ("k" in y) deps(y as Expr, out); else if ("v" in y) deps((y as { v: Expr }).v, out); else if ("spread" in y) deps((y as { spread: Expr }).spread, out); } });
            else if (v && typeof v === "object" && "k" in (v as object)) deps(v as Expr, out);
          }
          return out;
      }
    };
    const onAwait = () => { if (action) { st.held.forEach(h => report("HELD_WRITE", h)); st.held.clear(); } else st.written.clear(); };
    for (const s of ss) {
      if (st.dead) break;
      switch (s.k) {
        case "let": case "expr": {
          read(s.e);
          const d = stmtAwait(s) ? [] : deps(s.e);
          if (stmtAwait(s)) { st.epoch++; onAwait(); }
          if (s.k === "let") { const c = closureOf(s); sh.add(s.name); st.taint.set(s.name, d); if (c) local.set(s.name, c); else local.delete(s.name); }
          break;
        }
        case "write": case "optimistic": {
          for (const p of s.target.path) if (typeof p !== "string") read(p);
          if (s.e.k !== "fn") read(s.e);
          const k = key(s.target.name, s.target.ctx);
          const wpath = s.target.path.map(p => typeof p === "string" ? p : p.k === "lit" && typeof p.v === "string" ? p.v : "*");
          if (s.k === "write" && s.e.k !== "fn" && deps(s.e).some(d => d.k === k && d.epoch < st.epoch && overlaps(d.path, wpath))) report("STALE_WRITE_BACK", k);
          st.written.set(k, [...(st.written.get(k) ?? []), wpath]);
          if (s.k === "write" && inferred) st.held.add(k);
          break;
        }
        case "return": if (s.e) read(s.e); st.dead = true; break;
        case "throw": read(s.e); st.dead = true; break;
        case "sif": { read(s.c); const t = walk(s.t, clone(st), sh, local, depth), f = walk(s.f, clone(st), sh, local, depth); Object.assign(st, merge(t, f)); break; }
        case "try": {
          const before = clone(st);
          const body = walk(s.body, clone(st), sh, local, depth);
          const caught = s.handler ? walk(s.handler, merge(before, { ...body, dead: false }), s.catchName ? new Set([...sh, s.catchName]) : sh, local, depth) : null;
          const end = caught ? merge(body, caught) : body;
          if (s.fin) { const fin = walk(s.fin, merge(before, { ...end, dead: false }), sh, local, depth); Object.assign(st, fin, { dead: fin.dead || end.dead }); }
          else Object.assign(st, end);
          break;
        }
        case "action": case "refresh": case "affects": break;            // an inline action is its own run, checked on its own
      }
    }
    return st;
  };
  walk(stmts, { written: new Map(), held: new Set(), dead: false, taint: new Map(), epoch: 0 }, new Set(bound), new Map(), new Set());
  return out;
}

