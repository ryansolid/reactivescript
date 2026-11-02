// Drives a built app in Chromium for one test: serves its dist, opens a fresh page, and hands the test an `app` with
// the moves a user makes and the controls the backend has. Each assertion waits briefly for the page to settle, so a
// test never depends on how many microtasks a framework takes to show an answer.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html" };
const norm = s => (s ?? "").replace(/\s+/g, " ").trim();

export class Failure extends Error {}

export async function serve(dist) {
  const http = createServer((req, res) => {
    const f = path.join(dist, req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
    if (!f.startsWith(dist) || !existsSync(f)) { res.statusCode = 404; return res.end(); }
    res.setHeader("content-type", types[path.extname(f)] ?? "application/octet-stream"); res.end(readFileSync(f));
  });
  await new Promise(r => http.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${http.address().port}/`, close: () => http.close() };
}

export async function launch() { return chromium.launch(); }

/** One test: a fresh page on the app, `run(app)` with the helpers below. Returns { ok, error }. */
export async function runTest(browser, url, test) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(`uncaught: ${e.message}`));
  // the framework's own warnings and errors in the console (dev builds: Solid's diagnostics such as SILENT_HOLD, React's)
  const logs = [];
  page.on("console", m => { if (m.type() === "warning" || m.type() === "error") logs.push(`${m.type() === "error" ? "error" : "warning"}: ${m.text().split("\n").slice(0, 6).join("\n  ")}`); });
  const settle = () => page.waitForTimeout(60);
  const sel = id => `[data-testid="${id}"]`;
  const app = {
    page,
    async text(id) { await settle(); const l = page.locator(sel(id)); return (await l.count()) ? norm(await l.first().textContent()) : null; },
    async exists(id) { await settle(); return (await page.locator(sel(id)).count()) > 0; },
    async type(id, value) { await page.locator(sel(id)).first().fill(value); await settle(); },
    async value(id) { await settle(); return page.locator(sel(id)).first().inputValue(); },
    async click(id, nth = 0) { await page.locator(sel(id)).nth(nth).click(); await settle(); },
    async clickText(id, text) { await page.locator(sel(id), { hasText: text }).first().click(); await settle(); },
    async items(id) { await settle(); return (await page.locator(sel(id)).allTextContents()).map(norm); },
    async pending() { return page.evaluate(() => globalThis.__flights.pending()); },
    async asked() { return page.evaluate(() => globalThis.__flights.asked()); },
    async land(key, value) { await settle(); await page.evaluate(([k, v]) => globalThis.__flights.land(k, v), [key, value]); await settle(); },
    /** land `key` if the app asked it and it is still in the air (for answers an app may serve from a cache) */
    async landIfAsked(key, value) { if ((await app.pending()).includes(key)) await app.land(key, value); },
    /** the one request to `fn` in the air, whatever its arguments (for arguments whose formatting is the app's) */
    async only(fn) { await settle(); const ks = (await app.pending()).filter(k => k.startsWith(`${fn}:`)); if (ks.length !== 1) throw new Failure(`expected one ${fn} request in flight, found ${JSON.stringify(ks)}`); return ks[0]; },
    async landOnly(fn, value) { await app.land(await app.only(fn), value); },
    async failOnly(fn, message) { await app.fail(await app.only(fn), message); },
    async noneInAir(fn) { await settle(); const ks = (await app.pending()).filter(k => k.startsWith(`${fn}:`)); if (ks.length) throw new Failure(`expected no ${fn} request in flight, found ${JSON.stringify(ks)}`); },
    async fail(key, message) { await settle(); await page.evaluate(([k, m]) => globalThis.__flights.fail(k, m), [key, message]); await settle(); },
    // assertions
    async see(id, ...parts) { const t = await app.text(id); for (const p of parts) if (t == null || !t.includes(p)) throw new Failure(`expected [${id}] to show "${p}", it shows ${t == null ? "nothing (no such element)" : `"${t}"`}`); },
    async notSee(id, ...parts) { const t = await app.text(id); for (const p of parts) if (t != null && t.includes(p)) throw new Failure(`expected [${id}] not to show "${p}", it shows "${t}"`); },
    async eq(id, expected) { const t = await app.text(id); if (t !== expected) throw new Failure(`expected [${id}] to read "${expected}", it reads ${t == null ? "nothing (no such element)" : `"${t}"`}`); },
    async rows(id, expected) { const r = await app.items(id); if (JSON.stringify(r) !== JSON.stringify(expected)) throw new Failure(`expected [${id}] rows ${JSON.stringify(expected)}, got ${JSON.stringify(r)}`); },
    async hasValue(id, expected) { const v = await app.value(id); if (v !== expected) throw new Failure(`expected [${id}] to hold "${expected}", it holds "${v}"`); },
    async inAir(key) { const p = await app.pending(); if (!p.includes(key)) throw new Failure(`expected a request ${key} in flight; in flight: ${JSON.stringify(p)}`); },
    async notAsked(key) { const a = await app.asked(); if (a.includes(key)) throw new Failure(`expected no request ${key}; asked: ${JSON.stringify(a)}`); },
    async askedTimes(key, n) { const a = (await app.asked()).filter(k => k === key).length; if (a !== n) throw new Failure(`expected ${key} asked ${n} time(s), it was asked ${a}`); },
  };
  try {
    await page.goto(url); await page.waitForFunction(() => globalThis.__flights !== undefined, null, { timeout: 5000 }).catch(() => {});
    await settle();
    await test.run(app);
    if (errors.length) throw new Failure(errors.join(" | "));
    return { ok: true, logs };
  } catch (e) {
    return { ok: false, logs, error: e instanceof Failure ? e.message : `${e.message}`.split("\n")[0] + (errors.length ? ` (page: ${errors.join(" | ")})` : "") };
  } finally { await page.close(); }
}
