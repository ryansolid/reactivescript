// Hot updates for a dependency under a dev server (the `@reactivescript/runtime/hot` entry, which the Vite front end
// imports in dev client builds only). A dependency's module is a factory over the app (09 MO-1b, 11 CP-4b `module`), so
// Solid's refresh pass finds no component at its top level to swap. This wraps the factory: its exported components
// go out as Solid's refresh proxies, and the module-level calls the factory made on `__rt` are recorded. A new version
// whose text outside its components' bodies is unchanged runs against the same app with each of those calls answered
// from the record, so it creates no module-level state (the instance stays the one MO-1b promises) and its components
// close over the first instance's sources; the proxies then render them in place. Anything else reloads the page.
import { $$component, $$registry, type Registry } from "solid-js/refresh";
import { resetErrorHalt, sharedConfig } from "solid-js";

export interface HotMeta { components: string[]; top: string; code: string }
interface ViteHot { data: Record<string, any>; invalidate(message?: string): void }
type Factory = (rt: any) => Record<string, unknown>;
type Call = { key: PropertyKey; sig: string; result: unknown };

interface Instance { rt: object; calls: Call[]; exports: Record<string, unknown>; registry: Registry }
interface State { factory: Factory; meta: HotMeta; instances: Instance[]; next?: { factory: Factory; meta: HotMeta } }

const MISMATCH = Symbol("rx-hot-mismatch");

/** A call's arguments with functions left out: a component's edit can change how a module-level source is made. */
function signature(args: unknown[]) {
  try { return JSON.stringify(args, (_, v) => typeof v === "function" ? "ƒ" : typeof v === "symbol" ? String(v) : v) ?? ""; }
  catch { return "?"; }
}

/** `__rt` as the factory sees it: while `session.mode` is "record", each call it makes (not the calls those make) is
 *  kept; while "replay", each is answered from `session.calls` in turn, and a call that differs throws `MISMATCH`. */
function tap(rt: any, session: { mode: "record" | "replay" | "live"; calls: Call[]; at: number; depth: number }) {
  return new Proxy(rt, {
    get(target, key) {
      const v = target[key];
      if (typeof v !== "function" || session.mode === "live") return v;
      return (...args: unknown[]) => {
        if (session.depth > 0) return v.apply(target, args);
        const sig = signature(args);
        if (session.mode === "replay") {
          const c = session.calls[session.at++];
          if (!c || c.key !== key || c.sig !== sig) throw MISMATCH;
          return c.result;
        }
        session.depth++;
        try {
          const result = v.apply(target, args);
          session.calls.push({ key, sig, result });
          return result;
        } finally { session.depth--; }
      };
    },
  });
}

function run(rt: object, factory: Factory, replay?: Call[]) {
  const session = { mode: replay ? "replay" as const : "record" as const, calls: replay ?? [], at: 0, depth: 0 };
  try {
    const exports = factory(tap(rt, session));
    if (replay && session.at !== replay.length) throw MISMATCH;
    return { exports, calls: session.calls };
  } finally { (session as { mode: string }).mode = "live"; }
}

const same = (a: HotMeta, b: HotMeta) => a.top === b.top && a.components.length === b.components.length && a.components.every((c, i) => c === b.components[i]);

/** The module's factory as importers call it, and what its `import.meta.hot.accept` callback runs. */
export function hotModule(hot: ViteHot | undefined, factory: Factory, meta: HotMeta) {
  if (!hot) return { factory, accept() {} };
  const state: State = hot.data.rx ??= { factory, meta, instances: [] };
  if (state.instances.length || state.meta !== meta) state.next = { factory, meta };
  const wrapped: Factory = rt => {
    // MO-1b: an importer that loads this version later still gets the app's one instance
    const had = state.instances.find(i => i.rt === rt);
    if (had) return had.exports;
    // an app mounted after an update takes the version the others now run
    const { exports, calls } = run(rt, state.factory);
    const registry = $$registry();
    const out = { ...exports };
    for (const c of state.meta.components) if (typeof out[c] === "function") out[c] = $$component(registry, c, out[c] as any);
    state.instances.push({ rt, calls, exports: out, registry });
    return out;
  };
  return {
    factory: wrapped,
    accept(mod: unknown) {
      const next = state.next;
      state.next = undefined;
      if (!mod || !next) return hot.invalidate();
      const apply = () => {
        // the same code re-run means an import changed, which the recorded top level may have read
        if (next.meta.code === state.meta.code) return hot.invalidate("[reactivescript] an import of the module changed");
        if (!same(state.meta, next.meta)) return hot.invalidate("[reactivescript] the module's top level changed");
        const swaps: [Instance, Record<string, unknown>][] = [];
        for (const inst of state.instances) {
          try { swaps.push([inst, run(inst.rt, next.factory, inst.calls).exports]); }
          catch (e) {
            if (e !== MISMATCH) console.error(e);
            return hot.invalidate(e === MISMATCH ? "[reactivescript] the module's top level changed" : "[reactivescript] the new version threw");
          }
        }
        state.factory = next.factory;
        state.meta = next.meta;
        // an earlier version that threw while rendering halted the scheduler; the swap would not run
        resetErrorHalt();
        for (const [inst, exports] of swaps) for (const c of next.meta.components) {
          const fresh = exports[c];
          if (typeof fresh === "function") inst.registry.components.get(c)?.update(() => fresh as any);
        }
      };
      if (sharedConfig.isHydrationInProgress?.()) sharedConfig.onHydrationEnd(apply); else apply();
    },
  };
}
