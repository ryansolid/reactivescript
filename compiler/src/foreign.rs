//! R-f-11 (taken by default 2026-11-02): a failure that surfaces in another section's `errored` region.
//!
//! Runs after every module is checked, over the resolved model (`model.rs`), because the question that fails and the
//! region that shows its failure are often in different components (a list passed to a detail as a prop). A question is
//! *failable* when its equation awaits (outside any `catch`) or calls a non-`io` import (a fetch): a rejection is an error value (R-6) that flows to
//! every reader. It flows through equations and through props (call site → `props.field`), and stops at an equation
//! that has a `catch` expression (R-f-4). A reader shows it in its nearest `errored` regions, following the static
//! application tree (a component's regions hang under each place it is applied, R-f-5).
//!
//! The error: question `F` surfaces in `errored` region `B`, `B` is neither inside nor around another region where
//! `F` surfaces, and `B` also shows a question `G` that neither depends on `F` nor `F` on it. Then `B` is another
//! section's boundary: when `F` fails, that section shows `F`'s error as its own, and its own retry does not ask `F`
//! again (round 10 desk rx-2: the list's failure, passed to the detail as `rows`, replaced the detail).

use crate::check::Diagnostic;
use indexmap::{IndexMap, IndexSet};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

type Key = (usize, usize, Option<String>); // (module, symbol, props field)
type RKey = (usize, usize); // (module, region)

pub fn foreign_failures(models: &IndexMap<String, Value>, catch_eqs: &HashMap<String, HashSet<i64>>, await_eqs: &HashMap<String, HashSet<i64>>) -> Vec<Diagnostic> {
    let files: Vec<&String> = models.keys().collect();
    let ms: Vec<&Value> = models.values().collect();
    let arr = |v: &Value, k: &str| v[k].as_array().cloned().unwrap_or_default();
    let mut regions: HashMap<RKey, Value> = HashMap::new();
    let mut syms: HashMap<(usize, usize), Value> = HashMap::new();
    let mut comps: Vec<(usize, Value)> = vec![];
    for (mi, m) in ms.iter().enumerate() {
        for r in arr(m, "regions") {
            regions.insert((mi, r["id"].as_u64().unwrap_or(0) as usize), r);
        }
        for s in arr(m, "symbols") {
            syms.insert((mi, s["id"].as_u64().unwrap_or(0) as usize), s);
        }
        for c in arr(m, "computations") {
            comps.push((mi, c));
        }
    }
    let s_str = |s: &Value, k: &str| s[k].as_str().unwrap_or("").to_string();
    // a component's props symbol, and the places it is applied
    let mut comp_props: HashMap<String, (usize, usize)> = HashMap::new();
    for ((mi, id), s) in &syms {
        if s["kind"] == "props" {
            if let Some(r) = regions.get(&(*mi, s["region"].as_u64().unwrap_or(0) as usize)) {
                comp_props.insert(s_str(r, "name"), (*mi, *id));
            }
        }
    }
    let mut call_sites: HashMap<String, Vec<RKey>> = HashMap::new();
    let mut rkeys: Vec<&RKey> = regions.keys().collect();
    rkeys.sort();
    for k in rkeys {
        let r = &regions[k];
        if r["kind"] == "children" {
            call_sites.entry(s_str(r, "name")).or_default().push(*k);
        }
    }
    let parents = |k: &RKey| -> Vec<RKey> {
        let r = &regions[k];
        if r["kind"] == "component" {
            if let Some(cs) = call_sites.get(&s_str(r, "name")) {
                return cs.clone();
            }
        }
        r["parent"].as_u64().map(|p| vec![(k.0, p as usize)]).unwrap_or_default()
    };
    let ancestors = |k: RKey| -> HashSet<RKey> {
        let mut out = HashSet::new();
        let mut todo = vec![k];
        while let Some(x) = todo.pop() {
            if out.insert(x) {
                todo.extend(parents(&x));
            }
        }
        out
    };
    let nearest_errored = |k: RKey| -> IndexSet<RKey> {
        let mut out = IndexSet::new();
        let mut seen = HashSet::new();
        let mut todo = vec![k];
        while let Some(x) = todo.pop() {
            if !seen.insert(x) || !regions.contains_key(&x) {
                continue;
            }
            if regions[&x]["kind"] == "errored" {
                out.insert(x);
            } else {
                todo.extend(parents(&x));
            }
        }
        out
    };
    // equations: the computation that defines each eq / source symbol
    let mut defn: IndexMap<Key, usize> = IndexMap::new();
    for (ci, (mi, c)) in comps.iter().enumerate() {
        if (c["kind"] == "memo" || c["kind"] == "question") && c["name"].is_string() {
            for ((smi, sid), s) in &syms {
                if smi == mi && s["name"] == c["name"] && (s["kind"] == "eq" || s["kind"] == "source") && s["line"] == c["line"] {
                    defn.insert((*mi, *sid, None), ci);
                }
            }
        }
    }
    defn.sort_keys();
    let catches = |mi: usize, line: i64| catch_eqs.get(files[mi]).is_some_and(|s| s.contains(&line));
    let tracked = |mi: usize, c: &Value| -> Vec<Key> {
        arr(c, "reads")
            .iter()
            .filter(|r| r["mode"] == "tracked")
            .map(|r| {
                let sid = r["sym"].as_u64().unwrap_or(0) as usize;
                let props = syms.get(&(mi, sid)).is_some_and(|s| s["kind"] == "props");
                (mi, sid, if props { r["field"].as_str().map(String::from) } else { None })
            })
            .collect()
    };
    // roots: the failable questions each key carries
    let mut roots: HashMap<Key, IndexSet<Key>> = HashMap::new();
    for (k, ci) in &defn {
        let (mi, c) = &comps[*ci];
        let fetches = arr(c, "calls").iter().any(|x| {
            syms.get(&(*mi, x.as_u64().unwrap_or(usize::MAX as u64) as usize)).is_some_and(|s| s["kind"] == "import" && s["io"] != true)
        });
        let line = c["line"].as_i64().unwrap_or(0);
        let awaits = await_eqs.get(files[*mi]).is_some_and(|s| s.contains(&line)) && !catches(*mi, line);
        if fetches || awaits {
            roots.entry(k.clone()).or_default().insert(k.clone());
        }
    }
    let mut targets: Vec<(usize, Vec<Key>)> = vec![];
    for (ci, (mi, c)) in comps.iter().enumerate() {
        if c["kind"] == "prop" {
            let at = s_str(c, "at");
            let mut it = at.splitn(2, ' ');
            let (comp, field) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
            if let Some((pm, pid)) = comp_props.get(comp) {
                targets.push((ci, vec![(*pm, *pid, Some(field.to_string()))]));
            }
        } else {
            let ts: Vec<Key> = defn.iter().filter(|(_, d)| **d == ci).map(|(k, _)| k.clone()).collect();
            if !ts.is_empty() && !catches(*mi, c["line"].as_i64().unwrap_or(0)) {
                targets.push((ci, ts));
            }
        }
    }
    loop {
        let mut changed = false;
        for (ci, ts) in &targets {
            let (mi, c) = &comps[*ci];
            let mut acc: IndexSet<Key> = IndexSet::new();
            for k in tracked(*mi, c) {
                if let Some(rs) = roots.get(&k) {
                    acc.extend(rs.iter().cloned());
                }
            }
            for t in ts {
                let e = roots.entry(t.clone()).or_default();
                for r in &acc {
                    changed |= e.insert(r.clone());
                }
            }
        }
        if !changed {
            break;
        }
    }
    // a root depends on the roots its own equation carries
    let deps = |r: &Key| -> IndexSet<Key> { roots.get(r).map(|s| s.iter().filter(|x| *x != r).cloned().collect()).unwrap_or_default() };
    // where each root surfaces: (boundary) -> first reading (module, line, what is read)
    let mut surf: IndexMap<Key, IndexMap<RKey, (usize, i64, String)>> = IndexMap::new();
    let mut in_b: HashMap<RKey, IndexSet<Key>> = HashMap::new();
    for (mi, c) in &comps {
        let kind = c["kind"].as_str().unwrap_or("");
        if !matches!(kind, "reader" | "memo" | "question") {
            continue;
        }
        let line = c["line"].as_i64().unwrap_or(0);
        let region = (*mi, c["region"].as_u64().unwrap_or(0) as usize);
        let bs = nearest_errored(region);
        if bs.is_empty() {
            continue;
        }
        for k in tracked(*mi, c) {
            let Some(rs) = roots.get(&k) else { continue };
            let what = {
                let n = syms.get(&(k.0, k.1)).map(|s| s_str(s, "name")).unwrap_or_default();
                match &k.2 {
                    Some(f) => format!("{}.{}", n, f),
                    None => n,
                }
            };
            for r in rs {
                for b in &bs {
                    let e = surf.entry(r.clone()).or_default().entry(*b).or_insert((*mi, line, what.clone()));
                    if (e.0, e.1) > (*mi, line) {
                        *e = (*mi, line, what.clone());
                    }
                    in_b.entry(*b).or_default().insert(r.clone());
                }
            }
        }
    }
    let name = |k: &Key| syms.get(&(k.0, k.1)).map(|s| s_str(s, "name")).unwrap_or_default();
    let mut out: Vec<Diagnostic> = vec![];
    for (root, places) in &surf {
        let bs: Vec<RKey> = places.keys().cloned().collect();
        let anc: HashMap<RKey, HashSet<RKey>> = bs.iter().map(|b| (*b, ancestors(*b))).collect();
        for b in &bs {
            // a boundary of this root's own, not nested with b
            let other_home = bs.iter().any(|a| a != b && !anc[b].contains(a) && !anc[a].contains(b));
            if !other_home {
                continue;
            }
            let mine = deps(root);
            let guards: Vec<String> = in_b[b]
                .iter()
                .filter(|g| *g != root && !deps(g).contains(root) && !mine.contains(*g))
                .map(name)
                .collect();
            if guards.is_empty() {
                continue;
            }
            let (mi, line, what) = &places[b];
            let rline = syms.get(&(root.0, root.1)).and_then(|s| s["line"].as_i64()).unwrap_or(0);
            let rfile = files[root.0].rsplit('/').next().unwrap_or("");
            let via = if *what == name(root) { String::new() } else { format!(" (read here through `{}`)", what) };
            let msg = format!(
                "`{}` (asked at {}:{}) can fail{}, and this read is inside the `errored` region that shows the failures of `{}`: when `{}` fails, this section shows its error as its own and this section's retry does not ask it again. Catch it where it is read here (`… catch (e) => …`), or read it only inside its own `errored` region",
                name(root), rfile, rline, via, guards.join("`, `"), name(root)
            );
            if !out.iter().any(|d| d.line == *line && d.file.as_deref() == Some(files[*mi].as_str()) && d.msg == msg) {
                out.push(Diagnostic { code: "FOREIGN_FAILURE".into(), rule: "R-f-11".into(), line: *line, msg, file: Some(files[*mi].clone()) });
            }
        }
    }
    out
}
