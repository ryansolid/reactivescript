// MO-10: the scenario prelude's `./prims` in Solid (see prims.ts), with no other import, so a runtime can carry it.
/** What a runner over Solid calls: Solid primitives, as a library would write them. */
export function primsSolid(s: { createSignal: (v: any) => [() => any, (v: any) => void]; createMemo: (f: () => any) => () => any }): Record<string, (...a: any[]) => unknown> {
  return {
    createToggle: (initial: boolean) => { const [get, set] = s.createSignal(initial); return [get, (v: boolean) => { set(v); }]; },
    createShout: (src: () => string) => s.createMemo(() => `${src()}!`),
  };
}
