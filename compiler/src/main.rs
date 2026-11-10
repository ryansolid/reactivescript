//! `rxc`: the crate's command line.
//!
//!   rxc check file.rx...   diagnostics, as `ref/check.ts` prints them (`--spa`: see below)
//!   rxc check --json file.rx...
//!                          the same as `{diagnostics: [{file, line, range, code, rule, message}]}`, ranges per CP-8
//!   rxc project app.rx     TY-1c: the program's TSX projection, each file with its mappings onto the `.rx`
//!                          (`[generated offset, source offset, length]`, CP-8), and the prelude it imports; with no
//!                          file, reads `[{id, entry, files}]` on stdin, as `conform` does (`ref/crate.ts --project`)
//!   rxc serve              for a language server: one JSON request a line on stdin, `{id, method: "analyze", params:
//!                          {file, overlays, prelude}}`, answered a line each with the file's projection (mappings in
//!                          UTF-16 offsets; `ranges`, `[generated, length, source, length]`) and its diagnostics, the parse recovering (CP-8e); `method: "prelude"` too (`serve.rs`; `wasm.rs` answers the
//!                          same requests as WebAssembly)
//!   rxc model file.rx...   the resolved model (CP-6) of each module, as JSON
//!   rxc conform            reads `[{id, entry, files: {path: source}}]` on stdin and prints, per program, every module's
//!                          AST, the diagnostics, the printed signatures and the models: what `ref/crate.ts` compares.
//!   rxc lower              reads `[{id, entry, files, extra: [statements], renderer}]` on stdin and prints, per program,
//!                          each compiled module through Solid's compiler for the universal (over `renderer`), dom and ssr
//!                          targets, and the stylesheet: what `ref/crate.ts --lower` compares and `ref/compile/run.ts`
//!                          runs with `RX_CRATE=1`. With `maps: true`, also each module's source maps onto its `.rx`.
//!   rxc compile app.rx --out dir [--target dom|ssr|universal] [--module-name name] [--spa]
//!                          checks the program and writes each module's JavaScript for `target` (default dom) with its
//!                          source map, and the stylesheet (`style.css`), into `dir`.
//!   rxc app app.rx [--target dom|ssr|universal] [--module-name name] [--spa]
//!                          for a bundler plugin: prints `{entry, css, modules: {path: {code, map}}}`, each module importing
//!                          its dependencies by `.rx` path, or `{diagnostics: [...]}` / `{error}`.
//!   --spa                  (check, compile, app) a client-only build: a reader with no `loading` above it that can
//!                          have no value yet is an error, as its first load would show nothing (08 CN-3d).

use reactivescript::app::{self, read_disk};
use reactivescript::check::check_modules;
use reactivescript::emit::{compile_modules, lower_view, Target};
use reactivescript::parse::parse_stmts;
use reactivescript::project::{project_modules, unverified, PRELUDE};
use reactivescript::modules::load_modules;
use reactivescript::serve;
use reactivescript::signature::print_signature;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;


fn abs(f: &str) -> String {
    // module keys are POSIX paths (`modules::join_path`), on Windows too
    std::path::absolute(f).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| f.to_string()).replace('\\', "/")
}

fn conform_one(entry: &str, files: &HashMap<String, String>) -> Value {
    let read = |p: &str| files.get(p).cloned();
    let set = match load_modules(entry, &read) {
        Ok(s) => s,
        Err(e) => return json!({ "error": e.0 }),
    };
    let mut asts = Map::new();
    for p in &set.order {
        asts.insert(p.clone(), set.programs[p].to_json());
    }
    let checked = check_modules(&set, false);
    let mut sigs = Map::new();
    for p in &set.order {
        sigs.insert(p.clone(), json!(print_signature(&checked.sigs[p])));
    }
    let mut models = Map::new();
    for (p, m) in &checked.models {
        models.insert(p.clone(), m.clone());
    }
    let mut spans = Map::new();
    for p in &set.order {
        let mut bad = reactivescript::spans::check_spans(&set.sources[p], &set.programs[p]);
        // CP-8e: on a program that parses, the editor's parse is the same parse, with nothing to recover from
        let (rp, errs) = reactivescript::parse::parse_program_recovering(&set.sources[p]);
        if !errs.is_empty() {
            bad.push(format!("the editor's parse recovered from {} error(s) in a program that parses: {}", errs.len(), errs[0].0));
        } else if Some(rp.to_json()) != reactivescript::parse::parse_program(&set.sources[p]).ok().map(|x| x.to_json()) {
            bad.push("the editor's parse gives another tree".into());
        }
        if !bad.is_empty() {
            spans.insert(p.clone(), json!(bad));
        }
    }
    json!({
        "spans": spans,
        "order": set.order,
        "asts": asts,
        "diags": checked.diags.iter().map(|d| d.to_json()).collect::<Vec<_>>(),
        "sigs": sigs,
        "models": models,
    })
}

/// TY-1c: each module's projection with its mappings onto the `.rx` (CP-8), and how many of them fail to hold (none).
fn project_one(entry: &str, files: &HashMap<String, String>) -> Value {
    let read = |p: &str| files.get(p).cloned();
    let set = match load_modules(entry, &read) {
        Ok(s) => s,
        Err(e) => return json!({ "error": e.0 }),
    };
    projection_json(&set)
}
fn projection_json(set: &reactivescript::modules::ModuleSet) -> Value {
    let files: Vec<Value> = project_modules(set)
        .iter()
        .map(|p| {
            let bad = set.sources.get(&p.rx).map(|src| unverified(p, src).len()).unwrap_or(0);
            json!({ "path": p.path, "rx": p.rx, "code": p.code, "lines": p.lines, "mappings": p.mappings.iter().map(|m| [m.gen, m.src, m.len]).collect::<Vec<_>>(), "ranges": p.ranges.iter().map(|r| [r.gen, r.glen, r.src, r.len]).collect::<Vec<_>>(), "unverified": bad })
        })
        .collect();
    json!({ "files": files })
}

fn lower_one(r: &Value) -> Value {
    let files: HashMap<String, String> = r["files"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
    let entry = r["entry"].as_str().unwrap();
    let read = |p: &str| files.get(p).cloned();
    let set = match load_modules(entry, &read) {
        Ok(s) => s,
        Err(e) => return json!({ "error": e.0 }),
    };
    if !check_modules(&set, false).diags.is_empty() {
        return json!({ "refused": true });
    }
    // a handler row that does not parse runs nothing (ref/compile/run.ts)
    let extra: Vec<_> = r["extra"].as_array().map(|xs| xs.iter().map(|x| parse_stmts(x.as_str().unwrap()).unwrap_or_default()).collect()).unwrap_or_default();
    let out = match compile_modules(&set, &extra) {
        Ok(o) => o,
        Err(e) => return json!({ "compileError": e.0 }),
    };
    let renderer = r["renderer"].as_str().unwrap_or("@solidjs/web");
    let with_maps = r["maps"].as_bool().unwrap_or(false);
    let (mut mods, mut maps) = (Map::new(), Map::new());
    for (name, module) in &out.files {
        let path = &out.paths[name];
        let rx = with_maps.then(|| (path.as_str(), files.get(path).map(|s| s.as_str()).unwrap_or("")));
        let (mut t, mut m) = (Map::new(), Map::new());
        for (k, target, module_name) in [("universal", Target::Universal, renderer), ("dom", Target::Dom, "@solidjs/web"), ("ssr", Target::Ssr, "@solidjs/web")] {
            t.insert(k.into(), match lower_view(module, name, target, module_name, rx) {
                Ok(l) => {
                    if let Some(map) = l.map {
                        m.insert(k.into(), json!(map));
                    }
                    json!(l.code)
                }
                Err(e) => json!({ "error": e }),
            });
        }
        mods.insert(name.clone(), Value::Object(t));
        maps.insert(name.clone(), Value::Object(m));
    }
    let mut v = json!({ "entry": out.entry, "css": out.css, "files": mods });
    if with_maps {
        v["maps"] = Value::Object(maps);
    }
    v
}

/// A parse error as `rxc check` prints a diagnostic: `file:line:column: error CODE [rule] message`, the message without the
/// `file: line n:` it carries.
fn parse_error_text(f: &str, e: &reactivescript::parse::ParseError) -> String {
    let v = parse_error_json(f, e);
    let msg = serve::parse_message(e);
    let at = match (v["range"]["start"]["line"].as_i64(), v["range"]["start"]["column"].as_i64()) {
        (Some(l), Some(c)) => format!("{}:{}", l, c + 1),
        _ => "1".into(),
    };
    format!("{}:{}: error {} [{}] {}", v["file"].as_str().unwrap_or(f), at, e.3, v["rule"].as_str().unwrap_or("07"), msg)
}
/// A parse error as `diagnostic_json` writes a diagnostic: from where the parser stopped to the end of that line.
fn parse_error_json(f: &str, e: &reactivescript::parse::ParseError) -> Value {
    let file = e.2.clone().unwrap_or_else(|| abs(f));
    let src = read_disk(&file);
    serve::parse_error_in(&file, e, src.as_deref())
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // 08 CN-3d: a client-only build (dom, not hydratable)
    let spa = args.iter().any(|a| a == "--spa");
    let Some(cmd) = args.first() else {
        eprintln!("usage: rxc check|model file.rx... | rxc conform < request.json");
        std::process::exit(2);
    };
    match cmd.as_str() {
        "conform" => {
            let mut input = String::new();
            std::io::stdin().read_to_string(&mut input).expect("stdin");
            let req: Vec<Value> = serde_json::from_str(&input).expect("request: [{id, entry, files}]");
            let out: Vec<Value> = req
                .iter()
                .map(|r| {
                    let files: HashMap<String, String> = r["files"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
                    let entry = r["entry"].as_str().unwrap();
                    let mut v = std::panic::catch_unwind(|| conform_one(entry, &files)).unwrap_or_else(|e| {
                        let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
                        json!({ "panic": msg })
                    });
                    v["id"] = r["id"].clone();
                    v
                })
                .collect();
            println!("{}", serde_json::to_string(&out).unwrap());
        }
        "project" if args.len() == 1 => {
            let mut input = String::new();
            std::io::stdin().read_to_string(&mut input).expect("stdin");
            let req: Vec<Value> = serde_json::from_str(&input).expect("request: [{id, entry, files}]");
            let out: Vec<Value> = req
                .iter()
                .map(|r| {
                    let files: HashMap<String, String> = r["files"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
                    let mut v = std::panic::catch_unwind(|| project_one(r["entry"].as_str().unwrap(), &files)).unwrap_or_else(|_| json!({ "panic": true }));
                    v["id"] = r["id"].clone();
                    v
                })
                .collect();
            println!("{}", serde_json::to_string(&json!({ "prelude": PRELUDE, "programs": out })).unwrap());
        }
        "project" => {
            let set = match load_modules(&abs(&args[1]), &read_disk) {
                Ok(s) => s,
                Err(e) => {
                    println!("{}", json!({ "error": e.0 }));
                    std::process::exit(1);
                }
            };
            let mut v = projection_json(&set);
            v["prelude"] = json!(PRELUDE);
            println!("{}", serde_json::to_string_pretty(&v).unwrap());
        }
        "serve" => {
            // one JSON request a line on stdin, `{id, method, params}`; one response a line, `{id, result}`
            use std::io::{BufRead, Write};
            let stdout = std::io::stdout();
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
                let method = req["method"].as_str().unwrap_or_default();
                let result = std::panic::catch_unwind(|| serve::request(method, &req["params"], &read_disk)).unwrap_or_else(|_| json!({ "error": "panic" }));
                let mut o = stdout.lock();
                let _ = writeln!(o, "{}", json!({ "id": req["id"], "result": result }));
                let _ = o.flush();
            }
        }
        "lower" => {
            let mut input = String::new();
            std::io::stdin().read_to_string(&mut input).expect("stdin");
            let req: Vec<Value> = serde_json::from_str(&input).expect("request: [{id, entry, files, extra, renderer}]");
            let out: Vec<Value> = req
                .iter()
                .map(|r| {
                    let mut v = std::panic::catch_unwind(|| lower_one(r)).unwrap_or_else(|e| {
                        let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
                        json!({ "panic": msg })
                    });
                    v["id"] = r["id"].clone();
                    v
                })
                .collect();
            println!("{}", serde_json::to_string(&out).unwrap());
        }
        "compile" => {
            let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
            let (Some(file), Some(dir)) = (args[1..].iter().find(|a| !a.starts_with("--") && Some(*a) != opt("--out").as_ref() && Some(*a) != opt("--target").as_ref() && Some(*a) != opt("--module-name").as_ref()), opt("--out")) else {
                eprintln!("usage: rxc compile app.rx --out dir [--target dom|ssr|universal] [--module-name name]");
                std::process::exit(2);
            };
            let target = match opt("--target").as_deref().unwrap_or("dom") {
                "dom" => Target::Dom,
                "ssr" => Target::Ssr,
                "universal" => Target::Universal,
                t => {
                    eprintln!("unknown target {t}");
                    std::process::exit(2);
                }
            };
            let module_name = opt("--module-name").unwrap_or_else(|| "@solidjs/web".into());
            let set = match load_modules(&abs(file), &read_disk) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{}", parse_error_text(file, &e));
                    std::process::exit(1);
                }
            };
            let checked = check_modules(&set, spa);
            for d in &checked.diags {
                eprintln!("{}:{}: error {} [{}] {}", d.file.as_deref().unwrap_or(file), d.line, d.code, d.rule, d.msg);
            }
            if !checked.diags.is_empty() {
                std::process::exit(1);
            }
            let out = compile_modules(&set, &[]).unwrap_or_else(|e| {
                eprintln!("{}: not compiled: {}", file, e.0);
                std::process::exit(1);
            });
            std::fs::create_dir_all(&dir).expect("--out");
            let dir = Path::new(&dir);
            for (name, module) in &out.files {
                let path = &out.paths[name];
                let text = read_disk(path).unwrap_or_default();
                let l = lower_view(module, name, target, &module_name, Some((path, &text))).unwrap_or_else(|e| {
                    eprintln!("{path}: {e}");
                    std::process::exit(1);
                });
                std::fs::write(dir.join(name), format!("{}\n//# sourceMappingURL={name}.map\n", l.code.trim_end())).expect("write");
                std::fs::write(dir.join(format!("{name}.map")), l.map.unwrap_or_default()).expect("write");
            }
            if !out.css.is_empty() {
                std::fs::write(dir.join("style.css"), &out.css).expect("write");
            }
            println!("{}: {} module(s) → {} (entry {})", file, out.files.len(), dir.display(), out.entry);
        }
        "app" => {
            let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
            let Some(file) = args.get(1) else {
                eprintln!("usage: rxc app app.rx [--target dom|ssr|universal] [--module-name name]");
                std::process::exit(2);
            };
            let target = app::target(opt("--target").as_deref().unwrap_or("dom"));
            let module_name = opt("--module-name").unwrap_or_else(|| "@solidjs/web".into());
            println!("{}", serde_json::to_string(&app::app(&abs(file), target, &module_name, spa)).unwrap());
        }
        "check" | "model" => {
            let mut bad = 0;
            let as_json = cmd == "check" && args.iter().any(|a| a == "--json");
            let mut found: Vec<Value> = vec![];
            for f in args[1..].iter().filter(|a| !a.starts_with("--")) {
                let set = match load_modules(&abs(f), &read_disk) {
                    Ok(s) => s,
                    Err(e) => {
                        bad += 1;
                        if as_json {
                            found.push(parse_error_json(f, &e));
                        } else {
                            eprintln!("{}", parse_error_text(f, &e));
                        }
                        continue;
                    }
                };
                let checked = check_modules(&set, spa);
                for d in &checked.diags {
                    bad += 1;
                    if as_json {
                        found.push(serve::diagnostic_json(&set, d));
                    } else {
                        eprintln!("{}:{}: error {} [{}] {}", d.file.as_deref().unwrap_or(f), d.line, d.code, d.rule, d.msg);
                    }
                }
                if cmd == "model" {
                    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned() + "/").unwrap_or_default();
                    let ms: Vec<Value> = set
                        .order
                        .iter()
                        .map(|p| {
                            let mut m = checked.models[p].clone();
                            m["file"] = json!(p.replacen(&cwd, "", 1));
                            m
                        })
                        .collect();
                    println!("{}", serde_json::to_string_pretty(&ms).unwrap());
                } else if checked.diags.is_empty() && !as_json {
                    println!("{}: ok", f);
                }
            }
            if as_json {
                println!("{}", serde_json::to_string_pretty(&json!({ "diagnostics": found })).unwrap());
            }
            std::process::exit(if bad > 0 { 1 } else { 0 });
        }
        _ => {
            eprintln!("unknown command {}", cmd);
            std::process::exit(2);
        }
    }
}
