const land = (k, v) => p => p.evaluate(([k, v]) => globalThis.__flights.land(k, v), [k, v]);
const click = (sel) => p => p.locator(sel).click();
export default [
  ["load", land("fetchCards:todo", [{ id: 1, title: "a", done: 0, total: 0 }])],
  ["add", click('[data-testid="add"]')],
  ["away", click('[data-testid="away"]')],
  ["back", click('[data-testid="back"]')],
  ["accept add", land("addCard:todo,x", { id: 7, title: "x" })],
  ["land reload", land("fetchCards:todo", [{ id: 1, title: "a", done: 0, total: 0 }, { id: 7, title: "x", done: 0, total: 0 }])],
  ["html", async p => console.log(await p.locator('body').innerHTML())],
];
