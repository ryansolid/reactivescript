//! What the parser's spans promise (spec/11 CP-8), checked on a parsed program: each span is inside the source and inside
//! its parent's, a declaration's and a markup item's span starts on the line the node records, and a leaf's span is the
//! text it was parsed from (a name is its name, a member ends with its property). `ref/crate.ts` runs this on every
//! program; an editor's positions are only as good as these.

use crate::ast::*;

struct Spans<'a> {
    src: &'a str,
    out: Vec<String>,
}

impl Spans<'_> {
    fn bad(&mut self, at: Span, what: String) {
        self.out.push(format!("{}..{} (line {}): {}", at.start, at.end, at.line(self.src), what));
    }
    /// `at` is a real span, inside the source and inside `parent`.
    fn inside(&mut self, at: Span, parent: Span, what: &str) -> bool {
        if at.is_none() {
            return false;
        }
        let (s, e) = (at.start as usize, at.end as usize);
        if s > e || e > self.src.len() || !self.src.is_char_boundary(s) || !self.src.is_char_boundary(e) {
            self.bad(at, format!("{what}: not a range of the source"));
            return false;
        }
        if !parent.is_none() && (at.start < parent.start || at.end > parent.end) {
            self.bad(at, format!("{what}: outside its parent {}..{}", parent.start, parent.end));
        }
        true
    }
    fn word_in(&mut self, at: Span, name: &str, what: &str) {
        if name.starts_with("$$") {
            return; // a destructuring's temp (RG-4b): the parser's own name for its right side
        }
        let t = at.text(self.src);
        let found = t.match_indices(name).any(|(i, _)| {
            let before = t[..i].chars().next_back();
            let after = t[i + name.len()..].chars().next();
            !before.is_some_and(is_word) && !after.is_some_and(is_word)
        });
        if !found {
            self.bad(at, format!("{what} `{name}` is not in its text"));
        }
    }

    fn decls(&mut self, ds: &[Decl], parent: Span) {
        for d in ds {
            self.decl(d, parent);
        }
    }
    fn decl(&mut self, d: &Decl, parent: Span) {
        let at = d.span();
        if !self.inside(at, parent, "declaration") {
            self.bad(at, format!("a {} declaration has no span", d.to_json()["k"]));
            return;
        }
        if at.line(self.src) != d.line() {
            self.bad(at, format!("declaration on line {}, its span starts on line {}", d.line(), at.line(self.src)));
        }
        if let Some(n) = d.name() {
            self.word_in(at, n, "the declared name");
        }
        match d {
            Decl::Source { init: e, .. } | Decl::Eq { e, .. } | Decl::Provide { e, .. } => self.expr(e, at),
            Decl::Error { msg, .. } => msg.iter().for_each(|e| self.expr(e, at)),
            Decl::Context { dflt, .. } => dflt.iter().for_each(|e| self.expr(e, at)),
            Decl::Effect { inputs, body, .. } => {
                inputs.iter().for_each(|e| self.expr(e, at));
                self.stmts(body, at);
            }
            Decl::Fn { decls, tail, .. } => {
                self.decls(decls, at);
                self.expr(tail, at);
            }
            Decl::Component { decls, view, .. } => {
                self.decls(decls, at);
                self.markups(view, at);
            }
            Decl::Action { body, .. } | Decl::Server { body, .. } => self.stmts(body, at),
            Decl::Import { .. } | Decl::TypeDecl { .. } => {}
        }
    }

    fn stmts(&mut self, ss: &[Stmt], parent: Span) {
        for s in ss {
            self.stmt(s, parent);
        }
    }
    fn stmt(&mut self, s: &Stmt, parent: Span) {
        let at = s.span;
        if !self.inside(at, parent, "statement") {
            self.bad(parent, format!("a {} statement has no span", s.kind()));
            return;
        }
        match &s.k {
            StmtKind::Write { target, e } | StmtKind::Optimistic { target, e } => {
                self.word_in(at, &target.name, "the written name");
                for p in &target.path {
                    if let PathSeg::Expr(x) = p {
                        self.expr(x, at);
                    }
                }
                self.expr(e, at);
            }
            StmtKind::Let { name, e, .. } => {
                self.word_in(at, name, "the bound name");
                self.expr(e, at);
            }
            StmtKind::Expr(e) | StmtKind::Throw(e) => self.expr(e, at),
            StmtKind::Return(e) => e.iter().for_each(|e| self.expr(e, at)),
            StmtKind::Refresh(n) | StmtKind::Affects(n) => self.word_in(at, n, "the name"),
            StmtKind::Action(body) => self.stmts(body, at),
            StmtKind::Sif { c, t, f } => {
                self.expr(c, at);
                self.stmts(t, at);
                self.stmts(f, at);
            }
            StmtKind::Try { body, handler, fin, .. } => {
                self.stmts(body, at);
                handler.iter().for_each(|h| self.stmts(h, at));
                fin.iter().for_each(|h| self.stmts(h, at));
            }
        }
    }

    fn expr(&mut self, e: &Expr, parent: Span) {
        let at = e.span;
        if !self.inside(at, parent, e.kind()) {
            // the expressions the parser makes: a statement-bodied arrow's `body`, and a destructured name's projection
            // (RG-4b: `.field`, `[i]`, the default's `=== undefined ? d : v`, the right side's temp or `props`)
            if !matches!(e.k, ExprKind::Lit(Lit::Undefined) | ExprKind::Lit(Lit::Num(_)) | ExprKind::Member { .. } | ExprKind::Index { .. } | ExprKind::If { .. } | ExprKind::Bin { .. } | ExprKind::Id(_)) {
                self.bad(parent, format!("a {} expression has no span", e.kind()));
            }
            return;
        }
        let text = at.text(self.src);
        match &e.k {
            ExprKind::Id(n) if text != n => self.bad(at, format!("the name `{n}` spans `{text}`")),
            ExprKind::Member { p, .. } if !text.ends_with(p.as_str()) => self.bad(at, format!("the member `.{p}` spans `{text}`")),
            ExprKind::Use(n) | ExprKind::Pre { name: n, .. } => self.word_in(at, n, "the name"),
            ExprKind::Lit(Lit::Str(_)) if !(text.starts_with('"') || text.starts_with('\'')) => self.bad(at, format!("a string spans `{text}`")),
            ExprKind::Lit(Lit::Num(_)) if !text.starts_with(|c: char| c.is_ascii_digit()) => self.bad(at, format!("a number spans `{text}`")),
            _ => {}
        }
        let mut sub = |x: &Expr| self.expr(x, at);
        match &e.k {
            ExprKind::Lit(_) | ExprKind::Id(_) | ExprKind::Use(_) | ExprKind::StyleMap { .. } => {}
            ExprKind::Bin { l, r, .. } => {
                sub(l);
                sub(r);
            }
            ExprKind::Un { e, .. } | ExprKind::Peek(e) | ExprKind::Latest(e) | ExprKind::Pending(e) | ExprKind::Spread(e) | ExprKind::Throw(e) => sub(e),
            ExprKind::Pre { init, .. } => init.iter().for_each(|x| sub(x)),
            ExprKind::Await { e, init, .. } => {
                sub(e);
                init.iter().for_each(|x| sub(x));
            }
            ExprKind::If { c, t, f } => {
                sub(c);
                sub(t);
                sub(f);
            }
            ExprKind::Tpl(parts) => parts.iter().for_each(|p| {
                if let TplPart::Expr(x) = p {
                    sub(x)
                }
            }),
            ExprKind::Member { o, .. } => sub(o),
            ExprKind::Index { o, i, .. } => {
                sub(o);
                sub(i);
            }
            ExprKind::Call { f, args } => {
                sub(f);
                args.iter().for_each(&mut sub);
            }
            ExprKind::Arr(items) => items.iter().for_each(&mut sub),
            ExprKind::Rec(fields) => fields.iter().for_each(|f| match f {
                Field::Kv { v, .. } => sub(v),
                Field::Spread(x) => sub(x),
            }),
            ExprKind::Catch { e, alt, .. } => {
                sub(e);
                sub(alt);
            }
            ExprKind::Fn { body, stmts, .. } => {
                sub(body);
                if let Some(ss) = stmts {
                    self.stmts(ss, at);
                }
            }
            ExprKind::Draft { seed, body } => {
                sub(seed);
                self.stmts(body, at);
            }
            ExprKind::ServerFn { body, .. } => self.stmts(body, at),
        }
    }

    fn markups(&mut self, ms: &[Markup], parent: Span) {
        for m in ms {
            self.markup(m, parent);
        }
    }
    fn markup(&mut self, m: &Markup, parent: Span) {
        let at = m.span;
        if !self.inside(at, parent, "markup") {
            // made by the parser: the space between two texts, and a module's view of its default component (MO-1c)
            if m.line.is_some() && !matches!(m.kind, MarkupKind::El { .. }) {
                self.bad(parent, "a markup item has no span".into());
            }
            return;
        }
        if let Some(l) = m.line {
            if at.line(self.src) != l {
                self.bad(at, format!("markup on line {l}, its span starts on line {}", at.line(self.src)));
            }
        }
        match &m.kind {
            MarkupKind::El { tag, attrs, children } => {
                if !tag.is_empty() && !at.text(self.src)[1..].starts_with(tag.as_str()) {
                    self.bad(at, format!("the element <{tag}> spans `{}`", at.text(self.src)));
                }
                for a in attrs {
                    if self.inside(a.span, at, "attribute") && a.span.text(self.src) != a.name {
                        self.bad(a.span, format!("the attribute `{}` spans `{}`", a.name, a.span.text(self.src)));
                    }
                    self.expr(&a.e, at);
                }
                self.markups(children, at);
            }
            MarkupKind::Read(e) => self.expr(e, at),
            MarkupKind::Text(t) if at.text(self.src) != t => self.bad(at, format!("the text {t:?} spans {:?}", at.text(self.src))),
            MarkupKind::Text(_) | MarkupKind::Style(_) => {}
            MarkupKind::Mif { c, t, t_decls, f, f_decls } => {
                self.expr(c, at);
                self.decls(t_decls, at);
                self.markups(t, at);
                self.decls(f_decls, at);
                self.markups(f, at);
            }
            MarkupKind::Mfor { name, xs, decls, body } => {
                self.word_in(at, name, "the bound name");
                self.expr(xs, at);
                self.decls(decls, at);
                self.markups(body, at);
            }
            MarkupKind::Loading { on, fallback, decls, body } => {
                on.iter().for_each(|e| self.expr(e, at));
                self.markups(fallback, at);
                self.decls(decls, at);
                self.markups(body, at);
            }
            MarkupKind::Errored { fallback, decls, body, .. } => {
                self.markups(fallback, at);
                self.decls(decls, at);
                self.markups(body, at);
            }
            MarkupKind::Portal { to, decls, body } => {
                to.iter().for_each(|e| self.expr(e, at));
                self.decls(decls, at);
                self.markups(body, at);
            }
        }
    }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Every way `p`'s spans break their promise, against `src`, the text it was parsed from; empty when they keep it.
pub fn check_spans(src: &str, p: &Program) -> Vec<String> {
    let mut s = Spans { src, out: vec![] };
    s.decls(&p.decls, Span::NONE);
    s.markups(&p.view, Span::NONE);
    s.out
}

/// The range a diagnostic on `line` covers (the checker is line-precise, CN-1a): from where the first node that starts on
/// that line starts, to the furthest any such node reaches on it; the line's text when no node starts there.
pub fn line_range(src: &str, p: &Program, line: usize) -> Option<Span> {
    let (mut ls, mut n) = (0usize, 1usize);
    while n < line {
        ls = ls + src[ls..].find('\n')? + 1;
        n += 1;
    }
    let le = src[ls..].find('\n').map(|j| ls + j).unwrap_or(src.len());
    let mut r: Option<(u32, u32)> = None;
    let mut take = |at: Span| {
        if !at.is_none() && (at.start as usize) >= ls && (at.start as usize) <= le {
            let end = at.end.min(le as u32);
            r = Some(r.map_or((at.start, end), |(a, b)| (a.min(at.start), b.max(end))));
        }
    };
    walk(p, &mut take);
    if let Some((a, b)) = r {
        let t = src[a as usize..b as usize].trim_end();
        return Some(Span::new(a as usize, a as usize + t.len()));
    }
    let text = &src[ls..le];
    let t = text.trim_start();
    let a = ls + (text.len() - t.len());
    Some(Span::new(a, a + t.trim_end().len()))
}

/// Every span `p` holds: declarations, statements, expressions, markup and attributes.
pub fn walk(p: &Program, f: &mut dyn FnMut(Span)) {
    fn decl(d: &Decl, f: &mut dyn FnMut(Span)) {
        f(d.span());
        match d {
            Decl::Source { init: e, .. } | Decl::Eq { e, .. } | Decl::Provide { e, .. } => expr(e, f),
            Decl::Error { msg, .. } => msg.iter().for_each(|e| expr(e, f)),
            Decl::Context { dflt, .. } => dflt.iter().for_each(|e| expr(e, f)),
            Decl::Effect { inputs, body, .. } => {
                inputs.iter().for_each(|e| expr(e, f));
                body.iter().for_each(|s| stmt(s, f));
            }
            Decl::Fn { decls, tail, .. } => {
                decls.iter().for_each(|d| decl(d, f));
                expr(tail, f);
            }
            Decl::Component { decls, view, .. } => {
                decls.iter().for_each(|d| decl(d, f));
                view.iter().for_each(|m| markup(m, f));
            }
            Decl::Action { body, .. } | Decl::Server { body, .. } => body.iter().for_each(|s| stmt(s, f)),
            Decl::Import { .. } | Decl::TypeDecl { .. } => {}
        }
    }
    fn stmt(s: &Stmt, f: &mut dyn FnMut(Span)) {
        f(s.span);
        match &s.k {
            StmtKind::Write { target, e } | StmtKind::Optimistic { target, e } => {
                target.path.iter().for_each(|p| if let PathSeg::Expr(x) = p { expr(x, f) });
                expr(e, f);
            }
            StmtKind::Let { e, .. } | StmtKind::Expr(e) | StmtKind::Throw(e) => expr(e, f),
            StmtKind::Return(e) => e.iter().for_each(|e| expr(e, f)),
            StmtKind::Refresh(_) | StmtKind::Affects(_) => {}
            StmtKind::Action(b) => b.iter().for_each(|s| stmt(s, f)),
            StmtKind::Sif { c, t, f: e } => {
                expr(c, f);
                t.iter().chain(e).for_each(|s| stmt(s, f));
            }
            StmtKind::Try { body, handler, fin, .. } => body.iter().chain(handler.iter().flatten()).chain(fin.iter().flatten()).for_each(|s| stmt(s, f)),
        }
    }
    fn expr(e: &Expr, f: &mut dyn FnMut(Span)) {
        f(e.span);
        let mut sub: Vec<&Expr> = vec![];
        match &e.k {
            ExprKind::Lit(_) | ExprKind::Id(_) | ExprKind::Use(_) | ExprKind::StyleMap { .. } => {}
            ExprKind::Bin { l, r, .. } => sub.extend([&**l, &**r]),
            ExprKind::Un { e, .. } | ExprKind::Peek(e) | ExprKind::Latest(e) | ExprKind::Pending(e) | ExprKind::Spread(e) | ExprKind::Throw(e) => sub.push(e),
            ExprKind::Pre { init, .. } => sub.extend(init.iter().map(|x| &**x)),
            ExprKind::Await { e, init, .. } => sub.extend(std::iter::once(&**e).chain(init.iter().map(|x| &**x))),
            ExprKind::If { c, t, f } => sub.extend([&**c, &**t, &**f]),
            ExprKind::Tpl(parts) => sub.extend(parts.iter().filter_map(|p| if let TplPart::Expr(x) = p { Some(x) } else { None })),
            ExprKind::Member { o, .. } => sub.push(o),
            ExprKind::Index { o, i, .. } => sub.extend([&**o, &**i]),
            ExprKind::Call { f, args } => sub.extend(std::iter::once(&**f).chain(args.iter())),
            ExprKind::Arr(items) => sub.extend(items.iter()),
            ExprKind::Rec(fields) => sub.extend(fields.iter().map(|x| match x {
                Field::Kv { v, .. } => v,
                Field::Spread(x) => x,
            })),
            ExprKind::Catch { e, alt, .. } => sub.extend([&**e, &**alt]),
            ExprKind::Fn { body, stmts, .. } => {
                sub.push(body);
                stmts.iter().flatten().for_each(|s| stmt(s, f));
            }
            ExprKind::Draft { seed, body } => {
                sub.push(seed);
                body.iter().for_each(|s| stmt(s, f));
            }
            ExprKind::ServerFn { body, .. } => body.iter().for_each(|s| stmt(s, f)),
        }
        sub.into_iter().for_each(|x| expr(x, f));
    }
    fn markup(m: &Markup, f: &mut dyn FnMut(Span)) {
        f(m.span);
        let (ds, ms, es): (Vec<&Decl>, Vec<&Markup>, Vec<&Expr>) = match &m.kind {
            MarkupKind::El { attrs, children, .. } => {
                attrs.iter().for_each(|a| f(a.span));
                (vec![], children.iter().collect(), attrs.iter().map(|a| &a.e).collect())
            }
            MarkupKind::Read(e) => (vec![], vec![], vec![e]),
            MarkupKind::Text(_) | MarkupKind::Style(_) => (vec![], vec![], vec![]),
            MarkupKind::Mif { c, t, t_decls, f: fm, f_decls } => (t_decls.iter().chain(f_decls).collect(), t.iter().chain(fm).collect(), vec![c]),
            MarkupKind::Mfor { xs, decls, body, .. } => (decls.iter().collect(), body.iter().collect(), vec![xs]),
            MarkupKind::Loading { on, fallback, decls, body } => (decls.iter().collect(), fallback.iter().chain(body).collect(), on.iter().collect()),
            MarkupKind::Errored { fallback, decls, body, .. } => (decls.iter().collect(), fallback.iter().chain(body).collect(), vec![]),
            MarkupKind::Portal { to, decls, body } => (decls.iter().collect(), body.iter().collect(), to.iter().collect()),
        };
        es.into_iter().for_each(|e| expr(e, f));
        ds.into_iter().for_each(|d| decl(d, f));
        ms.into_iter().for_each(|m| markup(m, f));
    }
    p.decls.iter().for_each(|d| decl(d, f));
    p.view.iter().for_each(|m| markup(m, f));
}

/// A byte offset as a 1-based line and 0-based column in UTF-16 code units (what LSP and TypeScript count).
pub fn line_col(src: &str, at: u32) -> (usize, usize) {
    let at = (at as usize).min(src.len());
    let ls = src[..at].rfind('\n').map(|i| i + 1).unwrap_or(0);
    (src[..ls].matches('\n').count() + 1, src[ls..at].encode_utf16().count())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse_program;

    #[test]
    fn spans_hold_and_a_broken_one_is_caught() {
        let src = "source count := 0\ndoubled = count * 2\naction inc() {\n  count := count + 1\n}\nexport default component App() {\n  <button onClick={inc}>{doubled} {user?.name}</button>\n}\n";
        let mut p = parse_program(src).unwrap();
        assert_eq!(check_spans(src, &p), Vec::<String>::new());
        let Decl::Eq { e, span, .. } = &p.decls[1] else { panic!() };
        assert_eq!(span.text(src), "doubled = count * 2");
        assert_eq!(e.span.text(src), "count * 2");
        let Decl::Action { body, .. } = &p.decls[2] else { panic!() };
        assert_eq!(body[0].span.text(src), "count := count + 1");
        if let Decl::Eq { e, .. } = &mut p.decls[1] {
            e.span = Span::new(e.span.start as usize + 1, e.span.end as usize);
            if let ExprKind::Bin { l, .. } = &mut e.k {
                l.span = Span::new(l.span.start as usize, l.span.end as usize + 1);
            }
        }
        assert_eq!(check_spans(src, &p).len(), 2);
        let r = line_range(src, &p, 4).unwrap();
        assert_eq!(r.text(src), "count := count + 1");
        assert_eq!(line_col(src, r.start), (4, 2));
    }
}
