//! The checker: spec/08-constraints.md, ported from `ref/src/check.ts`. Every diagnostic is an error (CN-1a); codes keep
//! Solid's names where one exists (CN-1b); `rule` is the spec rule enforced. Names resolve lexically (RG-7a); provisions
//! resolve through the static application tree (RG-7b). The walk also records the resolved model (CP-6, `model.rs`).
//!
//! The port keeps the reference's structure — a walk that records readers, applications, actions and provisions, lazy row
//! and failure thunks over symbols, and a resolution over the application tree after the walk — so that its verdicts,
//! messages and their order are the reference's (`ref/crate.ts` diffs them on every scenario program).

use crate::ast::*;
use crate::content::{misnested, misnested_inside, Shape, P_CLOSERS, P_SCOPE};
use crate::infer::{inferred_action, run_findings, trigger_text, Code};
use crate::model::{ModelBuilder, ModelSymbol};
use crate::modules::ModuleSet;
use crate::parse::{js_trim, JsDecl};
use crate::signature::{Catch, CompSig, ExportSig, ModSig, Own, PropSig, SigParam, HOLD};
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq)]
pub struct Diagnostic {
    pub code: String,
    pub rule: String,
    pub line: i64,
    pub msg: String,
    pub file: Option<String>,
}
impl Diagnostic {
    pub fn to_json(&self) -> serde_json::Value {
        let mut m = serde_json::Map::new();
        m.insert("code".into(), self.code.clone().into());
        m.insert("rule".into(), self.rule.clone().into());
        m.insert("line".into(), self.line.into());
        m.insert("msg".into(), self.msg.clone().into());
        if let Some(f) = &self.file {
            m.insert("file".into(), f.clone().into());
        }
        serde_json::Value::Object(m)
    }
}

const BUILTINS: &[&str] = &["len", "str", "map", "filter", "sum", "fail", "fetch", "every", "indexOf"];
/// EF-5's cleanup shapes: a `return` of a closure anywhere in the body, a closure as its last expression, or an expression body that is one.
fn returns_closure(f: &Expr) -> bool {
    fn in_stmts(ss: &[Stmt]) -> bool {
        ss.iter().any(|s| match &s.k {
            StmtKind::Return(Some(Expr { k: ExprKind::Fn { .. }, .. })) => true,
            StmtKind::Sif { t, f, .. } => in_stmts(t) || in_stmts(f),
            StmtKind::Try { body, handler, fin, .. } => in_stmts(body) || handler.as_deref().is_some_and(in_stmts) || fin.as_deref().is_some_and(in_stmts),
            _ => false,
        })
    }
    match &f.k {
        ExprKind::Fn { stmts: None, body, .. } => matches!(body.k, ExprKind::Fn { .. }),
        ExprKind::Fn { stmts: Some(ss), .. } => in_stmts(ss) || matches!(ss.last().map(|s| &s.k), Some(StmtKind::Expr(Expr { k: ExprKind::Fn { .. }, .. }))),
        _ => false,
    }
}

fn is_handler(attr: &str) -> bool {
    let b = attr.as_bytes();
    b.len() > 2 && b[0] == b'o' && b[1] == b'n' && (b[2].is_ascii_uppercase() || b[2] == b':')
}
fn is_upper_tag(tag: &str) -> bool {
    tag.as_bytes().first().is_some_and(|c| c.is_ascii_uppercase())
}
static ROW_WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^((?:io|pending|lane|fails\([^)]*\))\s+)+").unwrap());
static DOLLAR_PARAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\$\d+$").unwrap());
static USE_JSON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""k":"use","name":"([^"]+)""#).unwrap());
static AT_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"@\d+$").unwrap());

/// `s.split(/\s+(?![^(]*\))/)`: whitespace runs, except those inside a parenthesis.
fn split_rows(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    let mut k = 0;
    while k < chars.len() {
        let (_, c) = chars[k];
        if c.is_whitespace() {
            let mut j = k;
            while j < chars.len() && chars[j].1.is_whitespace() {
                j += 1;
            }
            let after = if j < chars.len() { &s[chars[j].0..] } else { "" };
            let inside = match after.find(['(', ')']) {
                Some(i) => after.as_bytes()[i] == b')',
                None => false,
            };
            if inside {
                for (_, c) in &chars[k..j] {
                    cur.push(*c);
                }
            } else {
                out.push(std::mem::take(&mut cur));
            }
            k = j;
        } else {
            cur.push(c);
            k += 1;
        }
    }
    out.push(cur);
    out
}

/// A context key (`file#name`, `@n` for one declared in a block) → its name.
pub fn key_name(k: &str) -> String {
    let last = k.split('#').last().unwrap_or("");
    AT_SUFFIX.replace(last, "").to_string()
}

type RId = usize;
type SId = usize;
type EId = usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SymKind {
    Source,
    Eq,
    Props,
    Value,
    Fn,
    Action,
    Comp,
    Import,
    ErrClass,
    Context,
    Server,
}
impl SymKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SymKind::Source => "source",
            SymKind::Eq => "eq",
            SymKind::Props => "props",
            SymKind::Value => "value",
            SymKind::Fn => "fn",
            SymKind::Action => "action",
            SymKind::Comp => "comp",
            SymKind::Import => "import",
            SymKind::ErrClass => "errclass",
            SymKind::Context => "context",
            SymKind::Server => "server",
        }
    }
    fn reactive(self) -> bool {
        matches!(self, SymKind::Source | SymKind::Eq | SymKind::Props)
    }
}

struct Region {
    id: usize,
    depth: i64,
    parent: Option<RId>,
    component: Option<RId>,
    is_component_root: bool,
    provides: IndexSet<String>,
    catches: Option<Catch>,
    /// children passed to a component: (the component's root, the site)
    kids: Option<(RId, RId)>,
    sig: Option<CompSig>,
}

#[derive(Clone)]
struct PropRef {
    comp: RId,
    field: String,
    pre: Vec<Catch>,
}
#[derive(Clone, Default)]
struct Fails {
    cls: IndexSet<String>,
    props: Vec<PropRef>,
}
impl Fails {
    fn add(&mut self, b: Fails) {
        for x in b.cls {
            self.cls.insert(x);
        }
        self.props.extend(b.props);
    }
}

enum RowsT<'a> {
    Expr { e: &'a Expr, env: EId, cache: Option<IndexSet<String>>, busy: bool },
    Fixed(IndexSet<String>),
}
enum FailsT<'a> {
    Expr { e: &'a Expr, env: EId, cache: Option<Fails>, busy: bool },
    Fixed(IndexSet<String>),
}
enum ServerRejects<'a> {
    Body { body: &'a [Stmt], env: EId, cache: Option<IndexSet<String>> },
    Fixed(IndexSet<String>),
}

#[derive(Clone)]
struct CtxInfo {
    key: String,
    source: bool,
    dflt: bool,
    contract: Option<(IndexSet<String>, IndexSet<String>)>,
}

struct Sym<'a> {
    kind: SymKind,
    name: String,
    region: RId,
    line: i64,
    question: bool,
    io: bool,
    /// a fn's parameter: never a write target (O-4)
    param: bool,
    instantiating: bool,
    params: Option<Vec<SigParam>>,
    captures: Vec<SId>,
    /// what calling that value can return holding (O-3); None: as `captures`
    ret_captures: Option<Vec<SId>>,
    /// O-3: not a name but a prop's argument, stored — its captures are the caller's ("*": all of props)
    prop_of: Option<(RId, String)>,
    maps_records: bool,
    rows: Option<RowsT<'a>>,
    comp: Option<&'a Decl>,
    expr: Option<(&'a Expr, EId)>,
    comp_region: Option<RId>,
    comp_env: Option<EId>,
    fails_t: Option<FailsT<'a>>,
    fn_tail: Option<(&'a Expr, EId)>,
    rejects: Option<IndexSet<String>>,
    imported: Option<String>,
    ctx: Option<CtxInfo>,
    side: Option<Side>,
    io_via: Option<String>,
    server_rejects: Option<ServerRejects<'a>>,
    fn_decl: Option<&'a Decl>,
    decl_env: Option<EId>,
}
impl<'a> Sym<'a> {
    fn new(kind: SymKind, name: &str, region: RId, line: i64) -> Self {
        Sym {
            kind,
            name: name.to_string(),
            region,
            line,
            question: false,
            io: false,
            param: false,
            instantiating: false,
            params: None,
            captures: vec![],
            ret_captures: None,
            prop_of: None,
            maps_records: false,
            rows: None,
            comp: None,
            expr: None,
            comp_region: None,
            comp_env: None,
            fails_t: None,
            fn_tail: None,
            rejects: None,
            imported: None,
            ctx: None,
            side: None,
            io_via: None,
            server_rejects: None,
            fn_decl: None,
            decl_env: None,
        }
    }
}

struct Env {
    vars: IndexMap<String, SId>,
    parent: Option<EId>,
    region: RId,
}

#[derive(Clone, Copy, Default)]
struct Ctx {
    imperative: bool,
    in_fn: bool,
    in_action: bool,
    server: bool,
}
impl Ctx {
    fn reactive() -> Ctx {
        Ctx::default()
    }
    fn imperative() -> Ctx {
        Ctx { imperative: true, ..Ctx::default() }
    }
}

/// R-8: the names a handler reads as snapshots (not under `pending?` or `peek`), each with whether a `try` or a `catch`
/// expression around it takes its failure; `locals`: the names the handler binds itself (parameters, `let`s).
fn snapshot_reads<'a>(n: Node<'a>, caught: bool, locals: &mut HashSet<String>, out: &mut Vec<(String, bool)>) {
    match n {
        Node::E(e) => match &e.k {
            ExprKind::Id(name) => {
                out.push((name.clone(), caught));
                return;
            }
            ExprKind::Pending(_) | ExprKind::Peek(_) => return,
            ExprKind::Fn { params, .. } => locals.extend(params.iter().cloned()),
            ExprKind::Catch { e: inner, alt, .. } => {
                snapshot_reads(Node::E(inner), true, locals, out);
                snapshot_reads(Node::E(alt), caught, locals, out);
                return;
            }
            _ => {}
        },
        Node::S(st) => match &st.k {
            StmtKind::Let { name, .. } => {
                locals.insert(name.clone());
            }
            StmtKind::Try { body, handler, fin, catch_name, .. } => {
                for x in body {
                    snapshot_reads(Node::S(x), caught || handler.is_some(), locals, out);
                }
                if let Some(n) = catch_name {
                    locals.insert(n.clone());
                }
                for x in handler.iter().chain(fin.iter()).flatten() {
                    snapshot_reads(Node::S(x), caught, locals, out);
                }
                return;
            }
            _ => {}
        },
    }
    for c in children(n, false) {
        snapshot_reads(c, caught, locals, out);
    }
}
/// A node the reference walks generically (`Object.values`): an expression, or a statement inside one.
#[derive(Clone, Copy)]
pub(crate) enum Node<'a> {
    E(&'a Expr),
    S(&'a Stmt),
}
/// The children of a node in the order `Object.values` gives them; `paths`: also a write's target path (an object without
/// `k`, which only a walk over every value reaches).
pub(crate) fn children<'a>(n: Node<'a>, paths: bool) -> Vec<Node<'a>> {
    let mut out = vec![];
    let ss = |out: &mut Vec<Node<'a>>, ss: &'a [Stmt]| out.extend(ss.iter().map(Node::S));
    match n {
        Node::E(e) => match &e.k {
            ExprKind::Lit(_) | ExprKind::Id(_) | ExprKind::Use(_) | ExprKind::StyleMap { .. } => {}
            ExprKind::Bin { l, r, .. } => out.extend([Node::E(l), Node::E(r)]),
            ExprKind::Un { e, .. } | ExprKind::Peek(e) | ExprKind::Latest(e) | ExprKind::Pending(e) | ExprKind::Spread(e) | ExprKind::Throw(e) => out.push(Node::E(e)),
            ExprKind::Pre { init, .. } => out.extend(init.iter().map(|x| Node::E(x))),
            ExprKind::Await { e, init, .. } => {
                out.push(Node::E(e));
                out.extend(init.iter().map(|x| Node::E(x)));
            }
            ExprKind::If { c, t, f } => out.extend([Node::E(c), Node::E(t), Node::E(f)]),
            ExprKind::Tpl(parts) => out.extend(parts.iter().filter_map(|p| if let TplPart::Expr(e) = p { Some(Node::E(e)) } else { None })),
            ExprKind::Member { o, .. } => out.push(Node::E(o)),
            ExprKind::Index { o, i, .. } => out.extend([Node::E(o), Node::E(i)]),
            ExprKind::Call { f, args } => {
                out.push(Node::E(f));
                out.extend(args.iter().map(Node::E));
            }
            ExprKind::Arr(items) => out.extend(items.iter().map(Node::E)),
            ExprKind::Rec(fields) => out.extend(fields.iter().map(|f| match f {
                Field::Kv { v, .. } => Node::E(v),
                Field::Spread(e) => Node::E(e),
            })),
            ExprKind::Fn { body, stmts, .. } => {
                out.push(Node::E(body));
                if let Some(s) = stmts {
                    ss(&mut out, s);
                }
            }
            ExprKind::Draft { seed, body } => {
                out.push(Node::E(seed));
                ss(&mut out, body);
            }
            ExprKind::Catch { e, alt, .. } => out.extend([Node::E(e), Node::E(alt)]),
            ExprKind::ServerFn { body, .. } => ss(&mut out, body),
        },
        Node::S(s) => match &s.k {
            StmtKind::Write { target, e } | StmtKind::Optimistic { target, e } => {
                if paths {
                    out.extend(target.path.iter().filter_map(|p| if let PathSeg::Expr(x) = p { Some(Node::E(x)) } else { None }));
                }
                out.push(Node::E(e));
            }
            StmtKind::Let { e, .. } | StmtKind::Expr(e) | StmtKind::Throw(e) => out.push(Node::E(e)),
            StmtKind::Refresh(_) | StmtKind::Affects(_) => {}
            StmtKind::Action(body) => ss(&mut out, body),
            StmtKind::Sif { c, t, f } => {
                out.push(Node::E(c));
                ss(&mut out, t);
                ss(&mut out, f);
            }
            StmtKind::Return(e) => out.extend(e.iter().map(Node::E)),
            StmtKind::Try { body, handler, fin, .. } => {
                ss(&mut out, body);
                if let Some(h) = handler {
                    ss(&mut out, h);
                }
                if let Some(f) = fin {
                    ss(&mut out, f);
                }
            }
        },
    }
    out
}

// ---------------------------------------------------------------- free names
/// Free identifiers of an expression (`pre:x` for `pre x`), minus names bound inside it.
fn free_names(e: &Expr, bound: &HashSet<String>, out: &mut IndexSet<String>) {
    let go = |x: &Expr, out: &mut IndexSet<String>| free_names(x, bound, out);
    match &e.k {
        ExprKind::Lit(_) | ExprKind::Use(_) => {}
        ExprKind::Id(n) => {
            if !bound.contains(n) {
                out.insert(n.clone());
            }
        }
        ExprKind::Pre { name, .. } => {
            if !bound.contains(name) {
                out.insert(format!("pre:{}", name));
            }
        }
        ExprKind::Peek(x) => go(x, out),
        ExprKind::Await { e, init, .. } => {
            go(e, out);
            if let Some(i) = init {
                go(i, out);
            }
        }
        ExprKind::Latest(x) | ExprKind::Pending(x) | ExprKind::Un { e: x, .. } | ExprKind::Spread(x) => go(x, out),
        ExprKind::Bin { l, r, .. } => {
            go(l, out);
            go(r, out);
        }
        ExprKind::If { c, t, f } => {
            go(c, out);
            go(t, out);
            go(f, out);
        }
        ExprKind::Tpl(parts) => {
            for p in parts {
                if let TplPart::Expr(x) = p {
                    go(x, out);
                }
            }
        }
        ExprKind::Member { o, .. } => go(o, out),
        ExprKind::Index { o, i, .. } => {
            go(o, out);
            go(i, out);
        }
        ExprKind::Call { f, args } => {
            go(f, out);
            for a in args {
                go(a, out);
            }
        }
        ExprKind::Arr(items) => {
            for a in items {
                go(a, out);
            }
        }
        ExprKind::Rec(fields) => {
            for f in fields {
                match f {
                    Field::Kv { v, .. } => go(v, out),
                    Field::Spread(x) => go(x, out),
                }
            }
        }
        ExprKind::Fn { params, body, stmts } => {
            let mut b = bound.clone();
            b.extend(params.iter().cloned());
            free_names(body, &b, out);
            if let Some(ss) = stmts {
                free_names_stmts(ss, &b, out);
            }
        }
        ExprKind::Draft { seed, body } => {
            go(seed, out);
            let mut b = bound.clone();
            b.insert("d".into());
            free_names_stmts(body, &b, out);
        }
        ExprKind::Throw(x) => go(x, out),
        ExprKind::Catch { e, name, alt, .. } => {
            go(e, out);
            match name {
                Some(n) => {
                    let mut b = bound.clone();
                    b.insert(n.clone());
                    free_names(alt, &b, out);
                }
                None => free_names(alt, bound, out),
            }
        }
        ExprKind::StyleMap { .. } | ExprKind::ServerFn { .. } => {}
    }
}
fn free_names_stmts(ss: &[Stmt], bound0: &HashSet<String>, out: &mut IndexSet<String>) {
    let mut bound = bound0.clone();
    for s in ss {
        match &s.k {
            StmtKind::Let { name, e, .. } => {
                free_names(e, &bound, out);
                bound.insert(name.clone());
            }
            StmtKind::Write { target, e } | StmtKind::Optimistic { target, e } => {
                if !target.is_ctx() && !bound.contains(&target.name) {
                    out.insert(target.name.clone());
                }
                for p in &target.path {
                    if let PathSeg::Expr(x) = p {
                        free_names(x, &bound, out);
                    }
                }
                free_names(e, &bound, out);
            }
            StmtKind::Expr(e) | StmtKind::Throw(e) => free_names(e, &bound, out),
            StmtKind::Return(e) => {
                if let Some(e) = e {
                    free_names(e, &bound, out);
                }
            }
            StmtKind::Refresh(n) | StmtKind::Affects(n) => {
                if !bound.contains(n) {
                    out.insert(n.clone());
                }
            }
            StmtKind::Action(body) => free_names_stmts(body, &bound, out),
            StmtKind::Sif { c, t, f } => {
                free_names(c, &bound, out);
                free_names_stmts(t, &bound, out);
                free_names_stmts(f, &bound, out);
            }
            StmtKind::Try { body, catch_name, handler, fin, .. } => {
                free_names_stmts(body, &bound, out);
                if let Some(h) = handler {
                    let mut b = bound.clone();
                    if let Some(n) = catch_name {
                        b.insert(n.clone());
                    }
                    free_names_stmts(h, &b, out);
                }
                if let Some(f) = fin {
                    free_names_stmts(f, &bound, out);
                }
            }
        }
    }
}
/// A closure whose body makes another closure (O-3: what calling it returns may hold one).
fn contains_fn(f: &Expr) -> bool {
    fn any(n: Node) -> bool {
        children(n, true).into_iter().any(|c| matches!(c, Node::E(Expr { k: ExprKind::Fn { .. }, .. })) || any(c))
    }
    any(Node::E(f))
}
fn names_of(e: &Expr) -> IndexSet<String> {
    let mut out = IndexSet::new();
    free_names(e, &HashSet::new(), &mut out);
    out
}
fn strip_pre(n: &str) -> &str {
    n.strip_prefix("pre:").unwrap_or(n)
}
/// Free names outside `peek` — the reads that make an initializer a snapshot (E-4).
fn reads_outside_peek(n: Node, out: &mut IndexSet<String>) {
    match n {
        Node::E(Expr { k: ExprKind::Peek(_), .. }) | Node::E(Expr { k: ExprKind::Fn { .. }, .. }) => {}
        Node::E(Expr { k: ExprKind::Id(name), .. }) => {
            out.insert(name.clone());
        }
        Node::E(Expr { k: ExprKind::Pre { name, .. }, .. }) => {
            out.insert(name.clone());
        }
        _ => {
            for c in children(n, false) {
                reads_outside_peek(c, out);
            }
        }
    }
}
/// `map(xs, x => ({…}))` / `xs.map(x => ({…}))`
fn maps_into_records(e: &Expr) -> bool {
    let ExprKind::Call { f, args } = &e.k else { return false };
    let fn_arg = match &f.k {
        ExprKind::Id(n) if n == "map" => args.get(1),
        ExprKind::Member { p, .. } if p == "map" => args.first(),
        _ => None,
    };
    matches!(fn_arg, Some(Expr { k: ExprKind::Fn { stmts: None, body, .. }, .. }) if matches!(&body.k, ExprKind::Rec(_)))
}
/// 12 SF-1d: the server fn a declaration's value is — itself, or wrapped by calls.
pub fn unwrap_server(e: &Expr) -> Option<&Expr> {
    match &e.k {
        ExprKind::ServerFn { .. } => Some(e),
        ExprKind::Call { args, .. } => {
            let inner: Vec<&Expr> = args.iter().filter_map(unwrap_server).collect();
            if inner.len() == 1 { Some(inner[0]) } else { None }
        }
        _ => None,
    }
}
fn js_string(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}
/// A short rendering of an expression, for messages.
pub fn show(e: &Expr) -> String {
    match &e.k {
        ExprKind::Lit(l) => match l {
            Lit::Undefined => "undefined".into(),
            Lit::Null => "null".into(),
            Lit::Bool(b) => b.to_string(),
            Lit::Num(n) => js_number(*n),
            Lit::Str(s) => js_string(s),
        },
        ExprKind::Id(n) => n.clone(),
        ExprKind::Member { o, p, .. } => format!("{}.{}", show(o), p),
        ExprKind::Call { f, .. } => format!("{}(…)", show(f)),
        ExprKind::Await { e, .. } => format!("await {}", show(e)),
        ExprKind::Latest(e) => format!("latest {}", show(e)),
        ExprKind::Peek(e) => format!("peek {}", show(e)),
        ExprKind::Throw(e) => format!("throw {}", show(e)),
        ExprKind::Index { o, .. } => format!("{}[…]", show(o)),
        ExprKind::Use(n) => format!("use {}", n),
        ExprKind::Catch { e, .. } => format!("{} catch …", show(e)),
        ExprKind::Tpl(_) => "`…`".into(),
        ExprKind::Bin { op, l, r } => format!("{} {} {}", show(l), op, show(r)),
        ExprKind::If { c, .. } => format!("{} ? … : …", show(c)),
        _ => "…".into(),
    }
}
pub fn js_number(n: f64) -> String {
    if n.is_nan() {
        "null".into()
    } else if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i128)
    } else {
        format!("{}", n)
    }
}

// ---------------------------------------------------------------- the checker

#[derive(Clone)]
struct Step {
    f: Option<Catch>,
    p: Option<Catch>,
}
#[derive(Clone)]
struct PFEntry {
    chain: Vec<Step>,
    term: Option<(i64, String)>,
}
#[derive(Clone)]
struct Item {
    cls: String,
    line: i64,
    what: String,
}
#[derive(Clone)]
struct Req {
    name: String,
    line: i64,
    what: String,
}
#[derive(Clone, Default)]
struct Esc {
    fails: Vec<Item>,
    reqs: Vec<Req>,
}
fn ck(c: &Option<Catch>) -> String {
    match c {
        None => "-".into(),
        Some(Catch::All) => "*".into(),
        Some(Catch::Set(s)) => {
            let mut v: Vec<&String> = s.iter().collect();
            v.sort();
            v.into_iter().cloned().collect::<Vec<_>>().join("|")
        }
    }
}
fn chain_key(c: &[Step]) -> String {
    c.iter().map(|x| format!("{}~{}", ck(&x.f), ck(&x.p))).collect::<Vec<_>>().join("/")
}
fn dedupe_chains(xs: Vec<Vec<Step>>) -> Vec<Vec<Step>> {
    let mut seen = HashSet::new();
    xs.into_iter().filter(|x| seen.insert(chain_key(x))).collect()
}
fn dedupe_entries(xs: Vec<PFEntry>) -> Vec<PFEntry> {
    let mut seen = HashSet::new();
    xs.into_iter()
        .filter(|x| {
            let term = match &x.term {
                None => "null".to_string(),
                Some((l, n)) => format!("{{\"line\":{},\"name\":{}}}", l, js_string(n)),
            };
            seen.insert(chain_key(&x.chain) + &term)
        })
        .collect()
}
fn esc_f(chain: &[Step], cls: &str) -> bool {
    !chain.iter().any(|s| s.f.as_ref().is_some_and(|f| f.caught(cls)))
}
fn esc_p(chain: &[Step], name: &str) -> bool {
    !chain.iter().any(|s| match &s.p {
        Some(Catch::All) => true,
        Some(Catch::Set(p)) => p.contains(name),
        None => false,
    })
}
fn meet(a: Catch, b: &Catch) -> Catch {
    match (a, b) {
        (Catch::All, b) => b.clone(),
        (a, Catch::All) => a,
        (Catch::Set(a), Catch::Set(b)) => Catch::Set(a.into_iter().filter(|x| b.contains(x)).collect()),
    }
}
fn along(chain: &[Step], f: bool) -> Catch {
    let mut out = IndexSet::new();
    for st in chain {
        let c = if f { &st.f } else { &st.p };
        match c {
            Some(Catch::All) => return Catch::All,
            Some(Catch::Set(s)) => out.extend(s.iter().cloned()),
            None => {}
        }
    }
    Catch::Set(out)
}

#[derive(Clone)]
enum Via {
    Reader(RId),
    Arg { comp: RId, field: String, site: RId },
    Action { line: i64, name: String },
}
#[derive(Clone)]
struct Occ {
    comp: RId,
    field: String,
    pre: Vec<Step>,
    via: Via,
}

struct UseRec {
    region: RId,
    name: String,
    line: i64,
    display: String,
}
struct ReaderRec<'a> {
    region: RId,
    e: &'a Expr,
    env: EId,
    line: i64,
}
/// R-8: an event handler on an element, with the element's attributes (its `disabled` covers the handler).
struct HandlerRec<'a> {
    attrs: &'a [Attr],
    h: &'a Expr,
    env: EId,
    region: RId,
    line: i64,
    what: String,
}
struct AppRec<'a> {
    comp: RId,
    site: RId,
    line: i64,
    tag: String,
    args: Vec<(String, &'a Expr, EId)>,
    /// every attribute, handlers too (O-3)
    passed: Vec<(String, &'a Expr, EId)>,
}
struct ActionRec<'a> {
    name: String,
    body: &'a [Stmt],
    env: EId,
    line: i64,
}
struct Provision<'a> {
    key: String,
    e: &'a Expr,
    env: EId,
}
enum Later<'a> {
    Content { ms: &'a [Markup], env: EId, anc: Vec<String> },
    Provide { name: String, e: &'a Expr, env: EId, line: i64, contract: (IndexSet<String>, IndexSet<String>) },
    RowFails { name: String, env: EId, fw: Option<String>, written: String, line: i64 },
    Escape { target: &'a Target, e: &'a Expr, tsym: Option<SId>, env: EId, line: i64 },
}

pub struct Opts<'a> {
    pub sigs: &'a IndexMap<String, ModSig>,
    pub file: Option<String>,
    pub declarations: &'a IndexMap<String, Vec<JsDecl>>,
    /// CN-3d: a client-only build (no SSR): a first load nothing holds shows nothing, so every reader that can have
    /// no value yet needs a `loading` region above it, as a client question's reader does (SV-7b).
    pub spa: bool,
}

pub struct Checker<'a> {
    pub diags: Vec<Diagnostic>,
    pub model: ModelBuilder,
    opts: Opts<'a>,
    root_env: Option<EId>,
    line: i64,
    seq: usize,
    uses: Vec<UseRec>,
    readers: Vec<ReaderRec<'a>>,
    /// CN-3e: `loading on(…)` regions (the region made, its `on`) and effect inputs, by where they are.
    load_ons: Vec<ReaderRec<'a>>,
    effect_ins: Vec<ReaderRec<'a>>,
    handlers: Vec<HandlerRec<'a>>,
    apps: Vec<AppRec<'a>>,
    actions: Vec<ActionRec<'a>>,
    provisions: Vec<Provision<'a>>,
    /// MO-1d: the symbols import declarations bound, which no declaration in a nested block may shadow.
    import_syms: HashSet<SId>,
    later: Vec<Later<'a>>,
    comp_syms: HashMap<RId, SId>,
    rows_busy: HashSet<String>,
    /// O-3: per component, the props it stores where they outlive it — "d:<depth>" (a source), "p:<key>" (a provision above)
    retains: HashMap<RId, IndexMap<String, IndexSet<String>>>,
    regions: Vec<Region>,
    syms: Vec<Sym<'a>>,
    envs: Vec<Env>,
    awaited_calls: HashSet<*const Expr>,
    server_exprs: HashMap<*const Expr, SId>,
    stmt_awaits: HashSet<*const Expr>,
    shapes: HashMap<SId, Option<Shape>>,
    // the application tree (resolve_tree), kept for the signature's component summaries
    occ: Vec<Occ>,
    r_memo: HashMap<RId, Vec<Vec<Step>>>,
    r_busy: HashSet<RId>,
    pf_memo: HashMap<(RId, String), Vec<PFEntry>>,
    pf_busy: HashSet<(RId, String)>,
    esc_memo: HashMap<Option<RId>, Esc>,
    esc_busy: HashSet<Option<RId>>,
    reader_f: Vec<(RId, &'a Expr, i64, Fails)>,
    arg_r: Vec<(usize, String)>,
    arg_f: Vec<(usize, String, Fails)>,
}

pub struct CheckResult {
    pub diags: Vec<Diagnostic>,
    pub sig: ModSig,
    pub model: serde_json::Value,
}

pub fn check_with_signature(p: &Program, opts: Opts) -> CheckResult {
    let file = opts.file.clone().unwrap_or_else(|| "main.rx".into());
    let mut c = Checker::new(opts);
    c.run(p);
    let sig = c.signature(p);
    let model = c.build_model(&file);
    CheckResult { diags: c.diags, sig, model }
}

pub struct Checked {
    pub diags: Vec<Diagnostic>,
    pub sigs: IndexMap<String, ModSig>,
    pub models: IndexMap<String, serde_json::Value>,
}
/// CN-4b / MO-3: check every module of a program, dependencies first, each against its imports' signatures only.
pub fn check_modules(set: &ModuleSet, spa: bool) -> Checked {
    let mut sigs: IndexMap<String, ModSig> = set.signatures.clone();
    let mut diags = set.diags.clone();
    let mut models = IndexMap::new();
    for path in &set.order {
        let r = check_with_signature(&set.programs[path], Opts { sigs: &sigs, file: Some(path.clone()), declarations: &set.declarations, spa });
        diags.extend(r.diags);
        sigs.insert(path.clone(), r.sig);
        models.insert(path.clone(), r.model);
    }
    Checked { diags, sigs, models }
}

impl<'a> Checker<'a> {
    pub fn new(opts: Opts<'a>) -> Self {
        Checker {
            diags: vec![],
            model: ModelBuilder::default(),
            opts,
            root_env: None,
            line: 1,
            seq: 0,
            uses: vec![],
            readers: vec![],
            load_ons: vec![],
            effect_ins: vec![],
            handlers: vec![],
            apps: vec![],
            actions: vec![],
            provisions: vec![],
            import_syms: HashSet::new(),
            later: vec![],
            comp_syms: HashMap::new(),
            rows_busy: HashSet::new(),
            retains: HashMap::new(),
            regions: vec![],
            syms: vec![],
            envs: vec![],
            awaited_calls: HashSet::new(),
            server_exprs: HashMap::new(),
            stmt_awaits: HashSet::new(),
            shapes: HashMap::new(),
            occ: vec![],
            r_memo: HashMap::new(),
            r_busy: HashSet::new(),
            pf_memo: HashMap::new(),
            pf_busy: HashSet::new(),
            esc_memo: HashMap::new(),
            esc_busy: HashSet::new(),
            reader_f: vec![],
            arg_r: vec![],
            arg_f: vec![],
        }
    }

    fn err(&mut self, code: &str, rule: &str, msg: String) {
        let line = self.line;
        if !self.diags.iter().any(|d| d.code == code && d.line == line && d.msg == msg) {
            self.diags.push(Diagnostic { code: code.into(), rule: rule.into(), line, msg, file: self.opts.file.clone() });
        }
    }
    fn region(&mut self, parent: Option<RId>, kind: &'static str, component: bool, name: Option<String>) -> RId {
        let id = self.seq;
        self.seq += 1;
        let r = self.regions.len();
        let depth = parent.map(|p| self.regions[p].depth + 1).unwrap_or(0);
        let comp = if component { Some(r) } else { parent.and_then(|p| self.regions[p].component) };
        self.regions.push(Region { id, depth, parent, component: comp, is_component_root: component, provides: IndexSet::new(), catches: None, kids: None, sig: None });
        self.model.region(id, kind, parent.map(|p| self.regions[p].id), name);
        r
    }
    fn env(&mut self, parent: Option<EId>, region: RId) -> EId {
        self.envs.push(Env { vars: IndexMap::new(), parent, region });
        self.envs.len() - 1
    }
    fn lookup(&self, env: EId, n: &str) -> Option<SId> {
        let mut e = Some(env);
        while let Some(i) = e {
            if let Some(&s) = self.envs[i].vars.get(n) {
                return Some(s);
            }
            e = self.envs[i].parent;
        }
        None
    }
    fn new_sym(&mut self, s: Sym<'a>) -> SId {
        self.syms.push(s);
        self.syms.len() - 1
    }
    /// A constant (`let`, a parameter, a row binding): bound, not part of the model.
    fn set_value(&mut self, env: EId, name: &str, line: i64) {
        let region = self.envs[env].region;
        let s = self.new_sym(Sym::new(SymKind::Value, name, region, line));
        self.envs[env].vars.insert(name.to_string(), s);
    }
    /// CP-6: a symbol bound in `env`, recorded for the model.
    fn bind(&mut self, env: EId, name: &str, sym: Sym<'a>) -> SId {
        let kind = sym.kind;
        let s = self.new_sym(sym);
        self.envs[env].vars.insert(name.to_string(), s);
        self.model.sym(s, kind.as_str());
        s
    }
    fn reg(&self, env: EId) -> RId {
        self.envs[env].region
    }
    /// CP-6: a computation the walk enters.
    fn comp<F: FnOnce(&mut Self)>(&mut self, kind: &'static str, env: EId, name: Option<String>, at: Option<String>, f: F) {
        let region = self.regions[self.reg(env)].id;
        let saved = self.model.within(kind, region, self.line, name, at);
        f(self);
        self.model.leave(saved);
    }
    fn read(&mut self, s: SId, ctx: Ctx, pre: bool, field: Option<&str>) {
        let kind = self.syms[s].kind.as_str();
        self.model.read(s, kind, ctx.imperative, pre, field);
    }
    pub fn build_model(&self, file: &str) -> serde_json::Value {
        self.model.build(file, |i| {
            let s = &self.syms[i];
            ModelSymbol {
                name: s.name.clone(),
                kind: s.kind.as_str(),
                region: self.regions[s.region].id,
                line: s.line,
                question: if s.kind == SymKind::Source { Some(s.question) } else { None },
                io: s.io,
                from: s.imported.clone(),
            }
        })
    }

    pub fn run(&mut self, p: &'a Program) {
        let r = self.region(None, "program", false, None);
        let root = self.env(None, r);
        self.root_env = Some(root);
        if p.legacy_view == Some(true) {
            self.line = p.view.first().and_then(|m| m.line).unwrap_or(1) as i64;
            self.err("TOP_LEVEL_MARKUP", "MO-1c", "markup at a module's top level: a module is declarations; the app's view is a component — `export default component App() { … }`".into());
        }
        self.block(&p.decls, &p.view, root, Ctx::reactive());
        self.later.push(Later::Content { ms: &p.view, env: root, anc: vec![] });
        let mut i = 0;
        while i < self.later.len() {
            let job = std::mem::replace(&mut self.later[i], Later::Content { ms: &[], env: root, anc: vec![] });
            self.run_later(job);
            i += 1;
        }
        self.retained();
        self.resolve_tree();
        self.loading_on_outside();
        self.snapshot_guards();
    }
    fn run_later(&mut self, job: Later<'a>) {
        match job {
            Later::Content { ms, env, anc } => self.content_check(ms, env, &anc),
            Later::Escape { target, e, tsym, env, line } => {
                self.line = line;
                self.escape(target, e, tsym, env);
            }
            Later::Provide { name, e, env, line, contract } => {
                let rows = self.rows_of(e, env);
                let f = self.fails_of(e, env, false, &HashMap::new());
                self.line = line;
                for r in rows {
                    if !contract.0.contains(&r) {
                        self.err("ROW_NARROWER_THAN_INFERRED", "RG-7e", format!("context {} is declared without `{}`, but this provision is {}", name, r, r));
                    }
                }
                for x in f.cls {
                    if !contract.1.contains("Error") && !contract.1.contains(&x) {
                        self.err("ROW_NARROWER_THAN_INFERRED", "RG-7e", format!("context {} is declared without fails({}), but this provision can fail with {}", name, x, x));
                    }
                }
            }
            Later::RowFails { name, env, fw, written, line } => {
                let Some(s) = self.envs[env].vars.get(&name).copied() else { return };
                if self.syms[s].fails_t.is_none() {
                    return;
                }
                let f = self.sym_fails(s);
                let allowed: Option<Vec<String>> = fw.as_ref().map(|fw| fw[6..fw.len() - 1].split('|').map(|x| js_trim(x).to_string()).filter(|x| !x.is_empty()).collect());
                let all = allowed.as_ref().is_none_or(|a| a.iter().any(|x| x == "Error"));
                if fw.is_none() && f.cls.is_empty() {
                    return;
                }
                for c in f.cls {
                    if fw.is_none() || (!all && !allowed.as_ref().unwrap().contains(&c)) {
                        self.line = line;
                        self.err("ROW_NARROWER_THAN_INFERRED", "CN-4a", format!("{} is declared `{}` but its value also fails with {}", name, written, c));
                    }
                }
            }
        }
    }

    // ---- blocks: declarations, then a view (02 §1, 03) ----
    fn block(&mut self, decls: &'a [Decl], view: &'a [Markup], env: EId, ctx: Ctx) {
        let region = self.reg(env);
        // 1. names (E-7: one declaration per name in a block)
        for d in decls {
            self.line = d.line() as i64;
            if let Decl::Import { names, .. } = d {
                if matches!(d, Decl::Import { resolved: Some(_), .. }) {
                    self.import_rx(d, env);
                } else if matches!(d, Decl::Import { declared: Some(_), .. }) {
                    self.import_declared(d, env);
                }
                if matches!(d, Decl::Import { resolved: Some(_), .. } | Decl::Import { declared: Some(_), .. }) {
                    for n in names {
                        if let Some(&s) = self.envs[env].vars.get(&n.alias) {
                            self.import_syms.insert(s);
                        }
                    }
                    continue;
                }
            }
            match d {
                Decl::Import { names, pure, fails, side, line, .. } => {
                    for n in names {
                        let mut s = Sym::new(SymKind::Import, &n.alias, region, *line as i64);
                        s.io = !pure;
                        s.rejects = Some(fails.clone().unwrap_or_else(|| vec!["Error".into()]).into_iter().collect());
                        s.side = *side;
                        let s = self.bind(env, &n.alias, s);
                        self.import_syms.insert(s);
                    }
                    continue;
                }
                Decl::Effect { .. } | Decl::Provide { .. } | Decl::TypeDecl { .. } => continue,
                Decl::Context { name, ty, source, dflt, line, exported, .. } => {
                    if self.envs[env].vars.contains_key(name) {
                        self.err("DUPLICATE_DECLARATION", "E-7", format!("{} is declared twice in one block", name));
                    }
                    let contract = if ty.as_ref().is_some_and(|t| ROW_WORDS.is_match(t)) || *exported { Some(contract_of(ty.as_deref())) } else { None };
                    if *source {
                        self.err("SOURCE_CONTEXT", "O-4", format!("context {}: source … is withdrawn (RG-7c, 2026-10-31): what is provided is read beneath it — provide the writes you allow, as actions (`context {}: {{ current: T; set: (v: T) => void }}`)", name, name));
                    }
                    let suffix = if self.regions[region].parent.is_some() {
                        let n = self.seq;
                        self.seq += 1;
                        format!("@{}", n)
                    } else {
                        String::new()
                    };
                    let key = format!("{}#{}{}", self.opts.file.as_deref().unwrap_or("main.rx"), name, suffix);
                    let mut s = Sym::new(SymKind::Context, name, region, *line as i64);
                    s.ctx = Some(CtxInfo { key: key.clone(), source: *source, dflt: dflt.is_some(), contract });
                    self.bind(env, name, s);
                    if let Some(e) = dflt {
                        self.provisions.push(Provision { key, e, env });
                    }
                    continue;
                }
                _ => {}
            }
            let name = d.name().unwrap();
            if let Some(&prev) = self.envs[env].vars.get(name) {
                if self.syms[prev].kind != SymKind::Import {
                    self.err("DUPLICATE_DECLARATION", "E-7", format!("{} is declared twice in one block", name));
                }
            }
            if let Some(shadowed) = self.envs[env].parent.and_then(|p| self.lookup(p, name)) {
                if self.import_syms.contains(&shadowed) {
                    self.err("SHADOWED_IMPORT", "MO-1d", format!("{} shadows the imported {}: rename one (`import {{ {} as … }}`)", name, name, name));
                }
            }
            let kind = match d {
                Decl::Fn { .. } => SymKind::Fn,
                Decl::Component { .. } => SymKind::Comp,
                Decl::Action { .. } => SymKind::Action,
                Decl::Server { .. } => SymKind::Server,
                Decl::Source { .. } => SymKind::Source,
                Decl::Error { .. } => SymKind::ErrClass,
                _ => SymKind::Eq,
            };
            let mut sym = Sym::new(kind, name, region, d.line() as i64);
            let mut server_expr = None;
            match d {
                Decl::Server { params, .. } => sym.params = Some(params.iter().map(|n| SigParam { name: n.clone(), r#ref: false, ty: None }).collect()),
                Decl::Source { question, .. } => sym.question = *question,
                Decl::Action { .. } => sym.io = true,
                Decl::Fn { params, decls: fdecls, .. } => {
                    sym.params = Some(params.iter().map(|p| SigParam { name: p.name.clone(), r#ref: p.r#ref, ty: p.ty.clone() }).collect());
                    sym.instantiating = params.iter().any(|p| p.r#ref) || !fdecls.is_empty();
                    sym.fn_decl = Some(d);
                    sym.decl_env = Some(env);
                }
                Decl::Component { name, .. } => {
                    sym.comp = Some(d);
                    let r = self.region(Some(region), "component", true, Some(name.clone()));
                    sym.comp_region = Some(r);
                }
                Decl::Eq { e, key, .. } => {
                    sym.maps_records = key.is_none() && maps_into_records(e);
                    if let ExprKind::Id(n) = &e.k {
                        if let Some(t) = self.lookup(env, n) {
                            if self.syms[t].io {
                                sym.io = true;
                            }
                        }
                    }
                    if let Some(sf) = unwrap_server(e) {
                        sym.kind = SymKind::Server;
                        if let ExprKind::ServerFn { params, .. } = &sf.k {
                            sym.params = Some(params.iter().map(|n| SigParam { name: n.clone(), r#ref: false, ty: None }).collect());
                        }
                        server_expr = Some(sf as *const Expr);
                    }
                }
                _ => {}
            }
            let comp_region = sym.comp_region;
            let s = self.bind(env, name, sym);
            if let Some(r) = comp_region {
                self.comp_syms.insert(r, s);
            }
            if let Some(p) = server_expr {
                self.server_exprs.insert(p, s);
            }
        }
        self.server_io(decls, env);
        for d in decls {
            if let Decl::Source { name, init, question: false, .. } = d {
                let s = self.envs[env].vars[name.as_str()];
                self.syms[s].fails_t = Some(FailsT::Expr { e: init, env, cache: None, busy: false });
            }
        }
        for d in decls {
            let (name, e) = match d {
                Decl::Eq { name, e, .. } => (name, e),
                Decl::Source { name, init, question: true, .. } => (name, init),
                _ => continue,
            };
            let s = self.envs[env].vars[name.as_str()];
            let sym = &mut self.syms[s];
            sym.rows = Some(RowsT::Expr { e, env, cache: None, busy: false });
            sym.expr = Some((e, env));
            sym.fails_t = Some(FailsT::Expr { e, env, cache: None, busy: false });
        }
        // 2. C-1 over this block's equations (the static graph, CN-3a)
        self.cycles(decls, env);
        // 3. each declaration
        for d in decls {
            self.line = d.line() as i64;
            self.decl(d, env, ctx);
        }
        // 4. the view
        let view_root = self.regions[region].is_component_root || self.regions[region].parent.is_none();
        self.markup(view, env, view_root);
    }

    /// 12 SF-1: a server fn is io when its body calls io — JS declared io, `log`, or another server fn that is.
    fn server_io(&mut self, decls: &'a [Decl], env: EId) {
        let mut servers: Vec<(&str, &[String], &[Stmt])> = vec![];
        for d in decls {
            match d {
                Decl::Server { name, params, body, .. } => servers.push((name, params, body)),
                Decl::Eq { name, e, .. } => {
                    if let Some(Expr { k: ExprKind::ServerFn { params, body, .. }, .. }) = unwrap_server(e) {
                        servers.push((name, params, body));
                    }
                }
                _ => {}
            }
        }
        let mut changed = true;
        while changed {
            changed = false;
            for (name, params, body) in &servers {
                let s = self.envs[env].vars[*name];
                if self.syms[s].io {
                    continue;
                }
                let mut calls = vec![];
                for st in body.iter() {
                    calls_in(Node::S(st), &mut calls);
                }
                let hit = calls.into_iter().find(|n| {
                    !params.contains(n)
                        && if n == "log" {
                            self.lookup(env, n).is_none()
                        } else {
                            self.lookup(env, n).is_some_and(|t| self.syms[t].io)
                        }
                });
                if let Some(h) = hit {
                    self.syms[s].io = true;
                    self.syms[s].io_via = Some(format!("{}(…)", h));
                    changed = true;
                }
            }
        }
    }

    /// MO-3/MO-4: bind an `.rx` import's names from its module's signature.
    fn import_rx(&mut self, d: &'a Decl, env: EId) {
        let Decl::Import { names, from, pure, line, fails, resolved, .. } = d else { return };
        let region = self.reg(env);
        let line = *line as i64;
        let sigs = self.opts.sigs;
        let sig = sigs.get(resolved.as_ref().unwrap());
        if fails.is_some() {
            self.err("IMPORT_ROW_MISMATCH", "MO-4", format!("`fails` asserts rows at the JS boundary; {} is .rx and its rows are its signature's", from));
        }
        for ImportName { name, alias } in names {
            let base = || Sym::new(SymKind::Import, alias, region, line);
            let Some(sig) = sig else {
                self.bind(env, alias, base());
                continue;
            };
            let Some(x) = sig.exports.get(name) else {
                self.err("NOT_EXPORTED", "MO-6", format!("{} does not export {}", from, if name == "default" { "a default".to_string() } else { name.clone() }));
                self.bind(env, alias, base());
                continue;
            };
            let set = |v: &Vec<String>| -> IndexSet<String> { v.iter().cloned().collect() };
            let sym = match x {
                ExportSig::Type => continue,
                ExportSig::Source { question, rows, fails } => {
                    let mut s = Sym::new(SymKind::Source, alias, region, line);
                    s.question = *question;
                    s.imported = Some(from.clone());
                    s.rows = Some(RowsT::Fixed(set(rows)));
                    s.fails_t = Some(FailsT::Fixed(set(fails)));
                    s
                }
                ExportSig::Eq { rows, fails, io } => {
                    let mut s = Sym::new(SymKind::Eq, alias, region, line);
                    s.io = *io;
                    s.rows = Some(RowsT::Fixed(set(rows)));
                    s.fails_t = Some(FailsT::Fixed(set(fails)));
                    s
                }
                ExportSig::Fn { params, instantiating, rows, fails, rejects } => {
                    let mut s = Sym::new(SymKind::Fn, alias, region, line);
                    s.params = Some(params.clone());
                    s.instantiating = *instantiating;
                    s.rows = Some(RowsT::Fixed(set(rows)));
                    s.fails_t = Some(FailsT::Fixed(set(fails)));
                    s.rejects = Some(set(rejects));
                    s
                }
                ExportSig::Action => {
                    let mut s = Sym::new(SymKind::Action, alias, region, line);
                    s.io = true;
                    s
                }
                ExportSig::Server { io, params, rejects } => {
                    let mut s = Sym::new(SymKind::Server, alias, region, line);
                    s.io = *io;
                    s.params = Some(params.iter().map(|n| SigParam { name: n.clone(), r#ref: false, ty: None }).collect());
                    s.server_rejects = Some(ServerRejects::Fixed(set(rejects)));
                    s
                }
                ExportSig::ErrClass { .. } => Sym::new(SymKind::ErrClass, alias, region, line),
                ExportSig::Comp { sig } => {
                    let r = self.region(None, "imported", true, Some(alias.clone()));
                    self.regions[r].sig = Some(sig.clone());
                    let mut s = Sym::new(SymKind::Comp, alias, region, line);
                    s.comp_region = Some(r);
                    s
                }
                ExportSig::Context { key, source, dflt, rows, fails, .. } => {
                    let mut s = Sym::new(SymKind::Context, alias, region, line);
                    s.ctx = Some(CtxInfo { key: key.clone(), source: *source, dflt: *dflt, contract: Some((set(rows), set(fails))) });
                    s
                }
            };
            if *pure && sym.io {
                self.err("IMPORT_ROW_MISMATCH", "MO-4", format!("{} is io in {}'s signature; `pure` cannot lower an .rx row", name, from));
            }
            self.bind(env, alias, sym);
        }
    }
    /// RG-7: the context a `provide`/`use` names — lexically, like any name.
    fn ctx_of(&mut self, name: &str, env: EId) -> Option<SId> {
        let Some(s) = self.lookup(env, name) else {
            self.err("UNBOUND", "RG-7", format!("{} is not declared here: declare the context (`context {}: T`) or import it", name, name));
            return None;
        };
        let k = self.syms[s].kind;
        if k != SymKind::Context {
            let what = match k {
                SymKind::Source => "a source".to_string(),
                SymKind::Eq => "an equation".to_string(),
                k => format!("a {}", k.as_str()),
            };
            self.err("NOT_A_CONTEXT", "RG-7", format!("{} is {}, not a context: `provide` and `use` name a `context` declaration", name, what));
            return None;
        }
        Some(s)
    }
    /// MO-8: bind a JS import's names from its declaration file.
    fn import_declared(&mut self, d: &'a Decl, env: EId) {
        let Decl::Import { names, from, pure, line, fails, side, declared, .. } = d else { return };
        let region = self.reg(env);
        let line = *line as i64;
        let declared = declared.as_ref().unwrap();
        let decls: &[JsDecl] = self.opts.declarations.get(declared).map(|v| v.as_slice()).unwrap_or(&[]);
        let file = declared.split('/').last().unwrap_or("").to_string();
        if fails.is_some() {
            self.err("IMPORT_ROW_MISMATCH", "MO-8", format!("{}'s rows are declared in {}: `fails` on the import cannot restate them", from, file));
        }
        for ImportName { name, alias } in names {
            let Some(x) = decls.iter().find(|y| y.name() == name) else {
                self.err("NOT_EXPORTED", "MO-8", format!("{} declares no export {} (declare it, or it is not {}'s)", file, name, from));
                let mut s = Sym::new(SymKind::Import, alias, region, line);
                s.io = true;
                self.bind(env, alias, s);
                continue;
            };
            match x {
                JsDecl::Type { .. } => continue,
                JsDecl::Error { .. } => {
                    self.bind(env, alias, Sym::new(SymKind::ErrClass, alias, region, line));
                    continue;
                }
                JsDecl::Fn { pure: xpure, side: xside, rejects, .. } => {
                    if *pure && !xpure {
                        self.err("IMPORT_ROW_MISMATCH", "MO-8", format!("{} is declared io in {} (`export fn`, not `export pure fn`); `pure` on the import cannot lower it", name, file));
                    }
                    if let Some(sd) = side {
                        if *xside != Some(*sd) {
                            self.err(
                                "IMPORT_ROW_MISMATCH",
                                "SF-5",
                                format!("{} is declared {} in {}; `{}` on the import cannot restate it", name, xside.map(|x| format!("`{}`", x.as_str())).unwrap_or_else(|| "for both sides".into()), file, sd.as_str()),
                            );
                        }
                    }
                    let mut s = Sym::new(SymKind::Import, alias, region, line);
                    s.io = !xpure;
                    s.rejects = Some(rejects.clone().unwrap_or_else(|| vec!["Error".into()]).into_iter().collect());
                    s.side = *xside;
                    self.bind(env, alias, s);
                }
            }
        }
    }

    /// MO-3: this module's signature — every export as an importer sees it.
    pub fn signature(&mut self, p: &'a Program) -> ModSig {
        let mut exports = IndexMap::new();
        let env = self.root_env.unwrap();
        let arr = |x: IndexSet<String>| -> Vec<String> { x.into_iter().collect() };
        for d in &p.decls {
            if !d.exported() {
                continue;
            }
            let Some(name) = d.name() else { continue };
            if let Decl::TypeDecl { .. } = d {
                exports.insert(name.to_string(), ExportSig::Type);
                continue;
            }
            let Some(&s) = self.envs[env].vars.get(name) else { continue };
            let x = match self.syms[s].kind {
                SymKind::Source => {
                    let rows = if self.syms[s].rows.is_some() { self.sym_rows(s) } else { IndexSet::new() };
                    let fails = if self.syms[s].fails_t.is_some() { self.sym_fails(s).cls } else { IndexSet::new() };
                    ExportSig::Source { question: self.syms[s].question, rows: arr(rows), fails: arr(fails) }
                }
                SymKind::Eq => {
                    let rows = if self.syms[s].rows.is_some() { self.sym_rows(s) } else { IndexSet::new() };
                    let fails = if self.syms[s].fails_t.is_some() { self.sym_fails(s).cls } else { IndexSet::new() };
                    ExportSig::Eq { rows: arr(rows), fails: arr(fails), io: self.syms[s].io }
                }
                SymKind::Fn => {
                    let rows = if self.syms[s].rows.is_some() { self.sym_rows(s) } else { IndexSet::new() };
                    let fails = if self.syms[s].fails_t.is_some() { self.sym_fails(s).cls } else { IndexSet::new() };
                    let rejects = match self.syms[s].fn_tail {
                        Some((t, te)) => self.rejects(t, te, &mut HashSet::new()),
                        None => self.syms[s].rejects.clone().unwrap_or_default(),
                    };
                    ExportSig::Fn { params: self.syms[s].params.clone().unwrap_or_default(), instantiating: self.syms[s].instantiating, rows: arr(rows), fails: arr(fails), rejects: arr(rejects) }
                }
                SymKind::Action => ExportSig::Action,
                SymKind::Server => {
                    let rejects = if self.syms[s].server_rejects.is_some() { self.sym_server_rejects(s) } else { IndexSet::new() };
                    ExportSig::Server { io: self.syms[s].io, params: self.syms[s].params.clone().unwrap_or_default().into_iter().map(|p| p.name).collect(), rejects: arr(rejects) }
                }
                SymKind::ErrClass => ExportSig::ErrClass { params: if let Decl::Error { params, .. } = d { params.clone() } else { vec![] } },
                SymKind::Comp => {
                    let r = self.syms[s].comp_region.unwrap();
                    ExportSig::Comp { sig: self.comp_sig(r) }
                }
                SymKind::Context => {
                    let c = self.syms[s].ctx.clone().unwrap();
                    let (rows, fails) = c.contract.clone().unwrap_or_default();
                    let ty = if let Decl::Context { ty, .. } = d { ty.as_ref().map(|t| ROW_WORDS.replace(t, "").to_string()) } else { None };
                    ExportSig::Context { key: c.key, source: c.source, dflt: c.dflt, rows: arr(rows), fails: arr(fails), ty }
                }
                _ => continue,
            };
            exports.insert(name.to_string(), x);
        }
        ModSig { file: self.opts.file.clone().unwrap_or_default(), exports }
    }

    fn cycles(&mut self, decls: &'a [Decl], env: EId) {
        let mut eqs: IndexMap<&str, (&'a Expr, i64)> = IndexMap::new();
        for d in decls {
            match d {
                Decl::Eq { name, e, line, .. } => {
                    eqs.insert(name, (e, *line as i64));
                }
                Decl::Source { name, init, line, question: true, .. } => {
                    eqs.insert(name, (init, *line as i64));
                }
                _ => {}
            }
        }
        let mut color: HashMap<String, u8> = HashMap::new();
        let mut reported: HashSet<String> = HashSet::new();
        let names: Vec<&str> = eqs.keys().copied().collect();
        for n in names {
            self.visit_cycle(n, &[], &eqs, env, &mut color, &mut reported);
        }
    }
    fn visit_cycle(&mut self, n: &str, stack: &[String], eqs: &IndexMap<&str, (&'a Expr, i64)>, env: EId, color: &mut HashMap<String, u8>, reported: &mut HashSet<String>) {
        if color.get(n) == Some(&2) {
            return;
        }
        if color.get(n) == Some(&1) {
            let at = stack.iter().position(|s| s == n).map(|i| i as i64).unwrap_or(-1);
            let from = if at < 0 { stack.len().saturating_sub(1) } else { at as usize };
            let mut cyc: Vec<String> = stack[from..].to_vec();
            cyc.push(n.to_string());
            let mut sorted = cyc.clone();
            sorted.sort();
            let key = sorted.join(",");
            if reported.insert(key) {
                self.line = eqs[n].1;
                self.err("CYCLE", "C-1", format!("instantaneous cycle: {} (break it with `pre`, C-2)", cyc.join(" → ")));
            }
            return;
        }
        color.insert(n.to_string(), 1);
        let names = names_of(eqs[n].0);
        let region = self.reg(env);
        for m0 in names {
            if m0 == format!("pre:{}", n) {
                continue;
            }
            let m = strip_pre(&m0);
            if eqs.contains_key(m) && self.envs[env].vars.get(m).is_some_and(|&s| self.syms[s].region == region) {
                let mut st = stack.to_vec();
                st.push(n.to_string());
                self.visit_cycle(m, &st, eqs, env, color, reported);
            }
        }
        color.insert(n.to_string(), 2);
    }

    // ---- rows (R-13) ----
    fn sym_rows(&mut self, s: SId) -> IndexSet<String> {
        let (e, env) = match &mut self.syms[s].rows {
            None => return IndexSet::new(),
            Some(RowsT::Fixed(x)) => return x.clone(),
            Some(RowsT::Expr { cache: Some(c), .. }) => return c.clone(),
            Some(RowsT::Expr { busy: true, .. }) => return IndexSet::new(),
            Some(RowsT::Expr { e, env, busy, .. }) => {
                *busy = true;
                (*e, *env)
            }
        };
        let rows = self.rows_of(e, env);
        if let Some(RowsT::Expr { e: e2, cache, busy, .. }) = &mut self.syms[s].rows {
            if std::ptr::eq(*e2, e) {
                *busy = false;
                *cache = Some(rows.clone());
            }
        }
        rows
    }
    /// A fresh rows thunk over `e`, evaluated once (`this.rowsThunk(e, env)()`).
    fn rows_of(&mut self, e: &'a Expr, env: EId) -> IndexSet<String> {
        let mut rows = IndexSet::new();
        self.rows_walk(Node::E(e), env, &mut rows);
        rows
    }
    fn rows_walk(&mut self, x: Node<'a>, env: EId, rows: &mut IndexSet<String>) {
        if let Node::E(e) = x {
            match &e.k {
                ExprKind::Await { e: inner, init, .. } => {
                    rows.insert("pending".into());
                    if init.is_none() && self.client_call(inner, env) {
                        rows.insert("client".into());
                    }
                }
                ExprKind::Latest(_) | ExprKind::Pending(_) => {
                    rows.insert("lane".into());
                }
                ExprKind::Fn { .. } | ExprKind::ServerFn { .. } => return,
                ExprKind::Use(name) => {
                    let Some(c) = self.lookup(env, name).and_then(|s| self.syms[s].ctx.clone()) else { return };
                    if let Some((r, _)) = &c.contract {
                        rows.extend(r.iter().cloned());
                        return;
                    }
                    let mut i = 0;
                    while i < self.provisions.len() {
                        let (pk, pe, penv) = (self.provisions[i].key.clone(), self.provisions[i].e, self.provisions[i].env);
                        if pk == c.key && !self.rows_busy.contains(&c.key) {
                            self.rows_busy.insert(c.key.clone());
                            let r = self.rows_of(pe, penv);
                            rows.extend(r);
                            self.rows_busy.remove(&c.key);
                        }
                        i += 1;
                    }
                    return;
                }
                ExprKind::Id(n) => {
                    if let Some(s) = self.lookup(env, n) {
                        if self.syms[s].rows.is_some() {
                            let r = self.sym_rows(s);
                            rows.extend(r);
                        }
                    }
                    return;
                }
                _ => {}
            }
        }
        for c in children(x, false) {
            self.rows_walk(c, env, rows);
        }
    }

    /// SF-5b: a call into `client` JS.
    fn client_call(&self, e: &Expr, env: EId) -> bool {
        let f = if let ExprKind::Catch { e, .. } = &e.k { &**e } else { e };
        match &f.k {
            ExprKind::Call { f, .. } => match &f.k {
                ExprKind::Id(n) => self.lookup(env, n).is_some_and(|s| self.syms[s].side == Some(Side::Client)),
                _ => false,
            },
            _ => false,
        }
    }

    fn decl(&mut self, d: &'a Decl, env: EId, ctx: Ctx) {
        let reactive = Ctx { in_fn: ctx.in_fn, ..Ctx::reactive() };
        match d {
            Decl::Import { fails, .. } => {
                if let Some(f) = fails {
                    for n in f {
                        self.err_class(n, env);
                    }
                }
            }
            Decl::TypeDecl { .. } => {}
            Decl::Error { params, msg, line, .. } => {
                if let Some(m) = msg {
                    let region = self.reg(env);
                    let inner = self.env(Some(env), region);
                    for p in params {
                        self.set_value(inner, p, *line as i64);
                    }
                    self.expr(m, inner, Ctx { in_fn: true, ..Ctx::reactive() }, None);
                }
            }
            Decl::Source { name, init, question, ty, .. } => {
                if *question {
                    self.comp("question", env, Some(name.clone()), None, |c| c.expr(init, env, reactive, None));
                    self.row_check(name, ty.as_deref(), env);
                    return;
                }
                let mut reads = IndexSet::new();
                reads_outside_peek(Node::E(init), &mut reads);
                let hit = reads.iter().find(|n| self.lookup(env, n).is_some_and(|s| self.syms[s].kind.reactive())).cloned();
                if let Some(h) = hit {
                    self.err("SNAPSHOT_INITIALIZER", "E-4", format!("source {} := … reads {} outside peek(…): write the snapshot as one (DV-6)", name, h));
                }
                let c2 = Ctx { in_fn: ctx.in_fn, ..Ctx::reactive() };
                self.comp("seed", env, Some(name.clone()), None, |c| {
                    c.model.snap += 1;
                    c.expr(init, env, c2, None);
                });
            }
            Decl::Eq { name, e, deferred, key, ty, .. } => {
                let kind = if *deferred {
                    "deferred"
                } else if key.is_some() {
                    "keyed"
                } else {
                    "memo"
                };
                if let ExprKind::Call { f, args } = &e.k {
                    if let ExprKind::Id(fname) = &f.k {
                        if let Some(fs) = self.lookup(env, fname) {
                            if self.syms[fs].kind == SymKind::Fn && self.syms[fs].instantiating {
                                self.snapshot_args(e, fs, env);
                                let params = self.syms[fs].params.clone().unwrap_or_default();
                                self.comp(kind, env, Some(name.clone()), None, |c| {
                                    c.model.call(Some(fs), "fn");
                                    for (i, a) in args.iter().enumerate() {
                                        let value = params.get(i).is_some_and(|p| !p.r#ref);
                                        if value {
                                            c.model.snap += 1;
                                        }
                                        c.expr(a, env, reactive, None);
                                        if value {
                                            c.model.snap -= 1;
                                        }
                                    }
                                });
                                self.row_check(name, ty.as_deref(), env);
                                return;
                            }
                        }
                    }
                }
                self.comp(kind, env, Some(name.clone()), None, |c| c.expr(e, env, reactive, None));
                self.row_check(name, ty.as_deref(), env);
            }
            Decl::Provide { name, e, .. } => {
                self.comp("provide", env, Some(name.clone()), None, |c| c.expr(e, env, reactive, None));
                let Some(c) = self.ctx_of(name, env) else { return };
                let info = self.syms[c].ctx.clone().unwrap();
                let region = self.reg(env);
                self.regions[region].provides.insert(info.key.clone());
                self.provisions.push(Provision { key: info.key.clone(), e, env });
                if let Some(contract) = info.contract {
                    let line = self.line;
                    self.later.push(Later::Provide { name: name.clone(), e, env, line, contract });
                }
            }
            Decl::Context { name, dflt, .. } => {
                if let Some(dflt) = dflt {
                    self.comp("default", env, Some(name.clone()), None, |c| c.expr(dflt, env, reactive, None));
                }
            }
            Decl::Effect { inputs, body, line, .. } => {
                for i in inputs {
                    self.effect_ins.push(ReaderRec { region: self.reg(env), e: i, env, line: *line as i64 });
                }
                self.comp("effect", env, None, None, |c| {
                    for i in inputs {
                        c.expr(i, env, reactive, None);
                    }
                    c.comp("apply", env, None, None, |c| {
                        let region = c.reg(env);
                        let inner = c.env(Some(env), region);
                        c.stmts(body, inner, Ctx::imperative());
                    });
                    c.run_checks(body, false, &[], false);
                });
                self.own_source_writes(inputs, body, env);
            }
            Decl::Action { name, params, body, line, .. } => {
                let region = self.reg(env);
                let inner = self.env(Some(env), region);
                for p in params {
                    self.set_value(inner, p, *line as i64);
                }
                self.comp("action", env, Some(name.clone()), None, |c| c.stmts(body, inner, Ctx { in_action: true, ..Ctx::imperative() }));
                self.actions.push(ActionRec { name: name.clone(), body, env: inner, line: *line as i64 });
                self.run_checks(body, true, params, false);
            }
            Decl::Server { name, params, body, line, .. } => {
                let region = self.reg(env);
                let inner = self.env(Some(env), region);
                for p in params {
                    self.set_value(inner, p, *line as i64);
                }
                self.comp("server", env, Some(name.clone()), None, |c| c.stmts(body, inner, Ctx { server: true, ..Ctx::imperative() }));
                let s = self.lookup(env, name).unwrap();
                self.syms[s].server_rejects = Some(ServerRejects::Body { body, env: inner, cache: None });
            }
            Decl::Fn { name, params, decls, tail, line, .. } => {
                let region = self.reg(env);
                let r = if !decls.is_empty() { self.region(Some(region), "fn", false, Some(name.clone())) } else { region };
                let inner = self.env(Some(env), r);
                for p in params {
                    if p.r#ref {
                        let mut s = Sym::new(SymKind::Eq, &p.name, r, *line as i64);
                        s.param = true;
                        self.bind(inner, &p.name, s);
                    } else {
                        let mut s = Sym::new(SymKind::Value, &p.name, r, *line as i64);
                        s.param = true;
                        let s = self.new_sym(s);
                        self.envs[inner].vars.insert(p.name.clone(), s);
                    }
                }
                self.comp("fn", env, Some(name.clone()), None, |c| {
                    c.block(decls, &[], inner, Ctx { in_fn: true, ..Ctx::reactive() });
                    c.expr(tail, inner, Ctx { in_fn: true, ..Ctx::reactive() }, None);
                });
                let s = self.lookup(env, name).unwrap();
                let sym = &mut self.syms[s];
                sym.fn_tail = Some((tail, inner));
                sym.fails_t = Some(FailsT::Expr { e: tail, env: inner, cache: None, busy: false });
                sym.rows = Some(RowsT::Expr { e: tail, env: inner, cache: None, busy: false });
            }
            Decl::Component { name, props, decls, view, line, .. } => {
                let s = self.lookup(env, name).unwrap();
                let r = self.syms[s].comp_region.unwrap();
                let inner = self.env(Some(env), r);
                self.bind(inner, props, Sym::new(SymKind::Props, props, r, *line as i64));
                self.syms[s].comp_env = Some(inner);
                self.block(decls, view, inner, Ctx::reactive());
                self.later.push(Later::Content { ms: view, env: inner, anc: vec![] });
            }
        }
    }

    /// C-3 (ruled 2026-10-23): an apply block's own statements may not write a source its compute half reads.
    fn own_source_writes(&mut self, inputs: &'a [Expr], body: &'a [Stmt], env: EId) {
        let mut read: IndexMap<SId, String> = IndexMap::new();
        let mut seen: HashSet<SId> = HashSet::new();
        for i in inputs {
            self.osw_visit(i, env, "", &mut read, &mut seen);
        }
        self.osw_direct(body, env, &read);
    }
    fn osw_visit(&self, e: &Expr, scope: EId, via: &str, read: &mut IndexMap<SId, String>, seen: &mut HashSet<SId>) {
        for n0 in names_of(e) {
            let Some(s) = self.lookup(scope, strip_pre(&n0)) else { continue };
            if !seen.insert(s) {
                continue;
            }
            let path = if via.is_empty() { self.syms[s].name.clone() } else { format!("{} → {}", via, self.syms[s].name) };
            if self.syms[s].kind == SymKind::Source && !read.contains_key(&s) {
                read.insert(s, path.clone());
            }
            if let Some((x, xe)) = self.syms[s].expr {
                self.osw_visit(x, xe, &path, read, seen);
            }
        }
    }
    fn osw_direct(&mut self, ss: &'a [Stmt], env: EId, read: &IndexMap<SId, String>) {
        for st in ss {
            match &st.k {
                StmtKind::Write { target, .. } | StmtKind::Optimistic { target, .. } if !target.is_ctx() => {
                    if let Some(t) = self.lookup(env, &target.name) {
                        if let Some(path) = read.get(&t) {
                            let n = self.syms[t].name.clone();
                            self.err(
                                "EFFECT_WRITES_OWN_SOURCE",
                                "C-3",
                                format!(
                                    "the apply block writes {}, which its compute half reads ({}): a loop across instants — derive it as an equation, or as `source {} = …` (ST-5), or write it from the event that changes the inputs",
                                    n, path, n
                                ),
                            );
                        }
                    }
                }
                StmtKind::Sif { t, f, .. } => {
                    self.osw_direct(t, env, read);
                    self.osw_direct(f, env, read);
                }
                StmtKind::Try { body, handler, fin, .. } => {
                    self.osw_direct(body, env, read);
                    if let Some(h) = handler {
                        self.osw_direct(h, env, read);
                    }
                    if let Some(f) = fin {
                        self.osw_direct(f, env, read);
                    }
                }
                StmtKind::Action(body) => self.osw_direct(body, env, read),
                _ => {}
            }
        }
    }

    /// E-10: a reactive argument for a value parameter of an instantiating fn is snapshotted.
    fn snapshot_args(&mut self, call: &'a Expr, f: SId, env: EId) {
        let ExprKind::Call { args, .. } = &call.k else { return };
        let params = self.syms[f].params.clone().unwrap_or_default();
        let fname = self.syms[f].name.clone();
        for (i, p) in params.iter().enumerate() {
            let Some(a) = args.get(i) else { continue };
            if p.r#ref {
                continue;
            }
            let mut reads = IndexSet::new();
            reads_outside_peek(Node::E(a), &mut reads);
            let hit = reads.iter().find(|n| self.lookup(env, n).is_some_and(|s| self.syms[s].kind.reactive())).cloned();
            if let Some(h) = hit {
                self.err(
                    "SNAPSHOT_ARGUMENT",
                    "E-10",
                    format!("{}(…): the argument for value parameter {} reads {} and would be snapshotted — declare the parameter `ref`, or pass peek(…)", fname, p.name, h),
                );
            }
        }
    }

    /// CN-4a: a written row narrower than the inferred one.
    fn row_check(&mut self, name: &str, ty: Option<&str>, env: EId) {
        let Some(ty) = ty else { return };
        let Some(m) = ROW_WORDS.find(ty) else { return };
        let m0 = js_trim(m.as_str()).to_string();
        let words = split_rows(&m0);
        let written: HashSet<String> = words.iter().map(|w| match w.find('(') { Some(i) => w[..i].to_string(), None => w.clone() }).collect();
        let inferred = match self.envs[env].vars.get(name).copied() {
            Some(s) if self.syms[s].rows.is_some() => self.sym_rows(s),
            _ => IndexSet::new(),
        };
        for r in inferred {
            if !written.contains(&r) {
                self.err("ROW_NARROWER_THAN_INFERRED", "CN-4a", format!("{} is declared `{}` but its value is also `{}`", name, m0, r));
            }
        }
        let fw = words.iter().find(|w| w.starts_with("fails(")).cloned();
        let line = self.line;
        self.later.push(Later::RowFails { name: name.to_string(), env, fw, written: m0, line });
    }
    /// R-f-1: a name in a catch, a boundary or an import's `fails` must be an error class.
    fn err_class(&mut self, n: &str, env: EId) {
        if n == "Error" || n == "Panic" {
            return;
        }
        let ok = self.lookup(env, n).is_some_and(|s| matches!(self.syms[s].kind, SymKind::ErrClass | SymKind::Import));
        if !ok {
            self.err("NOT_AN_ERROR_CLASS", "R-f-1", format!("{} is not an error class (declare it: `error {}(…)`)", n, n));
        }
    }

    // ---- expressions ----
    fn resolve(&mut self, name: &str, env: EId, ctx: Ctx) -> Option<SId> {
        if let Some(s) = self.lookup(env, name) {
            self.sided(s, ctx);
            return Some(s);
        }
        if BUILTINS.contains(&name) {
            return None;
        }
        if ctx.imperative && (name == "log" || DOLLAR_PARAM.is_match(name)) {
            return None;
        }
        self.err("UNBOUND", "SCOPE", format!("{} is not declared here (a component sees its declaration site, not its caller — RG-7a)", name));
        None
    }
    /// 12 SF-3/SF-5: what a name may be on this side.
    fn sided(&mut self, s: SId, ctx: Ctx) {
        let (name, kind, side) = (self.syms[s].name.clone(), self.syms[s].kind, self.syms[s].side);
        if !ctx.server {
            if side == Some(Side::Server) {
                self.err("SERVER_ONLY", "SF-5a", format!("{} is `server` JS: it is not in the client bundle — call it in a `server fn` body", name));
            }
            return;
        }
        if side == Some(Side::Client) {
            self.err("CLIENT_IN_SERVER", "SF-5c", format!("{} is `client` JS and this is a server function's body", name));
            return;
        }
        let what = if kind.reactive() {
            Some(match kind {
                SymKind::Source => "a source",
                SymKind::Eq => "an equation",
                _ => "the component's props",
            })
        } else {
            match kind {
                SymKind::Context => Some("a context"),
                SymKind::Comp => Some("a component"),
                SymKind::Action => Some("a client action"),
                _ => None,
            }
        };
        let via = if what.is_some() { None } else if kind == SymKind::Fn { self.reach(s, &mut HashSet::new()) } else { None };
        if what.is_some() || via.is_some() {
            let w = match what {
                Some(w) => w.to_string(),
                None => format!("a fn that reads {}", via.unwrap()),
            };
            self.err(
                "SERVER_CAPTURE",
                "SF-3",
                format!("a server function's body names {}, {}: it runs in its own request on the server, where that is not the client's — pass what it needs as an argument", name, w),
            );
        }
    }
    /// SF-3: the reactive state a value fn reads, through the fns it calls; `None` if none.
    fn reach(&self, f: SId, seen: &mut HashSet<SId>) -> Option<String> {
        if seen.contains(&f) {
            return None;
        }
        let (Some(d), Some(denv)) = (self.syms[f].fn_decl, self.syms[f].decl_env) else { return None };
        seen.insert(f);
        let Decl::Fn { params, decls, tail, .. } = d else { return None };
        let mut bound: HashSet<String> = params.iter().map(|p| p.name.clone()).collect();
        for x in decls {
            if let Some(n) = x.name() {
                bound.insert(n.to_string());
            }
        }
        let mut names = IndexSet::new();
        for x in decls {
            match x {
                Decl::Eq { e, .. } => free_names(e, &bound, &mut names),
                Decl::Source { init, .. } => free_names(init, &bound, &mut names),
                _ => {}
            }
        }
        free_names(tail, &bound, &mut names);
        let text = serde_json::Value::Array(vec![decls_json(decls), tail.to_json()]).to_string();
        if let Some(u) = USE_JSON.captures(&text) {
            return Some(format!("use {}", &u[1]));
        }
        for n0 in names {
            let n = strip_pre(&n0);
            let Some(s) = self.lookup(denv, n) else { continue };
            let k = self.syms[s].kind;
            if k.reactive() || k == SymKind::Context {
                return Some(n.to_string());
            }
            if k == SymKind::Fn {
                if let Some(r) = self.reach(s, seen) {
                    return Some(format!("{} → {}", n, r));
                }
            }
        }
        None
    }

    /// `field`: the member read of an identifier (`props.title`), for the model (CP-6).
    fn expr(&mut self, e: &'a Expr, env: EId, ctx: Ctx, field: Option<&str>) {
        match &e.k {
            ExprKind::Lit(_) => {}
            ExprKind::Id(name) => {
                let s = self.resolve(name, env, ctx);
                if let Some(s) = s {
                    self.read(s, ctx, false, field);
                    match self.syms[s].kind {
                        SymKind::Comp => self.err("COMPONENT_AS_VALUE", "RG-4a", format!("component {} used as a value: apply it in a view", name)),
                        SymKind::Context => self.err("CONTEXT_AS_VALUE", "RG-7", format!("context {} used as a value: read the nearest provision with `use {}`", name, name)),
                        _ => {}
                    }
                }
            }
            ExprKind::Pre { name, init } => {
                let s = self.resolve(name, env, ctx);
                if let Some(s) = s {
                    self.read(s, ctx, true, None);
                    if !self.syms[s].kind.reactive() {
                        self.err("PRE_OF_NON_REACTIVE", "C-2", format!("pre of {}, which is not reactive", name));
                    }
                }
                if let Some(i) = init {
                    self.expr(i, env, ctx, None);
                }
            }
            ExprKind::Use(name) => {
                if ctx.server {
                    self.err("SERVER_CAPTURE", "SF-3", format!("a server function's body reads `use {}`: a provision is the client's — pass it as an argument", name));
                }
                let c = self.ctx_of(name, env);
                if let Some(c) = c {
                    self.read(c, ctx, false, None);
                    let info = self.syms[c].ctx.clone().unwrap();
                    if !info.dflt {
                        let region = self.reg(env);
                        self.uses.push(UseRec { region, name: info.key, line: self.line, display: name.clone() });
                    }
                }
            }
            ExprKind::Peek(x) => {
                self.model.snap += 1;
                self.expr(x, env, ctx, None);
                self.model.snap -= 1;
            }
            ExprKind::Latest(x) | ExprKind::Pending(x) => {
                let save = self.model.probe;
                self.model.probe = Some(if matches!(&e.k, ExprKind::Latest(_)) { "latest" } else { "pending" });
                self.expr(x, env, ctx, None);
                self.model.probe = save;
            }
            ExprKind::Un { e: x, .. } | ExprKind::Spread(x) => self.expr(x, env, ctx, None),
            ExprKind::Await { e: inner, init, .. } => {
                if ctx.imperative && !self.stmt_awaits.contains(&(e as *const Expr)) {
                    let sh = show(e);
                    self.err(
                        "AWAIT_IN_EXPRESSION",
                        "AC-1",
                        format!("`{}` inside an expression of imperative scope: a run suspends only at a statement — bind it first, `let v = {}` (a `catch (e) => alt` may follow it)", sh, sh),
                    );
                }
                self.awaited_calls.insert(&**inner as *const Expr);
                self.expr(inner, env, ctx, None);
                if let Some(i) = init {
                    self.expr(i, env, ctx, None);
                }
            }
            ExprKind::ServerFn { params, body, .. } => {
                let region = self.reg(env);
                let inner = self.env(Some(env), region);
                for p in params {
                    self.set_value(inner, p, self.line);
                }
                self.comp("server", env, None, None, |c| c.stmts(body, inner, Ctx { server: true, ..Ctx::imperative() }));
                if let Some(&sym) = self.server_exprs.get(&(e as *const Expr)) {
                    self.syms[sym].server_rejects = Some(ServerRejects::Body { body, env: inner, cache: None });
                }
            }
            ExprKind::Throw(x) => self.expr(x, env, ctx, None),
            ExprKind::Catch { e: inner, name, classes, alt } => {
                self.expr(inner, env, ctx, None);
                if let Some(cs) = classes {
                    for n in cs {
                        self.err_class(n, env);
                    }
                }
                let region = self.reg(env);
                let ienv = self.env(Some(env), region);
                if let Some(n) = name {
                    self.set_value(ienv, n, self.line);
                }
                self.expr(alt, ienv, ctx, None);
            }
            ExprKind::Bin { l, r, .. } => {
                self.expr(l, env, ctx, None);
                self.expr(r, env, ctx, None);
            }
            ExprKind::If { c, t, f } => {
                self.expr(c, env, ctx, None);
                self.expr(t, env, ctx, None);
                self.expr(f, env, ctx, None);
            }
            ExprKind::Tpl(parts) => {
                for p in parts {
                    if let TplPart::Expr(x) = p {
                        self.expr(x, env, ctx, None);
                    }
                }
            }
            ExprKind::Member { o, p, .. } => {
                if let ExprKind::Id(_) = &o.k {
                    self.expr(o, env, ctx, Some(p));
                } else {
                    self.expr(o, env, ctx, None);
                }
            }
            ExprKind::Index { o, i, .. } => {
                self.expr(o, env, ctx, None);
                self.expr(i, env, ctx, None);
            }
            ExprKind::Arr(items) => {
                for x in items {
                    self.expr(x, env, ctx, None);
                }
            }
            ExprKind::Rec(fields) => {
                for f in fields {
                    match f {
                        Field::Kv { v, .. } => self.expr(v, env, ctx, None),
                        Field::Spread(x) => self.expr(x, env, ctx, None),
                    }
                }
            }
            ExprKind::Call { f, args } => {
                if let ExprKind::Id(fname) = &f.k {
                    if fname == "until" && self.lookup(env, "until").is_none() {
                        if !ctx.imperative {
                            self.err("IO_IN_REACTIVE", "AC-6", "until(…) waits for the world to confirm a condition: it is called from imperative scope (an action or a handler), and awaited".into());
                        }
                        let ok = args.len() == 1 && matches!(&args[0].k, ExprKind::Fn { params, .. } if params.is_empty());
                        if !ok {
                            self.err("UNTIL_PREDICATE", "AC-6", "until takes a predicate, `until(() => e)`: a value would be read once and never change".into());
                            for a in args {
                                self.expr(a, env, ctx, None);
                            }
                            return;
                        }
                        self.expr(&args[0], env, Ctx { server: ctx.server, ..Ctx::reactive() }, None);
                        return;
                    }
                    // EF-7, EF-8: Solid's onSettled / onFlush, functions of the language
                    if (fname == "onSettled" || fname == "onFlush") && self.lookup(env, fname).is_none() {
                        let settled = fname == "onSettled";
                        let rule = if settled { "EF-7" } else { "EF-8" };
                        if !ctx.imperative {
                            self.err("IO_IN_REACTIVE", rule, if settled { "onSettled(…) schedules work from imperative scope (a handler, an apply block, an action); in a component body the mount hook is `effect () { … }` (EF-4)".into() } else { "onFlush(…) is called from imperative scope (a handler, an apply block, an action): it starts a run of its own after this flush".into() });
                        }
                        let ok = args.len() == 1 && matches!(&args[0].k, ExprKind::Fn { params, .. } if params.is_empty());
                        if !ok {
                            self.err("HOOK_CALLBACK", rule, format!("{} takes a closure, `{}(() => {{ … }})`: its body is the run it schedules", fname, fname));
                            for a in args {
                                self.expr(a, env, ctx, None);
                            }
                            return;
                        }
                        if settled && returns_closure(&args[0]) {
                            self.err("SETTLED_CLEANUP_UNOWNED", "EF-7", "an onSettled callback returns a cleanup, but it has no region to bind it to: setup with teardown is `effect () { … }` (EF-4, EF-5)".into());
                        }
                        // the callback is imperative scope
                        self.expr(&args[0], env, Ctx { server: ctx.server, ..Ctx::imperative() }, None);
                        return;
                    }
                    let s = self.lookup(env, fname);
                    let (io, kind, side, io_via, instantiating) = match s {
                        Some(s) => (self.syms[s].io, Some(self.syms[s].kind), self.syms[s].side, self.syms[s].io_via.clone(), self.syms[s].instantiating),
                        None => (false, None, None, None, false),
                    };
                    if !ctx.imperative && (io || (s.is_none() && fname == "log")) {
                        if ctx.in_fn {
                            self.err("IO_IN_FN", "R-io-2", format!("{}(…) is io; a fn is pure by definition", fname));
                        } else {
                            let code = if kind == Some(SymKind::Action) { "ACTION_CALLED_IN_OWNED_SCOPE" } else { "IO_IN_REACTIVE" };
                            self.err(code, "IO-2", format!("{}(…) is io and is called in reactive scope (R-io-3){}", fname, io_via.map(|v| format!(" — its server body calls {}", v)).unwrap_or_default()));
                        }
                    }
                    if side == Some(Side::Client) && !ctx.imperative && !ctx.server && !self.awaited_calls.contains(&(e as *const Expr)) {
                        self.err(
                            "CLIENT_NOT_AWAITED",
                            "SF-5b",
                            format!("{}(…) is `client` JS: in reactive scope it is awaited — a client question, asked once the browser has the page (SV-7b) — never called for its value now", fname),
                        );
                    }
                    if kind == Some(SymKind::Fn) && instantiating {
                        self.err("INSTANTIATION_NOT_BOUND", "E-9", format!("{}(…) declares state: bind it, `x = {}(…)` (RG-6)", fname, fname));
                    }
                    if kind == Some(SymKind::Comp) {
                        self.err("COMPONENT_AS_VALUE", "RG-4a", format!("component {} called as a function: apply it in a view", fname));
                    }
                    self.model.call(s, kind.map(|k| k.as_str()).unwrap_or(""));
                }
                self.expr(f, env, ctx, None);
                for a in args {
                    self.expr(a, env, ctx, None);
                }
            }
            ExprKind::Fn { params, body, stmts } => {
                let region = self.reg(env);
                let inner = self.env(Some(env), region);
                for p in params {
                    self.set_value(inner, p, self.line);
                }
                if let Some(ss) = stmts {
                    if !ctx.imperative {
                        self.err("REACTIVE_WRITE_IN_OWNED_SCOPE", "W-2", "a statement-bodied closure in reactive scope (SC-3: a closure created here is a pure function)".into());
                        return;
                    }
                    // AC-1b: an arrow that guesses, or writes and awaits, is an action
                    let why = if ctx.server { None } else { inferred_action(ss) };
                    self.stmts(ss, inner, Ctx { server: ctx.server, in_action: why.is_some(), ..Ctx::imperative() });
                    if let Some(w) = why {
                        self.actions.push(ActionRec { name: format!("inferred here (AC-1b: {})", trigger_text(w)), body: ss, env: inner, line: self.line });
                    }
                    if !ctx.server {
                        self.run_checks(ss, why.is_some(), params, why.is_some());
                    }
                    return;
                }
                self.expr(body, inner, Ctx { imperative: ctx.imperative, in_fn: ctx.in_fn, server: ctx.server, in_action: false }, None);
            }
            ExprKind::Draft { seed, body } => {
                self.expr(seed, env, ctx, None);
                let region = self.reg(env);
                let inner = self.env(Some(env), region);
                self.set_value(inner, "d", self.line);
                for s in body {
                    match &s.k {
                        StmtKind::Let { name, e, .. } => {
                            self.expr(e, inner, ctx, None);
                            self.set_value(inner, name, self.line);
                        }
                        StmtKind::Expr(x) => self.expr(x, inner, ctx, None),
                        StmtKind::Write { target, e } => {
                            if target.name != "d" || target.is_ctx() {
                                self.err("DRAFT_WRITE_OUTSIDE_DRAFT", "ST-3a", format!("a draft block writes only its draft, not {}{}", if target.is_ctx() { "use " } else { "" }, target.name));
                            }
                            for p in &target.path {
                                if let PathSeg::Expr(x) = p {
                                    self.expr(x, inner, ctx, None);
                                }
                            }
                            self.expr(e, inner, ctx, None);
                        }
                        other => self.err("ASYNC_STORE_SETTER", "ST-3b", format!("{} in a draft block: it is reactive scope (only let, expressions and writes to d)", other.kind())),
                    }
                }
            }
            ExprKind::StyleMap { .. } => {}
        }
    }

    // ---- imperative scope (SC-2) ----
    /// AC-1c, AC-1d, AC-1e over one imperative run (`crate::infer`).
    fn run_checks(&mut self, stmts: &[Stmt], action: bool, bound: &[String], inferred: bool) {
        for f in run_findings(stmts, action, bound, inferred) {
            let n = &f.name;
            match f.code {
                Code::HeldWrite => self.err("HELD_WRITE", "AC-1c", format!("{n} := … comes before an `await` in a body that is an action because it writes and awaits (AC-1b), so it is held until the body ends (AC-1): for state that shows while the work runs, `optimistic {n} := …` (a source with a question, ST-5c); for a reset that lands now, `onFlush(() => {{ {n} := … }})` (EF-8); to hold it on purpose, declare the action (`action name() {{ … }}`); or write it after the `await`")),
                Code::StaleOwnRead => self.err("STALE_OWN_READ", "AC-1d", format!("{n} is read after this change wrote it: the read sees the committed value, not the write (W-4) — keep the value you wrote in a local (`let v = …; {n} := v`) and read that, or write functionally (`{n} := v => …`, W-6)")),
                Code::StaleWriteBack => self.err("STALE_WRITE_BACK", "AC-1e", format!("{n} := … after an `await` is computed from {n} as it was read before that `await`: whatever changed {n} in between (another action, a reload) is overwritten — write functionally (`{n} := v => …`, W-6), which applies to {n} as it stands at the write, or guess it (`optimistic`, AC-3) and let the answer replace the guess")),
            }
        }
    }

    fn stmts(&mut self, ss: &'a [Stmt], env0: EId, ctx: Ctx) {
        let region = self.reg(env0);
        let env = self.env(Some(env0), region);
        for s in ss {
            if let StmtKind::Let { e, .. } | StmtKind::Expr(e) = &s.k {
                let t = if let ExprKind::Catch { e: inner, .. } = &e.k { &**inner } else { e };
                if let ExprKind::Await { .. } = &t.k {
                    self.stmt_awaits.insert(t as *const Expr);
                }
            }
            match &s.k {
                StmtKind::Let { name, e, .. } => {
                    self.expr(e, env, ctx, None);
                    let captures = self.stored(e, env, &mut HashSet::new(), false);
                    let ret = self.stored(e, env, &mut HashSet::new(), true);
                    let mut sym = Sym::new(SymKind::Value, name, region, self.line);
                    sym.captures = captures;
                    sym.ret_captures = Some(ret);
                    let id = self.new_sym(sym);
                    self.envs[env].vars.insert(name.clone(), id);
                }
                StmtKind::Expr(e) | StmtKind::Throw(e) => self.expr(e, env, ctx, None),
                StmtKind::Return(e) => {
                    if let Some(e) = e {
                        self.expr(e, env, ctx, None);
                    }
                }
                StmtKind::Write { target, e } | StmtKind::Optimistic { target, e } => {
                    let op = if matches!(&s.k, StmtKind::Optimistic { .. }) { "optimistic" } else { "write" };
                    if ctx.server {
                        self.err(
                            "SERVER_WRITE",
                            "SF-4",
                            format!(
                                "a server function writes {}{}: return the value, and write it in the action that awaited the call (`let r = await f(…); {} := r`)",
                                if target.is_ctx() { "use " } else { "" },
                                target.name,
                                target.name
                            ),
                        );
                        for p in &target.path {
                            if let PathSeg::Expr(x) = p {
                                self.expr(x, env, ctx, None);
                            }
                        }
                        self.expr(e, env, ctx, None);
                        continue;
                    }
                    let mut tsym = None;
                    if target.is_ctx() {
                        if let Some(c) = self.ctx_of(&target.name, env) {
                            self.model.write(Some(c), op, !target.path.is_empty());
                            let info = self.syms[c].ctx.clone().unwrap();
                            self.uses.push(UseRec { region, name: info.key.clone(), line: self.line, display: target.name.clone() });
                            if !info.source {
                                self.err("WRITE_TO_NON_SOURCE", "O-4", format!("context {} is read beneath its provision: call an action it provides that writes it (O-4)", target.name));
                            }
                        }
                    } else {
                        tsym = self.resolve(&target.name, env, ctx);
                        self.model.write(tsym, op, !target.path.is_empty());
                        if let Some(t) = tsym {
                            let k = self.syms[t].kind;
                            if k != SymKind::Source {
                                let what = match k {
                                    SymKind::Eq => "an equation".to_string(),
                                    SymKind::Props => "props".to_string(),
                                    k => format!("a {}", k.as_str()),
                                };
                                let hint = if k == SymKind::Props || k == SymKind::Value || self.syms[t].param { " — a source is written only in the region that declares it: have its owner pass an action that writes it (O-4)" } else { "" };
                                self.err("WRITE_TO_NON_SOURCE", "W-1", format!("{} is {}: only sources are written (W-1){}", target.name, what, hint));
                            } else if let Some(imp) = self.syms[t].imported.clone() {
                                self.err(
                                    "WRITE_TO_NON_SOURCE",
                                    "MO-2",
                                    format!("{} is a source of {}: a module boundary is a value boundary — write it through an action {} exports", target.name, imp, imp),
                                );
                            }
                        }
                    }
                    if op == "optimistic" {
                        if !ctx.in_action {
                            self.err("OPTIMISTIC_OUTSIDE_HOLD", "AC-3", "optimistic outside an action: a guess needs a hold to live in — an apply block is never an action (its return is the cleanup, EF-5): declare one, `action save(v) { optimistic … }`, and call it from the block".into());
                        }
                        if let Some(t) = tsym {
                            if self.syms[t].kind == SymKind::Source && !self.syms[t].question {
                                self.err(
                                    "OPTIMISTIC_NO_QUESTION",
                                    "AC-3",
                                    format!("{} is declared with := — a guess needs a question to confirm it (source {} = …, ST-5c)", target.name, target.name),
                                );
                            }
                        }
                    }
                    for p in &target.path {
                        if let PathSeg::Expr(x) = p {
                            self.expr(x, env, ctx, None);
                        }
                    }
                    self.expr(e, env, ctx, None);
                    self.later.push(Later::Escape { target, e, tsym, env, line: self.line }); // O-3: after every fn's result is known
                }
                StmtKind::Refresh(name) | StmtKind::Affects(name) => {
                    let is_refresh = matches!(&s.k, StmtKind::Refresh(_));
                    if ctx.server {
                        self.err(
                            "SERVER_CAPTURE",
                            "SF-3",
                            format!("`{} {}` in a server function's body: it is the client's (do it in the action that awaited the call)", if is_refresh { "refresh" } else { "affects" }, name),
                        );
                        continue;
                    }
                    let t = self.resolve(name, env, ctx);
                    if is_refresh {
                        self.model.write(t, "refresh", false);
                        if let Some(t) = t {
                            let k = self.syms[t].kind;
                            if !(k == SymKind::Eq || (k == SymKind::Source && self.syms[t].question)) {
                                self.err("INVALID_REFRESH_TARGET", "AC-4", format!("{} has no question to re-ask", name));
                            }
                        }
                    } else {
                        self.model.write(t, "affects", false);
                        if let Some(t) = t {
                            if !self.syms[t].kind.reactive() {
                                self.err("INVALID_AFFECTS_TARGET", "AC-5", format!("{} is not reactive", name));
                            }
                        }
                    }
                }
                StmtKind::Action(body) => {
                    if ctx.server {
                        self.err("SERVER_CAPTURE", "SF-3", "`action { … }` in a server function's body: it is the client's (do it in the action that awaited the call)".into());
                        continue;
                    }
                    self.comp("action", env, Some("(inline)".into()), None, |c| c.stmts(body, env, Ctx { in_action: true, ..Ctx::imperative() }));
                    self.actions.push(ActionRec { name: "(inline)".into(), body, env, line: self.line });
                    self.run_checks(body, true, &[], false);
                }
                StmtKind::Sif { c, t, f } => {
                    self.expr(c, env, ctx, None);
                    self.stmts(t, env, ctx);
                    self.stmts(f, env, ctx);
                }
                StmtKind::Try { body, catch_name, catch_classes, handler, fin } => {
                    self.stmts(body, env, ctx);
                    if let Some(cs) = catch_classes {
                        for n in cs {
                            self.err_class(n, env);
                        }
                    }
                    if let Some(h) = handler {
                        let henv = self.env(Some(env), region);
                        if let Some(n) = catch_name {
                            self.set_value(henv, n, self.line);
                        }
                        self.stmts(h, henv, ctx);
                    }
                    if let Some(f) = fin {
                        self.stmts(f, env, ctx);
                    }
                }
            }
        }
    }

    /// The reactive names captured by closures that a value stores (O-3). A functional write's own function is applied, not
    /// stored, and so is a closure handed to a prelude function (`map(xs, x => …)`). Through a name: a `let`'s captures, an
    /// equation's expression; through a call: what the fn's result captures — for an instantiation (RG-6), a name of the
    /// instance stands for the instance, which lives as long as the region of the call. A prop is marked (`prop_of`): what it
    /// captures is the caller's.
    fn stored(&mut self, e: &'a Expr, env: EId, seen: &mut HashSet<SId>, result: bool) -> Vec<SId> {
        let mut out = vec![];
        self.stored_walk(Node::E(e), env, seen, result, &mut out);
        out
    }
    fn prop_mark(&mut self, s: SId, name: String, field: &str) -> SId {
        let (region, line) = (self.syms[s].region, self.syms[s].line);
        let mut m = Sym::new(SymKind::Props, &name, region, line);
        m.prop_of = Some((region, field.to_string()));
        self.new_sym(m)
    }
    /// `res`: the value is called, and only what the call returns is stored — a closure stores nothing then unless its body
    /// makes one.
    fn stored_walk(&mut self, x: Node<'a>, env: EId, seen: &mut HashSet<SId>, res: bool, out: &mut Vec<SId>) {
        match x {
            Node::E(f @ Expr { k: ExprKind::Fn { .. }, .. }) => {
                if res && !contains_fn(f) {
                    return;
                }
                for n in names_of(f) {
                    if let Some(s) = self.lookup(env, strip_pre(&n)) {
                        if self.syms[s].kind.reactive() {
                            out.push(s);
                        }
                        out.extend(self.syms[s].captures.iter().copied());
                    }
                }
            }
            Node::E(Expr { k: ExprKind::Id(n), .. }) => {
                let Some(s) = self.lookup(env, n) else { return };
                let caps = match (&self.syms[s].ret_captures, res) {
                    (Some(r), true) => r.clone(),
                    _ => self.syms[s].captures.clone(),
                };
                out.extend(caps);
                if self.syms[s].kind == SymKind::Props {
                    let m = self.prop_mark(s, self.syms[s].name.clone(), "*");
                    out.push(m);
                }
                if self.syms[s].kind == SymKind::Eq && !seen.contains(&s) {
                    if let Some((xe, xenv)) = self.syms[s].expr {
                        seen.insert(s);
                        let c = self.stored(xe, xenv, seen, res);
                        out.extend(c);
                    }
                }
            }
            Node::E(Expr { k: ExprKind::Member { o, p, .. }, .. }) if matches!(&o.k, ExprKind::Id(n) if self.lookup(env, n).is_some_and(|s| self.syms[s].kind == SymKind::Props)) => {
                let ExprKind::Id(n) = &o.k else { unreachable!() };
                let s = self.lookup(env, n).unwrap();
                let m = self.prop_mark(s, format!("{}.{}", self.syms[s].name, p), p);
                out.push(m);
            }
            Node::E(Expr { k: ExprKind::Call { f, args }, .. }) => {
                let fs = match &f.k {
                    ExprKind::Id(name) => self.lookup(env, name),
                    _ => None,
                };
                if let ExprKind::Id(name) = &f.k {
                    if fs.is_none() && BUILTINS.contains(&name.as_str()) {
                        // a prelude function applies the closures it is given
                        for a in args {
                            let r = res || matches!(a.k, ExprKind::Fn { .. });
                            self.stored_walk(Node::E(a), env, seen, r, out);
                        }
                        return;
                    }
                }
                if let Some(fs) = fs {
                    if self.syms[fs].kind == SymKind::Fn && !seen.contains(&fs) {
                        if let Some((tail, fenv)) = self.syms[fs].fn_tail {
                            seen.insert(fs);
                            let r = self.reg(fenv);
                            let mut inst: Option<SId> = None;
                            for c in self.stored(tail, fenv, seen, res) {
                                let mut q = Some(self.syms[c].region);
                                while let Some(qi) = q {
                                    if qi == r {
                                        break;
                                    }
                                    q = self.regions[qi].parent;
                                }
                                if self.syms[fs].instantiating && q.is_some() && self.syms[c].prop_of.is_none() {
                                    let i = match inst {
                                        Some(i) => i,
                                        None => {
                                            let i = self.new_sym(Sym::new(SymKind::Eq, &format!("an instance of {}", self.syms[fs].name), self.reg(env), self.line));
                                            inst = Some(i);
                                            i
                                        }
                                    };
                                    out.push(i);
                                } else {
                                    out.push(c);
                                }
                            }
                            seen.remove(&fs);
                        }
                    }
                }
                // the callee is applied; what it returns may be an argument
                self.stored_walk(Node::E(f), env, seen, true, out);
                for a in args {
                    self.stored_walk(Node::E(a), env, seen, false, out);
                }
            }
            _ => {
                for c in children(x, false) {
                    self.stored_walk(c, env, seen, res, out);
                }
            }
        }
    }
    fn escape(&mut self, target: &Target, e: &'a Expr, tsym: Option<SId>, env: EId) {
        let value = match &e.k {
            ExprKind::Fn { body, stmts: None, .. } => &**body,
            _ => e,
        };
        let captured = self.stored(value, env, &mut HashSet::new(), false);
        if captured.is_empty() {
            return;
        }
        let mut prov: Option<String> = None;
        let t_depth = match tsym {
            Some(t) => self.regions[self.syms[t].region].depth,
            None => {
                let key = self.lookup(env, &target.name).and_then(|s| self.syms[s].ctx.as_ref().map(|c| c.key.clone())).unwrap_or_else(|| target.name.clone());
                let mut r = Some(self.reg(env));
                let mut found = None;
                while let Some(ri) = r {
                    if self.regions[ri].provides.contains(&key) {
                        found = Some(ri);
                        break;
                    }
                    if self.regions[ri].is_component_root {
                        break;
                    }
                    r = self.regions[ri].parent;
                }
                if found.is_none() {
                    prov = Some(key);
                }
                match found {
                    Some(f) => self.regions[f].depth,
                    None => match self.regions[self.reg(env)].component {
                        Some(c) => self.regions[c].depth - 1,
                        None => 0,
                    },
                }
            }
        };
        if let Some(&leak) = captured.iter().find(|&&c| self.syms[c].prop_of.is_none() && self.regions[self.syms[c].region].depth > t_depth) {
            let ln = self.syms[leak].name.clone();
            self.err(
                "REGION_ESCAPE",
                "O-3",
                format!("a closure capturing {} (declared in a region that ends sooner) is stored into {}{}, which outlives it", ln, if target.is_ctx() { "use " } else { "" }, target.name),
            );
        }
        for c in captured {
            if let Some((comp, field)) = self.syms[c].prop_of.clone() {
                if t_depth < self.regions[comp].depth {
                    let t = match &prov {
                        Some(k) => format!("p:{}", k),
                        None => format!("d:{}", t_depth),
                    };
                    self.retain(comp, &field, t); // checked where the component is applied
                }
            }
        }
    }
    fn retain(&mut self, comp: RId, field: &str, t: String) -> bool {
        self.retains.entry(comp).or_default().entry(field.to_string()).or_default().insert(t)
    }
    /// O-3 at an application: a closure passed for a prop the component stores must not capture a name that ends before where
    /// it is stored. A provision's place is found from the site; a prop passed on (`x={props.y}`) is stored by this component too.
    fn retained(&mut self) {
        let targets = |this: &Self, c: RId, field: &str| -> Vec<String> {
            if let Some(sig) = &this.regions[c].sig {
                let mut v: Vec<String> = sig.stored.get(field).cloned().unwrap_or_default();
                if field != "*" {
                    v.extend(sig.stored.get("*").cloned().unwrap_or_default());
                }
                return v.into_iter().map(|t| if t == "module" { "d:0".to_string() } else { format!("p:{}", t) }).collect();
            }
            let Some(m) = this.retains.get(&c) else { return vec![] };
            let mut v: Vec<String> = m.get(field).map(|x| x.iter().cloned().collect()).unwrap_or_default();
            if field != "*" {
                v.extend(m.get("*").map(|x| x.iter().cloned().collect::<Vec<_>>()).unwrap_or_default());
            }
            v
        };
        let mut changed = true;
        while changed {
            changed = false;
            for ai in 0..self.apps.len() {
                let (acomp, asite, aline, atag) = (self.apps[ai].comp, self.apps[ai].site, self.apps[ai].line, self.apps[ai].tag.clone());
                for xi in 0..self.apps[ai].passed.len() {
                    let (field, xe, xenv) = self.apps[ai].passed[xi].clone();
                    let ts = targets(self, acomp, &field);
                    if ts.is_empty() {
                        continue;
                    }
                    let cap = self.stored(xe, xenv, &mut HashSet::new(), false);
                    for t in ts {
                        let limit = match t.strip_prefix("d:") {
                            Some(d) => d.parse::<i64>().unwrap_or(0),
                            None => self.prov_anchor(asite, &t[2..]),
                        };
                        if let Some(&leak) = cap.iter().find(|&&c| self.syms[c].prop_of.is_none() && self.regions[self.syms[c].region].depth > limit) {
                            self.line = aline;
                            let ln = self.syms[leak].name.clone();
                            self.err(
                                "REGION_ESCAPE",
                                "O-3",
                                format!(
                                    "<{} {}={{…}}>: the closure passed captures {} (declared in a region that ends sooner), and {} stores {} (itself, or through a component it passes it to) where it outlives it",
                                    atag, field, ln, atag, field
                                ),
                            );
                        }
                        for &c in &cap {
                            if let Some((comp, f)) = self.syms[c].prop_of.clone() {
                                if limit < self.regions[comp].depth && self.retain(comp, &f, t.clone()) {
                                    changed = true;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    /// The depth, in the site's lexical tree, of the region a provision written from beneath `site` lives as long as.
    fn prov_anchor(&self, site: RId, key: &str) -> i64 {
        let mut r = Some(site);
        while let Some(ri) = r {
            let reg = &self.regions[ri];
            if reg.provides.contains(key) {
                return reg.depth;
            }
            if let Some((comp, ksite)) = reg.kids {
                // RG-4c: children see the component's provisions, then the site's
                if self.regions[comp].provides.contains(key) {
                    return self.regions[ksite].depth;
                }
                r = Some(ksite);
                continue;
            }
            if reg.is_component_root {
                return reg.depth - 1; // above the component: it outlives every name in it
            }
            r = reg.parent;
        }
        0
    }

    // ---- views ----
    fn markup(&mut self, ms: &'a [Markup], env: EId, view_root: bool) {
        let mut styles = 0;
        for m in ms {
            if let Some(l) = m.line {
                self.line = l as i64;
            }
            let region = self.reg(env);
            match &m.kind {
                MarkupKind::Text(_) => {}
                MarkupKind::Style(_) => {
                    if !view_root {
                        self.err("STYLE_PLACEMENT", "CSS-1", "a <style> is written at the top level of a component's view (or the program's): it scopes that whole view, branches and loops included — move it there".into());
                    } else {
                        styles += 1;
                        if styles > 1 {
                            self.err("STYLE_PLACEMENT", "CSS-1", "a second <style> in one view: a view has one stylesheet".into());
                        }
                    }
                }
                MarkupKind::Read(e) => {
                    self.comp("reader", env, None, Some("{…}".into()), |c| c.expr(e, env, Ctx::reactive(), None));
                    self.readers.push(ReaderRec { region, e, env, line: self.line });
                }
                MarkupKind::El { tag, attrs, children } => {
                    if is_upper_tag(tag) {
                        let s = self.lookup(env, tag);
                        let is_comp = s.is_some_and(|s| self.syms[s].kind == SymKind::Comp);
                        if !is_comp {
                            self.err("UNKNOWN_COMPONENT", "RG-4a", format!("<{}> is not a component declared here", tag));
                        }
                        for a in attrs {
                            let h = is_handler(&a.name);
                            let c2 = if h { Ctx::imperative() } else { Ctx::reactive() };
                            self.comp(if h { "handler" } else { "prop" }, env, None, Some(format!("{} {}", tag, a.name)), |c| c.expr(&a.e, env, c2, None));
                        }
                        if is_comp {
                            let cr = self.syms[s.unwrap()].comp_region.unwrap();
                            self.apps.push(AppRec { comp: cr, site: region, line: self.line, tag: tag.clone(), args: attrs.iter().filter(|a| !is_handler(&a.name)).map(|a| (a.name.clone(), &a.e, env)).collect(), passed: attrs.iter().map(|a| (a.name.clone(), &a.e, env)).collect() });
                            let kids = self.region(Some(region), "children", false, Some(tag.clone()));
                            self.regions[kids].kids = Some((cr, region));
                            let kenv = self.env(Some(env), kids);
                            self.markup(children, kenv, false);
                        } else {
                            self.markup(children, env, false);
                        }
                        continue;
                    }
                    for a in attrs {
                        let h = is_handler(&a.name);
                        let c2 = if h { Ctx::imperative() } else { Ctx::reactive() };
                        self.comp(if h { "handler" } else { "reader" }, env, None, Some(format!("{} {}", tag, a.name)), |c| c.expr(&a.e, env, c2, None));
                        if !h {
                            self.readers.push(ReaderRec { region, e: &a.e, env, line: self.line });
                        } else {
                            self.handlers.push(HandlerRec { attrs, h: &a.e, env, region, line: self.line, what: format!("<{}> {}", tag, a.name) });
                        }
                    }
                    self.markup(children, env, false);
                }
                MarkupKind::Mif { c, t, t_decls, f, f_decls } => {
                    self.comp("reader", env, None, Some("if".into()), |cc| cc.expr(c, env, Ctx::reactive(), None));
                    self.readers.push(ReaderRec { region, e: c, env, line: self.line });
                    let r = self.region(Some(region), "then", false, None);
                    let e1 = self.env(Some(env), r);
                    self.block(t_decls, t, e1, Ctx::reactive());
                    let r = self.region(Some(region), "else", false, None);
                    let e2 = self.env(Some(env), r);
                    self.block(f_decls, f, e2, Ctx::reactive());
                }
                MarkupKind::Mfor { name, xs, decls, body } => {
                    self.comp("reader", env, None, Some("for".into()), |c| c.expr(xs, env, Ctx::reactive(), None));
                    self.readers.push(ReaderRec { region, e: xs, env, line: self.line });
                    let src = if let ExprKind::Id(n) = &xs.k { self.lookup(env, n) } else { None };
                    if src.is_some_and(|s| self.syms[s].maps_records) || maps_into_records(xs) {
                        self.err("UNSTABLE_LIST_IDENTITY", "ST-4b", format!("for {} in …: the rows are rebuilt as fresh records on every change — declare a key (`x key id = …`)", name));
                    }
                    let r = self.region(Some(region), "for", false, None);
                    let inner = self.env(Some(env), r);
                    let s = self.new_sym(Sym::new(SymKind::Value, name, r, self.line));
                    self.envs[inner].vars.insert(name.clone(), s);
                    self.block(decls, body, inner, Ctx::reactive());
                }
                MarkupKind::Loading { on, fallback, decls, body } => {
                    if let Some(on) = on {
                        self.comp("reader", env, None, Some("loading on".into()), |c| c.expr(on, env, Ctx::reactive(), None));
                        self.readers.push(ReaderRec { region, e: on, env, line: self.line });
                    }
                    self.markup(fallback, env, false);
                    let b = self.region(Some(region), "loading", false, None);
                    self.regions[b].provides.insert(HOLD.into());
                    if let Some(on) = on {
                        self.load_ons.push(ReaderRec { region: b, e: on, env, line: self.line });
                    }
                    let be = self.env(Some(env), b);
                    self.block(decls, body, be, Ctx::reactive());
                }
                MarkupKind::Portal { to, decls, body } => {
                    if let Some(to) = to {
                        self.comp("reader", env, None, Some("portal to".into()), |c| c.expr(to, env, Ctx::reactive(), None));
                        self.readers.push(ReaderRec { region, e: to, env, line: self.line });
                    }
                    let b = self.region(Some(region), "portal", false, None);
                    self.regions[b].provides.insert(HOLD.into());
                    let be = self.env(Some(env), b);
                    self.block(decls, body, be, Ctx::reactive());
                    self.later.push(Later::Content { ms: body, env, anc: vec!["body".into()] });
                }
                MarkupKind::Errored { fallback, decls, body, err_name, classes } => {
                    let fe = self.env(Some(env), region);
                    if let Some(n) = err_name {
                        self.set_value(fe, n, self.line);
                    }
                    self.markup(fallback, fe, false);
                    if let Some(cs) = classes {
                        for n in cs {
                            self.err_class(n, env);
                        }
                    }
                    let b = self.region(Some(region), "errored", false, None);
                    self.regions[b].catches = Some(Catch::of(classes));
                    let be = self.env(Some(env), b);
                    self.block(decls, body, be, Ctx::reactive());
                }
            }
        }
    }

    // ---- SV-7d: the content model across templates ----
    /// What a component contributes where it is applied: from its signature, or its body.
    fn shape(&mut self, c: SId) -> Shape {
        if let Some(r) = self.syms[c].comp_region {
            if let Some(sig) = &self.regions[r].sig {
                return sig.shape.clone().unwrap_or_default();
            }
        }
        if let Some(s) = self.shapes.get(&c) {
            return s.clone().unwrap_or_default();
        }
        let (Some(d), Some(cenv)) = (self.syms[c].comp, self.syms[c].comp_env) else { return Shape::default() };
        let Decl::Component { view, .. } = d else { return Shape::default() };
        self.shapes.insert(c, None);
        let mut sh = Shape::default();
        let mut roots: IndexSet<String> = IndexSet::new();
        self.shape_walk(view, &[], false, cenv, &mut sh, &mut roots);
        sh.roots = roots.into_iter().collect();
        self.shapes.insert(c, Some(sh.clone()));
        sh
    }
    fn shape_walk(&mut self, ms: &'a [Markup], anc: &[String], scoped: bool, env: EId, sh: &mut Shape, roots: &mut IndexSet<String>) {
        for m in ms {
            match &m.kind {
                MarkupKind::Text(_) => {
                    if anc.is_empty() {
                        roots.insert("#text".into());
                    }
                }
                MarkupKind::Read(e) => {
                    if self.reads_children(e, env) {
                        sh.children_at.push(anc.to_vec());
                    }
                }
                MarkupKind::El { tag, children, .. } => {
                    if tag.is_empty() {
                        self.shape_walk(children, anc, scoped, env, sh, roots);
                        continue;
                    }
                    if is_upper_tag(tag) {
                        let Some(s) = self.lookup(env, tag) else { continue };
                        if self.syms[s].kind != SymKind::Comp {
                            continue;
                        }
                        let ss = self.shape(s);
                        if anc.is_empty() {
                            for r in &ss.roots {
                                roots.insert(r.clone());
                            }
                        }
                        if ss.closes_p && !scoped {
                            sh.closes_p = true;
                        }
                        if ss.a {
                            sh.a = true;
                        }
                        if ss.form {
                            sh.form = true;
                        }
                        for ch in &ss.children_at {
                            let mut a2 = anc.to_vec();
                            a2.extend(ch.iter().cloned());
                            let sc = scoped || ch.iter().any(|t| P_SCOPE.contains(t.as_str()));
                            self.shape_walk(children, &a2, sc, env, sh, roots);
                        }
                        continue;
                    }
                    if anc.is_empty() {
                        roots.insert(tag.clone());
                    }
                    if P_CLOSERS.contains(tag.as_str()) && !scoped {
                        sh.closes_p = true;
                    }
                    if tag == "a" {
                        sh.a = true;
                    }
                    if tag == "form" {
                        sh.form = true;
                    }
                    let mut a2 = anc.to_vec();
                    a2.push(tag.clone());
                    self.shape_walk(children, &a2, scoped || P_SCOPE.contains(tag.as_str()), env, sh, roots);
                }
                MarkupKind::Mif { t, f, .. } => {
                    self.shape_walk(t, anc, scoped, env, sh, roots);
                    self.shape_walk(f, anc, scoped, env, sh, roots);
                }
                MarkupKind::Mfor { body, .. } => self.shape_walk(body, anc, scoped, env, sh, roots),
                MarkupKind::Loading { fallback, body, .. } | MarkupKind::Errored { fallback, body, .. } => {
                    self.shape_walk(fallback, anc, scoped, env, sh, roots);
                    self.shape_walk(body, anc, scoped, env, sh, roots);
                }
                _ => {}
            }
        }
    }
    fn reads_children(&self, e: &Expr, env: EId) -> bool {
        match &e.k {
            ExprKind::Member { o, p, .. } if p == "children" => match &o.k {
                ExprKind::Id(n) => self.lookup(env, n).is_some_and(|s| self.syms[s].kind == SymKind::Props),
                _ => false,
            },
            _ => false,
        }
    }
    /// SV-7d: every element, text and component root of a view against the elements open above it.
    fn content_check(&mut self, ms: &'a [Markup], env: EId, anc: &[String]) {
        for m in ms {
            if let Some(l) = m.line {
                self.line = l as i64;
            }
            match &m.kind {
                MarkupKind::Text(s) => {
                    if !js_trim(s).is_empty() {
                        let why = misnested(anc, "#text");
                        self.report_content(anc, "text".into(), why);
                    }
                }
                MarkupKind::El { tag, children, .. } => {
                    if tag.is_empty() {
                        self.content_check(children, env, anc);
                        continue;
                    }
                    if is_upper_tag(tag) {
                        let Some(s) = self.lookup(env, tag) else { continue };
                        if self.syms[s].kind != SymKind::Comp {
                            continue;
                        }
                        let ss = self.shape(s);
                        for r in &ss.roots {
                            let what = if r == "#text" { format!("<{}>'s text", tag) } else { format!("<{}>, the root of <{}>,", r, tag) };
                            let why = misnested(anc, r);
                            self.report_content(anc, what, why);
                        }
                        let why = misnested_inside(anc, &ss);
                        self.report_content(anc, format!("<{}>", tag), why);
                        for ch in &ss.children_at {
                            let mut a2 = anc.to_vec();
                            a2.extend(ch.iter().cloned());
                            self.content_check(children, env, &a2);
                        }
                        continue;
                    }
                    let why = misnested(anc, tag);
                    self.report_content(anc, format!("<{}>", tag), why);
                    let mut a2 = anc.to_vec();
                    a2.push(tag.clone());
                    self.content_check(children, env, &a2);
                }
                MarkupKind::Mif { t, f, .. } => {
                    self.content_check(t, env, anc);
                    self.content_check(f, env, anc);
                }
                MarkupKind::Mfor { body, .. } => self.content_check(body, env, anc),
                MarkupKind::Loading { fallback, body, .. } | MarkupKind::Errored { fallback, body, .. } => {
                    self.content_check(fallback, env, anc);
                    self.content_check(body, env, anc);
                }
                _ => {}
            }
        }
    }
    fn report_content(&mut self, anc: &[String], what: String, why: Option<String>) {
        if let Some(why) = why {
            self.err("CONTENT_MODEL", "SV-7d", format!("{} inside <{}>: the browser's HTML parser {}, so the served page is not the tree the client builds", what, anc.last().map(|s| s.as_str()).unwrap_or("undefined"), why));
        }
    }

    // ---- R-8: a handler's snapshot of a value that may be absent or failing ----
    /// R-8: every element handler's snapshot reads of an equation that can have no value yet (a first load with no `-> v`)
    /// or can fail, unless handled (`-> v`; a `try` or `catch` for the failure) or covered (the element's `disabled` reads
    /// it, or the element sits in a `loading` / `errored` region whose content reads it).
    fn snapshot_guards(&mut self) {
        let hs: Vec<(&'a [Attr], &'a Expr, EId, RId, i64, String)> = self.handlers.iter().map(|h| (h.attrs, h.h, h.env, h.region, h.line, h.what.clone())).collect();
        let mut absent_memo: HashMap<SId, bool> = HashMap::new();
        let mut done: HashSet<*const Expr> = HashSet::new();
        for (attrs, h, env, region, line, what) in hs {
            if !done.insert(h as *const Expr) {
                continue;
            }
            let mut locals: HashSet<String> = HashSet::new();
            let mut reads: Vec<(String, bool)> = vec![];
            snapshot_reads(Node::E(h), false, &mut locals, &mut reads);
            let mut seen: HashSet<SId> = HashSet::new();
            for (n, caught) in reads {
                if locals.contains(&n) {
                    continue;
                }
                let Some(s) = self.lookup(env, &n) else { continue };
                if !matches!(self.syms[s].kind, SymKind::Eq | SymKind::Source) || seen.contains(&s) {
                    continue;
                }
                let absent = self.absent(s, &mut absent_memo, &mut HashSet::new());
                let failing = !caught && self.syms[s].fails_t.is_some() && !self.sym_fails(s).cls.is_empty();
                if !absent && !failing {
                    continue;
                }
                seen.insert(s);
                if attrs.iter().any(|a| a.name == "disabled" && self.depends(&a.e, env, s, &mut HashSet::new())) {
                    continue;
                }
                let need_hold = absent && !self.region_reads(region, s, |r| r.provides.contains(HOLD));
                let need_catch = failing && !self.region_reads(region, s, |r| r.catches.is_some());
                if !need_hold && !need_catch {
                    continue;
                }
                let why = match (need_hold, need_catch) {
                    (true, true) => "can have no value yet (a first load) and can fail",
                    (true, false) => "can have no value yet (a first load)",
                    _ => "can fail",
                };
                self.line = line;
                self.err(
                    "UNGUARDED_SNAPSHOT",
                    "R-8",
                    format!(
                        "{} reads {} as a snapshot, and {} {}: the click then {} — move the element inside a `loading` / `errored` region whose content reads {} (with `disabled={{pending? {}}}` for a new question){}",
                        what,
                        n,
                        n,
                        why,
                        if need_hold { "sees no value" } else { "throws its error" },
                        n,
                        n,
                        if need_catch { format!(", or catch the failure (`… catch (e) => …`)") } else { String::new() }
                    ),
                );
            }
        }
    }
    /// R-8: `s` can be read before its first answer: an `await` with no first paint (`-> v`, R-7) in it or what it reads.
    fn absent(&self, s: SId, memo: &mut HashMap<SId, bool>, busy: &mut HashSet<SId>) -> bool {
        self.sym_absent(s, false, memo, busy)
    }
    /// `first`: on the first load (CN-3d) rather than at any time (R-8). `memo` is per mode.
    fn sym_absent(&self, s: SId, first: bool, memo: &mut HashMap<SId, bool>, busy: &mut HashSet<SId>) -> bool {
        if let Some(&b) = memo.get(&s) {
            return b;
        }
        let Some((e, env)) = self.syms[s].expr else { return false };
        if !busy.insert(s) {
            return false;
        }
        let out = self.expr_absent(e, env, Some(s), first, memo, busy);
        busy.remove(&s);
        memo.insert(s, out);
        out
    }
    /// `e` can have no value yet: it awaits without a first paint (`-> v`), here or in an equation it reads (a probe
    /// too: R-9, no verdict before a first answer). R-8 (a handler's snapshot, at any time): `peek` is the snapshot's own read, and
    /// every branch counts. CN-3d (`first`): only what the first load surely asks: a question behind a condition
    /// (`c ? null : await f()`, `c && await f()`, a `catch`'s alternative) waits only if `c` lets it, which the
    /// checker cannot know.
    fn expr_absent(&self, e: &Expr, env: EId, own: Option<SId>, first: bool, memo: &mut HashMap<SId, bool>, busy: &mut HashSet<SId>) -> bool {
        let mut stack = vec![Node::E(e)];
        while let Some(n) = stack.pop() {
            if let Node::E(x) = n {
                match &x.k {
                    ExprKind::Fn { .. } | ExprKind::ServerFn { .. } => continue,
                    ExprKind::Peek(_) if !first => continue,
                    ExprKind::Await { init: None, .. } => return true,
                    ExprKind::Await { init: Some(_), .. } => continue,
                    ExprKind::If { c, .. } if first => {
                        stack.push(Node::E(c));
                        continue;
                    }
                    ExprKind::Bin { op, l, .. } if first && matches!(op.as_str(), "&&" | "||" | "??") => {
                        stack.push(Node::E(l));
                        continue;
                    }
                    ExprKind::Catch { e: inner, .. } if first => {
                        stack.push(Node::E(inner));
                        continue;
                    }
                    ExprKind::Id(name) => {
                        if let Some(t) = self.lookup(env, name) {
                            if Some(t) != own && matches!(self.syms[t].kind, SymKind::Eq | SymKind::Source) && self.sym_absent(t, first, memo, busy) {
                                return true;
                            }
                        }
                        continue;
                    }
                    _ => {}
                }
            }
            stack.extend(children(n, false));
        }
        false
    }
    /// CN-3e: a `loading on(k)` region re-arms when `k` changes, to show its fallback while what it waits on loads again.
    /// A reader outside the region of an equation that region waits on, and that `k` re-asks, holds the same change
    /// (nothing above it shows a fallback), so the region's fallback can never show: the change waits silently. Solid's
    /// dev build warns this at run time (LOADING_ON_OUTSIDE_HOLD); the checker sees it when both reads are in one
    /// component. `latest`, `pending?` and `peek` reads hold nothing.
    fn loading_on_outside(&mut self) {
        let mut found: Vec<(i64, String, String)> = vec![];
        let all_keys: Vec<Vec<(SId, Option<&str>)>> = self.load_ons.iter().map(|lo| self.on_keys(lo)).collect();
        for (li, lo) in self.load_ons.iter().enumerate() {
            let keys = &all_keys[li];
            // a reader in another region that re-arms on the same change shows that region's fallback: it holds nothing
            let rearmed = |r: RId| self.load_ons.iter().enumerate().any(|(oi, o)| oi != li && self.inside(r, o.region) && all_keys[oi].iter().any(|k| keys.contains(k)));
            // what the region waits on: questions read inside it that a key re-asks
            let mut waits: Vec<SId> = vec![];
            for rd in &self.readers {
                if !self.inside(rd.region, lo.region) {
                    continue;
                }
                for t in self.held_reads(rd.e, rd.env) {
                    if !waits.contains(&t) && keys.iter().any(|&(k, f)| t == k || self.syms[t].expr.is_some_and(|(e, env)| self.reads_key(e, env, k, f, &mut HashSet::new()))) {
                        waits.push(t);
                    }
                }
            }
            for rd in self.readers.iter().chain(self.effect_ins.iter()) {
                if self.inside(rd.region, lo.region) || std::ptr::eq(rd.e, lo.e) || self.regions[rd.region].component != self.regions[lo.region].component || rearmed(rd.region) {
                    continue;
                }
                let held = self.held_reads(rd.e, rd.env);
                if let Some(&t) = waits.iter().find(|&&t| held.contains(&t)) {
                    found.push((rd.line, self.syms[t].name.clone(), show(lo.e)));
                }
            }
        }
        for (line, name, on) in found {
            self.line = line;
            self.err(
                "LOADING_ON_OUTSIDE_HOLD",
                "CN-3e",
                format!(
                    "`{}` is read here, outside the `loading on({})` region that waits on it: when `{}` changes this read holds the change, so the region's fallback never shows and the old content stays up with no sign of the wait — move the read under the region, or read `latest {}` here",
                    name, on, on, name
                ),
            );
        }
    }
    /// CN-3e: the keys of a `loading on(…)`: the names its `on` reads, and for props the field read (`on(props.selected)`
    /// keys on `selected` alone).
    fn on_keys(&self, lo: &ReaderRec<'a>) -> Vec<(SId, Option<&'a str>)> {
        let mut keys = vec![];
        let mut stack = vec![Node::E(lo.e)];
        while let Some(n) = stack.pop() {
            if let Node::E(x) = n {
                if let ExprKind::Member { o, p, .. } = &x.k {
                    if let ExprKind::Id(name) = &o.k {
                        if let Some(t) = self.lookup(lo.env, name).filter(|&t| self.syms[t].kind == SymKind::Props) {
                            keys.push((t, Some(p.as_str())));
                            continue;
                        }
                    }
                }
                if let ExprKind::Id(name) = &x.k {
                    if let Some(t) = self.lookup(lo.env, name) {
                        keys.push((t, None));
                    }
                    continue;
                }
            }
            stack.extend(children(n, false));
        }
        keys
    }
    /// CN-3e: `e` reads `k` (with `f`, only the prop field `k.f`), directly or through the equations it reads.
    fn reads_key(&self, e: &Expr, env: EId, k: SId, f: Option<&str>, busy: &mut HashSet<SId>) -> bool {
        let Some(f) = f else { return self.depends(e, env, k, busy) };
        let mut stack = vec![Node::E(e)];
        while let Some(n) = stack.pop() {
            if let Node::E(x) = n {
                match &x.k {
                    ExprKind::Fn { .. } | ExprKind::ServerFn { .. } => continue,
                    ExprKind::Member { o, p, .. } if p == f && matches!(&o.k, ExprKind::Id(name) if self.lookup(env, name) == Some(k)) => return true,
                    ExprKind::Id(name) => {
                        if let Some(t) = self.lookup(env, name) {
                            if let Some((te, tenv)) = self.syms[t].expr {
                                if busy.insert(t) && self.reads_key(te, tenv, k, Some(f), busy) {
                                    return true;
                                }
                            }
                        }
                        continue;
                    }
                    _ => {}
                }
            }
            stack.extend(children(n, false));
        }
        false
    }
    /// CN-3e: the questions (async equations and sources) `e` holds on: what it reads, directly or through the equations it
    /// reads, outside `latest`, `pending?` and `peek`.
    fn held_reads(&self, e: &Expr, env: EId) -> Vec<SId> {
        let mut out = vec![];
        let mut busy = HashSet::new();
        let mut stack = vec![(e, env)];
        while let Some((e, env)) = stack.pop() {
            let mut nodes = vec![Node::E(e)];
            while let Some(n) = nodes.pop() {
                if let Node::E(x) = n {
                    match &x.k {
                        ExprKind::Fn { .. } | ExprKind::ServerFn { .. } | ExprKind::Peek(_) | ExprKind::Latest(_) | ExprKind::Pending(_) => continue,
                        ExprKind::Id(name) => {
                            if let Some(t) = self.lookup(env, name) {
                                if matches!(self.syms[t].kind, SymKind::Eq | SymKind::Source) && busy.insert(t) {
                                    if self.absent(t, &mut HashMap::new(), &mut HashSet::new()) {
                                        out.push(t);
                                    }
                                    if let Some((te, tenv)) = self.syms[t].expr {
                                        stack.push((te, tenv));
                                    }
                                }
                            }
                            continue;
                        }
                        _ => {}
                    }
                }
                nodes.extend(children(n, false));
            }
        }
        out
    }
    /// R-8: `e` reads `s`, directly or through the equations it reads.
    fn depends(&self, e: &Expr, env: EId, s: SId, busy: &mut HashSet<SId>) -> bool {
        let mut stack = vec![Node::E(e)];
        while let Some(n) = stack.pop() {
            if let Node::E(x) = n {
                match &x.k {
                    ExprKind::Fn { .. } | ExprKind::ServerFn { .. } => continue,
                    ExprKind::Id(name) => {
                        if let Some(t) = self.lookup(env, name) {
                            if t == s {
                                return true;
                            }
                            if let Some((te, tenv)) = self.syms[t].expr {
                                if busy.insert(t) && self.depends(te, tenv, s, busy) {
                                    return true;
                                }
                            }
                        }
                        continue;
                    }
                    _ => {}
                }
            }
            stack.extend(children(n, false));
        }
        false
    }
    /// R-8: some region around `r` that is `kind` has a reader of `s` in it.
    fn region_reads(&self, r: RId, s: SId, kind: impl Fn(&Region) -> bool) -> bool {
        let mut cur = Some(r);
        while let Some(c) = cur {
            if kind(&self.regions[c]) {
                for rd in &self.readers {
                    if self.inside(rd.region, c) && self.depends(rd.e, rd.env, s, &mut HashSet::new()) {
                        return true;
                    }
                }
            }
            if self.regions[c].is_component_root {
                break;
            }
            cur = self.regions[c].parent;
        }
        false
    }
    fn inside(&self, r: RId, anc: RId) -> bool {
        let mut cur = Some(r);
        while let Some(c) = cur {
            if c == anc {
                return true;
            }
            cur = self.regions[c].parent;
        }
        false
    }

    // ---- R-f: failures ----
    fn sym_fails(&mut self, s: SId) -> Fails {
        let (e, env) = match &mut self.syms[s].fails_t {
            None => return Fails::default(),
            Some(FailsT::Fixed(x)) => return Fails { cls: x.clone(), props: vec![] },
            Some(FailsT::Expr { cache: Some(c), .. }) => return c.clone(),
            Some(FailsT::Expr { busy: true, .. }) => return Fails::default(),
            Some(FailsT::Expr { e, env, busy, .. }) => {
                *busy = true;
                (*e, *env)
            }
        };
        let f = self.fails_of(e, env, false, &HashMap::new());
        if let Some(FailsT::Expr { e: e2, cache, busy, .. }) = &mut self.syms[s].fails_t {
            if std::ptr::eq(*e2, e) {
                *busy = false;
                *cache = Some(f.clone());
            }
        }
        f
    }
    fn sym_server_rejects(&mut self, s: SId) -> IndexSet<String> {
        let (body, env) = match &self.syms[s].server_rejects {
            None => return ["Error".to_string()].into_iter().collect(),
            Some(ServerRejects::Fixed(x)) => return x.clone(),
            Some(ServerRejects::Body { cache: Some(c), .. }) => return c.clone(),
            Some(ServerRejects::Body { body, env, .. }) => (*body, *env),
        };
        let mut out = self.stmts_fails(body, env, &HashMap::new()).cls;
        out.insert("Error".into());
        if let Some(ServerRejects::Body { cache, .. }) = &mut self.syms[s].server_rejects {
            *cache = Some(out.clone());
        }
        out
    }
    /// R-f-2/3/4: the failures an expression's evaluation can produce. `imp`: imperative scope, where closures are not run
    /// now. `bound`: catch bindings in scope and what they caught (for a rethrow).
    fn fails_of(&mut self, e: &'a Expr, env: EId, imp: bool, bound: &HashMap<String, IndexSet<String>>) -> Fails {
        self.fails_node(Node::E(e), env, imp, bound)
    }
    fn fails_node(&mut self, n: Node<'a>, env: EId, imp: bool, bound: &HashMap<String, IndexSet<String>>) -> Fails {
        let mut out = Fails::default();
        let e = match n {
            Node::E(e) => e,
            Node::S(Stmt { k: StmtKind::Throw(x), .. }) => {
                // a statement walked as an expression shares the expression's `throw` case
                let f = self.fails_of(x, env, imp, bound);
                out.add(f);
                out.cls.insert(self.class_of(x, env, bound));
                return out;
            }
            Node::S(_) => {
                for c in children(n, false) {
                    let f = self.fails_node(c, env, imp, bound);
                    out.add(f);
                }
                return out;
            }
        };
        match &e.k {
            ExprKind::Lit(_) | ExprKind::Pending(_) | ExprKind::Pre { .. } | ExprKind::ServerFn { .. } => out,
            ExprKind::Id(name) => {
                if bound.contains_key(name) {
                    return out;
                }
                let Some(s) = self.lookup(env, name) else { return out };
                match self.syms[s].kind {
                    SymKind::Props => {
                        out.props.push(PropRef { comp: self.syms[s].region, field: "*".into(), pre: vec![] });
                        out
                    }
                    SymKind::Eq | SymKind::Source if self.syms[s].fails_t.is_some() => {
                        let f = self.sym_fails(s);
                        out.add(f);
                        out
                    }
                    _ => out,
                }
            }
            ExprKind::Member { o, p, .. } => {
                if let ExprKind::Id(on) = &o.k {
                    if !bound.contains_key(on) {
                        if let Some(s) = self.lookup(env, on) {
                            if self.syms[s].kind == SymKind::Props {
                                out.props.push(PropRef { comp: self.syms[s].region, field: p.clone(), pre: vec![] });
                                return out;
                            }
                        }
                    }
                }
                let f = self.fails_of(o, env, imp, bound);
                out.add(f);
                out
            }
            ExprKind::Use(name) => {
                let Some(c) = self.lookup(env, name).and_then(|s| self.syms[s].ctx.clone()) else { return out };
                if let Some((_, fails)) = &c.contract {
                    out.cls.extend(fails.iter().cloned());
                    return out;
                }
                let mut i = 0;
                while i < self.provisions.len() {
                    let (pk, pe, penv) = (self.provisions[i].key.clone(), self.provisions[i].e, self.provisions[i].env);
                    if pk == c.key {
                        let f = self.fails_of(pe, penv, false, &HashMap::new());
                        out.add(f);
                    }
                    i += 1;
                }
                out
            }
            ExprKind::Await { e: inner, init, .. } => {
                let f = self.fails_of(inner, env, imp, bound);
                out.add(f);
                if let Some(i) = init {
                    let f = self.fails_of(i, env, imp, bound);
                    out.add(f);
                }
                for c in self.rejects(inner, env, &mut HashSet::new()) {
                    out.cls.insert(c);
                }
                out
            }
            ExprKind::Throw(x) => {
                let f = self.fails_of(x, env, imp, bound);
                out.add(f);
                out.cls.insert(self.class_of(x, env, bound));
                out
            }
            ExprKind::Catch { e: inner, name, classes, alt } => {
                let inn = self.fails_of(inner, env, imp, bound);
                let c = Catch::of(classes);
                let got: IndexSet<String> = inn.cls.iter().filter(|x| c.caught(x)).cloned().collect();
                for x in &inn.cls {
                    if !c.caught(x) {
                        out.cls.insert(x.clone());
                    }
                }
                for pr in &inn.props {
                    let mut pre = pr.pre.clone();
                    pre.push(c.clone());
                    out.props.push(PropRef { comp: pr.comp, field: pr.field.clone(), pre });
                }
                let mut b2 = bound.clone();
                if let Some(n) = name {
                    b2.insert(n.clone(), if c == Catch::All { inn.cls.clone() } else { got });
                }
                let f = self.fails_of(alt, env, imp, &b2);
                out.add(f);
                out
            }
            ExprKind::Fn { params, body, stmts } => {
                if imp || stmts.is_some() {
                    return out;
                }
                let mut b2 = bound.clone();
                for p in params {
                    b2.insert(p.clone(), IndexSet::new());
                }
                let region = self.reg(env);
                let inner = self.env(Some(env), region);
                for p in params {
                    self.set_value(inner, p, 0);
                }
                let f = self.fails_of(body, inner, imp, &b2);
                out.add(f);
                out
            }
            ExprKind::Call { f, args } => {
                match &f.k {
                    ExprKind::Id(fname) if !bound.contains_key(fname) => {
                        if let Some(s) = self.lookup(env, fname) {
                            let k = self.syms[s].kind;
                            if k == SymKind::Fn && self.syms[s].fails_t.is_some() {
                                let x = self.sym_fails(s);
                                out.add(x);
                            } else if !matches!(k, SymKind::ErrClass | SymKind::Import | SymKind::Action | SymKind::Server) {
                                let x = self.fails_of(f, env, imp, bound);
                                out.add(x);
                            }
                        }
                    }
                    _ => {
                        let x = self.fails_of(f, env, imp, bound);
                        out.add(x);
                    }
                }
                for a in args {
                    let x = self.fails_of(a, env, imp, bound);
                    out.add(x);
                }
                out
            }
            ExprKind::Draft { seed, body } => {
                let x = self.fails_of(seed, env, imp, bound);
                out.add(x);
                for st in body {
                    if let StmtKind::Let { e, .. } | StmtKind::Expr(e) | StmtKind::Write { e, .. } = &st.k {
                        let x = self.fails_of(e, env, imp, bound);
                        out.add(x);
                    }
                }
                out
            }
            _ => {
                for c in children(Node::E(e), false) {
                    let x = self.fails_node(c, env, imp, bound);
                    out.add(x);
                }
                out
            }
        }
    }
    /// R-f-8: what an awaited value's promise may reject with.
    fn rejects(&mut self, e: &'a Expr, env: EId, seen: &mut HashSet<SId>) -> IndexSet<String> {
        fn root(x: &Expr) -> &Expr {
            match &x.k {
                ExprKind::Member { o, .. } | ExprKind::Index { o, .. } => root(o),
                _ => x,
            }
        }
        let error = || -> IndexSet<String> { ["Error".to_string()].into_iter().collect() };
        match &e.k {
            ExprKind::Lit(_) | ExprKind::Tpl(_) | ExprKind::Arr(_) | ExprKind::Rec(_) | ExprKind::Bin { .. } | ExprKind::Un { .. } => IndexSet::new(),
            ExprKind::If { t, f, .. } => {
                let mut a = self.rejects(t, env, seen);
                a.extend(self.rejects(f, env, seen));
                a
            }
            ExprKind::Call { f, args } => {
                let r = root(f);
                if let ExprKind::Id(fname) = &f.k {
                    if fname == "until" && self.lookup(env, "until").is_none() {
                        return match args.first() {
                            Some(Expr { k: ExprKind::Fn { body, stmts: None, .. }, .. }) => self.fails_of(body, env, false, &HashMap::new()).cls,
                            _ => IndexSet::new(),
                        };
                    }
                }
                if let ExprKind::Id(rn) = &r.k {
                    if let Some(s) = self.lookup(env, rn) {
                        let k = self.syms[s].kind;
                        if k == SymKind::Import {
                            return self.syms[s].rejects.clone().unwrap_or_else(error);
                        }
                        if k == SymKind::Server {
                            return if self.syms[s].server_rejects.is_some() { self.sym_server_rejects(s) } else { error() };
                        }
                        if k == SymKind::Fn {
                            if let Some((t, te)) = self.syms[s].fn_tail {
                                if matches!(&f.k, ExprKind::Id(_)) && !seen.contains(&s) {
                                    seen.insert(s);
                                    return self.rejects(t, te, seen);
                                }
                            }
                            if let Some(rj) = &self.syms[s].rejects {
                                return rj.clone();
                            }
                        }
                        if k == SymKind::Action {
                            return IndexSet::new();
                        }
                    }
                }
                error()
            }
            ExprKind::Id(name) => {
                if let Some(s) = self.lookup(env, name) {
                    if let Some((x, xe)) = self.syms[s].expr {
                        if !seen.contains(&s) {
                            seen.insert(s);
                            return self.rejects(x, xe, seen);
                        }
                    }
                }
                error()
            }
            _ => error(),
        }
    }
    /// R-f-3: the class a `throw` fails with — a declared class's construction, a rethrown catch binding, else Error.
    fn class_of(&self, e: &Expr, env: EId, bound: &HashMap<String, IndexSet<String>>) -> String {
        if let ExprKind::Call { f, .. } = &e.k {
            if let ExprKind::Id(n) = &f.k {
                if self.lookup(env, n).is_some_and(|s| matches!(self.syms[s].kind, SymKind::ErrClass | SymKind::Import)) {
                    return n.clone();
                }
            }
        }
        if let ExprKind::Id(n) = &e.k {
            if let Some(b) = bound.get(n) {
                return if b.len() == 1 {
                    b[0].clone()
                } else if !b.is_empty() {
                    b.iter().cloned().collect::<Vec<_>>().join("|")
                } else {
                    "Error".into()
                };
            }
        }
        "Error".into()
    }
    /// R-f-6: the failures an action body lets out.
    fn stmts_fails(&mut self, ss: &'a [Stmt], env0: EId, bound: &HashMap<String, IndexSet<String>>) -> Fails {
        let mut out = Fails::default();
        let region = self.reg(env0);
        let env = self.env(Some(env0), region);
        for s in ss {
            match &s.k {
                StmtKind::Let { name, e, .. } => {
                    let f = self.fails_of(e, env, true, bound);
                    out.add(f);
                    self.set_value(env, name, 0);
                }
                StmtKind::Expr(e) => {
                    let f = self.fails_of(e, env, true, bound);
                    out.add(f);
                }
                StmtKind::Return(e) => {
                    if let Some(e) = e {
                        let f = self.fails_of(e, env, true, bound);
                        out.add(f);
                    }
                }
                StmtKind::Write { target, e } | StmtKind::Optimistic { target, e } => {
                    for p in &target.path {
                        if let PathSeg::Expr(x) = p {
                            let f = self.fails_of(x, env, true, bound);
                            out.add(f);
                        }
                    }
                    let f = self.fails_of(e, env, true, bound);
                    out.add(f);
                }
                StmtKind::Throw(e) => {
                    let f = self.fails_of(e, env, true, bound);
                    out.add(f);
                    for c in self.class_of(e, env, bound).split('|') {
                        out.cls.insert(c.to_string());
                    }
                }
                StmtKind::Sif { c, t, f } => {
                    let x = self.fails_of(c, env, true, bound);
                    out.add(x);
                    let x = self.stmts_fails(t, env, bound);
                    out.add(x);
                    let x = self.stmts_fails(f, env, bound);
                    out.add(x);
                }
                StmtKind::Try { body, catch_name, catch_classes, handler, fin } => {
                    let b = self.stmts_fails(body, env, bound);
                    if let Some(h) = handler {
                        let c = Catch::of(catch_classes);
                        for x in &b.cls {
                            if !c.caught(x) {
                                out.cls.insert(x.clone());
                            }
                        }
                        for pr in &b.props {
                            let mut pre = pr.pre.clone();
                            pre.push(c.clone());
                            out.props.push(PropRef { comp: pr.comp, field: pr.field.clone(), pre });
                        }
                        let mut b2 = bound.clone();
                        if let Some(n) = catch_name {
                            b2.insert(n.clone(), b.cls.iter().filter(|x| c.caught(x)).cloned().collect());
                        }
                        let henv = self.env(Some(env), region);
                        if let Some(n) = catch_name {
                            self.set_value(henv, n, 0);
                        }
                        let x = self.stmts_fails(h, henv, &b2);
                        out.add(x);
                    } else {
                        out.add(b);
                    }
                    if let Some(f) = fin {
                        let x = self.stmts_fails(f, env, bound);
                        out.add(x);
                    }
                }
                StmtKind::Action(_) | StmtKind::Refresh(_) | StmtKind::Affects(_) => {}
            }
        }
        out
    }

    // ---- R-f-5/6 and RG-7b over the static application tree ----
    fn resolve_tree(&mut self) {
        let readers: Vec<(RId, &'a Expr, EId, i64)> = self.readers.iter().map(|r| (r.region, r.e, r.env, r.line)).collect();
        let mut reader_f = vec![];
        for &(region, e, env, line) in &readers {
            let f = self.fails_of(e, env, false, &HashMap::new());
            reader_f.push((region, e, line, f));
        }
        let mut memo = HashMap::new();
        for &(region, e, env, line) in &readers {
            if self.rows_of(e, env).contains("client") || (self.opts.spa && self.expr_absent(e, env, None, true, &mut memo, &mut HashSet::new())) {
                self.uses.push(UseRec { region, name: HOLD.into(), line, display: show(e) });
            }
        }
        let apps: Vec<(usize, Vec<(String, &'a Expr, EId)>)> = self.apps.iter().enumerate().map(|(i, a)| (i, a.args.clone())).collect();
        let mut arg_r = vec![];
        for (i, args) in &apps {
            for (field, e, env) in args {
                if self.rows_of(e, *env).contains("client") || (self.opts.spa && self.expr_absent(e, *env, None, true, &mut memo, &mut HashSet::new())) {
                    arg_r.push((*i, field.clone()));
                }
            }
        }
        let mut arg_f = vec![];
        for (i, args) in &apps {
            for (field, e, env) in args {
                let f = self.fails_of(e, *env, false, &HashMap::new());
                arg_f.push((*i, field.clone(), f));
            }
        }
        let actions: Vec<(String, &'a [Stmt], EId, i64)> = self.actions.iter().map(|a| (a.name.clone(), a.body, a.env, a.line)).collect();
        let mut act_f = vec![];
        for (name, body, env, line) in &actions {
            let f = self.stmts_fails(body, *env, &HashMap::new());
            act_f.push((name.clone(), *line, f));
        }
        let pre = |cs: &[Catch]| -> Vec<Step> { cs.iter().map(|f| Step { f: Some(f.clone()), p: None }).collect() };
        let mut occ = vec![];
        for (region, _, _, f) in &reader_f {
            for pr in &f.props {
                occ.push(Occ { comp: pr.comp, field: pr.field.clone(), pre: pre(&pr.pre), via: Via::Reader(*region) });
            }
        }
        for (i, field, f) in &arg_f {
            for pr in &f.props {
                let a = &self.apps[*i];
                occ.push(Occ { comp: pr.comp, field: pr.field.clone(), pre: pre(&pr.pre), via: Via::Arg { comp: a.comp, field: field.clone(), site: a.site } });
            }
        }
        for (name, line, f) in &act_f {
            for pr in &f.props {
                occ.push(Occ { comp: pr.comp, field: pr.field.clone(), pre: pre(&pr.pre), via: Via::Action { line: *line, name: name.clone() } });
            }
        }
        self.occ = occ;
        self.reader_f = reader_f;
        self.arg_r = arg_r;
        self.arg_f = arg_f;

        let top = self.esc(None);
        for it in top.fails {
            self.line = it.line;
            let suffix = if it.cls == "Error" { String::new() } else { format!(": {}", it.cls) };
            self.err(
                "UNHANDLED_FAILURE",
                "R-f-5",
                format!(
                    "a reader of {} can fail with {} and no catch or errored boundary above it discharges {} — wrap it in `errored fallback(e{}) {{ … }} {{ … }}`, or catch it: `… catch (e{}) => …`",
                    it.what, it.cls, it.cls, suffix, suffix
                ),
            );
        }
        for it in top.reqs {
            self.line = it.line;
            if it.name == HOLD && self.opts.spa {
                self.err(
                    "ASYNC_OUTSIDE_LOADING_BOUNDARY",
                    "CN-3d",
                    format!(
                        "{} can have no value yet, and no `loading` region above it holds it on some path that renders it: in a client-only build the first load would show nothing until it answers — put it under `loading fallback {{ … }} {{ … }}`, or give the await a first paint (`await f() -> v`). Later answers are transitions and need no region",
                        it.what
                    ),
                );
                continue;
            }
            if it.name == HOLD {
                self.err(
                    "CLIENT_QUESTION_UNHELD",
                    "SV-7b",
                    format!(
                        "{} awaits `client` JS, and no `loading` region above it holds it on any path that renders it: the server never asks a client question, so it could never finish this page — put the reader under `loading fallback {{ … }} {{ … }}`, or give the await a first paint (`await f() -> v`)",
                        it.what
                    ),
                );
                continue;
            }
            let file = it.name.split('#').next().unwrap_or("").split('/').last().unwrap_or("").to_string();
            self.err("CONTEXT_NOT_FOUND", "RG-7b", format!("{}: no provision of {} (declared in {}) above this region on any path that renders it", it.what, key_name(&it.name), file));
        }
        for (name, line, f) in act_f {
            if !f.cls.is_empty() {
                self.line = line;
                self.err(
                    "UNCAUGHT_ACTION_FAILURE",
                    "R-f-6",
                    format!(
                        "action {} can fail with {} and does not catch it: a handler cannot (it does not await the action) — `try {{ … }} catch (e) {{ … }}` in the body",
                        name,
                        f.cls.iter().cloned().collect::<Vec<_>>().join(", ")
                    ),
                );
            }
        }
    }
    /// The steps from a region up to its component's root (or the program's), through children's reads.
    fn routes(&mut self, r0: RId) -> Vec<Vec<Step>> {
        if let Some(m) = self.r_memo.get(&r0) {
            return m.clone();
        }
        if self.r_busy.contains(&r0) {
            return vec![];
        }
        self.r_busy.insert(r0);
        let mut local: Vec<Step> = vec![];
        let mut out: Vec<Vec<Step>> = vec![];
        let mut r = Some(r0);
        while let Some(ri) = r {
            let (catches, provides, kids, root) = {
                let reg = &self.regions[ri];
                (reg.catches.clone(), reg.provides.clone(), reg.kids, reg.is_component_root || reg.parent.is_none())
            };
            if catches.is_some() || !provides.is_empty() {
                local.push(Step { f: catches, p: if provides.is_empty() { None } else { Some(Catch::Set(provides)) } });
            }
            if let Some((comp, site)) = kids {
                for p in self.pf(comp, "children") {
                    if p.term.is_none() {
                        for q in self.routes(site) {
                            let mut c = local.clone();
                            c.extend(p.chain.iter().cloned());
                            c.extend(q);
                            out.push(c);
                        }
                    }
                }
                break;
            }
            if root {
                out = vec![local.clone()];
                break;
            }
            r = self.regions[ri].parent;
        }
        let out = dedupe_chains(out);
        self.r_busy.remove(&r0);
        self.r_memo.insert(r0, out.clone());
        out
    }
    fn via(&mut self, v: &Via) -> Vec<PFEntry> {
        match v {
            Via::Reader(region) => self.routes(*region).into_iter().map(|q| PFEntry { chain: q, term: None }).collect(),
            Via::Arg { comp, field, site } => {
                let mut out = vec![];
                for p in self.pf(*comp, field) {
                    if p.term.is_some() {
                        out.push(p);
                    } else {
                        for q in self.routes(*site) {
                            let mut c = p.chain.clone();
                            c.extend(q);
                            out.push(PFEntry { chain: c, term: None });
                        }
                    }
                }
                out
            }
            Via::Action { line, name } => vec![PFEntry { chain: vec![], term: Some((*line, name.clone())) }],
        }
    }
    /// Where a component's prop field goes once read — up to its root, or out of an action.
    fn pf(&mut self, g: RId, field: &str) -> Vec<PFEntry> {
        if let Some(sig) = &self.regions[g].sig {
            let Some(s) = sig.props.get(field).or_else(|| sig.props.get("*")) else { return vec![] };
            let mut out = vec![PFEntry { chain: vec![Step { f: Some(s.f.clone()), p: Some(s.p.clone()) }], term: None }];
            if let Some((af, an)) = &s.action {
                out.push(PFEntry { chain: vec![Step { f: Some(af.clone()), p: None }], term: Some((-1, an.clone())) });
            }
            return out;
        }
        let k = (self.regions[g].id, field.to_string());
        if let Some(m) = self.pf_memo.get(&k) {
            return m.clone();
        }
        if self.pf_busy.contains(&k) {
            return vec![];
        }
        self.pf_busy.insert(k.clone());
        let mut out = vec![];
        let occ = self.occ.clone();
        for o in &occ {
            if o.comp == g && (o.field == field || o.field == "*") {
                for v in self.via(&o.via) {
                    let mut c = o.pre.clone();
                    c.extend(v.chain);
                    out.push(PFEntry { chain: c, term: v.term });
                }
            }
        }
        let res = dedupe_entries(out);
        self.pf_busy.remove(&k);
        self.pf_memo.insert(k, res.clone());
        res
    }
    /// What escapes each component's root (and the program's): failures and provisions.
    fn esc(&mut self, c: Option<RId>) -> Esc {
        if let Some(ci) = c {
            if let Some(sig) = &self.regions[ci].sig {
                return Esc {
                    fails: sig.own.iter().map(|o| Item { cls: o.cls.clone(), line: -1, what: match &o.at { Some(at) => format!("{} at {}", o.what, at), None => o.what.clone() } }).collect(),
                    reqs: sig.requires.iter().map(|n| Req { name: n.clone(), line: -1, what: if n == HOLD { "a reader of a client question".into() } else { format!("use {}", key_name(n)) } }).collect(),
                };
            }
        }
        if let Some(m) = self.esc_memo.get(&c) {
            return m.clone();
        }
        if self.esc_busy.contains(&c) {
            return Esc::default();
        }
        self.esc_busy.insert(c);
        let mut res = Esc::default();
        let mut seen: HashSet<String> = HashSet::new();
        let push_f = |res: &mut Esc, seen: &mut HashSet<String>, it: Item| {
            if seen.insert(format!("F{}@{}:{}", it.cls, it.line, it.what)) {
                res.fails.push(it);
            }
        };
        let push_r = |res: &mut Esc, seen: &mut HashSet<String>, it: Req| {
            if seen.insert(format!("R{}@{}:{}", it.name, it.line, it.what)) {
                res.reqs.push(it);
            }
        };
        let comp_of = |s: &Self, r: RId| s.regions[r].component;
        let reader_f: Vec<(RId, &'a Expr, i64, IndexSet<String>)> = self.reader_f.iter().map(|(r, e, l, f)| (*r, *e, *l, f.cls.clone())).collect();
        for (region, e, line, cls) in reader_f {
            if comp_of(self, region) != c {
                continue;
            }
            for cl in cls {
                if self.routes(region).iter().any(|q| esc_f(q, &cl)) {
                    push_f(&mut res, &mut seen, Item { cls: cl, line, what: show(e) });
                }
            }
        }
        let uses: Vec<(RId, String, i64, String)> = self.uses.iter().map(|u| (u.region, u.name.clone(), u.line, u.display.clone())).collect();
        for (region, name, line, display) in uses {
            if comp_of(self, region) != c {
                continue;
            }
            if self.routes(region).iter().any(|q| esc_p(q, &name)) {
                let what = if name == HOLD { format!("a reader of {}", display) } else { format!("use {}", display) };
                push_r(&mut res, &mut seen, Req { name, line, what });
            }
        }
        for (ai, field) in self.arg_r.clone() {
            let (acomp, asite, aline, atag) = (self.apps[ai].comp, self.apps[ai].site, self.apps[ai].line, self.apps[ai].tag.clone());
            if comp_of(self, asite) != c {
                continue;
            }
            for p in self.pf(acomp, &field) {
                if p.term.is_none()
                    && self.routes(asite).iter().any(|q| {
                        let mut ch = p.chain.clone();
                        ch.extend(q.iter().cloned());
                        esc_p(&ch, HOLD)
                    })
                {
                    push_r(&mut res, &mut seen, Req { name: HOLD.into(), line: aline, what: format!("<{} {}={{…}}>, read in {},", atag, field, atag) });
                    break;
                }
            }
        }
        for ai in 0..self.apps.len() {
            let (acomp, asite, aline, atag) = (self.apps[ai].comp, self.apps[ai].site, self.apps[ai].line, self.apps[ai].tag.clone());
            if comp_of(self, asite) != c {
                continue;
            }
            let e = self.esc(Some(acomp));
            for it in e.fails {
                if self.routes(asite).iter().any(|q| esc_f(q, &it.cls)) {
                    let line = if it.line < 0 { aline } else { it.line };
                    push_f(&mut res, &mut seen, Item { cls: it.cls, line, what: format!("{} (in <{}>)", it.what, atag) });
                }
            }
            for it in e.reqs {
                if self.routes(asite).iter().any(|q| esc_p(q, &it.name)) {
                    let line = if it.line < 0 { aline } else { it.line };
                    push_r(&mut res, &mut seen, Req { name: it.name, line, what: format!("{} (in <{}>)", it.what, atag) });
                }
            }
        }
        for (ai, field, f) in self.arg_f.clone() {
            let (acomp, asite, aline, atag) = (self.apps[ai].comp, self.apps[ai].site, self.apps[ai].line, self.apps[ai].tag.clone());
            if comp_of(self, asite) != c {
                continue;
            }
            for cl in &f.cls {
                for p in self.pf(acomp, &field) {
                    if let Some((_, tname)) = &p.term {
                        if esc_f(&p.chain, cl) {
                            self.line = aline;
                            self.err(
                                "UNCAUGHT_ACTION_FAILURE",
                                "R-f-6",
                                format!("action {} in <{}> reads props.{}, which can fail with {} here (line {}), and does not catch it", tname, atag, field, cl, aline),
                            );
                        }
                        continue;
                    }
                    if self.routes(asite).iter().any(|q| {
                        let mut ch = p.chain.clone();
                        ch.extend(q.iter().cloned());
                        esc_f(&ch, cl)
                    }) {
                        push_f(&mut res, &mut seen, Item { cls: cl.clone(), line: aline, what: format!("<{} {}={{…}}>", atag, field) });
                        break;
                    }
                }
            }
        }
        self.esc_busy.remove(&c);
        self.esc_memo.insert(c, res.clone());
        res
    }
    /// MO-3: the summary an importing module checks a component against.
    fn comp_sig(&mut self, g: RId) -> CompSig {
        let fields: IndexSet<String> = self.occ.iter().filter(|o| o.comp == g).map(|o| o.field.clone()).collect();
        let mut props = IndexMap::new();
        for f in fields {
            let es = self.pf(g, &f);
            let mut df = Catch::All;
            let mut dp = Catch::All;
            let mut da: Option<Catch> = None;
            let mut an = String::new();
            let mut rendered = false;
            for e in &es {
                if let Some((_, tname)) = &e.term {
                    let a = along(&e.chain, true);
                    da = Some(match da {
                        None => a,
                        Some(d) => meet(d, &a),
                    });
                    an = tname.clone();
                } else {
                    rendered = true;
                    df = meet(df, &along(&e.chain, true));
                    dp = meet(dp, &along(&e.chain, false));
                }
            }
            props.insert(f, PropSig { f: df, p: dp, rendered, action: da.map(|d| (d, an)) });
        }
        let e = self.esc(Some(g));
        let file = self.opts.file.clone().unwrap_or_else(|| "main.rx".into()).split('/').last().unwrap_or("").to_string();
        let shape = match self.comp_syms.get(&g).copied() {
            Some(cs) => self.shape(cs),
            None => Shape::default(),
        };
        let requires: IndexSet<String> = e.reqs.iter().map(|r| r.name.clone()).collect();
        let mut stored: IndexMap<String, Vec<String>> = IndexMap::new();
        if let Some(st) = self.retains.get(&g) {
            for (f, ts) in st {
                // an exported component's outside is its module
                let mut v: Vec<String> = ts.iter().map(|t| if t.starts_with("d:") { "module".to_string() } else { t[2..].to_string() }).collect::<IndexSet<_>>().into_iter().collect();
                v.sort();
                stored.insert(f.clone(), v);
            }
        }
        CompSig { own: e.fails.iter().map(|i| Own { cls: i.cls.clone(), what: i.what.clone(), at: Some(format!("{}:{}", file, i.line)) }).collect(), requires: requires.into_iter().collect(), props, shape: Some(shape), stored }
    }
}

/// The calls by name in a server fn's body (`callsIn`: every value, a target's path included).
fn calls_in(n: Node, out: &mut Vec<String>) {
    if let Node::E(Expr { k: ExprKind::Call { f, .. }, .. }) = n {
        if let ExprKind::Id(name) = &f.k {
            out.push(name.clone());
        }
    }
    for c in children(n, true) {
        calls_in(c, out);
    }
}
/// RG-7e: a context's written rows — the row words before its type.
fn contract_of(ty: Option<&str>) -> (IndexSet<String>, IndexSet<String>) {
    let mut rows = IndexSet::new();
    let mut fails = IndexSet::new();
    if let Some(m) = ty.and_then(|t| ROW_WORDS.find(t)) {
        for w in split_rows(js_trim(m.as_str())) {
            if let Some(inner) = w.strip_prefix("fails(") {
                let inner = &inner[..inner.len().saturating_sub(1)];
                for x in inner.split('|').map(js_trim).filter(|x| !x.is_empty()) {
                    fails.insert(x.to_string());
                }
            } else {
                rows.insert(w);
            }
        }
    }
    (rows, fails)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::load_modules;

    fn codes(src: &str, spa: bool) -> Vec<(i64, String)> {
        let read = |p: &str| if p == "/app.rx" { Some(src.to_string()) } else { None };
        let set = load_modules("/app.rx", &read).unwrap();
        check_modules(&set, spa).diags.iter().map(|d| (d.line, d.code.clone())).collect()
    }

    /// 08 CN-3d: in a client-only build, a reader the first load surely waits on needs a `loading` above it.
    #[test]
    fn first_load_unheld_in_client_only_builds() {
        let src = r#"import pure { get } from "./api"
source q: string := ""
users = await get(1)
found = q == "" ? null : await get(2)
shown = await get(3) -> []
component Panel() {
  <p>{users}</p>
}
export default component App() {
  errored fallback(e) { <p>failed</p> } {
    <p>{users}</p>
    <p>{pending? users}</p>
    <p>{found}</p>
    <p>{shown}</p>
    <Panel />
    loading fallback { <p>…</p> } {
      <p>{users}</p>
      <Panel />
    }
  }
}
"#;
        assert_eq!(codes(src, false), vec![]);
        let spa = codes(src, true);
        let mut lines: Vec<i64> = spa.iter().filter(|(_, c)| c == "ASYNC_OUTSIDE_LOADING_BOUNDARY").map(|(l, _)| *l).collect();
        lines.sort();
        assert_eq!(lines, vec![7, 11, 12], "{spa:?}");
        assert_eq!(spa.len(), 3, "{spa:?}");
    }

    #[test]
    fn outside_read_holds_a_loading_on() {
        let src = r#"import pure { get } from "./api"
export default component App() {
  source filter := "open"
  source sel := 1
  issues = await get(filter)
  detail = await get(sel)
  count = issues.length
  effect (filter == "open" ? count : -1) {
    log($0)
  }
  errored fallback(e) { <p>failed</p> } {
    <p>{latest issues}</p>
    <p>{pending? issues}</p>
    loading on(filter) fallback { <p>loading</p> } {
      <p>{count}</p>
    }
    loading on(sel) fallback { <p>…</p> } {
      <h2>{detail}</h2>
      loading on(sel) fallback { <p>…</p> } {
        <p>{detail}</p>
      }
    }
    loading fallback { <p>…</p> } {
      <p>{detail}</p>
    }
  }
}
"#;
        let mut got: Vec<i64> = codes(src, false).iter().filter(|(_, c)| c == "LOADING_ON_OUTSIDE_HOLD").map(|(l, _)| *l).collect();
        got.sort();
        // the effect (line 8) and the detail read under a plain `loading` (line 24); not `latest`/`pending?`, not the
        // outer `on(sel)` region's own read of `detail` beside the inner one
        assert_eq!(got, vec![8, 24]);
    }
}
