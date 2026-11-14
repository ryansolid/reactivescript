// ReactiveScript's forms, as TypeScript sees them (types/project.ts)
import type { JSX } from "@solidjs/web/jsx-runtime";
export declare function await_<T>(v: T): Awaited<T>;
export declare function awaitS<T>(v: T): T extends AsyncIterable<infer U> ? U : Awaited<T>;
/** R-1: Solid's memo consumes a promise or a stream its function returns, so an equation's value is never one — `await` says
 *  where it enters (`any`: not known here; Solid still consumes it). */
type Async<T> = 0 extends (1 & T) ? false : true extends (T extends PromiseLike<any> | AsyncIterable<any> ? true : false) ? true : false;
export declare function eq<T>(v: T, ok: Async<T> extends true ? "MISSING_AWAIT: an equation's value is a promise or a stream, which Solid consumes; write await e (or await* e for a stream)" : true): T;
export declare function first<T, I>(v: T, init: I): T | I;
export declare function pre<T>(init?: T): T;
export declare function pending(v: unknown): boolean;
/** RG-4b: an object rest, `{ a, ...rest } = e` (Solid's `omit`). */
export declare function omit<T, K extends string>(v: T, ...keys: K[]): Omit<T, K>;
export declare function caught<T, R>(v: T, alt: (e: any) => R): T | R;
export declare function raise(e: unknown): never;
/** W-1/W-6: a write checks its value (or its function of the slot) against the target — whose type alone decides it. */
export declare function set<T>(target: T): (v: T | ((p: T) => T)) => void;
/** A source's type when none is written: its initializer's, widened — a source is written later (`""` is a string,
 *  `null` and `[]` say nothing yet). With a written type, `src<T>` is that type, not what the initializer narrows it to. */
export type Widen<T> = 0 extends (1 & T) ? any : [T] extends [null | undefined] ? any : [T] extends [never[]] ? any[] : [T] extends [string] ? string : [T] extends [number] ? number : [T] extends [boolean] ? boolean : T;
export declare function src<T>(v: T): Widen<T>;
export declare function typed<T>(v: T): T;
type ElemOf<X> = 0 extends (1 & X) ? any : X extends Iterable<infer U> ? U : X extends ArrayLike<infer U> ? U : any;
export declare function each<X>(xs: X, f: (x: ElemOf<X>) => JSX.Element): JSX.Element;
/** 12 SF-6a: what crosses the wire — data. `Bad<T>` is true where a function or an instance of a class is in it (`any`: not
 *  known here; the run-time check stands). A server fn's parameters and result must not be. */
type Bad<T> = 0 extends (1 & T) ? false : T extends string | number | boolean | bigint | null | undefined ? false : T extends Function ? true
  : T extends readonly (infer U)[] ? Bad<U> : T extends object ? (Object extends T ? false : true extends { [K in keyof T]-?: Bad<T[K]> }[keyof T] ? true : false) : true;
export declare function wire<A extends unknown[], R>(f: (...a: A) => Promise<R>, ok: true extends Bad<R> ? "WIRE_VALUE: its result is not data (a function, or an instance of a class, does not cross)" : true extends Bad<A[number]> ? "WIRE_VALUE: a parameter is not data" : true): void;
/** 07 §6: a view (`props.children: View`); R-f-10: the class a panic is. */
export type View = JSX.Element;
export type Panic = Error;
/** CP-4a: an entry's default export, a function of the app (`createApp`'s, either build) giving the view `app.mount` takes. */
export type Main = (app: object) => () => View;
export interface Ctx<T> { readonly __ctx: T }
export declare function ctx<T>(d?: T): Ctx<T>;
export declare function use<T>(c: Ctx<T>): T;
export declare function provide<T>(c: Ctx<T>, v: NoInfer<T>): void;
export declare function effect(f: () => void | (() => void)): void;
export declare function draft<T>(seed: T, f: (d: T) => void): T;
export declare function len(x: unknown): number;
export declare function until<T>(p: () => T): Promise<Exclude<T, false | 0 | "" | null | undefined>>;   // AC-6: Solid's until — the first truthy value
export declare function onSettled(f: () => void): void;                   // EF-7: imperative scope only, so no cleanup return
export declare function onFlush(f: () => void): void;                     // EF-8
export declare function str(x: unknown): string;
export declare function map<X, U>(xs: X, f: (x: ElemOf<X>, i: number) => U): U[];
export declare function filter<X>(xs: X, f: (x: ElemOf<X>) => unknown): ElemOf<X>[];
export declare function every<X>(xs: X, f: (x: ElemOf<X>) => unknown): boolean;
export declare function sum(xs: readonly number[]): number;
export declare function fail(msg: string): never;
export declare function fetch(key: string): Promise<any>;
export declare function log(...a: unknown[]): void;
