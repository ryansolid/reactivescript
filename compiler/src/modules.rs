//! 09-modules: a program is a set of `.rx` modules (`ref/src/modules.ts`). The loader resolves each `.rx` import to a path,
//! parses every module once, and orders them dependencies first (MO-1). A cycle is refused (MO-5).

use crate::ast::{Decl, Program};
use crate::check::Diagnostic;
use crate::parse::{parse_declarations, parse_program, JsDecl, ParseError};
use crate::signature::{parse_signature, ModSig};
use indexmap::IndexMap;
use std::collections::HashMap;

pub struct ModuleSet {
    pub entry: String,
    pub programs: HashMap<String, Program>,
    pub order: Vec<String>,
    pub diags: Vec<Diagnostic>,
    /// MO-8, by `.d.rx` path
    pub declarations: IndexMap<String, Vec<JsDecl>>,
    /// MO-9, by `.rx` path
    pub signatures: IndexMap<String, ModSig>,
    /// each program's text, which its spans index
    pub sources: HashMap<String, String>,
    /// an editor's load (CP-8e): what the parse recovered from, each with its file
    pub parse_errors: Vec<ParseError>,
}

pub fn is_rx(from: &str) -> bool {
    from.ends_with(".rx")
}

/// POSIX-style join and normalisation, for module keys (no file system involved).
pub fn join_path(from_file: &str, rel: &str) -> String {
    let segs: Vec<&str> = from_file.split('/').collect();
    let base = &segs[..segs.len() - 1];
    let mut parts: Vec<String> = if rel.starts_with('/') { vec![] } else { base.iter().map(|s| s.to_string()).collect() };
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if !parts.is_empty() && parts.last().unwrap() != ".." {
                parts.pop();
            } else {
                parts.push("..".into());
            }
        } else {
            parts.push(seg.into());
        }
    }
    format!("{}{}", if rel.starts_with('/') { "/" } else { "" }, parts.join("/"))
}

#[derive(PartialEq, Clone, Copy)]
enum State {
    Busy,
    Done,
}

struct Loader<'r> {
    read: &'r dyn Fn(&str) -> Option<String>,
    programs: HashMap<String, Program>,
    order: Vec<String>,
    diags: Vec<Diagnostic>,
    declarations: IndexMap<String, Vec<JsDecl>>,
    signatures: IndexMap<String, ModSig>,
    sources: HashMap<String, String>,
    state: HashMap<String, State>,
    recover: bool,
    parse_errors: Vec<ParseError>,
}

/// MO-10c: the file a package import resolves to, as a bundler finds it — `node_modules` up from the importer, the
/// package's `exports` (a subpath, then the first of its conditions that a Solid build sets, in the package's order; `*`
/// patterns), else `module` or `main`. Its declaration is beside it: the same name, `.d.rx`.
pub fn package_declaration(from_file: &str, spec: &str, read: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    use serde_json::Value;
    const CONDITIONS: [&str; 4] = ["solid", "browser", "import", "default"];
    let seg: Vec<&str> = spec.split('/').collect();
    let n = if spec.starts_with('@') { 2 } else { 1 };
    if seg.len() < n || seg[..n].iter().any(|x| x.is_empty()) {
        return None;
    }
    let pkg = seg[..n].join("/");
    let sub = if seg.len() > n { format!("./{}", seg[n..].join("/")) } else { ".".to_string() };
    let all: Vec<&str> = from_file.split('/').collect();
    let dirs = &all[..all.len() - 1];
    let min = if from_file.starts_with('/') { 1 } else { 0 };
    fn pick(t: &Value) -> Option<String> {
        match t {
            Value::String(s) => Some(s.clone()),
            Value::Array(xs) => xs.iter().find_map(pick),
            Value::Object(m) => m.iter().filter(|(k, _)| CONDITIONS.contains(&k.as_str())).find_map(|(_, v)| pick(v)),
            _ => None,
        }
    }
    let mut i = dirs.len() as i64;
    while i >= min {
        let mut parts: Vec<&str> = dirs[..i as usize].to_vec();
        parts.push("node_modules");
        parts.push(&pkg);
        let root = parts.join("/");
        i -= 1;
        let Some(pj) = read(&format!("{root}/package.json")) else { continue };
        let Ok(json) = serde_json::from_str::<Value>(&pj) else { return None };
        let target: Option<String> = match json.get("exports") {
            Some(ex) => {
                let map = match ex {
                    Value::Object(m) if m.keys().any(|k| k.starts_with('.')) => Some(m),
                    _ => None,
                };
                match map {
                    None => (sub == ".").then(|| pick(ex)).flatten(),
                    Some(m) => match m.get(&sub) {
                        Some(v) => pick(v),
                        None => m.iter().find_map(|(k, v)| {
                            let star = k.find('*')?;
                            let (pre, post) = (&k[..star], &k[star + 1..]);
                            if sub.starts_with(pre) && sub.ends_with(post) && sub.len() >= pre.len() + post.len() {
                                Some(pick(v).map(|t| t.replace('*', &sub[pre.len()..sub.len() - post.len()])))
                            } else {
                                None
                            }
                        }).flatten(),
                    },
                }
            }
            None => {
                if sub == "." {
                    Some(json.get("module").and_then(|v| v.as_str()).or_else(|| json.get("main").and_then(|v| v.as_str())).unwrap_or("./index.js").to_string())
                } else {
                    Some(sub.clone())
                }
            }
        };
        let target = target?;
        let file = join_path(&format!("{root}/package.json"), &target);
        let stem = PKG_EXT.replace(&file, "").to_string();
        return Some(stem + ".d.rx");
    }
    None
}
static PKG_EXT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"\.(m?js|cjs|jsx|ts|tsx)$").unwrap());

fn replace_js_ext(from: &str) -> String {
    for ext in [".mjs", ".js", ".ts"] {
        if let Some(s) = from.strip_suffix(ext) {
            return s.to_string();
        }
    }
    from.to_string()
}

impl Loader<'_> {
    fn visit(&mut self, path: &str, stack: &[String]) -> Result<(), ParseError> {
        if self.state.get(path) == Some(&State::Done) {
            return Ok(());
        }
        let Some(src) = (self.read)(path) else { return Ok(()) };
        let mut p = if self.recover {
            let (p, errs) = crate::parse::parse_program_recovering(&src);
            self.parse_errors.extend(errs.into_iter().map(|e| ParseError(e.0, e.1, Some(path.to_string()), e.3)));
            p
        } else {
            parse_program(&src).map_err(|e| ParseError(format!("{}: {}", path, e.0), e.1, Some(path.to_string()), e.3))?
        };
        self.state.insert(path.to_string(), State::Busy);
        for d in p.decls.iter_mut() {
            let Decl::Import { from, line, resolved, declared, declared_errors, declared_pure, declared_side, .. } = d else { continue };
            // MO-10c: a package's declaration, beside the file it resolves to
            let pkg_dts = if !is_rx(from) && !from.starts_with('.') && !from.starts_with('/') { package_declaration(path, from, &*self.read) } else { None };
            if !is_rx(from) && (from.starts_with('.') || pkg_dts.is_some()) {
                // MO-8: a JS module with a declaration file beside it
                let dts = pkg_dts.unwrap_or_else(|| join_path(path, &(replace_js_ext(from) + ".d.rx")));
                if !self.declarations.contains_key(&dts) {
                    if let Some(src) = (self.read)(&dts) {
                        let ds = parse_declarations(&src).map_err(|e| ParseError(format!("{}: {}", dts, e.0), e.1, Some(dts.clone()), e.3))?;
                        self.declarations.insert(dts.clone(), ds);
                    }
                }
                if let Some(ds) = self.declarations.get(&dts) {
                    *declared = Some(dts.clone());
                    *declared_errors = Some(ds.iter().filter_map(|x| if let JsDecl::Error { name, .. } = x { Some(name.clone()) } else { None }).collect());
                    *declared_pure = Some(ds.iter().filter_map(|x| if let JsDecl::Fn { name, pure: true, .. } = x { Some(name.clone()) } else { None }).collect());
                    *declared_side = Some(ds.iter().filter_map(|x| if let JsDecl::Fn { name, side: Some(s), .. } = x { Some((name.clone(), *s)) } else { None }).collect());
                }
                continue;
            }
            if !is_rx(from) {
                continue;
            }
            let to = join_path(path, from);
            *resolved = Some(to.clone());
            if self.state.get(&to) == Some(&State::Busy) {
                let mut chain: Vec<String> = stack.to_vec();
                chain.push(path.to_string());
                let at = stack.iter().position(|s| *s == to).unwrap_or(0);
                let mut cyc: Vec<String> = chain[at..].to_vec();
                cyc.push(to.clone());
                self.diags.push(Diagnostic {
                    code: "MODULE_CYCLE".into(),
                    rule: "MO-5".into(),
                    line: *line as i64,
                    file: Some(path.to_string()),
                    msg: format!("{}: modules may not import each other in a cycle (signatures are computed dependencies first)", cyc.join(" → ")),
                });
                continue;
            }
            if self.state.get(&to) != Some(&State::Done) && !self.signatures.contains_key(&to) && (self.read)(&to).is_none() {
                // MO-9: no body — its signature, read in place
                let dts = to.strip_suffix(".rx").map(|s| format!("{}.d.rx", s)).unwrap_or_else(|| to.clone());
                if let Some(sig) = (self.read)(&dts) {
                    let s = parse_signature(&sig, &to).map_err(|e| ParseError(e.0, None, Some(dts.clone()), "PARSE"))?;
                    self.signatures.insert(to.clone(), s);
                    continue;
                }
            }
            if self.signatures.contains_key(&to) {
                continue;
            }
            if self.state.get(&to) != Some(&State::Done) && (self.read)(&to).is_none() {
                self.diags.push(Diagnostic { code: "MODULE_NOT_FOUND".into(), rule: "MO-6".into(), line: *line as i64, file: Some(path.to_string()), msg: format!("no module {} (from {})", from, path) });
                continue;
            }
            let mut st = stack.to_vec();
            st.push(path.to_string());
            self.visit(&to, &st)?;
        }
        self.programs.insert(path.to_string(), p);
        self.sources.insert(path.to_string(), src);
        self.state.insert(path.to_string(), State::Done);
        self.order.push(path.to_string());
        Ok(())
    }
}

/// Load `entry` and everything it imports from `.rx`. `read` returns a module's source, or `None` when there is none.
pub fn load_modules(entry: &str, read: &dyn Fn(&str) -> Option<String>) -> Result<ModuleSet, ParseError> {
    load(entry, read, false)
}
/// CP-8e: an editor's load. Each module is parsed recovering (`parse_program_recovering`), its errors in `parse_errors`;
/// a declaration file that does not parse is still an error.
pub fn load_modules_recovering(entry: &str, read: &dyn Fn(&str) -> Option<String>) -> Result<ModuleSet, ParseError> {
    load(entry, read, true)
}
fn load(entry: &str, read: &dyn Fn(&str) -> Option<String>, recover: bool) -> Result<ModuleSet, ParseError> {
    let mut l = Loader { read, programs: HashMap::new(), order: vec![], diags: vec![], declarations: IndexMap::new(), signatures: IndexMap::new(), sources: HashMap::new(), state: HashMap::new(), recover, parse_errors: vec![] };
    l.visit(entry, &[])?;
    Ok(ModuleSet { entry: entry.to_string(), programs: l.programs, order: l.order, diags: l.diags, declarations: l.declarations, signatures: l.signatures, sources: l.sources, parse_errors: l.parse_errors })
}
