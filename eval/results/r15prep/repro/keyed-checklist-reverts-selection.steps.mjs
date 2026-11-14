const land = (k, v) => p => p.evaluate(([k, v]) => globalThis.__flights.land(k, v), [k, v]);
const click = (sel) => p => p.locator(sel).first().click();
export default [
  ["land checklist 2", land("fetchChecklist:2", [{ id: 21, text: "repro", done: true }, { id: 22, text: "patch", done: false }])],
  ["add ship", click('[data-testid="add"]')],
  ["toggle 22", click('[data-testid="toggle"]')],
  ["select 4", click('[data-testid="sel4"]')],
  ["accept toggle", land("toggleItem:2,22,true", { id: 22, done: true })],
  ["land checklist 4", land("fetchChecklist:4", [{ id: 41, text: "release", done: false }])],
];
