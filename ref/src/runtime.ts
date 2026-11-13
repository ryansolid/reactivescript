// Reference runtime: spec/02-core §4 (instants), 03 (regions), 04 (rows), 05 (holds: two versions of state).
// Pull-based settle with push invalidation; dependencies per (object identity, key) — ST-2.
import { classMap } from "./style.ts";
import { inferredAction } from "./infer.ts";
import type { Decl, Expr, Markup, Program, Stmt } from "./ast.ts";
type FnDecl = Extract<Decl, { k: "fn" }>; type CompDecl = Extract<Decl, { k: "component" }>; type ActionDecl = Extract<Decl, { k: "action" }>; type ServerDecl = Extract<Decl, { k: "server" }>;

import { RuleError, CheckError } from "./errors.ts";
import { checkModules, unwrapServer } from "./check.ts";
export { RuleError, CheckError };
import { makeErrorClass, isA, PANIC, wireCopy, wireFailure } from "./failure.ts";
import { singleModule, type ModuleSet } from "./modules.ts";
import { primRx, isPrims } from "./prims.ts";
/** 12 SF-1d: Solid's server-function wrappers (\`GET\`, \`live\`, …) where there is no network: the function as it is (SF-7b). */
const LOCAL_WRAPPERS: Record<string, unknown> = { GET: (f: unknown) => f, live: (f: unknown) => f, broadcast: (f: unknown) => f, withMeta: (f: unknown) => f };
export class ErrVal { err: unknown; constructor(err: unknown) { this.err = err; } }
export class PendingVal { }                              // R-2: absence flows like a value
export const PENDING = new PendingVal();
const NOT_YET = Symbol("until: not yet");                 // AC-6: thrown out of an authoritative read that has no value yet
/** A flight lands any number of times: `await*` reads its latest landing (a stream, ST-6b); a plain `await` its first (R-1). */
export class Flight { key: string; state: "pending" | "resolved" | "rejected" = "pending"; value: unknown; first: { state: "resolved" | "rejected"; value: unknown } | null = null; constructor(key: string) { this.key = key; } }
export class ViewValue { region: Region; items: VItem[]; constructor(region: Region, items: VItem[]) { this.region = region; this.items = items; } }

type Path = string;
const join = (p: Path, k: string | number) => (p === "" ? String(k) : `${p}.${k}`);
type Target = Node | object;
const isErr = (v: unknown): v is ErrVal => v instanceof ErrVal;
const isAbsent = (v: unknown) => v instanceof ErrVal || v instanceof PendingVal;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !(v instanceof ErrVal) && !(v instanceof PendingVal) && !(v instanceof Flight) && !(v instanceof ViewValue);

/** Whether a difference between a guess and the truth touches a key the guess wrote (AC-3: a path guess is per key, Solid's per-node override). */
function guessedAt(n: { guessPaths: Path[] }, diff: Set<Path>): boolean {
  for (const d of diff) for (const g of n.guessPaths) if (g === "" || d === g || d.startsWith(g + ".") || g.startsWith(d + ".")) return true;
  return false;
}
/** Leaf paths at which `a` and `b` differ (E-6 per path). */
function diffPaths(a: unknown, b: unknown, path: Path, out: Set<Path>) {
  if (Object.is(a, b)) return;
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diffPaths(a[k], b[k], join(path, k), out);
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) out.add(join(path, "length"));
    return;
  }
  out.add(path);
}

// ---------------------------------------------------------------- nodes
type Kind = "source" | "eq" | "reader";
export class Node {
  static seq = 0;
  id = Node.seq++;
  value: unknown = undefined; hasValue = false;        // in-flight (σ′)
  committed: unknown = undefined; hasCommitted = false; // committed (σ)
  changedSinceCommit = false;
  prev: unknown = undefined; hasPrev = false;           // C-2 (ruled 2026-10-23, DV-5): the value before the most recent change
  state: "clean" | "check" | "dirty" = "dirty";
  changed = false; demanded = false; evaluated = false; // this instant
  deps = new Map<Target, Set<string>>();
  lane = false;                                        // R-10: read a probe during last compute
  lanes = new Set<Node>();                             // R-10 / H-7: which probed sources' lanes this value lives in
  inLanes = new Set<Node>();                           // H-7: the lanes it is held by: all but a guess's lane reached only through `latest` (DV-10)
  flight: Flight | null = null; answered = false; firstPaint = false; landing = false;   // R-1, R-7; landing: its flight answered and it has not recomputed since
  heldBy: number | null = null;                        // the change (instant) whose uncommitted write / flight this value belongs to
  taint = new Set<number>();                           // open changes this value derives from (equations); empty for served reads
  heldOn: number | null = null;                        // readers: the group this reader holds (root), or null
  taintFrom = new Set<Node>();                         // the inputs whose holds this node's last pass took (plain reads, not probes)
  served = new Set<Node>();                            // readers: held values this pass was served σ for (D-3); re-run while any is still in flight
  triggered = false;                                   // readers: this instant's pass was caused by a notification (D-4: membership is the tick's)
  kept = new Map<Target, Set<string>>();               // D-10: inputs of the committed pass, kept while the value is held
  questionMoved = false;                               // H-11: the question changed under the guess (S-solid-44): answers to it do not correct the guess
  plainTaint = new Set<number>();                      // R-11: the open changes this pass's plain reads derive from (a lane value carries these, not its lane's)
  probed = new Set<Node>();                            // R-11 / Solid D-25: the nodes this pass read ahead (`latest`, `pending?`)
  plainAhead = new Set<Node>();                        // R-11: held nodes this pass read plainly and was given the in-flight value
  screenFor: Set<Node> | null = null;                  // R-11: a re-run pass's probed nodes — a plain read of one is the screen's
  deferred = false; lagging = false;                   // V-16 / D-40: declared lag — re-asks never hold; readers keep the shown answer
  question = false;                                    // ST-5: `source x = e` — an equation until written
  guess: unknown = undefined; hasGuess = false; guessBy: number | null = null; corrected = false; guessPaths: Path[] = [];
  shownGuess: unknown = undefined; guessShown = false; answerCorrected = false;   // D-22/D-34 (Solid decision 3, #4695): the guess as the screen last showed it; `latest x` keeps it after an answer corrects the graph, until the hold commits
  guessEntries: { path: Path; by: number; value: unknown; spent?: boolean }[] = [];   // H-11: each guess with the hold it was made over ("" = the root); `guess` is the truth with the live ones applied in order; `spent`: a new answer corrected it (D-34) — it shows the truth now but still belongs to its action, so the action's re-ask still holds it (D-34) and its end still ends it   // guessPaths: the keys guessed ("" = the root; AC-3 path targets)   // AC-3 / H-11: a guess over the hold `guessBy`; corrected: the truth differed, display keeps what it showed
  quiet = false; refreshBy: number | null = null; refreshInAction = false;      // AC-4: a quiet re-ask; its landing belongs to the change that asked (D-31)
  affectedBy: number | null = null;                    // AC-5: declared pending until that change lands
  heldKeys = new Map<string, number>();                // ST-2c: held path writes, per key ("" = the root)
  keyBy: string | null = null;                         // ST-4: a keyed collection is reconciled by this key
  kind: Kind; name: string; region: Region; compute?: (rt: Runtime) => unknown;
  constructor(kind: Kind, name: string, region: Region, compute?: (rt: Runtime) => unknown) { this.kind = kind; this.name = name; this.region = region; this.compute = compute; }
}

type CtxBinding = { context: Extract<Decl, { k: "context" }>; home: Region; dflt: Node | null };   // RG-7: a declared context; its identity is this object
type Binding = Node | { constant: unknown } | CtxBinding | { fn: FnDecl; home: Region } | { comp: CompDecl; home: Region } | { action: ActionDecl; home: Region };   // home: the declaring region — bodies resolve names there (lexical, RG-7a; across modules, MO-6)
/** An imperative run that may suspend at a statement-level `await` (AC-1). An action run holds its change until it returns. */
/** A block being executed: a plain block, a `try` body (with its handlers), a catch handler, or a finally. */
type Frame = { stmts: Stmt[]; i: number; kind: "block" | "try" | "catch" | "finally"; catchName?: string; catchClasses?: unknown[]; handler?: Stmt[]; fin?: Stmt[] };
type Run = { frames: Frame[]; region: Region; env: Map<string, unknown>; change: number | null; flight: Flight | null; action: boolean; bind: string | null; caught?: Extract<Expr, { k: "catch" }> | null; result?: unknown; returned?: boolean; settle?: { flight: Flight; name: string } };   // settle: a server function's body — its end settles the call (12 SF-7b)
export class Region {
  nodes = new Set<Node>(); effects: EffectRec[] = []; children = new Set<Region>();
  scope = new Map<string, Binding>();
  provided = new Map<CtxBinding, Node>();              // RG-7: provisions by context, found through the instantiation chain
  alive = true;
  parent: Region | null; rt: Runtime; boundary: BoundaryItem | null;
  lexical: Region | null;                              // RG-4c: children keep the caller's names while owned where they are rendered
  constructor(parent: Region | null, rt: Runtime, boundary: BoundaryItem | null = parent?.boundary ?? null, lexical: Region | null = parent) { this.parent = parent; this.rt = rt; this.boundary = boundary; this.lexical = lexical; parent?.children.add(this); }
  lookup(name: string): Binding | undefined { return this.scope.get(name) ?? this.lexical?.lookup(name); }
  dispose() {
    if (!this.alive) return; this.alive = false;
    for (const c of [...this.children]) c.dispose();
    for (const e of this.effects) { if (e.cleanup) this.rt.pendingCleanups.push(e.cleanup); e.cleanup = undefined; e.alive = false; }
    for (const n of this.nodes) this.rt.unsubscribe(n);
    this.parent?.children.delete(this);
  }
}
type EffectRec = { computes: Node[]; body: Stmt[]; region: Region; ran: boolean; alive: boolean; cleanup?: () => void; last: unknown[] };
type Write = { node: Node; path: (string | number)[]; value: unknown };

// view instances: structure has a committed and an in-flight version (H-2, H-8)
type ViewInst = { region: Region; items: VItem[] };
type Row = { elem: unknown; region: Region; inst: ViewInst };
type ReaderItem = { k: "read"; node: Node; shown: string | null };
type BoundaryItem = { classes?: unknown[]; k: "loading" | "errored"; m: Extract<Markup, { k: "loading" | "errored" }>; region: Region; parent: BoundaryItem | null; armed: boolean; onNode: Node | null; fallback: ViewInst; content: ViewInst; showingFallback: boolean; committedFallback: boolean; caught: Node[]; stillWaiting: boolean; armedBy: number; laneAttached: boolean; bornCandidates: number };
type VItem =
  | { k: "text"; s: string } | ReaderItem | { k: "comp"; inst: ViewInst; portal?: boolean }   // portal: RG-8 — settled and committed here, shown at the end of the document
  | { k: "el"; tag: string; attrs: { name: string; node: Node }[]; children: VItem[] }
  | { k: "mif"; m: Extract<Markup, { k: "mif" }>; cond: Node; region: Region; committed: { branch: string; inst: ViewInst; openedBy: number } | null; inflight: { branch: string; inst: ViewInst; openedBy: number } | null }
  | { k: "mfor"; m: Extract<Markup, { k: "mfor" }>; xs: Node; region: Region; committedRows: Row[]; inflightRows: Row[]; rowsOpenedBy: number }
  | BoundaryItem;

function nearest(b: BoundaryItem | null, kind: "loading" | "errored"): BoundaryItem | null { for (let x = b; x; x = x.parent) if (x.k === kind) return x; return null; }
/** R-f-4: the nearest `errored` whose classes take `err`; a boundary of other classes lets it pass. */
function catching(b: BoundaryItem | null, err: unknown): BoundaryItem | null { for (let x = b; x; x = x.parent) if (x.k === "errored" && isA(err, x.classes)) return x; return null; }
/** H-12: a `loading` above an error fallback that is armed (re-armed by its `on`): the pending content under the fallback is its. */
function armedAbove(eb: BoundaryItem): BoundaryItem | null { for (let x = eb.parent; x; x = x.parent) if (x.k === "loading") return x.armed ? x : null; return null; }
/** An `errored` above that is showing its fallback: everything under it is behind it (H-4). */
function erroredShowing(b: BoundaryItem | null): BoundaryItem | null { for (let x = b; x; x = x.parent) if (x.k === "errored" && x.showingFallback) return x; return null; }

// ---------------------------------------------------------------- runtime
export class Runtime {
  root: Region;
  effects: EffectRec[] = [];
  view!: ViewInst;
  pendingWrites: Write[] = [];
  pendingCleanups: (() => void)[] = [];
  subs = new Map<Target, Map<string, Set<Node>>>();
  flights = new Map<string, Flight>();
  log: string[] = [];
  diagnostics: string[] = [];
  instant = -1;
  openChanges = new Set<number>();                     // roots of held groups (H-2, per-change membership: Solid D-1..D-5)
  parent = new Map<number, number>();                  // union-find over changes
  committedOnce = false;
  get holdOpen() { return this.openChanges.size > 0; }
  find(c: number): number { let r = c; while (this.parent.has(r) && this.parent.get(r) !== r) r = this.parent.get(r)!; return r; }
  union(a: number, b: number) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb)); }
  private groupOpen(c: number) { return this.openChanges.has(this.find(c)); }
  private tracking: Node | null = null;
  private demandMode = true;
  private probing = 0;                                  // inside `latest`: reads σ′, never served
  private committedView = false;                        // D-25: evaluate a lane reader against the committed world
  private probeReads: Set<Node> | null = null;          // `pending?` over a composite: nodes read inside
  private heldLanes = new Set<Node>();                  // H-7: lanes with pending work this instant
  private bornHeldOwn: { reader: Node; lb: BoundaryItem }[] = [];
  openActions = new Set<Run>();                         // AC-1: an action's change stays open until its body returns
  private suspended: Run[] = [];                        // runs waiting on a flight
  private started: Run[] = [];                          // runs started by the current imperative run, not yet assigned a change
  private currentRun: Run | null = null;
  private pendingJoin: number[] = []; private pendingBodyEnds: number[] = [];
  private pendingFlush: (() => unknown)[] = [];                 // EF-8: onFlush callbacks; one run after the flush that registered them
  private pendingSettled: { f: () => unknown; change: number | null }[] = [];   // EF-7: onSettled callbacks, by the change their run belongs to (null: the next instant opened)
  private pendingGuesses: { node: Node; path: string[]; value: unknown }[] = []; private pendingRefresh: Node[] = []; private pendingAffects: Node[] = [];
  program: Program;

  /** 09 MO-1: each imported module's region, instantiated once, dependencies first; its state is app state. */
  modules = new Map<string, Region>();
  constructor(input: Program | ModuleSet) {
    const set = "programs" in input ? input : singleModule(input);
    const program = set.programs.get(set.entry)!;
    this.program = program;
    this.root = new Region(null, this, null);
    const { diags } = checkModules(set); if (diags.length) throw new CheckError(diags);   // 08: the checker runs first; every static diagnostic is an error
    for (const path of set.order) { if (path === set.entry) continue; const r = new Region(this.root, this, null); this.modules.set(path, r); this.declare(set.programs.get(path)!.decls, r); }
    this.declare(program.decls, this.root);
    this.view = this.instantiate(program.view, this.root);
  }

  // ---- declarations (E-1, E-4, E-7, EF-1) ----
  declare(decls: Decl[], region: Region) {
    for (const d of decls) {
      if (d.k === "import" && d.resolved) { const m = this.modules.get(d.resolved); if (!m) throw new RuleError("MO-9", `${d.from} is known by its signature only (${d.from.replace(/\.rx$/, ".d.rx")}): there is no body to run`); for (const { name, alias } of d.names) { const b = m.scope.get(name); if (b) region.scope.set(alias, b); } continue; }   // MO-1: the module's own bindings (a type binds nothing)
      if (d.k === "import" && isPrims(d.from)) { for (const { name, alias } of d.names) { const f = primRx(name); if (!f) throw new RuleError("IMPORT", `${name} from "${d.from}" is not in the scenario prelude`); region.scope.set(alias, { fn: f, home: this.root }); } continue; }   // MO-10: the prelude's primitives, as the .rx they mean
      if (d.k === "import") for (const { name, alias } of d.names) {                    // R-io-4: a JS import is io unless `pure`; the scenario prelude supplies the values
        const v = d.from === "@solidjs/web/server-functions" ? LOCAL_WRAPPERS[name] : name === "log" ? (...a: unknown[]) => { this.log.push(`log(${a.map(fmt).join(", ")})`); } : d.declaredErrors?.includes(name) ? makeErrorClass(name, ["message"], a => String(a[0] ?? name)) : BUILTINS[name] ?? (d.from.endsWith("/api") ? (...a: unknown[]) => this.flight(`${name}:${a.map(fmt).join(",")}`) : undefined);   // "./api": every function is a flight keyed by its arguments
        if (v === undefined) throw new RuleError("IMPORT", `${name} from "${d.from}" is not in the scenario prelude`);
        region.scope.set(alias, { constant: d.pure || d.declaredPure?.includes(name) || d.declaredErrors?.includes(name) || typeof v !== "function" ? v : Object.assign((...a: unknown[]) => (v as (...a: unknown[]) => unknown)(...a), { io: true }) });
      }
      if (d.k === "error") { const msg = d.msg; region.scope.set(d.name, { constant: makeErrorClass(d.name, d.params, args => msg ? String(this.untracked(() => this.ev(msg, region, new Map(d.params.map((p, i) => [p, args[i]] as const))))) : d.name) }); }   // R-f-1
      if (d.k === "context") region.scope.set(d.name, { context: d, home: region, dflt: null });
      if (d.k === "server") region.scope.set(d.name, { constant: this.serverFn(d, region) });
      if (d.k === "eq") { const sf = unwrapServer(d.e); if (sf) this.serverNames.set(sf, d.name); }   // SF-1d: its flights are named by the equation
      if (d.k === "fn") region.scope.set(d.name, { fn: d, home: region }); if (d.k === "component") region.scope.set(d.name, { comp: d, home: region }); if (d.k === "action") region.scope.set(d.name, { action: d, home: region }); }
    for (const d of decls) {                                           // E-7: equations are a system
      if (d.k === "eq" && !this.instantiates(d.e, region)) { const n = this.mkNode("eq", d.name, region, rt => rt.evalExpr(d.e, region)); n.deferred = !!d.deferred; n.keyBy = d.key ?? null; region.scope.set(d.name, n); }
      if (d.k === "provide") { const b = d.e.k === "id" ? region.lookup(d.e.name) : undefined; region.provided.set(this.ctxNamed(d.name, region), b instanceof Node ? b : this.mkNode("eq", `provide ${d.name}`, region, rt => rt.evalExpr(d.e, region))); }   // a provided source is the source (O-4)
      if (d.k === "source" && d.question) { const n = this.mkNode("eq", d.name, region, rt => rt.evalExpr(d.init, region)); n.question = true; n.keyBy = d.key ?? null; region.scope.set(d.name, n); }   // ST-5: a source with a standing question
      else if (d.k === "source") { const n = this.mkNode("source", d.name, region); n.keyBy = d.key ?? null; region.scope.set(d.name, n); }
    }
    for (const d of decls) {
      if (d.k === "eq" && this.instantiates(d.e, region)) region.scope.set(d.name, this.instantiateFn(d.e as Extract<Expr, { k: "call" }>, region));
      else if (d.k === "source" && !d.question) {
        const n = region.scope.get(d.name) as Node;
        if (isReactive(d.init, region)) throw new RuleError("SNAPSHOT_INITIALIZER", `source ${d.name} := … reads a reactive value: write the snapshot as peek(…) (E-4, DV-6)`);
        n.value = this.demandMode && !this.currentRun ? this.unsubscribed(() => this.evalExpr(d.init, region)) : this.snapshot(d.init, region); n.hasValue = true; n.state = "clean"; n.changed = true; n.changedSinceCommit = true;   // E-4
      } else if (d.k === "effect") {
        const computes = d.inputs.map((e, i) => this.mkNode("eq", `effect#${i}`, region, rt => rt.evalExpr(e, region)));
        const rec: EffectRec = { computes, body: d.body, region, ran: false, alive: true, last: [] };
        region.effects.push(rec); this.effects.push(rec);
      }
    }
  }
  private fnBind(e: Expr, region: Region): { fn: FnDecl; home: Region } | null { if (e.k !== "call" || e.f.k !== "id") return null; const b = region.lookup(e.f.name); return b && "fn" in b ? b : null; }
  private fnOf(e: Expr, region: Region): FnDecl | null { return this.fnBind(e, region)?.fn ?? null; }
  private isInstantiating(f: FnDecl) { return f.params.some(p => p.ref) || f.decls.length > 0; }
  private instantiates(e: Expr, region: Region) { const f = this.fnOf(e, region); return !!f && this.isInstantiating(f); }
  private instantiateFn(call: Extract<Expr, { k: "call" }>, region: Region): Node {   // E-9 / RG-6
    const fb = this.fnBind(call, region)!; const f = fb.fn;
    const r = new Region(region, this, region.boundary, fb.home);           // owned at the call, names from the declaration
    f.params.forEach((p, i) => {
      const arg = call.args[i];
      if (p.ref) { const b = arg?.k === "id" ? region.lookup(arg.name) : undefined; r.scope.set(p.name, b instanceof Node ? b : this.mkNode("eq", `${f.name}.${p.name}`, region, rt => arg ? rt.evalExpr(arg, region) : undefined)); }
      else {
        if (arg && isReactive(arg, region)) this.diagnostics.push(`SNAPSHOT_ARGUMENT: ${f.name}(…): argument for value parameter ${p.name} is reactive and is snapshotted; declare the parameter ref`);
        r.scope.set(p.name, { constant: arg ? this.snapshot(arg, region) : undefined });
      }
    });
    this.declare(f.decls, r);
    const tb = f.tail.k === "id" ? r.lookup(f.tail.name) : undefined;
    if (tb instanceof Node) return tb;
    return this.mkNode("eq", `${f.name}()`, r, rt => rt.evalExpr(f.tail, r));
  }
  mkNode(kind: Kind, name: string, region: Region, compute?: (rt: Runtime) => unknown) { const n = new Node(kind, name, region, compute); region.nodes.add(n); return n; }

  // ---- instants (02 §4, 05 H-2/H-3) ----
  step(writes: Write[]): { frame: string; effects: string[] }[] {
    const out: { frame: string; effects: string[] }[] = [];
    let w = writes;
    for (;;) {
      do { this.instant++; out.push(this.runInstant(w)); w = this.pendingWrites; this.pendingWrites = []; } while (w.length && w.some(x => this.effective(x)));   // W-3: an apply's writes that are all equal open no instant
      const logBefore = this.log.length;
      const stray = this.pendingSettled.filter(s => s.change === null); this.pendingSettled = this.pendingSettled.filter(s => s.change !== null);
      for (const s of stray) this.fireSettled(s.f);                    // EF-7: registered by a run whose writes opened no instant — it fires now, with this one
      const fs = this.pendingFlush; this.pendingFlush = [];
      for (const f of fs) f();                                           // EF-8: the flush is done; its onFlush callbacks are one run, a new instant
      out[out.length - 1].effects.push(...this.log.slice(logBefore));
      w = this.pendingWrites; this.pendingWrites = [];
      if (!w.length || !w.some(x => this.effective(x))) break;
    }
    return out;
  }
  /** Whether a write would change its slot (E-6 per path; a functional write is applied to the current value, W-6). */
  private effective(w: Write): boolean {
    let cur: unknown = w.node.value; for (const k of w.path) cur = isObj(cur) ? cur[String(k)] : undefined;
    const v = typeof w.value === "function" ? (w.value as (x: unknown) => unknown)(cur) : w.value;
    const d = new Set<Path>(); diffPaths(cur, v, "", d); return d.size > 0;
  }
  /** Land an async answer (a change, V-6) and run the instant it opens. */
  land(target: string, value: unknown, reject = false) {
    let f: Flight | undefined;
    if (/^".*"$/.test(target)) f = this.flights.get(target.slice(1, -1));
    else { const n = this.findNode(target); f = n?.flight ?? undefined; if (!n) throw new Error(`no node ${target}`); if (!f) throw new Error(`${target} has no flight`); }
    if (!f) throw new Error(`no flight ${target}`);
    this.answer(f, reject ? "rejected" : "resolved", reject ? (value instanceof Error ? value : new Error(String(value))) : value);   // `reject x NotFound("…")`: a declared class (MO-8)
    const w = this.pendingWrites; this.pendingWrites = [];
    return this.step(w);
  }

  private runInstant(writes: Write[]) {
    // Phase 1 — write (W-3, W-4, H-3): into σ′; notify subscribers; E-6 per path.
    for (const n of this.allNodes()) { n.changed = false; n.demanded = false; n.evaluated = false; }
    for (const c of this.pendingJoin) this.union(this.instant, c); this.pendingJoin = [];                    // a continuation's instant is the action's change
    for (const r of this.started) r.change = this.instant; this.started = [];
    for (const s of this.pendingSettled) if (s.change === null) s.change = this.instant;                    // EF-7: the change the registering run's writes open (or are adopted into)
    const queue = [...writes];
    for (let qi = 0; ; qi++) {
      if (qi >= queue.length) {                                         // AC-6: a write (or landing) that flips an until joins its action's change; the action resumes in this instant
        if (!this.untilsFlip()) break;
        queue.push(...this.pendingWrites); this.pendingWrites = [];
        if (qi >= queue.length) break;
      }
      let w = queue[qi];
      if (w.node.heldBy !== null && w.node.heldBy !== this.instant && this.groupOpen(w.node.heldBy)) this.union(this.instant, w.node.heldBy);   // D-8: a second proposal for a held slot joins its hold
      if (typeof w.value === "function") {                                                                 // W-6: a functional write applies to the slot as it stands at the instant — writes compose in run order
        let cur: unknown = w.node.value; for (const k of w.path) cur = isObj(cur) ? cur[String(k)] : undefined;
        w = { ...w, value: (w.value as (v: unknown) => unknown)(cur) };
      }
      if (w.path.length === 0) {
        if (w.node.keyBy && Array.isArray(w.value) && Array.isArray(w.node.value)) w = { ...w, value: this.reconcile(w.node.value, w.value, w.node.keyBy) };   // ST-4a on a source: a root write reconciles by key
        const d = new Set<Path>(); diffPaths(w.node.value, w.value, "", d);
        if (d.size === 0) continue;
        w.node.prev = w.node.value; w.node.hasPrev = true;
        w.node.value = w.value; w.node.changed = true; w.node.changedSinceCommit = true; w.node.evaluated = true; w.node.heldBy = this.instant; w.node.heldKeys.set("", this.instant); this.notify(w.node, "");
      } else {
        let o = w.node.value as Record<string, unknown>;
        const keys = w.path.map(String); const last = keys.pop()!;
        for (const k of keys) { if (!isObj(o[k])) { o[k] = /^\d+$/.test(k) ? [] : {}; this.notify(o, k); } o = o[k] as Record<string, unknown>; }
        const d = new Set<Path>(); diffPaths(o[last], w.value, "", d);
        if (d.size === 0) continue;
        o[last] = w.value; w.node.changedSinceCommit = true; w.node.heldBy = this.instant; w.node.heldKeys.set(keys.concat(last).join("."), this.instant); this.notify(o, last);
        if (Array.isArray(o)) this.notify(o, "length");
      }
    }
    for (const { node, path, value: v0 } of this.pendingGuesses) {   // AC-3: a guess shows from this instant's settle
      const at0 = node.hasGuess ? node.guess : node.demanded ? node.value : this.pull(node);   /* a guess over a source nothing on screen reads (found by S-app-notes: the list was unmounted) */
      const open = (c: number | null) => c !== null && (c === this.instant || this.groupOpen(c));
      const held = !node.hasGuess && node.hasCommitted && (open(node.heldBy) || [...node.taint].some(open));
      const base = held ? node.committed : at0;   // a functional guess applies to what the screen shows: an input still held (the handler's own write, adopted by the action, AC-1) is not the screen's yet (#33 U1)
      let cur: unknown = base; for (const k of path) cur = isObj(cur) ? cur[k] : undefined;
      const value = typeof v0 === "function" ? (v0 as (x: unknown) => unknown)(cur) : v0;   // W-6 applies to guesses too
      const at = path.join(".");
      for (const e of node.guessEntries) if (!e.spent && this.groupOpen(e.by) && guessedAt({ guessPaths: [e.path] }, new Set([at]))) this.union(this.instant, e.by);   // H-2 / D-8: a guess on a slot another open change guesses is a second proposal for it — the two holds are one (#33 U2)
      node.guessEntries.push({ path: at, by: this.instant, value });   // its own hold's, per key (H-11): two actions' guesses on one row live and end apart
      node.corrected = false; this.rebuildGuess(node); this.notify(node, "");
    }
    this.pendingGuesses = [];
    for (const n of this.pendingRefresh) { n.quiet = true; n.refreshBy = this.instant; if (n.flight) this.flights.delete(n.flight.key); this.markDirty(n); }   // AC-4: re-ask quietly
    this.pendingRefresh = [];
    for (const n of this.pendingAffects) n.affectedBy = this.instant;                                        // AC-5
    this.pendingAffects = [];
    if (this.instant === 0) for (const n of this.allNodes()) if (n.kind === "source") { n.changed = true; n.evaluated = true; }

    // Phase 2 — settle (E-3) against σ′: readers of the in-flight structure, effect computes, boundaries (H-5/H-6).
    const settleAll = () => { const holding: Node[] = []; this.heldLanes.clear(); this.bornHeldOwn = []; this.settle(this.view, holding, null); for (const e of this.effects) if (e.alive) for (const c of e.computes) { this.pull(c); if (c.changed) c.changedSinceCommit = true; } return holding; };
    let holding = settleAll();
    if (this.bodyEndCorrections()) { for (const n of this.allNodes()) if (n.hasGuess && n.corrected) this.notify(n, ""); holding = settleAll(); }

    // Hold decision per change group (H-2, H-3, H-4; Solid D-1..D-5): a reader holds the group it joined; a group with no holder commits.
    const roots = () => { const r = new Set<number>(); for (const c of this.openChanges) r.add(this.find(c)); r.add(this.find(this.instant)); return r; };
    let committedSome = false;
    for (let pass = 0; pass < 3; pass++) {
      const heldRoots = new Set<number>();
      for (const n of holding) if (n.heldOn !== null) heldRoots.add(this.find(n.heldOn));
      for (const r of this.allNodes()) if (r.kind === "reader" && r.demanded) for (const b of r.served) if (b.value instanceof PendingVal) { if (b.heldBy !== null) heldRoots.add(this.find(b.heldBy)); for (const t of b.taint) heldRoots.add(this.find(t)); }   // a flight a display still waits on keeps every change in its question open (F-2)
      for (const a of this.openActions) if (a.change !== null) heldRoots.add(this.find(a.change));          // AC-1: an action holds its change until its body returns
      for (const n of this.allNodes()) if (n.quiet && n.refreshInAction && n.refreshBy !== null && n.flight?.state === "pending" && this.allNodes().some(m => this.guessedBy(m, this.find(n.refreshBy!)))) heldRoots.add(this.find(n.refreshBy));   // D-34, AC-4: a re-ask issued by an action that guessed is authoritative work in flight — the change waits for its answer, so every guess of the action (on that source or another) stays until the truth that confirms or corrects it lands
      for (const l of this.heldLanes) { if (l.heldBy !== null) heldRoots.add(this.find(l.heldBy)); for (const t of l.taint) heldRoots.add(this.find(t)); }   // H-7: a held lane keeps its change staged (S-solid-33: the landing stays uncommitted)
      let any = false;
      if (process.env.RS_TRACE) console.log(`[instant ${this.instant} pass ${pass}] holding=${holding.map(h => h.name + "@" + h.heldOn).join(",")} heldRoots=${[...heldRoots]} roots=${[...roots()]} parent=${[...this.parent.entries()].map(e => e.join(">"))} actions=${[...this.openActions].map(a => a.change)} lanes=${[...this.heldLanes].map(l => l.name + ":" + l.heldBy + "/" + [...l.taint])}`);
      for (const g of roots()) {
        if (heldRoots.has(g)) { this.openChanges.add(g); continue; }
        this.openChanges.delete(g); any = true; committedSome = true;
        this.commitGroup(g);
      }
      if (!any) break;
      holding = settleAll();                                           // readers that were served committed values re-run (sources notified)
    }
    if (!this.committedOnce && !committedSome) {
      for (const h of holding) if (!nearest(h.region.boundary, "loading")) this.diagnostics.push(`ASYNC_OUTSIDE_LOADING_BOUNDARY: ${h.name} is pending at mount with no loading boundary; the mount is held`);
    }
    if (!this.committedOnce && !this.openChanges.has(this.find(0)) && committedSome) this.committedOnce = true;   // the view attaches when the mount's change commits
    if (this.openChanges.has(this.find(this.instant))) for (const { reader, lb } of this.bornHeldOwn) { lb.caught.push(reader); lb.showingFallback = true; reader.heldOn = null; }   // D-25: born held under a fresh boundary → the boundary's
    else for (const { lb } of this.bornHeldOwn) { lb.bornCandidates = 0; lb.showingFallback = lb.caught.length > 0; if (!lb.showingFallback) lb.armed = false; }
    // Verdicts are final only after the decision (H-9): lane readers re-settle against the decided world, then show ahead (H-7).
    for (const n of this.allNodes()) if (n.hasGuess && !n.corrected && !this.heldLanes.has(n)) { n.guessShown = true; n.shownGuess = n.guess; }   // D-22: the guess the screen shows now (a held lane's guess is not shown: S-solid-33)
    for (const n of this.allNodes()) if (n.lane) { n.state = "clean"; this.markDirty(n); }   // re-settle lane nodes; their subscribers are notified too (a dirty node whose subs were not told blocks later invalidation)
    this.settle(this.view, [], null);
    this.patchLanes(this.view);
    this.portalOut = [];
    const main = this.committedOnce ? this.renderCommitted(this.view) : "";
    const portals = this.portalOut.join("");
    const frame = portals.trim() ? `${main} » ${portals}` : main;   // RG-8: what portals show follows the page's own text

    // Phase 3 — observe: E-8; effects (EF-2..EF-6) whose computes are committed.
    for (const n of this.allNodes()) {
      const inFrame = n.kind === "source" || n.demanded;
      if (!inFrame) { n.hasValue = false; n.value = undefined; n.hasCommitted = false; }   // E-8
    }
    const logBefore = this.log.length;
    for (const c of this.pendingCleanups) c(); this.pendingCleanups = [];
    for (const e of [...this.effects]) {
      if (!e.alive) continue;
      const settled = e.computes.every(c => !(c.value instanceof PendingVal) && ![...c.taint].some(t => this.openChanges.has(this.find(t))) && !this.laneHeld(c));   // E-12: an error is an answer; D-34: a corrected guess's effects wait for the commit, as its views do
      const differs = (c: Node, i: number) => { if (!e.ran) return true; const d = new Set<Path>(); diffPaths(e.last[i], c.value, "", d); return d.size > 0; };
      const fire = settled && (!e.ran || e.computes.some((c, i) => c.changedSinceCommit && differs(c, i)));   // EF-2: a value differing from the one last received (pending → equal is not a change)
      if (!fire) continue;
      for (const c of e.computes) c.changedSinceCommit = false;
      e.last = e.computes.map(c => c.value);
      e.cleanup?.(); e.cleanup = undefined; e.ran = true;
      const r = this.runStmts(e.body, e.region, new Map(), e.computes.map(c => c.value));
      if (typeof r === "function") e.cleanup = r as () => void;
    }
    this.effects = this.effects.filter(e => e.alive);
    const due = this.pendingSettled.filter(s => s.change !== null && s.change <= this.instant && !this.openChanges.has(this.find(s.change)));   // EF-7: its change has committed
    this.pendingSettled = this.pendingSettled.filter(s => !due.includes(s));
    for (const s of due) this.fireSettled(s.f);
    return { frame, effects: this.log.slice(logBefore) };
  }

  /** Commit a change group: its writes and landed answers become σ, its structure attaches, its readers show. */
  private commitGroup(g: number) {
    for (const n of this.allNodes()) {
      if (n.heldBy !== null && this.find(n.heldBy) === g) {
        n.heldBy = null;
        if (n.kind === "source") this.notify(n, "");                   // readers served the old committed value re-run
      }
      const stillHeld = n.heldBy !== null && this.openChanges.has(this.find(n.heldBy)) && this.find(n.heldBy) !== g;
      const openTaint = [...n.taint].some(t => this.openChanges.has(this.find(t)) && this.find(t) !== g);
      if (n.hasValue && !stillHeld && !openTaint && !(n.value instanceof PendingVal)) { n.committed = n.value; n.hasCommitted = true; }
      if (n.heldOn !== null && this.find(n.heldOn) === g) n.heldOn = null;
      if (n.hasGuess && (this.guessedBy(n, g) || (n.guessBy !== null && this.find(n.guessBy) === g))) {   // H-11: a guess lives as long as its hold; another action's guesses on the node stay
        n.guessEntries = n.guessEntries.filter(e => this.find(e.by) !== g); n.corrected = false;
        if (n.guessEntries.length === 0) { n.questionMoved = false; n.hasGuess = false; n.guess = undefined; n.guessBy = null; n.guessPaths = []; n.guessShown = false; n.shownGuess = undefined; n.answerCorrected = false; } else this.rebuildGuess(n);
        this.notify(n, "");
      }
      for (const [k, c] of n.heldKeys) if (this.find(c) === g) n.heldKeys.delete(k);
      if (n.affectedBy !== null && this.find(n.affectedBy) === g) n.affectedBy = null;
      if (n.refreshBy !== null && this.find(n.refreshBy) === g) { n.refreshBy = null; n.refreshInAction = false; if (!(n.value instanceof PendingVal)) n.quiet = false; }
    }
    this.commit(this.view, g);
  }
  // ---- settle / commit / render over the two structure versions ----
  private settle(v: ViewInst, holding: Node[], boundary: BoundaryItem | null) { for (const i of v.items) this.settleItem(i, holding, boundary); }
  private settleItem(i: VItem, holding: Node[], boundary: BoundaryItem | null) {
    switch (i.k) {
      case "text": return;
      case "comp": return this.settle(i.inst, holding, boundary);
      case "read": {
        const v = this.pull(i.node);
        if (v instanceof ViewValue) return this.settle(v, holding, boundary);
        { const eb = erroredShowing(boundary); const above = eb && v instanceof PendingVal ? armedAbove(eb) : null; if (above) { above.caught.push(i.node); i.node.heldOn = null; return; }   // H-12: an armed `loading` above the error fallback takes the pending content (found by S-ai2-search)
          if (eb && (i.node.served.size || v instanceof PendingVal)) { eb.stillWaiting = true; i.node.served.clear(); i.node.heldOn = null; return; } }   // behind an error fallback: not the display (H-4); pending is not an answer (D-41)
        if (v instanceof ErrVal) {                                                                                         // H-12 / D-41: an error is an answer; it reveals with its frame
          const eb = catching(boundary, v.err); if (eb) eb.caught.push(i.node);
          const openE = [...i.node.taint].filter(c => c !== this.instant && this.openChanges.has(this.find(c)));
          i.node.heldOn = openE.length || i.node.taint.has(this.instant) ? this.find(openE[0] ?? this.instant) : null;
          return;
        }
        const ownServed = [...i.node.served].some(b => b.heldBy === this.instant && b.value instanceof PendingVal);
        const openPlain = [...i.node.taint].filter(c => c !== this.instant && this.openChanges.has(this.find(c)));
        const plainHeld = ownServed || openPlain.length > 0 || i.node.taint.has(this.instant) || (v instanceof PendingVal && i.node.served.size > 0);
        if (i.node.lane && !plainHeld && !(v instanceof PendingVal)) {                                                     // H-7: a pure lane reader never holds the instant
          i.node.heldOn = null;
          if (i.shown === null && [...i.node.lanes].some(l => this.heldLanes.has(l))) {                                   // D-25: mounted mid-hold: shows the committed world
            this.committedView = true; i.node.evaluated = false; i.node.state = "dirty";
            try { i.shown = fmt(this.pull(i.node)); } finally { this.committedView = false; i.node.evaluated = false; i.node.state = "dirty"; }
          }
          return;
        }
        if (i.node.lane && v instanceof PendingVal && !plainHeld && this.committedOnce && i.shown !== null) {              // pending only through the lane (at the mount there is no committed world to show: the reader is the mount's — H-7). A reader that has never shown anything has no display to keep: its read throws and holds the pass like a plain one (Solid D-25, S-solid-39)
          i.node.heldOn = null;
          const lb = nearest(boundary, "loading"); if (lb && lb.armed) lb.caught.push(i.node); else for (const l of i.node.lanes) this.heldLanes.add(l);
          return;
        }
        // changes this reader consumes that are already held (its own instant's fresh writes are not held yet)
        const open = [...i.node.taint].filter(c => c !== this.instant && this.openChanges.has(this.find(c)));
        const entangles = i.node.taint.has(this.instant) || i.node.triggered;                                              // consumed this instant's writes, or this instant's writes caused the pass (D-4)
        const join = () => {                                                                                               // the changes this reader consumes become one (D-4); the current instant joins only if entangled
          for (const c of open) this.union(open[0], c);
          if (entangles || open.length === 0) { if (open.length) this.union(this.instant, open[0]); return this.find(this.instant); }
          return this.find(open[0]);
        };
        if (v instanceof PendingVal) {
          const eb = erroredShowing(boundary); if (eb) { eb.stillWaiting = true; i.node.heldOn = null; return; }   // pending is not an answer
          const lb = nearest(boundary, "loading");
          if (lb && lb.armed) { lb.caught.push(i.node); i.node.heldOn = null; return; }                                   // H-5: caught, holds nothing
          i.node.heldOn = join(); holding.push(i.node); return;                                                            // H-4 / H-6
        }
        if (open.length > 0) {
          const lb = nearest(boundary, "loading");
          if (lb && lb.armed && !i.node.hasCommitted) { lb.caught.push(i.node); i.node.heldOn = null; return; }           // D-12: a fresh boundary catches a born-held read
          i.node.heldOn = join(); return;                                                                                  // derived from a held change: reveals with it, holds nothing (H-8, D-1)
        }
        if (i.node.taint.has(this.instant)) {                                                                              // consumed this instant's writes: shows at its commit (F-2)
          const lb = nearest(boundary, "loading");
          if (lb && lb.armed && !i.node.hasCommitted) { this.bornHeldOwn.push({ reader: i.node, lb }); lb.bornCandidates++; }   // D-25: born held if this instant ends up held — decided after the hold decision
          i.node.heldOn = this.find(this.instant); return;
        }
        if (ownServed) { i.node.heldOn = this.find(this.instant); holding.push(i.node); i.shown = fmt(v); return; }        // served this change's own flight: publishes committed-derived text, holds the change (S-solid-27)
        i.node.heldOn = null; i.shown = fmt(v); return;                                                                    // only committed / served values: shows now (Solid D-3)
      }
      case "el": { for (const a of i.attrs) this.pull(a.node); for (const c of i.children) this.settleItem(c, holding, boundary); return; }
      case "mif": {
        const c = this.pull(i.cond);
        if (isErr(c)) { this.erroredControl(i.cond, c, boundary); if (i.inflight) this.settle(i.inflight.inst, holding, boundary); return; }   // H-12: an errored condition is a failed reader — its boundary takes it; the branch stays (found by S-ai2-settings)
        const want = c instanceof PendingVal ? (i.inflight?.branch ?? null) : (c ? "t" : "f");
        if (want === null) { this.holdPending(i.cond, holding, boundary); return; }
        if (i.inflight?.branch !== want) {
          if (i.inflight && i.inflight !== i.committed) i.inflight.inst.region.dispose();   // an uncommitted branch is replaced
          const existing = i.committed?.branch === want ? i.committed : null;
          if (existing) i.inflight = existing;
          else {
            const r = new Region(i.region, this);
            if (want === "t" && i.m.c.k === "id") { const b = i.region.lookup(i.m.c.name); if (b) r.scope.set(i.m.c.name, b); }   // RG-1c
            this.declare(want === "t" ? i.m.tDecls : i.m.fDecls, r);
            i.inflight = { branch: want, inst: this.instantiate(want === "t" ? i.m.t : i.m.f, r), openedBy: this.instant };
          }
        }
        this.settle(i.inflight!.inst, holding, boundary);
        return;
      }
      case "mfor": {
        const xs = this.pull(i.xs);
        if (xs instanceof PendingVal) { this.holdPending(i.xs, holding, boundary); return; }
        if (isErr(xs)) { this.erroredControl(i.xs, xs, boundary); for (const r of i.inflightRows) this.settle(r.inst, holding, boundary); return; }   // H-12, as for `if` (found by S-ai2-tracker)
        const arr = Array.isArray(xs) ? xs : [];
        const pool = new Map<unknown, Row[]>();
        for (const r of new Set([...i.committedRows, ...i.inflightRows])) { const l = pool.get(r.elem) ?? []; l.push(r); pool.set(r.elem, l); }
        const rows: Row[] = [];
        for (const elem of arr) {
          const reuse = pool.get(elem)?.shift();
          if (reuse) { rows.push(reuse); continue; }
          const r = new Region(i.region, this); r.scope.set(i.m.name, { constant: elem });   // RG-2b
          this.declare(i.m.decls, r);                                                        // RG-2c
          rows.push({ elem, region: r, inst: this.instantiate(i.m.body, r) });
        }
        for (const l of pool.values()) for (const r of l) if (!i.committedRows.includes(r)) r.region.dispose();   // uncommitted rows dropped now
        if (rows.length !== i.inflightRows.length || rows.some((r, k) => r !== i.inflightRows[k])) i.rowsOpenedBy = this.instant;
        i.inflightRows = rows;
        for (const r of rows) this.settle(r.inst, holding, boundary);
        return;
      }
      case "loading": {
        if (i.onNode) { this.pull(i.onNode); if (i.onNode.changed && !i.armed) { i.armed = true; i.armedBy = this.instant; } }   // H-6: a change to what `on` reads re-arms; the fallback belongs to this change's frame (H-5)
        i.caught = []; i.bornCandidates = 0;
        this.settle(i.content, holding, i);
        if (i.armed) { i.showingFallback = i.caught.length > 0 || i.bornCandidates > 0; if (!i.showingFallback) i.armed = false; }   // H-5: catch; disarm when ready (born-held candidates keep it armed until the hold is decided)
        if (i.showingFallback) this.settle(i.fallback, holding, boundary);
        return;
      }
      case "errored": {
        i.caught = []; i.stillWaiting = false;
        const was = i.showingFallback;
        this.settle(i.content, holding, i);
        i.showingFallback = i.caught.length > 0 || (i.showingFallback && i.stillWaiting);   // H-12: fallback until a new *answer* (D-41)
        if (i.showingFallback !== was) {                                                      // D-41: the change belongs to the frame of the answer that caused it
          const owners = (i.caught.length ? i.caught : this.contentReaders(i.content)).flatMap(r => [...r.taint]).filter(t => this.openChanges.has(this.find(t)) || t === this.instant);
          i.armedBy = owners.length ? owners[0] : this.instant;
        }
        if (i.showingFallback) this.settle(i.fallback, holding, boundary);
        return;
      }
    }
  }
  /** An errored control reader (`if`/`for`) is caught exactly as an errored read is (H-12, D-41). */
  private erroredControl(node: Node, v: ErrVal, boundary: BoundaryItem | null) {
    const eb = catching(boundary, v.err); if (eb) eb.caught.push(node);
    const openE = [...node.taint].filter(c => c !== this.instant && this.openChanges.has(this.find(c)));
    node.heldOn = openE.length || node.taint.has(this.instant) ? this.find(openE[0] ?? this.instant) : null;
  }
  /** A pending control reader (`if`/`for`) holds or is caught exactly as a pending read is (H-4, H-5). */
  private holdPending(node: Node, holding: Node[], boundary: BoundaryItem | null) {
    const eb = erroredShowing(boundary); const above = eb ? armedAbove(eb) : null; if (above) { above.caught.push(node); node.heldOn = null; return; }
    if (eb) { eb.stillWaiting = true; node.heldOn = null; return; }
    const lb = nearest(boundary, "loading"); if (lb && lb.armed) { lb.caught.push(node); node.heldOn = null; return; }
    const open = [...node.taint].filter(c => c !== this.instant && this.openChanges.has(this.find(c)));
    for (const c of open) this.union(open[0], c);
    if (node.taint.has(this.instant) || node.triggered || open.length === 0) { if (open.length) this.union(this.instant, open[0]); node.heldOn = this.find(this.instant); } else node.heldOn = this.find(open[0]);
    holding.push(node);
  }
  private commit(v: ViewInst, g: number | null) { for (const i of v.items) this.commitItem(i, g); }
  private commitItem(i: VItem, g: number | null) {
    switch (i.k) {
      case "text": return;
      case "comp": return this.commit(i.inst, g);
      case "read": {
        const val = i.node.value;
        if (val instanceof ViewValue) { this.commit(val, g); i.shown = null; return; }
        if (i.node.heldOn !== null) return;                             // still held on another group: keeps what it showed
        if (i.node.lane && this.laneHeld(i.node)) return;   // H-7: its lane is held: keeps what it showed
        if (val instanceof PendingVal) { i.shown = i.shown ?? ""; } else i.shown = fmt(val); return;
      }
      case "el": { for (const c of i.children) this.commitItem(c, g); return; }
      case "mif": {
        if (i.inflight !== i.committed && i.inflight && (g === null || this.find(i.inflight.openedBy) === g)) { i.committed?.inst.region.dispose(); i.committed = i.inflight; }
        if (i.committed) this.commit(i.committed.inst, g); return;
      }
      case "mfor": {
        if (g === null || this.find(i.rowsOpenedBy) === g) { for (const r of i.committedRows) if (!i.inflightRows.includes(r)) r.region.dispose(); i.committedRows = i.inflightRows; }
        for (const r of i.committedRows) this.commit(r.inst, g); return;
      }
      case "loading": case "errored": {
        if (g === null) i.laneAttached = true;
        if (g === null || this.find(i.armedBy) === g || !this.openChanges.has(this.find(i.armedBy))) i.committedFallback = i.showingFallback;   // H-5 / D-41: the fallback moves with the frame of the change that armed it
        this.commit(i.content, g); this.commit(i.fallback, g); return;
      }
    }
  }
  private portalOut: string[] = [];
  private renderCommitted(v: ViewInst): string { return v.items.map(i => this.renderItem(i)).join(""); }
  private renderItem(i: VItem): string {
    switch (i.k) {
      case "text": return i.s;
      case "comp": if (i.portal) { this.portalOut.push(this.renderCommitted(i.inst)); return ""; } return this.renderCommitted(i.inst);
      case "read": { const val = i.node.value; if (val instanceof ViewValue) return this.renderCommitted(val); return i.shown ?? ""; }
      case "el": return i.children.map(c => this.renderItem(c)).join("");
      case "mif": return i.committed ? this.renderCommitted(i.committed.inst) : "";
      case "mfor": return i.committedRows.map(r => this.renderCommitted(r.inst)).join("");
      case "loading": case "errored": return i.committedFallback ? this.renderCommitted(i.fallback) : this.renderCommitted(i.content);
    }
  }
  private contentReaders(v: ViewInst): Node[] {
    const out: Node[] = [];
    const walk = (i: VItem) => { switch (i.k) { case "read": out.push(i.node); if (i.node.value instanceof ViewValue) v2(i.node.value); break; case "el": i.children.forEach(walk); break; case "comp": v2(i.inst); break; case "mif": if (i.inflight) v2(i.inflight.inst); break; case "mfor": i.inflightRows.forEach(r => v2(r.inst)); break; case "loading": case "errored": v2(i.content); break; } };
    const v2 = (x: ViewInst) => x.items.forEach(walk); v2(v); return out;
  }
  /** D-1 (decision 4 of #4695): a mount whose content read a held value plainly, with no boundary catching it, is born held. */
  private bornHeld(v: ViewInst): boolean {
    const walk = (i: VItem): boolean => { switch (i.k) {
      case "read": return i.node.heldOn !== null || (i.node.value instanceof ViewValue && this.bornHeld(i.node.value));
      case "el": return i.children.some(walk); case "comp": return this.bornHeld(i.inst);
      case "mif": return !!i.inflight && this.bornHeld(i.inflight.inst); case "mfor": return i.inflightRows.some(r => this.bornHeld(r.inst));
      case "loading": return !i.armed && this.bornHeld(i.content);   // an armed boundary catches what is born held under it (D-12)
      case "errored": return this.bornHeld(i.content);
      default: return false; } };
    return v.items.some(walk);
  }
  /** H-7: during a hold, lane readers in the committed structure show σ′ unless their own lane is pending. */
  private patchLanes(v: ViewInst) { for (const i of v.items) this.patchItem(i); }
  private patchItem(i: VItem) {
    switch (i.k) {
      case "read": { if (i.node.value instanceof ViewValue) return this.patchLanes(i.node.value);   // children rendered by a component (found by S-app-shop)
        if (i.node.lane && i.node.heldOn === null && !(i.node.value instanceof PendingVal) && !this.laneHeld(i.node)) i.shown = fmt(i.node.value); return; }
      case "el": { for (const c of i.children) this.patchItem(c); return; }
      case "comp": return this.patchLanes(i.inst);
      case "mif": {
        if (i.cond.lane && i.inflight !== i.committed && i.inflight && ![...i.cond.lanes].some(l => this.heldLanes.has(l)) && !this.bornHeld(i.inflight.inst)) {   // D-25: a verdict-opened branch is a mainline mount: attaches now — unless its content is born held (D-1, decision 4 of #4695; S-solid-46): then the old arm stays until the landing
          i.committed?.inst.region.dispose(); i.committed = i.inflight; this.commit(i.committed.inst, null);
        }
        if (i.committed) this.patchLanes(i.committed.inst); return;
      }
      case "mfor": {
        if (i.xs.lane && ![...i.xs.lanes].some(l => this.heldLanes.has(l) || this.frozen(l)) && (i.inflightRows.length !== i.committedRows.length || i.inflightRows.some((r, k) => r !== i.committedRows[k])) && !i.inflightRows.some(r => !i.committedRows.includes(r) && this.bornHeld(r.inst))) {   // D-25 for rows: a lane-opened row set is a mainline mount, unless a fresh row is born held
          for (const r of i.committedRows) if (!i.inflightRows.includes(r)) r.region.dispose();
          const fresh = i.inflightRows.filter(r => !i.committedRows.includes(r)); i.committedRows = i.inflightRows;
          for (const r of fresh) this.commit(r.inst, null);
        }
        for (const r of i.committedRows) this.patchLanes(r.inst); return;
      }
      case "loading": case "errored": {
        // D-17: `on` read a probe → the fallback shows now; otherwise the display follows settle once nothing under it is held on an open change
        if ((i.k === "loading" && i.onNode?.lane && this.onAhead(i.onNode)) || i.laneAttached || !this.openChanges.has(this.find(i.armedBy))) i.committedFallback = i.showingFallback;
        this.patchLanes(i.content); if (i.committedFallback) this.patchLanes(i.fallback); return;
      }
      case "text": return;
    }
  }

  // ---- invalidation / pull (E-3, E-6, E-8) ----
  private notify(t: Target, key: string) { for (const s of this.subs.get(t)?.get(key) ?? []) this.markDirty(s); }
  unsubscribe(n: Node, clear = true) { for (const [t, ks] of n.deps) for (const k of ks) this.subs.get(t)?.get(k)?.delete(n); if (clear) n.deps.clear(); }
  private subscribe(n: Node) { for (const [t, ks] of n.deps) for (const k of ks) { let m = this.subs.get(t); if (!m) this.subs.set(t, (m = new Map())); let st = m.get(k); if (!st) m.set(k, (st = new Set())); st.add(n); } }
  private markDirty(m: Node, st: "dirty" | "check" = "dirty") {
    const rank = { clean: 0, check: 1, dirty: 2 } as const;
    if (rank[m.state] >= rank[st]) return;
    m.state = st; m.evaluated = false;                                  // may be re-pulled within the same instant (second settle pass)
    for (const s of this.subs.get(m)?.get("") ?? []) this.markDirty(s, "check");
  }
  pull(n: Node): unknown {
    if (n.kind === "source") { n.taint = n.heldBy !== null ? new Set([n.heldBy]) : new Set(); return this.demandMode ? n.value : (n.hasCommitted ? n.committed : n.value); }   // H-10: snapshots see σ
    if (!this.demandMode) return this.transient(n);
    n.demanded = true;
    if (n.evaluated) return n.value;
    let recompute = !n.hasValue || n.state === "dirty";
    const notified = n.state !== "clean" || !n.hasValue;
    if (n.kind === "reader" && (n.heldOn !== null || n.value instanceof PendingVal || n.served.size > 0)) recompute = true;   // a held or served display re-runs its pass each instant
    if (!recompute) {
      n.taint = new Set(); n.plainTaint = new Set();
      for (const d of n.deps.keys()) if (d instanceof Node) { this.pull(d); if (n.taintFrom.has(d)) for (const t of (d.lane ? d.plainTaint : d.taint)) { n.taint.add(t); n.plainTaint.add(t); }   /* only what the last pass took taint from: a probe's target is the lane's, not the instant's (F-6; found by S-solid-28) */ if (n.state === "check" && d.changed) { recompute = true; break; } }
      if (!recompute && n.state === "check") recompute = true;
    }
    if (process.env.RS_TRACE_PULL) console.log(`  pull ${n.name}#${n.id} state=${n.state} recompute=${recompute} evaluated=${n.evaluated} value=${fmt(n.value)}`);
    if (recompute) {
      const oldDeps = new Map([...n.deps].map(([t, ks]) => [t, new Set(ks)] as const));
      this.unsubscribe(n);
      const prevTracking = this.tracking; this.tracking = n; const prevFlight = n.flight;
      n.triggered = notified;
      let v: unknown;
      n.screenFor = null;
      for (;;) {
        n.lane = false; n.lanes = new Set(); n.inLanes = new Set(); n.flight = null; n.taint = new Set(); n.plainTaint = new Set(); n.taintFrom = new Set(); n.served = new Set(); n.probed = new Set(); n.plainAhead = new Set();
        try { v = n.compute!(this); } catch (e) { if (e instanceof RuleError) throw e; v = new ErrVal(e); }
        // R-11 (Solid D-25, decision 1 of #4695): posture is per read. A plain read of a node this same pass also read ahead is
        // the screen's (`[x, pending? x]` in an equation is `[committed, true]` now, either order: Solid S-27's memo case). The pass
        // learns what it probes only by running, so a pass that did both is run once more with those nodes on the screen.
        if (n.screenFor || n.kind !== "eq" || ![...n.plainAhead].some(b => n.probed.has(b))) break;
        n.screenFor = new Set(n.probed); this.unsubscribe(n);
      }
      this.tracking = prevTracking;
      const landed = n.landing && !(v instanceof PendingVal); n.landing = false;   // a new answer, even one equal to the truth the guess was made over: it is compared with the guess (D-34)
      this.subscribe(n);
      if (n.deferred && n.answered && v instanceof PendingVal) { n.lagging = true; v = n.value; }   // D-40: a declared-lag re-ask keeps showing its last answer
      else if (n.deferred) n.lagging = false;
      if (n.quiet && v instanceof PendingVal && n.answered) v = n.value;                              // AC-4: a quiet re-ask reveals silently; nothing pends
      else if (n.quiet && !(v instanceof PendingVal)) { if (n.refreshBy !== null && this.groupOpen(n.refreshBy)) n.heldBy = n.refreshBy; else { n.quiet = false; n.refreshBy = null; } }   // D-31: a refresh in a hold lands into it
      if (n.keyBy && Array.isArray(v) && Array.isArray(n.value)) v = this.reconcile(n.value, v, n.keyBy);   // ST-4a: rows with the same key keep their identity and receive per-key updates
      const ch = new Set<Path>();
      if (!n.hasValue) ch.add(""); else diffPaths(n.value, v, "", ch);
      if (ch.size > 0) { if (n.hasValue) { n.prev = n.value; n.hasPrev = true; } n.value = v; n.changed = true; n.changedSinceCommit = true; }   // C-2: `pre` is the value before this change
      n.hasValue = true;
      if (n.hasGuess && !n.questionMoved && !isAbsent(v) && (ch.size > 0 || landed)) { const dg = new Set<Path>(); diffPaths(v, n.guess, "", dg); if (guessedAt(n, dg)) { for (const e of n.guessEntries) if (guessedAt({ guessPaths: [e.path] }, dg)) e.spent = true; if (n.guessEntries.some(e => !e.spent)) this.rebuildGuess(n, v); else n.guess = v; n.corrected = true; n.answerCorrected = true; } }   // D-34: a new answer different from the guess at a guessed key corrects the graph now (derivations; `latest x` of a shown guess keeps it, D-22); equal there confirms silently (the screen keeps the guess's world until the commit)
      if (!(v instanceof PendingVal)) n.answered = true;   // H-12: an error is an answer (a first load ends with it — found by S-ai2-search)
      if (n.hasGuess && n.question && notified && v instanceof PendingVal && !n.quiet && !n.guessEntries.some(e => !e.spent && this.find(e.by) === this.find(this.instant))) {   // H-11 (Solid D-34, S-44): a new question under a guess is held with the guess's hold; its answer is not the guess's truth
        for (const e of n.guessEntries) if (!e.spent && this.groupOpen(e.by)) { this.union(this.instant, e.by); n.questionMoved = true; }
      }
      if (n.kind === "eq" && notified && v instanceof PendingVal && !(n.deferred && n.answered) && !n.quiet) n.heldBy = this.instant;   // a deferred node's first load holds like any   // R-4: a pass this change triggered asked a new question; its pending belongs to this change
      if (n.heldBy !== null) n.taint.add(n.heldBy);
      // D-10: while this value is held by an open change, the committed pass's inputs stay subscribed.
      const heldNow = [...n.taint].some(t => this.openChanges.has(this.find(t)) || t === this.instant);
      if (n.kind === "eq" && heldNow) { for (const [t, ks] of [...oldDeps, ...n.kept]) { let s2 = n.kept.get(t); if (!s2) n.kept.set(t, (s2 = new Set())); for (const k of ks) s2.add(k); } }
      else n.kept.clear();
      for (const [t, ks] of n.kept) { let s2 = n.deps.get(t); if (!s2) n.deps.set(t, (s2 = new Set())); for (const k of ks) s2.add(k); }
      this.unsubscribe(n, false); this.subscribe(n);   // re-subscribe with kept inputs included
    }
    if (n.heldBy !== null) n.taint.add(n.heldBy);
    n.state = "clean"; n.evaluated = true;
    return n.value;
  }
  /** ST-4a: reconcile a new collection by key — same key: the old object, updated in place per key; new key: the new object. */
  private reconcile(old: unknown[], nu: unknown[], key: string): unknown[] {
    const byKey = new Map<unknown, Record<string, unknown>>();
    for (const o of old) if (isObj(o)) byKey.set(o[key], o);
    return nu.map(e => { if (!isObj(e)) return e; const o = byKey.get(e[key]); if (!o) return e; this.applyDiff(o, e); return o; });
  }
  private applyDiff(o: Record<string, unknown>, e: Record<string, unknown>) {
    for (const k of new Set([...Object.keys(o), ...Object.keys(e)])) {
      const a = o[k], b = e[k];
      if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) { this.applyDiff(a, b); continue; }
      if (Object.is(a, b)) continue;
      if (!(k in e)) delete o[k]; else o[k] = b;
      this.notify(o, k);
    }
    if (Array.isArray(o) && Array.isArray(e) && o.length !== e.length) { o.length = e.length; this.notify(o, "length"); }
  }
  private transient(n: Node): unknown {                                // imperative reads see σ (H-10)
    if (n.hasCommitted) return n.committed;
    const prevTracking = this.tracking; this.tracking = null;
    let v: unknown; try { v = n.compute!(this); } catch (e) { if (e instanceof RuleError) throw e; v = new ErrVal(e); }
    this.tracking = prevTracking; return v;
  }
  private track(t: Target, key: string) { if (!this.tracking || !this.demandMode) return; let s = this.tracking.deps.get(t); if (!s) this.tracking.deps.set(t, (s = new Set())); s.add(key); }
  /** E-5 (refined by S-ai2-settings): read the values of the pass being computed — a region instantiated in a change sees that
   *  change's answers — without making them inputs of the reading equation. */
  private unsubscribed<T>(f: () => T): T { const tr = this.tracking; this.tracking = null; try { return f(); } finally { this.tracking = tr; } }
  private snapshot(e: Expr, region: Region) { const dm = this.demandMode, tr = this.tracking; this.demandMode = false; this.tracking = null; try { return this.evalExpr(e, region); } finally { this.demandMode = dm; this.tracking = tr; } }
  private untracked<T>(f: () => T): T { const dm = this.demandMode, tr = this.tracking; this.demandMode = false; this.tracking = null; try { return f(); } finally { this.demandMode = dm; this.tracking = tr; } }

  // ---- expressions ----
  evalExpr(e: Expr, region: Region, env?: Map<string, unknown>): unknown { return this.ev(e, region, env); }
  private latestOfGuess = 0;                            // DV-10: evaluating `latest g` of a guess: its reads join g's lane without being held by it
  private addLane(l: Node, held = true) { const t = this.tracking!; t.lanes.add(l); if (held && !this.latestOfGuess) t.inLanes.add(l); }
  /** H-6, R-11 (Solid D-17, decision 1 of #4695): a re-arm shows its fallback now iff every held value its `on` pass read, it read
   *  ahead. A plain read of another held value — served, or derived from an open change — makes the pass the hold's work. */
  private onAhead(n: Node) {
    if ([...n.served].some(b => !n.probed.has(b))) return false;
    return ![...n.taint].some(t => t === this.instant || this.groupOpen(t));
  }
  /** H-7: a reader keeps what it showed while one of the lanes it is in is held or frozen. */
  private laneHeld(n: Node) { return [...n.inLanes].some(l => this.heldLanes.has(l) || this.frozen(l)); }
  /** A tracked read of a reactive node from reactive scope: guesses (H-11), lanes (R-10), serving (D-3), taint. */
  private readNode(b: Node): unknown {
      this.track(b, ""); const v = this.pull(b); this.probeReads?.add(b);
      if (this.authoritative && [...b.lanes].some(l => l.hasGuess)) throw NOT_YET;                   // AC-6: a derivation of a guess has no authoritative value until the guess is confirmed (D-31)
      if (b.hasGuess && this.demandMode && !this.committedView && !this.authoritative) {                                     // AC-3 / H-11: the guess is the graph's and the screen's value, display-ahead (a lane with identity b)
        if (this.tracking) { this.tracking.lane = true; this.addLane(b); }
        return b.guess;
      }
      if (b.lane && this.tracking && this.demandMode) { this.tracking.lane = true; for (const l of b.lanes) this.addLane(l, b.inLanes.has(l)); }   // R-10: lane flows through equations
      if (this.tracking && this.demandMode) {
        const held = b.heldBy !== null && (b.heldBy === this.instant || this.groupOpen(b.heldBy));
        const future = ((b.kind === "source" || b.question) && b.heldBy !== this.instant && !(b.value instanceof PendingVal)) || b.value instanceof PendingVal;   // a landed answer is consumed, not served; own writes are read
        const armed = this.tracking.kind === "reader" && nearest(this.tracking.region.boundary, "loading")?.armed;   // F-4: an armed boundary's catch beats serving
        if (this.tracking.kind === "reader" && held && future && b.hasCommitted && !armed && !this.probing && !b.lane) { this.tracking.served.add(b); return b.committed; }   // D-3: served the committed value
        if (this.probing) this.tracking.probed.add(b);
        else if (b.hasCommitted && (held || [...b.taint].some(t => t === this.instant || this.groupOpen(t)))) {
          if (this.tracking.screenFor?.has(b)) return b.committed;                                   // R-11: the plain twin of a probe in this pass reads the screen
          this.tracking.plainAhead.add(b);
        }
        if (!this.probing) { this.tracking.taintFrom.add(b); for (const t of (b.lane ? b.plainTaint : b.taint)) { this.tracking.taint.add(t); this.tracking.plainTaint.add(t); } }   // probes and lane work are the lane's, not the instant's (F-6); a lane value carries the holds of its plain reads (R-11, Solid D-25)
      }
      return v;
  }
  private nodeOf(e: Expr, region: Region, env?: Map<string, unknown>): Node | null {
    if (e.k === "id") { if (env?.has(e.name)) return null; const b = region.lookup(e.name); return b instanceof Node ? b : null; }
    if (e.k === "member" || e.k === "index") return this.nodeOf(e.o, region, env);
    if (e.k === "latest") return this.nodeOf(e.e, region, env);
    return null;
  }
  private ev(e: Expr, region: Region, env?: Map<string, unknown>): unknown {
    switch (e.k) {
      case "lit": return e.v;
      case "id": {
        if (env?.has(e.name)) return env.get(e.name);
        const b = region.lookup(e.name);
        if (!b) { if (e.name in BUILTINS) return BUILTINS[e.name]; throw new RuleError("SCOPE", `unbound ${e.name}`); }
        if ("constant" in b) return b.constant;
        if ("fn" in b) {
          if (this.isInstantiating(b.fn)) throw new RuleError("E-9", `instantiating fn ${b.fn.name} must be bound: x = ${b.fn.name}(…)`);
          const f = b.fn;
          const home = b.home;
          return (...args: unknown[]) => { const en = new Map<string, unknown>(); f.params.forEach((p, i) => en.set(p.name, args[i])); return this.evalExpr(f.tail, home, en); };   // lexical: the declaration's names, not the caller's locals
        }
        if ("comp" in b) throw new RuleError("RG-4a", `component ${b.comp.name} applied outside a view`);
        if ("action" in b) { const a = b.action, home = b.home; return Object.assign((...args: unknown[]) => { const en = new Map<string, unknown>(); if (env?.has("log")) en.set("log", env.get("log")); a.params.forEach((p, i) => en.set(p, args[i])); this.startRun(a.body, home, en, true); }, { io: true }); }   // AC-1: an action is io; its body is lexical (its declaration's names)
        { const v = this.readNode(b); if (!this.demandMode && this.currentRun && v instanceof ErrVal) throw v.err; return v; }   // R-f-7: a snapshot of an error throws it
      }
      case "member": { const v = this.ev(e.o, region, env); if (isAbsent(v)) return v; if (!isObj(v)) { if (e.opt || v == null) return undefined; return (v as any)?.[e.p]; } this.track(v, e.p); return v[e.p]; }
      case "index": { const i = this.ev(e.i, region, env); if (isAbsent(i)) return i; const v = this.ev(e.o, region, env); if (isAbsent(v)) return v; if (!isObj(v)) { if (e.opt || v == null) return undefined; return (v as any)?.[String(i)]; } this.track(v, String(i)); return v[String(i)]; }
      case "tpl": { let out = ""; for (const part of e.parts) { if (typeof part === "string") { out += part; continue; } const v = this.ev(part, region, env); if (isAbsent(v)) return v; out += fmt(v); } return out; }
      case "pre": {                                                    // C-2 (DV-5, Solid's): the value before the most recent change
        const b = region.lookup(e.name);
        if (!b || !(b instanceof Node)) throw new RuleError("C-2", `pre of non-reactive ${e.name}`);
        if (this.tracking === b || (b.question && this.tracking === b)) { if (b.hasValue && !(b.value instanceof PendingVal)) return b.value; return e.init ? this.ev(e.init, region, env) : undefined; }   // own equation: the value before this recompute (the memo's `prev`); no edge
        if (this.tracking && this.demandMode) { this.track(b, ""); this.pull(b); }                                    // another node: an input of it
        if (b.hasPrev) return b.prev;
        return e.init ? this.ev(e.init, region, env) : undefined;
      }
      case "peek": return this.demandMode ? this.unsubscribed(() => this.ev(e.e, region, env)) : this.untracked(() => this.ev(e.e, region, env));   // E-5: in reactive scope, the pass's own values with no input; imperative reads see σ (H-10)
      case "use": return this.readNode(this.provisionOf(e.name, region));   // RG-7b: the nearest provision of the context through the instantiation chain
      case "await": {                                                  // R-1, R-6, R-7
        const v = this.ev(e.e, region, env); if (isAbsent(v)) return v;
        if (!(v instanceof Flight)) return v;                          // a value: same instant, no tick
        const n = this.tracking; if (n) n.flight = v;
        const got = e.stream ? (v.state === "pending" ? null : { state: v.state, value: v.value }) : v.first;   // a plain await: the first landing only
        if (got?.state === "resolved") { if (n) n.firstPaint = false; return got.value; }
        if (got?.state === "rejected") { if (n) n.firstPaint = false; return new ErrVal(got.value); }
        if (e.init && n && !n.answered) { n.firstPaint = true; return this.ev(e.init, region, env); }
        return PENDING;
      }
      case "latest": {                                                 // R-9 probe: the value an update is moving toward, else the committed value
        const ln = this.nodeOf(e.e, region, env);
        const ahead = !!ln?.hasGuess;                                  // DV-10: `latest` of a guess reads ahead of the guess's held lane (Solid #4284)
        if (this.tracking) { this.tracking.lane = true; if (ln) { this.addLane(ln, !ahead); this.tracking.probed.add(ln); } }
        if (this.committedView && ln && ln.hasCommitted) { this.track(ln, ""); return ln.committed; }   // D-25: an outsider shows what is on screen
        if (ln && e.e.k === "id" && ln.hasGuess && ln.answerCorrected && ln.guessShown && this.frozen(ln)) { this.track(ln, ""); return ln.shownGuess; }   // D-22, D-34 (Solid decision 3; DV-19): an answer corrected the graph, but the slot still displays the guess: `latest` keeps it until the hold commits
        this.probing++; if (ahead) this.latestOfGuess++; let v: unknown; try { v = this.ev(e.e, region, env); } finally { this.probing--; if (ahead) this.latestOfGuess--; }
        if (v instanceof PendingVal && ln && ln.hasCommitted && e.e.k === "id") return ln.committed;
        if (v instanceof PendingVal && !this.demandMode) throw new Error("NotReadyError: latest of a value that has never had one");   // R-12: in imperative scope as anywhere, `latest` of a first load throws (Solid S-28, A7)
        return v;
      }
      case "pending": {                                                // R-9 / H-9 verdict
        if (this.tracking) this.tracking.lane = true;
        const n = this.nodeOf(e.e, region, env);
        if (!n) {                                                      // composite: the verdict of the reads inside it (Solid S-29)
          const prev = this.probeReads; const reads = new Set<Node>(); this.probeReads = reads;
          this.probing++; let v: unknown; try { v = this.ev(e.e, region, env); } finally { this.probing--; this.probeReads = prev; }
          if (this.tracking) for (const r of reads) this.addLane(r);
          if (v instanceof PendingVal) return true;
          return [...reads].some(r => r.value instanceof PendingVal || (r.heldBy !== null && (r.heldBy === this.instant || this.groupOpen(r.heldBy))));
        }
        if (this.tracking) { this.addLane(n); this.tracking.probed.add(n); }
        this.track(n, ""); if (n.kind !== "source") this.pull(n);     // a probe is a (lane) dependency
        if (e.e.k === "latest") return n.value instanceof PendingVal;  // the latest channel's own verdict: x's own async is up (S-solid-27)
        if (n.lagging) return true;                                    // D-40: lagging behind a new question
        if (n.firstPaint) return false;                                // R-7
        if (n.affectedBy !== null && (n.affectedBy === this.instant || this.groupOpen(n.affectedBy))) return true;   // AC-5: a declared new question
        if (n.questionMoved && n.guessEntries.some(e => this.groupOpen(e.by))) return true;   // H-9 / H-11 (Solid S-44): the new question's answer waits in the guess's hold, re-asked or not
        if (n.quiet) return false;                                     // AC-4 / D-31: a re-ask of the same question is quiet, even landed into a hold
        if (n.kind !== "source" && !n.hasCommitted && !n.answered) return this.demandMode ? PENDING : false;   // first load: no verdict (R-9 / D-23)
        const open = (c: number | null) => c !== null && (c === this.instant || this.groupOpen(c));
        if (n.value instanceof PendingVal) return true;
        if (n.hasGuess && !n.corrected && open(n.heldBy)) { const dg = new Set<Path>(); diffPaths(n.value, n.guess, "", dg); if (dg.size === 0) return false; }   // D-34: a held answer equal to the guess is a silent confirm (S-solid-34)
        if (e.e.k === "member" || e.e.k === "index") {                   // ST-2c / D-30: pending is per key — a held path write pends exactly its key
          const path: string[] = []; let x: Expr = e.e; while (x.k === "member" || x.k === "index") { path.unshift(x.k === "member" ? x.p : String(this.ev(x.i, region, env))); x = x.o; }
          if (n.changedSinceCommit && n.heldKeys.size === 0 && open(n.heldBy)) return true;   // a re-derived family: every key re-asks
          for (const [k, c] of n.heldKeys) if (open(c) && (k === "" || k === path.join(".") || k.startsWith(path.join(".") + ".") || path.join(".").startsWith(k + "."))) return true;
          return false;
        }
        return open(n.heldBy);
      }
      case "if": { const c = this.ev(e.c, region, env); if (isAbsent(c)) return c; return this.ev(c ? e.t : e.f, region, env); }
      case "serverfn": { let f = this.serverFns.get(e); if (!f) this.serverFns.set(e, (f = this.serverFn({ name: this.serverNames.get(e) ?? "server fn", params: e.params, body: e.body }, region))); return f; }   // SF-1d
      case "throw": { const v = this.ev(e.e, region, env); if (isAbsent(v)) return v; throw v; }   // R-f-3: in reactive scope the equation's value is the error (E-12)
      case "catch": {                                                  // R-f-4: a matching failure becomes a value; pending and other failures pass
        let v: unknown; try { v = this.ev(e.e, region, env); } catch (err) { if (err instanceof RuleError) throw err; v = new ErrVal(err); }
        if (!(v instanceof ErrVal)) return v;
        if (!isA(v.err, this.classValues(e.classes, region))) { if (this.demandMode) return v; throw v.err; }
        const en = new Map(env); if (e.name) en.set(e.name, v.err);
        return this.ev(e.alt, region, en);
      }
      case "un": { const v = this.ev(e.e, region, env); if (isAbsent(v)) return v; return e.op === "!" ? !v : -(v as number); }
      case "bin": {                                                    // R-5: inputs are static — an absent operand does not erase the others
        const l = this.ev(e.l, region, env);
        if (e.op === "&&") { if (isAbsent(l)) return l; return l ? this.ev(e.r, region, env) : l; }
        if (e.op === "||") { if (isAbsent(l)) return l; return l ? l : this.ev(e.r, region, env); }
        if (e.op === "??") { if (isAbsent(l)) return l; return l != null ? l : this.ev(e.r, region, env); }
        const r = this.ev(e.r, region, env);
        if (isAbsent(l)) return l; if (isAbsent(r)) return r;
        return BIN[e.op](l, r);
      }
      case "arr": { const items: unknown[] = []; let bad: unknown; for (const i of e.items) { if (i.k === "spread") { const v = this.ev(i.e, region, env); if (isAbsent(v)) bad ??= v; else items.push(...(v as unknown[])); } else { const v = this.ev(i, region, env); if (isAbsent(v)) bad ??= v; items.push(v); } } return bad ?? items; }
      case "spread": throw new RuleError("SYNTAX", "spread outside an array literal");
      case "omit": { const v = this.ev(e.e, region, env); if (isAbsent(v)) return v; const o: Record<string, unknown> = {}; if (isObj(v)) for (const k of Object.keys(v)) if (!e.keys.includes(k)) { this.track(v, k); o[k] = v[k]; } return o; }   // RG-4b: an object rest
      case "rec": { const o: Record<string, unknown> = {}; let bad: unknown; for (const f of e.fields) { if ("spread" in f) { const v = this.ev(f.spread, region, env); if (isAbsent(v)) bad ??= v; else if (isObj(v)) { for (const k of Object.keys(v)) { this.track(v, k); o[k] = v[k]; } } continue; } const v = this.ev(f.v, region, env); if (isAbsent(v)) bad ??= v; o[f.key] = v; } return bad ?? o; }
      case "draft": {                                                  // ST-3: a copy of the seed, written only along `d`, is the value
        const seed = this.ev(e.seed, region, env); if (isAbsent(seed)) return seed;
        const copied = new Set<object>();
        const cow = (o: unknown) => { const c = Array.isArray(o) ? [...o] : isObj(o) ? { ...o } : o; if (isObj(c)) copied.add(c); return c; };
        const d = cow(seed);
        const en = new Map(env); en.set("d", d);
        for (const st of e.body) {
          if (st.k === "let") en.set(st.name, this.ev(st.e, region, en));
          else if (st.k === "expr") this.ev(st.e, region, en);
          else if (st.k === "write") {
            if (st.target.name !== "d") throw new RuleError("ST-3a", `a draft block writes only its draft, not ${st.target.name}`);
            const path = st.target.path.map(p => typeof p === "string" ? p : String(this.ev(p, region, en)));
            const last = path.pop()!; let o = d as Record<string, unknown>;
            for (const k of path) { if (!copied.has(o[k] as object)) o[k] = isObj(o[k]) ? cow(o[k]) : (/^\d+$/.test(k) ? [] : {}); o = o[k] as Record<string, unknown>; }   // copy on write along the path: untouched sub-objects keep identity
            o[last] = this.ev(st.e, region, en);
          } else throw new RuleError("ST-3b", `${st.k} in a draft block`);
        }
        return d;
      }
      case "fn": {
        const imperative = !this.demandMode;                           // SC-3
        if (e.stmts) { if (!imperative) throw new RuleError("W-2", "a statement-bodied arrow in reactive scope"); const act = !!inferredAction(e.stmts); return (...args: unknown[]) => { const en = new Map(env); e.params.forEach((p, i) => en.set(p, args[i])); return this.runStmts(e.stmts!, region, en, [], act); }; }   // AC-1b: an inferred action
        return (...args: unknown[]) => {
          const en = new Map(env); e.params.forEach((p, i) => en.set(p, args[i]));
          if (!imperative) return this.ev(e.body, region, en);
          return this.untracked(() => this.ev(e.body, region, en));
        };
      }
      case "stylemap": return classMap(e.css);                      // 07 CSS-5: a constant
      case "call": {
        let f: unknown, self: unknown;
        if (e.f.k === "id" && e.f.name === "until" && !env?.has("until") && !region.lookup("until")) return this.until(e.args[0], region, env);   // AC-6
        if (e.f.k === "id" && (e.f.name === "onSettled" || e.f.name === "onFlush") && !env?.has(e.f.name) && !region.lookup(e.f.name)) return this.hook(e.f.name, e.args[0], region, env);   // EF-7, EF-8
        if (e.f.k === "member") { self = this.ev(e.f.o, region, env); if (isAbsent(self)) return self; f = self == null ? undefined : (self as any)[e.f.p]; if (isObj(self)) this.track(self, e.f.p); }   // a method call: `xs.map(f)`, TS verbatim
        else f = this.ev(e.f, region, env);
        const args = e.args.map(a => this.ev(a, region, env)); const bad = args.find(isAbsent); if (isAbsent(f)) return f;
        if (bad && this.demandMode) return bad;                        // absence propagates in reactive scope; in imperative scope an error is a value (E-12)
        if (typeof f !== "function") throw new RuleError("TYPE", "call of non-function");
        if ((f as { io?: boolean }).io && this.demandMode) throw new RuleError("IO-2", "io function called in reactive scope");
        if (f === BUILTINS.fetch) return this.flight(String(args[0]));
        return (f as (...a: unknown[]) => unknown).apply(self, args);
      }
    }
  }
  /** RG-7: a context by its name in scope (lexical) — its identity is the declaration. */
  private ctxNamed(name: string, region: Region): CtxBinding { const b = region.lookup(name); if (!b || !("context" in b)) throw new RuleError("RG-7", `${name} is not a context`); return b; }
  /** RG-7b: the nearest provision of a context above `region`, else its default. */
  private provisionOf(name: string, region: Region): Node {
    const c = this.ctxNamed(name, region);
    for (let r: Region | null = region; r; r = r.parent) { const n = r.provided.get(c); if (n) return n; }
    if (c.context.dflt) { const de = c.context.dflt; return c.dflt ??= this.mkNode("eq", `${name} (default)`, c.home, rt => rt.evalExpr(de, c.home)); }
    throw new RuleError("RG-7b", `no provision for ${name}`);
  }
  /** R-f-4: error class names → their values (a declared class, or a JS class imported); undefined: every failure. */
  classValues(names: string[] | undefined, region: Region): unknown[] | undefined {
    if (!names) return undefined;
    return names.map(n => { if (n === "Error") return Error; if (n === "Panic") return PANIC; const b = region.lookup(n); if (!b || !("constant" in b)) throw new RuleError("R-f-1", `${n} is not an error class`); return b.constant; });
  }
  flight(key: string) { let f = this.flights.get(key); if (!f) this.flights.set(key, (f = new Flight(key))); return f; }
  /** 12 SF-7b: a server function as the client sees it — every call a flight. The body runs in place, behind a wire that copies
   *  the arguments and the result (SF-6a) and lets only declared failures through (SF-6b). A `server fn` is a loader: one
   *  flight per arguments, as a JS import's (re-asked by `refresh`) when it is asked in reactive scope — a question; in
   *  imperative scope each call is a new request (SF-2). */
  private serverSeq = 0;
  private serverFns = new WeakMap<Expr, unknown>(); private serverNames = new WeakMap<Expr, string>();
  private serverFn(d: { name: string; params: string[]; body: Stmt[] }, home: Region) {
    return (...args: unknown[]) => {
      const key = `${d.name}:${args.map(fmt).join(",")}`;
      const question = this.demandMode;
      if (question && this.flights.has(key)) return this.flights.get(key)!;
      const f = question ? this.flight(key) : new Flight(`${key}#${this.serverSeq++}`);
      const fail = (msg: string): never => { throw new RuleError("WIRE_VALUE", `${d.name}: ${msg}`); };
      const env = new Map<string, unknown>(d.params.map((p, i) => [p, wireCopy(args[i], `argument ${p}`, fail)]));
      env.set("log", Object.assign((...a: unknown[]) => { this.log.push(`log(${a.map(fmt).join(", ")})`); }, { io: true }));
      this.resume({ frames: [{ stmts: d.body, i: 0, kind: "block" }], region: home, env, change: null, flight: null, action: false, bind: null, settle: { flight: f, name: d.name } });
      return f;
    };
  }
  /** A flight's answer: the nodes that asked it recompute, the runs waiting on it resume. */
  // ---- onSettled, onFlush (EF-7, EF-8; Solid's) ----
  private hook(name: "onSettled" | "onFlush", arg: Expr | undefined, region: Region, env?: Map<string, unknown>): undefined {
    if (this.demandMode) throw new RuleError("IO-2", `${name} in reactive scope`);
    if (!arg || arg.k !== "fn" || arg.params.length) throw new RuleError("HOOK_CALLBACK", `${name} takes a closure, \`${name}(() => { … })\``);
    const f = this.ev(arg, region, env ?? new Map()) as () => unknown;
    if (name === "onFlush") this.pendingFlush.push(f);
    else this.pendingSettled.push({ f, change: this.currentRun?.change ?? null });
    return undefined;
  }
  private fireSettled(f: () => unknown) { if (typeof f() === "function") throw new RuleError("SETTLED_CLEANUP_UNOWNED", "an onSettled callback returned a cleanup: there is no region to bind it to (EF-7)"); }

  // ---- until (AC-6; Solid D-31) ----
  private untils: { flight: Flight; pred: Expr; region: Region; env?: Map<string, unknown> }[] = [];
  private authoritative = false;
  private untilSeq = 0;
  /** `until(() => p)`: a flight that resolves the first time `p`, read in the authoritative view, settles truthy. */
  private until(pred: Expr | undefined, region: Region, env?: Map<string, unknown>): Flight {
    if (!pred || pred.k !== "fn" || pred.stmts) throw new RuleError("UNTIL_PREDICATE", "until takes a predicate, `until(() => e)`");
    const w = { flight: new Flight(`until#${this.untilSeq++}`), pred: pred.body, region, env };
    const r = this.untilEval(w);
    if (r) { w.flight.state = r.state; w.flight.value = r.value; w.flight.first = r; } else this.untils.push(w);
    return w.flight;
  }
  /** The predicate in the authoritative view: guesses, and what is derived from them, are invisible (a guess never confirms itself);
   *  pending is "not yet"; a failure rejects. */
  private untilEval(w: { pred: Expr; region: Region; env?: Map<string, unknown> }): { state: "resolved" | "rejected"; value: unknown } | null {
    const was = this.authoritative, dm = this.demandMode, tr = this.tracking; this.authoritative = true; this.demandMode = true; this.tracking = null;   // a live read of σ′ (staged truth reads normally), not a snapshot of σ
    try {
      const v = this.ev(w.pred, w.region, w.env);
      if (v instanceof PendingVal) return null;
      if (v instanceof ErrVal) return { state: "rejected", value: v.err };
      return v ? { state: "resolved", value: v } : null;
    } catch (e) {
      if (e === NOT_YET) return null;
      if (e instanceof RuleError) throw e;
      return { state: "rejected", value: e };
    } finally { this.authoritative = was; this.demandMode = dm; this.tracking = tr; }
  }
  private untilsFlip(): boolean {
    let any = false;
    for (const w of [...this.untils]) {
      const r = this.untilEval(w); if (!r) continue;
      this.untils = this.untils.filter(x => x !== w); any = true;
      this.answer(w.flight, r.state, r.value);
    }
    if (any) { for (const c of this.pendingJoin) this.union(this.instant, c); this.pendingJoin = []; for (const r of this.started) r.change = this.instant; this.started = []; }
    return any;
  }
  private answer(f: Flight, state: "resolved" | "rejected", value: unknown) {
    f.state = state; f.value = value; f.first ??= { state, value };
    for (const n of this.allNodes()) if (n.flight === f) { n.landing = true; this.markDirty(n); }   // landing: the next pass of n is this answer's (D-34)
    const resumed = this.suspended.filter(r => r.flight === f); this.suspended = this.suspended.filter(r => r.flight !== f);
    for (const r of resumed) { if (r.action && r.change !== null) this.pendingJoin.push(r.change); this.resume(r); }   // AC-1: a write after an `await` is still the action's
  }

  // ---- imperative scope (SC-2) ----
  runStmts(stmts: Stmt[], region: Region, env: Map<string, unknown>, params: unknown[] = [], action = false): unknown {
    params.forEach((p, i) => env.set(`$${i}`, p));
    env.set("log", Object.assign((...a: unknown[]) => { this.log.push(`log(${a.map(fmt).join(", ")})`); }, { io: true }));
    return this.startRun(stmts, region, env, action);
  }
  /** Start an imperative run (a handler, an apply block, or an action body — AC-1); it may suspend at `await`. */
  private startRun(stmts: Stmt[], region: Region, env: Map<string, unknown>, action: boolean): unknown {
    const run: Run = { frames: [{ stmts, i: 0, kind: "block" }], region, env, change: null, flight: null, action, bind: null };
    if (action) { this.openActions.add(run); this.started.push(run); }
    return this.resume(run);
  }
  private resume(run: Run): unknown {
    return this.untracked(() => {
      const { region, env } = run;
      const prev = this.currentRun; this.currentRun = run;
      /** AC-7: unwind to the nearest `try` with a catch; none → the run ends rejected (an uncaught throw is the action's rejection, DV-2). */
      const raise = (err: unknown): boolean => {
        while (run.frames.length) {
          const f = run.frames.pop()!;
          if (f.kind === "try" && f.handler && isA(err, f.catchClasses)) { if (f.catchName) env.set(f.catchName, err); run.frames.push({ stmts: f.handler, i: 0, kind: "catch", fin: f.fin }); return true; }   // R-f-6: a typed catch takes its classes; others pass
          if (f.kind === "try" && f.fin) { run.frames.push({ stmts: f.fin, i: 0, kind: "finally" }); }   // a finally runs on the way out; the error continues after it (approximation: it runs now, then unwinding resumes)
        }
        this.endRun(run, true, err); return false;
      };
      try {
        /** AC-1 / R-f-4: a statement-level `await e catch (x: C) => alt` — a matching rejection is the statement's value. */
        const land = (bind: string | null, c: Extract<Expr, { k: "catch" }> | null | undefined, ok: boolean, v: unknown): boolean => {
          if (!ok && !(c && isA(v, this.classValues(c.classes, region)))) return raise(v);
          let val = v;
          if (!ok) { const en = new Map(env); if (c!.name) en.set(c!.name, v); val = this.ev(c!.alt, region, en); }
          if (bind) env.set(bind, val); else run.result = val;
          return true;
        };
        if (run.flight) {                                                  // resuming after `await`
          const f = run.flight; const bind = run.bind, c = run.caught; run.flight = null; run.bind = null; run.caught = null;
          if (!land(bind, c, f.state !== "rejected", f.value)) return undefined;
        }
        while (run.frames.length) {
          const f = run.frames[run.frames.length - 1];
          if (f.i >= f.stmts.length) {                                     // a block ended
            run.frames.pop();
            if ((f.kind === "try" || f.kind === "catch") && f.fin) run.frames.push({ stmts: f.fin, i: 0, kind: "finally" });
            continue;
          }
          const s = f.stmts[f.i++];
          try {
            const top = s.k === "let" || s.k === "expr" ? s.e : null;
            const caught = top?.k === "catch" && top.e.k === "await" ? top : null;
            const awaited = top?.k === "await" ? top : caught ? caught.e as Extract<Expr, { k: "await" }> : null;
            if (awaited) {                                                 // statement-level await (AC-1), with its catch: suspend the run on a pending flight
              const bind = s.k === "let" ? s.name : null;
              let v: unknown;
              try { v = this.ev(awaited.e, region, env); } catch (err) { if (err instanceof RuleError) throw err; if (!land(bind, caught, false, err)) return undefined; continue; }
              if (v instanceof Flight && v.state === "pending") { run.flight = v; run.bind = bind; run.caught = caught; this.suspended.push(run); return undefined; }
              if (!land(bind, caught, !(v instanceof Flight && v.state === "rejected"), v instanceof Flight ? v.value : v)) return undefined;
              continue;
            }
            if (s.k === "let") env.set(s.name, this.ev(s.e, region, env));
            else if (s.k === "expr") run.result = this.ev(s.e, region, env);
            else if (s.k === "return") { run.result = s.e ? this.ev(s.e, region, env) : undefined; run.returned = true; run.frames.length = 0; break; }
            else if (s.k === "sif") run.frames.push({ stmts: this.ev(s.c, region, env) ? s.t : s.f, i: 0, kind: "block" });
            else if (s.k === "try") run.frames.push({ stmts: s.body, i: 0, kind: "try", catchName: s.catchName, catchClasses: this.classValues(s.catchClasses, region), handler: s.handler, fin: s.fin });
            else if (s.k === "throw") { if (!raise(this.ev(s.e, region, env))) return undefined; }
            else this.resumeStmtOnly(s, region, env);
          } catch (e) {
            if (e instanceof RuleError) throw e;
            if (!raise(e)) return undefined;                               // a thrown error in imperative code is caught by an enclosing try, else rejects the run
          }
        }
        this.endRun(run, false);
        return run.result;
      } finally { this.currentRun = prev; }
    });
  }
  /** One imperative statement that neither suspends nor branches. */
  private resumeStmtOnly(s: Stmt, region: Region, env: Map<string, unknown>) {
    const run = this.currentRun ?? { action: false };
    if (s.k === "action") this.startRun(s.body, region, new Map(env), true);
    else if (s.k === "refresh") { const n = this.nodeNamed(s.name, region); if (!n || (n.kind !== "eq") || !(n.question || n.flight || n.compute)) throw new RuleError("INVALID_REFRESH_TARGET", `${s.name} has no question to re-ask`); n.refreshInAction = !!run.action; this.pendingRefresh.push(n); }
    else if (s.k === "affects") { const n = this.nodeNamed(s.name, region); if (!n) throw new RuleError("INVALID_AFFECTS_TARGET", `${s.name} is not reactive`); this.pendingAffects.push(n); }
    else if (s.k === "optimistic") {
      if (!run.action) throw new RuleError("GUESS_OUTSIDE_HOLD", "a guess outside an action body");
      const n = this.nodeNamed(s.target.name, region);
      if (!n || !(n.question || (n.kind === "eq" && !n.deferred && n.compute))) throw new RuleError("GUESS_NO_QUESTION", `${s.target.name} is not a source with a question (source x = e)`);
      const path = s.target.path.map(p => typeof p === "string" ? p : String(this.ev(p, region, env)));
      this.pendingGuesses.push({ node: n, path, value: this.ev(s.e, region, env) });
    } else if (s.k === "write") {
      let b: Binding | undefined = region.lookup(s.target.name);
      if (s.target.ctx) b = this.provisionOf(s.target.name, region);
      if (!b || !(b instanceof Node) || !(b.kind === "source" || b.question)) throw new RuleError("W-1", `write to non-source ${s.target.name}`);
      const path = s.target.path.map(p => typeof p === "string" ? p : String(this.ev(p, region, env)));
      this.pendingWrites.push({ node: b, path, value: this.ev(s.e, region, env) });
    }
  }
  private endRun(run: Run, rejected: boolean, err?: unknown) {
    if (run.settle) {                                                        // SF-6: the call's answer, across the wire
      const { flight, name } = run.settle;
      if (rejected) this.answer(flight, "rejected", wireFailure(err));
      else this.answer(flight, "resolved", wireCopy(run.returned ? run.result : undefined, "its result", msg => { throw new RuleError("WIRE_VALUE", `${name}: ${msg}`); }));
      return;
    }
    if (!run.action) return;
    this.openActions.delete(run);
    if (run.change === null) return;                                        // ended before its first instant: nothing to revert or correct
    // AC-1 (ruled 2026-10-22, DV-2): a rejection ends the body like a return — the held writes commit, the guesses
    // revert to the truth at hand (the body-end correction, D-34). Only optimistic state is provisional.
    this.pendingBodyEnds.push(this.find(run.change));
  }
  /** D-34: the body's end corrects a guess nothing authoritative is answering — by the truth at hand. */
  private bodyEndCorrections(): boolean {
    let any = false;
    for (const g0 of this.pendingBodyEnds) { const g = this.find(g0);
      for (const n of this.allNodes()) if (n.hasGuess && this.guessedBy(n, g)) {
        const truth = n.demanded ? n.value : this.pull(n);
        if (truth instanceof PendingVal || (n.quiet && n.flight?.state === "pending") || this.refreshPending(g)) continue;   // its own source is still answering — a first load or a re-ask (`refresh x`) — or the action re-asked a question the guess's truth may follow: that answer corrects (D-34, AC-4)
        const mine = n.guessEntries.filter(e => this.find(e.by) === g);
        const dg = new Set<Path>(); diffPaths(truth, n.guess, "", dg);
        if (guessedAt({ guessPaths: mine.map(e => e.path) }, dg)) {   // this action's keys differ from the truth at hand: corrected; another action's keys keep their guesses
          n.guessEntries = n.guessEntries.filter(e => this.find(e.by) !== g); this.rebuildGuess(n, truth);
          n.hasGuess = true; n.corrected = true; n.answerCorrected = false; n.guessBy = g; any = true;
        }
      }
    }
    this.pendingBodyEnds = []; return any;
  }
  /** H-11: the composite guess — the truth at hand with every live entry applied in order (a path entry copies along its path, ST-3a). */
  private rebuildGuess(n: Node, truth?: unknown) {
    let g: unknown = truth !== undefined ? truth : n.demanded ? n.value : this.pull(n);
    const copy = (o: unknown) => Array.isArray(o) ? [...o] : { ...(o as object) } as Record<string, unknown>;
    for (const e of n.guessEntries) {
      if (e.spent) continue;
      if (e.path === "") { g = e.value; continue; }
      const keys = e.path.split("."); const root = copy(g) as Record<string, unknown>; let o = root;
      for (const k of keys.slice(0, -1)) { o[k] = isObj(o[k]) ? copy(o[k]) : /^\d+$/.test(k) ? [] : {}; o = o[k] as Record<string, unknown>; }
      o[keys[keys.length - 1]] = e.value; g = root;
    }
    n.guess = g; n.guessPaths = n.guessEntries.map(e => e.path);
    if (n.guessEntries.length) { n.hasGuess = true; n.guessBy = n.guessEntries[n.guessEntries.length - 1].by; }
  }
  /** H-11: whether change `g` (a group root) made a guess on `n` that is still live. */
  private guessedBy(n: Node, g: number) { return n.guessEntries.some(e => this.find(e.by) === g); }
  /** AC-4, D-34: a re-ask issued by the action of change `g` is still answering. */
  private refreshPending(g: number) { return this.allNodes().some(n => n.quiet && n.refreshInAction && n.refreshBy !== null && this.find(n.refreshBy) === g && n.flight?.state === "pending"); }
  /** D-34: a corrected guess's readers keep what they showed until the hold commits (the lane is frozen, not held). */
  private frozen(n: Node) { return n.hasGuess && n.corrected && n.guessBy !== null && (n.guessBy === this.instant || this.groupOpen(n.guessBy)); }
  private nodeNamed(name: string, region: Region): Node | null { const b = region.lookup(name); return b instanceof Node ? b : null; }
  private virtualScope(): Region {
    const all: Region[] = []; const walk = (r: Region) => { for (const c of r.children) walk(c); all.push(r); }; walk(this.root);
    const scope = new Map<string, Binding>();
    for (const r of all) for (const [k, v] of r.scope) if (!scope.has(k)) scope.set(k, v);
    const virt = new Region(null, this, null); virt.scope = scope; return virt;
  }
  handler(stmts: Stmt[]) { this.runStmts(stmts, this.virtualScope(), new Map(), [], !!inferredAction(stmts)); const w = this.pendingWrites; this.pendingWrites = []; return this.step(w); }
  /** Scenario helper: land the flight an action run is suspended on. */
  awaitedFlights(): Flight[] { return this.suspended.map(r => r.flight!).filter(Boolean); }
  findNode(name: string): Node | null { const b = this.virtualScope().lookup(name); return b instanceof Node ? b : null; }

  // ---- view instantiation (V, RG-1, RG-2, RG-4, H-5) ----
  instantiate(m: Markup[], region: Region): ViewInst { return { region, items: m.map(x => this.inst1(x, region)) }; }
  private inst1(m: Markup, region: Region): VItem {
    switch (m.k) {
      case "text": return { k: "text", s: m.s };
      case "style": return { k: "text", s: "" };                                          // CSS-4: removed from the view
      case "portal": { const r = new Region(region, this, region.boundary); this.declare(m.decls, r); return { k: "comp", portal: true, inst: this.instantiate(m.body, r) }; }   // RG-8: owned here (its boundary, its provisions), shown elsewhere
      case "read": return { k: "read", node: this.mkNode("reader", "reader", region, rt => rt.evalExpr(m.e, region)), shown: null };
      case "el": {
        if (/^[A-Z]/.test(m.tag)) {
          const b = region.lookup(m.tag);
          if (!b || !("comp" in b)) throw new RuleError("SCOPE", `unknown component ${m.tag}`);
          const comp = b.comp; const r = new Region(region, this, region.boundary, b.home);   // owned at the application, names from the declaration (RG-7a, MO-6)
          const props: Record<string, unknown> = {};
          for (const a of m.attrs) { const node = this.mkNode("eq", `${m.tag}.${a.name}`, region, rt => rt.evalExpr(a.e, region)); Object.defineProperty(props, a.name, { enumerable: true, get: () => this.readNode(node) }); }   // a prop read is a read of the argument's node: taint, lanes, serving (found by S-fail-2)
          let children: ViewValue | null = null;                   // RG-4c: instantiated where first read — owned by the reader's region, named by the caller's
          Object.defineProperty(props, "children", { enumerable: true, get: () => { if (!children) { const owner = this.tracking?.region ?? region; const cr = new Region(owner, this, owner.boundary, region); children = new ViewValue(cr, m.children.map(c => this.inst1(c, cr))); } return children; } });
          r.scope.set(comp.props, { constant: props });
          this.declare(comp.decls, r);
          return { k: "comp", inst: { region: r, items: comp.view.map(c => this.inst1(c, r)) } };
        }
        return { k: "el", tag: m.tag, attrs: m.attrs.map(a => ({ name: a.name, node: this.mkNode("reader", a.name, region, /^on[A-Z:]/.test(a.name) ? rt => rt.untracked(() => rt.evalExpr(a.e, region)) : rt => rt.evalExpr(a.e, region)) })), children: m.children.map(c => this.inst1(c, region)) };   // 07 §5: an event handler is an imperative closure
      }
      case "mif": return { k: "mif", m, cond: this.mkNode("reader", "if", region, rt => { const c = rt.evalExpr(m.c, region); return isAbsent(c) ? c : Boolean(c); }), region, committed: null, inflight: null };
      case "mfor": return { k: "mfor", m, xs: this.mkNode("reader", "for", region, rt => rt.evalExpr(m.xs, region)), region, committedRows: [], inflightRows: [], rowsOpenedBy: 0 };
      case "loading": case "errored": {
        const item: BoundaryItem = { classes: m.k === "errored" ? this.classValues(m.classes, region) : undefined, k: m.k, m, region, parent: region.boundary, armed: true, onNode: null, fallback: null!, content: null!, showingFallback: false, committedFallback: false, caught: [], stillWaiting: false, armedBy: Math.max(this.instant, 0), laneAttached: false, bornCandidates: 0 };
        if (m.k === "loading" && m.on) item.onNode = this.mkNode("reader", "on", region, rt => rt.evalExpr(m.on!, region));
        const cr = new Region(region, this, item); this.declare(m.decls, cr);
        item.content = this.instantiate(m.body, cr);
        const fr = new Region(region, this, region.boundary);
        if (m.k === "errored" && m.errName) fr.scope.set(m.errName, this.mkNode("eq", m.errName, fr, () => { const c = item.caught[0]; const v = c?.value; return v instanceof ErrVal ? v.err : undefined; }));   // `fallback(e)`: the caught error, a value
        item.fallback = this.instantiate(m.fallback, fr);
        return item;
      }
    }
  }
  private allNodes(): Node[] { const out: Node[] = []; const walk = (r: Region) => { out.push(...r.nodes); for (const c of r.children) walk(c); }; walk(this.root); return out; }
}

export const fmt = (v: unknown): string => v instanceof ErrVal ? "#error" : v instanceof PendingVal ? "#pending" : v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v);
const BIN: Record<string, (a: any, b: any) => unknown> = {
  "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b, "/": (a, b) => a / b, "%": (a, b) => a % b,
  "==": (a, b) => a === b, "!=": (a, b) => a !== b, "<": (a, b) => a < b, ">": (a, b) => a > b, "<=": (a, b) => a <= b, ">=": (a, b) => a >= b,
};
const BUILTINS: Record<string, unknown> = {
  len: (x: unknown) => (Array.isArray(x) || typeof x === "string") ? x.length : isObj(x) ? Object.keys(x).length : 0,
  str: (x: unknown) => fmt(x),
  map: (xs: unknown[], f: (x: unknown, i: number) => unknown) => xs.map(f),
  filter: (xs: unknown[], f: (x: unknown) => unknown) => xs.filter(f),
  sum: (xs: number[]) => xs.reduce((a, b) => a + b, 0),
  fail: (msg: string) => { throw Object.assign(new Error(msg), { panic: true }); },   // R-f-3: a JS throw — a panic, not in the failure row
  every: (xs: unknown[], f: (x: unknown) => unknown) => xs.every(f),
  indexOf: (xs: unknown[], f: (x: unknown) => unknown) => xs.findIndex(f),
  fetch: (key: string) => key,   // intercepted in `call`: returns the Flight for `key`
};

function isReactive(e: Expr, region: Region): boolean { const names = new Set<string>(); freeVars(e, names); for (const n of names) if (region.lookup(n) instanceof Node) return true; return false; }
function freeVars(e: Expr, out: Set<string>) {
  switch (e.k) {
    case "id": out.add(e.name); break;
    case "pre": out.add(`pre:${e.name}`); break;
    case "peek": case "lit": break;
    case "await": freeVars(e.e, out); if (e.init) freeVars(e.init, out); break;
    case "latest": case "pending": freeVars(e.e, out); break;
    case "bin": freeVars(e.l, out); freeVars(e.r, out); break;
    case "un": freeVars(e.e, out); break;
    case "if": freeVars(e.c, out); freeVars(e.t, out); freeVars(e.f, out); break;
    case "member": freeVars(e.o, out); break;
    case "index": freeVars(e.o, out); freeVars(e.i, out); break;
    case "call": freeVars(e.f, out); e.args.forEach(a => freeVars(a, out)); break;
    case "arr": e.items.forEach(a => freeVars(a, out)); break;
    case "rec": e.fields.forEach(f => freeVars("spread" in f ? f.spread : f.v, out)); break;
    case "tpl": e.parts.forEach(p => { if (typeof p !== "string") freeVars(p, out); }); break;
    case "fn": { const o = new Set<string>(); freeVars(e.body, o); for (const st of e.stmts ?? []) if ("e" in st) freeVars(st.e, o); for (const n of o) if (!e.params.includes(n)) out.add(n); break; }
    case "spread": case "omit": freeVars(e.e, out); break;
    case "use": break;
    case "draft": { freeVars(e.seed, out); for (const st of e.body) { if (st.k === "write" || st.k === "let" || st.k === "expr" || st.k === "optimistic") freeVars(st.e, out); if (st.k === "write") for (const p of st.target.path) if (typeof p !== "string") freeVars(p, out); } out.delete("d"); break; }
  }
}
