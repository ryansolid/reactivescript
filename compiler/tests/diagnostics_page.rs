//! guide/diagnostics.md, the page each diagnostic code points to: every code the crate (and its type prelude) can
//! report has a section, every `rx before` fence gets its section's code, and every `rx after` fence checks clean.

use reactivescript::check::check_modules;
use reactivescript::modules::load_modules;
use regex::Regex;
use std::collections::BTreeSet;
use std::path::Path;

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
}

/// The codes a program `src` gets: its parse error's, else its checker diagnostics'.
fn codes(src: &str) -> Vec<String> {
    let entry = "/page/main.rx";
    let read = |p: &str| if p == entry { Some(src.to_string()) } else { None };
    match load_modules(entry, &read) {
        Err(e) => vec![e.3.to_string()],
        Ok(set) => check_modules(&set, false).diags.into_iter().map(|d| format!("{} ({}: {})", d.code, d.line, d.msg)).collect(),
    }
}

#[test]
fn every_code_has_a_section_and_its_examples_hold() {
    let page = std::fs::read_to_string(root().join("guide/diagnostics.md")).unwrap();
    let heading = Regex::new(r"^#{2,3} ([A-Z][A-Z_]+)$").unwrap();
    let mut sections = BTreeSet::new();
    let mut failures = vec![];
    let (mut code, mut fence): (Option<String>, Option<(String, String)>) = (None, None);
    for line in page.lines() {
        if let Some((mark, body)) = &mut fence {
            if line == "```" {
                let got = codes(body);
                let c = code.clone().unwrap_or_default();
                let ok = if mark == "before" { got.iter().any(|g| g == &c || g.starts_with(&format!("{} (", c))) } else { got.is_empty() };
                if !ok {
                    failures.push(format!("{} `rx {}`: got {:?}\n{}", c, mark, got, body));
                }
                fence = None;
            } else {
                body.push_str(line);
                body.push('\n');
            }
            continue;
        }
        if let Some(m) = heading.captures(line) {
            code = Some(m[1].to_string());
            sections.insert(m[1].to_string());
        } else if let Some(mark) = line.strip_prefix("```rx ") {
            fence = Some((mark.to_string(), String::new()));
        }
    }
    let mut emitted = BTreeSet::new();
    let patterns = [
        r#"err\(\s*"([A-Z][A-Z_]+)""#,
        r#"code: "([A-Z][A-Z_]+)""#,
        r#"\{ "([A-Z][A-Z_]+)" \} else \{ "([A-Z][A-Z_]+)" \}"#,
        r#"Some\(\("([A-Z][A-Z_]+)""#,
        r#"unwrap_or\("([A-Z][A-Z_]+)"\)"#,
        r#""([A-Z][A-Z_]+): "#,
    ];
    for f in std::fs::read_dir(root().join("compiler/src")).unwrap() {
        let p = f.unwrap().path();
        let src = std::fs::read_to_string(&p).unwrap();
        for pat in &patterns {
            for m in Regex::new(pat).unwrap().captures_iter(&src) {
                for g in m.iter().skip(1).flatten() {
                    emitted.insert(g.as_str().to_string());
                }
            }
        }
    }
    let missing: Vec<_> = emitted.difference(&sections).collect();
    assert!(missing.is_empty(), "codes with no section in guide/diagnostics.md: {:?}", missing);
    assert!(failures.is_empty(), "examples that do not hold:\n\n{}", failures.join("\n\n"));
}
