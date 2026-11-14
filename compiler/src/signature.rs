//! MO-3 / MO-9: a module's signature — what an importer is checked against — and its `.d.rx` text, printed and read back
//! (`ref/src/signature.ts`). One export per line:
//!
//!   export source products: pending fails(Error) = …        a question (ST-5); `:= …` a plain source
//!   export discount: pending fails(Error)                   an equation; `io` when bound to an io value
//!   export pure fn qtyOf(id) rejects(Offline) instantiates  a fn (`ref` params; RG-6); `rejects(…)` absent: none
//!   export server fn add(id) rejects(Error)                 12 SF-1 (`server pure fn` when no io)
//!   export action setCoupon
//!   export error NotFound(id)
//!   export type Product
//!   export context theme: source pending Theme = …          rows, then the written type; `= …` a default
//!   export component Panel(props: { title; children: catches(Error) provides(./theme.rx#theme) }) fails(Error) uses(…) shape(…)

use crate::content::Shape;
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use std::sync::LazyLock;

pub const HOLD: &str = "$hold";

/// What a catch or a boundary discharges: named classes, or every failure.
#[derive(Debug, Clone, PartialEq)]
pub enum Catch {
    All,
    Set(IndexSet<String>),
}
impl Catch {
    pub fn of(classes: &Option<Vec<String>>) -> Catch {
        match classes {
            Some(c) => Catch::Set(c.iter().cloned().collect()),
            None => Catch::All,
        }
    }
    pub fn caught(&self, cls: &str) -> bool {
        match self {
            Catch::All => true,
            Catch::Set(s) => cls != "Error" && s.contains(cls),
        }
    }
    pub fn is_empty_set(&self) -> bool {
        matches!(self, Catch::Set(s) if s.is_empty())
    }
}

#[derive(Debug, Clone)]
pub struct PropSig {
    pub f: Catch,
    pub p: Catch,
    pub rendered: bool,
    pub action: Option<(Catch, String)>,
    /// MO-11c: a JS component's prop that takes a component value
    pub component: bool,
}
#[derive(Debug, Clone)]
pub struct Own {
    pub cls: String,
    pub what: String,
    pub at: Option<String>,
}
/// MO-3: an exported component as an importer sees it.
#[derive(Debug, Clone)]
pub struct CompSig {
    pub own: Vec<Own>,
    pub requires: Vec<String>,
    pub props: IndexMap<String, PropSig>,
    pub shape: Option<Shape>,
    /// O-3: the props it stores where they outlive it — "module", or a provision's key.
    pub stored: IndexMap<String, Vec<String>>,
}
#[derive(Debug, Clone)]
pub struct SigParam {
    pub name: String,
    pub r#ref: bool,
    pub ty: Option<String>,
}
#[derive(Debug, Clone)]
pub enum ExportSig {
    Source { question: bool, rows: Vec<String>, fails: Vec<String> },
    Eq { rows: Vec<String>, fails: Vec<String>, io: bool },
    Fn { params: Vec<SigParam>, instantiating: bool, rows: Vec<String>, fails: Vec<String>, rejects: Vec<String> },
    Action,
    Server { io: bool, params: Vec<String>, rejects: Vec<String> },
    ErrClass { params: Vec<String> },
    Comp { sig: CompSig },
    Context { key: String, source: bool, dflt: bool, rows: Vec<String>, fails: Vec<String>, ty: Option<String> },
    Type,
}
#[derive(Debug, Clone)]
pub struct ModSig {
    pub file: String,
    pub exports: IndexMap<String, ExportSig>,
}

fn sorted(xs: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut v: Vec<String> = xs.into_iter().collect();
    v.sort();
    v
}
fn cls(c: &Catch) -> String {
    match c {
        Catch::All => "*".into(),
        Catch::Set(s) if s.is_empty() => "nothing".into(),
        Catch::Set(s) => sorted(s.iter().cloned()).join(" | "),
    }
}
fn rows(r: &[String], fails: &[String]) -> String {
    let mut out: Vec<String> = ["io", "pending", "lane"].iter().filter(|x| r.iter().any(|y| y == *x)).map(|x| x.to_string()).collect();
    if !fails.is_empty() {
        out.push(format!("fails({})", sorted(fails.iter().cloned()).join(" | ")));
    }
    out.join(" ")
}
fn dir(p: &str) -> String {
    let parts: Vec<&str> = p.split('/').collect();
    parts[..parts.len() - 1].join("/")
}
/// `[path, name]` at the last `#` (`slice(0, -1)` and the whole key when there is none, as the reference has it).
fn split_hash(key: &str) -> (String, String) {
    match key.rfind('#') {
        Some(i) => (key[..i].to_string(), key[i + 1..].to_string()),
        None => {
            let mut p: Vec<char> = key.chars().collect();
            p.pop();
            (p.into_iter().collect(), key.to_string())
        }
    }
}
/// A context key relative to the module whose signature names it (`./theme.rx#theme`).
/// O-3: the props a component stores where they outlive it, and where.
fn retains_text(file: &str, st: &IndexMap<String, Vec<String>>) -> String {
    let mut fs: Vec<&String> = st.keys().collect();
    fs.sort();
    let xs: Vec<String> = fs.into_iter().flat_map(|f| st[f].iter().map(move |t| format!("{}: {}", if f == "*" { "...props" } else { f }, if t == "module" { t.clone() } else { rel_key(file, t) }))).collect();
    if xs.is_empty() { String::new() } else { format!(" retains({})", xs.join(", ")) }
}
fn rel_key(from: &str, key: &str) -> String {
    if key == HOLD {
        return "loading".into();
    }
    let (path, name) = split_hash(key);
    let d = dir(from);
    let a: Vec<&str> = d.split('/').filter(|x| !x.is_empty()).collect();
    let b: Vec<&str> = path.split('/').filter(|x| !x.is_empty()).collect();
    let mut i = 0;
    while i < a.len() && (i as i64) < b.len() as i64 - 1 && a[i] == b[i] {
        i += 1;
    }
    let up = a.len() - i;
    let rel = format!("{}{}", if up > 0 { "../".repeat(up) } else { "./".into() }, b[i.min(b.len())..].join("/"));
    format!("{}#{}", if path.starts_with('/') == from.starts_with('/') { rel } else { path }, name)
}
fn abs_key(from: &str, rel: &str) -> String {
    if rel == "loading" {
        return HOLD.into();
    }
    let (path, name) = split_hash(rel);
    if !path.starts_with('.') {
        return rel.into();
    }
    let lead = if from.starts_with('/') { "/" } else { "" };
    let d = dir(from);
    let mut out: Vec<String> = d.split('/').filter(|x| !x.is_empty()).map(String::from).collect();
    for seg in path.split('/') {
        if seg == "." || seg.is_empty() {
            continue;
        }
        if seg == ".." {
            out.pop();
        } else {
            out.push(seg.into());
        }
    }
    format!("{}{}#{}", lead, out.join("/"), name)
}
fn shape_text(s: &Option<Shape>) -> String {
    let Some(s) = s else { return String::new() };
    let mut parts = vec![];
    if !s.roots.is_empty() {
        parts.push(format!("roots {}", s.roots.join(" ")));
    }
    if s.closes_p {
        parts.push("closes-p".into());
    }
    if s.a {
        parts.push("a".into());
    }
    if s.form {
        parts.push("form".into());
    }
    for c in &s.children_at {
        parts.push(format!("children-at {}", c.join(" ")));
    }
    if parts.is_empty() { String::new() } else { format!(" shape({})", parts.join("; ")) }
}
fn with_rows(head: String, r: String) -> String {
    if r.is_empty() { head } else { format!("{}: {}", head, r) }
}

fn line(file: &str, name: &str, x: &ExportSig) -> String {
    match x {
        ExportSig::Source { question, rows: r, fails } => format!("{} {} …", with_rows(format!("export source {}", name), rows(r, fails)), if *question { "=" } else { ":=" }),
        ExportSig::Eq { rows: r, fails, io } => {
            let mut rr = r.clone();
            if *io {
                rr.insert(0, "io".into());
            }
            with_rows(format!("export {}", name), rows(&rr, fails))
        }
        ExportSig::Fn { params, instantiating, rows: r, fails, rejects } => {
            let ps: Vec<String> = params.iter().map(|p| format!("{}{}{}", if p.r#ref { "ref " } else { "" }, p.name, p.ty.as_ref().map(|t| format!(": {}", t)).unwrap_or_default())).collect();
            format!(
                "{}{}{}",
                with_rows(format!("export pure fn {}({})", name, ps.join(", ")), rows(r, fails)),
                if rejects.is_empty() { String::new() } else { format!(" rejects({})", rejects.join(" | ")) },
                if *instantiating { " instantiates" } else { "" }
            )
        }
        ExportSig::Server { io, params, rejects } => format!(
            "export server {}fn {}({}){}",
            if *io { "" } else { "pure " },
            name,
            params.join(", "),
            if rejects.is_empty() { String::new() } else { format!(" rejects({})", sorted(rejects.iter().cloned()).join(" | ")) }
        ),
        ExportSig::Action => format!("export action {}", name),
        ExportSig::ErrClass { params } => format!("export error {}({})", name, params.join(", ")),
        ExportSig::Type => format!("export type {}", name),
        ExportSig::Context { source, dflt, rows: r, fails, ty, .. } => {
            let t: Vec<String> = [if *source { "source".to_string() } else { String::new() }, rows(r, fails), ty.clone().unwrap_or_default()].into_iter().filter(|x| !x.is_empty()).collect();
            let t = t.join(" ");
            format!("export context {}{}{}", name, if t.is_empty() { String::new() } else { format!(": {}", t) }, if *dflt { " = …" } else { "" })
        }
        ExportSig::Comp { sig: s } => {
            let props: Vec<String> = s
                .props
                .iter()
                .map(|(f, v)| {
                    let mut parts = vec![];
                    if !v.rendered {
                        parts.push("unrendered".to_string());
                    } else {
                        if !v.f.is_empty_set() {
                            parts.push(format!("catches({})", cls(&v.f)));
                        }
                        if !v.p.is_empty_set() {
                            parts.push(format!(
                                "provides({})",
                                match &v.p {
                                    Catch::All => "*".to_string(),
                                    Catch::Set(ks) => ks.iter().map(|k| rel_key(file, k)).collect::<Vec<_>>().join(", "),
                                }
                            ));
                        }
                    }
                    if let Some((af, an)) = &v.action {
                        parts.push(format!("action {} catches({})", an, cls(af)));
                    }
                    format!("{}{}", if f == "*" { "...props" } else { f }, if parts.is_empty() { String::new() } else { format!(": {}", parts.join(" ")) })
                })
                .collect();
            let own: IndexSet<String> = s.own.iter().map(|o| o.cls.clone()).collect();
            format!(
                "export component {}(props: {}){}{}{}{}",
                name,
                if props.is_empty() { "{}".to_string() } else { format!("{{ {} }}", props.join("; ")) },
                if own.is_empty() { String::new() } else { format!(" fails({})", sorted(own).join(" | ")) },
                if s.requires.is_empty() { String::new() } else { format!(" uses({})", s.requires.iter().map(|k| rel_key(file, k)).collect::<Vec<_>>().join(", ")) },
                retains_text(file, &s.stored),
                shape_text(&s.shape)
            )
        }
    }
}

pub fn print_signature(sig: &ModSig) -> String {
    let mut out = vec![format!("// {} — signature (09-modules MO-3). Sources are read-only to importers (MO-2).", sig.file.split('/').last().unwrap_or(""))];
    for (n, x) in &sig.exports {
        out.push(line(&sig.file, n, x));
    }
    out.join("\n") + "\n"
}

// ---------------------------------------------------------------- reading it back (MO-9)
#[derive(Debug)]
pub struct SignatureError(pub String);

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}
re!(ROW, r"^(io|pending|lane|fails\(([^)]*)\))$");
re!(TRAIL_COMMENT, r"\s//.*$");
re!(LEAD_COMMENT, r"^//.*$");
re!(T_TYPE, r"^type\s+([A-Za-z_$][A-Za-z0-9_$]*)");
re!(T_ACTION, r"^action\s+([A-Za-z_$][A-Za-z0-9_$]*)$");
re!(T_ERROR, r"^error\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\(([^)]*)\))?$");
re!(T_SOURCE, r"^source\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::([^=].*?)?)??\s*(:?=)\s*…$");
re!(T_SERVER, r"^server\s+(pure\s+)?fn\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*(?:rejects\(([^)]*)\))?$");
re!(T_FN, r"^pure\s+fn\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\((.*?)\)\s*(?::\s*((?:(?:io|pending|lane|fails\([^)]*\))\s*)*))?\s*(?:rejects\(([^)]*)\))?\s*(instantiates)?$");
re!(T_CONTEXT, r"^context\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*(.*?))?\s*(=\s*…)?$");
re!(T_COMP, r"^component\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(props:\s*(\{.*?\}|\{\})\)(.*)$");
re!(T_EQ, r"^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*(.*))?$");
re!(P_ACTION, r"(^|[^A-Za-z0-9_])action\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+catches\(([^)]*)\)");
re!(P_UNRENDERED, r"(^|[^A-Za-z0-9_])unrendered([^A-Za-z0-9_]|$)");
re!(P_CATCHES, r"(^|[^A-Za-z0-9_])catches\(([^)]*)\)");
re!(P_PROVIDES, r"(^|[^A-Za-z0-9_])provides\(([^)]*)\)");
re!(C_FAILS, r"(^|[^A-Za-z0-9_])fails\(([^)]*)\)");
re!(C_USES, r"(^|[^A-Za-z0-9_])uses\(([^)]*)\)");
re!(C_RETAINS, r"(^|[^A-Za-z0-9_])retains\(([^)]*)\)");
re!(C_SHAPE, r"(^|[^A-Za-z0-9_])shape\(([^)]*)\)");
re!(SOURCE_WORD, r"^source([^A-Za-z0-9_]|$)");
re!(REF_PARAM, r"^ref\s");

fn classes_of(s: &str) -> Vec<String> {
    s.split('|').map(|x| crate::parse::js_trim(x).to_string()).filter(|x| !x.is_empty() && x != "nothing").collect()
}
fn catch_of(s: &str) -> Catch {
    if crate::parse::js_trim(s) == "*" { Catch::All } else { Catch::Set(classes_of(s).into_iter().collect()) }
}
/// Split on `sep` outside parentheses and braces.
fn split(s: &str, sep: char) -> Vec<String> {
    let mut out = vec![];
    let mut depth = 0i64;
    let mut cur = String::new();
    for ch in s.chars() {
        if "({[<".contains(ch) {
            depth += 1;
        }
        if ")}]>".contains(ch) {
            depth -= 1;
        }
        if ch == sep && depth == 0 {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(ch);
        }
    }
    if !crate::parse::js_trim(&cur).is_empty() {
        out.push(cur);
    }
    out.iter().map(|x| crate::parse::js_trim(x).to_string()).filter(|x| !x.is_empty()).collect()
}
struct RowWords {
    rows: Vec<String>,
    fails: Vec<String>,
    rest: String,
}
fn row_words(s: &str) -> RowWords {
    let words = split(s, ' ');
    let mut rows = vec![];
    let mut fails = vec![];
    let mut i = 0;
    while i < words.len() {
        let Some(m) = ROW.captures(&words[i]) else { break };
        if let Some(f) = m.get(2) {
            fails = classes_of(f.as_str());
        } else {
            rows.push(m[1].to_string());
        }
        i += 1;
    }
    RowWords { rows, fails, rest: words[i..].join(" ") }
}
/// SV-7d's words (MO-9b; a JS component's, MO-11a).
pub fn content_shape_of(s: Option<&str>) -> Result<Shape, String> {
    let mut sh = Shape::default();
    let Some(s) = s else { return Ok(sh) };
    for p in s.split(';').map(crate::parse::js_trim).filter(|x| !x.is_empty()) {
        let ws: Vec<String> = p.split(char::is_whitespace).filter(|x| !x.is_empty()).map(String::from).collect();
        let (w, rest) = (ws[0].as_str(), ws[1..].to_vec());
        match w {
            "roots" => sh.roots = rest,
            "closes-p" => sh.closes_p = true,
            "a" => sh.a = true,
            "form" => sh.form = true,
            "children-at" => sh.children_at.push(rest),
            _ => return Err(format!("shape: {}", p)),
        }
    }
    Ok(sh)
}

/// A `.d.rx` printed for (or written as) an `.rx` module's signature, read in place of the module. `file` is the `.rx`
/// module's path: context keys are its, and relative keys resolve against it.
pub fn parse_signature(src: &str, file: &str) -> Result<ModSig, SignatureError> {
    let mut exports = IndexMap::new();
    for (i, raw) in src.split('\n').enumerate() {
        let t = TRAIL_COMMENT.replace(raw, "");
        let t = LEAD_COMMENT.replace(&t, "");
        let t = crate::parse::js_trim(&t).to_string();
        if t.is_empty() {
            continue;
        }
        let fail = |msg: &str| SignatureError(format!("{}:{}: {}: {}", file.strip_suffix(".rx").map(|f| format!("{}.d.rx", f)).unwrap_or_else(|| file.to_string()), i + 1, msg, t));
        if !t.starts_with("export ") {
            return Err(fail("a signature declares exports"));
        }
        let s = crate::parse::js_trim(&t[7..]).to_string();
        if let Some(m) = T_TYPE.captures(&s) {
            exports.insert(m[1].to_string(), ExportSig::Type);
            continue;
        }
        if let Some(m) = T_ACTION.captures(&s) {
            exports.insert(m[1].to_string(), ExportSig::Action);
            continue;
        }
        if let Some(m) = T_ERROR.captures(&s) {
            let params = m.get(2).map(|x| x.as_str()).unwrap_or("").split(',').map(|x| crate::parse::js_trim(x).to_string()).filter(|x| !x.is_empty()).collect();
            exports.insert(m[1].to_string(), ExportSig::ErrClass { params });
            continue;
        }
        if let Some(m) = T_SOURCE.captures(&s) {
            let r = row_words(m.get(2).map(|x| x.as_str()).unwrap_or(""));
            if !r.rest.is_empty() {
                return Err(fail("a source's rows"));
            }
            exports.insert(m[1].to_string(), ExportSig::Source { question: &m[3] == "=", rows: r.rows, fails: r.fails });
            continue;
        }
        if let Some(m) = T_SERVER.captures(&s) {
            let params = m[3].split(',').map(|x| crate::parse::js_trim(x).to_string()).filter(|x| !x.is_empty()).collect();
            exports.insert(m[2].to_string(), ExportSig::Server { io: m.get(1).is_none(), params, rejects: classes_of(m.get(4).map(|x| x.as_str()).unwrap_or("")) });
            continue;
        }
        if let Some(m) = T_FN.captures(&s) {
            let params = split(&m[2], ',')
                .into_iter()
                .map(|p0| {
                    let r = REF_PARAM.is_match(&p0);
                    let p = if r { crate::parse::js_trim(&p0[4..]).to_string() } else { p0.clone() };
                    match p.find(':') {
                        None => SigParam { name: crate::parse::js_trim(&p).to_string(), r#ref: r, ty: None },
                        Some(c) => SigParam { name: crate::parse::js_trim(&p[..c]).to_string(), r#ref: r, ty: Some(crate::parse::js_trim(&p[c + 1..]).to_string()) },
                    }
                })
                .collect();
            let r = row_words(m.get(3).map(|x| x.as_str()).unwrap_or(""));
            if !r.rest.is_empty() {
                return Err(fail("a fn's rows"));
            }
            exports.insert(m[1].to_string(), ExportSig::Fn { params, instantiating: m.get(5).is_some(), rows: r.rows, fails: r.fails, rejects: classes_of(m.get(4).map(|x| x.as_str()).unwrap_or("")) });
            continue;
        }
        if let Some(m) = T_CONTEXT.captures(&s) {
            let mut body = crate::parse::js_trim(m.get(2).map(|x| x.as_str()).unwrap_or("")).to_string();
            let source = SOURCE_WORD.is_match(&body);
            if source {
                body = crate::parse::js_trim(&body[6..]).to_string();
            }
            let r = row_words(&body);
            exports.insert(
                m[1].to_string(),
                ExportSig::Context { key: format!("{}#{}", file, &m[1]), source, dflt: m.get(3).is_some(), rows: r.rows, fails: r.fails, ty: if r.rest.is_empty() { None } else { Some(r.rest) } },
            );
            continue;
        }
        if let Some(m) = T_COMP.captures(&s) {
            let mut sig = CompSig { own: vec![], requires: vec![], props: IndexMap::new(), shape: None, stored: IndexMap::new() };
            let inner = &m[2][1..m[2].len() - 1];
            for f in split(inner, ';') {
                let (fname0, spec) = match f.find(':') {
                    Some(c) => (crate::parse::js_trim(&f[..c]).to_string(), crate::parse::js_trim(&f[c + 1..]).to_string()),
                    None => (crate::parse::js_trim(&f).to_string(), String::new()),
                };
                let fname = if fname0 == "...props" { "*".to_string() } else { fname0 };
                let mut v = PropSig { f: Catch::Set(IndexSet::new()), p: Catch::Set(IndexSet::new()), rendered: true, action: None, component: false };
                let a = P_ACTION.captures(&spec);
                let rest = match &a {
                    Some(a) => {
                        v.action = Some((catch_of(&a[3]), a[2].to_string()));
                        let whole = a.get(0).unwrap();
                        let start = whole.end() - (whole.as_str().len() - a.get(1).unwrap().as_str().len());
                        let matched = &spec[start..whole.end()];
                        spec.replacen(matched, "", 1)
                    }
                    None => spec.clone(),
                };
                if P_UNRENDERED.is_match(&rest) {
                    v.rendered = false;
                    v.f = Catch::All;
                    v.p = Catch::All;
                }
                if let Some(c) = P_CATCHES.captures(&rest) {
                    v.f = catch_of(&c[2]);
                }
                if let Some(p) = P_PROVIDES.captures(&rest) {
                    v.p = if crate::parse::js_trim(&p[2]) == "*" {
                        Catch::All
                    } else {
                        Catch::Set(p[2].split(',').map(|k| abs_key(file, crate::parse::js_trim(k))).filter(|x| !x.is_empty()).collect())
                    };
                }
                sig.props.insert(fname, v);
            }
            let tail = &m[3];
            if let Some(fl) = C_FAILS.captures(tail) {
                let at = file.split('/').last().map(String::from);
                sig.own = classes_of(&fl[2]).into_iter().map(|c| Own { cls: c, what: format!("{}'s root", &m[1]), at: at.clone() }).collect();
            }
            if let Some(us) = C_USES.captures(tail) {
                sig.requires = us[2].split(',').map(|k| abs_key(file, crate::parse::js_trim(k))).collect();
            }
            if let Some(so) = C_RETAINS.captures(tail) {
                for x in split(&so[2], ',') {
                    let i = x.find(':').unwrap_or(x.len());
                    let f0 = crate::parse::js_trim(&x[..i]).to_string();
                    let f = if f0 == "...props" { "*".to_string() } else { f0 };
                    let t = crate::parse::js_trim(x.get(i + 1..).unwrap_or("")).to_string();
                    sig.stored.entry(f).or_default().push(if t == "module" { t } else { abs_key(file, &t) });
                }
            }
            sig.shape = Some(content_shape_of(C_SHAPE.captures(tail).map(|x| x.get(2).unwrap().as_str())).map_err(|e| fail(&e))?);
            exports.insert(m[1].to_string(), ExportSig::Comp { sig });
            continue;
        }
        if let Some(m) = T_EQ.captures(&s) {
            let r = row_words(m.get(2).map(|x| x.as_str()).unwrap_or(""));
            if !r.rest.is_empty() {
                return Err(fail("an equation's rows"));
            }
            let io = r.rows.iter().any(|x| x == "io");
            exports.insert(m[1].to_string(), ExportSig::Eq { rows: r.rows.into_iter().filter(|x| x != "io").collect(), fails: r.fails, io });
            continue;
        }
        return Err(fail("not an export"));
    }
    Ok(ModSig { file: file.into(), exports })
}
