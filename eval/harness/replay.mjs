// Round 8: replay one fuzz trail ("step ; step ; …", as `fuzz.mjs` prints it) against an app and print, after each step,
// the rows, the start of the detail and the requests in the air. DUMP=1 also prints the issues store (when the page
// exposes it as globalThis.__stores); DIST=<dir> serves a prebuilt dist instead of building <dir>; TAB=1 adds the issues
// tab's label; EFFLOG=1 prints and clears globalThis.__efflog (for a dist patched to push to it).
// Usage: node harness/replay.mjs <dir> "<trail>"
import { build } from "./build.mjs"; import { launch, serve, runTest } from "./driver.mjs"; import { freshServer, answer } from "./fuzz.mjs";
const [dir, trail] = process.argv.slice(2);
const b = process.env.DIST ? { dist: process.env.DIST } : await build(dir); const srv = await serve(b.dist); const br = await launch(); const db = freshServer();
const r = await runTest(br, srv.url, { run: async app => {
  await app.page.waitForFunction(() => globalThis.__flights !== undefined);
  for (const s of trail.split(" ; ")) {
    const [op, ...rest] = s.split(" "); const arg = rest.join(" ");
    if (op === "land" || op === "fail") { const a = answer(db, arg, op === "fail"); if (a.fail) await app.fail(arg, "declined"); else await app.land(arg, a.value); }
    else if (op === "focus") await app.page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); for (const t of [document, window]) t.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("blur")); Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); for (const t of [document, window]) t.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
    else if (op === "select") await app.clickText("issue", `${arg} `);
    else if (op === "user") await app.type("user", arg);
    else if (op === "rename") { await app.type("title-input", arg); await app.click("rename"); }
    else if (op === "post") { await app.type("comment-input", arg); await app.click("post"); }
    else if (op === "add-label") { await app.type("label-input", arg); await app.click("add-label"); }
    else if (op === "filter") await app.click(`filter-${arg}`);
    else if (op === "tab") await app.click(`tab-${arg}`);
    else if (["row-close", "row-assign", "remove-label"].includes(op)) await app.click(op, Number(arg));
    else await app.click(op);
    if (process.env.DUMP) console.log("   store:", await app.page.evaluate(() => { const s = globalThis.__stores?.issues; if (!s) return ""; return JSON.stringify([...s].map(x => ({ keys: Object.keys(x), id: x.id, t: x.title, a: x.assignee }))); }));
    if (process.env.EFFLOG) console.log("   fx:", await app.page.evaluate(() => { const l = globalThis.__efflog ?? []; globalThis.__efflog = []; return l.join(" | "); }));
    console.log(s.slice(0, 32).padEnd(32), ...(process.env.TAB ? [`[${await app.text("tab-issues")}]`] : []), "|", JSON.stringify(await app.items("issue")), "|", (await app.text("detail") ?? "").slice(0, Number(process.env.DW ?? 30)), "| air", JSON.stringify(await app.pending()));
  }
} });
console.log(r.ok ? "ok" : r.error); await br.close(); srv.close();
