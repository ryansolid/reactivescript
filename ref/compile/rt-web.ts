// The browser runtime (10-server SV-3): the `__rt` API of ref/compile/rt.ts over solid-js's DOM build, so a compiled
// program can mount on a page — or hydrate one the server runtime (rt-server.ts) streamed. Views are JSX that Solid's
// compiler lowers (compile/jsx.ts, generate "dom", hydratable); what remains here is the reactive lowering, which must
// create the same owners in the same order as rt-server.ts so each takes the same hydration id on both sides.
import { Portal as WebPortal } from "@solidjs/web";
import { getObserver } from "solid-js";
import {
  createSignal, createMemo, createEffect, createOptimistic, createOptimisticStore, createStore, createProjection, createDeferred, createErrorBoundary, createContext,
  Show, For, Loading, Errored, createComponent,
  flush, untrack, latest, isPending, action, refresh, affects, until, onSettled, onFlush, NotReadyError, getOwner, runWithOwner, sharedConfig, deep,
} from "solid-js";
import { getContext, setContext, $TARGET } from "@solidjs/signals";
import { hydrate, render } from "@solidjs/web";

// 05 H-9 / Solid D-24: `isPending(fn)` judges the reads fn makes, never its return value, so `pending? x` over a structured
// value (a store, a keyed projection) reads its keys — Solid's "whole-store questions are asked through reads"
const readWhole = (v: unknown) => { if (v !== null && typeof v === "object") Reflect.ownKeys(v); return v; };
/** `latest x` (R-12) of a store is its whole value, read inside `latest` and handed out as a snapshot: a later read of a
 *  field outside `latest` would be a tracked read of the store (found by desk9-rx-7: `len(latest rows)` held a `loading on`). */
const latestWhole = (v: unknown) => v !== null && typeof v === "object" && (v as any)[$TARGET] !== undefined ? deep(v) : v;
/** EF-2: effect inputs compare as values: arrays and plain objects (a store's snapshot) by their contents. */
const sameInput = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const pa = Object.getPrototypeOf(a), plain = (p: unknown) => p === Object.prototype || p === null || p === Array.prototype;
  if (pa !== Object.getPrototypeOf(b) || !plain(pa)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameInput((a as any)[k], (b as any)[k]));
};
export { flush };
export type Acc = () => unknown;
export type Writer = { set: (v: unknown) => void; path: (keys: (string | number)[], v: unknown) => void; guess: (v: unknown, keys?: (string | number)[]) => void };
export type Entry = { get?: Acc; w?: Writer; value?: unknown };

// ---------------------------------------------------------------- values
export const ERR = { toString: () => "#error" }; export const PENDING_MARK = { toString: () => "#pending" };
export const fmt = (v: unknown): string => v === ERR ? "#error" : v === PENDING_MARK ? "#pending" : v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v);
const raw = (x: any) => (x && typeof x === "object" && x[$TARGET]) ? x[$TARGET].v : x;
/** A view: a DOM node, a function (a hole, a control-flow accessor), or an array of views — which compiled JSX mixes with
 *  its static strings. An array of strings alone is a value. */
const isNode = (v: unknown): boolean => typeof v === "function" || (typeof v === "object" && v !== null && "nodeType" in (v as object));
const isView = (v: unknown): boolean => isNode(v) || (Array.isArray(v) && (v.length === 0 || (v.every(x => x == null || typeof x === "string" || isView(x)) && v.some(x => x != null && typeof x !== "string"))));

// ---------------------------------------------------------------- failures (R-f; a copy of ref/src/failure.ts — this file is served alone)
type ErrorClass = ((...args: unknown[]) => Error) & { cls: new (...args: unknown[]) => Error; errorClass: string };
function errorClass(name: string, params: string[], message: (...args: unknown[]) => unknown, id?: string): ErrorClass {
  const C = class extends Error { constructor(...args: unknown[]) { super(""); this.name = name; params.forEach((p, i) => { (this as unknown as Record<string, unknown>)[p] = args[i]; }); this.message = String(untrack(() => message(...args))); if (id) (this as unknown as { $class: string }).$class = id; } };
  Object.defineProperty(C, "name", { value: name }); Object.defineProperty(C, "declared", { value: true });
  const f = ((...args: unknown[]) => new C(...args)) as ErrorClass; f.cls = C; f.errorClass = name; (f as { $class?: string }).$class = id; return f;
}
const PANIC = { panic: true } as const;   // R-f-10: statically discharges nothing; at run time takes whatever reaches it
/** SV-5a: a failure the server sent arrives as a plain `Error` carrying its declaration's identity (`$class`); the first
 *  test against that class gives it back its class. */
const isA = (err: unknown, classes: unknown[] | undefined): boolean => !classes || classes.includes(PANIC) || classes.some(c => {
  const k = (c as { cls?: unknown })?.cls ?? c; if (typeof k !== "function") return false;
  if (err instanceof (k as new () => unknown)) return true;
  const id = (c as { $class?: string }).$class;
  if (id && err && typeof err === "object" && (err as { $class?: string }).$class === id) { Object.setPrototypeOf(err, (k as { prototype: object }).prototype); return true; }
  return false;
});
/** `e catch (x: C) => alt`, reactive: an error boundary around the read whose fallback is the value (Solid: an errored read
 *  reaches the nearest boundary even inside a JS `try`). The fallback is decided when read, so a change of class re-decides it. */
function catchAcc(f: () => unknown, match: (err: unknown) => boolean, alt: (err: unknown) => unknown): () => unknown {
  const acc = untrack(() => createErrorBoundary(() => readWhole(f()), (err: () => unknown) => new Fallback(() => { const e0 = err(); return match(e0) ? alt(e0) : new Forward(e0); })));
  return () => unwrapFallback(acc());
}
/** Imperative scope: an ordinary try. */
function tryCatch(f: () => unknown, match: (err: unknown) => boolean, alt: (err: unknown) => unknown): unknown {
  try { return f(); } catch (err) { if (err instanceof NotReadyError || !match(err)) throw err; return alt(err); }
}
class Fallback { get: () => unknown; constructor(g: () => unknown) { this.get = g; } }
function unwrapFallback(v0: unknown): unknown { let v = v0; if (v instanceof Fallback) v = v.get(); if (v instanceof Forward) throw (v as Forward).err; return v; }
const NO_PROVISION: Entry = {};
class Forward { err: unknown; constructor(e: unknown) { this.err = e; } }

// ---------------------------------------------------------------- the wire (12 SF-6; a copy of ref/src/failure.ts's)
function wireCopy(v: unknown, where: string, fail: (msg: string) => never): unknown {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x, i) => wireCopy(x, `${where}[${i}]`, fail));
  if (typeof v === "object") { const proto = Object.getPrototypeOf(v); if (proto === Object.prototype || proto === null) { const o: Record<string, unknown> = {}; for (const k of Object.keys(v as object)) o[k] = wireCopy((v as Record<string, unknown>)[k], `${where}.${k}`, fail); return o; } }
  return fail(`${where} is ${typeof v === "function" ? "a function" : `an instance of ${(v as object).constructor?.name ?? "a class"}`}, which the wire cannot carry: send data`);
}
const wireFailure = (err: unknown): unknown => err instanceof Error && (err.constructor as { declared?: boolean }).declared ? err : new Error("Internal Server Error");

// ---------------------------------------------------------------- flights (the scenario harness's async)
/** A controllable flight: an async iterable (a stream — each resolve is a landing) that actions await through `first`. */
export class Flight {
  key: string; first: Promise<unknown>; private settleFirst!: (v: unknown) => void; private rejectFirst!: (e: unknown) => void;
  private queue: { v?: unknown; e?: unknown }[] = []; private waiters: ((x: { v?: unknown; e?: unknown }) => void)[] = []; private started = false;
  constructor(key: string) { this.key = key; this.first = new Promise((r, j) => { this.settleFirst = r; this.rejectFirst = j; }); this.first.catch(() => {}); }
  private push(x: { v?: unknown; e?: unknown }) { const w = this.waiters.shift(); if (w) w(x); else this.queue.push(x); }
  resolve(v: unknown) { if (!this.started) { this.started = true; this.settleFirst(v); } this.push({ v }); }
  reject(e: unknown) { if (!this.started) { this.started = true; this.rejectFirst(e); } this.push({ e }); }
  [Symbol.asyncIterator]() {
    const next = (): Promise<IteratorResult<unknown>> => new Promise((res, rej) => { const take = (x: { v?: unknown; e?: unknown }) => { if ("e" in x) rej(x.e); else res({ value: x.v, done: false }); }; const q = this.queue.shift(); if (q) take(q); else this.waiters.push(take); });
    return { next, return: async () => ({ value: undefined, done: true as const }) };
  }
}

// ---------------------------------------------------------------- one app instance
export function createApp(opts: { root: any; api?: Record<string, (...a: any[]) => unknown> }) {
  const flights = new Map<string, Flight>();
  const lastKey = new Map<string, string>();
  const truthOf = new Map<Acc, Acc>();                                  // an optimistic signal-form source: its guess layer -> its question
  const registry = new Map<string, Entry[]>();
  const contexts = new Map<string, ReturnType<typeof createContext<Entry | undefined>>>();
  const storeAccs = new WeakSet<object>();
  const modules = new Map<unknown, Record<string, unknown>>();
  // An equation's hoisted awaits, re-asked with it by `refresh`. They are emitted just before the equation and claimed
  // by its accessor when it registers, so a refresh reaches only its own instance's (never a disposed mount's).
  const hoistedBy = new Map<string, Acc[]>();
  const hoistedOf = new WeakMap<Acc, Acc[]>();
  const log: string[] = [];
  let currentEq: string | null = null; let serverSeq = 0; let classSeq = 0;
  const jsErrors = new Map<string, unknown>();   // MO-8: one class per declared JS error, per app
  type Ctx = { name: string; ctx: ReturnType<typeof createContext<Entry | undefined>>; dflt: (() => unknown) | null; owner: ReturnType<typeof getOwner>; dv: Entry | null };
  // During hydration Solid runs a compute under `subFetch` to learn its inputs, with `fetch` and `Promise` mocked, and keeps
  // the server's answer (SV-3b). A flight asked there is that trace, not a question: it is not registered.
  const tracing = () => { let ran = false; new Promise(() => { ran = true; }); return !ran; };
  const flight = (key: string) => { if (tracing()) return new Flight(key); let f = flights.get(key); if (!f) { f = new Flight(key); flights.set(key, f); } if (currentEq) lastKey.set(currentEq, key); return f; };
  const named = <T extends (...a: any[]) => unknown>(name: string | null, fn: T): T => (name ? ((...a: unknown[]) => { const was = currentEq; currentEq = name; try { return fn(...a); } finally { currentEq = was; } }) as T : fn);

  const app = {
    root: opts.root,
    log, flights, lastKey, asyncError: null as unknown,
    /** Mount `view` on the root: build it, or (SV-3) adopt the page the server streamed into it. */
    mount(view: () => unknown, hydrating = false) { return hydrating ? hydrate(view as never, app.root) : render(view as never, app.root); },

    // the prelude: what `import pure { … } from "./prelude"` and the built-in names refer to
    B: {
      len: (x: unknown) => (Array.isArray(x) || typeof x === "string") ? x.length : (typeof x === "object" && x) ? Object.keys(x).length : 0,
      str: (x: unknown) => fmt(x),
      map: (xs: unknown[], f: (x: unknown, i: number) => unknown) => xs.map(f),
      filter: (xs: unknown[], f: (x: unknown) => unknown) => xs.filter(f),
      sum: (xs: number[]) => xs.reduce((a, b) => a + b, 0),
      every: (xs: unknown[], f: (x: unknown) => unknown) => xs.every(f),
      indexOf: (xs: unknown[], f: (x: unknown) => unknown) => xs.findIndex(f),
      fail: (msg: string) => { throw Object.assign(new Error(msg), { panic: true }); },   // R-f-3: a JS throw — a panic, not in the failure row
      fetch: (key: string) => opts.api?.fetch ? opts.api.fetch(key) : flight(String(key)),
      log: (...a: unknown[]) => { log.push(`log(${a.map(fmt).join(", ")})`); },
    } as Record<string, any>,
    /** `import pure { f } from "./api"`: every function is a flight keyed by its name and formatted arguments. */
    /** MO-8: a class `api.d.rx` declares as an error: the real module's, or (in the harness) a stand-in `C(message)`. */
    jsError: (name: string) => jsErrors.get(name) ?? (jsErrors.set(name, (opts.api?.[name] as unknown) ?? errorClass(name, ["message"], (m?: unknown) => m ?? name, `${name}#${classSeq++}`)), jsErrors.get(name)),
    api: (name: string) => opts.api ? (opts.api[name] ?? (() => { throw new Error(`./api has no ${name}`); })) : (...a: unknown[]) => flight(`${name}:${a.map(fmt).join(",")}`),

    // ---- the scenario harness's view of names (handler rows reach any live binding by name) ----
    reg(name: string, e: Entry) { let l = registry.get(name); if (!l) registry.set(name, (l = [])); l.push(e); const h = hoistedBy.get(name); if (h && e.get) { hoistedOf.set(e.get, h); hoistedBy.delete(name); } },
    lookup(name: string): Entry { const l = registry.get(name); if (!l?.length) throw new Error(`unbound ${name}`); for (let i = l.length - 1; i >= 0; i--) if (l[i].w) return l[i]; return l[l.length - 1]; },
    dget(name: string, live = false) { const e = app.lookup(name); return e.get ? (live ? e.get() : app.snapshot(e.get)) : e.value; },   // live: inside a probe (R-12), the read itself
    dset(name: string, keys: (string | number)[], v: unknown, guess = false) { const w = app.lookup(name).w; if (!w) throw new Error(`W-1: write to non-source ${name}`); if (guess) w.guess(v, keys); else if (keys.length) w.path(keys, v); else w.set(v); },

    // ---- declarations ----
    /** `source x := e`: atomic → a signal; structured → a store behind a signal slot, so the root can be replaced (ST-1, ST-2a). */
    source(name: string, init: unknown): [Acc, Writer] {
      void name;
      if (typeof init === "object" && init !== null) {
        const [store, setStore] = createStore(init as any); const [get, set] = createSignal<unknown>(store);
        const w: Writer = {
          set: v => { if (typeof v === "function") { setStore(v as any); set(store); } else if (typeof v === "object" && v !== null) { setStore(() => v as any); set(store); } else set(v); },
          path: (keys, v) => setStore((d: any) => { let o = d; for (const k of keys.slice(0, -1)) o = o[k]; o[keys[keys.length - 1]] = v; }),
          guess: () => { throw new Error("OPTIMISTIC_NO_QUESTION"); },
        };
        return [get, w];
      }
      const [get, set] = createSignal(init);
      return [get, { set: set as (v: unknown) => void, path: () => { throw new Error("a path write to an atomic source"); }, guess: () => { throw new Error("OPTIMISTIC_NO_QUESTION"); } }];
    },
    /** `source x = e` (ST-5): createSignal(fn); with a guess written to it, a createOptimistic layer over that truth (AC-3);
     *  written or probed by path, createStore(fn, {}) whose derive writes its draft. */
    question(name: string, compute: (prev: unknown) => unknown, opts: { loadingValue?: unknown } | undefined, mode: { optimistic: boolean; structured: boolean }, key?: string): [Acc, Writer] {
      const fn = named(name, compute);
      if (mode.optimistic && mode.structured) {                        // AC-3 path targets: createOptimisticStore(fn, seed) — the derive writes its draft; the setter guesses per key
        const [store, setStore] = (createOptimisticStore as any)((draft: any) => { const r = fn(draft); if (r instanceof Flight || r instanceof Promise) return (async () => assignDraft(draft, r instanceof Flight ? await r.first : await r))(); assignDraft(draft, r); }, key ? [] : {}, key ? { key } : undefined);
        const get = () => store; storeAccs.add(get);
        const plain = () => { throw new Error("a plain write to an optimistic store is not lowered yet"); };
        return [get, { set: plain, path: plain, guess: (v, keys = []) => setStore((d: any) => { if (keys.length === 0) { assignDraft(d, typeof v === "function" ? (v as (x: unknown) => unknown)(d) : v); return; } let o = d; for (const k of keys.slice(0, -1)) o = o[k]; const last = keys[keys.length - 1]; o[last] = typeof v === "function" ? (v as (x: unknown) => unknown)(o[last]) : v; }) }];
      }
      if (mode.optimistic) {
        const [truth, setTruth] = createSignal(fn as any, opts as any);
        const [get, setGuess] = createOptimistic(() => truth());
        truthOf.set(get as Acc, truth as Acc);                            // AC-4: `refresh x` re-asks the truth, not the guess layer over it
        return [get, { set: setTruth as any, path: () => { throw new Error("optimistic path writes are not lowered yet"); }, guess: setGuess as any }];
      }
      if (mode.structured) {
        const [store, setStore] = (createStore as any)(async (draft: Record<string, unknown>) => { const r = fn(draft); const v = r instanceof Flight ? await r.first : await r; if (v && typeof v === "object") { for (const k of Object.keys(draft)) if (!(k in (v as object))) delete draft[k]; Object.assign(draft, v); } }, {});
        const get = () => store; storeAccs.add(get);
        return [get, { set: () => { throw new Error("a root write to a derived store is not lowered yet"); }, path: (keys, v) => setStore((d: any) => { let o = d; for (const k of keys.slice(0, -1)) o = o[k]; o[keys[keys.length - 1]] = v; }), guess: () => { throw new Error("optimistic over a structured question source is not lowered yet"); } }];
      }
      const [get, set] = createSignal(fn as any, opts as any);
      return [get, { set: set as any, path: () => { throw new Error("a path write to an atomic source"); }, guess: () => { throw new Error("OPTIMISTIC_NO_QUESTION"); } }];
    },
    memo: (name: string | null, fn: (prev: unknown) => unknown, opts?: { loadingValue?: unknown }): Acc => createMemo(named(name, fn) as any, opts as any) as Acc,
    deferred: (name: string, fn: (prev: unknown) => unknown, opts?: { loadingValue?: unknown }): Acc => createDeferred(named(name, fn) as any, opts as any) as Acc,
    /** `x key k = e` (ST-4): a keyed projection. */
    keyed: (name: string, key: string, fn: () => unknown): Acc => { const src = createMemo(named(name, () => fn()) as any); const p = createProjection(() => (src as Acc)() as any, [] as any, { key } as any); return () => p; },   // the answer is a memo (sync, or the tail await's); the projection reconciles it by key
    /** `x = draft(pre x -> seed) { … }` (ST-3). */
    draft: (seed: unknown, body: (d: any) => void): Acc => { const p = createProjection(body as any, seed as any); return () => p; },
    /** `pre y` of another node (C-2): a companion memo carrying (current, previous), owned where `y` is declared. */
    pre: (get: Acc): Acc => { const m = createMemo((st: any) => ({ cur: get(), prev: st ? st.cur : undefined })); return () => (m() as { prev: unknown }).prev; },
    firstPaint: (f: () => unknown) => ({ loadingValue: untrack(f) }),
    /** `effect (…) { … }`: compute, then apply; an error is an answer the apply receives (E-12); fires on a differing value (EF-2); a store enters whole, as a snapshot. */
    effect(n: number, inputs: () => unknown[], apply: (p: unknown[]) => unknown) {
      const run = (vals: unknown[]) => { const r = apply(vals); return typeof r === "function" ? (r as () => void) : undefined; };
      let last: unknown[] | null = null;
      createEffect((() => inputs().map(latestWhole)) as any, { effect: (vals: unknown[]) => { if (last && last.length === vals.length && vals.every((v, i) => sameInput(v, last![i]))) return; last = vals; return run(vals); }, error: () => { last = null; return run(Array.from({ length: n }, () => ERR)); } } as any);
    },
    /** `action f(…) { … }` (AC-1): a generator; a statement-level `await` is a hold-safe yield. */
    action(gen: (...a: unknown[]) => Generator<unknown, unknown, unknown>) {
      const run = action(gen as any) as (...a: unknown[]) => Promise<unknown>;
      return (...a: unknown[]) => { const p = run(...a); p.catch(e => { app.asyncError = e; }); return p; };
    },
    awaited: (v: unknown) => v instanceof Flight ? v.first : v,
    /** RG-8: Solid's Portal — client-only: the server renders nothing for it, the browser renders it once it has the page. */
    Portal: WebPortal,
    /** CSS-2: a dynamic class with the view's scope class after it. */
    scopedClass: (v: unknown, hash: string) => v == null || v === false || v === "" ? hash : `${v} ${hash}`,
    /** SV-7b: a client question — not asked on the server; the browser asks it once hydrated (Solid's \`ssrSource: "client"\`). */
    clientQuestion: (o?: { loadingValue?: unknown }) => ({ ...(o ?? {}), ssrSource: "client" }),
    /** 12 SF-2: a server fn as the client calls it — every call a flight. Asked in reactive scope it is a question, one
     *  flight per arguments, as a JS import's; in imperative scope each call is a new request. \`fn\` is the module-level
     *  \`"use server"\` function (SF-7a): the body in place, or — once Solid's \`transformDirectives\` has made it a reference
     *  — a request to the server. */
    serverRef(name: string, fn: (...a: unknown[]) => Promise<unknown>) {
      return (...args: unknown[]) => {
        const key = `${name}:${args.map(fmt).join(",")}`;
        const question = !!getObserver();
        if (question && flights.has(key)) return flights.get(key)!;
        const fl = question ? flight(key) : new Flight(`${key}#${serverSeq++}`);
        (globalThis as { __rx_app?: unknown }).__rx_app = app;   // the app a body run in place belongs to (it reads it once, at its start)
        let p: Promise<unknown>; try { p = Promise.resolve(fn(...args)); } catch (e) { p = Promise.reject(e); }
        p.then(v => fl.resolve(v), e => fl.reject(e));
        return fl;
      };
    },
    /** SF-6: a server fn's body (a generator, as an action's), driven by promises — not by an action: it is no change of
     *  the client's — behind a wire that copies arguments and result and lets only declared failures through. */
    serverCall(name: string, gen: (...a: unknown[]) => Generator<unknown, unknown, unknown>, args: unknown[]): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const fail = (msg: string): never => { throw new Error(`WIRE_VALUE: ${name}: ${msg}`); };
        let g: Generator<unknown, unknown, unknown>;
        try { g = gen(...args.map((a, i) => wireCopy(a, `argument ${i + 1}`, fail))); } catch (e) { reject(e); return; }
        const step = (input: unknown, thrown: boolean) => {
          const was = currentEq; currentEq = null; let r: IteratorResult<unknown, unknown>;   // the body's flights are not the asking equation's
          try { r = untrack(() => thrown ? g.throw(input) : g.next(input)); } catch (e) { reject(wireFailure(e)); return; } finally { currentEq = was; }
          if (r.done) { try { resolve(wireCopy(r.value, "its result", fail)); } catch (e) { reject(e); } return; }
          Promise.resolve(r.value).then(v => step(v, false), e => step(e, true));
        };
        step(undefined, false);
      });
    },
    hoisted(name: string, get: Acc) { let l = hoistedBy.get(name); if (!l) hoistedBy.set(name, (l = [])); l.push(get); },
    until: (p: () => unknown) => until(p),                                   // AC-6
    onSettled: (f: () => void) => onSettled(f),                             // EF-7
    onFlush: (f: () => void) => onFlush(f),                                 // EF-8
    refresh(name: string, get: Acc) { const key = lastKey.get(name); if (key) flights.delete(key); for (const h of hoistedOf.get(get) ?? []) refresh(h as any); const t = truthOf.get(get) ?? get; refresh((storeAccs.has(t) ? t() : t) as any); },
    affects: (get: Acc) => affects(get as any),
    preOr: (v: unknown, init: () => unknown) => v === undefined ? init() : v,

    // ---- modules (09 MO-1): a dependency's factory runs once per app; its exports are shared by every importer ----
    module(key: unknown, factory: (rt: unknown) => Record<string, unknown>) { let m = modules.get(key); if (!m) { m = factory(app); modules.set(key, m); } return m; },
    // ---- context (RG-7) ----
    owner: () => getOwner(),
    /** `context x: T = d` (RG-7): the declaration is the identity; `d`, if any, is evaluated once, owned where it is declared. */
    /** `context x: T = d` (RG-7): the declaration is the identity (a sentinel default: absence is ours to decide); `d` is
     *  evaluated once, owned where it is declared — created now, so it takes its id there on both sides (SV-3). */
    context(name: string, dflt: (() => unknown) | null): Ctx { return { name, ctx: createContext<Entry | undefined>(NO_PROVISION, name), dflt, owner: getOwner(), dv: dflt ? { get: createMemo(dflt as any) as Acc } : null }; },
    provide(c: Ctx, e: Entry) { setContext(c.ctx, e); },
    use(c: Ctx, owner: ReturnType<typeof getOwner>): Entry {
      const e = getContext(c.ctx, owner ?? undefined); if (e && e !== NO_PROVISION) return e;
      if (c.dv) return c.dv;
      throw new Error(`RG-7b: no provision for ${c.name}`);
    },
    useGet(c: Ctx, owner: ReturnType<typeof getOwner>) { const e = app.use(c, owner); return e.get ? e.get() : e.value; },
    runWithOwner,

    // ---- reads ----
    /** An imperative read sees σ (H-10): a pending value is a value; a snapshot of an error throws it (R-f-7). */
    snapshot(get: Acc) { try { return untrack(get); } catch (e) { if (e instanceof NotReadyError) return PENDING_MARK; throw e; } },
    // ---- failures (R-f) ----
    errorClass: (name: string, params: string[], message: (...args: unknown[]) => unknown) => errorClass(name, params, message, `${name}#${classSeq++}`),   // a declaration's identity: the same on both sides (SV-5a)
    isA, PANIC, catchMemo: catchAcc, tryCatch, catchRead: (f: () => unknown, match: (err: unknown) => boolean, alt: (err: unknown) => unknown) => catchAcc(f, match, alt)(),
    throw: (e: unknown): never => { throw e; },
    eq: (a: unknown, b: unknown) => raw(a) === raw(b),
    untrack, latest: (f: () => unknown) => latest(() => latestWhole(f())), isPending: (f: () => unknown) => isPending(() => readWhole(f())),
    fmt,

    // ---- views: compiled JSX (compile/jsx.ts, generate "dom") does the rest ----
    show: (v: unknown) => isView(v) ? v : fmt(v),
    /** `errored fallback(e: A | B)`: a failure of another class passes to the boundary above (R-f-4) — the fallback hands it out
     *  and a memo throws it there (a rethrow from the fallback itself did not recover until solidjs/solid#4277: ref/oracle/repros/dv7-rethrow.mjs). */
    TypedErrored(props: { classes: unknown[]; fallback: (err: Acc) => unknown; children: unknown }) {
      const classes = props.classes;
      const out = createComponent(Errored as any, {
        fallback: (err: Acc) => {
          const owner = getOwner(); const ok = createMemo(() => isA(err(), classes)); let shown: unknown = null;
          return new Fallback(() => ok() ? (shown ??= runWithOwner(owner, () => props.fallback(err))) : new Forward(err()));
        },
        get children() { return props.children; },
      });
      return createMemo(() => unwrapFallback(typeof out === "function" ? (out as Acc)() : out));
    },
  };
  return app;
}
export type App = ReturnType<typeof createApp>;

/** A store draft becomes `v`: keys `v` lacks are removed, the rest assigned (an array's length follows). */
function assignDraft(draft: any, v: unknown) {
  if (!v || typeof v !== "object") return;
  if (Array.isArray(draft) && Array.isArray(v)) { draft.length = v.length; v.forEach((x, i) => { draft[i] = x; }); return; }
  for (const k of Object.keys(draft)) if (!(k in (v as object))) delete draft[k];
  Object.assign(draft, v);
}
