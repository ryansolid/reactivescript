// Round 8: an async timing fuzzer for the issue desk (rounds 5-7 apps). No per-app tests: a seeded random session of
// user moves and backend answers (land or fail, in any order, after the page was left), against a fake server that
// keeps the truth, checked by two oracles every desk must pass whatever the agent built:
// - every frame (after each step, once the page settles): each issue row and the detail heading show the server's
//   value or the value of a write still in flight; no row the server has closed shows in the open list; no open
//   row is missing unless a close of it is in flight; the detail shows the selected issue.
// - at rest (nothing in flight, at the end of a session): the issues page matches the server: the rows, assignees,
//   titles, the tab count, and the selected issue's heading, labels and comments.
// Allowances, the same for every arm (FUZZ-A1..A3 in PREREG-fuzz-8.md):
// - A1 (one change, H-11): a declined write's value, or a declined close's missing row, may show while any other
//   write is in flight.
// - A2 (newest wins): with several writes to one field accepted in one busy period, at rest the field may show the
//   newest one started instead of the one the server took last.
// - A3: the count is checked only at rest, on the issues page, with the open list on screen.
// Round 9 (`--r9`, PREREG-fuzz-9.md) adds a move and three oracles every frame, the same for every arm:
// - focus: the window is hidden and shown again (a user switching tabs);
// - dropped guess: a write's value, once shown, stays while the write is in flight and no newer write to that field
//   started (Ryan, 2026-10-27: a guess holds until the server answers it); a closed row stays out the same way;
// - two views: an issue's row and the detail heading show the same title;
// - count: with the open list on screen, the tab count equals its rows.
// Writes weigh twice as much among the moves and answers come a little less often (0.4), so writes overlap.
// Usage: node harness/fuzz.mjs <dir> [--seeds N] [--steps N] [--from S] [--r9] [--json out.json] [--log]
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "./build.mjs";
import { launch, serve } from "./driver.mjs";

const norm = s => (s ?? "").replace(/\s+/g, " ").trim();
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const USERS = ["ann", "bob", "guest"];
const TITLES = ["Alpha", "Bravo", "Delta"];
const LABELS = ["bug", "ui", "p1"];
const TEXTS = ["me too", "fixed?", "ping"];

export function freshServer() {
  return {
    issues: [
      { id: 1, title: "Login fails", assignee: null, open: true, body: "on Safari only" },
      { id: 2, title: "Old bug", assignee: "eve", open: false, body: "long gone" },
      { id: 3, title: "Crash on save", assignee: null, open: true, body: "stack trace attached" },
      { id: 4, title: "Typo in footer", assignee: "dana", open: true, body: "footer says 2019" },
    ],
    comments: { 1: [], 2: [], 3: [{ author: "dana", text: "seen it too" }], 4: [] },
    labels: { 1: [], 2: ["old"], 3: ["bug", "ui"], 4: ["docs"] },
  };
}
const row = i => ({ id: i.id, title: i.title, assignee: i.assignee });
const WRITES = new Set(["assign", "renameIssue", "closeIssue", "addComment", "addLabel", "removeLabel", "saveSettings"]);

/** the answer the server gives `key` now, applying a write; `fail` = the server declines / the read fails */
export function answer(srv, key, fail) {
  const i = key.indexOf(":"); const name = key.slice(0, i); const args = key.slice(i + 1).split(",");
  const issue = id => srv.issues.find(x => x.id === Number(id));
  if (fail) return { fail: true };
  switch (name) {
    case "fetchIssues": return { value: srv.issues.filter(x => x.open === (args[0] === "open")).map(row) };
    case "fetchIssue": { const x = issue(args[0]); return { value: x ? { id: x.id, title: x.title, body: x.body } : null }; }
    case "assign": { const x = issue(args[0]); x.assignee = args[1]; return { value: { id: x.id, assignee: x.assignee } }; }
    case "renameIssue": { const x = issue(args[0]); x.title = args.slice(1).join(","); return { value: { id: x.id, title: x.title } }; }
    case "closeIssue": { const x = issue(args[0]); x.open = false; return { value: { id: x.id } }; }
    case "fetchComments": return { value: srv.comments[args[0]] ?? [] };
    case "addComment": { const c = { author: args[1], text: args.slice(2).join(",") }; srv.comments[args[0]] = [...(srv.comments[args[0]] ?? []), c]; return { value: c }; }
    case "fetchLabels": return { value: srv.labels[args[0]] ?? [] };
    case "addLabel": { const l = srv.labels[args[0]] ?? []; if (!l.includes(args[1])) srv.labels[args[0]] = [...l, args[1]]; return { value: srv.labels[args[0]] }; }
    case "removeLabel": { srv.labels[args[0]] = (srv.labels[args[0]] ?? []).filter(l => l !== args[1]); return { value: srv.labels[args[0]] }; }
    case "search": return { value: args.join(",").length >= 2 ? [{ id: 7, name: "saving files" }, { id: 8, name: "crash reports" }] : [] };
    case "fetchItem": return { value: { id: Number(args[0]), name: `item ${args[0]}`, blurb: "about it" } };
    case "loadSettings": return { value: { name: "Ann", theme: "light", density: "compact" } };
    default: return { value: null };
  }
}

/** one session; returns the violations it found (each with the step and the log so far) */
async function session(browser, url, seed, steps, log, r9 = false) {
  const r = rng(seed); const pick = xs => xs[Math.floor(r() * xs.length)];
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", e => { errors.push(e.message); if (process.env.FUZZ_STACK) console.log("PAGEERROR after", trail.at(-1), trail.length, e.message); });
  const settle = () => page.waitForTimeout(60);
  const sel = id => `[data-testid="${id}"]`;
  const srv = freshServer();
  const ui = { page: "issues", filter: "open", selected: null };
  // writes in flight (key -> { issue, field, value }); declined values per issue/field during the busy period;
  // accepted writes per field in this busy period, in start order
  const writes = new Map(); let declined = []; let started = []; let seq = 0; let gen = 0; let stale = []; let held = { filters: new Set(), selections: new Set(), rows: new Set() }; const settledCount = new Map();
  const trail = []; const found = [];
  const pending = () => page.evaluate(() => globalThis.__flights.pending());
  const texts = async id => (await page.locator(sel(id)).allTextContents()).map(norm);
  const exists = async id => (await page.locator(sel(id)).count()) > 0;
  const text = async id => (await exists(id)) ? norm(await page.locator(sel(id)).first().textContent()) : null;
  const note = (kind, detail) => { found.push({ seed, step: trail.length, kind, detail, trail: [...trail] }); };
  const writeOf = key => {
    const [name, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)]; const a = rest.split(",");
    if (name === "assign") return { issue: Number(a[0]), field: "assignee", value: a[1] };
    if (name === "renameIssue") return { issue: Number(a[0]), field: "title", value: a.slice(1).join(",") };
    if (name === "closeIssue") return { issue: Number(a[0]), field: "open", value: false };
    return { issue: Number(a[0]), field: name, value: a.slice(1).join(",") };
  };
  // a write asked again while its first ask is in the air (one key to the test) is started again: it moves to the newest
  const askCount = new Map();
  const track = async () => {
    const asked = await page.evaluate(() => globalThis.__flights.asked()); const count = k => asked.filter(x => x === k).length;
    for (const k of await pending()) {
      if (!WRITES.has(k.slice(0, k.indexOf(":")))) continue;
      if (!writes.has(k)) { if (!writes.size) started = []; const w = { ...writeOf(k), seq: seq++, gen }; writes.set(k, w); started.push(w); }
      else if (count(k) > askCount.get(k)) { const w = writes.get(k); started.splice(started.indexOf(w), 1); w.seq = seq++; started.push(w); }
      askCount.set(k, count(k));
    }
  };
  const busy = () => writes.size > 0;
  let inFlight = false;   // anything in the air at this frame (A1: an action runs until its refresh answers)
  const allowed = (id, field) => {
    const x = srv.issues.find(i => i.id === id); const vals = new Set([x[field]]);
    for (const w of writes.values()) if (w.issue === id && w.field === field) vals.add(w.value);
    if (inFlight) for (const d of declined) if (d.issue === id && d.field === field) vals.add(d.value);   // A1
    for (const t of stale) if (t.issue === id && t.field === field) vals.add(t.before);   // A4
    for (const w of started) if (w.accepted && w.issue === id && w.field === field && (busy() || w === started.filter(s => s.accepted && s.issue === id && s.field === field).at(-1))) vals.add(w.value);   // A2
    return vals;
  };

  function listViolations(parsed, filter, valuesToo = true) {
    const out = [];
    for (const p of parsed) {
      const x = srv.issues.find(i => i.id === p.id);
      if (!x) { out.push(["unknown row", `#${p.id}`]); continue; }
      if (valuesToo && !allowed(p.id, "title").has(p.title)) out.push(["row title", `#${p.id} shows "${p.title}", server "${x.title}"`]);
      if (valuesToo && !allowed(p.id, "assignee").has(p.assignee)) out.push(["row assignee", `#${p.id} shows ${p.assignee}, server ${x.assignee}`]);
      if (filter === "open" && !x.open && ![...writes.values()].some(w => w.issue === p.id && w.field === "open") && !stale.some(t => t.issue === p.id && t.field === "open")) {
        const lingering = inFlight && declined.some(d => d.issue === p.id && d.field === "open");
        if (!lingering) out.push(["closed row shown", `#${p.id} is closed on the server`]);
      }
      if (filter === "closed" && x.open) out.push(["open row in closed list", `#${p.id}`]);
    }
    if (filter === "open") for (const x of srv.issues.filter(i => i.open)) {
      if (parsed.some(p => p.id === x.id)) continue;
      const closing = [...writes.values()].some(w => w.issue === x.id && w.field === "open");
      const lingering = inFlight && declined.some(d => d.issue === x.id && d.field === "open");     // A1
      if (!closing && !lingering) out.push(["open row missing", `#${x.id}`]);
    }
    return out;
  }

  // round 9: what each field of an issue shows this frame, where it is on screen (undefined: not on screen)
  function shownValue(parsed, listShown, detail, id, field) {
    const p = listShown ? parsed.find(x => x.id === id) : undefined;
    if (field === "open") return listShown && ui.filter === "open" ? (p ? true : false) : undefined;
    if (p) return p[field];
    if (field === "title" && detail && ui.selected === id) { const m = detail.match(new RegExp(`^#${id} `)); if (m) for (const t of allowed(id, "title")) if (detail.startsWith(`#${id} ${t}`)) return t; }
    return undefined;
  }
  function round9(parsed, listShown, detail, tab) {
    // A5: a held list or detail is not judged
    if (held.filters.size) listShown = false;
    if (held.selections.size) detail = null;
    for (const w of writes.values()) {
      if (w.gen !== gen || !["title", "assignee", "open"].includes(w.field)) continue;
      const v = shownValue(parsed, listShown, detail, w.issue, w.field);
      if (v === undefined) continue;
      if (v === w.value) { w.shown = true; continue; }
      const newer = [...writes.values()].some(o => o !== w && o.issue === w.issue && o.field === w.field && o.seq > w.seq);
      if (w.shown && !newer) return note("dropped guess", `#${w.issue} ${w.field}: showed ${JSON.stringify(w.value)} while it was in flight, now ${JSON.stringify(v)}`);
    }
    if (listShown && detail && ui.selected != null) {
      const p = parsed.find(x => x.id === ui.selected);
      const m = detail.match(/^#(\d+) /);
      if (p && m && Number(m[1]) === p.id && !detail.startsWith(`#${p.id} ${p.title}`)) return note("two views", `row "#${p.id} ${p.title}", detail "${detail.slice(0, 40)}"`);
    }
    const cm = tab && tab.match(/\((\d+)\)/);
    if (listShown && ui.filter === "open" && cm && Number(cm[1]) !== parsed.length) note("count", `tab ${tab}, ${parsed.length} open rows shown`);
  }

  async function everyFrame() {
    inFlight = (await pending()).length > 0;
    if (ui.page !== "issues") return;
    const rows = await texts("issue");
    const listText = await text("list");
    const parsed = rows.map(t => t.match(/^#(\d+) (.*) \((.*)\)$/)).filter(Boolean).map(m => ({ id: Number(m[1]), title: m[2], assignee: m[3] === "unassigned" ? null : m[3] }));
    if (r9) {
      const listShown = !!listText && !/loading|error/.test(listText);
      const d = await text("detail"); const detail = d && !/loading #|detail error|select an issue/.test(d) ? d : null;
      round9(parsed, listShown, detail, await text("tab-issues"));
      if (found.length) return;
    }
    if (parsed.length && listText && !/loading/.test(listText)) {
      const v = listViolations(parsed, ui.filter);
      // A5: a filter switch made while work is in flight may hold the previous filter's list (Ryan, 2026-10-28)
      if (v.length && !(held.filters.size && parsed.every(p => held.rows.has(p.id))) && ![...held.filters].some(f => !listViolations(parsed, f, false).length)) for (const [k, d] of v) note(k, d);
    }
    const detail = await text("detail");
    if (detail && ui.selected != null && !/loading #|detail error|select an issue/.test(detail)) {
      const m = detail.match(/#(\d+) /);
      const shownId = m ? Number(m[1]) : null;
      if (m && shownId !== ui.selected && !held.selections.has(shownId)) note("wrong detail", `selected #${ui.selected}, detail shows #${m[1]}`);   // A5
      else if (m && ![...allowed(shownId, "title")].some(t => detail.includes(`#${shownId} ${t}`))) note("detail title", `"${detail.slice(0, 60)}", server "${srv.issues.find(i => i.id === shownId).title}"`);
    }
  }

  async function atRest() {
    if (ui.page !== "issues") return;
    const listText = await text("list");
    if (!listText || /error/.test(listText)) return;
    const parsed = (await texts("issue")).map(t => t.match(/^#(\d+) (.*) \((.*)\)$/)).filter(Boolean).map(m => ({ id: Number(m[1]), title: m[2], assignee: m[3] === "unassigned" ? null : m[3] }));
    const want = srv.issues.filter(i => i.open === (ui.filter === "open") || (ui.filter === "open" && stale.some(t => t.issue === i.id && t.field === "open") && parsed.some(p => p.id === i.id)));
    const newest = (id, field) => { const ws = started.filter(w => w.issue === id && w.field === field && w.accepted); return ws.length ? ws.at(-1).value : undefined; };
    const ok = (id, field, v) => { const x = srv.issues.find(i => i.id === id); return v === x[field] || v === newest(id, field) || stale.some(t => t.issue === id && t.field === field && t.before === v); };   // A2, A4
    const ids = parsed.map(p => p.id).join(",");
    // the closed list need not gain an issue closed after it loaded (no brief asks for it): it must hold no open issue
    const closedOk = ui.filter === "closed" && parsed.every(p => want.some(i => i.id === p.id));
    if (ids !== want.map(i => i.id).join(",") && !closedOk) note("at rest: rows", `shows [${ids}], server [${want.map(i => i.id)}]`);
    for (const p of parsed) {
      if (!want.some(i => i.id === p.id)) continue;
      if (!ok(p.id, "title", p.title)) note("at rest: row title", `#${p.id} "${p.title}"`);
      if (!ok(p.id, "assignee", p.assignee)) note("at rest: row assignee", `#${p.id} ${p.assignee}`);
    }
    const tab = await text("tab-issues");
    const cm = tab && tab.match(/\((\d+)\)/);
    if (cm && ui.filter === "open" && Number(cm[1]) !== parsed.length) note("at rest: count", `tab ${tab}, ${parsed.length} open rows shown`);   // A3
    if (ui.selected != null) {
      const detail = await text("detail");
      const x = srv.issues.find(i => i.id === ui.selected);
      if (detail && !/detail error/.test(detail) && !detail.includes(`#${x.id} ${x.title}`) && !(newest(x.id, "title") && detail.includes(`#${x.id} ${newest(x.id, "title")}`))) note("at rest: detail", `"${detail.slice(0, 60)}", server "#${x.id} ${x.title}"`);
      if (await exists("label")) {
        const labelsText = await text("labels");
        if (labelsText && !/error/.test(labelsText)) { const ls = (await texts("label")).join(","); if (ls !== (srv.labels[x.id] ?? []).join(",")) note("at rest: labels", `#${x.id} shows [${ls}], server [${srv.labels[x.id]}]`); }
      }
      const commentsText = await text("comments");
      if (commentsText && !/error|loading/.test(commentsText)) {
        const cs = (await texts("comment")).join(" | "); const want2 = (srv.comments[x.id] ?? []).map(c => `${c.author}: ${c.text}`).join(" | ");
        if (cs !== want2) note("at rest: comments", `#${x.id} shows [${cs}], server [${want2}]`);
      }
    }
  }

  async function answerOne(keys) {
    const key = pick(keys); const name = key.slice(0, key.indexOf(":"));
    const fail = r() < (WRITES.has(name) ? 0.3 : 0.1);
    const w = writes.get(key);
    const target = w && srv.issues.find(i => i.id === w.issue);
    const before = target && w.field in target ? target[w.field] : undefined;
    // two calls with one key while both are in the air are one flight to the test, but two requests to the server
    const times = Math.max(1, (await page.evaluate(k => globalThis.__flights.asked().filter(x => x === k).length, key)) - (settledCount.get(key) ?? 0));
    settledCount.set(key, (settledCount.get(key) ?? 0) + times);
    let a; for (let t = 0; t < times; t++) a = answer(srv, key, fail);
    if (w && !fail && w.gen !== gen && target) stale.push({ issue: w.issue, field: w.field, before });   // A4
    trail.push(`${fail ? "fail" : "land"} ${key}`);
    if (w) { writes.delete(key); if (fail) declined.push(w); else w.accepted = true; }
    await page.evaluate(([k, a]) => a.fail ? globalThis.__flights.fail(k, "declined") : globalThis.__flights.land(k, a.value), [key, a]);
    await settle();
    if (!(await pending()).length) declined = [];
    if (!(await pending()).length) held = { filters: new Set(), selections: new Set(), rows: new Set() };
  }

  async function move() {
    const opts = [];
    const rows = await texts("issue");
    if (ui.page === "issues") {
      if (rows.length) opts.push(["select", 3]);
      if (await exists("assign")) opts.push(["assign", r9 ? 4 : 2]);
      if (await exists("rename")) opts.push(["rename", r9 ? 4 : 2]);
      if (await exists("close")) opts.push(["close", r9 ? 4 : 2]);
      if (await exists("row-assign")) opts.push(["row-assign", r9 ? 4 : 2]);
      if (await exists("row-close")) opts.push(["row-close", r9 ? 4 : 2]);
      if (await exists("add-label")) opts.push(["add-label", r9 ? 2 : 1]);
      if (await exists("remove-label")) opts.push(["remove-label", r9 ? 2 : 1]);
      if (await exists("post")) opts.push(["post", r9 ? 2 : 1]);
      opts.push(["user", 1], ["filter", 1], ["leave", 1]);
      if (r9) opts.push(["focus", 1]);
    } else opts.push(["back", 3]);
    const total = opts.reduce((s, o) => s + o[1], 0); let x = r() * total; let m = opts[0][0];
    for (const [k, w] of opts) { if ((x -= w) < 0) { m = k; break; } }
    const click = async (id, nth = 0) => { await page.locator(sel(id)).nth(nth).click({ timeout: 2000 }); };
    switch (m) {
      case "select": { const t = pick(rows); const id = Number(t.match(/^#(\d+)/)?.[1]); if (!id) return; trail.push(`select #${id}`); await page.locator(sel("issue"), { hasText: `#${id} ` }).first().click({ timeout: 2000 }); if ((await pending()).length && ui.selected !== id) held.selections.add(ui.selected); ui.selected = id; break; }
      case "user": { const u = pick(USERS); trail.push(`user ${u}`); await page.locator(sel("user")).first().fill(u, { timeout: 2000 }); break; }
      case "assign": trail.push("assign"); await click("assign"); break;
      case "rename": { const t = pick(TITLES); trail.push(`rename ${t}`); await page.locator(sel("title-input")).first().fill(t, { timeout: 2000 }); await click("rename"); break; }
      case "close": trail.push("close"); await click("close"); break;
      case "row-assign": { const n = Math.floor(r() * (await page.locator(sel("row-assign")).count())); trail.push(`row-assign ${n}`); await click("row-assign", n); break; }
      case "row-close": { const n = Math.floor(r() * (await page.locator(sel("row-close")).count())); trail.push(`row-close ${n}`); await click("row-close", n); break; }
      case "add-label": { const l = pick(LABELS); trail.push(`add-label ${l}`); await page.locator(sel("label-input")).first().fill(l, { timeout: 2000 }); await click("add-label"); break; }
      case "remove-label": { const n = Math.floor(r() * (await page.locator(sel("remove-label")).count())); trail.push(`remove-label ${n}`); await click("remove-label", n); break; }
      case "post": { const t = pick(TEXTS); trail.push(`post ${t}`); await page.locator(sel("comment-input")).first().fill(t, { timeout: 2000 }); await click("post"); break; }
      case "filter": { const f = ui.filter === "open" ? "closed" : "open"; trail.push(`filter ${f}`); if ((await pending()).length) { held.filters.add(ui.filter); for (const t of await texts("issue")) { const m = t.match(/^#(\d+)/); if (m) held.rows.add(Number(m[1])); } } await click(`filter-${f}`); ui.filter = f; break; }
      case "focus": trail.push("focus"); await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); for (const t of [document, window]) t.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("blur")); Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); for (const t of [document, window]) t.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); }); break;
      case "leave": trail.push("tab help"); await click("tab-help"); ui.page = "help"; gen++; break;
      case "back": trail.push("tab issues"); await click("tab-issues"); ui.page = "issues"; ui.filter = "open"; ui.selected = null; gen++; stale = []; held = { filters: new Set(), selections: new Set(), rows: new Set() }; break;
    }
    await settle();
  }

  try {
    await page.goto(url); await page.waitForFunction(() => globalThis.__flights !== undefined, null, { timeout: 5000 }).catch(() => {});
    await settle();
    for (let s = 0; s < steps; s++) {
      await track();
      const keys = await pending();
      if (keys.length && r() < (r9 ? 0.4 : 0.5)) await answerOne(keys); else await move().catch(e => { trail.push(`(move failed: ${e.message.split("\n")[0].slice(0, 80)})`); });
      await track();
      await everyFrame();
      if (found.length) break;
    }
    for (let guard = 0; !found.length && guard < 200; guard++) {
      await track();
      const keys = await pending();
      if (!keys.length) break;
      await answerOne(keys); await track(); await everyFrame();
    }
    if (!found.length && !(await pending()).length) await atRest();
    if (errors.length && !found.length) note("page error", errors[0].slice(0, 120));
  } finally { await page.close(); }
  if (log) console.log(`seed ${seed}: ${trail.join(" ; ")}`);
  return found.slice(0, 1);
}

export async function fuzz(dir, { seeds = 40, steps = 30, from = 1, log = false, r9 = false } = {}) {
  const b = await build(dir);
  if (!b.ok) return { dir, build: false, seeds, violations: [] };
  const server = await serve(b.dist); let browser = await launch();
  const violations = [];
  try {
    for (let s = from; s < from + seeds; s++) {
      // a page that crashes or hangs the browser is a hole of its own; the next seed gets a fresh browser
      try { let t; violations.push(...await Promise.race([session(browser, server.url, s, steps, log, r9), new Promise((_, rej) => { t = setTimeout(() => rej(new Error("session timed out (120 s): the page hangs")), 120000); })]).finally(() => clearTimeout(t))); }
      catch (e) { violations.push({ seed: s, step: -1, kind: "page crash", detail: e.message.split("\n")[0].slice(0, 120), trail: [] }); await browser.close().catch(() => {}); browser = await launch(); }
    }
  }
  finally { await browser.close(); server.close(); }
  return { dir, build: true, seeds, violations };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2); const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const res = await fuzz(path.resolve(a[0]), { seeds: Number(opt("--seeds", 40)), steps: Number(opt("--steps", 30)), from: Number(opt("--from", 1)), log: a.includes("--log"), r9: a.includes("--r9") });
  console.log(`${path.basename(res.dir)}: ${res.build ? `${res.violations.length}/${res.seeds} seeds found a hole` : "build failed"}`);
  for (const v of res.violations) console.log(`  seed ${v.seed} step ${v.step}: ${v.kind}: ${v.detail}\n    ${v.trail.join(" ; ")}`);
  if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(res, null, 2) + "\n");
}
