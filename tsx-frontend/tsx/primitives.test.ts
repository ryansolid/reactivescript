import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Errored, Loading, NotReadyError, createComponent, createMemo, createRoot, createSignal, createStore, flush, getOwner, onCleanup,
  refresh as solidRefresh, resolve,
  type Accessor, type Element, type Signal, type Store, type StoreSetter,
} from "solid-js";
import {
  FailureBoundary, catchFailure, createServerMemo, createSourceContext, defineError, raiseFailure,
  refresh, serverAction, serverFunction, useSourceContext, type SourcePair,
} from "reactivescript-tsx";
import { isA, PANIC, wireCopy } from "./rx/runtime.ts";
import { wireCacheKey } from "./wire-key.ts";
import { R, serialize } from "./rx/runtime.ts";

const Missing = defineError("Missing", ["id"], (id: number) => `Missing ${id}`);
const Denied = defineError("Denied", [], () => "Denied");

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0)); flush();
  await new Promise(resolve => setTimeout(resolve, 0)); flush();
}

function text(read: () => unknown) {
  const node = R.createElement("span");
  R.insert(node, read);
  return node;
}

function mount(view: () => Element, host: ReturnType<typeof R.createElement>) {
  return R.render(() => text(view), host);
}

test("defineError and raiseFailure use shared failure identity, fields and class matching", () => {
  const Moved = defineError("Moved", ["id", "destination"], (id: number, destination: string) => `${id} -> ${destination}`);
  const error = Moved(7, "elsewhere");
  const id: number = error.id;
  const destination: string = error.destination;
  assert.equal(id, 7); assert.equal(destination, "elsewhere");
  assert.equal(error.message, "7 -> elsewhere"); assert.equal(error.name, "Moved");
  assert.equal(Moved.errorClass, "Moved"); assert.ok(error instanceof Moved.cls);
  assert.ok(isA(error, [Moved])); assert.ok(isA(error, [Moved.cls]));
  assert.ok(!isA(error, [defineError("Moved", [], () => "different class")]));
  assert.throws(() => raiseFailure(error), value => value === error);
  const fromClass: typeof error = new Moved.cls(8, "home");
  assert.equal(fromClass.id, 8);
  if (false) {
    // @ts-expect-error Constructor arguments follow the typed message callback.
    Moved("wrong", "elsewhere");
    // @ts-expect-error Field count and message callback arity must agree.
    defineError("Bad", ["id"], (id: number, extra: string) => extra + id);
  }
});

test("catchFailure handles matching synchronous failures without catching fallback failures", () => {
  const value = { ok: true };
  assert.equal(catchFailure(() => value, [], () => null), value);
  const error = Missing(4);
  assert.equal(catchFailure(() => raiseFailure(error), [Missing], e => { assert.equal(e, error); return 4; }), 4);
  assert.equal(catchFailure(() => raiseFailure(error), undefined, () => "any"), "any");
  assert.equal(catchFailure(() => raiseFailure(error), [Missing], () => 4).toFixed(), "4");
  assert.throws(() => catchFailure(() => raiseFailure(error), [Denied], () => 0), e => e === error);
  assert.throws(() => catchFailure(() => raiseFailure(error), [], () => 0), e => e === error);
  const fallbackError = Denied();
  assert.throws(() => catchFailure(() => raiseFailure(error), [Missing], () => raiseFailure(fallbackError)), e => e === fallbackError);
});

test("catchFailure maps controlled promise rejection and retains unmatched rejection identity", async () => {
  const request = deferred<number>();
  const events: unknown[] = [];
  const result = catchFailure(() => request.promise, [Missing], error => { events.push(error); return 12; });
  assert.deepEqual(events, []);
  const error = Missing(12); request.reject(error);
  assert.equal(await result, 12); assert.deepEqual(events, [error]);
  assert.equal(await catchFailure(() => Promise.resolve(5), [Missing], () => 0), 5);
  const unmatched = Denied();
  await assert.rejects(Promise.resolve(catchFailure(() => Promise.reject(unmatched), [Missing], () => 0)), e => e === unmatched);
});

test("catchFailure maps a controlled stream failure after preserving its earlier answers", async () => {
  const first = deferred<number>(), second = deferred<number>();
  let closed = false;
  async function* values() {
    try { yield await first.promise; yield await second.promise; }
    finally { closed = true; }
  }
  const caught = catchFailure(values, [Missing], () => 9);
  assert.notEqual(typeof caught, "number");
  const iterator = (caught as AsyncIterable<number>)[Symbol.asyncIterator]();
  const pendingFirst = iterator.next(); first.resolve(3);
  assert.deepEqual(await pendingFirst, { value: 3, done: false });
  const pendingSecond = iterator.next(); second.reject(Missing(9));
  assert.deepEqual(await pendingSecond, { value: 9, done: false });
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.ok(closed);
  const error = Denied();
  async function* failed() { yield 1; throw error; }
  const unmatched = catchFailure(failed, [Missing], () => 0) as AsyncIterable<number>;
  const other = unmatched[Symbol.asyncIterator]();
  assert.deepEqual(await other.next(), { value: 1, done: false });
  await assert.rejects(other.next(), e => e === error);
});

test("catchFailure forwards stream cancellation to the source", async () => {
  let closed = false;
  async function* values() { try { yield 1; yield 2; } finally { closed = true; } }
  const result = catchFailure(values, undefined, () => 0) as AsyncIterable<number>;
  const iterator = result[Symbol.asyncIterator]();
  await iterator.next(); await iterator.return!();
  assert.ok(closed);
});

test("global Error is catchFailure's top class for throws, rejections and stream failures", async () => {
  const failures = [Missing(8), new Error("native"), "primitive", 23, false, null, undefined, NaN];
  for (const failure of failures) {
    const fallback = (error: unknown) => { assert.equal(error, failure); return "caught"; };
    assert.equal(catchFailure(() => raiseFailure(failure), [Error], fallback), "caught");
    assert.equal(await catchFailure(() => Promise.reject(failure), [Error], fallback), "caught");
    async function* values() { yield 1; throw failure; }
    const answers: unknown[] = [];
    for await (const answer of catchFailure(values, [Error], fallback)) answers.push(answer);
    assert.deepEqual(answers, [1, "caught"]);
  }
});

test("a declared error named Error stays filtered rather than becoming the top class", async () => {
  const Error = defineError("Error", [], () => "declared");
  const failure = Error(), other = Denied();
  for (const classes of [[Error], [Error.cls]]) {
    assert.equal(catchFailure(() => raiseFailure(failure), classes, () => "declared"), "declared");
    assert.throws(() => catchFailure(() => raiseFailure(other), classes, () => "wrong"), error => error === other);
    await assert.rejects(Promise.resolve(catchFailure(() => Promise.reject("primitive"), classes, () => "wrong")), error => error === "primitive");
  }
  assert.throws(() => catchFailure(() => raiseFailure("primitive"), ["Error"], () => "wrong"), error => error === "primitive");
  const host = R.createElement("main");
  let received: unknown, innerFallbacks = 0;
  const dispose = mount(() => createComponent(Errored, {
    fallback(error: Accessor<unknown>) { received = error(); return "outer"; },
    get children() {
      return createComponent(FailureBoundary, {
        classes: [Error],
        fallback() { innerFallbacks++; return "wrong"; },
        get children() { return text(createMemo(() => raiseFailure("primitive"))); },
      });
    },
  }), host);
  try { flush(); assert.equal(serialize(host), "outer"); assert.equal(received, "primitive"); assert.equal(innerFallbacks, 0); }
  finally { dispose(); }
});

test("global Error boundaries catch thrown and rejected values while Loading still owns pending", async () => {
  const failures = [Missing(8), new Error("native"), "primitive", 23, false, null, undefined];
  for (const failure of failures) {
    for (const asynchronous of [false, true]) {
      const host = R.createElement("main"), request = deferred<never>();
      let fallbacks = 0, received: unknown;
      const dispose = mount(() => createComponent(Loading, {
        fallback: "loading",
        get children() {
          return createComponent(FailureBoundary, {
            classes: [Error],
            fallback(error) { fallbacks++; received = error(); return "caught"; },
            get children() { return text(createMemo(() => asynchronous ? request.promise : raiseFailure(failure))); },
          });
        },
      }), host);
      try {
        flush();
        if (asynchronous) {
          assert.equal(serialize(host), "loading"); assert.equal(fallbacks, 0);
          const rejection = assert.rejects(request.promise, error => Object.is(error, failure));
          request.reject(failure); await rejection; flush(); await Promise.resolve(); flush();
        }
        assert.equal(serialize(host), "caught"); assert.equal(fallbacks, 1); assert.equal(received, failure);
      } finally { dispose(); }
    }
  }
});

test("catchFailure never turns native pending into a failure, including promises and streams", async () => {
  const pending = new NotReadyError({});
  let caught = 0;
  const fallback = () => ++caught;
  assert.throws(() => catchFailure(() => { throw pending; }, [Error], fallback), e => e === pending);
  await assert.rejects(Promise.resolve(catchFailure(() => Promise.reject(pending), [Error, PANIC], fallback)), e => e === pending);
  async function* values() { throw pending; }
  const result = catchFailure(values, [Error], fallback) as AsyncIterable<number>;
  await assert.rejects(result[Symbol.asyncIterator]().next(), e => e === pending);
  assert.equal(caught, 0);
});

test("FailureBoundary gives the fallback a real native error accessor and reset", () => {
  const host = R.createElement("main");
  const failure = Missing(6);
  let setFailed!: (value: boolean) => void, error!: Accessor<unknown>, reset!: () => void;
  const dispose = mount(() => {
    const [failed, set] = createSignal(true); setFailed = set;
    return createComponent(FailureBoundary, {
      classes: [Missing],
      fallback(read, retry) { error = read; reset = retry; return text(() => (read() as Error).message); },
      get children() { return text(createMemo(() => failed() ? raiseFailure(failure) : "ready")); },
    });
  }, host);
  try {
    flush();
    assert.equal(serialize(host), "Missing 6"); assert.equal(error(), failure);
    setFailed(false); reset(); flush();
    assert.equal(serialize(host), "ready");
  } finally { dispose(); }
});

test("FailureBoundary rethrows unmatched failures to the enclosing native Errored", () => {
  const host = R.createElement("main");
  const failure = Missing(8);
  let received: unknown, innerFallbacks = 0;
  const dispose = mount(() => createComponent(Errored, {
    fallback(error: Accessor<unknown>) { received = error(); return "outer"; },
    get children() {
      return createComponent(FailureBoundary, {
        classes: [Denied],
        fallback(_error) { innerFallbacks++; return "wrong"; },
        get children() { return raiseFailure(failure); },
      });
    },
  }), host);
  try { flush(); assert.equal(serialize(host), "outer"); assert.equal(received, failure); assert.equal(innerFallbacks, 0); }
  finally { dispose(); }
});

test("matching failure payloads stay live without remounting fallback snapshots or local state", () => {
  const host = R.createElement("main");
  let setId!: (id: number) => void, bump!: () => void, mounts = 0, cleanups = 0;
  const dispose = mount(() => {
    const [id, set] = createSignal(0); setId = set;
    const result = createMemo(() => id() ? raiseFailure(Missing(id())) : "ok");
    return createComponent(FailureBoundary, {
      classes: [Missing],
      fallback(error) {
        mounts++; onCleanup(() => { cleanups++; });
        const captured = (error() as ReturnType<typeof Missing>).id;
        const [local, setLocal] = createSignal(10); bump = () => setLocal(n => n + 1);
        return text(() => `${(error() as ReturnType<typeof Missing>).id}/${captured}/${local()}`);
      },
      get children() { return text(result); },
    });
  }, host);
  try {
    flush(); assert.equal(serialize(host), "ok"); assert.equal(mounts, 0);
    setId(1); flush(); assert.equal(serialize(host), "1/1/10"); assert.equal(mounts, 1);
    bump(); flush(); setId(2); flush(); assert.equal(serialize(host), "2/1/11");
    assert.equal(mounts, 1); assert.equal(cleanups, 0);
    setId(0); flush(); assert.equal(serialize(host), "ok"); assert.equal(cleanups, 1);
    setId(3); flush(); assert.equal(serialize(host), "3/3/10"); assert.equal(mounts, 2);
  } finally { dispose(); }
  assert.equal(cleanups, 2);
});

test("filtered nested failures rethrow every new payload and react to a changed matching class", () => {
  const host = R.createElement("main");
  let setId!: (id: number) => void, outerMounts = 0, innerMounts = 0;
  const dispose = mount(() => {
    const [id, set] = createSignal(0); setId = set;
    const result = createMemo(() => { if (id() === 4) throw Denied(); return id() ? raiseFailure(Missing(id())) : "ok"; });
    return createComponent(FailureBoundary, {
      classes: [Missing],
      fallback(error) {
        outerMounts++; const captured = (error() as ReturnType<typeof Missing>).id;
        return text(() => `${(error() as Error).message}/${captured}`);
      },
      get children() {
        return createComponent(FailureBoundary, {
          classes: [Denied],
          fallback(error) { innerMounts++; return text(() => (error() as Error).message); },
          get children() { return text(result); },
        });
      },
    });
  }, host);
  try {
    flush(); assert.equal(serialize(host), "ok");
    for (const id of [1, 2, 3]) { setId(id); flush(); assert.equal(serialize(host), `Missing ${id}/1`); }
    assert.equal(outerMounts, 1); assert.equal(innerMounts, 0);
    setId(0); flush(); assert.equal(serialize(host), "ok");
    setId(4); flush(); assert.equal(serialize(host), "Denied"); assert.equal(innerMounts, 1);
    setId(5); flush(); assert.equal(serialize(host), "Missing 5/5"); assert.equal(outerMounts, 2);
  } finally { dispose(); }
});

test("native Loading still owns pending through catchFailure and FailureBoundary", async () => {
  const request = deferred<string>();
  const host = R.createElement("main");
  let fallbacks = 0;
  const dispose = mount(() => {
    const [data] = createSignal(() => request.promise);
    return createComponent(Loading, {
      fallback: "loading",
      get children() {
        return createComponent(FailureBoundary, {
          fallback(_error) { fallbacks++; return "wrong"; },
          get children() { return text(() => catchFailure(data, undefined, () => { fallbacks++; return "caught"; })); },
        });
      },
    });
  }, host);
  try {
    flush(); assert.equal(serialize(host), "loading"); assert.equal(fallbacks, 0);
    request.resolve("ready"); await settle();
    assert.equal(serialize(host), "ready"); assert.equal(fallbacks, 0);
  } finally { dispose(); }
});

test("source contexts share canonical native Signal tuples with lexical provider shadowing", () => {
  const Source = createSourceContext<number>();
  const host = R.createElement("main");
  let outer!: Signal<number>, inner!: Signal<number>;
  const dispose = mount(() => {
    outer = createSignal(1);
    return createComponent(Source, {
      value: outer,
      get children() {
        const source = useSourceContext(Source); assert.equal(source, outer);
        return [
          text(() => String(source[0]())), "/",
          createComponent(Source, {
            value: createSignal(5),
            get children() { inner = useSourceContext(Source); return text(() => String(inner[0]())); },
          }),
          "/", text(() => String(source[0]())),
        ];
      },
    });
  }, host);
  try {
    flush(); assert.equal(serialize(host), "1/5/1");
    outer[1](n => n + 1); flush(); assert.equal(serialize(host), "2/5/2");
    inner[1](9); flush(); assert.equal(serialize(host), "2/9/2");
    assert.notEqual(inner, outer);
  } finally { dispose(); }
});

test("structured source contexts retain canonical store pairs and lexical provider identity", () => {
  type State = { count: number };
  const Source = createSourceContext<State>();
  const host = R.createElement("main");
  let outer!: SourcePair<State>, inner!: SourcePair<State>;
  const dispose = mount(() => {
    outer = createStore({ count: 1 });
    return createComponent(Source, {
      value: outer,
      get children() {
        const source = useSourceContext(Source);
        const typed: SourcePair<State> = source;
        assert.equal(typed, outer); assert.equal(source[0], outer[0]); assert.equal(source[1], outer[1]);
        return [
          text(() => String(source[0].count)), "/",
          createComponent(Source, {
            value: createStore({ count: 5 }),
            get children() { inner = useSourceContext(Source); return text(() => String(inner[0].count)); },
          }),
          "/", text(() => String(source[0].count)),
        ];
      },
    });
  }, host);
  try {
    flush(); assert.equal(serialize(host), "1/5/1");
    outer[1](state => ({ count: state.count + 1 })); flush(); assert.equal(serialize(host), "2/5/2");
    inner[1](state => { state.count = 9; }); flush(); assert.equal(serialize(host), "2/9/2");
    assert.notEqual(inner, outer);
  } finally { dispose(); }
});

test("source pair types preserve scalar signals and reject object signals as store providers", () => {
  const scalar: SourcePair<boolean> = createSignal(false);
  const structured: SourcePair<{ ok: boolean }[]> = createStore<{ ok: boolean }[]>([]);
  const objectSignal = createSignal<{ ok: boolean }[]>([]);
  // @ts-expect-error An object signal accessor is not a Store<T>.
  const invalid: SourcePair<{ ok: boolean }[]> = objectSignal;
  assert.equal(invalid, objectSignal); assert.equal(typeof objectSignal[0], "function");
  assert.equal(scalar[0](), false); assert.equal(structured[0].length, 0);
  const Source = createSourceContext<{ ok: boolean }[]>();
  const invalidProvider = () => createComponent(Source, {
    // @ts-expect-error A structured source provider requires the real store pair.
    value: objectSignal,
    children: null,
  });
  assert.equal(typeof invalidProvider, "function");
});

test("source context inference keeps natural scalar and array destructuring fully typed", () => {
  type Row = { ok: boolean };
  const Fields = createSourceContext<Row[]>();
  const Enabled = createSourceContext<boolean>();
  const host = R.createElement("main");
  let update!: StoreSetter<Row[]>, toggle!: Signal<boolean>[1];
  const dispose = mount(() => {
    const pair = createStore<Row[]>([{ ok: false }]);
    const flag = createSignal(false);
    return createComponent(Fields, {
      value: pair,
      get children() {
        const [rows, setRows] = useSourceContext(Fields);
        const store: Store<Row[]> = rows;
        const setter: StoreSetter<Row[]> = setRows;
        assert.equal(store, pair[0]); assert.equal(setter, pair[1]); update = setRows;
        // @ts-expect-error A store is not a signal accessor, nor an inferred any.
        const wrongRead = () => rows();
        assert.equal(typeof wrongRead, "function");
        return createComponent(Enabled, {
          value: flag,
          get children() {
            const [enabled, setEnabled] = useSourceContext(Enabled);
            const signal: Signal<boolean> = [enabled, setEnabled];
            assert.equal(signal[0], flag[0]); assert.equal(signal[1], flag[1]); toggle = setEnabled;
            // @ts-expect-error Natural scalar inference must not widen to any.
            const wrongScalar: () => number = enabled;
            assert.equal(typeof wrongScalar, "function");
            return text(() => String(enabled() && rows.every(row => row.ok)));
          },
        });
      },
    });
  }, host);
  try {
    flush(); assert.equal(serialize(host), "false");
    update(rows => [...rows, { ok: true }]); toggle(true); flush(); assert.equal(serialize(host), "false");
    update(rows => rows.filter(row => row.ok)); flush(); assert.equal(serialize(host), "true");
  } finally { dispose(); }
});

test("source contexts fail explicitly without a provider or owner", () => {
  const Source = createSourceContext<number>();
  assert.throws(() => useSourceContext(Source), /source context provider/);
  createRoot(dispose => {
    try { assert.throws(() => useSourceContext(Source), /source context provider/); }
    finally { dispose(); }
  });
  const Structured = createSourceContext<{ ok: boolean }[]>();
  assert.throws(() => useSourceContext(Structured), /source context provider/);
  createRoot(dispose => {
    try { assert.throws(() => useSourceContext(Structured), /source context provider/); }
    finally { dispose(); }
  });
});

for (const [name, factory] of [["serverFunction", serverFunction], ["serverAction", serverAction]] as const) {
  test(`${name} copies arguments and results across its real in-process wire`, async () => {
    const request = deferred<number>();
    let remote!: { items: number[] }, answer!: { items: number[]; extra: number };
    const endpoint = factory("copy", function* (input: { items: number[] }) {
      remote = input; input.items.push(2);
      const extra: number = yield request.promise;
      answer = { items: input.items, extra }; return answer;
    });
    const input = { items: [1] };
    const pending = endpoint(input); assert.ok(pending instanceof Promise);
    assert.notEqual(remote, input); assert.notEqual(remote.items, input.items);
    assert.deepEqual(input, { items: [1] }); input.items.push(99);
    request.resolve(4); const result = await pending;
    assert.deepEqual(result, { items: [1, 2], extra: 4 });
    assert.notEqual(result, answer); assert.notEqual(result.items, answer.items);
    result.items.push(3); assert.deepEqual(answer.items, [1, 2]);
  });
}

test("server generator drivers resume promises and throw rejections back into the server body", async () => {
  const first = deferred<number>(), second = deferred<number>();
  const failure = new Error("server detail");
  const events: unknown[] = [];
  const endpoint = serverAction("resume", function* () {
    const value: number = yield first.promise; events.push(value);
    try { yield second.promise; } catch (error) { events.push(error); }
    return value + 1;
  });
  const result = endpoint(); assert.deepEqual(events, []);
  first.resolve(5); await Promise.resolve(); assert.deepEqual(events, [5]);
  second.reject(failure); assert.equal(await result, 6); assert.deepEqual(events, [5, failure]);
});

test("server failures preserve declared classes and sanitize undeclared throws and rejections", async () => {
  const declared = Missing(3);
  const typed = serverFunction("typed", function* () { throw declared; });
  await assert.rejects(typed(), error => error === declared && error instanceof Missing.cls);
  for (const error of [new Error("secret"), "secret", undefined, null, 0]) {
    const thrown = serverAction("thrown", function* () { throw error; });
    await assert.rejects(thrown(), value => value instanceof Error && value.message === "Internal Server Error");
    const rejected = serverFunction("rejected", function* () { yield Promise.reject(error); });
    await assert.rejects(rejected(), value => value instanceof Error && value.message === "Internal Server Error");
  }
});

test("server wire rejects non-data arguments before execution and non-data results after execution", async () => {
  let calls = 0;
  const endpoint = serverFunction("data", function* (value: unknown) { calls++; return value; });
  for (const value of [() => 1, new Date(0), Symbol("secret"), 1n])
    await assert.rejects(endpoint({ nested: [value] }), error => error instanceof Error && error.message.includes("WIRE_VALUE: data: argument 1.nested[0]"));
  assert.equal(calls, 0);
  const result = serverAction("result", function* () { return { callback: () => 1 }; });
  await assert.rejects(result(), /WIRE_VALUE: result: its result.callback/);
});

test("server drivers detach the native caller owner and dependencies while the callsite remains reactive", async () => {
  let read!: Accessor<{ request: Promise<number> }>, second!: typeof read, setKey!: (n: number) => void, setHidden!: (n: number) => void;
  const owners: unknown[] = [];
  let calls = 0, dispose!: () => void;
  createRoot(stop => {
    dispose = stop;
    const [key, writeKey] = createSignal(1), [hidden, writeHidden] = createSignal(0);
    setKey = writeKey; setHidden = writeHidden;
    const endpoint = serverFunction("read", function* (n: number) {
      calls++; owners.push(getOwner());
      // JavaScript closure purity cannot be checked here; this read must at least stay untracked.
      const snapshot = hidden(); yield Promise.resolve(); owners.push(getOwner());
      return n + snapshot;
    });
    read = createMemo(() => ({ request: endpoint(key()) }));
    second = createMemo(() => ({ request: endpoint(key()) }));
  });
  try {
    const first = read().request; assert.equal(second().request, first); assert.equal(await first, 1); assert.equal(calls, 1);
    setHidden(10); flush(); assert.equal(read().request, first); assert.equal(calls, 1);
    setKey(2); flush(); assert.equal(await read().request, 12); assert.equal(calls, 2);
    setKey(1); flush(); assert.equal(read().request, first); assert.equal(calls, 2);
    assert.deepEqual(owners, [null, null, null, null]);
    let requests = 0;
    const uncached = serverAction("uncached", function* () { return ++requests; });
    const a = uncached(), b = uncached(); assert.notEqual(a, b);
    assert.deepEqual(await Promise.all([a, b]), [1, 2]);
  } finally { dispose(); }
});

test("serverFunction deduplicates equal arguments across readers and reuses earlier flights", async () => {
  const request = deferred<number>();
  let calls = 0;
  const load = serverFunction("load", function* (input: { id: number }) { calls++; return (yield request.promise) + input.id; });
  const first = load({ id: 1 }), same = load({ id: 1 }), other = load({ id: 2 });
  assert.equal(first, same); assert.notEqual(first, other); assert.equal(calls, 2);
  request.resolve(10); assert.deepEqual(await Promise.all([first, same, other]), [11, 11, 12]);
  assert.equal(load({ id: 1 }), first); assert.equal(calls, 2);
  const failed = serverFunction("failed", function* () { calls++; throw new Error("secret"); });
  const rejection = failed(); await assert.rejects(rejection, /Internal Server Error/);
  assert.equal(failed(), rejection);
});

test("new loader factories in independent native owners do not share a cache", async () => {
  let calls = 0;
  const requests = [0, 1].map(() => createRoot(dispose => {
    try { return serverFunction("load", function* (id: number) { calls++; return id; })(1); }
    finally { dispose(); }
  }));
  assert.notEqual(requests[0], requests[1]);
  assert.deepEqual(await Promise.all(requests), [1, 1]); assert.equal(calls, 2);
});

test("result serialization failures are sanitized but wire value diagnostics remain explicit", async () => {
  const read = serverFunction("read", function* () { return { get privateData(): unknown { throw new Error("private database details"); } }; });
  await assert.rejects(read(), error => error instanceof Error && error.message === "Internal Server Error");
  const load = serverFunction("validated", function* (value: unknown) { return value; });
  assert.equal(await load(undefined), undefined);
  await assert.rejects(load(() => 1), /WIRE_VALUE: validated: argument 1/);
});

test("server memo refresh reasks only its reader, records cache hits, and retains other argument entries", async () => {
  let calls = 0;
  const app = createRoot(dispose => {
    const load = serverFunction("load", function* (id: number) { return { id, value: ++calls }; });
    const [id, setId] = createSignal(1);
    const first = createServerMemo(async () => await load(id()), { name: "first" });
    const second = createServerMemo(() => load(id()));
    return { dispose, load, first, second, setId };
  });
  try {
    await Promise.all([resolve(app.first), resolve(app.second)]); flush();
    assert.equal(calls, 1); assert.deepEqual([app.first().value, app.second().value], [1, 1]);
    const once = refresh(app.first), coalesced = refresh(app.first); flush();
    assert.deepEqual(await Promise.all([once, coalesced]), [{ id: 1, value: 2 }, { id: 1, value: 2 }]);
    flush(); assert.equal(calls, 2); assert.deepEqual([app.first().value, app.second().value], [2, 1]);
    const twice = refresh(app.first); flush(); await twice; flush();
    assert.equal(calls, 3); assert.deepEqual([app.first().value, app.second().value], [3, 1]);
    const cacheHit = refresh(app.second); flush(); await cacheHit; flush();
    assert.equal(calls, 4); assert.deepEqual([app.first().value, app.second().value], [3, 4]);
    const other = app.load(2); assert.deepEqual(await other, { id: 2, value: 5 });
    app.setId(2); flush(); await Promise.all([resolve(app.first), resolve(app.second)]); flush();
    assert.equal(calls, 5); assert.deepEqual([app.first().value, app.second().value], [5, 5]);
    const changed = refresh(app.first); flush(); await changed; flush();
    assert.equal(calls, 6); assert.deepEqual([app.first().value, app.second().value], [6, 5]);
    assert.deepEqual(await app.load(1), { id: 1, value: 4 }); assert.equal(calls, 6);
  } finally { app.dispose(); }
});

test("server refresh invalidation stays within its factory and leaves unrelated memos alone", async () => {
  let leftCalls = 0, rightCalls = 0, plainCalls = 0;
  const app = createRoot(dispose => {
    const left = serverFunction("same", function* (id: number) { return { id, value: ++leftCalls }; });
    const right = serverFunction("same", function* (id: number) { return { id, value: ++rightCalls }; });
    const first = createServerMemo(() => left(1));
    const second = createServerMemo(() => right(1));
    const unrelated = createServerMemo(() => left(2));
    const plain = createMemo(() => ++plainCalls);
    return { dispose, first, second, unrelated, plain, left };
  });
  try {
    await Promise.all([resolve(app.first), resolve(app.second), resolve(app.unrelated)]); flush();
    const before = app.first(), second = app.second(), unrelated = app.unrelated();
    assert.equal(leftCalls, 2); assert.equal(rightCalls, 1); assert.equal(app.plain(), 1);
    const renewed = refresh(app.first); flush(); await renewed; flush();
    assert.equal(leftCalls, 3); assert.equal(rightCalls, 1); assert.notEqual(app.first(), before);
    assert.equal(app.second(), second); assert.equal(app.unrelated(), unrelated);
    assert.equal(await app.left(2), unrelated);
    const ordinary = refresh(app.plain); flush(); assert.equal(await ordinary, 2);
    assert.equal(leftCalls, 3); assert.equal(rightCalls, 1);
  } finally { app.dispose(); }
});

test("native Solid refresh and ordinary memos do not implicitly invalidate loader caches", async () => {
  let calls = 0;
  const app = createRoot(dispose => {
    const load = serverFunction("plain", function* () { return ++calls; });
    return { dispose, ordinary: createMemo(() => load()), explicit: createServerMemo(() => load()) };
  });
  try {
    await Promise.all([resolve(app.ordinary), resolve(app.explicit)]); flush(); assert.equal(calls, 1);
    const native = solidRefresh(app.explicit); flush(); assert.equal(await native, 1);
    const ordinary = refresh(app.ordinary); flush(); assert.equal(await ordinary, 1);
    assert.equal(calls, 1);
    const explicit = refresh(app.explicit); flush(); assert.equal(await explicit, 2); flush();
    assert.equal(calls, 2); assert.equal(app.explicit(), 2); assert.equal(app.ordinary(), 1);
  } finally { app.dispose(); }
});

test("server memo refresh evicts cached rejections without rerunning other failed readers", async () => {
  let calls = 0; const failure = Missing(404);
  const app = createRoot(dispose => {
    const load = serverFunction("retry", function* () { if (++calls === 1) throw failure; return calls; });
    return { dispose, first: createServerMemo(() => load()), second: createServerMemo(() => load()) };
  });
  try {
    const results = await Promise.allSettled([resolve(app.first), resolve(app.second)]); flush();
    assert.deepEqual(results, [{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
    assert.equal(calls, 1);
    const retry = refresh(app.first); flush(); assert.equal(await retry, 2); flush();
    assert.equal(calls, 2); assert.equal(app.first(), 2);
    assert.throws(app.second, error => error instanceof Error && error.cause === failure); assert.equal(calls, 2);
    const other = refresh(app.second); flush(); assert.equal(await other, 3); flush();
    assert.equal(calls, 3); assert.equal(app.first(), 2); assert.equal(app.second(), 3);
  } finally { app.dispose(); }
});

test("server memo refresh supersedes pending answers without discarding older argument cache entries", async () => {
  const requests: ReturnType<typeof deferred<number>>[] = [];
  const app = createRoot(dispose => {
    const load = serverFunction("pending", function* (_id: number) {
      const request = deferred<number>(); requests.push(request);
      return (yield request.promise) as number;
    });
    const [id, setId] = createSignal(1);
    const first = load(1), second = load(2);
    return { dispose, load, first, second, setId, memo: createServerMemo(() => load(id())) };
  });
  try {
    const mounted = resolve(app.memo);
    app.setId(2); flush(); const switched = resolve(app.memo);
    const newest = refresh(app.memo); flush(); await Promise.resolve(); flush();
    assert.equal(requests.length, 3);
    requests[2].resolve(22); assert.equal(await newest, 22); flush(); assert.equal(app.memo(), 22);
    requests[1].resolve(21); requests[0].resolve(11);
    assert.deepEqual(await Promise.all([app.first, app.second]), [11, 21]);
    await Promise.all([mounted, switched]); flush();
    assert.equal(app.memo(), 22); assert.equal(await app.load(1), 11); assert.equal(await app.load(2), 22);
    assert.equal(requests.length, 3);
  } finally { app.dispose(); }
});

test("server memo forwards previous values and native memo options without creating another reactive layer", async () => {
  const app = createRoot(dispose => {
    const [n, setN] = createSignal(1);
    const values: number[] = [];
    const total = createServerMemo((previous: number) => { values.push(previous); return previous + n(); }, { loadingValue: 10, name: "total" });
    return { dispose, total, setN, values };
  });
  try {
    assert.equal(await resolve(app.total), 11);
    app.setN(2); flush(); assert.equal(app.total(), 13);
    const next = refresh(app.total); flush(); assert.equal(await next, 15);
    assert.deepEqual(app.values, [10, 11, 13]);
  } finally { app.dispose(); }
});

test("server memo request collection stops when an async compute returns its promise", async () => {
  const start = deferred<void>(); let calls = 0;
  const app = createRoot(dispose => {
    const load = serverFunction("late", function* () { return ++calls; });
    const memo = createServerMemo(async () => { await start.promise; return load(); });
    return { dispose, memo };
  });
  try {
    const first = resolve(app.memo); start.resolve(); assert.equal(await first, 1);
    const next = refresh(app.memo); flush(); assert.equal(await next, 1);
    assert.equal(calls, 1);
  } finally { app.dispose(); }
});

test("wire argument cache keys distinguish types, delimiters, special numbers and data structures", async () => {
  const variants: unknown[][] = [
    [], [""], [undefined], [null], [false], [true], [0], [-0], [1], ["1"],
    [NaN], [Infinity], [-Infinity], ["NaN"], ["Infinity"], ["-Infinity"],
    ["undefined"], ["null"], ["false"], ["true"],
    ["a,b", "c"], ["a", "b,c"], ["a,b,c"], ["a", "b", "c"],
    [["a,b", "c"]], [["a", "b,c"]], [[1]], [["1"]],
    [[]], [{}], [new Array(1)], [[undefined]], [[null]], [[NaN]], [[Infinity]], [[-Infinity]], [[0]], [[-0]],
    [{ value: undefined }], [{ value: null }], [{ value: NaN }], [{ value: Infinity }], [{ value: -Infinity }],
    [{ value: 0 }], [{ value: -0 }], [{ value: [] }], [{ value: {} }],
    [["x"]], [{ "0": "x", length: 1 }],
  ];
  const validated = variants.map(args => wireCopy(args, "arguments", message => { throw new Error(message); }) as unknown[]);
  assert.equal(new Set(validated.map(wireCacheKey)).size, variants.length);
  let calls = 0;
  const load = serverFunction("collisions", function* (..._args: unknown[]) { return ++calls; });
  const requests = variants.map(args => load(...args));
  assert.deepEqual(await Promise.all(requests), variants.map((_, i) => i + 1));
  for (const [i, args] of validated.entries()) assert.equal(load(...args), requests[i]);
  assert.equal(calls, variants.length);
});

test("wire cache keys canonicalize record order recursively while retaining array order", async () => {
  const first = { z: [{ b: 2, a: 1 }, undefined, -0], a: { y: true, x: null } };
  const reordered = { a: { x: null, y: true }, z: [{ a: 1, b: 2 }, undefined, -0] };
  const reversed = { a: reordered.a, z: [...reordered.z].reverse() };
  assert.equal(wireCacheKey([first]), wireCacheKey([reordered]));
  assert.notEqual(wireCacheKey([first]), wireCacheKey([reversed]));
  assert.equal(wireCacheKey([{ b: 2, a: 1 }]), wireCacheKey([Object.assign(Object.create(null), { a: 1, b: 2 })]));
  let calls = 0;
  const load = serverFunction("records", function* (_value: unknown) { return ++calls; });
  const initial = load(first); assert.equal(load(reordered), initial); assert.equal(await initial, 1);
  assert.equal(await load(reversed), 2); assert.equal(calls, 2);
});

test("typed loader cache keys isolate cached rejections and targeted refresh", async () => {
  const failure = Missing(1); let calls = 0;
  const app = createRoot(dispose => {
    const load = serverFunction("typed", function* (value: number | string) {
      const call = ++calls; if (typeof value === "number" && call === 1) throw failure;
      return { value, call };
    });
    const failed = load(1), cachedText = load("1");
    return { dispose, load, failed, cachedText, numeric: createServerMemo(() => load(1)), text: createServerMemo(() => load("1")) };
  });
  try {
    const initial = await Promise.allSettled([resolve(app.numeric), resolve(app.text)]); flush();
    assert.deepEqual(initial, [{ status: "rejected", reason: failure }, { status: "fulfilled", value: { value: "1", call: 2 } }]);
    assert.equal(app.load(1), app.failed); assert.equal(calls, 2);
    const retry = refresh(app.numeric); flush(); assert.deepEqual(await retry, { value: 1, call: 3 }); flush();
    assert.equal(app.text(), await app.cachedText); assert.equal(app.load("1"), app.cachedText);
    assert.notEqual(app.load(1), app.failed); assert.equal(calls, 3);
  } finally { app.dispose(); }
});
