const land = (k, v) => p => p.evaluate(([k, v]) => globalThis.__flights.land(k, v), [k, v]);
const C = id => ({ id, title: "t" + id, done: 0, total: 0 });
const TODO = [C(1), C(2), C(5)];
const DOING = [C(3), C(4)];
const dis = async p => { await p.waitForTimeout(100); console.log("  todo right disabled:", await p.locator('[data-testid="col-todo"] [data-testid="right"]').evaluateAll(bs => bs.map(b => b.disabled))); };
export default [
  ["load", async p => { await land("fetchCards:doing", DOING)(p); await land("fetchCards:todo", TODO)(p); await dis(p); }],
  ["right #5", async p => { await p.locator('[data-testid="col-todo"] [data-testid="right"]').nth(2).click(); await dis(p); }],
  ["accept", async p => { await land("moveCard:5,doing,2", {})(p); await dis(p); }],
  ["land todo", async p => { await land("fetchCards:todo", TODO)(p); await dis(p); }],
];
