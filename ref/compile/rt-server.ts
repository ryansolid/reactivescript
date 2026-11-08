// The server runtime (10-server): the same `__rt` API the compiled modules call (ref/compile/rt.ts), over solid-js 2.0's
// server build. What runs on the server is what the mount needs — equations, source initializers, awaits, the view —
// and nothing an instant after it would (SV-2): effects, actions and handlers do not run. The view renders to HTML
// that `renderToStream` streams, a boundary at a time. Every call mirrors rt-web.ts's (the browser runtime): the same
// solid-js primitives in the same order, so each owner, element and hole takes the id the client will look for (SV-3). A failure of a declared class (R-f-1, MO-8) is marked safe and goes
// to the client as it is; anything else that reaches a boundary — a panic, or a JS rejection of plain `Error` — goes as
// Solid's generic error (SV-5).
import { Portal as WebPortal } from "@solidjs/web";
import { getObserver } from "solid-js";
import { provideRequestEvent } from "@solidjs/web/storage";
import { Show, For, Loading, Errored, createComponent, createSignal, createMemo, createEffect, createOptimistic, createOptimisticStore, createStore, createProjection, createDeferred, untrack, latest, isPending, deep, NotReadyError, getOwner, runWithOwner, getNextChildId, runInServerComponentScope } from "solid-js";
import { escape, renderToStream, markSafeError, generateHydrationScript } from "@solidjs/web";
import { $TARGET } from "@solidjs/signals";

// 05 H-9 / Solid D-23: `isPending(fn)` judges the reads fn makes, never its return value, so `pending? x` over a structured
// value (a store, a keyed projection) reads its keys — Solid's "whole-store questions are asked through reads"
const readWhole = (v: unknown) => { if (v !== null && typeof v === "object") Reflect.ownKeys(v); return v; };
/** `latest x` (R-12) of a store is its whole value, read inside `latest` and handed out as a snapshot: a later read of a
 *  field outside `latest` would be a tracked read of the store (found by desk9-rx-7: `len(latest rows)` held a `loading on`). */
const latestWhole = (v: unknown) => v !== null && typeof v === "object" && (v as any)[$TARGET] !== undefined ? deep(v) : v;
export type Acc = () => unknown;
export type Writer = { set: (v: unknown) => void; path: (keys: (string | number)[], v: unknown) => void; guess: (v: unknown, keys?: (string | number)[]) => void };
export type Entry = { get?: Acc; w?: Writer; value?: unknown };
export { generateHydrationScript };

// ---------------------------------------------------------------- values (as rt.ts)
export const ERR = { toString: () => "#error" }; export const PENDING_MARK = { toString: () => "#pending" };
export const fmt = (v: unknown): string => v === ERR ? "#error" : v === PENDING_MARK ? "#pending" : v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v);
/** A view: an ssr() result, a function (a hole), or an array of views mixed with compiled JSX's static strings. */
const isNode = (v: unknown): boolean => typeof v === "function" || (typeof v === "object" && v !== null && "t" in (v as object));
const isView = (v: unknown): boolean => isNode(v) || (Array.isArray(v) && (v.length === 0 || (v.every(x => x == null || typeof x === "string" || isView(x)) && v.some(x => x != null && typeof x !== "string"))));
/** Take the ids a client-side owner the server has no counterpart for would take (rt-web.ts creates it; the server need not). */
const reserve = (n = 1) => { const o = getOwner() as any; if (o?.id != null) for (let i = 0; i < n; i++) getNextChildId(o); };
const onServer = (what: string) => () => { throw new Error(`SV-2: ${what} does not run on the server`); };

// ---------------------------------------------------------------- failures (R-f; SV-5: a failure is safe to send)
type ErrorClass = ((...args: unknown[]) => Error) & { cls: new (...args: unknown[]) => Error; errorClass: string };
function errorClass(name: string, params: string[], message: (...args: unknown[]) => unknown, id?: string): ErrorClass {
  const C = class extends Error { constructor(...args: unknown[]) { super(""); this.name = name; params.forEach((p, i) => { (this as unknown as Record<string, unknown>)[p] = args[i]; }); this.message = String(untrack(() => message(...args))); if (id) (this as unknown as { $class: string }).$class = id; markSafeError(this); } };
  Object.defineProperty(C, "name", { value: name }); Object.defineProperty(C, "declared", { value: true });
  const f = ((...args: unknown[]) => new C(...args)) as ErrorClass; f.cls = C; f.errorClass = name; (f as { $class?: string }).$class = id; return f;
}
const PANIC = { panic: true } as const;
const isA = (err: unknown, classes: unknown[] | undefined): boolean => !classes || classes.includes(PANIC) || classes.some(c => { const k = (c as { cls?: unknown })?.cls ?? c; return typeof k === "function" && err instanceof (k as new () => unknown); });
/** The server renders once: an errored read throws where it is read, so a catch is an ordinary try around the read. (The
 *  client's is an error boundary: its ids are reserved.) */
function catchAcc(f: () => unknown, match: (err: unknown) => boolean, alt: (err: unknown) => unknown): () => unknown {
  reserve(2);   // a client error boundary takes two ids
  return () => { try { return f(); } catch (err) { if (err instanceof NotReadyError || !match(err)) throw err; return alt(err); } };
}
function tryCatch(f: () => unknown, match: (err: unknown) => boolean, alt: (err: unknown) => unknown): unknown {
  try { return f(); } catch (err) { if (err instanceof NotReadyError || !match(err)) throw err; return alt(err); }
}

// ---------------------------------------------------------------- the wire (12 SF-6; a copy of ref/src/failure.ts's)
function wireCopy(v: unknown, where: string, fail: (msg: string) => never): unknown {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x, i) => wireCopy(x, `${where}[${i}]`, fail));
  if (typeof v === "object") { const proto = Object.getPrototypeOf(v); if (proto === Object.prototype || proto === null) { const o: Record<string, unknown> = {}; for (const k of Object.keys(v as object)) o[k] = wireCopy((v as Record<string, unknown>)[k], `${where}.${k}`, fail); return o; } }
  return fail(`${where} is ${typeof v === "function" ? "a function" : `an instance of ${(v as object).constructor?.name ?? "a class"}`}, which the wire cannot carry: send data`);
}
const wireFailure = (err: unknown): unknown => err instanceof Error && (err.constructor as { declared?: boolean }).declared ? err : new Error("Internal Server Error");

// ---------------------------------------------------------------- flights (the harness's async)
/** As rt.ts's Flight. A rejection is sent as it is only when its class is declared (SV-5): `errorClass` marks those. */
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

// ---------------------------------------------------------------- one request (SV-4: module state is per request)
type Owner = ReturnType<typeof getOwner>;
type Ctx = { name: string; id: symbol; dflt: (() => unknown) | null; owner: Owner; dv: Entry | null };

export function createApp(opts: { api?: Record<string, (...a: any[]) => unknown> } = {}) {
  const flights = new Map<string, Flight>();
  const lastKey = new Map<string, string>();
  const registry = new Map<string, Entry[]>();
  const modules = new Map<unknown, Record<string, unknown>>();
  const log: string[] = [];
  const declared: unknown[] = [];
  let currentEq: string | null = null; let serverSeq = 0; let classSeq = 0;
  const jsErrors = new Map<string, unknown>();   // MO-8: one class per declared JS error, per app
  const flight = (key: string) => { let f = flights.get(key); if (!f) { f = new Flight(key); flights.set(key, f); } if (currentEq) lastKey.set(currentEq, key); return f; };
  const named = <T extends (...a: any[]) => unknown>(name: string | null, fn: T): T => (name ? ((...a: unknown[]) => { const was = currentEq; currentEq = name; try { return fn(...a); } finally { currentEq = was; } }) as T : fn);
  const ro = (get: Acc): [Acc, Writer] => [get, { set: onServer("a write"), path: onServer("a write"), guess: onServer("a write") }];

  const app = {
    log, flights, lastKey, asyncError: null as unknown,
    /** Render `view` as a stream: `write` receives each chunk, `end` the close. */
    /** One request (a request event, as Solid's integrations provide one — a server function called during the render runs
     *  in it, SF-2b). */
    stream(view: () => unknown, sink: { write: (s: string) => void; end: () => void }) { return provideRequestEvent({ request: new Request("http://127.0.0.1/"), locals: {} }, () => renderToStream((process.env.SV_SCOPE ? () => runInServerComponentScope(view) : view) as never).pipe(sink as never)); },

    B: {
      len: (x: unknown) => (Array.isArray(x) || typeof x === "string") ? x.length : (typeof x === "object" && x) ? Object.keys(x).length : 0,
      str: (x: unknown) => fmt(x),
      map: (xs: unknown[], f: (x: unknown, i: number) => unknown) => xs.map(f),
      filter: (xs: unknown[], f: (x: unknown) => unknown) => xs.filter(f),
      sum: (xs: number[]) => xs.reduce((a, b) => a + b, 0),
      every: (xs: unknown[], f: (x: unknown) => unknown) => xs.every(f),
      indexOf: (xs: unknown[], f: (x: unknown) => unknown) => xs.findIndex(f),
      fail: (msg: string) => { throw Object.assign(new Error(msg), { panic: true }); },
      fetch: (key: string) => opts.api?.fetch ? opts.api.fetch(key) : flight(String(key)),
      log: (...a: unknown[]) => { log.push(`log(${a.map(fmt).join(", ")})`); },
    } as Record<string, any>,
    /** MO-8: a class a `.d.rx` declares — a failure the server sends as it is (SV-5). */
    jsError(name: string) { if (jsErrors.has(name)) return jsErrors.get(name); const C = (opts.api?.[name] as unknown) ?? errorClass(name, ["message"], (m?: unknown) => m ?? name, `${name}#${classSeq++}`); declared.push(C); jsErrors.set(name, C); return C; },
    /** A JS function's promise: a rejection with a declared class is marked safe to send; any other is redacted (SV-5). */
    api: (name: string) => {
      if (!opts.api) return (...a: unknown[]) => flight(`${name}:${a.map(fmt).join(",")}`);
      const f = opts.api[name] ?? (() => { throw new Error(`./api has no ${name}`); });
      return (...a: unknown[]) => { const r = f(...a); return r && typeof (r as PromiseLike<unknown>).then === "function" ? Promise.resolve(r).catch(e => { if (isA(e, declared)) markSafeError(e); throw e; }) : r; };
    },

    reg(name: string, e: Entry) { let l = registry.get(name); if (!l) registry.set(name, (l = [])); l.push(e); },
    dget(name: string) { const e = app.lookup(name); return e.get ? app.snapshot(e.get) : e.value; },
    lookup(name: string): Entry { const l = registry.get(name); if (!l?.length) { if (jsErrors.has(name)) return { value: jsErrors.get(name) }; throw new Error(`unbound ${name}`); } return l[l.length - 1]; },   // a server function's request has its module's error classes, not the page's registry

    // ---- declarations: the same primitives, from the server build. Writes do not happen on the server (SV-2). ----
    source(name: string, init: unknown): [Acc, Writer] {
      void name;
      if (typeof init === "object" && init !== null) { const [store] = createStore(init as any); const [get] = createSignal<unknown>(store); return ro(get as Acc); }
      const [get] = createSignal(init); return ro(get as Acc);
    },
    question(name: string, compute: (prev: unknown) => unknown, o: { loadingValue?: unknown } | undefined, mode: { optimistic: boolean; structured: boolean }, key?: string): [Acc, Writer] {
      const fn = named(name, compute);
      if (mode.optimistic && mode.structured) { const [store] = (createOptimisticStore as any)((draft: any) => { const r = fn(draft); if (r instanceof Flight || r instanceof Promise) return (async () => assignDraft(draft, r instanceof Flight ? await r.first : await r))(); assignDraft(draft, r); }, key ? [] : {}, key ? { key } : undefined); return ro(() => store); }
      if (mode.optimistic) { const [truth] = createSignal(fn as any, o as any); const [get] = createOptimistic(() => (truth as Acc)()); return ro(get as Acc); }
      if (mode.structured) {
        const [store] = (createStore as any)(async (draft: Record<string, unknown>) => { const r = fn(draft); const v = r instanceof Flight ? await r.first : await r; if (v && typeof v === "object") { for (const k of Object.keys(draft)) if (!(k in (v as object))) delete draft[k]; Object.assign(draft, v); } }, {});
        return ro(() => store);
      }
      const [get] = createSignal(fn as any, o as any); return ro(get as Acc);
    },
    memo: (name: string | null, fn: (prev: unknown) => unknown, o?: { loadingValue?: unknown }): Acc => createMemo(named(name, fn) as any, o as any) as Acc,
    deferred: (name: string, fn: (prev: unknown) => unknown, o?: { loadingValue?: unknown }): Acc => createDeferred(named(name, fn) as any, o as any) as Acc,
    keyed: (name: string, key: string, fn: () => unknown): Acc => { const src = createMemo(named(name, () => fn()) as any); const p = createProjection(() => (src as Acc)() as any, [] as any, { key } as any); return () => p; },
    draft: (seed: unknown, body: (d: any) => void): Acc => { const p = createProjection(body as any, seed as any); return () => p; },
    pre: (get: Acc): Acc => { const m = createMemo((st: any) => ({ cur: get(), prev: st ? st.cur : undefined })); return () => (m() as { prev: unknown }).prev; },
    firstPaint: (f: () => unknown) => ({ loadingValue: untrack(f) }),
    /** SV-2: the apply half runs on the client, after hydration. The compute half is reactive scope — Solid's server runs it;
     *  an input's failure is an answer (E-12), not a server error. */
    effect(_n: number, inputs: () => unknown[], _apply: (p: unknown[]) => unknown) {
      createEffect((() => { try { return inputs(); } catch (e) { if (e instanceof NotReadyError) throw e; return ERR; } }) as any, { effect() {}, error() {} } as any);
    },
    action(_gen: (...a: unknown[]) => Generator<unknown, unknown, unknown>) { return onServer("an action"); },
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
    hoisted(_name: string, _get: Acc) {},
    refresh: onServer("refresh"),
    affects: onServer("affects"),
    onSettled: onServer("onSettled"),                                       // EF-7: imperative scope only, and no imperative run happens here (SV-2a)
    onFlush: onServer("onFlush"),                                           // EF-8
    preOr: (v: unknown, init: () => unknown) => v === undefined ? init() : v,

    module(key: unknown, factory: (rt: unknown) => Record<string, unknown>) { let m = modules.get(key); if (!m) { m = factory(app); modules.set(key, m); } return m; },
    // ---- context (RG-7): the server build's owner context, keyed by the declaration ----
    owner: () => getOwner(),
    context(name: string, dflt: (() => unknown) | null): Ctx { return { name, id: Symbol(name), dflt, owner: getOwner(), dv: dflt ? { get: createMemo(dflt as any) as Acc } : null }; },
    provide(c: Ctx, e: Entry) { const o = getOwner() as any; o._context = { ...o._context, [c.id]: e }; },
    use(c: Ctx, owner: Owner): Entry {
      const e = ((owner ?? getOwner()) as any)?._context?.[c.id]; if (e) return e;
      if (c.dv) return c.dv;
      throw new Error(`RG-7b: no provision for ${c.name}`);
    },
    useGet(c: Ctx, owner: Owner) { const e = app.use(c, owner); return e.get ? e.get() : e.value; },
    runWithOwner,

    snapshot(get: Acc) { try { return untrack(get); } catch (e) { if (e instanceof NotReadyError) return PENDING_MARK; throw e; } },
    errorClass: (name: string, params: string[], message: (...args: unknown[]) => unknown) => errorClass(name, params, message, `${name}#${classSeq++}`),   // a declaration's identity, sent with its failures (SV-5a)
    isA, PANIC, catchMemo: catchAcc, tryCatch, catchRead: (f: () => unknown, match: (err: unknown) => boolean, alt: (err: unknown) => unknown) => catchAcc(f, match, alt)(),
    throw: (e: unknown): never => { throw e; },
    eq: (a: unknown, b: unknown) => a === b,
    untrack, latest: (f: () => unknown) => latest(() => latestWhole(f())), isPending: (f: () => unknown) => isPending(() => readWhole(f())),
    fmt,

    // ---- views: compiled JSX (compile/jsx.ts, generate "ssr", hydratable) does the rest ----
    show: (v: unknown) => isView(v) ? v : escape(fmt(v)),
    /** A failure of another class passes to the boundary above (R-f-4): on the server, a rethrow from the fallback. The
     *  client's unwrapping memo has no counterpart here: its id is reserved. */
    TypedErrored(props: { classes: unknown[]; fallback: (err: Acc) => unknown; children: unknown }) {
      const out = createComponent(Errored as any, {
        fallback: (err: Acc) => { const ok = createMemo(() => isA(err(), props.classes)); if (!ok()) throw err(); return props.fallback(err); },
        get children() { return props.children; },
      });
      reserve();
      return out;
    },
  };
  return app;
}
export type ServerApp = ReturnType<typeof createApp>;

/** A store draft becomes `v`: keys `v` lacks are removed, the rest assigned (an array's length follows). */
function assignDraft(draft: any, v: unknown) {
  if (!v || typeof v !== "object") return;
  if (Array.isArray(draft) && Array.isArray(v)) { draft.length = v.length; v.forEach((x, i) => { draft[i] = x; }); return; }
  for (const k of Object.keys(draft)) if (!(k in (v as object))) delete draft[k];
  Object.assign(draft, v);
}
