import {
  Errored, NotReadyError, createContext, createMemo, getOwner, refresh as solidRefresh, runWithOwner, untrack, useContext,
  type Accessor, type Context, type Element, type Signal, type Store, type StoreSetter,
} from "solid-js";
import { caughtValue, isA, makeErrorClass, wireCopy, wireFailure } from "./rx/failure.ts";
import { wireCacheKey } from "./wire-key.ts";
export { createRxEffect } from "./effects.ts";
export { createPrevious } from "./previous.ts";

type Failure<Fields extends readonly string[], Args extends { [I in keyof Fields]: unknown }> = Error & {
  [I in keyof Fields as I extends `${number}` ? Fields[I] & string : never]: Args[I];
};

/** Declares an RX failure class; the message callback receives the named fields by position. */
export function defineError<const Fields extends readonly string[], Args extends unknown[] & { [I in keyof Fields]: unknown }>(
  name: string, fields: Fields, message: (...args: Args) => string,
): ((...args: Args) => Failure<Fields, Args>) & {
  cls: new (...args: Args) => Failure<Fields, Args>;
  errorClass: string;
} {
  return makeErrorClass(name, [...fields], args => message(...args as Args)) as unknown as ReturnType<typeof defineError<Fields, Args>>;
}

export function raiseFailure(error: unknown): never {
  throw error;
}

type Caught<Value, Fallback> = [Value] extends [never] ? Fallback : Value extends AsyncIterable<infer Item>
  ? AsyncIterable<Awaited<Item | Fallback>> | Fallback
  : Value extends PromiseLike<infer Item>
    ? Promise<Awaited<Item | Fallback>> | Fallback
    : Value | Fallback;

/** Maps failures in synchronous values, promises and streams, but never catches pending. */
export function catchFailure<Value, Fallback>(
  compute: () => Value, classes: readonly unknown[] | undefined, fallback: (error: unknown) => Fallback,
): Caught<Value, Fallback> {
  const list = classes?.includes(Error) ? undefined : classes && [...classes];
  return caughtValue(
    compute, error => !(error instanceof NotReadyError) && isA(error, list), fallback,
    error => error instanceof NotReadyError,
  ) as Caught<Value, Fallback>;
}

export function FailureBoundary(props: {
  classes?: readonly unknown[];
  fallback: (error: Accessor<unknown>, reset: () => void) => Element;
  children: Element;
}): Element {
  const tag = Symbol("failure-fallback");
  const out = Errored({
    get children() { return props.children; },
    fallback(error: Accessor<unknown>, reset: () => void) {
      const matched = createMemo(() => {
        const value = error();
        const classes = props.classes;
        return !(value instanceof NotReadyError) && isA(value, classes?.includes(Error) ? undefined : classes && [...classes]);
      });
      const content = createMemo(() => matched() ? untrack(() => props.fallback(error, reset)) : undefined);
      return { [tag]: { matched, content, error } };
    },
  });
  // As in the shared TypedErrored bridge, forward outside Errored: throwing in its
  // fallback strands equal-value recovery. Matching payloads do not remount content.
  return createMemo(() => {
    const value: unknown = typeof out === "function" ? (out as Accessor<unknown>)() : out;
    if (value && typeof value === "object" && tag in value) {
      const fallback = value[tag] as { matched: Accessor<boolean>; content: Accessor<Element>; error: Accessor<unknown> };
      if (!fallback.matched()) throw fallback.error();
      return fallback.content();
    }
    return value;
  }) as unknown as Element;
}

/** Structured sources carry store pairs; scalar unions keep a single Signal<T>. */
export type SourcePair<T> = [T] extends [object] ? [Store<T>, StoreSetter<T>] : Signal<T>;

export function createSourceContext<T>(): Context<SourcePair<T> | null> {
  return createContext<SourcePair<T> | null>(null);
}

export function useSourceContext<T extends object>(context: Context<[Store<T>, StoreSetter<T>] | null>): SourcePair<T>;
export function useSourceContext<T>(context: Context<Signal<T> | null>): Signal<T>;
export function useSourceContext<Pair>(context: Context<Pair | null>): Pair {
  const source = getOwner() ? useContext(context) : null;
  if (!source) throw new Error("useSourceContext requires a source context provider");
  return source;
}

type ServerBody<Args extends unknown[], Result> = (...args: Args) => Generator<unknown, Result, any>;
let requestedLoaders: Set<() => void> | undefined;
const memoLoaders = new WeakMap<object, Set<() => void>>();

/** Explicit server-loader memo: only requests made before the compute returns are recorded. */
export const createServerMemo: typeof createMemo = (compute, options) => {
  const requests = new Set<() => void>();
  const memo = createMemo(previous => {
    const outer = requestedLoaders; requestedLoaders = requests; requests.clear();
    // Solid supplies the previous value according to its seeded/unseeded overload.
    try { return (compute as (value: typeof previous) => ReturnType<typeof compute>)(previous); }
    finally { requestedLoaders = outer; }
  }, options);
  memoLoaders.set(memo, requests);
  return memo;
};

/** Evict this memo pass's loader keys, then use Solid's real refresh scheduling. */
export const refresh: typeof solidRefresh = target => {
  for (const invalidate of memoLoaders.get(target) ?? []) invalidate();
  return solidRefresh(target);
};

function serverCallable<Args extends unknown[], Result>(
  name: string, body: ServerBody<Args, Result>, loader: boolean,
): (...args: Args) => Promise<Result> {
  const flights = new Map<string, Promise<Result>>();
  return (...args) => {
    let wireError: Error | undefined;
    const fail = (message: string): never => { throw wireError = new Error(`WIRE_VALUE: ${name}: ${message}`); };
    let copied: Args, key: string;
    try {
      copied = args.map((arg, i) => wireCopy(arg, `argument ${i + 1}`, fail)) as Args;
      key = wireCacheKey(copied);
    } catch (error) { return Promise.reject(error); }
    if (loader && requestedLoaders) requestedLoaders.add(() => { flights.delete(key); });
    if (loader && flights.has(key)) return flights.get(key)!;
    const detached = <T>(work: () => T): T => runWithOwner(null, () => untrack(work));
    const request = (async () => {
      try {
        const generator = detached(() => body(...copied));
        let input: unknown, thrown = false;
        for (;;) {
          const next = detached(() => thrown ? generator.throw(input) : generator.next(input));
          if (next.done) return detached(() => wireCopy(next.value, "its result", fail)) as Result;
          try { input = await next.value; thrown = false; }
          catch (error) { input = error; thrown = true; }
        }
      } catch (error) { throw wireError && error === wireError ? error : wireFailure(error); }
    })();
    if (loader) flights.set(key, request);
    return request;
  };
}

/** In-process SF-6 wire, not HTTP. Capture/purity checks belong to the frontend.
 *  The factory cache is invalidated explicitly by createServerMemo + this module's refresh. */
export function serverFunction<Args extends unknown[], Result>(name: string, body: ServerBody<Args, Result>): (...args: Args) => Promise<Result> {
  return serverCallable(name, body, true);
}

export function serverAction<Args extends unknown[], Result>(name: string, body: ServerBody<Args, Result>): (...args: Args) => Promise<Result> {
  return serverCallable(name, body, false);
}
