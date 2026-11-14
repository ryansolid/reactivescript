const land = (k, v) => p => p.evaluate(([k, v]) => globalThis.__flights.land(k, v), [k, v]);
const click = (sel) => p => p.locator(sel).first().click();
const TODO = [{ id: 1, title: "Write spec", done: 0, total: 2 }, { id: 2, title: "Fix login", done: 1, total: 3 }];
const DOING = [{ id: 3, title: "Review PR", done: 2, total: 2 }, { id: 4, title: "Deploy", done: 0, total: 1 }];
const DONE = [{ id: 5, title: "Kickoff", done: 3, total: 3 }];
const near = (t, b) => p => p.locator('[data-testid="card"]', { hasText: t }).first().locator('xpath=..').locator(`[data-testid="${b}"]`).click();
const dis = async p => console.log("  todo right disabled:", await p.locator('[data-testid="col-todo"] [data-testid="right"]').evaluateAll(bs => bs.map(b => b.disabled)));
const VISITS = process.env.VISITS === "1";
export default [
  ...(VISITS ? [["tab archive", click('[data-testid="tab-archive"]')], ["tab board", click('[data-testid="tab-board"]')]] : []),
  ["load", async p => { await land("fetchCards:doing", DOING)(p); await land("fetchCards:done", DONE)(p); await land("fetchCards:todo", TODO)(p); await dis(p); }],
  ["left #5", async p => { await near("#5 ", "left")(p); await dis(p); }],
  ["accept", async p => { await land("moveCard:5,doing,2", { id: 5, column: "doing", index: 2 })(p); await dis(p); }],
  ["land todo", async p => { await land("fetchCards:todo", TODO)(p); await p.waitForTimeout(100); await dis(p); }],
];
