// Rename while the detail is loading: select #3, hold its detail, rename to "Bravo", let the detail land (old title),
// and read the heading while the rename is still out. Then the same for a post while comments load.
import { build } from "/home/claude/reactivescript/eval/harness/build.mjs";
import { launch, serve } from "/home/claude/reactivescript/eval/harness/driver.mjs";
import { answer, freshServer } from "/home/claude/reactivescript/eval/harness/fuzz.mjs";
const browser = await launch();
const norm = s => (s ?? "").replace(/\s+/g, " ").trim();
for (const dir of process.argv.slice(2)) {
  const name = dir.split("/").pop(); const out = [];
  try {
    const b = await build(dir); if (!b.ok) { console.log(name, "BUILD FAIL"); continue; }
    const server = await serve(b.dist);
    for (const mode of ["rename", "post"]) {
      const srv = freshServer(); const page = await browser.newPage();
      await page.goto(server.url); await page.waitForFunction(() => globalThis.__flights !== undefined, null, { timeout: 5000 });
      const pend = () => page.evaluate(() => globalThis.__flights.pending());
      const land = async k => { const a = answer(srv, k, false); await page.evaluate(([k, v]) => globalThis.__flights.land(k, v), [k, a.value]); await page.waitForTimeout(60); };
      const landAll = async (skip = () => false) => { for (let g = 0; g < 30; g++) { await page.waitForTimeout(60); const keys = (await pend()).filter(k => !skip(k)); if (!keys.length) return; for (const k of keys) await land(k); } };
      await landAll();
      await page.locator('[data-testid="issue"]', { hasText: "#3 " }).first().click({ timeout: 2000 });
      await page.waitForTimeout(80);
      const isW = k => /^(renameIssue|addComment)/.test(k);
      try {
        if (mode === "rename") {
          await page.locator('[data-testid="title-input"]').first().fill("Bravo", { timeout: 1000 });
          await page.locator('[data-testid="rename"]').first().click({ timeout: 1000 });
          await landAll(k => isW(k) || /^(fetchIssues|search)/.test(k) && false);   // the detail (and the rest) land; the rename stays out
          await landAll(isW);
          const h = norm(await page.locator('[data-testid="detail"]').first().textContent());
          out.push(`rename:${(await pend()).some(isW) ? (h.includes("#3 Bravo") ? "ok" : "LOST[" + h.slice(0, 30) + "]") : "no-write"}`);
        } else {
          await page.locator('[data-testid="comment-input"]').first().fill("ping", { timeout: 1000 });
          await page.locator('[data-testid="post"]').first().click({ timeout: 1000 });
          await landAll(isW);
          const c = norm((await page.locator('[data-testid="comments"]').allTextContents()).join(" ")) || norm(await page.locator('[data-testid="detail"]').first().textContent());
          out.push(`post:${(await pend()).some(isW) ? (c.includes("ping") && c.includes("seen it too") ? "ok" : c.includes("ping") ? "TRUTH-DROPPED" : "LOST") : "no-write"}`);
        }
      } catch (e) { out.push(`${mode}:unavailable`); }
      await page.close();
    }
    server.close();
  } catch (e) { out.push("ERR " + e.message.split("\n")[0].slice(0, 80)); }
  console.log(name, out.join(" "));
}
await browser.close();
