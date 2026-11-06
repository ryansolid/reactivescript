// DV-20, solidjs/solid#4690 (S-guess-reask-refresh, effect-only variant): a guess reverts at the action's end, before the refresh it issued lands, once an outside
// re-ask landed under it. Reader: a text node under <Loading> (view) vs an effect (no boundary).
// node --conditions=browser --conditions=development repros/4690-guess-reask-refresh.mjs   (from ref/oracle)
// Expected (spec 06 D-35): every reader keeps the guess until the action's re-ask lands.
// Observed on 2.0.0-rc.21: a text node under <Loading> keeps it; an effect alone sees the old truth once the write lands
//   until the re-ask lands; an effect beside a rendered reader keeps it. Without the outside re-ask, every reader keeps it.
import { createRenderer } from "@solidjs/universal";
import { Loading, createRoot, createOptimisticStore, createEffect, action, refresh, flush } from "solid-js";
const nodes = {
  createElement: tag => ({ tag, children: [] }), createTextNode: text => ({ text }), replaceText: (n, v) => { n.text = v; }, isTextNode: n => "text" in n,
  setProperty() {}, getParentNode: n => n.parent, getFirstChild: n => n.children?.[0], getNextSibling: n => n.parent && n.parent.children[n.parent.children.indexOf(n) + 1],
  insertNode(p, n, anchor) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); const i = anchor ? p.children.indexOf(anchor) : -1; i < 0 ? p.children.push(n) : p.children.splice(i, 0, n); n.parent = p; },
  removeNode(p, n) { p.children.splice(p.children.indexOf(n), 1); n.parent = undefined; },
};
const R = createRenderer(nodes);
const text = n => "text" in n ? n.text : n.children.map(text).join("");
const settle = async () => { for (let i = 0; i < 3; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
const asks = []; const ask = key => new Promise((res, rej) => asks.push({ key, res, rej }));
const land = async (key, v) => { for (const a of asks.filter(a => a.key === key)) { asks.splice(asks.indexOf(a), 1); a.res(v); } await settle(); };
for (const reader of ["view under <Loading>", "effect", "effect + view"]) {
  const root = { tag: "root", children: [] }; let d, rename, eff = null;
  createRoot(() => {
    let set; [d, set] = createOptimisticStore(async draft => { const r = await ask("fetch"); Object.assign(draft, r); }, {});
    rename = action(function* (t) { set(x => { x.title = t; }); yield ask("rename"); refresh(d); });
    if (reader.startsWith("effect")) createEffect(() => d.title, v => { eff = v; });
    if (reader !== "effect") R.insert(root, R.createComponent(Loading, { fallback: "loading", get children() { return R.memo(() => d.title); } }));
  });
  const shown = () => reader === "effect" ? eff : reader === "effect + view" ? `${eff} (view ${text(root)})` : text(root);
  flush(); await settle(); await land("fetch", { id: 2, title: "Old" });
  rename("New"); await settle(); const s1 = shown();
  refresh(d); await settle(); await land("fetch", { id: 2, title: "Old" }); const s2 = shown();
  await land("rename", true); const s3 = shown();
  await land("fetch", { id: 2, title: "New" }); const s4 = shown();
  console.log(`${reader.padEnd(22)} guess=${s1}  outside re-ask landed=${s2}  write landed, refresh in flight=${s3} (expected New)  refresh landed=${s4}`);
}
