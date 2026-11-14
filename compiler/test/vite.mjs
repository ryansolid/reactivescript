// `.rx` in Vite end to end: each example app built by Vite with plain `solid()` from @solidjs/vite-plugin, which finds
// this package (`@reactivescript/compiler/vite`) in the project, then driven in Chromium; and the todo app again under
// the dev server. Vite, solid-js and @solidjs/web come from the solid-next checkout (ref/SOLID_NEXT), as ref/ takes
// Solid. Solid's plugin needs built-in `.rx` (solid-vite-plugin PR, see README): SOLID_VITE_PLUGIN names a built
// checkout of it, else the one pnpm installed in solid-next. The Node-API build first: `npm run build` here,
// and the runtime's: `npm run build` in ../runtime.
// Usage: SOLID_VITE_PLUGIN=../solid-vite-plugin node compiler/test/vite.mjs [filter]
import { readdirSync, mkdirSync, rmSync, symlinkSync, writeFileSync, cpSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const repo = path.resolve(pkg, "..");
const store = path.resolve(repo, "../solid-next/node_modules/.pnpm");
const installed = path.join(store, readdirSync(store).filter(d => d.startsWith("@solidjs+vite-plugin@")).sort().pop(), "node_modules/@solidjs/vite-plugin");
const pluginDir = process.env.SOLID_VITE_PLUGIN ? path.resolve(process.env.SOLID_VITE_PLUGIN) : installed;
const deps = path.resolve(installed, "../..");   // the installed plugin's node_modules: vite, solid-js, @solidjs/web
const vite = await import(pathToFileURL(path.join(deps, "vite/dist/node/index.js")).href);
const solid = (await import(pathToFileURL(path.join(pluginDir, "dist/esm/index.mjs")).href)).default;
const { chromium } = createRequire(import.meta.url)("playwright");
const runtime = path.join(repo, "runtime");   // @reactivescript/runtime, built (`npm run build` there)

// notes/ calls server functions: with no server behind the static build, it shows its own error boundary
const apps = {
  todo: "todo.rx", cart: "cart.rx", signup: "signup.rx", users: "users.rx", shop: "shop/main.rx", notes: "notes/main.rx",
  "ai-feed": "ai/feed.rx", "ai-grid": "ai/grid.rx", "ai-wizard": "ai/wizard.rx",
  "ai2-search": "ai2/search/main.rx", "ai2-settings": "ai2/settings/main.rx", "ai2-tracker": "ai2/tracker/main.rx",
};
const filter = process.argv[2];
const out = path.join(here, ".out"); mkdirSync(out, { recursive: true });

/** A Vite project around an example: its sources, a page, an entry that mounts the program over rt-web.ts. */
function project(name, entry) {
  const dir = path.join(out, name); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  // the project's node_modules: the plugin's (vite, solid-js, @solidjs/web) and this package, installed
  const nm = path.join(dir, "node_modules"); mkdirSync(path.join(nm, "@reactivescript"), { recursive: true });
  for (const d of readdirSync(deps)) {
    if (!d.startsWith("@")) { symlinkSync(path.join(deps, d), path.join(nm, d)); continue; }
    mkdirSync(path.join(nm, d), { recursive: true });
    for (const e of readdirSync(path.join(deps, d))) symlinkSync(path.join(deps, d, e), path.join(nm, d, e));
  }
  // the runtime's peers: solid-js and @solidjs/web are the plugin's; @solidjs/signals the one that solid-js runs on
  if (!existsSync(path.join(nm, "@solidjs/signals"))) symlinkSync(realpathSync(path.join(deps, "solid-js/node_modules/@solidjs/signals")), path.join(nm, "@solidjs/signals"));
  symlinkSync(pkg, path.join(nm, "@reactivescript/compiler"));
  // the runtime as installed: copied, so that it takes the project's Solid (a peer), not its own dev copy
  for (const f of ["package.json", "dist"]) cpSync(path.join(runtime, f), path.join(nm, "@reactivescript/runtime", f), { recursive: true });
  cpSync(path.join(repo, "examples"), path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src/entry.js"), `import { createApp } from "@reactivescript/runtime";\nimport main from "./${entry}";\nimport * as api from "./api.mjs";\nconst app = createApp({ root: document.getElementById("app"), api });\napp.mount(main(app));\n`);
  writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><div id="app"></div><script type="module" src="/src/entry.js"></script></body></html>\n`);
  return dir;
}
const config = (dir, entry) => ({
  // a cache per project: the default, under the nearest package.json, would serve one run's runtime to the next
  root: dir, cacheDir: path.join(dir, ".vite"), configFile: false, logLevel: "warn", clearScreen: false,
  plugins: [solid()],
  server: { fs: { allow: [repo, path.dirname(deps), path.resolve(repo, "../solid-next"), pluginDir] } },
  build: { outDir: "dist", sourcemap: true, emptyOutDir: true },
});

const browser = await chromium.launch();
let pass = 0, fail = 0;
async function drive(name, url, check) {
  const page = await browser.newPage(); const errors = [];
  page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  try {
    await page.goto(url); await page.waitForTimeout(900);
    const text = (await page.textContent("#app"))?.replace(/\s+/g, " ").trim() ?? "";
    if (!text) throw new Error("nothing rendered");
    if (check) await check(page);
    if (errors.length) throw new Error(errors.join(" | "));
    pass++; console.log(`✓ ${name}: ${text.slice(0, 90)}`);
  } catch (e) { fail++; console.log(`✗ ${name}: ${e.message}`); }
  finally { await page.close(); }
}
const todo = async page => {
  await page.fill("input[placeholder]", "milk"); await page.click("text=Add"); await page.waitForTimeout(100);
  const t1 = await page.textContent("#app"); if (!t1.includes("milk") || !t1.includes("1 left")) throw new Error(`after add: ${t1}`);
  await page.click("input[type=checkbox]"); await page.waitForTimeout(100);
  const t2 = await page.textContent("#app"); if (!t2.includes("0 left")) throw new Error(`after toggle: ${t2}`);
};

for (const [name, entry] of Object.entries(apps)) {
  if (filter && !name.includes(filter)) continue;
  const dir = project(name, entry);
  try { await vite.build(config(dir, entry)); }
  catch (e) { fail++; console.log(`✗ ${name}: build: ${e.message.split("\n")[0]}`); continue; }
  // CP-1c: the bundle's map reaches the .rx sources
  const maps = readdirSync(path.join(dir, "dist/assets")).filter(f => f.endsWith(".js.map"));
  const sources = maps.flatMap(f => JSON.parse(readFileSync(path.join(dir, "dist/assets", f), "utf8")).sources);
  if (!sources.some(s => s.endsWith(".rx"))) { fail++; console.log(`✗ ${name}: the bundle's source map names no .rx file`); continue; }
  const dist = path.join(dir, "dist");
  const http = createServer((req, res) => { const f = path.join(dist, req.url === "/" ? "index.html" : req.url.split("?")[0]); if (!existsSync(f)) { res.statusCode = 404; return res.end(); } res.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "text/html"); res.end(readFileSync(f)); });
  await new Promise(r => http.listen(0, "127.0.0.1", r));
  await drive(`${name} (build)`, `http://127.0.0.1:${http.address().port}/`, name === "todo" ? todo : undefined);
  http.close();
}
if (!filter || "shared".includes(filter)) {   // two programs on one page, sharing shop/catalog.rx: no entry option, one catalog module
  const dir = project("shared", "shop/main.rx");
  writeFileSync(path.join(dir, "src/shop/count.rx"), `import { products } from "./catalog.rx"\n\nexport default component Count() {\n  errored fallback(e) { <p>no catalogue</p> } {\n    <p>{len(products)} products</p>\n  }\n}\n`);
  writeFileSync(path.join(dir, "src/entry.js"), `import { createApp } from "@reactivescript/runtime";\nimport shop from "./shop/main.rx";\nimport count from "./shop/count.rx";\nimport * as api from "./api.mjs";\nfor (const [main, el] of [[shop, "app"], [count, "app2"]]) { const app = createApp({ root: document.getElementById(el), api }); app.mount(main(app)); }\n`);
  writeFileSync(path.join(dir, "index.html"), readFileSync(path.join(dir, "index.html"), "utf8").replace('<div id="app"></div>', '<div id="app"></div><div id="app2"></div>'));
  try {
    const bundle = await vite.build(config(dir, "shop/main.rx"));
    const ids = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(b => b.output.flatMap(o => Object.keys(o.modules ?? {})));
    const catalogs = ids.filter(m => m.includes("catalog.rx"));
    if (catalogs.length !== 1) throw new Error(`catalog.rx bundled as ${JSON.stringify(catalogs)}`);
    const dist = path.join(dir, "dist");
    const http = createServer((req, res) => { const f = path.join(dist, req.url === "/" ? "index.html" : req.url.split("?")[0]); if (!existsSync(f)) { res.statusCode = 404; return res.end(); } res.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "text/html"); res.end(readFileSync(f)); });
    await new Promise(r => http.listen(0, "127.0.0.1", r));
    await drive("shared (build)", `http://127.0.0.1:${http.address().port}/`, async page => {
      const t = await page.textContent("#app2"); if (!/3 products/.test(t)) throw new Error(`second program: ${t}`);
    });
    http.close();
  } catch (e) { fail++; console.log(`✗ shared: ${e.message.split("\n").slice(0, 6).join(" | ")}`); }
}
if (!filter || "todo".includes(filter)) {   // the dev server: modules transformed on request
  const dir = project("todo-dev", "todo.rx");
  const server = await vite.createServer(config(dir, "todo.rx")); await server.listen(0);
  await drive("todo (dev)", server.resolvedUrls.local[0], todo);
  await server.close();
}
if (!filter || "styles".includes(filter)) {   // CSS-4 under the dev server: a dependency's <style> edit reaches the page
  const dir = project("styles-dev", "styled/main.rx");
  mkdirSync(path.join(dir, "src/styled"));
  writeFileSync(path.join(dir, "src/styled/main.rx"), `import { Badge } from "./badge.rx"\n\nexport default component Main() {\n  <main><Badge /></main>\n}\n`);
  const badge = path.join(dir, "src/styled/badge.rx");
  const style = color => `export component Badge() {\n  <style>\n    .badge { color: ${color} }\n  </style>\n  <p class="badge">badge</p>\n}\n`;
  writeFileSync(badge, style("rgb(0, 0, 255)"));
  const server = await vite.createServer(config(dir, "styled/main.rx")); await server.listen(0);
  const url = server.resolvedUrls.local[0];
  const color = page => page.$eval(".badge", e => getComputedStyle(e).color);
  const until = async (page, want, what) => {
    for (let i = 0; i < 40 && await color(page).catch(() => "") !== want; i++) await page.waitForTimeout(100);
    const got = await color(page).catch(e => e.message.split("\n")[0]); if (got !== want) throw new Error(`${what}: color ${got}, not ${want}`);
  };
  await drive("styles (dev)", url, async page => {
    await until(page, "rgb(0, 0, 255)", "first load");
    writeFileSync(badge, style("rgb(255, 0, 0)"));
    await until(page, "rgb(255, 0, 0)", "after the edit");
    await page.reload(); await until(page, "rgb(255, 0, 0)", "after a reload");
    const fresh = await browser.newPage();
    try { await fresh.goto(url); await until(fresh, "rgb(255, 0, 0)", "in a new page"); } finally { await fresh.close(); }
  });
  await server.close();
}
if (!filter || "hot".includes(filter)) {   // a dependency's component edit swaps in place; a top-level or entry edit reloads
  const dir = project("hot-dev", "hot/main.rx");
  mkdirSync(path.join(dir, "src/hot"));
  const main = path.join(dir, "src/hot/main.rx"), panel = path.join(dir, "src/hot/panel.rx");
  writeFileSync(main, `import { Panel } from "./panel.rx"\nimport { Other } from "./other.rx"\nimport { Tick } from "./tick.rx"\n\nexport default component Main() {\n  <main><Panel /><Other /><Tick /></main>\n}\n`);
  writeFileSync(path.join(dir, "src/hot/other.rx"), `export component Other() {\n  source n := 0\n  <button class="other" onClick={() => { n := n + 1 }}>other {n}</button>\n}\n`);
  // a top level that calls into JS: a replay would call it again, so its module always reloads
  const tick = path.join(dir, "src/hot/tick.rx");
  writeFileSync(path.join(dir, "src/hot/clock.mjs"), `export const now = () => "one";\n`);
  writeFileSync(tick, `import pure { now } from "./clock"\n\nfirst = now()\n\nexport component Tick() {\n  <p class="tick">{first}</p>\n}\n`);
  const lib = path.join(dir, "src/hot/lib.mjs");
  writeFileSync(lib, `export const word = () => "one";\n`);
  const source = ({ top = "", label = "total", color = "rgb(0, 0, 255)", step = 1 } = {}) =>
    `import pure { word } from "./lib"\n\n${top}source total := 0\n\nexport component Panel() {\n  said = word()\n  <style>\n    .panel { color: ${color} }\n  </style>\n  <button class="panel" onClick={() => { total := total + ${step} }}>${label} {total}</button>\n  <p class="said">{said}</p>\n}\n`;
  writeFileSync(panel, source());
  const server = await vite.createServer(config(dir, "hot/main.rx")); await server.listen(0);
  await drive("hot (dev)", server.resolvedUrls.local[0], async page => {
    const seen = async () => ({
      panel: (await page.textContent(".panel").catch(() => "")).trim(), other: (await page.textContent(".other").catch(() => "")).trim(),
      color: await page.$eval(".panel", e => getComputedStyle(e).color).catch(() => ""), kept: await page.evaluate(() => window.__kept === 1).catch(() => false),
      said: (await page.textContent(".said").catch(() => "")).trim(),
    });
    const until = async (what, want) => {
      let got;
      for (let i = 0; i < 50; i++) { got = await seen(); if (Object.entries(want).every(([k, v]) => got[k] === v)) return; await page.waitForTimeout(100); }
      throw new Error(`${what}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    };
    for (let i = 0; i < 3; i++) await page.click(".panel");
    for (let i = 0; i < 2; i++) await page.click(".other");
    await page.evaluate(() => { window.__kept = 1; });
    await until("before the edits", { panel: "total 3", other: "other 2" });
    // the module-level source and the other module's component state survive; the page is not reloaded
    writeFileSync(panel, source({ label: "sum" }));
    await until("after a markup edit", { panel: "sum 3", other: "other 2", kept: true });
    writeFileSync(panel, source({ label: "sum", color: "rgb(255, 0, 0)" }));
    await until("after a <style> edit", { color: "rgb(255, 0, 0)", panel: "sum 3", other: "other 2", kept: true });
    writeFileSync(panel, source({ label: "plus", color: "rgb(255, 0, 0)", step: 10 }));
    await until("after a logic edit", { panel: "plus 3", kept: true });
    await page.click(".panel"); await until("the new handler", { panel: "plus 13", other: "other 2", kept: true });
    // a JS module the dependency imports changed: what its top level read from it may be stale, so the page reloads
    writeFileSync(lib, `export const word = () => "two";\n`);
    await until("after an import's edit", { said: "two", panel: "plus 0", kept: false });
    await page.evaluate(() => { window.__kept = 1; }); await page.click(".other");
    writeFileSync(tick, readFileSync(tick, "utf8").replace('class="tick"', 'class="tick edited"'));
    await until("after an edit to a module whose top level calls JS", { other: "other 0", kept: false });
    await page.evaluate(() => { window.__kept = 1; });
    // the module's top level changed: a reload, with the module's new state
    writeFileSync(panel, source({ top: "base = 1\n", label: "plus", color: "rgb(255, 0, 0)" }));
    await until("after a top-level edit", { panel: "plus 0", other: "other 0", kept: false });
    await page.evaluate(() => { window.__kept = 1; }); await page.click(".other");
    writeFileSync(main, readFileSync(main, "utf8").replace("<main>", `<main class="edited">`));
    await until("after an entry edit", { other: "other 0", kept: false });
    if (!await page.$("main.edited")) throw new Error("the entry's edit did not reach the page");
    // a dependency that stops compiling, then compiles again, swaps as before
    writeFileSync(panel, source({ label: "plus" }) + "\nexport bad = missingName\n"); await page.waitForTimeout(800);
    writeFileSync(panel, source({ label: "back" }));
    await until("after the fix", { panel: "back 0" });
    await page.evaluate(() => { window.__kept = 1; }); await page.click(".panel");
    writeFileSync(panel, source({ label: "again" }));
    await until("after an edit that follows a failed compile", { panel: "again 1", kept: true });
  });
  await server.close();
}
if (!filter || "cold".includes(filter)) {   // a dependency asked for before its entry, as Vitest's `fsModuleCache` leaves it
  const { default: rx } = await import(pathToFileURL(path.join(pkg, "vite.mjs")).href);
  const root = project("cold", "shop/main.rx"), catalog = path.join(root, "src/shop/catalog.rx");
  const ctx = (id, moduleId) => ({ id, moduleId, root, ssr: false, solid: { generate: "dom", hydratable: false }, addWatchFile() {} });
  try {
    // a commented-out import is not an edge: read as one, it would make main.rx look imported and leave no entry
    writeFileSync(catalog, readFileSync(catalog, "utf8") + `\n// import { x } from "./main.rx"\n`);
    const warm = rx(); warm.compile("", ctx(path.join(root, "src/shop/main.rx"), path.join(root, "src/shop/main.rx")));
    const want = warm.compile("", ctx(catalog, `${catalog}?rx-dep`)).code;
    const got = rx().compile("", ctx(catalog, `${catalog}?rx-dep`)).code;
    if (got !== want) throw new Error("the dependency compiled cold differs from the one compiled after its entry");
    writeFileSync(catalog, readFileSync(catalog, "utf8") + "\nexport bad = missingName\n");
    let report = "";
    try { rx().compile("", ctx(catalog, `${catalog}?rx-dep`)); } catch (e) { report = e.message; }
    if (!/catalog\.rx:\d+(:\d+)?: error /.test(report)) throw new Error(`a cold dependency that does not compile reports ${JSON.stringify(report.slice(0, 200))}`);
    pass++; console.log("✓ cold dependency: compiled from the program that holds it, or that program's diagnostics");
  } catch (e) { fail++; console.log(`✗ cold dependency: ${e.message.split("\n")[0]}`); }
}
await browser.close();
console.log(`\n${pass} pass, ${fail} fail (vite ${vite.version}, @solidjs/vite-plugin ${JSON.parse(readFileSync(path.join(pluginDir, "package.json"), "utf8")).version})`);
process.exit(fail ? 1 : 0);
