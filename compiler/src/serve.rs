//! `rxc serve`'s requests (spec/11 CP-8e), for a language server: the native binary answers them a line at a time, the
//! WebAssembly build (`wasm.rs`) a call at a time, the same way. `disk` reads a file the editor does not have open.
use serde_json::{json, Value};
use std::collections::HashMap;

/// One request: `analyze` (`{file, overlays, prelude}`) or `prelude`.
pub fn request(method: &str, params: &Value, disk: &dyn Fn(&str) -> Option<String>) -> Value {
    match method {
        "analyze" => analyze(params, disk),
        "prelude" => json!(crate::project::PRELUDE),
        _ => json!({ "error": "unknown method" }),
    }
}

/// `rxc check --json`: a diagnostic with its range (CP-8), for an editor or an agent. Lines are 1-based, columns 0-based in
/// UTF-16 code units, as LSP counts; `start`/`end` are byte offsets; `rule` names the spec rule (spec/99).
pub fn diagnostic_json(set: &crate::modules::ModuleSet, d: &crate::check::Diagnostic) -> Value {
    let file = d.file.clone().unwrap_or_else(|| set.entry.clone());
    let mut v = json!({ "file": file, "line": d.line, "code": d.code, "rule": d.rule, "message": d.msg });
    if let (Some(src), Some(p)) = (set.sources.get(&file), set.programs.get(&file)) {
        if let Some(r) = crate::spans::line_range(src, p, d.line.max(1) as usize) {
            let ((l0, c0), (l1, c1)) = (crate::spans::line_col(src, r.start), crate::spans::line_col(src, r.end));
            v["range"] = json!({ "start": { "line": l0, "column": c0 }, "end": { "line": l1, "column": c1 }, "offsets": [r.start, r.end] });
        }
    }
    v
}

/// A parse error's message without the `file: line n:` it carries (the diagnostic's own fields say where).
pub fn parse_message(e: &crate::parse::ParseError) -> &str {
    e.0.split_once("line ").filter(|(pre, _)| pre.is_empty() || pre.ends_with(": ")).and_then(|(_, r)| r.split_once(": ")).map(|(_, m)| m).unwrap_or(&e.0)
}

pub fn parse_error_in(file: &str, e: &crate::parse::ParseError, src: Option<&str>) -> Value {
    static RULE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"\b([A-Z]+-\d+[a-z]?)\b").unwrap());
    let rule = RULE.captures(&e.0).map(|c| c[1].to_string()).unwrap_or_else(|| "07".into());
    let mut v = json!({ "file": file, "code": e.3, "rule": rule, "message": parse_message(e) });
    if let (Some(at), Some(src)) = (e.1, src) {
        let at = at.min(src.len());
        let end = src[at..].find('\n').map(|j| at + j).unwrap_or(src.len());
        let end = at + src[at..end].trim_end().len();
        let ((l0, c0), (l1, c1)) = (crate::spans::line_col(src, at as u32), crate::spans::line_col(src, end as u32));
        v["line"] = json!(l0);
        v["range"] = json!({ "start": { "line": l0, "column": c0 }, "end": { "line": l1, "column": c1 }, "offsets": [at, end] });
    }
    v
}

/// UTF-16 offsets of a text's byte offsets (what JavaScript strings, Volar and LSP index by).
pub fn utf16_index(s: &str) -> Vec<u32> {
    let mut idx = vec![0u32; s.len() + 1];
    let mut u = 0u32;
    for (b, ch) in s.char_indices() {
        for k in 0..ch.len_utf8() {
            idx[b + k] = u;
        }
        u += ch.len_utf16() as u32;
    }
    idx[s.len()] = u;
    idx
}

/// `rxc serve`, one request: `{file, overlays: {path: text}, prelude}` — the file loaded (and its imports) as an editor
/// has them, recovering (CP-8e); its projection with mappings in UTF-16 offsets, and its diagnostics: the parse's, else
/// the checker's.
pub fn analyze(params: &Value, disk: &dyn Fn(&str) -> Option<String>) -> Value {
    let file = params["file"].as_str().unwrap_or_default().to_string();
    let overlays: HashMap<String, String> = params["overlays"].as_object().map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).unwrap_or_default();
    let read = |p: &str| overlays.get(p).cloned().or_else(|| disk(p));
    let set = match crate::modules::load_modules_recovering(&file, &read) {
        Ok(s) => s,
        Err(e) => {
            let src = e.2.as_deref().and_then(|f| read(f));
            return json!({ "diagnostics": [parse_error_in(e.2.as_deref().unwrap_or(&file), &e, src.as_deref())] });
        }
    };
    let src = set.sources.get(&file).cloned().unwrap_or_default();
    let prelude = params["prelude"].as_str();
    let mut out = json!({ "code": null, "mappings": [] });
    if let Some(p) = crate::project::project_modules_with(&set, prelude).into_iter().find(|p| p.rx == file) {
        let (gi, si) = (utf16_index(&p.code), utf16_index(&src));
        let maps: Vec<[u32; 3]> = p.mappings.iter().map(|m| [gi[m.gen as usize], si[m.src as usize], si[(m.src + m.len) as usize] - si[m.src as usize]]).collect();
        let u = |i: &[u32], a: u32, n: u32| [i[a as usize], i[(a + n) as usize] - i[a as usize]];
        let ranges: Vec<[u32; 4]> = p.ranges.iter().map(|r| { let (g, s) = (u(&gi, r.gen, r.glen), u(&si, r.src, r.len)); [g[0], g[1], s[0], s[1]] }).collect();
        out = json!({ "code": p.code, "mappings": maps, "ranges": ranges });
    }
    let own: Vec<Value> = if set.parse_errors.iter().any(|e| e.2.as_deref() == Some(file.as_str())) {
        set.parse_errors.iter().filter(|e| e.2.as_deref() == Some(file.as_str())).map(|e| parse_error_in(&file, e, Some(&src))).collect()
    } else {
        crate::check::check_modules(&set, params["spa"].as_bool().unwrap_or(false)).diags.iter().map(|d| diagnostic_json(&set, d)).filter(|d| d["file"] == json!(file)).collect()
    };
    out["diagnostics"] = json!(own);
    out
}

