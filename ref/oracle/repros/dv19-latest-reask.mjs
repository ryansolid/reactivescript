// DV-19: `latest()` over an optimistic guess answers the re-asked truth once a re-ask lands while the guess is pending.
// node --conditions=browser --conditions=development repros/dv19-latest-reask.mjs   (from ref/oracle)
// Expected (spec H-7, R-12; S-latest-reask instant 4): `latest` reads past a hold but answers what the source shows —
//   the guess, while its action is out. After the re-ask lands: store.length 2, latest 2.
// Observed on 2.0.0-rc.21 (next @ 2105ffb8): store.length 2, untrack 2, latest 3. Before the re-ask lands, latest is 2.
//   The signal form (createOptimistic over createSignal(async)) does the same: detail().title "New", latest "Old".
// Found by the timing fuzzer on the chain4 reference desk. Filed as solidjs/solid#4689; ruled a bug in #4695 (decision 3), not built.
import { createRoot, createSignal, createOptimistic, createOptimisticStore, action, refresh, latest, untrack, flush } from "solid-js";
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flush(); } };
const asks = []; const ask = key => new Promise((res, rej) => asks.push({ key, res, rej }));
const land = async (key, v) => { for (const a of asks.filter(a => a.key === key)) { asks.splice(asks.indexOf(a), 1); a.res(v); } await tick(); };
const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
{
  let issues, setIssues, close, probe;
  createRoot(() => {
    [issues, setIssues] = createOptimisticStore(async d => { const r = await ask("fetch"); d.length = r.length; r.forEach((x, i) => { d[i] = { ...x }; }); }, [], { key: "id" });
    close = action(function* (id) { setIssues(d => { const v = d.filter(t => t.id != id); d.length = v.length; v.forEach((x, i) => { d[i] = x; }); }); yield ask("close"); refresh(issues); });
    probe = () => `store.length=${issues.length} untrack=${untrack(() => issues.length)} latest=${latest(() => issues.length)}`;
  });
  await tick(); await land("fetch", rows); close(1); await tick();
  console.log("store  | guess pending, before the re-ask:", probe());
  refresh(issues); await tick(); await land("fetch", rows);
  console.log("store  | guess pending, re-ask landed:    ", probe(), " (expected latest=2)");
}
{
  let truth, detail, setGuess, rename, probe;
  createRoot(() => {
    [truth] = createSignal(async () => ({ ...(await ask("fetch")) }));
    [detail, setGuess] = createOptimistic(() => truth());
    rename = action(function* (t) { setGuess(d => ({ ...d, title: t })); yield ask("rename"); refresh(truth); });
    probe = () => `detail().title=${detail().title} untrack=${untrack(() => detail().title)} latest=${latest(() => detail().title)}`;
  });
  await tick(); await land("fetch", { id: 2, title: "Old" }); rename("New"); await tick();
  console.log("signal | guess pending, before the re-ask:", probe());
  refresh(truth); await tick(); await land("fetch", { id: 2, title: "Old" });
  console.log("signal | guess pending, re-ask landed:    ", probe(), " (expected latest=New)");
}
