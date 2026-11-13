//! TY-1 (spec/13), ported from `ref/types/project.ts`: a checked program projected to TSX that TypeScript checks, and that an
//! editor asks for types (TY-1c). The projection is the reference's, text for text (`ref/crate.ts --project` diffs them);
//! what the crate adds is where each piece came from (CP-8): every name, member, literal and written type the projection
//! copies from the `.rx` is a mapping, generated offset to source offset, of text that is the same on both sides.

use crate::ast::*;
use crate::modules::ModuleSet;
use crate::parse::JsDecl;
use crate::signature::{ExportSig, ModSig};
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::LazyLock;

/// The helpers every projection imports (`__`), and the prelude's names (`len`, `map`, …): `ref/types/project.ts`'s PRELUDE.
pub const PRELUDE: &str = include_str!("prelude.ts");

static ROW_WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^((?:io|pending|lane|fails\([^)]*\))\s+)+").unwrap());
static SOURCE_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^source\s+").unwrap());
const BUILTINS: [&str; 13] = ["len", "str", "map", "filter", "sum", "fail", "fetch", "every", "indexOf", "log", "until", "onSettled", "onFlush"];
fn builtin(n: &str) -> bool {
    BUILTINS.contains(&n)
}

/// One mapping: `len` bytes at `gen` in the projection are the same text as `len` bytes at `src` in the `.rx`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mapping {
    pub gen: u32,
    pub src: u32,
    pub len: u32,
}

/// A coarser correspondence: `glen` bytes at `gen` in the projection were written for the `len` bytes at `src` (an
/// expression, a statement, a declaration's line), not the same text. An editor maps through it what falls between
/// mappings (a type error on `(a + b)` starts at its parenthesis); it is listed innermost first.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Range {
    pub gen: u32,
    pub glen: u32,
    pub src: u32,
    pub len: u32,
}

/// Text with the mappings of the pieces in it that came from the source.
#[derive(Default, Clone)]
struct Code {
    s: String,
    m: Vec<Mapping>,
    r: Vec<Range>,
}
impl Code {
    fn new() -> Self {
        Code::default()
    }
    fn of(s: &str) -> Self {
        Code { s: s.to_string(), m: vec![], r: vec![] }
    }
    /// All of this text was written for `sp`.
    fn from(mut self, sp: Span) -> Self {
        if !sp.is_none() {
            self.r.push(Range { gen: 0, glen: self.s.len() as u32, src: sp.start, len: sp.end - sp.start });
        }
        self
    }
    fn t(mut self, s: &str) -> Self {
        self.s.push_str(s);
        self
    }
    fn c(mut self, o: Code) -> Self {
        self.push(o);
        self
    }
    fn push(&mut self, o: Code) {
        let at = self.s.len() as u32;
        self.m.extend(o.m.into_iter().map(|m| Mapping { gen: m.gen + at, ..m }));
        self.r.extend(o.r.into_iter().map(|r| Range { gen: r.gen + at, ..r }));
        self.s.push_str(&o.s);
    }
    /// `text`, mapped to `src` when it was found there.
    fn at(mut self, text: &str, src: Option<usize>) -> Self {
        if let Some(src) = src {
            self.m.push(Mapping { gen: self.s.len() as u32, src: src as u32, len: text.len() as u32 });
        }
        self.s.push_str(text);
        self
    }
    fn join(xs: Vec<Code>, sep: &str) -> Code {
        let mut out = Code::new();
        for (i, x) in xs.into_iter().enumerate() {
            if i > 0 {
                out.s.push_str(sep);
            }
            out.push(x);
        }
        out
    }
}

/// The reference's `W`: lines, each with the `.rx` line it came from.
#[derive(Default)]
struct W {
    buf: Code,
    lines: Vec<usize>,
    last: usize,
}
impl W {
    fn new() -> Self {
        W { buf: Code::new(), lines: vec![], last: 1 }
    }
    /// A statement or a markup item carries no line of its own (0): it is on its declaration's.
    fn emit(&mut self, text: Code, line: usize) {
        if line != 0 {
            self.last = line;
        }
        let n = text.s.matches('\n').count() + 1;
        if !self.lines.is_empty() {
            self.buf.s.push('\n');
        }
        self.buf.push(text);
        for _ in 0..n {
            self.lines.push(if line != 0 { line } else { self.last });
        }
    }
}

/// One projected file: its TSX, for each of its lines the `.rx` line it came from, and its mappings onto the `.rx`.
pub struct Projected {
    pub path: String,
    pub code: String,
    pub lines: Vec<usize>,
    pub rx: String,
    pub mappings: Vec<Mapping>,
    pub ranges: Vec<Range>,
}

/// A written type, without its row words (`pending T` → `T`, 04 CN-4a) or a context's `source` (RG-7c).
fn type_text(t: &Option<String>) -> Option<String> {
    let t = t.as_ref()?;
    let x = ROW_WORDS.replace(t, "");
    let x = SOURCE_WORD.replace(&x, "");
    let x = crate::parse::js_trim(&x);
    if x.is_empty() {
        None
    } else {
        Some(x.to_string())
    }
}
/// `JSON.stringify` of a literal.
fn j(l: &Lit) -> String {
    match crate::ast::lit_json(l) {
        None => "undefined".into(),
        Some(v) => serde_json::to_string(&v).unwrap(),
    }
}
fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}
fn is_handler(a: &str) -> bool {
    crate::awaits::is_handler(a)
}
fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// The file a module projects to: `main.rx` → `main.rx.tsx`, so `import … from "./lib.rx"` resolves to the projection.
pub fn projected_path(rx: &str) -> String {
    format!("{rx}.tsx")
}

pub fn project_modules(set: &ModuleSet) -> Vec<Projected> {
    project_modules_with(set, None)
}
/// `prelude`: where the projections import the prelude from, in place of `__prelude.ts` at the program's root (an editor
/// writes it once, where the project's own `@solidjs/web` resolves).
pub fn project_modules_with(set: &ModuleSet, prelude: Option<&str>) -> Vec<Projected> {
    let mut out = vec![];
    let mut js_stubs: IndexMap<String, IndexSet<String>> = IndexMap::new();
    for path in &set.order {
        let p = &set.programs[path];
        let src = set.sources.get(path).map(|s| s.as_str()).unwrap_or("");
        let mut pr = Proj { w: W::new(), set, path, src, js_stubs: &mut js_stubs, used: IndexSet::new(), declared: HashSet::new(), prelude };
        pr.module(p);
        let w = pr.w;
        out.push(Projected { path: projected_path(path), code: w.buf.s, lines: w.lines, rx: path.clone(), mappings: w.buf.m, ranges: w.buf.r });
    }
    for (rx, sig) in &set.signatures {
        out.push(Projected { path: format!("{rx}.d.ts"), code: signature_stub(sig), lines: vec![], rx: rx.strip_suffix(".rx").map(|s| format!("{s}.d.rx")).unwrap_or(rx.clone()), mappings: vec![], ranges: vec![] });
    }
    for (dts, decls) in &set.declarations {
        let path = dts.strip_suffix(".d.rx").map(|s| format!("{s}.d.ts")).unwrap_or(dts.clone());
        out.push(Projected { path, code: declaration_file(decls), lines: vec![], rx: dts.clone(), mappings: vec![], ranges: vec![] });
    }
    for (m, names) in js_stubs {
        let code = names.iter().map(|n| if n == "default" { "declare const __d: any; export default __d;".to_string() } else { format!("export declare const {n}: any;") }).collect::<Vec<_>>().join("\n");
        out.push(Projected { path: m.clone(), code, lines: vec![], rx: m, mappings: vec![], ranges: vec![] });
    }
    out
}

/// Mappings whose two sides are not the same text: none, when the projection keeps its promise (CP-8).
pub fn unverified(p: &Projected, src: &str) -> Vec<Mapping> {
    p.mappings
        .iter()
        .filter(|m| {
            let g = p.code.get(m.gen as usize..(m.gen + m.len) as usize);
            let s = src.get(m.src as usize..(m.src + m.len) as usize);
            g.is_none() || g != s
        })
        .copied()
        .collect()
}

/// TY-4c: an `.rx` module read by its signature (MO-9) is typed by the `.d.ts` TypeScript emits from its projection (TY-1c);
/// none is shipped here, so its exports are `any`.
fn signature_stub(sig: &ModSig) -> String {
    sig.exports
        .iter()
        .map(|(n, x)| match x {
            ExportSig::Type => format!("export type {n} = any;"),
            ExportSig::Comp { .. } => format!("export declare function {n}(props: any): any;"),
            _ => format!("export declare const {n}: any;"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}
/// MO-8: a `.d.rx` as TypeScript's `.d.ts` for the same JS module.
fn declaration_file(decls: &[JsDecl]) -> String {
    decls
        .iter()
        .map(|d| match d {
            JsDecl::Type { text, .. } => format!("export {text}"),
            JsDecl::Error { name, .. } => format!("export declare class {name}$ extends Error {{}}\nexport declare const {name}: (message?: string) => {name}$;\nexport type {name} = {name}$;"),
            JsDecl::Fn { name, params, ptypes, ret, .. } => {
                let ps = params.iter().enumerate().map(|(i, n)| match ptypes.get(i).and_then(|t| t.as_ref()) {
                    Some(t) => format!("{n}: {t}"),
                    None => n.clone(),
                });
                format!("export declare function {name}({}): {};", ps.collect::<Vec<_>>().join(", "), ret.as_deref().unwrap_or("any"))
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

/// `JSON.stringify(stmts).includes('"k":"await"')`: an `await` anywhere in them, closures included.
fn has_await(ss: &[Stmt]) -> bool {
    stmts_json(ss).to_string().contains("\"k\":\"await\"")
}
/// The names an expression reads, in the order the reference's walk meets them; a `pre` reads the previous instant, so
/// nothing under it orders.
fn free_ids(e: &Expr) -> IndexSet<String> {
    fn go(v: &Value, out: &mut IndexSet<String>) {
        match v {
            Value::Array(xs) => xs.iter().for_each(|x| go(x, out)),
            Value::Object(o) => {
                if o.get("k").and_then(|k| k.as_str()) == Some("id") {
                    if let Some(n) = o.get("name").and_then(|n| n.as_str()) {
                        out.insert(n.to_string());
                    }
                }
                if o.get("k").and_then(|k| k.as_str()) == Some("pre") {
                    return;
                }
                for (k, x) in o {
                    if k != "k" {
                        go(x, out);
                    }
                }
            }
            _ => {}
        }
    }
    let mut out = IndexSet::new();
    go(&e.to_json(), &mut out);
    out
}

struct Proj<'a> {
    w: W,
    set: &'a ModuleSet,
    path: &'a str,
    src: &'a str,
    js_stubs: &'a mut IndexMap<String, IndexSet<String>>,
    /// prelude names the module reads
    used: IndexSet<String>,
    /// names the module declares (they shadow the prelude)
    declared: HashSet<String>,
    prelude: Option<&'a str>,
}

impl Proj<'_> {
    // ---- where a name or a written type is, in the source ----
    /// The first whole-word `word` in `within`, at or after `from`.
    fn find(&self, word: &str, within: Span, from: usize) -> Option<usize> {
        if within.is_none() || word.is_empty() {
            return None;
        }
        let (a, b) = ((within.start as usize).max(from), within.end as usize);
        let hay = self.src.get(a..b)?;
        let wordy = word.starts_with(is_word);
        hay.match_indices(word).find_map(|(i, _)| {
            let before = hay[..i].chars().next_back();
            let after = hay[i + word.len()..].chars().next();
            (!wordy || (!before.is_some_and(is_word) && !after.is_some_and(is_word))).then_some(a + i)
        })
    }
    /// `word` as found in `within` from `*from` on, mapped; `*from` moves past it.
    fn name(&self, word: &str, within: Span, from: &mut usize) -> Code {
        let at = self.find(word, within, *from);
        if let Some(a) = at {
            *from = a + word.len();
        }
        Code::new().at(word, at)
    }
    /// A written type's text (row words dropped), found after `*from`.
    fn ty(&self, t: &str, within: Span, from: &mut usize) -> Code {
        self.name(t, within, from)
    }
    /// `: T`, or nothing.
    fn ann(&self, t: &Option<String>, within: Span, from: &mut usize) -> Code {
        match type_text(t) {
            Some(x) => Code::of(": ").c(self.ty(&x, within, from)),
            None => Code::new(),
        }
    }
    /// `n` or `n: T` for a parameter list of names and their written types (no row words to drop).
    fn params(&self, params: &[String], ptypes: &[Option<String>], within: Span, from: &mut usize) -> Code {
        let ps = params
            .iter()
            .enumerate()
            .map(|(i, n)| {
                let c = self.name(n, within, from);
                match ptypes.get(i).and_then(|t| t.as_ref()) {
                    Some(t) => c.t(": ").c(self.ty(t, within, from)),
                    None => c,
                }
            })
            .collect();
        Code::join(ps, ", ")
    }

    fn module(&mut self, p: &Program) {
        let saved = std::mem::replace(&mut self.w, W::new());
        self.decls(&p.decls, "", true);
        if !p.view.is_empty() {
            self.w.emit(Code::of("export const __view = ("), p.view[0].line.unwrap_or(1));
            self.markup(&p.view, "  ");
            self.w.emit(Code::of(");"), p.view[p.view.len() - 1].line.unwrap_or(1));
        }
        let body = std::mem::replace(&mut self.w, saved);
        let prelude: Vec<String> = self.used.iter().filter(|n| !self.declared.contains(*n)).cloned().collect();
        let types: Vec<&str> = ["View", "Panic"].into_iter().filter(|n| !self.declared.contains(*n)).collect();
        let rel = self.prelude.map(|p| p.to_string()).unwrap_or_else(|| self.rel("__prelude.ts"));
        let mut head = format!("import * as __ from \"{rel}\"; import type {{ {} }} from \"{rel}\";", types.join(", "));
        if !prelude.is_empty() {
            head += &format!(" import {{ {} }} from \"{rel}\";", prelude.join(", "));
        }
        self.w.emit(Code::of(&head), 0);
        if !body.lines.is_empty() {
            self.w.buf.s.push('\n');
            self.w.buf.push(body.buf);
            self.w.lines.extend(body.lines);
        }
    }
    /// A path relative to this module's directory, for the prelude (at the root of the program).
    fn rel(&self, f: &str) -> String {
        let depth = self.path.split('/').count() as i64 - 1 - (self.set.entry.split('/').count() as i64 - 1);
        if depth > 0 {
            "../".repeat(depth as usize) + f
        } else {
            format!("./{f}")
        }
    }

    // ---- declarations, in dependency order (functions are hoisted; values are not) ----
    fn decls(&mut self, ds: &[Decl], ind: &str, top: bool) {
        let ex = |d: &Decl| if top && d.exported() { "export " } else { "" };
        for d in ds {
            if let Some(n) = d.name() {
                self.declared.insert(n.to_string());
            }
        }
        for d in ds {
            let sp = d.span();
            let mut at = sp.start as usize;
            match d {
                Decl::Import { .. } => self.import_decl(d, ind),
                Decl::TypeDecl { text, line, .. } => {
                    let c = Code::of(ind).t(ex(d)).c(self.name(text, sp, &mut at));
                    self.w.emit(c, *line);
                }
                Decl::Error { name, params, ptypes, msg, line, .. } => {
                    let fields = params.iter().enumerate().map(|(i, n)| format!("declare {n}: {};", ptypes.get(i).and_then(|t| t.as_deref()).unwrap_or("any"))).collect::<Vec<_>>().join(" ");
                    let nm = self.name(name, sp, &mut at);
                    let ps = self.params(params, ptypes, sp, &mut at);
                    let body = match msg {
                        Some(m) => Code::of("{ void (").c(self.expr(m, false, None)).t(&format!("); return new {name}$(); }}")),
                        None => Code::of(&format!("new {name}$()")),
                    };
                    let c = Code::of(&format!("{ind}{}class {name}$ extends Error {{ {fields} }}\n{ind}{}const ", ex(d), ex(d)))
                        .c(nm)
                        .t(" = (")
                        .c(ps)
                        .t(&format!("): {name}$ => "))
                        .c(body)
                        .t(&format!(";\n{ind}{}type {name} = {name}$;", ex(d)));
                    self.w.emit(c, *line);
                }
                Decl::Context { name, ty, dflt, line, .. } => {
                    let nm = self.name(name, sp, &mut at);
                    let t = match type_text(ty) {
                        Some(x) => self.ty(&x, sp, &mut at),
                        None => Code::of("any"),
                    };
                    let dv = dflt.as_ref().map(|e| self.expr(e, false, None)).unwrap_or_default();
                    let c = Code::of(ind).t(ex(d)).t("const ").c(nm).t(" = __.ctx<").c(t).t(">(").c(dv).t(");");
                    self.w.emit(c, *line);
                }
                _ => {}
            }
        }
        for d in ds {
            let sp = d.span();
            let mut at = sp.start as usize;
            match d {
                Decl::Fn { name, params, decls, tail, line, ret, .. } => {
                    let nm = self.name(name, sp, &mut at);
                    let ps = Code::join(
                        params
                            .iter()
                            .map(|p| {
                                let n = self.name(&p.name, sp, &mut at);
                                n.c(self.ann(&p.ty, sp, &mut at))
                            })
                            .collect(),
                        ", ",
                    );
                    let r = self.ann(ret, sp, &mut at);
                    let head = Code::of(ind).t(ex(d)).t("function ").c(nm).t("(").c(ps).t(")").c(r);
                    if decls.is_empty() {
                        let t = self.expr(tail, false, None);
                        self.w.emit(head.t(" { return ").c(t).t("; }"), *line);
                        continue;
                    }
                    self.w.emit(head.t(" {"), *line);
                    self.decls(decls, &format!("{ind}  "), false);
                    let t = self.expr(tail, false, None);
                    self.w.emit(Code::of(&format!("{ind}  return ")).c(t).t(&format!(";\n{ind}}}")), *line);
                }
                Decl::Component { name, props, decls, view, line, props_type, .. } => {
                    let nm = self.name(name, sp, &mut at);
                    let pn = self.name(props, sp, &mut at);
                    let pt = match props_type {
                        Some(t) => Code::of(": ").c(self.ty(t, sp, &mut at)),
                        None => Code::of(": any"),
                    };
                    self.w.emit(Code::of(ind).t(ex(d)).t("function ").c(nm).t("(").c(pn).c(pt).t(") {"), *line);
                    self.decls(decls, &format!("{ind}  "), false);
                    self.w.emit(Code::of(&format!("{ind}  return (")), *line);
                    self.markup(view, &format!("{ind}    "));
                    self.w.emit(Code::of(&format!("{ind}  );\n{ind}}}")), *line);
                }
                Decl::Action { name, params, ptypes, body, line, .. } | Decl::Server { name, params, ptypes, body, line, .. } => {
                    let nm = self.name(name, sp, &mut at);
                    let ps = self.params(params, ptypes, sp, &mut at);
                    let r = match d {
                        Decl::Server { ret: Some(r), .. } => Code::of(": Promise<").c(self.ty(r, sp, &mut at)).t(">"),
                        _ => Code::new(),
                    };
                    self.w.emit(Code::of(ind).t(ex(d)).t("async function ").c(nm).t("(").c(ps).t(")").c(r).t(" {"), *line);
                    self.stmts(body, &format!("{ind}  "));
                    self.w.emit(Code::of(&format!("{ind}}}")), *line);
                    if matches!(d, Decl::Server { .. }) {
                        // SF-6a, statically where the types are known
                        self.w.emit(Code::of(&format!("{ind}__.wire({name}, true);")), *line);
                    }
                }
                _ => {}
            }
        }
        for d in self.order(ds) {
            let sp = d.span();
            let mut at = sp.start as usize;
            match d {
                Decl::Source { name, init, line, ty, .. } => {
                    let nm = self.name(name, sp, &mut at);
                    let a = self.ann(ty, sp, &mut at);
                    let v = match type_text(ty) {
                        Some(t) => Code::of(&format!("__.typed<{t}>(")).c(self.expr(init, false, None)).t(")"),
                        None => Code::of("__.src(").c(self.expr(init, false, None)).t(")"),
                    };
                    self.w.emit(Code::of(ind).t(ex(d)).t("const ").c(nm).c(a).t(" = ").c(v).t(";").from(sp), *line);
                }
                Decl::Eq { name, e, line, ty, .. } => {
                    let nm = self.name(name, sp, &mut at);
                    let a = self.ann(ty, sp, &mut at);
                    let v = Code::of("__.eq(").c(self.expr(e, false, Some(name))).t(", true)");   // R-1: no promise without `await`
                    self.w.emit(Code::of(ind).t(ex(d)).t("const ").c(nm).c(a).t(" = ").c(v).t(";").from(sp), *line);
                }
                Decl::Provide { name, e, line, .. } => {
                    let nm = self.name(name, sp, &mut at);
                    let v = self.expr(e, false, None);
                    self.w.emit(Code::of(&format!("{ind}__.provide(")).c(nm).t(", ").c(v).t(");"), *line);
                }
                _ => {}
            }
        }
        for d in ds {
            if let Decl::Effect { inputs, body, line, .. } = d {
                self.w.emit(Code::of(&format!("{ind}__.effect(() => {{")), *line);
                for (i, e) in inputs.iter().enumerate() {
                    let v = self.expr(e, false, None);
                    self.w.emit(Code::of(&format!("{ind}  const ${i} = ")).c(v).t(";"), *line);
                }
                self.stmts(body, &format!("{ind}  "));
                self.w.emit(Code::of(&format!("{ind}}});")), *line);
            }
        }
    }

    fn import_decl(&mut self, d: &Decl, ind: &str) {
        let Decl::Import { names, from, line, resolved, declared, .. } = d else { return };
        let sp = d.span();
        for n in names {
            if builtin(&n.name) {
                // the prelude's own (`import { log } from "./prelude"`)
                self.declared.remove(&n.alias);
            }
        }
        for n in names.iter().filter(|n| builtin(&n.name)) {
            self.used.insert(n.name.clone());
        }
        let rest: Vec<&ImportName> = names.iter().filter(|n| !builtin(&n.name)).collect();
        if rest.is_empty() {
            return;
        }
        if resolved.is_none() && declared.is_none() {
            // a JS module with no declaration: `any`
            let key = self.mod_path(from) + ".ts";
            let s = self.js_stubs.entry(key).or_default();
            for n in &rest {
                s.insert(n.name.clone());
            }
        }
        let mut at = sp.start as usize;
        let def = rest.iter().find(|n| n.name == "default").map(|n| self.name(&n.alias, sp, &mut at));
        let parts: Vec<Code> = rest
            .iter()
            .filter(|n| n.name != "default")
            .map(|n| {
                if n.name == n.alias {
                    self.name(&n.name, sp, &mut at)
                } else {
                    let a = self.name(&n.name, sp, &mut at);
                    a.t(" as ").c(self.name(&n.alias, sp, &mut at))
                }
            })
            .collect();
        let mut c = Code::of(ind).t("import ");
        let has_parts = !parts.is_empty();
        if let Some(def) = def {
            c = c.c(def).t(if has_parts { ", " } else { "" });
        }
        if has_parts {
            c = c.t("{ ").c(Code::join(parts, ", ")).t(" }");
        }
        let q = js_str(from);
        let fa = self.find(&q[1..q.len() - 1], sp, at).map(|a| a - 1).filter(|a| self.src[*a..].starts_with(&q));
        c = c.t(" from ").at(&q, fa).t(";");
        self.w.emit(c, *line);
    }
    /// A JS import's module, from the program's root (where the stubs are written).
    fn mod_path(&self, from: &str) -> String {
        let mut parts: Vec<&str> = self.path.split('/').collect();
        parts.pop();
        for seg in from.split('/') {
            if seg == "." || seg.is_empty() {
                continue;
            }
            if seg == ".." {
                parts.pop();
            } else {
                parts.push(seg);
            }
        }
        parts.join("/")
    }
    /// E-7: values in dependency order (C-1 makes it a DAG; a `pre` reads the previous instant, so it is no edge).
    fn order<'d>(&self, ds: &'d [Decl]) -> Vec<&'d Decl> {
        let vals: Vec<&Decl> = ds.iter().filter(|d| matches!(d, Decl::Source { .. } | Decl::Eq { .. } | Decl::Provide { .. })).collect();
        let mut by_name: IndexMap<&str, usize> = IndexMap::new();
        for (i, d) in vals.iter().enumerate() {
            if !matches!(d, Decl::Provide { .. }) {
                by_name.insert(d.name().unwrap(), i);
            }
        }
        fn visit<'d>(i: usize, vals: &[&'d Decl], by_name: &IndexMap<&str, usize>, done: &mut Vec<bool>, busy: &mut Vec<bool>, out: &mut Vec<&'d Decl>) {
            if done[i] || busy[i] {
                return;
            }
            busy[i] = true;
            let e = match vals[i] {
                Decl::Eq { e, .. } | Decl::Provide { e, .. } => e,
                Decl::Source { init, .. } => init,
                _ => unreachable!(),
            };
            for n in free_ids(e) {
                if let Some(&t) = by_name.get(n.as_str()) {
                    if t != i {
                        visit(t, vals, by_name, done, busy, out);
                    }
                }
            }
            busy[i] = false;
            done[i] = true;
            out.push(vals[i]);
        }
        let (mut done, mut busy, mut out) = (vec![false; vals.len()], vec![false; vals.len()], vec![]);
        for i in 0..vals.len() {
            visit(i, &vals, &by_name, &mut done, &mut busy, &mut out);
        }
        out
    }

    // ---- imperative scope ----
    fn stmts(&mut self, ss: &[Stmt], ind: &str) {
        for s in ss {
            let sp = s.span;
            let mut at = sp.start as usize;
            match &s.k {
                StmtKind::Let { name, e, ty } => {
                    let nm = self.name(name, sp, &mut at);
                    let a = self.ann(ty, sp, &mut at);
                    let v = self.expr(e, true, None);
                    self.w.emit(Code::of(&format!("{ind}let ")).c(nm).c(a).t(" = ").c(v).t(";").from(sp), 0);
                }
                StmtKind::Expr(e) => {
                    let v = self.expr(e, true, None);
                    self.w.emit(Code::of(ind).c(v).t(";").from(sp), 0);
                }
                StmtKind::Return(e) => {
                    let v = match e {
                        Some(e) => Code::of(" ").c(self.expr(e, true, None)),
                        None => Code::new(),
                    };
                    self.w.emit(Code::of(&format!("{ind}return")).c(v).t(";").from(sp), 0);
                }
                StmtKind::Throw(e) => {
                    let v = self.expr(e, true, None);
                    self.w.emit(Code::of(&format!("{ind}throw ")).c(v).t(";").from(sp), 0);
                }
                StmtKind::Write { target, e } | StmtKind::Optimistic { target, e } => {
                    let t = self.target(target, sp, &mut at);
                    let v = self.expr(e, true, None);
                    self.w.emit(Code::of(&format!("{ind}__.set(")).c(t).t(")(").c(v).t(");").from(sp), 0);
                }
                StmtKind::Refresh(n) | StmtKind::Affects(n) => {
                    let nm = self.name(n, sp, &mut at);
                    self.w.emit(Code::of(&format!("{ind}void ")).c(nm).t(";"), 0);
                }
                StmtKind::Action(body) => {
                    self.w.emit(Code::of(&format!("{ind}void (async () => {{")), 0);
                    self.stmts(body, &format!("{ind}  "));
                    self.w.emit(Code::of(&format!("{ind}}})();")), 0);
                }
                StmtKind::Sif { c, t, f } => {
                    let v = self.expr(c, true, None);
                    self.w.emit(Code::of(&format!("{ind}if (")).c(v).t(") {"), 0);
                    self.stmts(t, &format!("{ind}  "));
                    self.w.emit(Code::of(&format!("{ind}}} else {{")), 0);
                    self.stmts(f, &format!("{ind}  "));
                    self.w.emit(Code::of(&format!("{ind}}}")), 0);
                }
                StmtKind::Try { body, catch_name, catch_classes, handler, fin } => {
                    self.w.emit(Code::of(&format!("{ind}try {{")), 0);
                    self.stmts(body, &format!("{ind}  "));
                    if let Some(h) = handler {
                        let bind = match catch_name {
                            Some(n) => format!(" const {n} = __e as {};", catch_classes.as_ref().map(|c| c.join(" | ")).unwrap_or("Error".into())),
                            None => String::new(),
                        };
                        self.w.emit(Code::of(&format!("{ind}}} catch (__e) {{{bind}")), 0);
                        self.stmts(h, &format!("{ind}  "));
                    }
                    if let Some(f) = fin {
                        self.w.emit(Code::of(&format!("{ind}}} finally {{")), 0);
                        self.stmts(f, &format!("{ind}  "));
                    }
                    self.w.emit(Code::of(&format!("{ind}}}")), 0);
                }
            }
        }
    }
    fn target(&mut self, t: &Target, within: Span, at: &mut usize) -> Code {
        let nm = self.name(&t.name, within, at);
        let mut s = if t.is_ctx() { Code::of("__.use(").c(nm).t(")") } else { nm };
        for p in &t.path {
            s = match p {
                PathSeg::Name(n) => {
                    let m = self.name(n, within, at);
                    s.t(".").c(m)
                }
                PathSeg::Expr(e) => s.t("[").c(self.expr(e, true, None)).t("]"),
            };
        }
        s
    }

    // ---- expressions: `imp` imperative scope (a real `await`); `me` the equation being defined (its own `pre`) ----
    fn expr(&mut self, e: &Expr, imp: bool, me: Option<&str>) -> Code {
        self.expr_text(e, imp, me).from(e.span)
    }
    fn expr_text(&mut self, e: &Expr, imp: bool, me: Option<&str>) -> Code {
        let sp = e.span;
        let src_at = |text: &str| -> Option<usize> { (!sp.is_none() && sp.text(self.src) == text).then_some(sp.start as usize) };
        macro_rules! go {
            ($x:expr) => {
                self.expr($x, imp, me)
            };
        }
        match &e.k {
            ExprKind::Lit(l) => {
                let t = j(l);
                let at = src_at(&t);
                Code::new().at(&t, at)
            }
            ExprKind::Id(n) => {
                if builtin(n) && !self.declared.contains(n) {
                    self.used.insert(n.clone());
                }
                let at = src_at(n);
                Code::new().at(n, at)
            }
            ExprKind::Pre { name, init } => {
                let mut from = sp.start as usize;
                if me == Some(name.as_str()) {
                    match init {
                        Some(i) => Code::of("__.pre(").c(go!(i)).t(")"),
                        None => Code::of("__.pre<any>()"),
                    }
                } else {
                    let nm = self.name(name, sp, &mut from);
                    let iv = init.as_ref().map(|i| go!(i)).unwrap_or_default();
                    Code::of("__.pre<typeof ").c(nm).t(">(").c(iv).t(")")
                }
            }
            ExprKind::Peek(x) | ExprKind::Latest(x) => go!(x),
            ExprKind::Pending(x) => Code::of("__.pending(").c(go!(x)).t(")"),
            ExprKind::Await { e: x, init, stream } => {
                if imp {
                    return Code::of("(await ").c(go!(x)).t(")");
                }
                let v = Code::of(if *stream { "__.awaitS(" } else { "__.await_(" }).c(go!(x)).t(")");
                match init {
                    Some(i) => Code::of("__.first(").c(v).t(", ").c(go!(i)).t(")"),
                    None => v,
                }
            }
            ExprKind::If { c, t, f } => Code::of("(").c(go!(c)).t(" ? ").c(go!(t)).t(" : ").c(go!(f)).t(")"),
            ExprKind::Throw(x) => Code::of("__.raise(").c(go!(x)).t(")"),
            ExprKind::Catch { e: x, name, classes, alt } => {
                let v = go!(x);
                let a = go!(alt);
                Code::of("__.caught(").c(v).t(&format!(", ({}: {}) => ", name.as_deref().unwrap_or("__e"), classes.as_ref().map(|c| c.join(" | ")).unwrap_or("Error".into()))).c(a).t(")")
            }
            ExprKind::Tpl(parts) => {
                let mut c = Code::of("`");
                for p in parts {
                    match p {
                        TplPart::Str(s) => c = c.t(&escape_tpl(s)),
                        TplPart::Expr(x) => c = c.t("${").c(go!(x)).t("}"),
                    }
                }
                c.t("`")
            }
            ExprKind::Member { o, p, opt } => {
                // `.p` with its dot, so that a position just after the dot (what is being typed) is mapped too
                let dot = format!(".{p}");
                let at = (!sp.is_none() && sp.text(self.src).ends_with(dot.as_str())).then(|| sp.end as usize - dot.len());
                go!(o).t(if *opt { "?" } else { "" }).at(&dot, at)
            }
            ExprKind::Index { o, i, opt } => go!(o).t(if *opt { "?.[" } else { "[" }).c(go!(i)).t("]"),
            ExprKind::StyleMap { css, .. } => Code::of(&class_map(css)),
            ExprKind::Call { f, args } => {
                let fc = go!(f);
                let a = args.iter().map(|a| go!(a)).collect();
                fc.t("(").c(Code::join(a, ", ")).t(")")
            }
            ExprKind::Arr(items) => {
                let a = items.iter().map(|a| go!(a)).collect();
                Code::of("[").c(Code::join(a, ", ")).t("]")
            }
            ExprKind::Rec(fields) => {
                let fs = fields
                    .iter()
                    .map(|f| match f {
                        Field::Spread(x) => Code::of("...").c(go!(x)),
                        Field::Kv { key, v } => Code::of(&js_str(key)).t(": ").c(go!(v)),
                    })
                    .collect();
                Code::of("({ ").c(Code::join(fs, ", ")).t(" })")
            }
            ExprKind::Spread(x) => Code::of("...").c(go!(x)),
            ExprKind::Omit { e: x, keys } => {
                let ks: String = keys.iter().map(|k| format!(", {}", js_str(k))).collect();
                Code::of("__.omit(").c(go!(x)).t(&ks).t(")")
            }
            ExprKind::Fn { params, body, stmts } => {
                let mut from = sp.start as usize;
                let ps = Code::join(params.iter().map(|p| self.name(p, sp, &mut from)).collect(), ", ");
                let Some(ss) = stmts else {
                    return Code::of("((").c(ps).t(") => ").c(self.expr(body, imp, me)).t(")");
                };
                let inner = self.nested(|me| me.stmts(ss, "  "));
                Code::of(if has_await(ss) { "(async (" } else { "((" }).c(ps).t(") => {\n").c(inner).t("\n})")
            }
            ExprKind::ServerFn { params, ptypes, ret, body } => {
                let mut from = sp.start as usize;
                let ps = self.params(params, ptypes, sp, &mut from);
                let r = match ret {
                    Some(r) => Code::of(": Promise<").c(self.ty(r, sp, &mut from)).t(">"),
                    None => Code::new(),
                };
                let inner = self.nested(|me| me.stmts(body, "  "));
                // SF-1d: an async function, its wire checked (TY-5a)
                Code::of("((__f) => (__.wire(__f, true), __f))(async (").c(ps).t(")").c(r).t(" => {\n").c(inner).t("\n})")
            }
            ExprKind::Draft { seed, body } => {
                let s = go!(seed);
                let inner = self.nested(|me| me.stmts(body, "  "));
                Code::of("__.draft(").c(s).t(", (d) => {\n").c(inner).t("\n})")
            }
            ExprKind::Use(n) => {
                let mut from = sp.start as usize + 3;
                Code::of("__.use(").c(self.name(n, sp, &mut from)).t(")")
            }
            ExprKind::Bin { op, l, r } => {
                let o = match op.as_str() {
                    "==" => "===",
                    "!=" => "!==",
                    o => o,
                };
                Code::of("(").c(go!(l)).t(&format!(" {o} ")).c(go!(r)).t(")")
            }
            ExprKind::Un { op, e: x } => Code::of("(").t(op).c(go!(x)).t(")"),
        }
    }
    /// What `f` writes, as one piece of text (a closure's body).
    fn nested(&mut self, f: impl FnOnce(&mut Self)) -> Code {
        let saved = std::mem::replace(&mut self.w, W::new());
        f(self);
        std::mem::replace(&mut self.w, saved).buf
    }

    // ---- views: JSX over Solid's JSX types ----
    fn markup(&mut self, ms: &[Markup], ind: &str) {
        if ms.is_empty() {
            self.w.emit(Code::of(&format!("{ind}null")), 0);
            return;
        }
        self.w.emit(Code::of(&format!("{ind}<>")), ms[0].line.unwrap_or(0));
        for m in ms {
            self.child(m, &format!("{ind}  "));
        }
        self.w.emit(Code::of(&format!("{ind}</>")), ms[ms.len() - 1].line.unwrap_or(0));
    }
    fn region(&mut self, decls: &[Decl], view: &[Markup], ind: &str, line: usize) {
        if decls.is_empty() {
            self.markup(view, ind);
            return;
        }
        self.w.emit(Code::of(&format!("{ind}(() => {{")), line);
        self.decls(decls, &format!("{ind}  "), false);
        self.w.emit(Code::of(&format!("{ind}  return (")), line);
        self.markup(view, &format!("{ind}    "));
        self.w.emit(Code::of(&format!("{ind}  );\n{ind}}})()")), line);
    }
    fn child(&mut self, m: &Markup, ind: &str) {
        let line = m.line.unwrap_or(0);
        let sp = m.span;
        let i2 = format!("{ind}  ");
        match &m.kind {
            MarkupKind::Text(s) => self.w.emit(Code::of(&format!("{ind}{{{}}}", js_str(s))), line),
            MarkupKind::Style(_) => {}
            MarkupKind::Read(e) => {
                let v = self.expr(e, false, None);
                self.w.emit(Code::of(&format!("{ind}{{")).c(v).t("}").from(sp), line);
            }
            MarkupKind::El { tag, attrs, children } => {
                if tag.is_empty() {
                    self.w.emit(Code::of(&format!("{ind}<>")), line);
                    for c in children {
                        self.child(c, &i2);
                    }
                    self.w.emit(Code::of(&format!("{ind}</>")), line);
                    return;
                }
                let tag_at = (!sp.is_none() && sp.text(self.src)[1..].starts_with(tag.as_str())).then_some(sp.start as usize + 1);
                let mut a = Code::new();
                for at in attrs {
                    // 07 §4: a spread, as JSX's
                    if at.name == "..." {
                        a = a.t(" {...").c(self.expr(&at.e, false, None)).t("}");
                        continue;
                    }
                    let name_at = (!at.span.is_none() && at.span.text(self.src) == at.name).then_some(at.span.start as usize);
                    a = a.t(" ").at(&at.name, name_at);
                    if !matches!(at.e.k, ExprKind::Lit(Lit::Bool(true))) {
                        a = a.t("={").c(self.expr(&at.e, is_handler(&at.name), None)).t("}");
                    }
                }
                let open = Code::of(&format!("{ind}<")).at(tag, tag_at).c(a);
                if children.is_empty() {
                    self.w.emit(open.t(" />"), line);
                    return;
                }
                self.w.emit(open.t(">"), line);
                for c in children {
                    self.child(c, &i2);
                }
                let close_at = self.src.get(..sp.end as usize).filter(|s| !sp.is_none() && s.ends_with(&format!("</{tag}>"))).map(|_| sp.end as usize - tag.len() - 1);
                self.w.emit(Code::of(&format!("{ind}</")).at(tag, close_at).t(">"), line);
            }
            MarkupKind::Mif { c, t, t_decls, f, f_decls } => {
                let v = self.expr(c, false, None);
                self.w.emit(Code::of(&format!("{ind}{{")).c(v).t(" ? ("), line);
                self.region(t_decls, t, &i2, line);
                self.w.emit(Code::of(&format!("{ind}) : (")), line);
                self.region(f_decls, f, &i2, line);
                self.w.emit(Code::of(&format!("{ind})}}")), line);
            }
            MarkupKind::Mfor { name, xs, decls, body } => {
                let mut from = sp.start as usize;
                let nm = self.name(name, sp, &mut from);
                let v = self.expr(xs, false, None);
                self.w.emit(Code::of(&format!("{ind}{{__.each(")).c(v).t(", (").c(nm).t(") => ("), line);
                self.region(decls, body, &i2, line);
                self.w.emit(Code::of(&format!("{ind}))}}")), line);
            }
            MarkupKind::Loading { on, fallback, decls, body } => {
                if let Some(on) = on {
                    let v = self.expr(on, false, None);
                    self.w.emit(Code::of(&format!("{ind}{{void ")).c(v).t("}"), line);
                }
                self.w.emit(Code::of(&format!("{ind}{{(")), line);
                self.markup(fallback, &i2);
                self.w.emit(Code::of(&format!("{ind})}}{{(")), line);
                self.region(decls, body, &i2, line);
                self.w.emit(Code::of(&format!("{ind})}}")), line);
            }
            MarkupKind::Portal { to, decls, body } => {
                if let Some(to) = to {
                    let v = self.expr(to, false, None);
                    self.w.emit(Code::of(&format!("{ind}{{void ")).c(v).t("}"), line);
                }
                self.w.emit(Code::of(&format!("{ind}{{(")), line);
                self.region(decls, body, &i2, line);
                self.w.emit(Code::of(&format!("{ind})}}")), line);
            }
            MarkupKind::Errored { fallback, decls, body, err_name, classes } => {
                let head = format!("{ind}{{(({}: {}) => (", err_name.as_deref().unwrap_or("__err"), classes.as_ref().map(|c| c.join(" | ")).unwrap_or("Error".into()));
                self.w.emit(Code::of(&head), line);
                self.markup(fallback, &i2);
                self.w.emit(Code::of(&format!("{ind}))(null!)}}{{(")), line);
                self.region(decls, body, &i2, line);
                self.w.emit(Code::of(&format!("{ind})}}")), line);
            }
        }
    }
}

/// A template literal's text: `` ` ``, `\` and `${` escaped.
fn escape_tpl(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '`' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '$' if it.peek() == Some(&'{') => {
                out.push_str("\\${");
                it.next();
            }
            _ => out.push(c),
        }
    }
    out
}

/// 07 CSS-5: TSRX's class map, as its typecheck projection writes it — each class a `string`.
fn class_map(css: &str) -> String {
    use solidjs_compiler::style::*;
    let r = compile_style(StyleInput { css, location: StyleLocation { filename: "class-map.tsrx", line: 1, column: 19 }, elements: &[], kind: StyleKind::Expression, minify: false });
    let Ok(r) = r else { return "({} as const)".into() };
    if r.class_map.is_empty() {
        return "({} as const)".into();
    }
    let fields: Vec<String> = r.class_map.into_iter().map(|c| format!("{}: \"\" as string", js_str(&c.class_name))).collect();
    format!("({{ {} }} as const)", fields.join(", "))
}
