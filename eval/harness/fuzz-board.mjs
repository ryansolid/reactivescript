// The board's timing fuzzer (round 15). No per-app tests: a seeded random session of user moves and backend answers
// (land or fail, in any order, also after the page was left) against a fake server that keeps the truth, checked by
// oracles every board app must pass whatever the agent built. The brief is tasks/board/brief-plain.md.
//
// Every frame, on the board page (a column counts once its heading reads "(n)"):
// - duplicate card: no card id shows twice, and an added card never shows beside its own "(adding…)" row;
// - heading: a loaded column's heading counts the cards it shows;
// - count: the selected card's "<done>/<total>" equals the checklist's "<done>/<total> done" while both show;
// - limit: while Doing shows 3 or more cards, every To do card's right and every Done card's left is disabled;
// - detail: the selected card's detail names the column it shows in, and the title its card shows (two views).
// Settled (nothing in the air), on the board page with all three columns loaded, and at the end of a session:
// - the columns hold the server's cards, with its titles and counts, in its order; the selected card's checklist
//   is the server's. On the archive page: its rows are the server's archive.
// Allowances, the same for every arm:
// - B1 (brief: leaving a page discards it): a write that answers after its page was left need not show on the next
//   visit, so a visit where one landed is not checked settled (Ryan, 2026-11-14: late writes are out of scope).
// - B2 (brief: "if the server accepts, the card stays where it was moved"): after two moves overlapped in the air, a
//   column's order is not checked settled for the rest of the visit, only which cards it holds. An app asked to keep a
//   card where it showed it cannot know an order the server made from answers it applied in another order.
// - Two accepted writes to one field: settled, the field must show the server's last answer (Ryan, 2026-11-14).
// Usage: node harness/fuzz-board.mjs <dir> [--seeds N] [--steps N] [--from S] [--json out.json] [--log]
// (--r9 and --r15 are accepted and ignored, so harness/grade.sh can pass its round flag.)
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "./build.mjs";
import { launch, serve } from "./driver.mjs";

const norm = s => (s ?? "").replace(/\s+/g, " ").trim();
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const COLS = ["todo", "doing", "done"];
const NAME = { todo: "To do", doing: "Doing", done: "Done" };
const TITLES = ["Alpha", "Bravo", "Delta"];
const ITEMS = ["ship", "docs", "qa"];
const WRITES = new Set(["moveCard", "renameCard", "addCard", "archiveCard", "toggleItem", "addItem", "restoreCard"]);

export function freshServer() {
  return {
    cols: {
      todo: [{ id: 1, title: "Write spec" }, { id: 2, title: "Fix login" }],
      doing: [{ id: 3, title: "Review PR" }, { id: 4, title: "Deploy" }],
      done: [{ id: 5, title: "Kickoff" }],
    },
    items: {
      1: [{ id: 11, text: "outline", done: false }, { id: 12, text: "draft", done: false }],
      2: [{ id: 21, text: "repro", done: true }, { id: 22, text: "patch", done: false }, { id: 23, text: "test", done: false }],
      3: [{ id: 31, text: "read", done: true }, { id: 32, text: "approve", done: true }],
      4: [{ id: 41, text: "release", done: false }],
      5: [{ id: 51, text: "invite", done: true }, { id: 52, text: "agenda", done: true }, { id: 53, text: "notes", done: true }],
      8: [], 9: [{ id: 91, text: "try it", done: true }],
    },
    archived: [{ id: 8, title: "Old idea" }, { id: 9, title: "Spike" }],
    nextCard: 10, nextItem: 100,
  };
}
const withCounts = (srv, c) => { const xs = srv.items[c.id] ?? []; return { id: c.id, title: c.title, done: xs.filter(x => x.done).length, total: xs.length }; };
const where = (srv, id) => { for (const col of COLS) { const i = srv.cols[col].findIndex(c => c.id === id); if (i >= 0) return [col, i]; } return null; };

/** the answer the server gives `key` now, applying a write; `fail` = the server declines / the read fails */
export function answer(srv, key, fail) {
  if (fail) return { fail: true };
  const i = key.indexOf(":"); const name = key.slice(0, i); const a = key.slice(i + 1).split(",");
  switch (name) {
    case "fetchCards": return { value: srv.cols[a[0]].map(c => withCounts(srv, c)) };
    case "moveCard": {
      const id = Number(a[0]); const w = where(srv, id); if (!w) return { fail: true };
      const [c] = srv.cols[w[0]].splice(w[1], 1); const to = srv.cols[a[1]]; const at = Math.max(0, Math.min(Number(a[2]), to.length));
      to.splice(at, 0, c); return { value: { id, column: a[1], index: at } };
    }
    case "renameCard": {
      const id = Number(a[0]); const title = a.slice(1).join(",");
      const w = where(srv, id); const x = w ? srv.cols[w[0]][w[1]] : srv.archived.find(c => c.id === id); if (!x) return { fail: true };
      x.title = title; return { value: { id, title } };
    }
    case "addCard": { const c = { id: srv.nextCard++, title: a.slice(1).join(",") }; srv.cols[a[0]].push(c); srv.items[c.id] = []; return { value: { id: c.id, title: c.title } }; }
    case "archiveCard": { const id = Number(a[0]); const w = where(srv, id); if (!w) return { fail: true }; const [c] = srv.cols[w[0]].splice(w[1], 1); srv.archived.unshift(c); return { value: { id } }; }
    case "fetchChecklist": return { value: srv.items[a[0]] ?? [] };
    case "toggleItem": { const x = (srv.items[a[0]] ?? []).find(t => t.id === Number(a[1])); if (!x) return { fail: true }; x.done = a[2] === "true"; return { value: { id: x.id, done: x.done } }; }
    case "addItem": { const x = { id: srv.nextItem++, text: a.slice(1).join(","), done: false }; srv.items[a[0]] = [...(srv.items[a[0]] ?? []), x]; return { value: x }; }
    case "fetchArchived": return { value: srv.archived.map(c => ({ ...c })) };
    case "restoreCard": { const id = Number(a[0]); const k = srv.archived.findIndex(c => c.id === id); if (k < 0) return { fail: true }; const [c] = srv.archived.splice(k, 1); srv.cols.todo.push(c); return { value: { id } }; }
    default: return { value: null };
  }
}

const CARD = /^#(\d+) (.*) · (\d+)\/(\d+)$/;
const ADDING = /^(.*) \(adding…\)$/;

/** one session; returns the violations it found (each with the step and the log so far) */
async function session(browser, url, seed, steps, log) {
  const r = rng(seed); const pick = xs => xs[Math.floor(r() * xs.length)];
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const settle = () => page.waitForTimeout(60);
  const sel = id => `[data-testid="${id}"]`;
  const srv = freshServer();
  const ui = { page: "board", selected: null, visit: 0 };
  const writeVisit = new Map();          // write key -> the visit (board or archive) it was made on
  const settledCount = new Map();
  let lateVisit = false;                 // B1
  let looseOrder = false;                // B2
  const trail = []; const found = [];
  let made = 0;   // added cards and items get distinct texts: two adds of one text would be one flight to the harness
  const pending = () => page.evaluate(() => globalThis.__flights.pending());
  const exists = async id => (await page.locator(sel(id)).count()) > 0;
  const text = async id => (await exists(id)) ? norm(await page.locator(sel(id)).first().textContent()) : null;
  const note = (kind, detail) => { if (!found.length) found.push({ seed, step: trail.length, kind, detail, trail: [...trail] }); };
  const track = async () => {
    const ks = await pending();
    for (const k of ks) if (WRITES.has(k.slice(0, k.indexOf(":"))) && !writeVisit.has(k)) writeVisit.set(k, ui.visit);
    if (ks.filter(k => k.startsWith("moveCard:")).length >= 2) looseOrder = true;
  };

  // what the board shows: per column, null when it isn't loaded, else its rows
  async function board() {
    const out = {};
    for (const col of COLS) {
      const head = await text(`head-${col}`);
      const m = head && head.match(/\((\d+)\)\s*$/);
      if (!m) { out[col] = null; continue; }
      const rows = (await page.locator(`${sel(`col-${col}`)} ${sel("card")}`).allTextContents()).map(norm);
      out[col] = { n: Number(m[1]), rows: rows.map(t => { const c = t.match(CARD); if (c) return { id: Number(c[1]), title: c[2], done: Number(c[3]), total: Number(c[4]), text: t }; const g = t.match(ADDING); return { adding: true, title: g ? g[1] : t, text: t }; }) };
    }
    return out;
  }

  async function everyFrame(settled) {
    if (ui.page === "archive") {
      if (!settled) return;
      const list = await text("archived");
      if (!list || /loading|error/.test(list)) return;
      const rows = (await page.locator(sel("archived-card")).allTextContents()).map(norm);
      const want = srv.archived.map(c => `#${c.id} ${c.title}`);
      if (!lateVisit && JSON.stringify(rows) !== JSON.stringify(want)) note("settled: archive", `shows ${JSON.stringify(rows)}, server ${JSON.stringify(want)}`);
      return;
    }
    const b = await board();
    const seen = new Map();
    for (const col of COLS) {
      const c = b[col]; if (!c) continue;
      if (c.n !== c.rows.length) note("heading", `head-${col} counts ${c.n}, the column shows ${c.rows.length} cards`);
      for (const x of c.rows) if (!x.adding) { if (seen.has(x.id)) note("duplicate card", `#${x.id} shows in ${seen.get(x.id)} and ${col}`); seen.set(x.id, col); }
    }
    const placeholders = COLS.flatMap(col => (b[col]?.rows ?? []).filter(x => x.adding).map(x => x.title));
    const addsOut = (await pending()).filter(k => k.startsWith("addCard:")).map(k => k.slice(k.indexOf(",") + 1));
    for (const t of new Set(placeholders)) {
      const shownReal = COLS.flatMap(col => (b[col]?.rows ?? []).filter(x => !x.adding && x.title === t && x.id >= 10)).length;
      const n = placeholders.filter(p => p === t).length, out = addsOut.filter(a => a === t).length;
      if (n > out) note("duplicate card", `"${t} (adding…)" shows ${n} time(s) with ${out} add(s) of it in the air${shownReal ? ", beside its added card" : ""}`);
    }
    // the work-in-progress limit
    if (b.doing && b.doing.rows.length >= 3) {
      for (const [col, dir] of [["todo", "right"], ["done", "left"]]) {
        const btns = page.locator(`${sel(`col-${col}`)} ${sel(dir)}`);
        for (let k = 0; k < await btns.count(); k++) if (!(await btns.nth(k).isDisabled())) { note("limit", `Doing shows ${b.doing.rows.length} cards and a ${NAME[col]} card's ${dir} is enabled`); break; }
      }
    }
    // the detail against the card it shows
    const detail = await text("detail");
    if (ui.selected != null && detail && !/select a card/.test(detail)) {
      const col = COLS.find(cl => b[cl]?.rows.some(x => x.id === ui.selected));
      const x = col && b[col].rows.find(y => y.id === ui.selected);
      if (x) {
        if (!detail.includes(`in ${NAME[col]}`)) note("detail column", `#${x.id} shows in ${NAME[col]}, the detail says "${detail.slice(0, 80)}"`);
        if (!detail.includes(`#${x.id} ${x.title}`)) note("two views", `card "${x.text}", detail "${detail.slice(0, 80)}"`);
        const prog = await text("progress"); const m = prog && prog.match(/^(\d+)\/(\d+) done$/);
        const list = await text("checklist");
        if (m && list && !/loading|error/.test(list) && (Number(m[1]) !== x.done || Number(m[2]) !== x.total)) note("count", `card "${x.text}", progress "${prog}"`);
      }
    }
    if (!settled || lateVisit || !COLS.every(col => b[col])) return;
    for (const col of COLS) {
      const want = srv.cols[col].map(c => withCounts(srv, c));
      const got = b[col].rows;
      if (got.some(x => x.adding)) { note(`settled: ${col}`, `an "(adding…)" row with nothing in the air`); continue; }
      const ids = got.map(x => x.id), wids = want.map(x => x.id);
      const same = looseOrder ? JSON.stringify([...ids].sort()) === JSON.stringify([...wids].sort()) : JSON.stringify(ids) === JSON.stringify(wids);
      if (!same) { note(`settled: ${col}`, `shows [${ids}], server [${wids}]${looseOrder ? " (order not checked)" : ""}`); continue; }
      for (const x of got) { const w = want.find(y => y.id === x.id); if (x.title !== w.title || x.done !== w.done || x.total !== w.total) note(`settled: card`, `"${x.text}", server "#${w.id} ${w.title} · ${w.done}/${w.total}"`); }
    }
    if (ui.selected != null && b && COLS.some(col => b[col].rows.some(x => x.id === ui.selected))) {
      const list = await text("checklist");
      if (list && !/loading|error/.test(list)) {
        const rows = (await page.locator(sel("item")).allTextContents()).map(norm);
        const want = (srv.items[ui.selected] ?? []).map(t => `${t.done ? "[x]" : "[ ]"} ${t.text}`);
        if (JSON.stringify(rows) !== JSON.stringify(want)) note("settled: checklist", `#${ui.selected} shows ${JSON.stringify(rows)}, server ${JSON.stringify(want)}`);
      }
    }
  }

  async function answerOne(keys) {
    const key = pick(keys); const name = key.slice(0, key.indexOf(":"));
    const fail = r() < (WRITES.has(name) ? 0.3 : 0.1);
    const times = Math.max(1, (await page.evaluate(k => globalThis.__flights.asked().filter(x => x === k).length, key)) - (settledCount.get(key) ?? 0));
    settledCount.set(key, (settledCount.get(key) ?? 0) + times);
    let a; for (let t = 0; t < times; t++) a = answer(srv, key, fail);
    if (WRITES.has(name) && !a.fail && writeVisit.get(key) !== ui.visit) lateVisit = true;   // B1
    writeVisit.delete(key);
    trail.push(`${a.fail ? "fail" : "land"} ${key}`);
    await page.evaluate(([k, a]) => a.fail ? globalThis.__flights.fail(k, "declined") : globalThis.__flights.land(k, a.value), [key, a]);
    await settle();
  }

  async function move() {
    const opts = [];
    const click = async (id, nth = 0) => { await page.locator(sel(id)).nth(nth).click({ timeout: 2000 }); };
    if (ui.page === "board") {
      const cards = page.locator(sel("card"));
      const n = await cards.count();
      if (n) opts.push(["select", 3], ["move", 6]);
      for (const col of COLS) if (await exists(`retry-${col}`)) opts.push([`retry-${col}`, 2]);
      opts.push(["add", 2], ["archive-tab", 1]);
      if (ui.selected != null && await exists("rename")) opts.push(["rename", 3], ["archive", 1]);
      if (await exists("toggle")) opts.push(["toggle", 3]);
      if (await exists("add-item")) opts.push(["add-item", 2]);
    } else {
      if (await exists("restore")) opts.push(["restore", 3]);
      opts.push(["board-tab", 2]);
    }
    let total = opts.reduce((s, [, w]) => s + w, 0), x = r() * total, choice = opts[0][0];
    for (const [k, w] of opts) { if ((x -= w) < 0) { choice = k; break; } }
    switch (choice) {
      case "select": {
        const ids = (await page.locator(sel("card")).allTextContents()).map(norm).map(t => t.match(CARD)).filter(Boolean).map(m => Number(m[1]));
        if (!ids.length) return; const id = pick(ids); trail.push(`select #${id}`);
        await page.locator(sel("card"), { hasText: new RegExp(`^\\s*#${id} `) }).first().click({ timeout: 2000 }); ui.selected = id; break;
      }
      case "move": {
        const btns = [];
        for (const dir of ["left", "right", "up", "down"]) { const l = page.locator(sel(dir)); for (let k = 0; k < await l.count(); k++) if (!(await l.nth(k).isDisabled())) btns.push([dir, k]); }
        if (!btns.length) return; const [dir, k] = pick(btns);
        const owner = norm(await page.locator(sel(dir)).nth(k).locator(`xpath=ancestor::*[count(.//*[@data-testid="card"]) = 1][1]`).locator(sel("card")).first().textContent().catch(() => "?"));
        trail.push(`${dir} ${owner.match(/^#\d+/)?.[0] ?? owner}`); await click(dir, k); break;
      }
      case "add": { const t = `${pick(TITLES)} ${++made}`; trail.push(`add ${t}`); await page.locator(sel("new-card")).first().fill(t, { timeout: 2000 }); await click("add-card"); break; }
      case "rename": { const t = pick(TITLES); trail.push(`rename ${t}`); await page.locator(sel("title-input")).first().fill(t, { timeout: 2000 }); await click("rename"); break; }
      case "archive": trail.push(`archive #${ui.selected}`); await click("archive"); ui.selected = null; break;
      case "toggle": { const n = await page.locator(sel("toggle")).count(); const k = Math.floor(r() * n); trail.push(`toggle ${k}`); await click("toggle", k); break; }
      case "add-item": { const t = `${pick(ITEMS)} ${++made}`; trail.push(`add-item ${t}`); await page.locator(sel("item-input")).first().fill(t, { timeout: 2000 }); await click("add-item"); break; }
      case "archive-tab": trail.push("tab archive"); await click("tab-archive"); ui.page = "archive"; ui.selected = null; ui.visit++; lateVisit = false; looseOrder = false; break;
      case "board-tab": trail.push("tab board"); await click("tab-board"); ui.page = "board"; ui.selected = null; ui.visit++; lateVisit = false; looseOrder = false; break;
      case "restore": { const n = await page.locator(sel("restore")).count(); const k = Math.floor(r() * n); trail.push(`restore ${k}`); await click("restore", k); break; }
      default: if (choice.startsWith("retry-")) { trail.push(choice); await click(choice); }
    }
    await settle();
  }

  try {
    await page.goto(url); await page.waitForFunction(() => globalThis.__flights !== undefined, null, { timeout: 5000 }).catch(() => {});
    await settle();
    for (let s = 0; s < steps && !found.length; s++) {
      await track();
      const keys = await pending();
      if (keys.length && r() < 0.4) await answerOne(keys); else await move().catch(e => { trail.push(`(move failed: ${e.message.split("\n")[0].slice(0, 80)})`); });
      await track();
      await everyFrame((await pending()).length === 0);
    }
    for (let guard = 0; !found.length && guard < 200; guard++) {
      await track();
      const keys = await pending();
      if (!keys.length) break;
      await answerOne(keys); await track(); await everyFrame((await pending()).length === 0);
    }
    if (errors.length && !found.length) note("page error", errors[0].slice(0, 120));
  } finally { await page.close(); }
  if (log) console.log(`seed ${seed}: ${trail.join(" ; ")}`);
  return found.slice(0, 1);
}

export async function fuzz(dir, { seeds = 20, steps = 30, from = 1, log = false } = {}) {
  const b = await build(dir);
  if (!b.ok) return { dir, build: false, seeds, violations: [] };
  const server = await serve(b.dist); let browser = await launch();
  const violations = [];
  try {
    for (let s = from; s < from + seeds; s++) {
      try { let t; violations.push(...await Promise.race([session(browser, server.url, s, steps, log), new Promise((_, rej) => { t = setTimeout(() => rej(new Error("session timed out (120 s): the page hangs")), 120000); })]).finally(() => clearTimeout(t))); }
      catch (e) { violations.push({ seed: s, step: -1, kind: "page crash", detail: e.message.split("\n")[0].slice(0, 120), trail: [] }); await browser.close().catch(() => {}); browser = await launch(); }
    }
  } finally { await browser.close(); server.close(); }
  return { dir, build: true, seeds, violations };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2); const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const res = await fuzz(path.resolve(a[0]), { seeds: Number(opt("--seeds", 20)), steps: Number(opt("--steps", 30)), from: Number(opt("--from", 1)), log: a.includes("--log") });
  console.log(`${path.basename(res.dir)}: ${res.build ? `${res.violations.length}/${res.seeds} seeds found a hole` : "build failed"}`);
  for (const v of res.violations) console.log(`  seed ${v.seed} step ${v.step}: ${v.kind}: ${v.detail}\n    ${v.trail.join(" ; ")}`);
  if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(res, null, 2) + "\n");
}
