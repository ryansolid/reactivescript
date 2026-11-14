//! The code generator (spec/11 CP-1a, a port of `ref/compile/emit.ts`): a checked program → one JavaScript module per `.rx`
//! module (MO-1), the reactive lowering as `__rt` calls (CP-4b), the views as JSX, which Solid's compiler then lowers for the
//! target (`lower_views`, CP-1b). Lexical scopes become JS scopes: every region is a JS function, every declaration a
//! `const`. Names are mangled (`v$x` the value or accessor, `w$x` a source's writer, `p$x` a companion `pre` memo). The
//! module is a tree (`js.rs`), never text (CP-3).

use crate::ast::{Decl, Expr, ExprKind, Lit, Markup, MarkupKind, PathSeg, Program, Stmt, StmtKind};
use crate::awaits::{is_handler, non_tail_awaits, view_readers};
use crate::check::{children, unwrap_server, Node};
use crate::js::*;
use crate::modules::ModuleSet;
use crate::parse::{JsDecl, Part, Shape as FShape};
use crate::signature::ExportSig;
use indexmap::{IndexMap, IndexSet};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
pub struct CompileError(pub String);
type R<T> = Result<T, CompileError>;
fn fail<T>(msg: impl Into<String>) -> R<T> {
    Err(CompileError(msg.into()))
}

const BUILTINS: &[&str] = &["len", "str", "map", "filter", "sum", "fail", "fetch", "every", "indexOf"];
fn builtin(n: &str) -> bool {
    BUILTINS.contains(&n)
}
const VOID_TAGS: &[&str] = &["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"];
fn mg(n: &str) -> String {
    format!("v${n}")
}
/// a component: an uppercase JSX tag
fn cm(n: &str) -> String {
    format!("V${n}")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Acc,
    Src,
    Val,
    Fn,
    Ifn,
    /// MO-10: a declared JS primitive
    Jfn,
    Act,
    Comp,
}
#[derive(Clone)]
struct FnRef {
    params: Vec<(String, bool)>,
    decl: Option<*const Decl>,
}
#[derive(Clone)]
struct Bind {
    kind: Kind,
    js: String,
    w: Option<String>,
    f: Option<FnRef>,
    prev: Option<String>,
    /// `client` JS (12 SF-5b)
    client: bool,
    /// MO-10: a primitive's result (Jfn), or an instance's (with `inst`, the name of its raw result)
    shape: Option<FShape>,
    inst: Option<String>,
}
fn bind(kind: Kind, js: impl Into<String>) -> Bind {
    Bind { kind, js: js.into(), w: None, f: None, prev: None, client: false, shape: None, inst: None }
}
fn val(js: impl Into<String>) -> Bind {
    bind(Kind::Val, js)
}

struct Frame {
    vars: IndexMap<String, Bind>,
    parent: Option<usize>,
}
type Env = usize;

#[derive(Clone, Default)]
struct Ctx {
    imp: bool,
    gen: bool,
    is_async: bool,
    tail: bool,
    self_: Option<String>,
    effect: bool,
    dynamic: bool,
}
fn reactive() -> Ctx {
    Ctx::default()
}

// ---------------------------------------------------------------- usage analysis (the oracle's walkers, at compile time)
#[derive(Default)]
struct Usage {
    optimistic: HashSet<String>,
    paths: HashSet<String>,
    prev_of: HashSet<String>,
}
fn usage(programs: &[&Program], extra: &[Vec<Stmt>]) -> Usage {
    let mut u = Usage::default();
    fn walk(x: &Value, self_name: Option<&str>, u: &mut Usage) {
        match x {
            Value::Array(xs) => xs.iter().for_each(|y| walk(y, self_name, u)),
            Value::Object(o) => {
                let k = o.get("k").and_then(Value::as_str);
                let target = o.get("target");
                let tname = || target.and_then(|t| t["name"].as_str()).unwrap_or_default().to_string();
                if k == Some("optimistic") {
                    u.optimistic.insert(tname());
                }
                if matches!(k, Some("write" | "optimistic")) && target.and_then(|t| t["path"].as_array()).is_some_and(|p| !p.is_empty()) {
                    u.paths.insert(tname());
                }
                if k == Some("pending") && matches!(o["e"]["k"].as_str(), Some("member" | "index")) {
                    let mut y = &o["e"];
                    while matches!(y["k"].as_str(), Some("member" | "index")) {
                        y = &y["o"];
                    }
                    if y["k"] == "id" {
                        u.paths.insert(y["name"].as_str().unwrap().to_string());
                    }
                }
                if k == Some("pre") && o["name"].as_str() != self_name {
                    u.prev_of.insert(o["name"].as_str().unwrap().to_string());
                }
                let next = if matches!(k, Some("eq" | "source")) { o["name"].as_str() } else { self_name };
                for v in o.values() {
                    walk(v, next, u);
                }
            }
            _ => {}
        }
    }
    for p in programs {
        walk(&p.to_json(), None, &mut u);
    }
    for ss in extra {
        walk(&Value::Array(ss.iter().map(|s| s.to_json()).collect()), None, &mut u);
    }
    u
}
/// Free names of an expression, for ordering declarations (JS consts have a temporal dead zone; memos compute eagerly).
fn deps(e: &Value, self_name: &str, out: &mut IndexSet<String>) {
    match e {
        Value::Array(xs) => xs.iter().for_each(|x| deps(x, self_name, out)),
        Value::Object(o) => {
            let k = o.get("k").and_then(Value::as_str);
            if k == Some("id") {
                out.insert(o["name"].as_str().unwrap().to_string());
            }
            if k == Some("pre") && o["name"].as_str() != Some(self_name) {
                out.insert(o["name"].as_str().unwrap().to_string());
            }
            if matches!(k, Some("write" | "optimistic")) {
                out.insert(o["target"]["name"].as_str().unwrap().to_string());
            }
            for (key, v) in o {
                if key != "k" {
                    deps(v, self_name, out);
                }
            }
        }
        _ => {}
    }
}
fn has_await_json(v: &Value) -> bool {
    serde_json::to_string(v).unwrap().contains("\"k\":\"await\"")
}

// ---------------------------------------------------------------- the modules

/// One ES module per `.rx` module (MO-1), before Solid's compiler lowers its views.
pub struct Compiled {
    pub files: IndexMap<String, Vec<S>>,
    /// each module's `.rx` path
    pub paths: IndexMap<String, String>,
    pub entry: String,
    /// CSS-4: the modules' stylesheets, beside their JavaScript
    pub css: String,
    /// CSS-4: each module's own stylesheet, by its output name
    pub module_css: IndexMap<String, String>,
}

/// 09 MO-1: one ES module per `.rx` module. A dependency's module is a factory over the app (`__rt.module` runs it once per
/// app, the first time an importer instantiates — inside the mounted root, so its state is owned there); the entry's is
/// `main`. `extra`: statements the program does not hold that run against it (a scenario's handler rows), for usage only.
pub fn compile_modules(set: &ModuleSet, extra: &[Vec<Stmt>]) -> R<Compiled> {
    compile_linked(set, extra, false)
}

/// `compile_modules`, with each module importing its dependencies by their `.rx` paths (relative to the importer) when
/// `by_source`, as a bundler resolves them, rather than as the sibling `.mjs` files `compile_modules` names.
pub fn compile_linked(set: &ModuleSet, extra: &[Vec<Stmt>], by_source: bool) -> R<Compiled> {
    let programs: Vec<&Program> = set.order.iter().map(|p| &set.programs[p]).collect();
    let mut g = Gen::new(usage(&programs, extra), set);
    g.by_source = by_source;
    let mut files = IndexMap::new();
    let mut paths = IndexMap::new();
    let mut module_css = IndexMap::new();
    for path in &set.order {
        let p = &set.programs[path];
        let css0 = g.css.len();
        g.begin_module(path, &p.decls);
        let mut deps: Vec<&str> = vec![];
        for d in &p.decls {
            if let Decl::Import { resolved: Some(r), .. } = d {
                if !deps.contains(&r.as_str()) {
                    deps.push(r);
                }
            }
        }
        let mut body: Vec<S> = deps.iter().map(|d| S::ImportDefault(g.dep_var(d), if by_source { relative(path, d) } else { format!("./{}", g.out(d)) })).collect();
        if *path == set.entry {
            let root = g.new_env(None);
            let inner = g.block(&p.decls, &p.view, root, None, true)?;
            body.append(&mut g.top);
            body.push(S::ExportDefault(Func {
                name: Some("main".into()),
                params: vec![P::Id("__rt".into())],
                directives: vec![],
                body: vec![konst("__B", dot(id("__rt"), "B")), S::Return(Some(arrow_block(vec![], inner, false)))],
                is_async: false,
                generator: false,
            }));
        } else {
            let exported: Vec<&str> = p.decls.iter().filter(|d| d.exported() && !matches!(d, Decl::TypeDecl { .. })).filter_map(|d| d.name()).collect();
            let is_comp = |n: &str| p.decls.iter().any(|d| matches!(d, Decl::Component { name, .. } if name == n));
            let tail = E::Obj(exported.iter().map(|n| Prop::Kv(Key::Str(n.to_string()), id(if is_comp(n) { cm(n) } else { mg(n) }))).collect());
            let root = g.new_env(None);
            let mut inner = g.block(&p.decls, &[], root, Some(tail), false)?;
            body.append(&mut g.top);
            let mut fbody = vec![konst("__B", dot(id("__rt"), "B"))];
            fbody.append(&mut inner);
            body.push(S::ExportDefault(Func { name: Some("module".into()), params: vec![P::Id("__rt".into())], directives: vec![], body: fbody, is_async: false, generator: false }));
        }
        module_css.insert(g.out(path), g.css[css0..].join("\n"));
        files.insert(g.out(path), body);
        paths.insert(g.out(path), path.clone());
    }
    Ok(Compiled { files, paths, entry: g.out(&set.entry), css: g.css.join("\n"), module_css })
}

struct Gen<'p> {
    u: Usage,
    set: &'p ModuleSet,
    file: String,
    /// Modules imported by source path, for a bundler (`compile_linked`), not as sibling `.mjs` files.
    by_source: bool,
    css: Vec<String>,
    /// module-level code: hoisted server functions and the module's error classes
    top: Vec<S>,
    top_fns: HashSet<String>,
    /// a module-level server fn → its hoisted function
    server_names: IndexMap<String, String>,
    mod_decls: &'p [Decl],
    sf_seq: usize,
    /// CSS-2: the scope class of the view being emitted
    style_hash: Option<String>,
    hoisted: HashMap<*const Expr, String>,
    hoist_seq: usize,
    frames: Vec<Frame>,
    style_ids: u32,
}

/// MO-10: the scenario prelude's `./prims`, a JS module of Solid primitives (`ref/compile/prims-solid.ts`).
fn is_prims(from: &str) -> bool {
    from == "prims" || from == "prims.js" || from.ends_with("/prims") || from.ends_with("/prims.js")
}

impl<'p> Gen<'p> {
    /// A JS import that becomes a real ES import (MO-8): a package's always; a relative one too when the modules go to a
    /// bundler (`by_source`, the product), where `./util.js` is the app's own file. `./api` stays the app's injected API
    /// (`createApp({ api })`, CP-4), and in the scenario runners every relative import is the harness's.
    fn js_import(&self, from: &str) -> bool {
        !from.starts_with('.') || (self.by_source && !from.ends_with("/api"))
    }
    fn new(u: Usage, set: &'p ModuleSet) -> Self {
        Gen {
            u,
            set,
            file: "main.rx".into(),
            by_source: false,
            css: vec![],
            top: vec![],
            top_fns: HashSet::new(),
            server_names: IndexMap::new(),
            mod_decls: &[],
            sf_seq: 0,
            style_hash: None,
            hoisted: HashMap::new(),
            hoist_seq: 0,
            frames: vec![],
            style_ids: 0,
        }
    }
    // ---- environments
    fn new_env(&mut self, parent: Option<Env>) -> Env {
        self.frames.push(Frame { vars: IndexMap::new(), parent });
        self.frames.len() - 1
    }
    fn set(&mut self, env: Env, n: &str, b: Bind) {
        self.frames[env].vars.insert(n.to_string(), b);
    }
    fn lookup(&self, env: Env, n: &str) -> Option<Bind> {
        let mut e = Some(env);
        while let Some(i) = e {
            if let Some(b) = self.frames[i].vars.get(n) {
                return Some(b.clone());
            }
            e = self.frames[i].parent;
        }
        None
    }
    fn params(&mut self, env: Env, ps: &[String]) -> Env {
        let e = self.new_env(Some(env));
        for p in ps {
            self.set(e, p, val(mg(p)));
        }
        e
    }

    // ---- modules
    fn out(&self, path: &str) -> String {
        if path == self.set.entry {
            "main.mjs".into()
        } else if let Some(i) = self.set.order.iter().position(|p| p == path) {
            format!("m{i}.mjs")
        } else {
            let base = path.rsplit('/').next().unwrap();
            format!("{}.mjs", base.strip_suffix(".rx").unwrap_or(base))
        }
    }
    fn mod_index(&self, path: &str) -> i64 {
        self.set.order.iter().chain(self.set.signatures.keys()).position(|p| p == path).map(|i| i as i64).unwrap_or(-1)
    }
    fn dep_var(&self, path: &str) -> String {
        format!("__m{}", self.mod_index(path))
    }
    /// Begin a module: what a hoisted server function may name at module level (SF-3: imports, error classes, server fns).
    fn begin_module(&mut self, path: &str, decls: &'p [Decl]) {
        self.file = path.to_string();
        self.top = vec![];
        self.top_fns = HashSet::new();
        self.mod_decls = decls;
        self.server_names = IndexMap::new();
        for d in decls {
            match d {
                Decl::Server { name, .. } => {
                    self.server_names.insert(name.clone(), format!("sf${name}"));
                }
                Decl::Eq { name, e, .. } if unwrap_server(e).is_some() => {
                    self.server_names.insert(name.clone(), format!("sf${name}"));
                }
                _ => {}
            }
        }
        // a package's JS (`@solidjs/web/server-functions`): a real import at module level, where a hoisted server fn's wrappers are
        for d in decls {
            if let Decl::Import { resolved: None, from, names, .. } = d {
                if !self.js_import(from) {
                    continue;
                }
                let ns: Vec<(String, String)> = names.iter().filter(|n| !builtin(&n.name) && n.name != "log").map(|n| (n.name.clone(), format!("w${}", n.alias))).collect();
                if !ns.is_empty() {
                    self.top.push(S::ImportNamed(ns, from.clone()));
                }
            }
        }
    }
    /// SF-1d: a wrapped server fn — the wrapper calls kept around it at module level, where Solid's directive pass finds it.
    fn server_wrapped(&mut self, name: &str, e: &Expr) -> R<String> {
        // a server fn below module level has no hoisted name: the reference writes `const undefined = …` (and reads it back)
        let f = self.server_names.get(name).cloned().unwrap_or("undefined".into());
        let v = self.chain(name, e)?;
        self.top.push(konst(f.clone(), v));
        Ok(f)
    }
    fn chain(&mut self, name: &str, x: &Expr) -> R<E> {
        match &x.k {
            ExprKind::ServerFn { params, body, .. } => self.server_hoist(name, params, body, true),
            ExprKind::Call { f, args } if matches!(&f.k, ExprKind::Id(_)) => {
                let ExprKind::Id(fname) = &f.k else { unreachable!() };
                let found = self.mod_decls.iter().any(|d| matches!(d, Decl::Import { resolved: None, from, names, .. } if self.js_import(from) && names.iter().any(|n| &n.alias == fname)));
                if !found {
                    return fail(format!("{name}: a server fn's wrapper is a package's function (here, {fname})"));
                }
                let mut out = vec![];
                for a in args {
                    out.push(if unwrap_server(a).is_some() {
                        self.chain(name, a)?
                    } else if let ExprKind::Lit(l) = &a.k {
                        lit(l)
                    } else {
                        return fail(format!("{name}: a wrapper's other arguments are literals"));
                    });
                }
                Ok(call(id(format!("w${fname}")), out))
            }
            _ => fail(format!("{name}: not a wrapped server fn")),
        }
    }
    /// 12 SF-7a: a server fn as Solid's `"use server"` function at module level — it may name only its parameters, its locals
    /// and module-level bindings, which SF-3 makes always possible: every name a body may use is a module-level import, error
    /// class or server fn, bound here from the calling app.
    fn server_hoist(&mut self, name: &str, params: &[String], body: &[Stmt], expression: bool) -> R<E> {
        let f = match self.server_names.get(name) {
            Some(f) if !expression && !self.top_fns.contains(f) => f.clone(),
            _ => {
                let f = format!("sf${name}${}", self.sf_seq);
                self.sf_seq += 1;
                f
            }
        };
        let env = self.new_env(None);
        let mut pre: Vec<S> = vec![];
        let decls = self.mod_decls;
        for x in decls {
            match x {
                Decl::Import { resolved: None, names, from, declared_errors, .. } => {
                    for n in names {
                        if n.name == "log" || builtin(&n.name) {
                            continue;
                        }
                        if self.js_import(from) {
                            self.set(env, &n.alias, val(format!("w${}", n.alias)));
                            continue;
                        }
                        self.set(env, &n.alias, val(mg(&n.alias)));
                        let v = if declared_errors.as_ref().is_some_and(|e| e.contains(&n.name)) { "jsError" } else { "api" };
                        pre.push(konst(mg(&n.alias), rtc(v, vec![str(n.name.clone())])));
                    }
                }
                Decl::Error { name, .. } => {
                    self.set(env, name, val(mg(name)));
                    pre.push(konst(mg(name), call(id(format!("g${name}")), vec![id("__rt")])));
                }
                Decl::Server { name, .. } => {
                    let js = self.server_names[name].clone();
                    self.set(env, name, val(js));
                }
                Decl::Eq { name, e, .. } if unwrap_server(e).is_some() => {
                    let js = self.server_names[name].clone();
                    self.set(env, name, val(js));
                }
                // a value fn (SF-3: it reads nothing reactive)
                Decl::Fn { name, params, decls: ds, .. } if !params.iter().any(|p| p.r#ref) && ds.is_empty() => {
                    let mut b = bind(Kind::Fn, mg(name));
                    b.f = Some(FnRef { params: params.iter().map(|p| (p.name.clone(), p.r#ref)).collect(), decl: Some(x as *const Decl) });
                    self.set(env, name, b);
                }
                _ => {}
            }
        }
        // declared again inside: the body is extracted with it (found by S-app-notes)
        for x in decls {
            if let Decl::Fn { name, .. } = x {
                if self.frames[env].vars.get(name).and_then(|b| b.f.as_ref()).and_then(|f| f.decl) == Some(x as *const Decl) {
                    pre.push(self.fn_decl(x, env)?);
                }
            }
        }
        let penv = self.params(env, params);
        let body = self.stmts(body, penv, &Ctx { imp: true, gen: true, ..Ctx::default() }, false)?;
        let mut fbody = vec![konst("__rt", dot(id("globalThis"), "__rx_app")), konst("__B", dot(id("__rt"), "B"))];
        fbody.extend(pre);
        fbody.push(S::Return(Some(rtc(
            "serverCall",
            vec![
                str(name),
                E::Func(Box::new(Func { name: None, params: params.iter().map(|p| P::Id(mg(p))).collect(), directives: vec![], body, is_async: false, generator: true })),
                id("__a"),
            ],
        ))));
        let func = Func { name: Some(f.clone()), params: vec![P::Rest("__a".into())], directives: vec!["use server".into()], body: fbody, is_async: true, generator: false };
        if expression {
            return Ok(E::Func(Box::new(func)));
        }
        self.top_fns.insert(f.clone());
        self.top.push(S::Func(func));
        Ok(id(f))
    }

    // ---- blocks: a region's declarations, then its view
    fn block(&mut self, decls: &[Decl], view: &[Markup], env: Env, exports_tail: Option<E>, style_root: bool) -> R<Vec<S>> {
        let prev = self.style_hash.clone();
        if style_root {
            // a component's view (or the program's) has its own scope; a branch keeps its view's
            self.style_hash = self.style(view)?;
        }
        let r = self.block0(decls, view, env, exports_tail);
        self.style_hash = prev;
        r
    }
    fn tsrx_file(&self) -> String {
        self.file.strip_suffix(".rx").unwrap_or(&self.file).to_string()
    }
    /// 07 CSS-5: a style expression through TSRX's engine — its class map literal; its stylesheet joins the module's.
    fn class_map(&mut self, css: &str, line: usize) -> R<E> {
        use solidjs_compiler::style::*;
        let filename = format!("{}.{line}.tsrx", self.tsrx_file());
        // `export const __s = <style>…`: the element the reference compiles starts at line 1, column 19
        let r = compile_style(StyleInput { css, location: StyleLocation { filename: &filename, line: 1, column: 19 }, elements: &[], kind: StyleKind::Expression, minify: false })
            .map_err(|e| CompileError(format!("<style> (line {line}): {}", e.message)))?;
        if !r.css.is_empty() {
            self.css.push(r.css);
        }
        let map = E::Obj(r.class_map.into_iter().map(|c| Prop::Kv(Key::Str(c.class_name), str(c.value))).collect());
        Ok(call(dot(id("Object"), "freeze"), vec![map]))
    }
    /// 07 §6b: a view's <style> through TSRX's engine (Solid's compiler): the view's elements as TSRX sees the fragment the
    /// reference compiles — HTML elements with their static attributes, components with the children passed to them, and
    /// every region (a branch, a loop body, a boundary) as an expression TSRX matches conservatively, as it does its own
    /// control flow. Its scoped stylesheet joins the module's; its hash is the view's scope class.
    fn style(&mut self, view: &[Markup]) -> R<Option<String>> {
        use solidjs_compiler::style::*;
        let Some((css, line)) = view.iter().find_map(|m| if let MarkupKind::Style(css) = &m.kind { Some((css.clone(), m.line)) } else { None }) else { return Ok(None) };
        // what the fragment's markup contributes: at the root a container is transparent; inside an element it is a
        // `Dynamic` child followed by what it holds
        enum Item {
            El(Element),
            Container(Vec<Item>),
        }
        fn tree(g: &mut Gen, ms: &[Markup]) -> Vec<Item> {
            let mut out = vec![];
            for m in ms {
                match &m.kind {
                    MarkupKind::Text(_) | MarkupKind::Style(_) | MarkupKind::Portal { .. } => {}
                    MarkupKind::Read(_) => out.push(Item::Container(vec![])),
                    MarkupKind::El { tag, attrs, children } if tag.is_empty() => out.extend(tree(g, children)),
                    MarkupKind::El { tag, attrs, children } => {
                        g.style_ids += 1;
                        let kind = if tag.as_bytes()[0].is_ascii_lowercase() { ElementKind::Native(tag.clone()) } else { ElementKind::Component };
                        let attributes = attrs
                            .iter()
                            .filter(|a| !is_handler(&a.name) && a.name != "...")
                            .map(|a| Attribute {
                                name: a.name.clone(),
                                value: match &a.e.k {
                                    ExprKind::Lit(Lit::Str(s)) => Some(AttributeValue::Static(s.clone())),
                                    ExprKind::Lit(Lit::Bool(true)) => None,
                                    _ => Some(AttributeValue::Dynamic),
                                },
                            })
                            .collect();
                        let kids = flatten(tree(g, children));
                        out.push(Item::El(Element { id: g.style_ids, kind, attributes, has_spread: attrs.iter().any(|a| a.name == "..."), children: kids }));
                    }
                    MarkupKind::Mif { t, f, .. } => {
                        out.push(Item::Container(tree(g, t)));
                        out.push(Item::Container(tree(g, f)));
                    }
                    MarkupKind::Mfor { body, .. } => out.push(Item::Container(tree(g, body))),
                    MarkupKind::Loading { fallback, body, .. } | MarkupKind::Errored { fallback, body, .. } => {
                        out.push(Item::Container(tree(g, fallback)));
                        out.push(Item::Container(tree(g, body)));
                    }
                }
            }
            out
        }
        fn flatten(items: Vec<Item>) -> Vec<ElementChild> {
            let mut out = vec![];
            for i in items {
                match i {
                    Item::El(e) => out.push(ElementChild::Element(e)),
                    Item::Container(xs) => {
                        out.push(ElementChild::Dynamic);
                        out.extend(flatten(xs));
                    }
                }
            }
            out
        }
        fn roots(items: Vec<Item>, out: &mut Vec<Element>) {
            for i in items {
                match i {
                    Item::El(e) => out.push(e),
                    Item::Container(xs) => roots(xs, out),
                }
            }
        }
        let items = tree(self, view);
        let mut elements = vec![];
        roots(items, &mut elements);
        let filename = format!("{}.tsrx", self.tsrx_file());
        // `export const __view = () => <><style>…`: the element starts at line 1, column 30
        let r = compile_style(StyleInput { css: &css, location: StyleLocation { filename: &filename, line: 1, column: 30 }, elements: &elements, kind: StyleKind::Block, minify: false })
            .map_err(|e| CompileError(format!("<style> (line {}): {}", line.map(|l| l.to_string()).unwrap_or("?".into()), e.message)))?;
        self.css.push(r.css);
        Ok(Some(r.hash))
    }

    fn block0(&mut self, decls: &[Decl], view: &[Markup], env: Env, exports_tail: Option<E>) -> R<Vec<S>> {
        let mut out: Vec<S> = vec![konst("__o", rtc("owner", vec![]))];
        // MO-1: each .rx dependency instantiated (once per app), its exports bound by name
        let mut instantiated: HashSet<String> = HashSet::new();
        for d in decls {
            let Decl::Import { resolved: Some(r), names, .. } = d else { continue };
            let n0 = out.len();
            let iv = format!("__i{}", self.mod_index(r));
            if instantiated.insert(iv.clone()) {
                // MO-1b: once per app. A bundler's module is one factory function wherever it is imported from, so by source the
                // factory is its own key: a module shared by two programs gets the same key in both (11 CP-7).
                let key = if self.by_source { id(self.dep_var(r)) } else { str(self.out(r)) };
                out.push(konst(iv.clone(), rtc("module", vec![key, id(self.dep_var(r))])));
            }
            for n in names {
                let is_type = self.set.programs.get(r).is_some_and(|p| p.decls.iter().any(|x| matches!(x, Decl::TypeDecl { name, .. } if *name == n.name)))
                    || self.set.signatures.get(r).and_then(|s| s.exports.get(&n.name)).is_some_and(|x| matches!(x, ExportSig::Type));
                if is_type {
                    continue; // a type binds nothing
                }
                let ib = self.import_bind(r, &n.name, &n.alias);
                let js = ib.js.clone();
                self.set(env, &n.alias, ib);
                out.push(konst(js, E::Index(Box::new(id(iv.clone())), Box::new(str(n.name.clone())), false)));
            }
            at(&mut out, n0, d.line());
        }
        // names first: hoisted functions and components; every other declaration is a const
        for d in decls {
            match d {
                Decl::Import { resolved: Some(_), .. } => {}
                Decl::Import { names, side, declared_side, declared, .. } => {
                    for n in names {
                        // MO-10a: a declared primitive
                        let x = declared.as_ref().and_then(|dp| self.set.declarations.get(dp)).and_then(|ds| ds.iter().find(|y| y.name() == n.name));
                        if let Some(JsDecl::Fn { params, refs, shape, instantiates: true, .. }) = x {
                            let mut b = bind(Kind::Jfn, mg(&n.alias));
                            b.f = Some(FnRef { params: params.iter().enumerate().map(|(i, p)| (p.clone(), refs.get(i).copied().unwrap_or(false))).collect(), decl: None });
                            b.shape = Some(shape.clone());
                            self.set(env, &n.alias, b);
                            continue;
                        }
                        let mut b = val(mg(&n.alias));
                        b.client = *side == Some(crate::ast::Side::Client)
                            || declared_side.as_ref().is_some_and(|ds| ds.iter().any(|(k, s)| *k == n.name && *s == crate::ast::Side::Client));
                        self.set(env, &n.alias, b);
                    }
                }
                Decl::Fn { name, params, decls: ds, .. } => {
                    let mut b = bind(if params.iter().any(|p| p.r#ref) || !ds.is_empty() { Kind::Ifn } else { Kind::Fn }, mg(name));
                    b.f = Some(FnRef { params: params.iter().map(|p| (p.name.clone(), p.r#ref)).collect(), decl: Some(d as *const Decl) });
                    self.set(env, name, b);
                }
                Decl::Component { name, .. } => self.set(env, name, bind(Kind::Comp, cm(name))),
                Decl::Action { name, .. } => self.set(env, name, bind(Kind::Act, mg(name))),
                Decl::Server { name, .. } | Decl::Error { name, .. } | Decl::Context { name, .. } => self.set(env, name, val(mg(name))),
                Decl::Source { name, .. } => {
                    let mut b = bind(Kind::Src, mg(name));
                    b.w = Some(format!("w${name}"));
                    b.prev = self.u.prev_of.contains(name).then(|| format!("p${name}"));
                    self.set(env, name, b);
                }
                // SF-1d: a server fn, not an accessor
                Decl::Eq { name, e, .. } if unwrap_server(e).is_some() => self.set(env, name, val(mg(name))),
                Decl::Eq { name, e, deferred, .. } => {
                    let mut b = bind(Kind::Acc, mg(name));
                    if let ExprKind::Call { f, .. } = &e.k {
                        if let ExprKind::Id(fname) = &f.k {
                            if let Some(jf) = self.lookup(env, fname).filter(|x| x.kind == Kind::Jfn) {
                                b.inst = Some(format!("r${name}"));
                                b.shape = jf.shape.clone();
                            }
                        }
                    }
                    if self.guessed_eq(name, e, *deferred) {
                        b.w = Some(format!("w${name}"));
                    }
                    b.prev = self.u.prev_of.contains(name).then(|| format!("p${name}"));
                    self.set(env, name, b);
                }
                _ => {}
            }
        }
        for d in decls {
            let Decl::Import { resolved: None, names, from, declared_errors, .. } = d else { continue };
            let n0 = out.len();
            for n in names {
                let (name, alias) = (&n.name, &n.alias);
                let v = if self.js_import(from) && !builtin(name) && name != "log" {
                    id(format!("w${alias}"))
                } else if name == "log" {
                    dot(id("__B"), "log")
                } else if declared_errors.as_ref().is_some_and(|e| e.contains(name)) {
                    rtc("jsError", vec![str(name.clone())])
                } else if builtin(name) {
                    dot(id("__B"), name)
                } else if from.ends_with("/api") {
                    rtc("api", vec![str(name.clone())])
                } else if is_prims(from) {
                    // MO-10: the scenario prelude's Solid primitives
                    rtc("prim", vec![str(name.clone())])
                } else {
                    return fail(format!("{name} from \"{from}\" is not in the scenario prelude"));
                };
                out.push(konst(mg(alias), v));
                out.push(sexpr(rtc("reg", vec![str(alias.clone()), obj(vec![("value", id(mg(alias)))])])));
            }
            at(&mut out, n0, d.line());
        }
        for d in decls {
            let Decl::Error { name, params, msg, .. } = d else { continue };
            let inner = self.params(env, params);
            let body = match msg {
                Some(m) => self.expr(m, inner, &reactive())?,
                None => str(name.clone()),
            };
            let make = rtc(
                "errorClass",
                vec![str(name.clone()), strs(params), E::Arrow { params: params.iter().map(|p| P::Id(mg(p))).collect(), body: Body::Expr(Box::new(body)), is_async: false }],
            );
            if self.frames[env].parent.is_some() {
                out.push(S::At(d.line(), Box::new(konst(mg(name), make)))); // R-f-1
                continue;
            }
            let t0 = self.top.len();
            // a module's error class is the module's, created once (by whichever app asks first): a server function's body,
            // hoisted to module level (SF-7a), throws the class an action's catch tests
            self.top.push(S::Let(format!("c${name}"), None));
            self.top.push(S::Func(Func {
                name: Some(format!("g${name}")),
                params: vec![P::Id("__rt".into())],
                directives: vec![],
                body: vec![konst("__B", dot(id("__rt"), "B")), S::Return(Some(E::Assign("??=", Box::new(id(format!("c${name}"))), Box::new(make))))],
                is_async: false,
                generator: false,
            }));
            at(&mut self.top, t0, d.line());
            out.push(S::At(d.line(), Box::new(konst(mg(name), call(id(format!("g${name}")), vec![id("__rt")]))))); // R-f-1
        }
        for d in decls {
            let Decl::Context { name, dflt, .. } = d else { continue };
            let n0 = out.len();
            let dv = match dflt {
                Some(x) => thunk(self.expr(x, env, &reactive())?),
                None => E::Null,
            };
            // RG-7: the declaration is the context's identity
            out.push(konst(mg(name), rtc("context", vec![str(name.clone()), dv])));
            out.push(sexpr(rtc("reg", vec![str(name.clone()), obj(vec![("value", id(mg(name)))])])));
            at(&mut out, n0, d.line());
        }
        for d in decls {
            if let Decl::Fn { .. } = d {
                let s = self.fn_decl(d, env)?;
                out.push(S::At(d.line(), Box::new(s)));
            }
        }
        for d in decls {
            if let Decl::Component { .. } = d {
                let s = self.component(d, env)?;
                out.push(S::At(d.line(), Box::new(s)));
            }
        }
        for d in decls {
            let Decl::Action { name, params, body, .. } = d else { continue };
            let n0 = out.len();
            let penv = self.params(env, params);
            let body = self.stmts(body, penv, &Ctx { imp: true, gen: true, ..Ctx::default() }, false)?;
            let gen = E::Func(Box::new(Func { name: None, params: params.iter().map(|p| P::Id(mg(p))).collect(), directives: vec![], body, is_async: false, generator: true }));
            out.push(konst(mg(name), rtc("action", vec![gen])));
            out.push(sexpr(rtc("reg", vec![str(name.clone()), obj(vec![("value", id(mg(name)))])])));
            at(&mut out, n0, d.line());
        }
        for d in decls {
            let Decl::Eq { name, e, .. } = d else { continue };
            if unwrap_server(e).is_none() {
                continue;
            }
            // 12 SF-1d: a wrapped server fn, at module level
            let f = self.server_wrapped(name, e)?;
            out.push(S::At(d.line(), Box::new(konst(mg(name), rtc("serverRef", vec![str(name.clone()), id(f)])))));
        }
        for d in decls {
            let Decl::Server { name, params, body, .. } = d else { continue };
            // 12 SF-7a: the call site's (question or request); the function is module-level
            let f = self.server_hoist(name, params, body, false)?;
            out.push(S::At(d.line(), Box::new(konst(mg(name), rtc("serverRef", vec![str(name.clone()), f])))));
        }
        // values in dependency order (E-7: equations are unordered in the source; C-1 makes this a DAG)
        let vals: Vec<&Decl> = decls
            .iter()
            .filter(|d| matches!(d, Decl::Source { .. } | Decl::Provide { .. }) || matches!(d, Decl::Eq { e, .. } if unwrap_server(e).is_none()))
            .collect();
        let key = |d: &Decl| match d {
            Decl::Provide { name, .. } => format!("provide:{name}"),
            _ => d.name().unwrap().to_string(),
        };
        let local: HashSet<&str> = vals.iter().filter(|d| !matches!(d, Decl::Provide { .. })).filter_map(|d| d.name()).collect();
        let mut done: HashSet<String> = HashSet::new();
        let mut busy: HashSet<String> = HashSet::new();
        let mut order: Vec<&Decl> = vec![];
        fn visit<'d>(d: &'d Decl, vals: &[&'d Decl], local: &HashSet<&str>, key: &dyn Fn(&Decl) -> String, done: &mut HashSet<String>, busy: &mut HashSet<String>, order: &mut Vec<&'d Decl>) {
            let k = key(d);
            if done.contains(&k) || busy.contains(&k) {
                return;
            }
            busy.insert(k.clone());
            let self_name = match d {
                Decl::Provide { .. } => "",
                _ => d.name().unwrap(),
            };
            let e = match d {
                Decl::Eq { e, .. } => e,
                Decl::Source { init, .. } => init,
                Decl::Provide { e, .. } => e,
                _ => unreachable!(),
            };
            let mut ds = IndexSet::new();
            deps(&e.to_json(), self_name, &mut ds);
            for n in &ds {
                if local.contains(n.as_str()) && n != self_name {
                    if let Some(t) = vals.iter().find(|x| !matches!(x, Decl::Provide { .. }) && x.name() == Some(n.as_str())) {
                        visit(t, vals, local, key, done, busy, order);
                    }
                }
            }
            busy.remove(&k);
            done.insert(k);
            order.push(d);
        }
        for d in &vals {
            visit(d, &vals, &local, &key, &mut done, &mut busy, &mut order);
        }
        for d in order {
            let n0 = out.len();
            let mut v = self.value(d, env)?;
            out.append(&mut v);
            at(&mut out, n0, d.line());
        }
        for d in decls {
            let Decl::Effect { inputs, body, .. } = d else { continue };
            let n0 = out.len();
            let inner = self.new_env(Some(env));
            let mut h = self.hoist_all(&inputs.iter().collect::<Vec<_>>(), env)?;
            out.append(&mut h);
            let mut ins = vec![];
            for i in inputs {
                ins.push(self.expr(i, env, &reactive())?);
            }
            let apply = self.stmts(body, inner, &Ctx { imp: true, effect: true, ..Ctx::default() }, true)?;
            // SC-2: the apply reads σ, untracked
            out.push(sexpr(rtc(
                "effect",
                vec![E::Num(inputs.len() as f64), thunk(E::Arr(ins)), arrow(&["$p"], rtc("untrack", vec![arrow_block(vec![], apply, false)]))],
            )));
            at(&mut out, n0, d.line());
        }
        match exports_tail {
            Some(t) => out.push(S::Return(Some(t))),
            None => {
                let mut h = self.hoist_all(&view_readers(view), env)?;
                out.append(&mut h);
                let m = self.markup(view, env)?;
                out.push(S::Return(Some(m)));
            }
        }
        Ok(out)
    }

    /// An imported name's binding, from the exporting module's declaration (MO-3: a source is read-only here, so an accessor).
    fn import_bind(&self, path: &str, name: &str, alias: &str) -> Bind {
        let js = mg(alias);
        if !self.set.programs.contains_key(path) {
            if let Some(sig) = self.set.signatures.get(path).and_then(|s| s.exports.get(name)) {
                // MO-9: the kind is the signature's
                return match sig {
                    ExportSig::Fn { params, instantiating, .. } => {
                        let mut b = bind(if *instantiating || params.iter().any(|p| p.r#ref) { Kind::Ifn } else { Kind::Fn }, js);
                        b.f = Some(FnRef { params: params.iter().map(|p| (p.name.clone(), p.r#ref)).collect(), decl: None });
                        b
                    }
                    ExportSig::Comp { .. } => bind(Kind::Comp, cm(alias)),
                    ExportSig::Action => bind(Kind::Act, js),
                    ExportSig::Source { .. } | ExportSig::Eq { .. } => bind(Kind::Acc, js),
                    _ => val(js),
                };
            }
        }
        let Some(d) = self.set.programs.get(path).and_then(|p| p.decls.iter().find(|x| x.name() == Some(name))) else { return val(js) };
        match d {
            Decl::Fn { params, decls, .. } => {
                let mut b = bind(if params.iter().any(|p| p.r#ref) || !decls.is_empty() { Kind::Ifn } else { Kind::Fn }, js);
                b.f = Some(FnRef { params: params.iter().map(|p| (p.name.clone(), p.r#ref)).collect(), decl: Some(d as *const Decl) });
                b
            }
            Decl::Component { .. } => bind(Kind::Comp, cm(alias)),
            Decl::Action { .. } => bind(Kind::Act, js),
            Decl::Source { .. } | Decl::Eq { .. } => bind(Kind::Acc, js),
            _ => val(js),
        }
    }

    fn reg(&self, name: &str, b: &Bind, writer: bool) -> S {
        let mut kv = vec![("get", id(b.js.clone()))];
        if writer {
            kv.push(("w", id(b.w.clone().unwrap())));
        }
        sexpr(rtc("reg", vec![str(name), obj(kv)]))
    }
    fn value(&mut self, d: &Decl, env: Env) -> R<Vec<S>> {
        if let Decl::Provide { name, e, .. } = d {
            let b = if let ExprKind::Id(n) = &e.k { self.lookup(env, n) } else { None };
            let src = b.as_ref().filter(|b| b.kind == Kind::Src);
            let mut out = if src.is_some() { vec![] } else { self.hoist_all(&[e], env)? };
            let entry = match src {
                Some(b) => obj(vec![("get", id(b.js.clone())), ("w", id(b.w.clone().unwrap()))]),
                None => {
                    let x = self.expr(e, env, &reactive())?;
                    obj(vec![("get", rtc("memo", vec![E::Null, thunk(x)]))])
                }
            };
            let c = self.reference(name, env, &reactive())?;
            out.push(sexpr(rtc("provide", vec![c, entry])));
            return Ok(out);
        }
        let name = d.name().unwrap();
        let b = self.frames[env].vars.get(name).unwrap().clone();
        let mut out = match d {
            Decl::Source { question: true, init, .. } => self.hoist(Some(name), init, env, true)?,
            Decl::Eq { e, .. } if !matches!(&e.k, ExprKind::Draft { .. }) => self.hoist(Some(name), e, env, true)?,
            _ => vec![],
        };
        out.append(&mut self.value1(d, env, &b)?);
        Ok(out)
    }
    /// 07 §3 / R-1: each `await` that is not the equation's result is its own async memo, asked only while the conditions that
    /// reach it hold (E-11, awaits.rs); the equation reads it where the `await` was.
    fn hoist(&mut self, name: Option<&str>, e: &Expr, env: Env, tail: bool) -> R<Vec<S>> {
        let mut out = vec![];
        for h in non_tail_awaits(e, tail) {
            let v = format!("a${}${}", name.unwrap_or(""), self.hoist_seq);
            self.hoist_seq += 1;
            let mut guards = vec![];
            for g in &h.guards {
                let x = self.expr(g.e, env, &reactive())?;
                guards.push(if g.nullish { bin("==", x, E::Null) } else if g.neg { not(x) } else { x });
            }
            let ExprKind::Await { e: inner, init, stream } = &h.node.k else { unreachable!() };
            let body0 = self.expr(inner, env, &Ctx { tail: true, ..Ctx::default() })?;
            let body = if *stream { body0 } else { rtc("awaited", vec![body0]) };
            self.hoisted.insert(h.node as *const Expr, v.clone());
            let lv = match init {
                Some(i) => rtc("firstPaint", vec![thunk(self.expr(i, env, &reactive())?)]),
                None => undef(),
            };
            let lv = if self.client_call(inner, env) { rtc("clientQuestion", vec![lv]) } else { lv };
            let f = if guards.is_empty() {
                body
            } else {
                let mut it = guards.into_iter();
                let first = it.next().unwrap();
                let c = it.fold(first, |a, b| bin("&&", a, b));
                E::Cond(Box::new(c), Box::new(body), Box::new(undef()))
            };
            out.push(konst(v.clone(), rtc("memo", vec![name.map(str).unwrap_or(E::Null), thunk(f), lv])));
            if let Some(n) = name {
                out.push(sexpr(rtc("hoisted", vec![str(n), id(v)])));
            }
        }
        Ok(out)
    }
    fn hoist_all(&mut self, es: &[&Expr], env: Env) -> R<Vec<S>> {
        let mut out = vec![];
        for x in es {
            out.append(&mut self.hoist(None, x, env, false)?);
        }
        Ok(out)
    }
    fn value1(&mut self, d: &Decl, env: Env, b: &Bind) -> R<Vec<S>> {
        let prev = |out: &mut Vec<S>| {
            if let Some(p) = &b.prev {
                out.push(konst(p.clone(), rtc("pre", vec![id(b.js.clone())])));
            }
        };
        let pair = || Pat::Arr(vec![b.js.clone(), b.w.clone().unwrap()]);
        match d {
            Decl::Source { name, init, question: false, .. } => {
                let x = self.expr(init, env, &reactive())?;
                let mut out = vec![S::Const(pair(), rtc("source", vec![str(name.clone()), rtc("untrack", vec![thunk(x)])])), self.reg(name, b, true)];
                prev(&mut out);
                Ok(out)
            }
            Decl::Source { name, init, key, .. } => {
                let lv = self.loading_value(init, env)?;
                let mode = obj(vec![("optimistic", E::Bool(self.u.optimistic.contains(name))), ("structured", E::Bool(self.u.paths.contains(name)))]);
                let x = self.expr(init, env, &Ctx { tail: true, self_: Some(name.clone()), ..Ctx::default() })?;
                let mut args = vec![str(name.clone()), arrow(&["__prev"], x), lv, mode];
                if let Some(k) = key {
                    args.push(str(k.clone()));
                }
                let mut out = vec![S::Const(pair(), rtc("question", args)), self.reg(name, b, true)];
                prev(&mut out);
                Ok(out)
            }
            Decl::Eq { name, e, key, deferred, .. } if self.guessed_eq(name, e, *deferred) => {
                // AC-3 over an equation: createOptimistic(fn) / createOptimisticStore(fn, seed) — derived, its setter only guesses
                let lv = self.loading_value(e, env)?;
                let mode = obj(vec![("optimistic", E::Bool(true)), ("structured", E::Bool(self.u.paths.contains(name) || key.is_some())), ("derived", E::Bool(true))]);
                let x = self.expr(e, env, &Ctx { tail: true, self_: Some(name.clone()), ..Ctx::default() })?;
                let mut args = vec![str(name.clone()), arrow(&["__prev"], x), lv, mode];
                if let Some(k) = key {
                    args.push(str(k.clone()));
                }
                let mut out = vec![S::Const(pair(), rtc("question", args)), self.reg(name, b, true)];
                prev(&mut out);
                Ok(out)
            }
            Decl::Eq { name, e, key, deferred, .. } => {
                let fin = |mut out: Vec<S>, g: &Self| {
                    out.push(g.reg(name, b, false));
                    prev(&mut out);
                    Ok(out)
                };
                // ST-3
                if let ExprKind::Draft { seed, body } = &e.k {
                    let ExprKind::Pre { name: sn, init: Some(si) } = &seed.k else { return fail("a draft's seed must be `pre self -> seed`") };
                    if sn != name {
                        return fail("a draft's seed must be `pre self -> seed`");
                    }
                    let inner = self.new_env(Some(env));
                    self.set(inner, "d", val("v$d"));
                    let s = self.expr(si, env, &reactive())?;
                    let db = self.draft_body(body, inner)?;
                    return fin(vec![konst(b.js.clone(), rtc("draft", vec![rtc("untrack", vec![thunk(s)]), arrow_block(vec![P::Id("v$d".into())], db, false)]))], self);
                }
                // RG-6
                if let ExprKind::Call { f, .. } = &e.k {
                    if let ExprKind::Id(fname) = &f.k {
                        if self.lookup(env, fname).is_some_and(|x| x.kind == Kind::Ifn) {
                            let v = self.instantiate(e, env)?;
                            return fin(vec![konst(b.js.clone(), v)], self);
                        }
                    }
                }
                if let Some(fx) = self.foreign(e, env, &b)? {
                    return fin(fx, self);
                }
                if let Some(k) = key {
                    let x = self.expr(e, env, &Ctx { tail: true, ..Ctx::default() })?;
                    return fin(vec![konst(b.js.clone(), rtc("keyed", vec![str(name.clone()), str(k.clone()), thunk(x)]))], self);
                }
                // R-f-4 over a tail await: the flight is an inner memo, read through a boundary
                if let (ExprKind::Catch { e: ce, name: cn, classes, alt }, false) = (&e.k, deferred) {
                    let inner = self.new_env(Some(env));
                    if let Some(n) = cn {
                        self.set(inner, n, val(mg(n)));
                    }
                    let x = self.expr(ce, env, &Ctx { tail: true, self_: Some(name.clone()), ..Ctx::default() })?;
                    let lv = self.loading_value(ce, env)?;
                    let i = format!("i${name}");
                    let cls = self.classes(classes.as_deref(), env)?;
                    let a = self.expr(alt, inner, &reactive())?;
                    let out = vec![
                        konst(i.clone(), rtc("memo", vec![str(name.clone()), arrow(&["__prev"], x), lv])),
                        konst(
                            b.js.clone(),
                            rtc(
                                "catchMemo",
                                vec![thunk(call(id(i), vec![])), arrow(&["__e"], rtc("isA", vec![id("__e"), cls])), arrow(&[&cn.as_ref().map(|n| mg(n)).unwrap_or("__e".into())], a)],
                            ),
                        ),
                    ];
                    return fin(out, self);
                }
                let x = self.expr(e, env, &Ctx { tail: true, self_: Some(name.clone()), ..Ctx::default() })?;
                let lv = self.loading_value(e, env)?;
                fin(vec![konst(b.js.clone(), rtc(if *deferred { "deferred" } else { "memo" }, vec![str(name.clone()), arrow(&["__prev"], x), lv]))], self)
            }
            _ => fail("unreachable"),
        }
    }
    /// SV-7b: a call into `client` JS — awaited, a client question: Solid's `ssrSource: "client"`, never asked on the server.
    fn client_call(&self, e: &Expr, env: Env) -> bool {
        let f = if let ExprKind::Catch { e, .. } = &e.k { &**e } else { e };
        if let ExprKind::Call { f, .. } = &f.k {
            if let ExprKind::Id(n) = &f.k {
                return self.lookup(env, n).is_some_and(|b| b.client);
            }
        }
        false
    }
    fn tail_client(&self, e: &Expr, env: Env) -> bool {
        fn walk(g: &Gen, n: Node, env: Env) -> bool {
            if let Node::E(x) = n {
                match &x.k {
                    ExprKind::Fn { .. } => return false,
                    ExprKind::Await { e, .. } if !g.hoisted.contains_key(&(x as *const Expr)) && g.client_call(e, env) => return true,
                    _ => {}
                }
            }
            children(n, true).into_iter().any(|c| walk(g, c, env))
        }
        walk(self, Node::E(e), env)
    }
    /// R-7: the first paint of an `await … -> v`; SV-7b: a client question's ssrSource
    fn loading_value(&mut self, e: &Expr, env: Env) -> R<E> {
        let lv = self.loading_value0(e, env)?;
        Ok(if self.tail_client(e, env) { rtc("clientQuestion", vec![lv]) } else { lv })
    }
    fn loading_value0(&mut self, e: &Expr, env: Env) -> R<E> {
        fn find<'a>(n: Node<'a>) -> Option<&'a Expr> {
            if let Node::E(x) = n {
                match &x.k {
                    ExprKind::Fn { .. } => return None,
                    ExprKind::Await { init: Some(i), .. } => return Some(i),
                    _ => {}
                }
            }
            children(n, true).into_iter().find_map(find)
        }
        Ok(match find(Node::E(e)) {
            Some(i) => rtc("firstPaint", vec![thunk(self.expr(i, env, &reactive())?)]),
            None => undef(),
        })
    }
    fn draft_body(&mut self, ss: &[Stmt], env: Env) -> R<Vec<S>> {
        let mut out = vec![];
        for s in ss {
            match &s.k {
                StmtKind::Let { name, e, .. } => {
                    self.set(env, name, val(mg(name)));
                    out.push(konst(mg(name), self.expr(e, env, &reactive())?));
                }
                StmtKind::Expr(e) => out.push(sexpr(self.expr(e, env, &reactive())?)),
                StmtKind::Write { target, e } => {
                    let mut path = vec![];
                    for p in &target.path {
                        path.push(match p {
                            PathSeg::Name(n) => str(n.clone()),
                            PathSeg::Expr(x) => self.expr(x, env, &reactive())?,
                        });
                    }
                    let last = path.pop().unwrap_or_else(undef);
                    let mut block = vec![S::Let("__t".into(), Some(id("v$d")))];
                    for k in path {
                        let slot = E::Index(Box::new(id("__t")), Box::new(k), false);
                        block.push(sexpr(E::Assign("=", Box::new(id("__t")), Box::new(E::Assign("??=", Box::new(slot), Box::new(E::Obj(vec![])))))));
                    }
                    let v = self.expr(e, env, &reactive())?;
                    block.push(sexpr(E::Assign("=", Box::new(E::Index(Box::new(id("__t")), Box::new(last), false)), Box::new(v))));
                    out.push(S::Block(block));
                }
                s => return fail(format!("{} in a draft block", s.kind())),
            }
        }
        Ok(out)
    }
    fn fn_decl(&mut self, d: &Decl, env: Env) -> R<S> {
        let Decl::Fn { name, params, decls, tail, .. } = d else { unreachable!() };
        let inner = self.new_env(Some(env));
        for p in params {
            self.set(inner, &p.name, bind(if p.r#ref { Kind::Acc } else { Kind::Val }, mg(&p.name)));
        }
        let ps: Vec<P> = params.iter().map(|p| P::Id(mg(&p.name))).collect();
        if !params.iter().any(|p| p.r#ref) && decls.is_empty() {
            let x = self.expr(tail, inner, &reactive())?;
            return Ok(S::Func(Func { name: Some(mg(name)), params: ps, directives: vec![], body: vec![S::Return(Some(x))], is_async: false, generator: false }));
        }
        // an instantiating fn (RG-6): called once, returns the accessor of its tail
        let mut body = self.block(decls, &[], inner, None, false)?;
        strip_return_null(&mut body);
        let tb = if let ExprKind::Id(n) = &tail.k { self.lookup(inner, n) } else { None };
        let t = match tb {
            Some(tb) if matches!(tb.kind, Kind::Acc | Kind::Src) => id(tb.js),
            _ => rtc("memo", vec![E::Null, thunk(self.expr(tail, inner, &reactive())?)]),
        };
        body.push(S::Return(Some(t)));
        Ok(S::Func(Func { name: Some(mg(name)), params: ps, directives: vec![], body, is_async: false, generator: false }))
    }
    /// MO-10: `x = f(…)` over a declared primitive — called once (RG-6), a ref argument as an accessor, a value one
    /// untracked; and `y = x[i]` / `x.k` over its result. A `ref` part is bound to the accessor itself, any other part to
    /// its value.
    fn foreign(&mut self, e: &Expr, env: Env, b: &Bind) -> R<Option<Vec<S>>> {
        fn part(r: E, p: Part) -> E {
            if p == Part::Ref {
                r
            } else {
                thunk(r)
            }
        }
        let ix = |r: &str, k: E| E::Index(Box::new(id(r)), Box::new(k), false);
        match &e.k {
            ExprKind::Call { f, args } => {
                let ExprKind::Id(fname) = &f.k else { return Ok(None) };
                let Some(fb) = self.lookup(env, fname).filter(|x| x.kind == Kind::Jfn) else { return Ok(None) };
                let refs: Vec<bool> = fb.f.as_ref().unwrap().params.iter().map(|p| p.1).collect();
                let mut out = vec![];
                for (i, a) in args.iter().enumerate() {
                    if !refs.get(i).copied().unwrap_or(false) {
                        out.push(rtc("untrack", vec![thunk(self.expr(a, env, &reactive())?)]));
                        continue;
                    }
                    if let ExprKind::Id(n) = &a.k {
                        if let Some(ab) = self.lookup(env, n).filter(|ab| matches!(ab.kind, Kind::Acc | Kind::Src)) {
                            out.push(id(ab.js));
                            continue;
                        }
                    }
                    out.push(rtc("memo", vec![E::Null, thunk(self.expr(a, env, &reactive())?)]));
                }
                let r = b.inst.clone().unwrap();
                let whole = match fb.shape.as_ref().unwrap() {
                    FShape::Part(p) => part(id(r.clone()), *p),
                    FShape::Items(items) => rtc(
                        "memo",
                        vec![E::Null, thunk(E::Arr(items.iter().enumerate().map(|(i, p)| { let x = ix(&r, E::Num(i as f64)); if *p == Part::Ref { call(x, vec![]) } else { x } }).collect()))],
                    ),
                    FShape::Fields(fields) => rtc(
                        "memo",
                        vec![E::Null, thunk(E::Obj(fields.iter().map(|(k, p)| { let x = ix(&r, str(k.clone())); Prop::Kv(Key::Str(k.clone()), if *p == Part::Ref { call(x, vec![]) } else { x }) }).collect()))],
                    ),
                };
                Ok(Some(vec![konst(r.clone(), call(id(fb.js.clone()), out)), konst(b.js.clone(), whole)]))
            }
            ExprKind::Index { o, .. } | ExprKind::Member { o, .. } => {
                let ExprKind::Id(on) = &o.k else { return Ok(None) };
                let Some(ob) = self.lookup(env, on) else { return Ok(None) };
                let (Some(inst), Some(sh)) = (ob.inst.clone(), ob.shape.clone()) else { return Ok(None) };
                let (key, p) = match (&e.k, &sh) {
                    (ExprKind::Index { i, .. }, FShape::Items(items)) => match &i.k {
                        ExprKind::Lit(Lit::Num(v)) if *v >= 0.0 && v.fract() == 0.0 => match items.get(*v as usize) {
                            Some(p) => (E::Num(*v), *p),
                            None => return Ok(None),
                        },
                        _ => return Ok(None),
                    },
                    (ExprKind::Member { p: k, .. }, FShape::Fields(fields)) => match fields.iter().find(|f| &f.0 == k) {
                        Some(f) => (str(k.clone()), f.1),
                        None => return Ok(None),
                    },
                    _ => return Ok(None),
                };
                Ok(Some(vec![konst(b.js.clone(), part(ix(&inst, key), p))]))
            }
            _ => Ok(None),
        }
    }
    fn instantiate(&mut self, e: &Expr, env: Env) -> R<E> {
        let ExprKind::Call { f, args } = &e.k else { unreachable!() };
        let ExprKind::Id(fname) = &f.k else { unreachable!() };
        let b = self.lookup(env, fname).unwrap();
        let mut out = vec![];
        for (i, (_, r#ref)) in b.f.as_ref().unwrap().params.iter().enumerate() {
            let Some(a) = args.get(i) else {
                out.push(undef());
                continue;
            };
            if *r#ref {
                if let ExprKind::Id(n) = &a.k {
                    if let Some(ab) = self.lookup(env, n).filter(|ab| matches!(ab.kind, Kind::Acc | Kind::Src)) {
                        out.push(id(ab.js));
                        continue;
                    }
                }
                out.push(rtc("memo", vec![E::Null, thunk(self.expr(a, env, &reactive())?)]));
            } else {
                out.push(rtc("untrack", vec![thunk(self.expr(a, env, &reactive())?)]));
            }
        }
        Ok(call(id(b.js), out))
    }
    fn component(&mut self, d: &Decl, env: Env) -> R<S> {
        let Decl::Component { name, props, decls, view, .. } = d else { unreachable!() };
        let inner = self.new_env(Some(env));
        self.set(inner, props, val(mg(props)));
        let body = self.block(decls, view, inner, None, true)?;
        Ok(S::Func(Func { name: Some(cm(name)), params: vec![P::Id(mg(props))], directives: vec![], body, is_async: false, generator: false }))
    }

    // ---- expressions
    fn expr(&mut self, e: &Expr, env: Env, ctx: &Ctx) -> R<E> {
        let sub = Ctx { tail: false, ..ctx.clone() };
        Ok(match &e.k {
            ExprKind::Lit(l) => lit(l),
            ExprKind::Id(n) => self.reference(n, env, ctx)?,
            ExprKind::Pre { name, init } => {
                let i = match init {
                    Some(i) => self.expr(i, env, &sub)?,
                    None => undef(),
                };
                // the equation's own: the memo's previous value
                if ctx.self_.as_deref() == Some(name) {
                    return Ok(rtc("preOr", vec![id("__prev"), thunk(i)]));
                }
                let Some(p) = self.lookup(env, name).and_then(|b| b.prev) else { return fail(format!("pre {name}: no companion memo")) };
                rtc("preOr", vec![call(id(p), vec![]), thunk(i)])
            }
            ExprKind::Peek(x) => rtc("untrack", vec![thunk(self.expr(x, env, &sub)?)]),
            // RG-4b: Solid's live view
            ExprKind::Omit { e: x, keys } => rtc("omit", std::iter::once(self.expr(x, env, &sub)).chain(keys.iter().map(|k| Ok(str(k.clone())))).collect::<Result<Vec<_>, _>>()?),
            ExprKind::Await { e: x, stream, .. } => {
                if let Some(v) = self.hoisted.get(&(e as *const Expr)) {
                    return Ok(call(id(v.clone()), vec![]));
                }
                if ctx.imp {
                    let y = self.expr(x, env, &sub)?;
                    return Ok(if ctx.gen {
                        E::Yield(Box::new(rtc("awaited", vec![y])))
                    } else if ctx.is_async {
                        E::Await(Box::new(rtc("awaited", vec![y])))
                    } else {
                        y
                    });
                }
                if !ctx.tail {
                    return fail("`await` outside an equation's result position is not lowered yet");
                }
                // the memo returns the flight (R-1): a stream for `await*`, else its one answer
                let y = self.expr(x, env, &sub)?;
                if *stream {
                    y
                } else {
                    rtc("awaited", vec![y])
                }
            }
            // R-12: Solid's latest — of a value that never had one it throws, in a handler too (S-solid-28)
            ExprKind::Latest(x) => rtc("latest", vec![thunk(self.expr(x, env, &Ctx { imp: false, ..ctx.clone() })?)]),
            ExprKind::Pending(x) => rtc("isPending", vec![thunk(self.expr(x, env, &sub)?)]),
            ExprKind::If { c, t, f } => {
                let c = self.expr(c, env, &sub)?;
                let t = self.expr(t, env, ctx)?;
                let f = self.expr(f, env, ctx)?;
                E::Cond(Box::new(c), Box::new(t), Box::new(f))
            }
            // R-f-3
            ExprKind::Throw(x) => rtc("throw", vec![self.expr(x, env, &sub)?]),
            // R-f-4: over a sync value, or the tail await's promise/stream
            ExprKind::Catch { e: x, name, classes, alt } => {
                if ctx.imp && has_await_json(&x.to_json()) {
                    return fail("`await … catch` inside an expression of imperative scope (AWAIT_IN_EXPRESSION, AC-1)");
                }
                let inner = self.new_env(Some(env));
                if let Some(n) = name {
                    self.set(inner, n, val(mg(n)));
                }
                let body = self.expr(x, env, &sub)?;
                let cls = self.classes(classes.as_deref(), env)?;
                let a = self.expr(alt, inner, &sub)?;
                let p = name.as_ref().map(|n| mg(n)).unwrap_or("__e".into());
                rtc(if ctx.imp { "tryCatch" } else { "catchRead" }, vec![thunk(body), arrow(&["__e"], rtc("isA", vec![id("__e"), cls])), arrow(&[&p], a)])
            }
            ExprKind::Tpl(parts) => {
                let mut xs = vec![];
                for p in parts {
                    xs.push(match p {
                        crate::ast::TplPart::Str(s) => str(s.clone()),
                        crate::ast::TplPart::Expr(x) => rtc("fmt", vec![self.expr(x, env, &sub)?]),
                    });
                }
                let mut it = xs.into_iter();
                match it.next() {
                    None => str(""),
                    Some(first) => it.fold(first, |a, b| bin("+", a, b)),
                }
            }
            ExprKind::Member { o, p, .. } => E::Member(Box::new(self.expr(o, env, &sub)?), p.clone(), true),
            ExprKind::Index { o, i, .. } => {
                let o = self.expr(o, env, &sub)?;
                E::Index(Box::new(o), Box::new(self.expr(i, env, &sub)?), true)
            }
            // 07 CSS-5
            ExprKind::StyleMap { css, line } => self.class_map(css, *line)?,
            ExprKind::Call { f, args } => {
                // AC-6: Solid's until; the predicate is reactive scope
                if let (ExprKind::Id(n), Some(Expr { k: ExprKind::Fn { body, .. }, .. })) = (&f.k, args.first()) {
                    if n == "until" && self.lookup(env, "until").is_none() {
                        return Ok(rtc("until", vec![thunk(self.expr(body, env, &Ctx { dynamic: ctx.dynamic, ..Ctx::default() })?)]));
                    }
                }
                // EF-7, EF-8: Solid's own
                if let ExprKind::Id(n) = &f.k {
                    if (n == "onSettled" || n == "onFlush") && self.lookup(env, n).is_none() {
                        let mut xs = vec![];
                        for a in args {
                            xs.push(self.expr(a, env, &sub)?);
                        }
                        return Ok(rtc(n, xs));
                    }
                }
                let callee = if let ExprKind::Member { o, p, .. } = &f.k { E::Member(Box::new(self.expr(o, env, &sub)?), p.clone(), true) } else { self.expr(f, env, &sub)? };
                let mut xs = vec![];
                for a in args {
                    xs.push(self.expr(a, env, &sub)?);
                }
                call(callee, xs)
            }
            ExprKind::Arr(items) => {
                let mut xs = vec![];
                for i in items {
                    xs.push(match &i.k {
                        ExprKind::Spread(x) => E::Spread(Box::new(self.expr(x, env, &sub)?)),
                        _ => self.expr(i, env, &sub)?,
                    });
                }
                E::Arr(xs)
            }
            ExprKind::Rec(fields) => {
                let mut ps = vec![];
                for f in fields {
                    ps.push(match f {
                        crate::ast::Field::Spread(x) => Prop::Spread(self.expr(x, env, &sub)?),
                        crate::ast::Field::Kv { key, v } => Prop::Kv(Key::Str(key.clone()), self.expr(v, env, &sub)?),
                    });
                }
                E::Obj(ps)
            }
            ExprKind::Fn { params, body, stmts } => {
                let inner = self.params(env, params);
                let ps: Vec<P> = params.iter().map(|p| P::Id(mg(p))).collect();
                match stmts {
                    Some(ss) if crate::infer::inferred_action(ss).is_some() => {
                        // AC-1b: an inferred action lowers as `action { … }` does, to Solid's action()
                        let b = self.stmts(ss, inner, &Ctx { imp: true, gen: true, dynamic: ctx.dynamic, effect: ctx.effect, ..Ctx::default() }, false)?;
                        let gen = E::Func(Box::new(Func { name: None, params: vec![], directives: vec![], body: b, is_async: false, generator: true }));
                        E::Arrow { params: ps, body: Body::Expr(Box::new(call(rtc("action", vec![gen]), vec![]))), is_async: false }
                    }
                    Some(ss) => {
                        let is_async = has_await_json(&Value::Array(ss.iter().map(|s| s.to_json()).collect()));
                        let b = self.stmts(ss, inner, &Ctx { imp: true, is_async, dynamic: ctx.dynamic, effect: ctx.effect, ..Ctx::default() }, false)?;
                        arrow_block(ps, b, is_async)
                    }
                    None => {
                        let b = self.expr(body, inner, &Ctx { imp: ctx.imp, dynamic: ctx.dynamic, effect: ctx.effect, ..Ctx::default() })?;
                        E::Arrow { params: ps, body: Body::Expr(Box::new(b)), is_async: false }
                    }
                }
            }
            ExprKind::Use(n) => rtc("useGet", vec![self.reference(n, env, &Ctx { dynamic: ctx.dynamic, ..Ctx::default() })?, id("__o")]),
            ExprKind::Bin { op, l, r } => {
                let l = self.expr(l, env, &sub)?;
                let r = self.expr(r, env, &sub)?;
                match op.as_str() {
                    "==" => rtc("eq", vec![l, r]),
                    "!=" => not(rtc("eq", vec![l, r])),
                    op => bin(static_op(op), l, r),
                }
            }
            ExprKind::Un { op, e: x } => E::Un(static_op(op), Box::new(self.expr(x, env, &sub)?)),
            ExprKind::Draft { .. } => return fail("a draft is an equation's whole expression"),
            ExprKind::Spread(_) => return fail("spread outside an array literal"),
            ExprKind::ServerFn { .. } => undef(),
        })
    }
    fn reference(&mut self, name: &str, env: Env, ctx: &Ctx) -> R<E> {
        if ctx.effect && name.len() > 1 && name.starts_with('$') && name[1..].bytes().all(|b| b.is_ascii_digit()) {
            return Ok(E::Index(Box::new(id("$p")), Box::new(E::Num(name[1..].parse::<f64>().unwrap())), false));
        }
        let Some(b) = self.lookup(env, name) else {
            if builtin(name) {
                return Ok(dot(id("__B"), name));
            }
            if ctx.dynamic {
                return Ok(if name == "log" {
                    dot(id("__B"), "log")
                } else if ctx.imp {
                    rtc("dget", vec![str(name)])
                } else {
                    rtc("dget", vec![str(name), E::Bool(true)])
                });
            }
            if name == "log" && ctx.imp {
                return Ok(dot(id("__B"), "log"));
            }
            return fail(format!("unbound {name}"));
        };
        match b.kind {
            Kind::Acc | Kind::Src => Ok(if ctx.imp { rtc("snapshot", vec![id(b.js)]) } else { call(id(b.js), vec![]) }),
            Kind::Comp => fail(format!("component {name} used as a value")),
            _ => Ok(id(b.js)),
        }
    }
    /// R-f-4: error class names → a JS array of their values; `undefined`: every failure.
    fn classes(&mut self, names: Option<&[String]>, env: Env) -> R<E> {
        let Some(names) = names else { return Ok(undef()) };
        let mut out = vec![];
        for n in names {
            out.push(match n.as_str() {
                "Error" => id("Error"),
                "Panic" => rt("PANIC"),
                _ => self.reference(n, env, &reactive())?,
            });
        }
        Ok(E::Arr(out))
    }

    // ---- imperative scope
    fn stmts(&mut self, ss: &[Stmt], env0: Env, ctx: &Ctx, return_last: bool) -> R<Vec<S>> {
        let env = self.new_env(Some(env0));
        let sub = Ctx { tail: false, ..ctx.clone() };
        let mut out = vec![];
        for (i, s) in ss.iter().enumerate() {
            // AC-1 / R-f-4: a statement-level `await … catch` is a try around the await
            let c = match &s.k {
                StmtKind::Let { e: c @ Expr { k: ExprKind::Catch { e: inner, .. }, .. }, .. } | StmtKind::Expr(c @ Expr { k: ExprKind::Catch { e: inner, .. }, .. }) if matches!(&inner.k, ExprKind::Await { .. }) => Some(c),
                _ => None,
            };
            if let Some(Expr { k: ExprKind::Catch { e: ce, name: cn, classes, alt }, .. }) = c {
                let v = if let StmtKind::Let { name, .. } = &s.k { Some(mg(name)) } else { None };
                let set = |x: E| match &v {
                    Some(v) => sexpr(E::Assign("=", Box::new(id(v.clone())), Box::new(x))),
                    None => sexpr(x),
                };
                let h = self.new_env(Some(env));
                if let Some(n) = cn {
                    self.set(h, n, val(mg(n)));
                }
                let ev = cn.as_ref().map(|n| mg(n)).unwrap_or("__e".into());
                if let Some(v) = &v {
                    out.push(S::Let(v.clone(), None));
                }
                let body = self.expr(ce, env, &sub)?;
                let cls = self.classes(classes.as_deref(), env)?;
                let a = self.expr(alt, h, &sub)?;
                out.push(S::Try {
                    block: vec![set(body)],
                    param: Some(ev.clone()),
                    handler: Some(vec![S::IfThen(not(rtc("isA", vec![id(ev.clone()), cls])), Box::new(S::Throw(id(ev)))), set(a)]),
                    fin: None,
                });
                if let (Some(v), StmtKind::Let { name, .. }) = (&v, &s.k) {
                    self.set(env, name, val(v.clone()));
                }
                continue;
            }
            match &s.k {
                StmtKind::Let { name, e, .. } => {
                    let x = self.expr(e, env, &sub)?;
                    out.push(S::Let(mg(name), Some(x)));
                    self.set(env, name, val(mg(name)));
                }
                StmtKind::Expr(e) => {
                    let x = self.expr(e, env, &sub)?;
                    out.push(if return_last && i == ss.len() - 1 { S::Return(Some(x)) } else { sexpr(x) });
                }
                StmtKind::Return(e) => {
                    let x = match e {
                        Some(e) => Some(self.expr(e, env, &sub)?),
                        None => None,
                    };
                    out.push(S::Return(x));
                }
                StmtKind::Throw(e) => out.push(S::Throw(self.expr(e, env, &sub)?)),
                StmtKind::Write { target, e } | StmtKind::Optimistic { target, e } => {
                    let optimistic = matches!(&s.k, StmtKind::Optimistic { .. });
                    let mut keys = vec![];
                    for p in &target.path {
                        keys.push(match p {
                            PathSeg::Name(n) => str(n.clone()),
                            PathSeg::Expr(x) => self.expr(x, env, &sub)?,
                        });
                    }
                    let has_path = !keys.is_empty();
                    let keys = E::Arr(keys);
                    let v = self.expr(e, env, &sub)?;
                    if ctx.dynamic && !target.is_ctx() && self.lookup(env, &target.name).is_none() {
                        out.push(sexpr(rtc("dset", vec![str(target.name.clone()), keys, v, E::Bool(optimistic)])));
                        continue;
                    }
                    let w = if target.is_ctx() {
                        let c = self.reference(&target.name, env, &Ctx { dynamic: ctx.dynamic, ..Ctx::default() })?;
                        dot(rtc("use", vec![c, id("__o")]), "w")
                    } else {
                        match self.lookup(env, &target.name).and_then(|b| b.w) {
                            Some(w) => id(w),
                            None => return fail(format!("W-1: {} is not a source", target.name)),
                        }
                    };
                    out.push(sexpr(if optimistic {
                        call(dot(w, "guess"), if has_path { vec![v, keys] } else { vec![v] })
                    } else if has_path {
                        call(dot(w, "path"), vec![keys, v])
                    } else {
                        call(dot(w, "set"), vec![v])
                    }));
                }
                StmtKind::Refresh(n) | StmtKind::Affects(n) => {
                    let get = match self.lookup(env, n) {
                        Some(b) => id(b.js),
                        None => dot(rtc("lookup", vec![str(n.clone())]), "get"),
                    };
                    out.push(sexpr(if matches!(&s.k, StmtKind::Refresh(_)) { rtc("refresh", vec![str(n.clone()), get]) } else { rtc("affects", vec![get]) }));
                }
                StmtKind::Action(body) => {
                    let b = self.stmts(body, env, &Ctx { imp: true, gen: true, dynamic: ctx.dynamic, ..Ctx::default() }, false)?;
                    let gen = E::Func(Box::new(Func { name: None, params: vec![], directives: vec![], body: b, is_async: false, generator: true }));
                    out.push(sexpr(call(rtc("action", vec![gen]), vec![])));
                }
                StmtKind::Sif { c, t, f } => {
                    let c = self.expr(c, env, &sub)?;
                    let t = self.stmts(t, env, ctx, false)?;
                    let f = self.stmts(f, env, ctx, false)?;
                    out.push(S::If(c, t, Some(f)));
                }
                StmtKind::Try { body, catch_name, catch_classes, handler, fin } => {
                    let block = self.stmts(body, env, ctx, false)?;
                    let (param, handler) = match handler {
                        Some(hs) => {
                            let h = self.new_env(Some(env));
                            if let Some(n) = catch_name {
                                self.set(h, n, val(mg(n)));
                            }
                            let v = catch_name.as_ref().map(|n| mg(n)).unwrap_or("__e".into());
                            let mut hb = vec![];
                            if let Some(cc) = catch_classes {
                                // R-f-6: a typed catch rethrows other classes
                                let cls = self.classes(Some(cc), env)?;
                                hb.push(S::IfThen(not(rtc("isA", vec![id(v.clone()), cls])), Box::new(S::Throw(id(v.clone())))));
                            }
                            hb.append(&mut self.stmts(hs, h, ctx, false)?);
                            (Some(v), Some(hb))
                        }
                        None => (None, None),
                    };
                    let fin = match fin {
                        Some(f) => Some(self.stmts(f, env, ctx, false)?),
                        None => None,
                    };
                    out.push(S::Try { block, param, handler, fin });
                }
            }
        }
        Ok(out)
    }

    // ---- views: JSX, which Solid's compiler lowers for the DOM, the server and the test renderer
    /// A view: a fragment of children. Text is a string child; `{e}` is `{__rt.show(e)}` (a value is formatted, a view is
    /// inserted); control flow is Solid's components. What is a hole, a scope or a memo is the compiler's to decide. An empty
    /// view is null, not `<></>` (an empty array loses its slot in the universal renderer: DV-13).
    fn markup(&mut self, ms: &[Markup], env: Env) -> R<E> {
        if ms.is_empty() {
            return Ok(E::Null);
        }
        Ok(E::Jsx(Box::new(Jsx::Frag(self.kids(ms, env)?, None))))
    }
    fn kids(&mut self, ms: &[Markup], env: Env) -> R<Vec<Child>> {
        let mut out = vec![];
        for m in ms {
            if let Some(c) = self.child(m, env)? {
                out.push(c);
            }
        }
        Ok(out)
    }
    /// A region's body as a child: its declarations, then its view (a function body, so it is owned where it is called).
    /// An equation a guess sits over (AC-3): not deferred, not a draft, not a wrapped server fn.
    fn guessed_eq(&self, name: &str, e: &Expr, deferred: bool) -> bool {
        self.u.optimistic.contains(name) && !deferred && !matches!(&e.k, ExprKind::Draft { .. }) && unwrap_server(e).is_none()
    }
    fn region_fn(&mut self, decls: &[Decl], view: &[Markup], env: Env, param: Option<String>, narrow: Option<(String, Bind)>, bind_name: Option<String>) -> R<E> {
        let inner = self.new_env(Some(env));
        let mut pre = vec![];
        if let Some((n, b)) = narrow {
            pre.push(konst(b.js.clone(), id("__item")));
            self.set(inner, &n, b);
        }
        if let Some(n) = bind_name {
            self.set(inner, &n, val(mg(&n)));
        }
        pre.append(&mut self.block(decls, view, inner, None, false)?);
        Ok(arrow_block(param.into_iter().map(P::Id).collect(), pre, false))
    }
    fn region(&mut self, decls: &[Decl], view: &[Markup], env: Env) -> R<Child> {
        let f = self.region_fn(decls, view, env, None, None, None)?;
        Ok(Child::Expr(call(f, vec![])))
    }
    fn attr(&mut self, name: &str, e: &Expr, env: Env) -> R<(String, AttrValue)> {
        let x = self.expr(e, env, &Ctx { imp: is_handler(name), ..Ctx::default() })?;
        Ok((name.to_string(), AttrValue::Expr(x)))
    }
    fn child(&mut self, m: &Markup, env: Env) -> R<Option<Child>> {
        let re = reactive();
        let line = m.line;
        let el = |name: JsxName, attrs, children, self_closing| Child::Jsx(Jsx::El { name, attrs, children, self_closing, line });
        Ok(Some(match &m.kind {
            MarkupKind::Text(s) => Child::Expr(str(s.clone())),
            // CSS-4: removed; the stylesheet is the module's
            MarkupKind::Style(_) => return Ok(None),
            MarkupKind::Read(e) => Child::Expr(rtc("show", vec![self.expr(e, env, &re)?])),
            MarkupKind::El { tag, children, .. } if tag.is_empty() => {
                if children.is_empty() {
                    Child::Text("null".into())
                } else {
                    Child::Jsx(Jsx::Frag(self.kids(children, env)?, line))
                }
            }
            MarkupKind::El { tag, attrs, children } if tag.as_bytes()[0].is_ascii_uppercase() => {
                let Some(b) = self.lookup(env, tag).filter(|b| b.kind == Kind::Comp) else { return fail(format!("unknown component {tag}")) };
                let mut xs = vec![];
                for a in attrs {
                    xs.push(self.attr(&a.name, &a.e, env)?);
                }
                if children.is_empty() {
                    xs.push(("children".into(), AttrValue::Expr(E::Arr(vec![]))));
                    el(JsxName::Ident(b.js), xs, vec![], true)
                } else {
                    el(JsxName::Ident(b.js), xs, self.kids(children, env)?, false)
                }
            }
            MarkupKind::El { tag, attrs, children } => {
                let mut xs = vec![];
                for a in attrs {
                    xs.push(match (&self.style_hash, a.name.as_str(), &a.e.k) {
                        (Some(h), "class", ExprKind::Lit(Lit::Str(v))) => ("class".to_string(), AttrValue::Expr(str(format!("{v} {h}")))),
                        (Some(h), "class", _) => {
                            let h = h.clone();
                            ("class".to_string(), AttrValue::Expr(rtc("scopedClass", vec![self.expr(&a.e, env, &re)?, str(h)])))
                        }
                        _ => self.attr(&a.name, &a.e, env)?,
                    });
                }
                // CSS-2: every HTML element of the view
                if let Some(h) = &self.style_hash {
                    if !attrs.iter().any(|a| a.name == "class") {
                        xs.push(("class".into(), AttrValue::Str(h.clone())));
                    }
                }
                if VOID_TAGS.contains(&tag.as_str()) {
                    el(JsxName::Ident(tag.clone()), xs, vec![], true)
                } else {
                    el(JsxName::Ident(tag.clone()), xs, self.kids(children, env)?, false)
                }
            }
            MarkupKind::Mif { c, t, t_decls, f, f_decls } => {
                let narrowed = if let ExprKind::Id(n) = &c.k { self.lookup(env, n).filter(|b| matches!(b.kind, Kind::Acc | Kind::Src)).map(|b| (n.clone(), b)) } else { None };
                let narrow = narrowed.map(|(n, b)| {
                    let mut nb = bind(Kind::Acc, format!("n${n}"));
                    nb.w = b.w;
                    (n, nb)
                });
                let tf = self.region_fn(t_decls, t, env, Some("__item".into()), narrow, None)?;
                let when = self.expr(c, env, &re)?;
                let fb = self.region_fn(f_decls, f, env, None, None, None)?;
                el(JsxName::Ident("Show".into()), vec![("when".into(), AttrValue::Expr(when)), ("fallback".into(), AttrValue::Expr(call(fb, vec![])))], vec![Child::Expr(tf)], false)
            }
            MarkupKind::Mfor { name, xs, decls, body } => {
                let b = self.region_fn(decls, body, env, Some(mg(name)), None, Some(name.clone()))?;
                let each = self.expr(xs, env, &re)?;
                el(JsxName::Ident("For".into()), vec![("each".into(), AttrValue::Expr(each))], vec![Child::Expr(b)], false)
            }
            MarkupKind::Loading { on, fallback, decls, body } => {
                let mut xs = vec![];
                if let Some(o) = on {
                    xs.push(("on".to_string(), AttrValue::Expr(self.expr(o, env, &re)?)));
                }
                let fb = self.markup(fallback, env)?;
                xs.push(("fallback".into(), AttrValue::Expr(fb)));
                let r = self.region(decls, body, env)?;
                el(JsxName::Ident("Loading".into()), xs, vec![r], false)
            }
            // RG-8: Solid's Portal (the web's, or the test renderer's)
            MarkupKind::Portal { to, decls, body } => {
                let mut xs = vec![];
                if let Some(t) = to {
                    xs.push(("mount".to_string(), AttrValue::Expr(self.expr(t, env, &re)?)));
                }
                let r = self.region(decls, body, env)?;
                el(JsxName::Member("__rt".into(), "Portal".into()), xs, vec![r], false)
            }
            MarkupKind::Errored { fallback, decls, body, err_name, classes } => {
                let fb_env = self.new_env(Some(env));
                if let Some(n) = err_name {
                    self.set(fb_env, n, bind(Kind::Acc, mg(n)));
                }
                let fm = self.markup(fallback, fb_env)?;
                let p = err_name.as_ref().map(|n| mg(n)).unwrap_or("__err".into());
                let fallback = ("fallback".to_string(), AttrValue::Expr(arrow(&[&p], fm)));
                let b = self.region(decls, body, env)?;
                // R-f-4: a typed boundary passes other classes up
                match classes {
                    Some(cs) => {
                        let cls = self.classes(Some(cs), env)?;
                        el(JsxName::Member("__rt".into(), "TypedErrored".into()), vec![("classes".into(), AttrValue::Expr(cls)), fallback], vec![b], false)
                    }
                    None => el(JsxName::Ident("Errored".into()), vec![fallback], vec![b], false),
                }
            }
        }))
    }
}

fn static_op(op: &str) -> &'static str {
    const OPS: &[&str] = &["+", "-", "*", "/", "%", "**", "<", ">", "<=", ">=", "===", "!==", "&&", "||", "??", "!", "typeof", "in", "instanceof", "==", "!="];
    OPS.iter().find(|o| **o == op).copied().unwrap_or_else(|| panic!("operator {op}"))
}

/// The reference drops every line `return null;` of an instantiating fn's body (its block's empty view).
/// `to` as an import specifier from the module at `from` (both paths as the loader keyed them)
fn relative(from: &str, to: &str) -> String {
    let (f, t): (Vec<&str>, Vec<&str>) = (from.split('/').collect(), to.split('/').collect());
    let dir = &f[..f.len() - 1];
    let common = dir.iter().zip(&t).take_while(|(a, b)| a == b).count();
    let up = dir.len() - common;
    let rest = t[common..].join("/");
    if up == 0 { format!("./{rest}") } else { format!("{}{rest}", "../".repeat(up)) }
}

/// The statements `out[from..]` lower the declaration on `.rx` line `line` (the program's layout keeps it, CP-1c).
fn at(out: &mut [S], from: usize, line: usize) {
    for s in &mut out[from..] {
        *s = S::At(line, Box::new(std::mem::replace(s, S::Block(vec![]))));
    }
}

fn strip_return_null(ss: &mut Vec<S>) {
    ss.retain(|s| !matches!(s, S::Return(Some(E::Null))));
    for s in ss.iter_mut() {
        let mut s = s;
        while let S::At(_, inner) = s {
            s = inner;
        }
        if let S::Func(f) = s {
            strip_return_null(&mut f.body);
        }
    }
}

// ---------------------------------------------------------------- CP-1b: the views through Solid's compiler

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Target {
    Universal,
    Dom,
    Ssr,
}

pub struct Lowered {
    pub code: String,
    /// a source map from `code` onto the module's `.rx` text, when one was asked for
    pub map: Option<String>,
}

/// Each module's JSX → JavaScript for `target` (`ref/compile/jsx.ts`): dom and ssr with hydration; universal over the
/// renderer `module_name`. With `rx` (the module's `.rx` path and text), the output carries a source map onto it. CP-1c:
/// Solid's positions are the program's layout; each maps to the `.rx` line it was lowered from (`oxc::Build::lines`), at
/// that line's first non-blank column. An error's `(line:column)` is reported as its `.rx` line.
pub fn lower_view(module: &[S], filename: &str, target: Target, module_name: &str, rx: Option<(&str, &str)>) -> Result<Lowered, String> {
    use solidjs_compiler::{compile_program, CompileOptions, Generate};
    let alloc = oxc_allocator::Allocator::default();
    let build = crate::oxc::Build::new(&alloc);
    let program = build.program(module);
    let lines = build.lines();
    let src = program.source_text;
    let options = CompileOptions {
        filename: Some(filename.strip_suffix(".mjs").map(|s| format!("{s}.jsx")).unwrap_or(filename.to_string())),
        generate: match target {
            Target::Universal => Generate::Universal,
            Target::Dom => Generate::Dom,
            Target::Ssr => Generate::Ssr,
        },
        hydratable: target != Target::Universal,
        module_name: module_name.to_string(),
        source_map: rx.is_some(),
        ..CompileOptions::default()
    };
    let line_of = |pos: u32| lines.get(pos as usize).copied().filter(|l| *l > 0);
    let out = compile_program(&alloc, program, src, &options).map_err(|e| {
        // the blank layout is one line: a position is `(1:offset+1)`
        let re = regex::Regex::new(r"\(1:(\d+)\)").unwrap();
        re.replace_all(e.message(), |c: &regex::Captures| match c[1].parse::<u32>().ok().and_then(|n| line_of(n.saturating_sub(1))) {
            Some(l) => format!("({}:{l})", rx.map(|r| r.0).unwrap_or(filename)),
            None => c[0].to_string(),
        })
        .into_owned()
    })?;
    let map = match (rx, out.source_map) {
        (Some((path, text)), Some(json)) => {
            let layout = oxc_sourcemap::SourceMap::from_json_string(&json).map_err(|e| format!("source map: {e:?}"))?;
            let indent: Vec<u32> = text.lines().map(|l| l.chars().take_while(|c| c.is_whitespace()).map(|c| c.len_utf16() as u32).sum()).collect();
            let mut b = oxc_sourcemap::SourceMapBuilder::default();
            b.set_file(filename);
            let id = b.add_source_and_content(path, text);
            let mut last = None;
            for t in layout.get_tokens() {
                let Some(l) = t.get_source_id().and_then(|_| line_of(t.get_src_col())) else { continue };
                let at = (t.get_dst_line(), t.get_dst_col(), l);
                if last.is_some_and(|(dl, _, ll)| dl == at.0 && ll == l) {
                    continue; // the same .rx line, further along the same output line
                }
                last = Some(at);
                b.add_token(at.0, at.1, l - 1, indent.get(l as usize - 1).copied().unwrap_or(0), Some(id), None);
            }
            Some(b.into_sourcemap().to_json_string())
        }
        _ => None,
    };
    Ok(Lowered { code: out.code, map })
}
