//! 06 AC-1b…AC-1e (`ref/src/infer.ts`): what the compiler reads off an imperative body. Which arrows are actions without
//! the keyword (AC-1b), and the checks every imperative run gets: a plain write an inferred action holds across an
//! `await` (HELD_WRITE, AC-1c), a read of a source the same change already wrote (STALE_OWN_READ, AC-1d), and a write
//! after an `await` computed from the same source as read before it (STALE_WRITE_BACK, AC-1e). Solid sees none of them:
//! a TypeScript body's promises and reads are not visible to it, which is why it asks for `action(function* …)` and lets
//! a stale read or a lost update through.

use crate::ast::{Expr, ExprKind, Field, Lit, PathSeg, Stmt, StmtKind, TplPart};
use indexmap::{IndexMap, IndexSet};
use std::collections::HashSet;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Trigger {
    Optimistic,
    Affects,
    WriteAwait,
}
pub fn trigger_text(t: Trigger) -> &'static str {
    match t {
        Trigger::WriteAwait => "it writes and awaits",
        Trigger::Optimistic => "it has `guess`",
        Trigger::Affects => "it has `affects`",
    }
}

/// AC-1: a run suspends only at a statement-level `await` (`await e`, `let v = await e`, either with a `catch`).
pub fn stmt_await(s: &Stmt) -> bool {
    let e = match &s.k {
        StmtKind::Let { e, .. } | StmtKind::Expr(e) => e,
        _ => return false,
    };
    match &e.k {
        ExprKind::Await { .. } => true,
        ExprKind::Catch { e, .. } => matches!(e.k, ExprKind::Await { .. }),
        _ => false,
    }
}

type Closures<'a> = IndexMap<String, &'a Expr>;
fn fn_parts(e: &Expr) -> (&[String], &[Stmt]) {
    match &e.k {
        ExprKind::Fn { params, stmts: Some(ss), .. } => (params, ss),
        _ => unreachable!(),
    }
}
/// The local closures a body's own statements call by name: `let f = () => { … }`, statement-bodied, not an action of its own.
fn closure_of(s: &Stmt) -> Option<&Expr> {
    match &s.k {
        StmtKind::Let { e, .. } => match &e.k {
            ExprKind::Fn { stmts: Some(ss), .. } if inferred_action(ss).is_none() => Some(e),
            _ => None,
        },
        _ => None,
    }
}
fn called_closure<'a>(e: &Expr, cl: &Closures<'a>) -> Option<&'a Expr> {
    match &e.k {
        ExprKind::Call { f, .. } => match &f.k {
            ExprKind::Id(n) => cl.get(n).copied(),
            _ => None,
        },
        _ => None,
    }
}

/// AC-1b: why an arrow's body is an action — it guesses, declares `affects`, or both writes a source and awaits — or None for
/// a plain run. Its own statements only: not the bodies of closures in it (each is inferred on its own), not an inline
/// `action { … }` (its own run), but through the local closures it calls (a call runs the closure's writes in this run).
pub fn inferred_action(stmts: &[Stmt]) -> Option<Trigger> {
    struct S<'a> {
        guess: Option<Trigger>,
        write: bool,
        wait: bool,
        seen: HashSet<*const Expr>,
        _p: std::marker::PhantomData<&'a ()>,
    }
    fn go<'a>(ss: &'a [Stmt], cl: &Closures<'a>, st: &mut S<'a>) {
        let mut local = cl.clone();
        for s in ss {
            if let Some(c) = closure_of(s) {
                if let StmtKind::Let { name, .. } = &s.k {
                    local.insert(name.clone(), c);
                }
            } else if let StmtKind::Let { name, .. } = &s.k {
                local.shift_remove(name);
            }
            let called = match &s.k {
                StmtKind::Expr(e) | StmtKind::Let { e, .. } => called_closure(e, &local),
                _ => None,
            };
            if let Some(c) = called {
                if st.seen.insert(c as *const Expr) {
                    go(fn_parts(c).1, &local, st);
                }
            }
            match &s.k {
                StmtKind::Optimistic { .. } => {
                    if st.guess.is_none() {
                        st.guess = Some(Trigger::Optimistic);
                    }
                }
                StmtKind::Affects(_) => {
                    if st.guess.is_none() {
                        st.guess = Some(Trigger::Affects);
                    }
                }
                StmtKind::Write { .. } => st.write = true,
                StmtKind::Let { .. } | StmtKind::Expr(_) => {
                    if stmt_await(s) {
                        st.wait = true;
                    }
                }
                StmtKind::Sif { t, f, .. } => {
                    go(t, &local, st);
                    go(f, &local, st);
                }
                StmtKind::Try { body, handler, fin, .. } => {
                    go(body, &local, st);
                    if let Some(h) = handler {
                        go(h, &local, st);
                    }
                    if let Some(f) = fin {
                        go(f, &local, st);
                    }
                }
                _ => {}
            }
        }
    }
    let mut st = S { guess: None, write: false, wait: false, seen: HashSet::new(), _p: std::marker::PhantomData };
    go(stmts, &IndexMap::new(), &mut st);
    st.guess.or(if st.write && st.wait { Some(Trigger::WriteAwait) } else { None })
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Code {
    HeldWrite,
    StaleOwnRead,
    StaleWriteBack,
}
pub struct Finding {
    pub code: Code,
    pub name: String,
}

/// keys from the source; "*" a computed key
type Path = Vec<String>;
/// a read of a source: its key, the path read, and how many `await`s the run had passed when it read (AC-1e)
type Dep = (String, Path, u32);
#[derive(Clone)]
struct State {
    written: IndexMap<String, Vec<Path>>,
    held: IndexSet<String>,
    dead: bool,
    /// AC-1e: the source reads each local's value was computed from
    taint: IndexMap<String, Vec<Dep>>,
    /// AC-1e: the `await`s passed so far on this path (the most of any path into a merge)
    epoch: u32,
}
fn merge(ss: &[&State]) -> State {
    let live: Vec<&&State> = ss.iter().filter(|s| !s.dead).collect();
    if live.is_empty() {
        let mut s = ss[0].clone();
        s.dead = true;
        return s;
    }
    let mut out = State { written: IndexMap::new(), held: IndexSet::new(), dead: false, taint: IndexMap::new(), epoch: 0 };
    for s in live {
        out.epoch = out.epoch.max(s.epoch);
        for (k, v) in &s.taint {
            out.taint.entry(k.clone()).or_default().extend(v.iter().cloned());
        }
        for (k, v) in &s.written {
            out.written.entry(k.clone()).or_default().extend(v.iter().cloned());
        }
        for h in &s.held {
            out.held.insert(h.clone());
        }
    }
    out
}
fn alive(s: &State) -> State {
    let mut c = s.clone();
    c.dead = false;
    c
}
fn overlaps(a: &Path, b: &Path) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| x == y || x == "*" || y == "*")
}
fn key(name: &str, ctx: bool) -> String {
    if ctx { format!("use {}", name) } else { name.to_string() }
}
fn lit_key(e: &Expr) -> String {
    match &e.k {
        ExprKind::Lit(Lit::Str(s)) => s.clone(),
        _ => "*".into(),
    }
}

struct Walker {
    out: Vec<Finding>,
    said: HashSet<(Code, String)>,
    action: bool,
    inferred: bool,
}
impl Walker {
    fn report(&mut self, code: Code, name: String) {
        if self.said.insert((code, name.clone())) {
            self.out.push(Finding { code, name });
        }
    }
    fn read<'a>(&mut self, e: &'a Expr, st: &mut State, sh: &IndexSet<String>, local: &Closures<'a>, depth: &[*const Expr]) {
        let mut path: Path = vec![];
        let mut x = e;
        loop {
            match &x.k {
                ExprKind::Member { o, p, .. } => {
                    path.insert(0, p.clone());
                    x = o;
                }
                ExprKind::Index { o, i, .. } => {
                    path.insert(0, lit_key(i));
                    self.read(i, st, sh, local, depth);
                    x = o;
                }
                _ => break,
            }
        }
        let root = match &x.k {
            ExprKind::Id(n) if !sh.contains(n) => Some(key(n, false)),
            ExprKind::Use(n) => Some(key(n, true)),
            _ => None,
        };
        if let Some(k) = root {
            if st.written.get(&k).is_some_and(|ws| ws.iter().any(|w| overlaps(w, &path))) {
                self.report(Code::StaleOwnRead, k);
            }
            return;
        }
        if !std::ptr::eq(x, e) {
            self.read(x, st, sh, local, depth);
            return;
        }
        match &x.k {
            ExprKind::Fn { .. } | ExprKind::ServerFn { .. } | ExprKind::Draft { .. } | ExprKind::Pending(_) | ExprKind::Latest(_) | ExprKind::Lit(_) | ExprKind::Pre { .. } | ExprKind::Peek(_) | ExprKind::StyleMap { .. } => {}
            ExprKind::Call { f, args } => {
                let c = called_closure(x, local);
                for a in args {
                    self.read(a, st, sh, local, depth);
                }
                if let Some(c) = c {
                    if !depth.contains(&(c as *const Expr)) {
                        let (params, body) = fn_parts(c);
                        let mut inner = sh.clone();
                        for p in params {
                            inner.insert(p.clone());
                        }
                        let mut d = depth.to_vec();
                        d.push(c as *const Expr);
                        let after = self.walk(body, alive(st), &inner, local, &d);
                        st.written = after.written;
                        st.held = after.held;
                        st.epoch = after.epoch;
                    }
                    return;
                }
                self.read(f, st, sh, local, depth);
            }
            ExprKind::Id(_) | ExprKind::Use(_) | ExprKind::Member { .. } | ExprKind::Index { .. } => {}
            ExprKind::Bin { l, r, .. } => {
                self.read(l, st, sh, local, depth);
                self.read(r, st, sh, local, depth);
            }
            ExprKind::Un { e, .. } | ExprKind::Spread(e) | ExprKind::Throw(e) => self.read(e, st, sh, local, depth),
            ExprKind::Await { e, init, .. } => {
                self.read(e, st, sh, local, depth);
                if let Some(i) = init {
                    self.read(i, st, sh, local, depth);
                }
            }
            ExprKind::If { c, t, f } => {
                self.read(c, st, sh, local, depth);
                self.read(t, st, sh, local, depth);
                self.read(f, st, sh, local, depth);
            }
            ExprKind::Tpl(parts) => {
                for p in parts {
                    if let TplPart::Expr(e) = p {
                        self.read(e, st, sh, local, depth);
                    }
                }
            }
            ExprKind::Arr(items) => {
                for i in items {
                    self.read(i, st, sh, local, depth);
                }
            }
            ExprKind::Rec(fields) => {
                for f in fields {
                    match f {
                        Field::Kv { v, .. } => self.read(v, st, sh, local, depth),
                        Field::Spread(e) => self.read(e, st, sh, local, depth),
                    }
                }
            }
            ExprKind::Catch { e, alt, .. } => {
                self.read(e, st, sh, local, depth);
                self.read(alt, st, sh, local, depth);
            }
        }
    }
    /// AC-1e: the source reads a value is computed from now — read directly (at this epoch) or through a local's taint.
    /// A closure's body runs later; an awaited answer is the server's, not a snapshot of a source.
    fn deps(&self, e: &Expr, st: &State, sh: &IndexSet<String>, out: &mut Vec<Dep>) {
        let mut path: Path = vec![];
        let mut x = e;
        loop {
            match &x.k {
                ExprKind::Member { o, p, .. } => {
                    path.insert(0, p.clone());
                    x = o;
                }
                ExprKind::Index { o, i, .. } => {
                    path.insert(0, lit_key(i));
                    self.deps(i, st, sh, out);
                    x = o;
                }
                _ => break,
            }
        }
        match &x.k {
            ExprKind::Id(n) if sh.contains(n) => {
                if let Some(t) = st.taint.get(n) {
                    out.extend(t.iter().cloned());
                }
                return;
            }
            ExprKind::Id(n) => {
                out.push((key(n, false), path, st.epoch));
                return;
            }
            ExprKind::Use(n) => {
                out.push((key(n, true), path, st.epoch));
                return;
            }
            _ => {}
        }
        if !std::ptr::eq(x, e) {
            self.deps(x, st, sh, out);
            return;
        }
        match &x.k {
            ExprKind::Fn { .. } | ExprKind::ServerFn { .. } | ExprKind::Draft { .. } | ExprKind::Pending(_) | ExprKind::Latest(_) | ExprKind::Lit(_) | ExprKind::Pre { .. } | ExprKind::Peek(_) | ExprKind::StyleMap { .. } | ExprKind::Await { .. } => {}
            ExprKind::Id(_) | ExprKind::Use(_) | ExprKind::Member { .. } | ExprKind::Index { .. } => {}
            ExprKind::Call { f, args } => {
                self.deps(f, st, sh, out);
                for a in args {
                    self.deps(a, st, sh, out);
                }
            }
            ExprKind::Bin { l, r, .. } => {
                self.deps(l, st, sh, out);
                self.deps(r, st, sh, out);
            }
            ExprKind::Un { e, .. } | ExprKind::Spread(e) | ExprKind::Throw(e) => self.deps(e, st, sh, out),
            ExprKind::If { c, t, f } => {
                self.deps(c, st, sh, out);
                self.deps(t, st, sh, out);
                self.deps(f, st, sh, out);
            }
            ExprKind::Tpl(parts) => {
                for p in parts {
                    if let TplPart::Expr(e) = p {
                        self.deps(e, st, sh, out);
                    }
                }
            }
            ExprKind::Arr(items) => {
                for i in items {
                    self.deps(i, st, sh, out);
                }
            }
            ExprKind::Rec(fields) => {
                for f in fields {
                    match f {
                        Field::Kv { v, .. } => self.deps(v, st, sh, out),
                        Field::Spread(e) => self.deps(e, st, sh, out),
                    }
                }
            }
            ExprKind::Catch { e, alt, .. } => {
                self.deps(e, st, sh, out);
                self.deps(alt, st, sh, out);
            }
        }
    }
    fn walk<'a>(&mut self, ss: &'a [Stmt], mut st: State, shadow: &IndexSet<String>, cl: &Closures<'a>, depth: &[*const Expr]) -> State {
        let mut sh = shadow.clone();
        let mut local = cl.clone();
        for s in ss {
            if st.dead {
                break;
            }
            match &s.k {
                StmtKind::Let { e, .. } | StmtKind::Expr(e) => {
                    self.read(e, &mut st, &sh, &local, depth);
                    let mut d = vec![];
                    if !stmt_await(s) {
                        self.deps(e, &st, &sh, &mut d);
                    }
                    if stmt_await(s) {
                        st.epoch += 1;
                        if self.action {
                            for h in std::mem::take(&mut st.held) {
                                self.report(Code::HeldWrite, h);
                            }
                        } else {
                            st.written.clear();
                        }
                    }
                    if let StmtKind::Let { name, .. } = &s.k {
                        sh.insert(name.clone());
                        st.taint.insert(name.clone(), d);
                        match closure_of(s) {
                            Some(c) => {
                                local.insert(name.clone(), c);
                            }
                            None => {
                                local.shift_remove(name);
                            }
                        }
                    }
                }
                StmtKind::Write { target, e } | StmtKind::Optimistic { target, e } => {
                    for p in &target.path {
                        if let PathSeg::Expr(p) = p {
                            self.read(p, &mut st, &sh, &local, depth);
                        }
                    }
                    if !matches!(e.k, ExprKind::Fn { .. }) {
                        self.read(e, &mut st, &sh, &local, depth);
                    }
                    let k = key(&target.name, target.is_ctx());
                    let path: Path = target.path.iter().map(|p| match p { PathSeg::Name(n) => n.clone(), PathSeg::Expr(e) => lit_key(e) }).collect();
                    if matches!(s.k, StmtKind::Write { .. }) && !matches!(e.k, ExprKind::Fn { .. }) {
                        let mut d = vec![];
                        self.deps(e, &st, &sh, &mut d);
                        if d.iter().any(|(dk, dp, ep)| *dk == k && *ep < st.epoch && overlaps(dp, &path)) {
                            self.report(Code::StaleWriteBack, k.clone());
                        }
                    }
                    st.written.entry(k.clone()).or_default().push(path);
                    if matches!(s.k, StmtKind::Write { .. }) && self.inferred {
                        st.held.insert(k);
                    }
                }
                StmtKind::Return(e) => {
                    if let Some(e) = e {
                        self.read(e, &mut st, &sh, &local, depth);
                    }
                    st.dead = true;
                }
                StmtKind::Throw(e) => {
                    self.read(e, &mut st, &sh, &local, depth);
                    st.dead = true;
                }
                StmtKind::Sif { c, t, f } => {
                    self.read(c, &mut st, &sh, &local, depth);
                    let a = self.walk(t, st.clone(), &sh, &local, depth);
                    let b = self.walk(f, st.clone(), &sh, &local, depth);
                    st = merge(&[&a, &b]);
                }
                StmtKind::Try { body, catch_name, handler, fin, .. } => {
                    let before = st.clone();
                    let b = self.walk(body, st.clone(), &sh, &local, depth);
                    let caught = handler.as_ref().map(|h| {
                        let mut hs = sh.clone();
                        if let Some(n) = catch_name {
                            hs.insert(n.clone());
                        }
                        self.walk(h, merge(&[&before, &alive(&b)]), &hs, &local, depth)
                    });
                    let end = match &caught {
                        Some(c) => merge(&[&b, c]),
                        None => b,
                    };
                    st = match fin {
                        Some(f) => {
                            let mut r = self.walk(f, merge(&[&before, &alive(&end)]), &sh, &local, depth);
                            r.dead = r.dead || end.dead;
                            r
                        }
                        None => end,
                    };
                }
                StmtKind::Action(_) | StmtKind::Refresh(_) | StmtKind::Affects(_) => {}
            }
        }
        st
    }
}

/// AC-1c, AC-1d and AC-1e over one imperative run (`runFindings` in `ref/src/infer.ts`). `action`: the body is one change across
/// its awaits (AC-1); a plain run's change ends at each `await`. `inferred`: an action by AC-1b, the only kind HELD_WRITE
/// applies to. `bound`: the run's parameters. Each finding once per name, in source order.
pub fn run_findings(stmts: &[Stmt], action: bool, bound: &[String], inferred: bool) -> Vec<Finding> {
    let mut w = Walker { out: vec![], said: HashSet::new(), action, inferred };
    let sh: IndexSet<String> = bound.iter().cloned().collect();
    w.walk(stmts, State { written: IndexMap::new(), held: IndexSet::new(), dead: false, taint: IndexMap::new(), epoch: 0 }, &sh, &IndexMap::new(), &[]);
    w.out
}
