//! The abstract syntax (spec/02-core.md §1), as `ref/src/ast.ts` has it. Operators are spelled as in JS; types are TS's,
//! kept as text (07 §2). `to_json` writes a node the way `JSON.stringify` writes the reference's, so the two parsers are
//! diffed node for node (`ref/crate.ts`).

use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum Lit {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
}

#[derive(Debug, Clone)]
pub enum TplPart {
    Str(String),
    Expr(Expr),
}

#[derive(Debug, Clone)]
pub enum Field {
    Kv { key: String, v: Expr },
    Spread(Expr),
}

/// A byte range of the `.rx` source (`start..end`). `Span::NONE` (0..0) marks a node the compiler made, not the parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}
impl Span {
    pub const NONE: Span = Span { start: 0, end: 0 };
    pub fn new(start: usize, end: usize) -> Self {
        Span { start: start as u32, end: end as u32 }
    }
    pub fn is_none(&self) -> bool {
        self.start == 0 && self.end == 0
    }
    /// The 1-based line `start` is on.
    pub fn line(&self, src: &str) -> usize {
        src.as_bytes()[..(self.start as usize).min(src.len())].iter().filter(|b| **b == b'\n').count() + 1
    }
    pub fn text<'a>(&self, src: &'a str) -> &'a str {
        src.get(self.start as usize..self.end as usize).unwrap_or("")
    }
}

/// An expression and where it was written.
#[derive(Debug, Clone)]
pub struct Expr {
    pub k: ExprKind,
    pub span: Span,
}
impl Expr {
    pub fn new(k: ExprKind, span: Span) -> Self {
        Expr { k, span }
    }
    /// An expression the compiler made: no source.
    pub fn made(k: ExprKind) -> Self {
        Expr { k, span: Span::NONE }
    }
}

#[derive(Debug, Clone)]
pub enum ExprKind {
    Lit(Lit),
    Id(String),
    Bin { op: String, l: Box<Expr>, r: Box<Expr> },
    Un { op: String, e: Box<Expr> },
    Pre { name: String, init: Option<Box<Expr>> },
    Peek(Box<Expr>),
    /// R-1, R-7; `stream`: `await*` (ST-6b)
    Await { e: Box<Expr>, init: Option<Box<Expr>>, stream: bool },
    Latest(Box<Expr>),
    Pending(Box<Expr>),
    If { c: Box<Expr>, t: Box<Expr>, f: Box<Expr> },
    Tpl(Vec<TplPart>),
    Member { o: Box<Expr>, p: String, opt: bool },
    Index { o: Box<Expr>, i: Box<Expr>, opt: bool },
    Call { f: Box<Expr>, args: Vec<Expr> },
    Arr(Vec<Expr>),
    Rec(Vec<Field>),
    /// `stmts`: a statement-bodied arrow (imperative scope, 07 §5)
    Fn { params: Vec<String>, body: Box<Expr>, stmts: Option<Vec<Stmt>> },
    /// ST-3
    Draft { seed: Box<Expr>, body: Vec<Stmt> },
    /// RG-7b
    Use(String),
    Spread(Box<Expr>),
    /// R-f-3
    Throw(Box<Expr>),
    /// R-f-4: `e catch (x: A | B) => alt`; classes absent: every failure
    Catch { e: Box<Expr>, name: Option<String>, classes: Option<Vec<String>>, alt: Box<Expr> },
    /// 07 CSS-5
    StyleMap { css: String, line: usize },
    /// 12 SF-1d
    ServerFn { params: Vec<String>, ptypes: Vec<Option<String>>, ret: Option<String>, body: Vec<Stmt> },
}

#[derive(Debug, Clone)]
pub enum PathSeg {
    Name(String),
    Expr(Expr),
}

#[derive(Debug, Clone)]
pub struct Target {
    pub name: String,
    pub path: Vec<PathSeg>,
    /// `use name := …` (RG-7, O-4). `None`: not written by this form (a `guess` target).
    pub ctx: Option<bool>,
}
impl Target {
    pub fn is_ctx(&self) -> bool {
        self.ctx == Some(true)
    }
}

/// A statement and where it was written.
#[derive(Debug, Clone)]
pub struct Stmt {
    pub k: StmtKind,
    pub span: Span,
}

#[derive(Debug, Clone)]
pub enum StmtKind {
    Write { target: Target, e: Expr },
    Let { name: String, e: Expr, ty: Option<String> },
    Expr(Expr),
    Optimistic { target: Target, e: Expr },
    Refresh(String),
    Affects(String),
    Action(Vec<Stmt>),
    Sif { c: Expr, t: Vec<Stmt>, f: Vec<Stmt> },
    Return(Option<Expr>),
    Try { body: Vec<Stmt>, catch_name: Option<String>, catch_classes: Option<Vec<String>>, handler: Option<Vec<Stmt>>, fin: Option<Vec<Stmt>> },
    Throw(Expr),
}
impl Stmt {
    pub fn kind(&self) -> &'static str {
        self.k.kind()
    }
}
impl StmtKind {
    pub fn kind(&self) -> &'static str {
        match self {
            StmtKind::Write { .. } => "write",
            StmtKind::Let { .. } => "let",
            StmtKind::Expr(_) => "expr",
            StmtKind::Optimistic { .. } => "optimistic",
            StmtKind::Refresh(_) => "refresh",
            StmtKind::Affects(_) => "affects",
            StmtKind::Action(_) => "action",
            StmtKind::Sif { .. } => "sif",
            StmtKind::Return(_) => "return",
            StmtKind::Try { .. } => "try",
            StmtKind::Throw(_) => "throw",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Param {
    pub name: String,
    pub r#ref: bool,
    pub ty: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Server,
    Client,
}
impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Server => "server",
            Side::Client => "client",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ImportName {
    pub name: String,
    pub alias: String,
}

#[derive(Debug, Clone)]
pub enum Decl {
    Source { name: String, init: Expr, line: usize, span: Span, question: bool, ty: Option<String>, exported: bool, key: Option<String> },
    Eq { name: String, e: Expr, line: usize, span: Span, deferred: bool, key: Option<String>, ty: Option<String>, exported: bool },
    Import {
        names: Vec<ImportName>,
        from: String,
        pure: bool,
        side: Option<Side>,
        line: usize,
        span: Span,
        fails: Option<Vec<String>>,
        /// an `.rx` import's module key (MO-1, set by the loader)
        resolved: Option<String>,
        /// a JS import's declaration file (MO-8)
        declared: Option<String>,
        declared_errors: Option<Vec<String>>,
        declared_pure: Option<Vec<String>>,
        declared_side: Option<Vec<(String, Side)>>,
    },
    Error { name: String, params: Vec<String>, ptypes: Vec<Option<String>>, msg: Option<Expr>, line: usize, span: Span, exported: bool },
    TypeDecl { name: String, line: usize, span: Span, text: String, exported: bool },
    Effect { inputs: Vec<Expr>, body: Vec<Stmt>, line: usize, span: Span },
    Fn { name: String, params: Vec<Param>, decls: Vec<Decl>, tail: Expr, line: usize, span: Span, ret: Option<String>, exported: bool },
    Component { name: String, props: String, decls: Vec<Decl>, view: Vec<Markup>, line: usize, span: Span, props_type: Option<String>, exported: bool, is_default: bool },
    Action { name: String, params: Vec<String>, ptypes: Vec<Option<String>>, body: Vec<Stmt>, line: usize, span: Span, exported: bool },
    Server { name: String, params: Vec<String>, ptypes: Vec<Option<String>>, ret: Option<String>, body: Vec<Stmt>, line: usize, span: Span, exported: bool },
    Provide { name: String, e: Expr, line: usize, span: Span },
    Context { name: String, ty: Option<String>, source: bool, dflt: Option<Expr>, line: usize, span: Span, exported: bool },
}
impl Decl {
    pub fn line(&self) -> usize {
        match self {
            Decl::Source { line, .. }
            | Decl::Eq { line, .. }
            | Decl::Import { line, .. }
            | Decl::Error { line, .. }
            | Decl::TypeDecl { line, .. }
            | Decl::Effect { line, .. }
            | Decl::Fn { line, .. }
            | Decl::Component { line, .. }
            | Decl::Action { line, .. }
            | Decl::Server { line, .. }
            | Decl::Provide { line, .. }
            | Decl::Context { line, .. } => *line,
        }
    }
    /// Where the declaration was written, from its first keyword (`export` included) to its end.
    pub fn span(&self) -> Span {
        match self {
            Decl::Source { span, .. }
            | Decl::Eq { span, .. }
            | Decl::Import { span, .. }
            | Decl::Error { span, .. }
            | Decl::TypeDecl { span, .. }
            | Decl::Effect { span, .. }
            | Decl::Fn { span, .. }
            | Decl::Component { span, .. }
            | Decl::Action { span, .. }
            | Decl::Server { span, .. }
            | Decl::Provide { span, .. }
            | Decl::Context { span, .. } => *span,
        }
    }
    pub fn set_span(&mut self, to: Span) {
        match self {
            Decl::Source { span, .. }
            | Decl::Eq { span, .. }
            | Decl::Import { span, .. }
            | Decl::Error { span, .. }
            | Decl::TypeDecl { span, .. }
            | Decl::Effect { span, .. }
            | Decl::Fn { span, .. }
            | Decl::Component { span, .. }
            | Decl::Action { span, .. }
            | Decl::Server { span, .. }
            | Decl::Provide { span, .. }
            | Decl::Context { span, .. } => *span = to,
        }
    }
    /// The name a declaration binds (`"name" in d`): every kind but `import` and `effect`.
    pub fn name(&self) -> Option<&str> {
        match self {
            Decl::Source { name, .. }
            | Decl::Eq { name, .. }
            | Decl::Error { name, .. }
            | Decl::TypeDecl { name, .. }
            | Decl::Fn { name, .. }
            | Decl::Component { name, .. }
            | Decl::Action { name, .. }
            | Decl::Server { name, .. }
            | Decl::Provide { name, .. }
            | Decl::Context { name, .. } => Some(name),
            Decl::Import { .. } | Decl::Effect { .. } => None,
        }
    }
    pub fn exported(&self) -> bool {
        match self {
            Decl::Source { exported, .. }
            | Decl::Eq { exported, .. }
            | Decl::Error { exported, .. }
            | Decl::TypeDecl { exported, .. }
            | Decl::Fn { exported, .. }
            | Decl::Component { exported, .. }
            | Decl::Action { exported, .. }
            | Decl::Server { exported, .. }
            | Decl::Context { exported, .. } => *exported,
            _ => false,
        }
    }
    pub fn set_exported(&mut self) {
        match self {
            Decl::Source { exported, .. }
            | Decl::Eq { exported, .. }
            | Decl::Error { exported, .. }
            | Decl::TypeDecl { exported, .. }
            | Decl::Fn { exported, .. }
            | Decl::Component { exported, .. }
            | Decl::Action { exported, .. }
            | Decl::Server { exported, .. }
            | Decl::Context { exported, .. } => *exported = true,
            _ => {}
        }
    }
}

#[derive(Debug, Clone)]
pub struct Attr {
    pub name: String,
    pub e: Expr,
    /// the attribute's name
    pub span: Span,
}

#[derive(Debug, Clone)]
pub enum MarkupKind {
    El { tag: String, attrs: Vec<Attr>, children: Vec<Markup> },
    Read(Expr),
    Text(String),
    /// 07 §6b CSS-1
    Style(String),
    Mif { c: Expr, t: Vec<Markup>, t_decls: Vec<Decl>, f: Vec<Markup>, f_decls: Vec<Decl> },
    Mfor { name: String, xs: Expr, decls: Vec<Decl>, body: Vec<Markup> },
    /// H-5/H-6
    Loading { on: Option<Expr>, fallback: Vec<Markup>, decls: Vec<Decl>, body: Vec<Markup> },
    /// H-12, R-f-4
    Errored { fallback: Vec<Markup>, decls: Vec<Decl>, body: Vec<Markup>, err_name: Option<String>, classes: Option<Vec<String>> },
    /// RG-8
    Portal { to: Option<Expr>, decls: Vec<Decl>, body: Vec<Markup> },
}

#[derive(Debug, Clone)]
pub struct Markup {
    pub kind: MarkupKind,
    pub line: Option<usize>,
    pub span: Span,
}

#[derive(Debug, Clone)]
pub struct Program {
    pub decls: Vec<Decl>,
    pub view: Vec<Markup>,
    /// markup written at the top level (refused, TOP_LEVEL_MARKUP); `None` when the view is the default component's (MO-1c)
    pub legacy_view: Option<bool>,
}

// ---------------------------------------------------------------- JSON, as JSON.stringify writes the reference's AST

fn obj(pairs: Vec<(&str, Option<Value>)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        if let Some(v) = v {
            m.insert(k.to_string(), v);
        }
    }
    Value::Object(m)
}
fn s(x: &str) -> Option<Value> {
    Some(Value::String(x.to_string()))
}
fn os(x: &Option<String>) -> Option<Value> {
    x.as_ref().map(|x| Value::String(x.clone()))
}
fn strs(xs: &[String]) -> Value {
    Value::Array(xs.iter().map(|x| Value::String(x.clone())).collect())
}
fn ostrs(xs: &[Option<String>]) -> Value {
    Value::Array(xs.iter().map(|x| x.as_ref().map(|x| Value::String(x.clone())).unwrap_or(Value::Null)).collect())
}
fn flag(b: bool) -> Option<Value> {
    if b { Some(Value::Bool(true)) } else { None }
}
fn num(n: usize) -> Option<Value> {
    Some(json!(n))
}

pub fn lit_json(l: &Lit) -> Option<Value> {
    match l {
        Lit::Undefined => None,
        Lit::Null => Some(Value::Null),
        Lit::Bool(b) => Some(Value::Bool(*b)),
        Lit::Num(n) => Some(num_json(*n)),
        Lit::Str(x) => Some(Value::String(x.clone())),
    }
}
pub fn num_json(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { json!(n as i64) } else { json!(n) }
}

impl Expr {
    pub fn kind(&self) -> &'static str {
        match &self.k {
            ExprKind::Lit(_) => "lit",
            ExprKind::Id(_) => "id",
            ExprKind::Bin { .. } => "bin",
            ExprKind::Un { .. } => "un",
            ExprKind::Pre { .. } => "pre",
            ExprKind::Peek(_) => "peek",
            ExprKind::Await { .. } => "await",
            ExprKind::Latest(_) => "latest",
            ExprKind::Pending(_) => "pending",
            ExprKind::If { .. } => "if",
            ExprKind::Tpl(_) => "tpl",
            ExprKind::Member { .. } => "member",
            ExprKind::Index { .. } => "index",
            ExprKind::Call { .. } => "call",
            ExprKind::Arr(_) => "arr",
            ExprKind::Rec(_) => "rec",
            ExprKind::Fn { .. } => "fn",
            ExprKind::Draft { .. } => "draft",
            ExprKind::Use(_) => "use",
            ExprKind::Spread(_) => "spread",
            ExprKind::Throw(_) => "throw",
            ExprKind::Catch { .. } => "catch",
            ExprKind::StyleMap { .. } => "stylemap",
            ExprKind::ServerFn { .. } => "serverfn",
        }
    }
    pub fn to_json(&self) -> Value {
        let k = s(self.kind());
        let b = |e: &Expr| Some(e.to_json());
        let ob = |e: &Option<Box<Expr>>| e.as_ref().map(|e| e.to_json());
        match &self.k {
            ExprKind::Lit(l) => obj(vec![("k", k), ("v", lit_json(l))]),
            ExprKind::Id(n) => obj(vec![("k", k), ("name", s(n))]),
            ExprKind::Bin { op, l, r } => obj(vec![("k", k), ("op", s(op)), ("l", b(l)), ("r", b(r))]),
            ExprKind::Un { op, e } => obj(vec![("k", k), ("op", s(op)), ("e", b(e))]),
            ExprKind::Pre { name, init } => obj(vec![("k", k), ("name", s(name)), ("init", ob(init))]),
            ExprKind::Peek(e) | ExprKind::Latest(e) | ExprKind::Pending(e) | ExprKind::Spread(e) | ExprKind::Throw(e) => obj(vec![("k", k), ("e", b(e))]),
            ExprKind::Await { e, init, stream } => obj(vec![("k", k), ("e", b(e)), ("init", ob(init)), ("stream", Some(Value::Bool(*stream)))]),
            ExprKind::If { c, t, f } => obj(vec![("k", k), ("c", b(c)), ("t", b(t)), ("f", b(f))]),
            ExprKind::Tpl(parts) => obj(vec![
                ("k", k),
                ("parts", Some(Value::Array(parts.iter().map(|p| match p { TplPart::Str(x) => Value::String(x.clone()), TplPart::Expr(e) => e.to_json() }).collect()))),
            ]),
            ExprKind::Member { o, p, opt } => obj(vec![("k", k), ("o", b(o)), ("p", s(p)), ("opt", flag(*opt))]),
            ExprKind::Index { o, i, opt } => obj(vec![("k", k), ("o", b(o)), ("i", b(i)), ("opt", flag(*opt))]),
            ExprKind::Call { f, args } => obj(vec![("k", k), ("f", b(f)), ("args", Some(Value::Array(args.iter().map(|a| a.to_json()).collect())))]),
            ExprKind::Arr(items) => obj(vec![("k", k), ("items", Some(Value::Array(items.iter().map(|a| a.to_json()).collect())))]),
            ExprKind::Rec(fields) => obj(vec![
                ("k", k),
                (
                    "fields",
                    Some(Value::Array(
                        fields
                            .iter()
                            .map(|f| match f {
                                Field::Kv { key, v } => obj(vec![("key", s(key)), ("v", Some(v.to_json()))]),
                                Field::Spread(e) => obj(vec![("spread", Some(e.to_json()))]),
                            })
                            .collect(),
                    )),
                ),
            ]),
            ExprKind::Fn { params, body, stmts } => obj(vec![("k", k), ("params", Some(strs(params))), ("body", b(body)), ("stmts", stmts.as_ref().map(|ss| stmts_json(ss)))]),
            ExprKind::Draft { seed, body } => obj(vec![("k", k), ("seed", b(seed)), ("body", Some(stmts_json(body)))]),
            ExprKind::Use(n) => obj(vec![("k", k), ("name", s(n))]),
            ExprKind::Catch { e, name, classes, alt } => obj(vec![("k", k), ("e", b(e)), ("name", os(name)), ("classes", classes.as_ref().map(|c| strs(c))), ("alt", b(alt))]),
            ExprKind::StyleMap { css, line } => obj(vec![("k", k), ("css", s(css)), ("line", num(*line))]),
            ExprKind::ServerFn { params, ptypes, ret, body } => obj(vec![("k", k), ("params", Some(strs(params))), ("ptypes", Some(ostrs(ptypes))), ("ret", os(ret)), ("body", Some(stmts_json(body)))]),
        }
    }
}

pub fn stmts_json(ss: &[Stmt]) -> Value {
    Value::Array(ss.iter().map(|s| s.to_json()).collect())
}
fn target_json(t: &Target) -> Value {
    obj(vec![
        ("name", s(&t.name)),
        ("path", Some(Value::Array(t.path.iter().map(|p| match p { PathSeg::Name(n) => Value::String(n.clone()), PathSeg::Expr(e) => e.to_json() }).collect()))),
        ("ctx", t.ctx.map(Value::Bool)),
    ])
}
impl Stmt {
    pub fn to_json(&self) -> Value {
        let k = s(self.kind());
        match &self.k {
            StmtKind::Write { target, e } | StmtKind::Optimistic { target, e } => obj(vec![("k", k), ("target", Some(target_json(target))), ("e", Some(e.to_json()))]),
            StmtKind::Let { name, e, ty } => obj(vec![("k", k), ("name", s(name)), ("e", Some(e.to_json())), ("type", os(ty))]),
            StmtKind::Expr(e) | StmtKind::Throw(e) => obj(vec![("k", k), ("e", Some(e.to_json()))]),
            StmtKind::Refresh(n) | StmtKind::Affects(n) => obj(vec![("k", k), ("name", s(n))]),
            StmtKind::Action(body) => obj(vec![("k", k), ("body", Some(stmts_json(body)))]),
            StmtKind::Sif { c, t, f } => obj(vec![("k", k), ("c", Some(c.to_json())), ("t", Some(stmts_json(t))), ("f", Some(stmts_json(f)))]),
            StmtKind::Return(e) => obj(vec![("k", k), ("e", e.as_ref().map(|e| e.to_json()))]),
            StmtKind::Try { body, catch_name, catch_classes, handler, fin } => obj(vec![
                ("k", k),
                ("body", Some(stmts_json(body))),
                ("catchName", os(catch_name)),
                ("catchClasses", catch_classes.as_ref().map(|c| strs(c))),
                ("handler", handler.as_ref().map(|h| stmts_json(h))),
                ("fin", fin.as_ref().map(|h| stmts_json(h))),
            ]),
        }
    }
}

pub fn decls_json(ds: &[Decl]) -> Value {
    Value::Array(ds.iter().map(|d| d.to_json()).collect())
}
pub fn markups_json(ms: &[Markup]) -> Value {
    Value::Array(ms.iter().map(|m| m.to_json()).collect())
}
impl Decl {
    pub fn to_json(&self) -> Value {
        match self {
            Decl::Source { name, init, line, question, ty, exported, key, .. } => obj(vec![
                ("k", s("source")),
                ("name", s(name)),
                ("init", Some(init.to_json())),
                ("line", num(*line)),
                ("question", flag(*question)),
                ("type", os(ty)),
                ("key", os(key)),
                ("exported", flag(*exported)),
            ]),
            Decl::Eq { name, e, line, deferred, key, ty, exported, .. } => obj(vec![
                ("k", s("eq")),
                ("name", s(name)),
                ("e", Some(e.to_json())),
                ("line", num(*line)),
                ("deferred", flag(*deferred)),
                ("key", os(key)),
                ("type", os(ty)),
                ("exported", flag(*exported)),
            ]),
            Decl::Import { names, from, pure, side, line, fails, resolved, declared, declared_errors, declared_pure, declared_side, .. } => obj(vec![
                ("k", s("import")),
                ("names", Some(Value::Array(names.iter().map(|n| obj(vec![("name", s(&n.name)), ("alias", s(&n.alias))])).collect()))),
                ("from", s(from)),
                ("pure", Some(Value::Bool(*pure))),
                ("line", num(*line)),
                ("fails", fails.as_ref().map(|f| strs(f))),
                ("side", side.map(|x| Value::String(x.as_str().into()))),
                ("resolved", os(resolved)),
                ("declared", os(declared)),
                ("declaredErrors", declared_errors.as_ref().map(|f| strs(f))),
                ("declaredPure", declared_pure.as_ref().map(|f| strs(f))),
                (
                    "declaredSide",
                    declared_side.as_ref().map(|xs| {
                        let mut m = Map::new();
                        for (n, sd) in xs {
                            m.insert(n.clone(), Value::String(sd.as_str().into()));
                        }
                        Value::Object(m)
                    }),
                ),
            ]),
            Decl::Error { name, params, ptypes, msg, line, exported, .. } => obj(vec![
                ("k", s("error")),
                ("name", s(name)),
                ("params", Some(strs(params))),
                ("ptypes", Some(ostrs(ptypes))),
                ("msg", msg.as_ref().map(|m| m.to_json())),
                ("line", num(*line)),
                ("exported", flag(*exported)),
            ]),
            Decl::TypeDecl { name, line, text, exported, .. } => obj(vec![("k", s("typedecl")), ("name", s(name)), ("line", num(*line)), ("text", s(text)), ("exported", flag(*exported))]),
            Decl::Effect { inputs, body, line, .. } => obj(vec![("k", s("effect")), ("inputs", Some(Value::Array(inputs.iter().map(|e| e.to_json()).collect()))), ("body", Some(stmts_json(body))), ("line", num(*line))]),
            Decl::Fn { name, params, decls, tail, line, ret, exported, .. } => obj(vec![
                ("k", s("fn")),
                ("name", s(name)),
                ("params", Some(Value::Array(params.iter().map(|p| obj(vec![("name", s(&p.name)), ("ref", Some(Value::Bool(p.r#ref))), ("type", os(&p.ty))])).collect()))),
                ("decls", Some(decls_json(decls))),
                ("tail", Some(tail.to_json())),
                ("line", num(*line)),
                ("ret", os(ret)),
                ("exported", flag(*exported)),
            ]),
            Decl::Component { name, props, decls, view, line, props_type, exported, is_default, .. } => obj(vec![
                ("k", s("component")),
                ("name", s(name)),
                ("props", s(props)),
                ("decls", Some(decls_json(decls))),
                ("view", Some(markups_json(view))),
                ("line", num(*line)),
                ("propsType", os(props_type)),
                ("exported", flag(*exported)),
                ("isDefault", flag(*is_default)),
            ]),
            Decl::Action { name, params, ptypes, body, line, exported, .. } => obj(vec![
                ("k", s("action")),
                ("name", s(name)),
                ("params", Some(strs(params))),
                ("ptypes", Some(ostrs(ptypes))),
                ("body", Some(stmts_json(body))),
                ("line", num(*line)),
                ("exported", flag(*exported)),
            ]),
            Decl::Server { name, params, ptypes, ret, body, line, exported, .. } => obj(vec![
                ("k", s("server")),
                ("name", s(name)),
                ("params", Some(strs(params))),
                ("ptypes", Some(ostrs(ptypes))),
                ("ret", os(ret)),
                ("body", Some(stmts_json(body))),
                ("line", num(*line)),
                ("exported", flag(*exported)),
            ]),
            Decl::Provide { name, e, line, .. } => obj(vec![("k", s("provide")), ("name", s(name)), ("e", Some(e.to_json())), ("line", num(*line))]),
            Decl::Context { name, ty, source, dflt, line, exported, .. } => obj(vec![
                ("k", s("context")),
                ("name", s(name)),
                ("type", os(ty)),
                ("source", Some(Value::Bool(*source))),
                ("dflt", dflt.as_ref().map(|e| e.to_json())),
                ("line", num(*line)),
                ("exported", flag(*exported)),
            ]),
        }
    }
}

impl Markup {
    pub fn to_json(&self) -> Value {
        let line = self.line.map(|l| json!(l));
        let ms = |x: &Vec<Markup>| Some(markups_json(x));
        let ds = |x: &Vec<Decl>| Some(decls_json(x));
        match &self.kind {
            MarkupKind::El { tag, attrs, children } => obj(vec![
                ("k", s("el")),
                ("tag", s(tag)),
                ("attrs", Some(Value::Array(attrs.iter().map(|a| obj(vec![("name", s(&a.name)), ("e", Some(a.e.to_json()))])).collect()))),
                ("children", ms(children)),
                ("line", line),
            ]),
            MarkupKind::Read(e) => obj(vec![("k", s("read")), ("e", Some(e.to_json())), ("line", line)]),
            MarkupKind::Text(x) => obj(vec![("k", s("text")), ("s", s(x)), ("line", line)]),
            MarkupKind::Style(css) => obj(vec![("k", s("style")), ("css", s(css)), ("line", line)]),
            MarkupKind::Mif { c, t, t_decls, f, f_decls } => obj(vec![("k", s("mif")), ("c", Some(c.to_json())), ("t", ms(t)), ("tDecls", ds(t_decls)), ("f", ms(f)), ("fDecls", ds(f_decls)), ("line", line)]),
            MarkupKind::Mfor { name, xs, decls, body } => obj(vec![("k", s("mfor")), ("name", s(name)), ("xs", Some(xs.to_json())), ("decls", ds(decls)), ("body", ms(body)), ("line", line)]),
            MarkupKind::Loading { on, fallback, decls, body } => obj(vec![("k", s("loading")), ("on", on.as_ref().map(|e| e.to_json())), ("fallback", ms(fallback)), ("decls", ds(decls)), ("body", ms(body)), ("line", line)]),
            MarkupKind::Errored { fallback, decls, body, err_name, classes } => obj(vec![
                ("k", s("errored")),
                ("fallback", ms(fallback)),
                ("decls", ds(decls)),
                ("body", ms(body)),
                ("errName", os(err_name)),
                ("classes", classes.as_ref().map(|c| strs(c))),
                ("line", line),
            ]),
            MarkupKind::Portal { to, decls, body } => obj(vec![("k", s("portal")), ("to", to.as_ref().map(|e| e.to_json())), ("decls", ds(decls)), ("body", ms(body)), ("line", line)]),
        }
    }
}

impl Program {
    pub fn to_json(&self) -> Value {
        obj(vec![("decls", Some(decls_json(&self.decls))), ("view", Some(markups_json(&self.view))), ("legacyView", self.legacy_view.map(Value::Bool))])
    }
}
