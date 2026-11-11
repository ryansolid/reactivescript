//! The parser: `ref/src/parse.ts`, a hand-rolled scanner and recursive descent over `.rx` text (07). It produces the same
//! tree, and fails with the same messages, as the reference; `ref/crate.ts` diffs the two on every scenario program.

use crate::ast::*;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq)]
/// What failed to parse; where (a byte offset), and in which file, when known; and its code: the habit `hint` recognised
/// (guide/diagnostics.md), else `PARSE`.
pub struct ParseError(pub String, pub Option<usize>, pub Option<String>, pub &'static str);
impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
type R<T> = Result<T, ParseError>;

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}
re!(IDENT, r"^[A-Za-z_$][A-Za-z0-9_$]*");
re!(TAG, r"^[A-Za-z_$][A-Za-z0-9_$:.\-]*");
re!(SPLIT_KEY, r"^([\s\S]*?)\s+key\s+([A-Za-z_$][A-Za-z0-9_$]*)$");
re!(SOURCE_KEY, r"^key\s+[A-Za-z_$][A-Za-z0-9_$]*\s*(=|:=)[^=>]");
re!(EQ_KEY, r"^key\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=[^=>]");
re!(IMPORT_SIDE, r"^(server|client)\s+(pure[^A-Za-z0-9_]|pure$|\{)");
re!(ERROR_DECL, r"^error\s+[A-Z]");
re!(TYPE_DECL, r"^(type|interface)([^A-Za-z0-9_]|$)");
re!(SERVER_DECL, r"^server\s+(fn|action)([^A-Za-z0-9_]|$)");
re!(WRITE_AHEAD, r"^[A-Za-z_$][A-Za-z0-9_$.\[\]]*\s*:=");
re!(DRAFT, r"^draft\s*\(");
re!(BRACE_AHEAD, r"^\s*\{");
re!(STYLE, r"^<style([^A-Za-z0-9_]|$)");
re!(SERVER_FN_EXPR, r"^server\s+fn\s*\(");
re!(NUMBER, r"^\d[\d_]*(\.\d+)?");
re!(REJECTS, r"(^|[^A-Za-z0-9_])rejects\(");
re!(LINE_COMMENT, r"//.*$");

static KEYWORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "source", "effect", "component", "ref", "await", "latest", "loading", "errored", "fallback", "on", "deferred", "action", "guess", "refresh", "affects", "if", "else", "pre", "peek", "fn", "let", "for", "in", "true", "false", "undefined",
        "null", "provide", "context", "use", "import", "export", "from", "pure", "return", "type", "interface", "try", "catch", "finally", "throw", "portal",
    ]
    .into_iter()
    .collect()
});
fn is_kw(s: &str) -> bool {
    KEYWORDS.contains(s)
}
fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

/// An expression from `start` to where the cursor is.
fn ex(start: usize, k: ExprKind, c: &Cursor) -> Expr {
    Expr::new(k, Span::new(start, c.i))
}
/// A statement from `start` to where the cursor is.
fn st(start: usize, k: StmtKind, c: &Cursor) -> Stmt {
    Stmt { k, span: Span::new(start, c.i) }
}

/// A position in the source, in bytes, always on a char boundary. `peek` at the end is `'\0'` (the reference's `""`).
pub struct Cursor<'a> {
    pub src: &'a str,
    pub i: usize,
    /// an editor's parse (CP-8e): a missing member name or expression is an error recorded in `errors`, and the parse goes
    /// on with an empty one, so that what is being typed still projects
    pub recover: bool,
    pub errors: Vec<ParseError>,
}
impl<'a> Cursor<'a> {
    pub fn new(src: &'a str) -> Self {
        Cursor { src, i: 0, recover: false, errors: vec![] }
    }
    /// What `fail` would return, recorded instead (`recover`).
    fn note(&mut self, msg: &str) {
        if let Err(e) = self.fail::<()>(msg) {
            self.errors.push(e);
        }
    }
    /// A member's name; in an editor's parse, `x.` with none yet is `x.` with an empty one.
    fn member(&mut self) -> R<String> {
        if self.recover && self.peek_ident().is_none() {
            self.note("member");
            return Ok(String::new());
        }
        self.ident_or("member")
    }
    pub fn line(&self) -> usize {
        self.src[..self.i].bytes().filter(|b| *b == b'\n').count() + 1
    }
    pub fn eof(&self) -> bool {
        self.i >= self.src.len()
    }
    pub fn rest(&self) -> &'a str {
        &self.src[self.i.min(self.src.len())..]
    }
    pub fn peek(&self) -> char {
        self.rest().chars().next().unwrap_or('\0')
    }
    pub fn peek_at(&self, n: usize) -> char {
        self.rest().chars().nth(n).unwrap_or('\0')
    }
    /// One character on (the reference's `c.i++`).
    pub fn bump(&mut self) {
        if let Some(c) = self.rest().chars().next() {
            self.i += c.len_utf8();
        } else {
            self.i += 1;
        }
    }
    pub fn ws(&mut self, newlines: bool) {
        loop {
            let c = self.peek();
            if c == ' ' || c == '\t' || c == '\r' || (newlines && c == '\n') {
                self.bump();
            } else if c == '/' && self.peek_at(1) == '/' {
                while !self.eof() && self.peek() != '\n' {
                    self.bump();
                }
            } else if c == '/' && self.peek_at(1) == '*' {
                match self.src[self.i + 2..].find("*/") {
                    Some(j) => self.i = self.i + 2 + j + 2,
                    None => self.i = self.src.len(),
                }
            } else {
                break;
            }
        }
    }
    pub fn starts_with(&self, s: &str) -> bool {
        self.rest().starts_with(s)
    }
    pub fn eat(&mut self, s: &str) -> bool {
        if self.starts_with(s) {
            self.i += s.len();
            true
        } else {
            false
        }
    }
    pub fn expect(&mut self, s: &str) -> R<()> {
        if !self.eat(s) {
            return self.fail(&format!("expected '{}'", s));
        }
        Ok(())
    }
    pub fn fail<T>(&self, msg: &str) -> R<T> {
        let near: String = self.rest().chars().take(20).collect();
        let near = near.split('\n').next().unwrap_or("");
        let near = if near.trim().is_empty() { "at the end of the line".to_string() } else { format!("near '{}'", near) };
        let h = hint(self.src, self.i, msg);
        let tail = h.as_ref().map(|(_, t)| format!(" — {}", t)).unwrap_or_default();
        Err(ParseError(format!("line {}: {} {}{}", self.line(), msg, near, tail), Some(self.i), None, h.map(|(c, _)| c).unwrap_or("PARSE")))
    }
    pub fn ident(&mut self) -> Option<String> {
        let m = IDENT.find(self.rest())?;
        let s = m.as_str().to_string();
        self.i += s.len();
        Some(s)
    }
    fn tag_name(&mut self) -> Option<String> {
        let m = TAG.find(self.rest())?;
        let s = m.as_str().to_string();
        self.i += s.len();
        Some(s)
    }
    pub fn peek_ident(&self) -> Option<String> {
        IDENT.find(self.rest()).map(|m| m.as_str().to_string())
    }
    pub fn keyword(&mut self, k: &str) -> bool {
        let save = self.i;
        if self.ident().as_deref() == Some(k) && !is_ident_char(self.peek()) {
            return true;
        }
        self.i = save;
        false
    }
    fn ident_or(&mut self, what: &str) -> R<String> {
        match self.ident() {
            Some(s) => Ok(s),
            None => self.fail(what),
        }
    }
}

/// A TypeScript type, kept as text: balanced up to a depth-0 stop (`=`, `:=`, `,`, `)`, `=>`, `{` when `brace_stops`). 07 §2.
/// A type's text, up to where the declaration goes on. `=>` inside brackets is a function type, as it is anywhere in
/// a type alias (`arrows`); elsewhere at the top it starts a body (`fn f(): T => …`).
fn parse_type(c: &mut Cursor, brace_stops: bool, arrows: bool) -> R<String> {
    let start = c.i;
    let mut depth: i64 = 0;
    while !c.eof() {
        if c.starts_with("=>") && (depth > 0 || arrows) {
            c.bump();
            c.bump();
            continue;
        }
        let ch = c.peek();
        if depth == 0 && (c.starts_with("//") || c.starts_with("=>") || c.starts_with(":=") || ch == '=' || ch == ',' || ch == ')' || ch == ';' || ch == '\n' || (brace_stops && ch == '{')) {
            break;
        }
        if "([{<".contains(ch) {
            depth += 1;
        } else if ")]}>".contains(ch) {
            depth -= 1;
        }
        c.bump();
    }
    let t = js_trim(&c.src[start..c.i]).to_string();
    if t.is_empty() {
        return c.fail("type");
    }
    Ok(t)
}
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}
/// `x: T key k = …` (ST-4): the type ends where the key begins.
fn split_key(ty: Option<String>) -> (Option<String>, Option<String>) {
    if let Some(t) = &ty {
        if let Some(m) = SPLIT_KEY.captures(t) {
            return (Some(m[1].to_string()), Some(m[2].to_string()));
        }
    }
    (ty, None)
}
fn opt_type(c: &mut Cursor, brace_stops: bool) -> R<Option<String>> {
    c.ws(false);
    if c.peek() == ':' && c.peek_at(1) != '=' {
        c.bump();
        c.ws(true);
        return Ok(Some(parse_type(c, brace_stops, false)?));
    }
    Ok(None)
}
/// R-f: `A | B` — error class names. `Error` (or TS's `unknown`/`any`) is every failure: `None`.
fn parse_classes(c: &mut Cursor) -> R<Option<Vec<String>>> {
    let mut out = vec![];
    loop {
        c.ws(true);
        out.push(c.ident_or("error class")?);
        c.ws(false);
        if c.peek() == '|' && c.peek_at(1) != '|' {
            c.bump();
            continue;
        }
        break;
    }
    if out.iter().any(|n| n == "Error" || n == "unknown" || n == "any") {
        return Ok(None);
    }
    Ok(Some(out))
}

re!(JS_APIS, r"\b(useState|useReducer|useMemo|useCallback|useEffect|useRef|createSignal|createMemo|createEffect|createStore|createResource|createAsync)\s*\(");
re!(JS_FUNCTION, r"^(export\s+)?(default\s+)?(async\s+)?function\b");
re!(JS_LOCAL, r"^(const|let|var)\b");
re!(JS_RETURN, r"^return\b");
re!(NAME_BEFORE, r"([A-Za-z_$][A-Za-z0-9_$.]*)\s*$");
re!(ARROW_BEFORE, r"=>\s*[A-Za-z_$][A-Za-z0-9_$.]*\s*$");
re!(OP_ASSIGN, r"^(\+\+|--|(\*\*|\|\||&&|\?\?|[-+*/%])=)");

/// What a parse failure at `i` most likely meant, when the line reads like JavaScript, React or Solid: its code and the
/// text appended to the message. `ref/src/parse.ts` `hint` is the same function.
pub fn hint(src: &str, i: usize, msg: &str) -> Option<(&'static str, String)> {
    let i = i.min(src.len());
    let rest = &src[i..];
    let at = if !rest.is_empty() && !rest.split('\n').next().unwrap_or("").trim().is_empty() { i as i64 } else { src[..i].trim_end().len() as i64 - 1 };
    let p = at.max(0) as usize;
    let start = if p == 0 { 0 } else { src[..p].rfind('\n').map(|j| j + 1).unwrap_or(0) };
    let end = src[p..].find('\n').map(|j| p + j).unwrap_or(src.len());
    let line = src[start..end].trim();
    let before = &src[src[..i].rfind('\n').map(|j| j + 1).unwrap_or(0)..i];
    let name = NAME_BEFORE.captures(before).map(|c| c[1].to_string()).unwrap_or_else(|| "x".into());
    if msg.starts_with("W-2") && rest.starts_with(":=") && ARROW_BEFORE.is_match(before) {
        return Some(("REACTIVE_WRITE_IN_OWNED_SCOPE", format!("an arrow that writes takes a braced body, `() => {{ {} := … }}`: an expression-bodied arrow is a pure function (SC-3)", name)));
    }
    if OP_ASSIGN.is_match(rest) || (rest.starts_with('=') && !rest[1..].starts_with('=') && !rest[1..].starts_with('>')) {
        return Some(("ASSIGNMENT", format!("a source is written with `:=`, as a statement in a handler or action: `{n} := {n} + 1`, or `{n} := v => v + 1` (W-1, W-6); .rx has no `=`, `+=` or `++` on state", n = name)));
    }
    if JS_FUNCTION.is_match(line) {
        return Some(("JS_FUNCTION", "`function` is not .rx: a pure function is `fn f(x) => …`, one that writes or awaits is `action f(x) { … }`, one that renders is `component F(props) { … }`".into()));
    }
    if let Some(c) = JS_LOCAL.captures(line) {
        return Some(("JS_LOCAL", format!("`{}` declares a local only in a handler or action body: in a component or at a module's top level, state is `source x := …` and a value computed from others is an equation, `x = …`", &c[1])));
    }
    if JS_RETURN.is_match(line) {
        return Some(("JS_RETURN", "a component has no `return`: its body is declarations, then its markup".into()));
    }
    if let Some(c) = JS_APIS.captures(line) {
        return Some(("JS_API", format!("`{}` is not .rx: state is `source x := …`, a value computed from others is `x = …`, a side effect is `effect (x) {{ … }}`", &c[1])));
    }
    None
}

pub fn parse_program(src: &str) -> R<Program> {
    let mut c = Cursor::new(src);
    let mut decls = vec![];
    c.ws(true);
    while !c.eof() && looks_like_decl(&mut c) {
        decls.push(parse_decl(&mut c)?);
        c.ws(true);
        c.eat(";");
        c.ws(true);
    }
    let view = parse_markup(&mut c, Close::Top)?;
    c.ws(true);
    if !c.eof() {
        return c.fail("expected a declaration or markup");
    }
    let dflt: Vec<&Decl> = decls.iter().filter(|d| matches!(d, Decl::Component { is_default: true, .. })).collect();
    if dflt.len() > 1 {
        return c.fail("two default components: a module has one entry");
    }
    if view.is_empty() && !dflt.is_empty() {
        let (name, line) = match dflt[0] {
            Decl::Component { name, line, .. } => (name.clone(), *line),
            _ => unreachable!(),
        };
        let el = Markup { kind: MarkupKind::El { tag: name, attrs: vec![], children: vec![] }, line: Some(line), span: Span::NONE };
        return Ok(Program { decls, view: vec![el], legacy_view: None });
    }
    let legacy = !view.is_empty();
    Ok(Program { decls, view, legacy_view: Some(legacy) })
}

/// CP-8e: an editor's parse. A declaration that does not parse is left out (the error recorded, the parse resumed at the
/// next line that starts at column 0), and a missing member name or expression is an empty one, so the rest of the file
/// still projects. Never used to compile: `parse_program` is the language.
pub fn parse_program_recovering(src: &str) -> (Program, Vec<ParseError>) {
    let mut c = Cursor::new(src);
    c.recover = true;
    let mut decls = vec![];
    c.ws(true);
    while !c.eof() {
        if !looks_like_decl(&mut c) {
            let (at, n) = (c.i, c.errors.len());
            match parse_markup(&mut c, Close::Top) {
                Ok(view) if !view.is_empty() => {
                    let mut errors = c.errors;
                    errors.push(ParseError("line 1: markup at a module's top level (MO-1c)".into(), Some(at), None, "PARSE"));
                    return (Program { decls, view, legacy_view: Some(true) }, errors);
                }
                Ok(_) => break,
                Err(e) => {
                    c.errors.truncate(n);
                    c.errors.push(e);
                    c.i = at;
                    skip_line(&mut c);
                }
            }
        } else {
            let (at, n) = (c.i, c.errors.len());
            match parse_decl(&mut c) {
                Ok(d) => decls.push(d),
                Err(e) => {
                    // what the failed attempt noted on the way is moot: the declaration is out
                    c.errors.truncate(n);
                    c.errors.push(e);
                    c.i = at;
                    skip_line(&mut c);
                }
            }
        }
        c.ws(true);
        c.eat(";");
        c.ws(true);
    }
    let (view, legacy_view) = match decls.iter().find(|d| matches!(d, Decl::Component { is_default: true, .. })) {
        Some(Decl::Component { name, line, .. }) => (vec![Markup { kind: MarkupKind::El { tag: name.clone(), attrs: vec![], children: vec![] }, line: Some(*line), span: Span::NONE }], None),
        _ => (vec![], Some(false)),
    };
    (Program { decls, view, legacy_view }, c.errors)
}
/// On to the next line that starts at column 0 with something other than a closing brace (where a declaration may).
fn skip_line(c: &mut Cursor) {
    loop {
        match c.rest().find('\n') {
            None => {
                c.i = c.src.len();
                return;
            }
            Some(j) => c.i += j + 1,
        }
        let ch = c.peek();
        if !ch.is_whitespace() && ch != '}' && ch != '\0' {
            return;
        }
    }
}

/// MO-8: a declaration file (`api.d.rx`) for a JS module.
#[derive(Debug, Clone)]
pub enum JsDecl {
    Fn { name: String, pure: bool, params: Vec<String>, rejects: Option<Vec<String>>, line: usize, side: Option<Side>, ptypes: Vec<Option<String>>, ret: Option<String> },
    Error { name: String, line: usize },
    Type { name: String, line: usize, text: String },
}
impl JsDecl {
    pub fn name(&self) -> &str {
        match self {
            JsDecl::Fn { name, .. } | JsDecl::Error { name, .. } | JsDecl::Type { name, .. } => name,
        }
    }
}
pub fn parse_declarations(src: &str) -> R<Vec<JsDecl>> {
    let mut c = Cursor::new(src);
    let mut out = vec![];
    loop {
        c.ws(true);
        if c.eof() {
            return Ok(out);
        }
        let line = c.line();
        if !c.keyword("export") {
            return c.fail("a declaration file declares exports: `export pure fn …`, `export fn …`, `export error …`, `export type …`");
        }
        c.ws(true);
        if c.starts_with("type") || c.starts_with("interface") {
            let t0 = c.i;
            let _ = c.keyword("type") || c.keyword("interface");
            c.ws(true);
            let name = c.ident_or("type name")?;
            c.ws(true);
            if c.eat("=") {
                c.ws(true);
                parse_type(&mut c, false, true)?;
            } else if c.starts_with("{") {
                let mut depth = 0;
                loop {
                    if c.peek() == '{' {
                        depth += 1;
                    }
                    if c.peek() == '}' {
                        depth -= 1;
                    }
                    c.bump();
                    if c.eof() || depth == 0 {
                        break;
                    }
                }
            }
            out.push(JsDecl::Type { name, line, text: c.src[t0..c.i].to_string() });
            continue;
        }
        if c.keyword("error") {
            c.ws(true);
            let name = c.ident_or("error class name")?;
            out.push(JsDecl::Error { name, line });
            continue;
        }
        let side = if c.keyword("server") {
            Some(Side::Server)
        } else if c.keyword("client") {
            Some(Side::Client)
        } else {
            None
        };
        c.ws(true);
        let pure = c.keyword("pure");
        c.ws(true);
        if !c.keyword("fn") {
            return c.fail("fn");
        }
        c.ws(true);
        let name = c.ident_or("fn name")?;
        c.ws(true);
        c.expect("(")?;
        c.ws(true);
        let mut params = vec![];
        let mut ptypes = vec![];
        while !c.starts_with(")") {
            params.push(c.ident_or("param")?);
            ptypes.push(opt_type(&mut c, false)?);
            c.ws(true);
            if !c.eat(",") {
                break;
            }
            c.ws(true);
        }
        c.expect(")")?;
        let save = c.i;
        c.ws(false);
        let mut ret = None;
        if c.peek() == ':' {
            c.bump();
            c.ws(true);
            let t = c.rest().split('\n').next().unwrap_or("").to_string();
            let r = REJECTS.find(&t).map(|m| m.end() - "rejects(".len());
            let head = match r {
                Some(at) => &t[..at],
                None => &t[..],
            };
            let head = LINE_COMMENT.replace(head, "");
            let head = js_trim(&head).to_string();
            ret = if head.is_empty() { None } else { Some(head) };
            c.i += r.unwrap_or(t.len());
        } else {
            c.i = save;
        }
        c.ws(false);
        let mut rejects = None;
        if c.keyword("rejects") {
            c.ws(true);
            c.expect("(")?;
            rejects = Some(parse_classes(&mut c)?.unwrap_or_else(|| vec!["Error".to_string()]));
            c.ws(true);
            c.expect(")")?;
        }
        out.push(JsDecl::Fn { name, pure, params, rejects, line, side, ptypes, ret });
    }
}

fn params_typed(c: &mut Cursor) -> R<(Vec<String>, Vec<Option<String>>)> {
    let mut params = vec![];
    let mut ptypes = vec![];
    while !c.starts_with(")") {
        params.push(c.ident_or("param")?);
        ptypes.push(opt_type(c, false)?);
        c.ws(true);
        if !c.eat(",") {
            break;
        }
        c.ws(true);
    }
    Ok((params, ptypes))
}

fn parse_decl(c: &mut Cursor) -> R<Decl> {
    c.ws(true);
    let start = c.i;
    let mut d = parse_decl_at(c)?;
    d.set_span(Span::new(start, c.i));
    Ok(d)
}
fn parse_decl_at(c: &mut Cursor) -> R<Decl> {
    let line = c.line();
    if c.keyword("export") {
        c.ws(true);
        if c.keyword("default") {
            c.ws(true);
            let mut d = parse_decl(c)?;
            match &mut d {
                Decl::Component { exported, is_default, .. } => {
                    *exported = true;
                    *is_default = true;
                }
                _ => return c.fail("export default: only a component is a module's default export (the app's entry, MO-1c)"),
            }
            return Ok(d);
        }
        let mut d = parse_decl(c)?;
        if matches!(d, Decl::Import { .. } | Decl::Effect { .. } | Decl::Provide { .. }) {
            return c.fail("export of a non-declaration");
        }
        d.set_exported();
        return Ok(d);
    }
    if c.keyword("import") {
        c.ws(true);
        let side = if IMPORT_SIDE.is_match(c.rest()) {
            if c.keyword("server") {
                Some(Side::Server)
            } else {
                c.keyword("client");
                Some(Side::Client)
            }
        } else {
            None
        };
        c.ws(true);
        let pure = c.keyword("pure");
        c.ws(true);
        let mut names = vec![];
        if c.eat("{") {
            c.ws(true);
            while !c.starts_with("}") {
                let name = c.ident_or("import name")?;
                c.ws(true);
                let mut alias = name.clone();
                if c.keyword("as") {
                    c.ws(true);
                    alias = c.ident_or("alias")?;
                    c.ws(true);
                }
                names.push(ImportName { name, alias });
                if !c.eat(",") {
                    break;
                }
                c.ws(true);
            }
            c.expect("}")?;
        } else {
            let name = c.ident_or("import name")?;
            names.push(ImportName { name: "default".into(), alias: name });
        }
        c.ws(true);
        if !c.keyword("from") {
            return c.fail("from");
        }
        c.ws(true);
        let from = match parse_primary(c)?.k {
            ExprKind::Lit(Lit::Str(s)) => s,
            _ => return c.fail("module path"),
        };
        let save = c.i;
        c.ws(false);
        let mk = |fails| Decl::Import { names, from, pure, side, line, span: Span::NONE, fails, resolved: None, declared: None, declared_errors: None, declared_pure: None, declared_side: None };
        if c.keyword("fails") {
            c.ws(true);
            let fails = parse_classes(c)?.unwrap_or_else(|| vec!["Error".to_string()]);
            return Ok(mk(Some(fails)));
        }
        c.i = save;
        return Ok(mk(None));
    }
    if ERROR_DECL.is_match(c.rest()) {
        c.keyword("error");
        c.ws(true);
        let name = c.ident_or("error class name")?;
        c.ws(false);
        let mut params = vec![];
        let mut ptypes = vec![];
        if c.eat("(") {
            c.ws(true);
            while !c.starts_with(")") {
                params.push(c.ident_or("field")?);
                ptypes.push(opt_type(c, false)?);
                c.ws(true);
                if !c.eat(",") {
                    break;
                }
                c.ws(true);
            }
            c.expect(")")?;
        }
        let save = c.i;
        c.ws(false);
        if c.eat("=>") {
            c.ws(true);
            let msg = parse_expr(c)?;
            return Ok(Decl::Error { name, params, ptypes, msg: Some(msg), line, span: Span::NONE, exported: false });
        }
        c.i = save;
        return Ok(Decl::Error { name, params, ptypes, msg: None, line, span: Span::NONE, exported: false });
    }
    if TYPE_DECL.is_match(c.rest()) {
        let t0 = c.i;
        let _ = c.keyword("type") || c.keyword("interface");
        c.ws(true);
        let name = c.ident_or("type name")?;
        c.ws(true);
        if c.eat("=") {
            c.ws(true);
            parse_type(c, false, true)?;
        } else {
            c.expect("{")?;
            let mut depth = 1;
            while !c.eof() && depth != 0 {
                if c.peek() == '{' {
                    depth += 1;
                }
                if c.peek() == '}' {
                    depth -= 1;
                }
                c.bump();
            }
        }
        return Ok(Decl::TypeDecl { name, line, span: Span::NONE, text: c.src[t0..c.i].to_string(), exported: false });
    }
    if c.keyword("source") {
        c.ws(true);
        let name = c.ident_or("source name")?;
        let (ty, mut key) = split_key(opt_type(c, false)?);
        c.ws(true);
        if SOURCE_KEY.is_match(c.rest()) {
            c.keyword("key");
            c.ws(true);
            key = Some(c.ident_or("key name")?);
            c.ws(true);
        }
        if c.eat(":=") {
            c.ws(true);
            let init = parse_expr(c)?;
            return Ok(Decl::Source { name, init, line, span: Span::NONE, question: false, ty, exported: false, key });
        }
        c.expect("=")?;
        c.ws(true);
        let init = parse_expr(c)?;
        return Ok(Decl::Source { name, init, line, span: Span::NONE, question: true, ty, exported: false, key });
    }
    if c.keyword("effect") {
        c.ws(true);
        c.expect("(")?;
        c.ws(true);
        let mut inputs = vec![];
        while !c.starts_with(")") {
            inputs.push(parse_expr(c)?);
            c.ws(true);
            if !c.eat(",") {
                break;
            }
            c.ws(true);
        }
        c.expect(")")?;
        c.ws(true);
        let body = parse_block(c)?;
        return Ok(Decl::Effect { inputs, body, line, span: Span::NONE });
    }
    if c.keyword("deferred") {
        c.ws(true);
        let name = c.ident_or("deferred name")?;
        let ty = opt_type(c, false)?;
        c.ws(true);
        c.expect("=")?;
        c.ws(true);
        let e = parse_expr(c)?;
        return Ok(Decl::Eq { name, e, line, span: Span::NONE, deferred: true, key: None, ty, exported: false });
    }
    if c.keyword("action") {
        c.ws(true);
        let name = c.ident_or("action name")?;
        c.ws(true);
        c.expect("(")?;
        c.ws(true);
        let (params, ptypes) = params_typed(c)?;
        c.expect(")")?;
        c.ws(true);
        let body = parse_block(c)?;
        return Ok(Decl::Action { name, params, ptypes, body, line, span: Span::NONE, exported: false });
    }
    if SERVER_DECL.is_match(c.rest()) {
        c.keyword("server");
        c.ws(true);
        if c.keyword("action") {
            return c.fail("`server fn` (SF-1: one form — it is io when its body is; there is no `server action`)");
        }
        c.keyword("fn");
        c.ws(true);
        let name = c.ident_or("server function name")?;
        c.ws(true);
        c.expect("(")?;
        c.ws(true);
        let (params, ptypes) = params_typed(c)?;
        c.expect(")")?;
        let ret = opt_type(c, true)?;
        c.ws(true);
        let body = parse_block(c)?;
        return Ok(Decl::Server { name, params, ptypes, ret, body, line, span: Span::NONE, exported: false });
    }
    if c.keyword("context") {
        c.ws(true);
        let name = c.ident_or("context name")?;
        c.ws(false);
        let mut ty = None;
        let mut source = false;
        if c.peek() == ':' && c.peek_at(1) != '=' {
            c.bump();
            c.ws(true);
            source = c.keyword("source");
            c.ws(true);
            ty = Some(parse_type(c, false, false)?);
        }
        let save = c.i;
        c.ws(false);
        if c.peek() == '=' && c.peek_at(1) != '=' && c.peek_at(1) != '>' {
            c.bump();
            c.ws(true);
            let dflt = parse_expr(c)?;
            return Ok(Decl::Context { name, ty, source, dflt: Some(dflt), line, span: Span::NONE, exported: false });
        }
        c.i = save;
        return Ok(Decl::Context { name, ty, source, dflt: None, line, span: Span::NONE, exported: false });
    }
    if c.keyword("provide") {
        c.ws(true);
        let name = c.ident_or("provide name")?;
        c.ws(true);
        c.expect("=")?;
        c.ws(true);
        let e = parse_expr(c)?;
        return Ok(Decl::Provide { name, e, line, span: Span::NONE });
    }
    if c.keyword("fn") {
        c.ws(true);
        let name = c.ident_or("fn name")?;
        c.ws(true);
        c.expect("(")?;
        c.ws(true);
        let mut params = vec![];
        while !c.starts_with(")") {
            let r = c.keyword("ref");
            c.ws(true);
            let pname = c.ident_or("param")?;
            let ty = opt_type(c, false)?;
            params.push(Param { name: pname, r#ref: r, ty });
            c.ws(true);
            if !c.eat(",") {
                break;
            }
            c.ws(true);
        }
        c.expect(")")?;
        let ret = opt_type(c, true)?;
        c.ws(true);
        if c.eat("=>") {
            c.ws(true);
            let tail = parse_expr(c)?;
            return Ok(Decl::Fn { name, params, decls: vec![], tail, line, span: Span::NONE, ret, exported: false });
        }
        c.expect("{")?;
        let mut decls = vec![];
        loop {
            c.ws(true);
            if !looks_like_decl(c) {
                break;
            }
            decls.push(parse_decl(c)?);
            c.ws(true);
            c.eat(";");
        }
        c.ws(true);
        let tail = parse_expr(c)?;
        c.ws(true);
        c.expect("}")?;
        return Ok(Decl::Fn { name, params, decls, tail, line, span: Span::NONE, ret, exported: false });
    }
    if c.keyword("component") {
        c.ws(true);
        let name = c.ident_or("component name")?;
        c.ws(true);
        c.expect("(")?;
        c.ws(true);
        let props = if c.peek() == ')' { "props".to_string() } else { c.ident_or("props name")? };
        let props_type = opt_type(c, false)?;
        c.ws(true);
        c.expect(")")?;
        c.ws(true);
        c.expect("{")?;
        let (decls, view) = parse_block_body(c)?;
        return Ok(Decl::Component { name, props, decls, view, line, span: Span::NONE, props_type, exported: false, is_default: false });
    }
    let save = c.i;
    let name = c.ident();
    c.ws(false);
    let mut key = None;
    let mut ty = None;
    let plain = name.as_deref().is_some_and(|n| !is_kw(n));
    if plain {
        let (t, k) = split_key(opt_type(c, false)?);
        ty = t;
        key = k;
        c.ws(false);
    }
    if plain && EQ_KEY.is_match(c.rest()) {
        c.keyword("key");
        c.ws(true);
        key = Some(c.ident_or("key name")?);
        c.ws(false);
    }
    if plain && c.peek() == '=' && c.peek_at(1) != '=' && c.peek_at(1) != '>' {
        c.bump();
        c.ws(true);
        let e = parse_expr(c)?;
        return Ok(Decl::Eq { name: name.unwrap(), e, line, span: Span::NONE, deferred: false, key, ty, exported: false });
    }
    c.i = save;
    if c.peek_ident().is_some() && WRITE_AHEAD.is_match(c.rest()) {
        return c.fail("W-2: write in reactive scope (no statement position)");
    }
    c.fail("declaration")
}

pub fn parse_block(c: &mut Cursor) -> R<Vec<Stmt>> {
    c.ws(true);
    c.expect("{")?;
    c.ws(true);
    let mut out = vec![];
    while !c.starts_with("}") {
        out.push(parse_stmt(c)?);
        c.ws(true);
        c.eat(";");
        c.ws(true);
    }
    c.expect("}")?;
    Ok(out)
}

pub fn parse_stmts(src: &str) -> R<Vec<Stmt>> {
    let mut c = Cursor::new(src);
    let mut out = vec![];
    c.ws(true);
    while !c.eof() {
        out.push(parse_stmt(&mut c)?);
        c.ws(true);
        c.eat(";");
        c.ws(true);
    }
    Ok(out)
}

fn parse_path(c: &mut Cursor) -> R<Vec<PathSeg>> {
    let mut path = vec![];
    loop {
        if c.eat(".") {
            path.push(PathSeg::Name(c.ident_or("member")?));
        } else if c.eat("[") {
            c.ws(true);
            path.push(PathSeg::Expr(parse_expr(c)?));
            c.ws(true);
            c.expect("]")?;
        } else {
            break;
        }
    }
    Ok(path)
}

fn parse_stmt(c: &mut Cursor) -> R<Stmt> {
    c.ws(true);
    let start = c.i;
    if c.keyword("guess") {
        c.ws(true);
        let name = c.ident_or("target")?;
        let path = parse_path(c)?;
        c.ws(true);
        c.expect(":=")?;
        c.ws(true);
        let e = parse_expr(c)?;
        return Ok(st(start, StmtKind::Optimistic { target: Target { name, path, ctx: None }, e }, c));
    }
    if c.keyword("refresh") {
        c.ws(true);
        return Ok(st(start, StmtKind::Refresh(c.ident_or("name")?), c));
    }
    if c.keyword("affects") {
        c.ws(true);
        return Ok(st(start, StmtKind::Affects(c.ident_or("name")?), c));
    }
    if c.keyword("action") {
        c.ws(true);
        return Ok(st(start, StmtKind::Action(parse_block(c)?), c));
    }
    if c.keyword("let") || c.keyword("const") {
        c.ws(true);
        let name = c.ident_or("let name")?;
        let ty = opt_type(c, false)?;
        c.ws(true);
        c.expect("=")?;
        c.ws(true);
        let e = parse_expr(c)?;
        return Ok(st(start, StmtKind::Let { name, e, ty }, c));
    }
    if c.keyword("try") {
        c.ws(true);
        let body = parse_block(c)?;
        c.ws(true);
        let mut catch_name = None;
        let mut handler = None;
        let mut fin = None;
        let mut catch_classes = None;
        if c.keyword("catch") {
            c.ws(true);
            if c.eat("(") {
                c.ws(true);
                catch_name = Some(c.ident_or("catch name")?);
                c.ws(false);
                if c.eat(":") {
                    catch_classes = parse_classes(c)?;
                }
                c.ws(true);
                c.expect(")")?;
            }
            c.ws(true);
            handler = Some(parse_block(c)?);
            c.ws(true);
        }
        if c.keyword("finally") {
            c.ws(true);
            fin = Some(parse_block(c)?);
        }
        if handler.is_none() && fin.is_none() {
            return c.fail("catch or finally");
        }
        return Ok(st(start, StmtKind::Try { body, catch_name, catch_classes, handler, fin }, c));
    }
    if c.keyword("throw") {
        c.ws(true);
        return Ok(st(start, StmtKind::Throw(parse_expr(c)?), c));
    }
    if c.keyword("return") {
        c.ws(false);
        if c.peek() == '}' || c.peek() == ';' || c.peek() == '\n' || c.eof() {
            return Ok(st(start, StmtKind::Return(None), c));
        }
        return Ok(st(start, StmtKind::Return(Some(parse_expr(c)?)), c));
    }
    if c.keyword("if") {
        c.ws(true);
        c.expect("(")?;
        c.ws(true);
        let cond = parse_expr(c)?;
        c.ws(true);
        c.expect(")")?;
        c.ws(true);
        let t = if c.peek() == '{' { parse_block(c)? } else { vec![parse_stmt(c)?] };
        c.ws(true);
        let mut f = vec![];
        if c.keyword("else") {
            c.ws(true);
            f = if c.peek() == '{' { parse_block(c)? } else { vec![parse_stmt(c)?] };
        }
        return Ok(st(start, StmtKind::Sif { c: cond, t, f }, c));
    }
    // write?  target := expr
    let save = c.i;
    let mut name = c.ident();
    let mut ctx = false;
    if name.as_deref() == Some("use") {
        c.ws(true);
        name = Some(c.ident_or("provision name")?);
        ctx = true;
    }
    if let Some(n) = name {
        if !is_kw(&n) || ctx {
            let path = parse_path(c)?;
            c.ws(false);
            if c.eat(":=") {
                c.ws(true);
                let e = parse_expr(c)?;
                return Ok(st(start, StmtKind::Write { target: Target { name: n, path, ctx: Some(ctx) }, e }, c));
            }
        }
    }
    c.i = save;
    Ok(st(start, StmtKind::Expr(parse_expr(c)?), c))
}

// ---- expressions ----
/// An expression, with any trailing `catch (x: A | B) => alt` (R-f-4).
pub fn parse_expr(c: &mut Cursor) -> R<Expr> {
    let mut e = parse_expr_no_catch(c)?;
    let start = e.span.start as usize;
    loop {
        let save = c.i;
        c.ws(true);
        if !c.keyword("catch") {
            c.i = save;
            return Ok(e);
        }
        c.ws(true);
        let mut name = None;
        let mut classes = None;
        if c.eat("(") {
            c.ws(true);
            name = Some(c.ident_or("catch name")?);
            c.ws(false);
            if c.eat(":") {
                classes = parse_classes(c)?;
            }
            c.ws(true);
            c.expect(")")?;
            c.ws(true);
        }
        c.expect("=>")?;
        c.ws(true);
        let alt = parse_expr_no_catch(c)?;
        e = Expr::new(ExprKind::Catch { e: Box::new(e), name, classes, alt: Box::new(alt) }, Span::new(start, c.i));
    }
}

fn draft_ahead(c: &Cursor) -> bool {
    if !(c.starts_with("draft") && DRAFT.is_match(c.rest())) {
        return false;
    }
    let b = c.src.as_bytes();
    let mut i = c.i + 5;
    let mut depth = 0;
    while i < b.len() {
        let ch = b[i];
        if ch == b'(' {
            depth += 1;
        } else if ch == b')' {
            depth -= 1;
            if depth == 0 {
                break;
            }
        }
        i += 1;
    }
    let from = (i + 1).min(c.src.len());
    c.src.is_char_boundary(from) && BRACE_AHEAD.is_match(&c.src[from..])
}

fn parse_expr_no_catch(c: &mut Cursor) -> R<Expr> {
    c.ws(true);
    let start = c.i;
    if draft_ahead(c) {
        c.keyword("draft");
        c.ws(true);
        c.expect("(")?;
        c.ws(true);
        let seed = parse_expr(c)?;
        c.ws(true);
        c.expect(")")?;
        c.ws(true);
        let body = parse_block(c)?;
        return Ok(ex(start, ExprKind::Draft { seed: Box::new(seed), body }, c));
    }
    {
        // 07 §3: TS arrow functions, verbatim — `x => e`, `(a, b) => e`
        let save = c.i;
        let mut params = vec![];
        let mut ok = false;
        if c.peek() == '(' {
            c.bump();
            c.ws(true);
            ok = true;
            while !c.starts_with(")") {
                match c.ident() {
                    Some(id) => params.push(id),
                    None => {
                        ok = false;
                        break;
                    }
                }
                c.ws(true);
                if !c.eat(",") {
                    break;
                }
                c.ws(true);
            }
            if ok && c.eat(")") {
                c.ws(false);
                ok = c.starts_with("=>");
            } else {
                ok = false;
            }
        } else if let Some(id) = c.ident() {
            if !is_kw(&id) {
                params.push(id);
                c.ws(false);
                ok = c.starts_with("=>");
            }
        }
        if ok {
            c.expect("=>")?;
            c.ws(true);
            if c.peek() == '{' {
                let at = c.i;
                if let Ok(stmts) = parse_block(c) {
                    if stmts.iter().any(|st| !matches!(&st.k, StmtKind::Expr(Expr { k: ExprKind::Id(_), .. }))) {
                        return Ok(ex(start, ExprKind::Fn { params, body: Box::new(Expr::made(ExprKind::Lit(Lit::Undefined))), stmts: Some(stmts) }, c));
                    }
                }
                c.i = at;
            }
            let body = parse_expr(c)?;
            return Ok(ex(start, ExprKind::Fn { params, body: Box::new(body), stmts: None }, c));
        }
        c.i = save;
    }
    if c.keyword("fn") {
        c.ws(true);
        c.expect("(")?;
        c.ws(true);
        let mut params = vec![];
        while !c.starts_with(")") {
            params.push(c.ident_or("param")?);
            c.ws(true);
            if !c.eat(",") {
                break;
            }
            c.ws(true);
        }
        c.expect(")")?;
        c.ws(true);
        c.expect("=>")?;
        c.ws(true);
        let body = parse_expr(c)?;
        return Ok(ex(start, ExprKind::Fn { params, body: Box::new(body), stmts: None }, c));
    }
    let cond = parse_bin(c, 0)?;
    c.ws(false);
    if c.starts_with(":=") {
        return c.fail("W-2: write in reactive scope (no statement position)");
    }
    if c.peek() == '?' && c.peek_at(1) != '.' {
        c.bump();
        c.ws(true);
        let t = parse_expr_no_catch(c)?;
        c.ws(true);
        c.expect(":")?;
        c.ws(true);
        let f = parse_expr_no_catch(c)?;
        return Ok(ex(cond.span.start as usize, ExprKind::If { c: Box::new(cond), t: Box::new(t), f: Box::new(f) }, c));
    }
    Ok(cond)
}

const LEVELS: &[&[&str]] = &[&["??"], &["||"], &["&&"], &["===", "!==", "==", "!="], &["<=", ">=", "<", ">"], &["+", "-"], &["*", "/", "%"]];
fn parse_bin(c: &mut Cursor, lvl: usize) -> R<Expr> {
    if lvl >= LEVELS.len() {
        return parse_unary(c);
    }
    let mut l = parse_bin(c, lvl + 1)?;
    let start = l.span.start as usize;
    loop {
        c.ws(false);
        let op = LEVELS[lvl].iter().find(|o| c.starts_with(o) && !(**o == "-" && c.peek_at(1) == '>'));
        let Some(op) = op else { return Ok(l) };
        c.i += op.len();
        c.ws(true);
        let r = parse_bin(c, lvl + 1)?;
        let op = match *op {
            "===" => "==",
            "!==" => "!=",
            o => o,
        };
        l = Expr::new(ExprKind::Bin { op: op.to_string(), l: Box::new(l), r: Box::new(r) }, Span::new(start, c.i));
    }
}
fn parse_unary(c: &mut Cursor) -> R<Expr> {
    c.ws(true);
    let start = c.i;
    if c.eat("!") {
        return Ok(ex(start, ExprKind::Un { op: "!".into(), e: Box::new(parse_unary(c)?) }, c));
    }
    if c.peek() == '-' && c.peek_at(1) != '>' {
        c.bump();
        return Ok(ex(start, ExprKind::Un { op: "-".into(), e: Box::new(parse_unary(c)?) }, c));
    }
    if c.keyword("pre") {
        c.ws(true);
        let name = c.ident_or("pre name")?;
        c.ws(false);
        if c.eat("->") {
            c.ws(true);
            return Ok(ex(start, ExprKind::Pre { name, init: Some(Box::new(parse_unary(c)?)) }, c));
        }
        return Ok(ex(start, ExprKind::Pre { name, init: None }, c));
    }
    if c.keyword("peek") {
        c.ws(true);
        return Ok(ex(start, ExprKind::Peek(Box::new(parse_unary(c)?)), c));
    }
    if c.keyword("await") {
        let stream = c.eat("*");
        c.ws(true);
        let e = parse_unary(c)?;
        c.ws(false);
        if c.eat("->") {
            c.ws(true);
            let init = parse_unary(c)?;
            return Ok(ex(start, ExprKind::Await { e: Box::new(e), init: Some(Box::new(init)), stream }, c));
        }
        return Ok(ex(start, ExprKind::Await { e: Box::new(e), init: None, stream }, c));
    }
    if c.keyword("latest") {
        c.ws(true);
        return Ok(ex(start, ExprKind::Latest(Box::new(parse_unary(c)?)), c));
    }
    if c.keyword("throw") {
        c.ws(true);
        return Ok(ex(start, ExprKind::Throw(Box::new(parse_unary(c)?)), c));
    }
    if c.keyword("use") {
        c.ws(true);
        return Ok(ex(start, ExprKind::Use(c.ident_or("context name")?), c));
    }
    if c.starts_with("pending?") {
        c.i += 8;
        c.ws(true);
        return Ok(ex(start, ExprKind::Pending(Box::new(parse_unary(c)?)), c));
    }
    parse_postfix(c)
}
fn parse_postfix(c: &mut Cursor) -> R<Expr> {
    let mut e = parse_primary(c)?;
    let start = e.span.start as usize;
    loop {
        if c.eat("?.") {
            if c.peek() == '[' {
                c.bump();
                c.ws(true);
                let i = parse_expr(c)?;
                c.ws(true);
                c.expect("]")?;
                e = Expr::new(ExprKind::Index { o: Box::new(e), i: Box::new(i), opt: true }, Span::new(start, c.i));
            } else {
                let p = c.member()?;
                e = Expr::new(ExprKind::Member { o: Box::new(e), p, opt: true }, Span::new(start, c.i));
            }
        } else if c.eat(".") {
            let p = c.member()?;
            e = Expr::new(ExprKind::Member { o: Box::new(e), p, opt: false }, Span::new(start, c.i));
        } else if c.peek() == '[' {
            c.bump();
            c.ws(true);
            let i = parse_expr(c)?;
            c.ws(true);
            c.expect("]")?;
            e = Expr::new(ExprKind::Index { o: Box::new(e), i: Box::new(i), opt: false }, Span::new(start, c.i));
        } else if c.peek() == '(' {
            c.bump();
            c.ws(true);
            let mut args = vec![];
            while !c.starts_with(")") {
                args.push(parse_expr(c)?);
                c.ws(true);
                if !c.eat(",") {
                    break;
                }
                c.ws(true);
            }
            c.expect(")")?;
            e = Expr::new(ExprKind::Call { f: Box::new(e), args }, Span::new(start, c.i));
        } else {
            return Ok(e);
        }
    }
}
fn parse_primary(c: &mut Cursor) -> R<Expr> {
    c.ws(true);
    let start = c.i;
    if STYLE.is_match(c.rest()) {
        let line = c.line();
        c.i += "<style".len();
        c.ws(true);
        if !c.eat(">") {
            return c.fail("CSS-5: a class map is `<style>…</style>`, with no attributes");
        }
        let Some(end) = c.rest().find("</style>") else { return c.fail("expected </style>") };
        let css = c.rest()[..end].to_string();
        c.i += end + "</style>".len();
        return Ok(ex(start, ExprKind::StyleMap { css, line }, c));
    }
    if SERVER_FN_EXPR.is_match(c.rest()) {
        c.keyword("server");
        c.ws(true);
        c.keyword("fn");
        c.ws(true);
        c.expect("(")?;
        c.ws(true);
        let (params, ptypes) = params_typed(c)?;
        c.expect(")")?;
        let ret = opt_type(c, true)?;
        c.ws(true);
        let body = parse_block(c)?;
        return Ok(ex(start, ExprKind::ServerFn { params, ptypes, ret, body }, c));
    }
    let ch = c.peek();
    if ch == '`' {
        c.bump();
        let mut parts = vec![];
        let mut s = String::new();
        while !c.eof() && c.peek() != '`' {
            if c.starts_with("${") {
                c.i += 2;
                if !s.is_empty() {
                    parts.push(TplPart::Str(std::mem::take(&mut s)));
                }
                c.ws(true);
                parts.push(TplPart::Expr(parse_expr(c)?));
                c.ws(true);
                c.expect("}")?;
                continue;
            }
            if c.peek() == '\\' {
                c.bump();
            }
            if !c.eof() {
                s.push(c.peek());
            }
            c.bump();
        }
        c.expect("`")?;
        if !s.is_empty() || parts.is_empty() {
            parts.push(TplPart::Str(s));
        }
        return Ok(ex(start, ExprKind::Tpl(parts), c));
    }
    if ch == '"' || ch == '\'' {
        c.bump();
        let mut s = String::new();
        while !c.eof() && c.peek() != ch {
            if c.peek() == '\\' {
                c.bump();
            }
            if !c.eof() {
                s.push(c.peek());
            }
            c.bump();
        }
        c.expect(&ch.to_string())?;
        return Ok(ex(start, ExprKind::Lit(Lit::Str(s)), c));
    }
    if let Some(m) = NUMBER.find(c.rest()) {
        let text = m.as_str().to_string();
        c.i += text.len();
        return Ok(ex(start, ExprKind::Lit(Lit::Num(text.replace('_', "").parse::<f64>().unwrap_or(f64::NAN))), c));
    }
    if c.eat("(") {
        c.ws(true);
        let e = parse_expr(c)?;
        c.ws(true);
        c.expect(")")?;
        return Ok(e);
    }
    if c.eat("[") {
        c.ws(true);
        let mut items = vec![];
        while !c.starts_with("]") {
            let s0 = c.i;
            if c.eat("...") {
                c.ws(true);
                items.push(ex(s0, ExprKind::Spread(Box::new(parse_expr(c)?)), c));
            } else {
                items.push(parse_expr(c)?);
            }
            c.ws(true);
            if !c.eat(",") {
                break;
            }
            c.ws(true);
        }
        c.expect("]")?;
        return Ok(ex(start, ExprKind::Arr(items), c));
    }
    if c.eat("{") {
        c.ws(true);
        let mut fields = vec![];
        while !c.starts_with("}") {
            if c.eat("...") {
                c.ws(true);
                fields.push(Field::Spread(parse_expr(c)?));
                c.ws(true);
                if !c.eat(",") {
                    break;
                }
                c.ws(true);
                continue;
            }
            let k0 = c.i;
            let key = match c.ident() {
                Some(k) => k,
                None => {
                    if c.peek() == '"' || c.peek() == '\'' {
                        match parse_primary(c)?.k {
                            ExprKind::Lit(Lit::Str(s)) => s,
                            _ => unreachable!(),
                        }
                    } else {
                        return c.fail("field");
                    }
                }
            };
            c.ws(true);
            if c.eat(":") {
                c.ws(true);
                let v = parse_expr(c)?;
                fields.push(Field::Kv { key, v });
            } else {
                fields.push(Field::Kv { v: Expr::new(ExprKind::Id(key.clone()), Span::new(k0, k0 + key.len())), key });
            }
            c.ws(true);
            if !c.eat(",") {
                break;
            }
            c.ws(true);
        }
        c.expect("}")?;
        return Ok(ex(start, ExprKind::Rec(fields), c));
    }
    if c.keyword("true") {
        return Ok(ex(start, ExprKind::Lit(Lit::Bool(true)), c));
    }
    if c.keyword("false") {
        return Ok(ex(start, ExprKind::Lit(Lit::Bool(false)), c));
    }
    if c.keyword("undefined") {
        return Ok(ex(start, ExprKind::Lit(Lit::Undefined), c));
    }
    if c.keyword("null") {
        return Ok(ex(start, ExprKind::Lit(Lit::Null), c));
    }
    if c.recover && (c.i == 0 || c.src.as_bytes()[c.i - 1] == b'\n') && looks_like_decl(c) {
        c.note("expression");
        return Ok(ex(start, ExprKind::Id(String::new()), c));
    }
    if let Some(id) = c.ident() {
        return Ok(ex(start, ExprKind::Id(id), c));
    }
    if c.recover {
        // a missing expression; what follows (on its own line) is the next declaration's
        c.note("expression");
        return Ok(ex(start, ExprKind::Id(String::new()), c));
    }
    c.fail("expression")
}

// ---- markup ----
#[derive(Clone)]
enum Close {
    /// the top level: markup runs to the end of input
    Top,
    /// a control form's body, up to `}`
    Brace,
    /// an element, up to `</tag>` (`""`: a fragment's `</>`)
    Tag(String),
}

fn parse_markup(c: &mut Cursor, close: Close) -> R<Vec<Markup>> {
    let mut out: Vec<Markup> = vec![];
    let in_element = matches!(close, Close::Tag(_));
    let close_text = match &close {
        Close::Top => None,
        Close::Brace => Some("}".to_string()),
        Close::Tag(t) => Some(t.clone()),
    };
    let mut broke = false;
    loop {
        let start = c.i;
        if in_element {
            let mut s = String::new();
            while !c.eof() && " \t\r\n".contains(c.peek()) {
                s.push(c.peek());
                c.bump();
            }
            broke = s.contains('\n');
            let tag = close_text.as_deref().unwrap();
            if !s.is_empty() && !broke && !c.starts_with(&format!("</{}>", tag)) && !out.is_empty() {
                out.push(Markup { kind: MarkupKind::Text(" ".into()), line: None, span: Span::NONE });
            }
        } else {
            c.ws(true);
        }
        if c.eof() {
            if let Some(t) = &close_text {
                return c.fail(&format!("expected </{}>", t));
            }
            return Ok(out);
        }
        if let Close::Tag(t) = &close {
            if c.starts_with(&format!("</{}>", t)) {
                c.i += t.len() + 3;
                return Ok(out);
            }
        }
        if matches!(close, Close::Brace) && c.starts_with("}") {
            c.bump();
            return Ok(out);
        }
        let line = c.line();
        let m0 = c.i;
        if c.starts_with("<") {
            let mut m = parse_element(c)?;
            m.line = Some(line);
            m.span = Span::new(m0, c.i);
            out.push(m);
            continue;
        }
        if c.starts_with("{") {
            c.bump();
            c.ws(true);
            if let Some(mut ctl) = parse_control(c)? {
                c.ws(true);
                c.expect("}")?;
                ctl.line = Some(line);
                ctl.span = Span::new(m0, c.i);
                out.push(ctl);
                continue;
            }
            let e = parse_expr(c)?;
            c.ws(true);
            c.expect("}")?;
            out.push(Markup { kind: MarkupKind::Read(e), line: Some(line), span: Span::new(m0, c.i) });
            continue;
        }
        if !in_element {
            if let Some(mut ctl) = parse_control(c)? {
                ctl.line = Some(line);
                ctl.span = Span::new(m0, c.i);
                out.push(ctl);
                continue;
            }
        }
        if matches!(close, Close::Top) && looks_like_decl(c) {
            return c.fail("declaration after markup: a block is declarations, then its view");
        }
        let mut s = String::new();
        let s0 = c.i;
        while !c.eof() && !"<{}\n".contains(c.peek()) {
            s.push(c.peek());
            c.bump();
        }
        if c.peek() == '\n' || c.eof() {
            s = s.trim_end_matches([' ', '\t', '\r']).to_string();
        }
        if !in_element {
            if js_trim(&s).is_empty() {
                if c.peek() == '\n' {
                    c.bump();
                }
                if c.i == start {
                    // the reference loops here forever (a stray `}`); this ends it
                    return c.fail("expected a declaration or markup");
                }
                continue;
            }
            if s.contains(":=") {
                return c.fail("W-2: write in reactive scope (no statement position)");
            }
            return c.fail("expected a declaration or markup");
        }
        if broke && matches!(out.last(), Some(Markup { kind: MarkupKind::Text(_), .. })) {
            out.push(Markup { kind: MarkupKind::Text(" ".into()), line: None, span: Span::NONE });
        }
        if !s.is_empty() {
            let span = Span::new(s0, s0 + s.len());
            out.push(Markup { kind: MarkupKind::Text(s), line: None, span });
        }
        if c.i == start {
            // the reference loops here forever (a stray `}` in an element); this ends it
            return c.fail("expected a declaration or markup");
        }
    }
}

/// Control forms of a view: `if c { … } else { … }`, `for x in e { … }`, `loading … { … }`, `errored …`, `portal …`.
fn parse_control(c: &mut Cursor) -> R<Option<Markup>> {
    let save = c.i;
    let mk = |kind| Some(Markup { kind, line: None, span: Span::NONE });
    if c.keyword("if") {
        c.ws(true);
        let cond = parse_expr(c)?;
        c.ws(true);
        if !c.starts_with("{") {
            c.i = save;
            return Ok(None);
        }
        c.expect("{")?;
        let (t_decls, t) = parse_block_body(c)?;
        c.ws(true);
        let (mut f_decls, mut f) = (vec![], vec![]);
        if c.keyword("else") {
            c.ws(true);
            c.expect("{")?;
            (f_decls, f) = parse_block_body(c)?;
        }
        return Ok(mk(MarkupKind::Mif { c: cond, t, t_decls, f, f_decls }));
    }
    if c.keyword("loading") {
        c.ws(true);
        let mut on = None;
        if c.keyword("on") {
            c.ws(true);
            c.expect("(")?;
            c.ws(true);
            on = Some(parse_expr(c)?);
            c.ws(true);
            c.expect(")")?;
            c.ws(true);
        }
        if !c.keyword("fallback") {
            return c.fail("fallback");
        }
        c.ws(true);
        c.expect("{")?;
        let fallback = parse_markup(c, Close::Brace)?;
        c.ws(true);
        c.expect("{")?;
        let (decls, body) = parse_block_body(c)?;
        return Ok(mk(MarkupKind::Loading { on, fallback, decls, body }));
    }
    if c.keyword("portal") {
        c.ws(true);
        let mut to = None;
        if c.keyword("to") {
            c.ws(true);
            c.expect("(")?;
            c.ws(true);
            to = Some(parse_expr(c)?);
            c.ws(true);
            c.expect(")")?;
            c.ws(true);
        }
        c.expect("{")?;
        let (decls, body) = parse_block_body(c)?;
        return Ok(mk(MarkupKind::Portal { to, decls, body }));
    }
    if c.keyword("errored") {
        c.ws(true);
        if !c.keyword("fallback") {
            return c.fail("fallback");
        }
        c.ws(false);
        let mut err_name = None;
        let mut classes = None;
        if c.eat("(") {
            c.ws(true);
            err_name = Some(c.ident_or("error name")?);
            c.ws(false);
            if c.eat(":") {
                classes = parse_classes(c)?;
            }
            c.ws(true);
            c.expect(")")?;
        }
        c.ws(true);
        c.expect("{")?;
        let fallback = parse_markup(c, Close::Brace)?;
        c.ws(true);
        c.expect("{")?;
        let (decls, body) = parse_block_body(c)?;
        return Ok(mk(MarkupKind::Errored { fallback, decls, body, err_name, classes }));
    }
    if c.keyword("for") {
        c.ws(true);
        let name = c.ident_or("for name")?;
        c.ws(true);
        if !c.keyword("in") {
            return c.fail("in");
        }
        c.ws(true);
        let xs = parse_expr(c)?;
        c.ws(true);
        c.expect("{")?;
        let (decls, body) = parse_block_body(c)?;
        return Ok(mk(MarkupKind::Mfor { name, xs, decls, body }));
    }
    Ok(None)
}
/// A reactive block body: declarations, then markup, up to the closing `}` (03).
fn parse_block_body(c: &mut Cursor) -> R<(Vec<Decl>, Vec<Markup>)> {
    let mut decls = vec![];
    loop {
        c.ws(true);
        if !looks_like_decl(c) {
            break;
        }
        decls.push(parse_decl(c)?);
        c.ws(true);
        c.eat(";");
    }
    Ok((decls, parse_markup(c, Close::Brace)?))
}
fn looks_like_decl(c: &mut Cursor) -> bool {
    let save = c.i;
    c.ws(true);
    let r = c.starts_with("source ")
        || c.starts_with("effect")
        || c.starts_with("fn ")
        || c.starts_with("component ")
        || c.starts_with("deferred ")
        || c.starts_with("action ")
        || c.starts_with("provide ")
        || c.starts_with("context ")
        || c.starts_with("import ")
        || c.starts_with("export ")
        || c.starts_with("type ")
        || c.starts_with("interface ")
        || ERROR_DECL.is_match(c.rest())
        || SERVER_DECL.is_match(c.rest())
        || {
            let id = c.ident();
            c.ws(false);
            match id {
                Some(id) if !is_kw(&id) => {
                    if c.peek() == ':' && c.peek_at(1) != '=' {
                        true
                    } else {
                        (c.peek() == '=' && c.peek_at(1) != '=') || EQ_KEY.is_match(c.rest())
                    }
                }
                _ => false,
            }
        };
    c.i = save;
    r
}
fn parse_element(c: &mut Cursor) -> R<Markup> {
    c.expect("<")?;
    let mk = |kind| Markup { kind, line: None, span: Span::NONE };
    if c.eat(">") {
        let children = parse_markup(c, Close::Tag(String::new()))?;
        return Ok(mk(MarkupKind::El { tag: String::new(), attrs: vec![], children }));
    }
    let Some(tag) = c.tag_name() else { return c.fail("tag") };
    if tag == "style" {
        c.ws(true);
        if !c.eat(">") {
            return c.fail(if c.rest().starts_with("ref") {
                "CSS-5: a class map is a declaration, `styles = <style>…</style>` — TSRX's `<style ref={styles}>` assigns into a variable, and a name here is bound once, by its declaration"
            } else {
                "CSS-1: a <style> takes no attributes: `<style>…</style>`"
            });
        }
        let Some(end) = c.rest().find("</style>") else { return c.fail("expected </style>") };
        let css = c.rest()[..end].to_string();
        c.i += end + "</style>".len();
        return Ok(mk(MarkupKind::Style(css)));
    }
    let mut attrs = vec![];
    loop {
        c.ws(true);
        if c.eat("/>") {
            return Ok(mk(MarkupKind::El { tag, attrs, children: vec![] }));
        }
        if c.eat(">") {
            break;
        }
        let a0 = c.i;
        let Some(name) = c.tag_name() else { return c.fail("attr") };
        let span = Span::new(a0, c.i);
        c.ws(false);
        if !c.eat("=") {
            attrs.push(Attr { name, e: Expr::new(ExprKind::Lit(Lit::Bool(true)), span), span });
            continue;
        }
        c.ws(true);
        if c.eat("{") {
            c.ws(true);
            let e = parse_expr(c)?;
            attrs.push(Attr { name, e, span });
            c.ws(true);
            c.expect("}")?;
        } else {
            let e = parse_primary(c)?;
            attrs.push(Attr { name, e, span });
        }
    }
    let children = parse_markup(c, Close::Tag(tag.clone()))?;
    Ok(mk(MarkupKind::El { tag, attrs, children }))
}

#[cfg(test)]
mod recovering {
    use super::*;

    fn names(p: &Program) -> Vec<String> {
        p.decls.iter().filter_map(|d| d.name().map(|n| n.to_string())).collect()
    }

    #[test]
    fn half_typed_member_and_expression_still_parse() {
        let src = "source user := { name: \"a\" }\nshown = user.\nnext = \nexport default component App() {\n  <p>{shown}</p>\n}\n";
        let (p, errs) = parse_program_recovering(src);
        assert_eq!(names(&p), ["user", "shown", "next", "App"]);
        assert_eq!(errs.len(), 2);
        let Decl::Eq { e, .. } = &p.decls[1] else { panic!() };
        assert!(matches!(&e.k, ExprKind::Member { p, .. } if p.is_empty()));
        assert_eq!(e.span.text(src), "user.");
    }

    #[test]
    fn a_broken_declaration_is_left_out_and_the_rest_parse() {
        let src = "source a := 1\nfn f(x => x\nb = a + 1\ncomponent Item(props) {\n  <li>{props.x</li>\n}\nexport default component App() {\n  <Item x={b} />\n}\n";
        let (p, errs) = parse_program_recovering(src);
        assert_eq!(names(&p), ["a", "b", "App"]);
        assert_eq!(errs.len(), 2);
        assert!(parse_program(src).is_err());
    }

    #[test]
    fn function_types_in_props_and_type_aliases() {
        let src = "type Pick = (id: number) => void\ncomponent Row(props: { id: number; onPick: (id: number) => void; onDrop: Pick }) {\n  source n: number := peek(props.id)\n  <li onClick={() => { props.onPick(n) }}>{n}</li>\n}\nfn twice(x: number): number => x * 2\nexport default component App() {\n  <Row id={twice(1)} onPick={id => { log(id) }} onDrop={id => { log(id) }} />\n}\n";
        let p = parse_program(src).expect("parses");
        assert_eq!(names(&p), ["Pick", "Row", "twice", "App"]);
    }
}
