import { createStore, createMemo, Show, For } from "solid-js";
export function Counter() {
  const [state, setState] = createStore({ count: 0, rows: [{ id: 1, label: "A" }, { id: 2, label: "B" }] });
  const total = createMemo(() => state.count + state.rows.length);
  return <button onClick={() => setState(d => { d.count += 1; d.rows[0].label = "X"; })}>{state.count}/{total()}<Show when={state.count > 0} fallback={<i>empty</i>}><For each={state.rows}>{row => <i>{row.label}</i>}</For></Show></button>;
}
