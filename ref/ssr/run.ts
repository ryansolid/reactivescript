// 10-server: renders every scenario's mount on the server, streams it to a real browser, and hydrates it. For each table,
// the rows up to the first handler are the mount and its landings (the instants a server can stream); the server renders
// the compiled program with solid-js 2.0's server build (ref/compile/rt-server.ts), the runner lands each flight as the
// rows say, and the browser's visible text after each chunk is a server frame. SV-1: the server frames, deduplicated, are
// the client's frames in order — the first is the mount's, and a landing may be coalesced with the next — with a panic's
// message redacted (SV-5). SV-3: the same modules bundled over ref/compile/rt-web.ts then take the page over — after the
// last landing, and right after the shell — and every remaining row runs in the browser.
// node --experimental-strip-types ssr/run.ts [filter]      (default conditions: solid-js resolves to its server build)
// env: RX_CRATE=1 serves and hydrates the Rust crate's output (compiler/, compile/lowered.ts); CSR=1 also mounts each table in the browser with no server; NO_HYDRATE=1 serves only; SV_SCOPE=1 renders in
// Solid's server-component scope (DV-9); DEBUG=1, DEBUG_NAMES=a,b and WAIT=ms help when a table disagrees.
import { SOLID } from "../solid-version.ts";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { parseScenario, moduleSet, type Scenario } from "../src/scenario.ts";
import { parseStmts } from "../src/parse.ts";
import { checkModules } from "../src/check.ts";
import { compileDynamic, compileDynamicExpr, CompileError } from "../compile/emit.ts";
import { buildSync } from "esbuild";
import { build, type Built } from "../compile/lowered.ts";
import { createApp, generateHydrationScript } from "../compile/rt-server.ts";
import { transformDirectives } from "@solidjs/compiler";
import { handleServerFunctionRequest } from "@solidjs/web/server-functions";

/** 12 SF-7a: Solid's \`"use server"\` pass over a lowered module — "server" keeps and registers each server function,
 *  "client" replaces it with a reference that calls the server. The same filename on both sides, so the ids agree. */
const directives = (code: string, filename: string, mode: "server" | "client") => { if (!code.includes('"use server"')) return code; const r = transformDirectives(code, { filename, root: "/", mode }); return r.valid ? r.code : code; };
/** The requests a server function call made after hydration: each runs in an app of its own (SV-4), whose flights the
 *  runner lands like the page's. */
const rpcApps: ReturnType<typeof createApp>[] = [];
async function serverFunction(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  if (process.env.DEBUG_RPC) console.log("  rpc:", req.method, req.url?.slice(0, 80));
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks) });
  const rpc = createApp(); rpcApps.push(rpc); (globalThis as { __rx_app?: unknown }).__rx_app = rpc;
  const response = await handleServerFunctionRequest(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) for await (const c of response.body as unknown as AsyncIterable<Uint8Array>) res.write(c);
  res.end();
}

process.on("unhandledRejection", () => {});
const { chromium } = createRequire(import.meta.url)("playwright");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const outDir = fileURLToPath(new URL(`./.out/${process.pid}/`, import.meta.url)); mkdirSync(outDir, { recursive: true });
export const REDACTED = "Internal Server Error";   // what Solid sends for an error not marked safe

// One live response at a time: the runner holds it open and writes what the server render streams.
let pending: ((res: import("node:http").ServerResponse) => void) | null = null;
let clientJs = "";   // the current table's client bundle (SV-3)
const http = createServer((req, res) => { if (req.url?.startsWith("/_server")) { serverFunction(req, res).catch(e => { res.statusCode = 500; res.end(String(e)); }); return; } if (req.url === "/favicon.ico") { res.statusCode = 404; res.end(); return; } if (req.url === "/client.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(clientJs); return; } res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); const p = pending; pending = null; if (p) p(res); else res.end("no render"); });
await new Promise<void>(r => http.listen(0, "127.0.0.1", () => r()));
const port = (http.address() as { port: number }).port;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});   // CHROMIUM: a system browser (as eval/harness/driver.mjs)
const page = await browser.newPage();
const pageErrors: string[] = []; page.on("pageerror", (e: Error) => pageErrors.push(e.message)); page.on("console", (m: any) => { if (m.type() === "error" || (m.type() === "warning" && /hydrat/i.test(m.text()))) pageErrors.push(m.text()); });
const textOf = () => page.evaluate(() => {
  const root = document.getElementById("app"); if (!root) return "";
  let s = ""; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => { for (let p = n.parentElement; p && p !== root; p = p.parentElement) if (p.tagName === "SCRIPT" || p.tagName === "TEMPLATE" || p.tagName === "STYLE") return NodeFilter.FILTER_REJECT; return NodeFilter.FILTER_ACCEPT; } });
  for (let n = w.nextNode(); n; n = w.nextNode()) s += n.nodeValue;
  // RG-8: what portals show at the end of the document (Solid's Portal appends to <body>), after the page's own text
  let p = ""; for (const c of [...document.body.childNodes]) { if (c === root || (c as Element).tagName === "SCRIPT" || (c as Element).tagName === "TEMPLATE" || (c as Element).tagName === "STYLE") continue; p += c.textContent ?? ""; }
  return p.trim() ? `${s} » ${p}` : s;
});

let seq = 0;
const dedupe = (xs: string[]) => xs.filter((x, i) => i === 0 || x !== xs[i - 1]);

type Row = Scenario["tables"][number]["rows"][number];
type Served = { got: string[]; ended: boolean; file: string };

/** Serve `src` once (a request: a fresh app, so fresh module state — SV-4) and land `rows[1..]` in order; the browser's text
 *  after the shell and after each landing. Undefined when the program is not served (refused, not compiled — noted). */
async function serve(sc: Scenario, src: string, rows: Row[], title: string, lines: string[], other?: { chunks: string[] }): Promise<Served | undefined | false> {
  let out: Built;
  try { const set = moduleSet(sc, src); if (checkModules(set).diags.length) { lines.push(`  ~ ${title}: refused by the checker`); return undefined; } out = build(sc, src, []); }
  catch (e) { if (e instanceof CompileError) { lines.push(`  ~ ${title}: not compiled — ${e.message}`); return undefined; } lines.push(`  ✗ ${title}: ${(e as Error).message}`); return false; }
  const dir = `${outDir}${sc.name}.${++seq}/`; mkdirSync(dir, { recursive: true });
  for (const [name, js] of out.views("ssr")) writeFileSync(dir + name, directives(js, dir + name, "server"));
  const main = (await import(pathToFileURL(dir + out.entry).href)).default;
  const app = createApp();
  const got: string[] = []; let ended = false; let chunks = 0; let renderError: unknown = null;
  const doc: string[] = [];
  const served$ = new Promise<void>(resolve => {
    pending = res => {
      res.on("error", () => {});
      res.write(`<!doctype html><html><head>${generateHydrationScript()}<style>${out.css}</style></head><body><div id="app">`);   // CSS-4: the stylesheet is linked, not injected by the runtime
      try { app.stream(main(app), { write: (c: string) => { chunks++; doc.push(c); if (!res.writableEnded) res.write(c); }, end: () => { ended = true; if (!res.writableEnded) res.end("</div></body></html>"); } }); }
      catch (e) { renderError = e; res.end(); }
      resolve();
    };
  });
  // SV-4: another request for the same page, in flight at the same time — its own app, its own module state
  if (other) { const b = createApp(); b.stream(main(b), { write: (c: string) => { other.chunks.push(c); }, end: () => {} }); }
  const nav = page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" }).catch(() => {});
  await served$; await nav;
  for (let i = 0; i < 40 && chunks === 0 && !ended && !renderError; i++) await wait(10);
  await wait(40);
  if (renderError) { lines.push(`  ✗ ${title}: server render threw: ${(renderError as Error).message}`); return false; }
  got.push(norm(await textOf()));
  for (const r of rows.slice(1)) {
    const m = /^(resolve|reject)\s+(\S+)\s+([\s\S]*)$/.exec(r.action);
    if (!m) { lines.push(`  ✗ ${title} instant ${r.instant}: a server table has mount, resolve and reject rows only`); return false; }
    const key = /^".*"$/.test(m[2]) ? m[2].slice(1, -1) : app.lastKey.get(m[2]);
    const f = key === undefined ? undefined : app.flights.get(key);
    if (!f) { if (ended) break; lines.push(`  ✗ ${title} instant ${r.instant}: the server has no flight for ${m[2]}`); return false; }
    const v = parseStmts(m[3])[0];
    const value = v.k === "expr" ? new Function("__rt", "__B", `return ${compileDynamicExpr(v.e)};`)(app, app.B) : undefined;
    if (m[1] === "reject") f.reject(value instanceof Error ? value : new Error(String(value))); else f.resolve(value);
    await wait(60);
    got.push(norm(await textOf()));
  }
  writeFileSync(dir + "stream.html", doc.join("\n<!-- chunk -->\n"));
  return { got, ended, file: dir + "stream.html" };
}

const rtWeb = fileURLToPath(new URL("../compile/rt-web.ts", import.meta.url));
/** The browser's half of a table (SV-3): its compiled modules over rt-web.ts, bundled for the page. */
function bundle(dir: string, views: Map<string, string>, entry: string) {
  const cdir = dir + "client/"; mkdirSync(cdir, { recursive: true });
  for (const [name, js] of views) writeFileSync(cdir + name, directives(js, dir + name, "client"));   // the server's filename: the same ids
  writeFileSync(cdir + "client-entry.mjs", `import main from "./${entry}";\nimport { createApp, flush } from ${JSON.stringify(rtWeb)};\nimport { sharedConfig } from "solid-js";\nconst app = createApp({ root: document.getElementById("app") });\nwindow.__client = { app, flush, sharedConfig, main };\n`);
  // the dev builds: Solid reports a hydration key miss, a tag mismatch and unclaimed server nodes on the console
  const r = buildSync({ entryPoints: [cdir + "client-entry.mjs"], bundle: true, write: false, format: "esm", platform: "browser", conditions: ["browser", "development"], logLevel: "silent", tsconfigRaw: "{}" });   // (not next's tsconfig paths, which map solid-js to its source)
  return r.outputFiles[0].text;
}

/** SV-7b: the `client` JS a program imports (12 SF-5b) — its flights are the browser's: the server never asks them. */
function clientFns(sc: Scenario, src: string): Set<string> {
  const out = new Set<string>();
  for (const p of moduleSet(sc, src).programs.values()) for (const d of p.decls) if (d.k === "import") for (const { name } of d.names) if (d.side === "client" || d.declaredSide?.[name] === "client") out.add(name);
  return out;
}
const isClientRow = (r: Row, cf: Set<string>) => { const m = /^(resolve|reject)\s+"([^":]*):/.exec(r.action); return !!m && cf.has(m[2]); };
type Chain = Row[];
const c0last = (chains: Chain[]) => chains[0][chains[0].length - 1];
/** SV-3: serve, hydrate at `at` (after that many served chains — 1 is right after the shell), then run every chain on the
 *  client. The frames after hydration are the client's own (a recorded oracle divergence where there is one; a panic's
 *  message may be redacted, SV-5b). After hydrating: every element the server sent was adopted, and no question the server
 *  answered was asked again. */
async function hydrated(sc: Scenario, t: Scenario["tables"][number], src: string, chains: Chain[], served: number, at: number, label: string, lines: string[]): Promise<boolean> {
  let out: Built;
  try { const set = moduleSet(sc, src); if (checkModules(set).diags.length) return true; out = build(sc, src, chains.flat().filter(r => r.action.startsWith("handler")).map(r => r.action.slice(7))); }
  catch (e) { if (e instanceof CompileError) return true; lines.push(`  ✗ ${t.title} [${label}]: ${(e as Error).message}`); return false; }
  const dir = `${outDir}${sc.name}.${++seq}/`; mkdirSync(dir, { recursive: true });
  for (const [name, js] of out.views("ssr")) writeFileSync(dir + name, directives(js, dir + name, "server"));
  const main = (await import(pathToFileURL(dir + out.entry).href)).default;
  clientJs = bundle(dir, out.views("dom"), out.entry);
  const app = createApp(); let ended = false; let chunks = 0;
  const csr = at === 0;   // the baseline: the same bundle mounted on an empty page, no server
  const served$ = new Promise<void>(resolve => {
    pending = res => {
      res.on("error", () => {});
      if (csr) { res.end(`<!doctype html><html><head><style>${out.css}</style></head><body><div id="app"></div></body></html>`); chunks = 1; ended = true; resolve(); return; }
      res.write(`<!doctype html><html><head>${generateHydrationScript()}<style>${out.css}</style></head><body><div id="app">`);   // CSS-4: the stylesheet is linked, not injected by the runtime
      app.stream(main(app), { write: (c: string) => { chunks++; if (!res.writableEnded) res.write(c); }, end: () => { ended = true; if (!res.writableEnded) res.end("</div></body></html>"); } });
      resolve();
    };
  });
  pageErrors.length = 0;
  const nav = page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" }).catch(() => {});
  await served$; await nav;
  for (let i = 0; i < 40 && chunks === 0 && !ended; i++) await wait(10);
  await wait(40);
  // after hydration the client is Solid's client: the spec's frame, or Solid's where an oracle divergence is recorded
  const framesOf = (r: Row) => { const div = sc.divergences.find(d => d.runner === "oracle" && d.table === t.title && d.instant === r.instant); return div ? [norm(r.frame), norm(div.frame)] : [norm(r.frame)]; };
  const matches = (r: Row, got: string) => framesOf(r).some(w => w === got || redactedMatch(w, got));
  // a `hydrated` divergence, or a `## Hydration window` frame (SV-3b, ruled): what the client shows there once it has taken
  // over a served page — from there the rows cannot be followed (a question the scenario lands was never asked), so the run stops with it
  const known = (r: Row) => !scope && sc.divergences.find(d => d.runner === "hydrated" && d.table === t.title && d.instant === r.instant);
  const land = async (r: Row, server: boolean) => {
    const m = /^(resolve|reject)\s+(\S+)\s+([\s\S]*)$/.exec(r.action)!;
    const v = parseStmts(m[3])[0]; const js = v.k === "expr" ? compileDynamicExpr(v.e) : "undefined";
    const named = /^".*"$/.test(m[2]) ? m[2].slice(1, -1) : null;
    if (!server) {   // a flight the client asked (after hydration, a new question is the client's)
      const done = await page.evaluate(([kind, name, key, js]: string[]) => {
        const c = (window as any).__client; const k = key || c.app.lastKey.get(name); const f = k && c.app.flights.get(k); if (!f) return false;
        const value = new Function("__rt", "__B", `return ${js};`)(c.app, c.app.B);
        if (kind === "reject") f.reject(value instanceof Error ? value : new Error(String(value))); else f.resolve(value);
        return true;
      }, [m[1], m[2], named ?? "", js]);
      if (done) return true;
      if (process.env.DEBUG) console.log("land on server:", r.action, await page.evaluate(() => JSON.stringify([...(window as any).__client.app.flights.keys()])));
    }
    const key = named ?? app.lastKey.get(m[2]);
    const owner = key === undefined ? undefined : [app, ...[...rpcApps].reverse()].find(a => a.flights.has(key));   // the page's request, or a server function's
    const f = owner?.flights.get(key!);
    if (!f) return false;
    const value = new Function("__rt", "__B", `return ${js};`)(owner, owner!.B);
    if (m[1] === "reject") f.reject(value instanceof Error ? value : new Error(String(value))); else f.resolve(value);
    return true;
  };
  let ok = true; const shown: string[] = []; const mark = lines.length; const rpcBefore = rpcApps.length;
  for (let i = 0; i <= chains.length; i++) {   // (i === chains.length: hydrating after the last row)
    const c = chains[i] ?? []; const r = c[0];
    if (i === at && chunks === 0 && at < served) at++;   // nothing has arrived to take over yet (a held shell, SV-1c): the client loads with the shell
    if (csr && i === 0) {
      await page.addScriptTag({ url: "/client.js", type: "module" });
      await page.evaluate(async () => { const c = (window as any).__client; c.app.mount(c.main(c.app), false); c.flush(); await new Promise(r => setTimeout(r, 30)); c.flush(); });
      const got = norm(await textOf()); shown.push(got); const last = c0last(chains);
      if (!matches(last, got)) { ok = false; lines.push(`  ✗ ${t.title} [${label}] instant ${last.instant}: expected '${framesOf(last).join("' or '")}', got '${got}'`); }
      continue;
    }
    if (i === at) {   // take the page over
      const before = norm(await textOf());
      await page.evaluate(() => { const root = document.getElementById("app")!; const els = [...root.querySelectorAll("*")].filter(n => n.tagName !== "SCRIPT" && n.tagName !== "TEMPLATE" && !n.closest("template")); for (const n of els) (n as any).__srv = 1; (window as any).__srvEls = els; });
      await page.addScriptTag({ url: "/client.js", type: "module" });
      if (process.env.DEBUG) { page.on("console", (m: any) => console.log("  page:", m.text())); await page.evaluate(() => { (window as any).__dbg = 1; }); }
      const d = await page.evaluate(async () => {
        const c = (window as any).__client; c.app.mount(c.main(c.app), true); c.flush();
        await new Promise(r => setTimeout(r, 30)); c.flush();
        const root = document.getElementById("app")!;
        const fresh = [...root.querySelectorAll("*")].filter(n => !(n as any).__srv && !n.closest("template") && n.tagName !== "SCRIPT" && n.tagName !== "TEMPLATE").map(n => n.tagName.toLowerCase());
        if ((window as any).__dbg) console.log("HY.r keys", JSON.stringify(Object.keys((window as any)._$HY.r)));
        const dropped = ((window as any).__srvEls as Element[]).filter(n => !n.isConnected).map(n => n.tagName.toLowerCase());
        return { fresh, dropped, asked: [...c.app.flights.keys()], left: c.sharedConfig.registry ? c.sharedConfig.registry.size : 0 };
      });
      const cf = clientFns(sc, src); d.asked = d.asked.filter((k: string) => !cf.has(k.split(":")[0]));   // a client question is the browser's to ask (SV-7b)
      // SV-3a: where hydration leaves the frame as the server drew it, every element is the server's (adopted, none rebuilt);
      // where the client draws a later frame at once (a landing the stream could not carry, DV-9), it builds what changed
      const same = before === norm(await textOf());
      const issues = [same && (d.fresh.length || d.dropped.length) ? `rebuilt instead of adopting: built ${d.fresh.join(" ") || "nothing"}, dropped ${d.dropped.join(" ") || "nothing"}` : "", d.asked.length ? `asked again: ${d.asked.join(", ")}` : "", d.left ? `${d.left} server element(s) never claimed` : "", pageErrors.length ? `page errors: ${pageErrors.join(" | ")}` : ""].filter(Boolean);
      // DV-15: a recorded `hydrated` divergence at this instant whose frame is the one shown: Solid rebuilt what it should adopt
      const rec = known(chains[at - 1][chains[at - 1].length - 1]);
      if (issues.length && rec && issues.every(x => x.startsWith("rebuilt")) && norm(rec.frame) === norm(await textOf())) lines.push(`  ≠ ${t.title} [${label}] hydrating after instant ${chains[at - 1][chains[at - 1].length - 1].instant}: ${issues.join("; ")}  — recorded (hydrated)`);
      else if (issues.length) { ok = false; lines.push(`  ✗ ${t.title} [${label}] hydrating after instant ${chains[at - 1][chains[at - 1].length - 1].instant}: ${issues.join("; ")}`); }
      shown.push(norm(await textOf()));
      const lastRow = chains[at - 1][chains[at - 1].length - 1]; const got = shown[shown.length - 1];
      if (!matches(lastRow, got)) { ok = false; lines.push(`  ✗ ${t.title} [${label}] hydrated after instant ${lastRow.instant}: expected '${framesOf(lastRow).join("' or '")}', got '${got}'`); }
    }
    if (i === chains.length) break;
    if (i === 0) continue;   // the mount is the request
    if (i < at && !csr) {   // still the server's: a landing streams
      if (!(await land(r, true))) { if (!ended) { ok = false; lines.push(`  ✗ ${t.title} [${label}] instant ${r.instant}: the server has no flight for ${r.action}`); } break; }
      await wait(60); continue;
    }
    try {
      if (r.action.startsWith("handler")) { const body = compileDynamic(parseStmts(r.action.slice(7))); await page.evaluate((b: string) => { const c = (window as any).__client; new Function("__rt", "__B", b)(c.app, c.app.B); c.flush(); }, body); }
      else if (/^(resolve|reject)\s/.test(r.action)) { if (!(await land(r, false))) { const k = known(r); if (k) { lines.push(`  ${k.ruled ? "✓" : "≠"} ${t.title} [${label}] instant ${r.instant}: the question was never asked on the client  — ${k.ruled ? "SV-3b hydration window" : "recorded (hydrated)"}`); break; } ok = false; lines.push(`  ✗ ${t.title} [${label}] instant ${r.instant}: no flight on either side for ${r.action}`); break; } }
      else { lines.push(`  ~ ${t.title} [${label}] instant ${r.instant}: ${r.action} not driven in the browser`); break; }
    } catch (e) { ok = false; lines.push(`  ✗ ${t.title} [${label}] instant ${r.instant}: ${(e as Error).message.split("\n")[0]}`); break; }
    await wait(Number(process.env.WAIT ?? 60));
    await page.evaluate(() => { (window as any).__client.flush(); });
    if (process.env.DEBUG_NAMES) console.log("  after", r.instant, "ended=" + ended, await page.evaluate(() => { const sc = (window as any).__client.sharedConfig; return `done=${sc.done} hydrating=${sc.hydrating} HYdone=${(window as any)._$HY.done}`; }), await page.evaluate((names: string[]) => names.map(n => { try { return n + "=" + (window as any).__client.app.fmt((window as any).__client.app.dget(n)); } catch (e) { return n + "!" + (e as Error).message; } }).join(" "), process.env.DEBUG_NAMES.split(",")));
    const got = norm(await textOf()); const last = c[c.length - 1];
    const k = known(last); if (k && got === norm(k.frame)) { lines.push(`  ${k.ruled ? "✓" : "≠"} ${t.title} [${label}] instant ${last.instant}: ${got}  — ${k.ruled ? "SV-3b hydration window" : "recorded (hydrated)"}`); break; }
    if (!matches(last, got)) { ok = false; lines.push(`  ✗ ${t.title} [${label}] instant ${last.instant}: expected '${framesOf(last).join("' or '")}', got '${got}'${pageErrors.length ? `  (page: ${pageErrors.join(" | ")})` : ""}`); break; }
    shown.push(got);
  }
  // SF-7: a server function the client called after taking over went to the server — its body is not in the bundle
  const calls = rpcApps.length - rpcBefore; const bodyShipped = /\.serverCall\(/.test(clientJs);
  if (bodyShipped) { ok = false; lines.push(`  ✗ ${t.title} [${label}]: a server function's body is in the browser bundle`); }
  if (ok) lines.push(`  ✓ ${t.title} [${label}]: ${dedupe(shown).map(x => `'${x}'`).join(" → ")}${calls ? `  (${calls} server function request${calls > 1 ? "s" : ""})` : ""}`);
  // DV-9: a boundary that failed on the server before the client took over is the client's to render, and Solid's client
  // re-renders it from scratch — asking its questions again — instead of drawing the failure it was sent
  const dv9 = !scope && at > 0 && chains.slice(0, at).flat().some(r => sc.divergences.some(d => d.runner === "server" && d.table === t.title && d.instant === r.instant));
  if (!ok && dv9) { for (let i = mark; i < lines.length; i++) lines[i] = lines[i].replace("  ✗ ", "  ≠ ") + (i === mark ? "  — DV-9" : ""); return true; }
  return ok;
}

/** SV-1 over a client table: its mount and landings, served; the server's frames, deduplicated, must be the client's in order. */
async function runTable(sc: Scenario, t: Scenario["tables"][number], base: Scenario["tables"][number] | undefined, lines: string[]): Promise<boolean> {
  const src = t.program ?? sc.program;
  let rows = t.rows; let own = 0;   // own: rows before this index are the base's, replayed to drive state
  if (t !== base && base && rows.length && rows[0].instant > 0) { const pre = base.rows.filter(r => r.instant < rows[0].instant); own = pre.length; rows = [...pre, ...rows]; }
  const chains: Row[][] = []; for (const r of rows) { if ((r.action === "(effect)" || r.action === "(flush)") && chains.length) chains[chains.length - 1].push(r); else chains.push([r]); }
  const cf = clientFns(sc, src);   // SV-7b: a client question's landing is the browser's — the stream ends before it
  const upTo = chains.findIndex(c => !(c[0].action === "mount" || (/^(resolve|reject)\s/.test(c[0].action) && !isClientRow(c[0], cf))));
  const served = upTo < 0 ? chains : chains.slice(0, upTo);
  if (!served.length || served[0][0].action !== "mount") return true;
  // A variant with its own program has no frames for the base's rows: they only drive state, and its own rows are checked.
  const from = t.program ? served.findIndex(c => rows.indexOf(c[0]) >= own) : 0;
  if (from < 0) { lines.push(`  ~ ${t.title}: a variant program whose own rows begin after a handler`); return true; }
  // the client's frames for these instants: the spec's, or the oracle's where a divergence is recorded — every row of a
  // chain, since the server runs no effect (SV-2) and shows the frame before an effect's chain lands
  // (a `server` divergence: what Solid's server render shows there instead — DV-9)
  const served1 = (f: string) => f.split(" » ")[0];   // PT-3: the server renders nothing for a portal — the browser does, once it has the page
  const frameOf = (r: Row) => { const sv = !scope && sc.divergences.find(d => d.runner === "server" && d.table === t.title && d.instant === r.instant); if (sv) return norm(sv.frame); const div = sc.divergences.find(d => d.runner === "oracle" && d.table === t.title && d.instant === r.instant); return norm(served1(div ? div.frame : r.frame)); };
  const want = served.slice(from).flatMap(c => c.map(frameOf));
  const res = await serve(sc, src, served.map(c => c[0]), t.title, lines);
  if (!res) return res !== false;
  const g = dedupe(res.got.slice(from)); const w = dedupe(want);
  let j = 0;
  for (const [i, s] of g.entries()) {
    const k = w.findIndex((x, n) => n >= j && (x === s || redactedMatch(x, s)));
    if (k < 0 || (i === 0 && from === 0 && k !== 0)) { lines.push(`  ✗ ${t.title}: server frame '${s}' is not ${i === 0 && from === 0 ? "the mount's" : "a later client frame"} (client: ${w.map(x => `'${x}'`).join(" → ")})  (${res.file})`); return false; }
    j = k + 1;
  }
  lines.push(`  ✓ ${t.title}: ${g.map(x => `'${x}'`).join(" → ")}${res.ended ? "" : "  (stream open)"}`);
  if (from !== 0 || !hydrating) return true;
  // SV-3: hydrate after the last landing the server streamed, and (when there are landings) right after the shell
  let ok = await hydrated(sc, t, src, chains, served.length, served.length, "hydrated late", lines);
  if (served.length > 1) ok = (await hydrated(sc, t, src, chains, served.length, 1, "hydrated early", lines)) && ok;
  if (baseline) ok = (await hydrated(sc, t, src, chains, served.length, 0, "browser, no server", lines)) && ok;
  return ok;
}
const hydrating = !process.env.NO_HYDRATE;
const baseline = !!process.env.CSR;   // also mount each table client-side in the browser, no server (rt-web.ts alone)

/** `## Server frames`: exactly what the browser shows from the stream, row by row (a `server` divergence where Solid differs). */
async function runServerTable(sc: Scenario, lines: string[]): Promise<boolean> {
  const title = "Server frames";
  const other = { chunks: [] as string[] };
  const res = await serve(sc, sc.program, sc.server, title, lines, other);
  if (!res) return res !== false;
  let ok = true;
  // SV-4: the landings were the first request's; the second, sharing every module, still shows its shell
  if (other.chunks.length !== 1) { ok = false; lines.push(`  ✗ ${title}: a concurrent request received ${other.chunks.length} chunks — module state leaked across requests`); }
  else lines.push(`  ✓ ${title}: a concurrent request kept its own shell (SV-4)`);
  sc.server.forEach((r, i) => {
    const div = sc.divergences.find(d => d.runner === "server" && d.table === title && d.instant === r.instant);
    const want = norm(div && !scope ? div.frame : r.frame); const got = res.got[i];
    if (got === want) lines.push(`  ${div && !scope ? "≠" : "✓"} ${title} instant ${r.instant}: ${got}`);
    else { ok = false; lines.push(`  ✗ ${title} instant ${r.instant}: expected '${want}', got '${got ?? "(no frame)"}'  (${res.file})`); }
  });
  return ok;
}
/** `## Before hydration` (SV-3e): the user acts on the served page — `click "<selector>"`, `input "<selector>" "<text>"` —
 *  before the client has taken over; `hydrate` takes it over, and the recorded events replay through the handlers in order.
 *  Rows after `hydrate` are ordinary client instants. */
async function runBeforeHydration(sc: Scenario, lines: string[]): Promise<boolean> {
  const title = "Before hydration"; const rows = sc.before;
  if (!rows.length || rows[0].action !== "mount") { lines.push(`  ✗ ${title}: the first row is the mount`); return false; }
  let out: Built;
  try { const set = moduleSet(sc, sc.program); if (checkModules(set).diags.length) { lines.push(`  ~ ${title}: refused by the checker`); return true; } out = build(sc, sc.program, []); }
  catch (e) { if (e instanceof CompileError) { lines.push(`  ~ ${title}: not compiled — ${e.message}`); return true; } lines.push(`  ✗ ${title}: ${(e as Error).message}`); return false; }
  const dir = `${outDir}${sc.name}.${++seq}/`; mkdirSync(dir, { recursive: true });
  for (const [name, js] of out.views("ssr")) writeFileSync(dir + name, directives(js, dir + name, "server"));
  const main = (await import(pathToFileURL(dir + out.entry).href)).default;
  clientJs = bundle(dir, out.views("dom"), out.entry);
  const app = createApp(); let chunks = 0;
  const served$ = new Promise<void>(resolve => {
    pending = res => {
      res.on("error", () => {});
      res.write(`<!doctype html><html><head>${generateHydrationScript()}<style>${out.css}</style></head><body><div id="app">`);   // CSS-4: the stylesheet is linked, not injected by the runtime
      app.stream(main(app), { write: (c: string) => { chunks++; if (!res.writableEnded) res.write(c); }, end: () => { if (!res.writableEnded) res.end("</div></body></html>"); } });
      resolve();
    };
  });
  pageErrors.length = 0;
  const nav = page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" }).catch(() => {});
  await served$; await nav;
  for (let i = 0; i < 40 && chunks === 0; i++) await wait(10);
  await wait(40);
  let ok = true; let hydrated = false;
  for (const r of rows) {
    const m = /^(click|input)\s+"([^"]*)"(?:\s+"([^"]*)")?$/.exec(r.action);
    try {
      if (r.action === "mount") { /* the request */ }
      else if (m && m[1] === "click") await page.click(m[2]);
      else if (m && m[1] === "input") await page.fill(m[2], m[3] ?? "");   // fill dispatches `input`, which the bootstrap records
      else if (r.action === "hydrate") {
        await page.addScriptTag({ url: "/client.js", type: "module" });
        await page.evaluate(async () => { const c = (window as any).__client; c.app.mount(c.main(c.app), true); c.flush(); await new Promise(r => setTimeout(r, 30)); c.flush(); });
        hydrated = true;
      }
      else { lines.push(`  ✗ ${title} instant ${r.instant}: a before-hydration table has mount, click, input and hydrate rows`); return false; }
    } catch (e) { lines.push(`  ✗ ${title} instant ${r.instant}: ${(e as Error).message.split("\n")[0]}`); return false; }
    await wait(60); if (hydrated) await page.evaluate(() => { (window as any).__client.flush(); });
    const got = norm(await textOf()); const div = sc.divergences.find(d => d.runner === "hydrated" && d.table === title && d.instant === r.instant); const want = norm(div ? div.frame : r.frame);
    if (got === want) lines.push(`  ${div ? "≠" : "✓"} ${title} instant ${r.instant}: ${got}${div ? "  — recorded (hydrated)" : ""}`);
    else { ok = false; lines.push(`  ✗ ${title} instant ${r.instant}: expected '${want}', got '${got}'${pageErrors.length ? `  (page: ${pageErrors.join(" | ")})` : ""}`); }
  }
  return ok;
}
const scope = !!process.env.SV_SCOPE;   // probe: render inside Solid's server-component scope, where a failure after the shell streams its fallback (DV-9)
/** A client frame that shows a panic's message, shown by the server as Solid's generic message. */
function redactedMatch(client: string, server: string): boolean {
  if (!server.includes(REDACTED)) return false;
  const [pre, post] = server.split(REDACTED);
  return client.startsWith(pre) && client.endsWith(post) && client.length > pre.length + post.length - 1;
}

const filter = process.argv[2];
const dir = new URL("../../scenarios/", import.meta.url);
let pass = 0, fail = 0, skip = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith(".md") && f !== "TEMPLATE.md" && !f.startsWith("OPEN-") && (!filter || f.includes(filter))).sort()) {
  const sc = parseScenario(f.replace(/\.md$/, ""), readFileSync(new URL(f, dir), "utf8"), fileURLToPath(dir));
  const lines: string[] = []; let ok = true;
  const base = sc.tables.find(t => t.title === "Frames");
  for (const t of sc.tables) { try { ok = (await runTable(sc, t, base, lines)) && ok; } catch (e) { ok = false; lines.push(`  ✗ ${t.title}: ${(e as Error).stack}`); } }
  if (sc.server.length) { try { ok = (await runServerTable(sc, lines)) && ok; } catch (e) { ok = false; lines.push(`  ✗ Server frames: ${(e as Error).stack}`); } }
  if (sc.before.length) { try { ok = (await runBeforeHydration(sc, lines)) && ok; } catch (e) { ok = false; lines.push(`  ✗ Before hydration: ${(e as Error).stack}`); } }
  const skipped = lines.some(l => l.includes("~ ")) && !lines.some(l => l.includes("✗"));
  console.log(`${ok ? (skipped ? "SKIP" : "PASS") : "FAIL"} ${sc.name}`); for (const l of lines) console.log(l);
  if (!ok) fail++; else if (skipped) skip++; else pass++;
}
console.log(`\n${pass} pass, ${fail} fail, ${skip} skip (server render → ${SOLID}, streamed to Chromium)`);
await browser.close(); http.close();
process.exit(fail ? 1 : 0);
