//! CP-1c: a lowered module (`js.rs`) as an `oxc_ast::Program` in an Oxc `Allocator`, handed to Solid's compiler through
//! `compile_program`. The nodes are the ones Oxc's parser builds for the JavaScript `ref/compile/emit.ts` writes (with
//! `preserve_parens: false`, as Solid parses): an optional chain is one `ChainExpression` around its whole spine, a
//! lowercase JSX tag is a `JSXIdentifier` and any other an `IdentifierReference`.
//!
//! Spans: Solid's SSR props hoisting reads source order as meaning (`ssr/props.rs`): it finds a component's props literal
//! by its element's span, and constructs it ahead only from locals whose declaration ends before the element (else the
//! getter stays, as `const x = <C a={x.y} />` needs). So the program carries the layout the reference's text has, not
//! `.rx` positions: every statement, declarator, import binding, catch parameter, JSX element, fragment and attribute opens and
//! closes on a counter in print order, the rest are unspanned, and `source_text` is that many blanks — the module's shape
//! with no text, which the back ends only slice for comments and spreads, neither of which the lowering writes. Each
//! position also records the `.rx` line it was lowered from (`S::At`, a markup's line), so a position in Solid's output —
//! a source map's, an error's — is mapped back to `.rx` (`lines`).

use crate::js::{AttrValue, Body, Child, Func, Jsx, JsxName, Key, Pat, Prop, E, P, S};
use oxc_allocator::{Allocator, ArenaBox, ArenaVec};
use std::cell::{Cell, RefCell};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_span::{GetSpanMut, SourceType, Span, SPAN};
use oxc_syntax::number::NumberBase;
use oxc_syntax::operator::{AssignmentOperator, BinaryOperator, LogicalOperator, UnaryOperator};

pub struct Build<'a> {
    b: AstBuilder<'a>,
    alloc: &'a Allocator,
    /// the next print-order position
    at: Cell<u32>,
    /// the `.rx` line being lowered (1-based; 0: none)
    line: Cell<u32>,
    /// each position's `.rx` line
    lines: RefCell<Vec<u32>>,
}

impl<'a> Build<'a> {
    pub fn new(alloc: &'a Allocator) -> Self {
        Build { b: AstBuilder::new(alloc), alloc, at: Cell::new(0), line: Cell::new(0), lines: RefCell::new(vec![]) }
    }
    /// The `.rx` line (1-based) each position of the program was lowered from; 0 where none is known.
    pub fn lines(&self) -> Vec<u32> {
        self.lines.borrow().clone()
    }
    fn open(&self) -> u32 {
        let at = self.at.get();
        self.at.set(at + 1);
        self.lines.borrow_mut().push(self.line.get());
        at
    }
    /// `f` lowers `.rx` line `line`, when there is one
    fn on_line<T>(&self, line: Option<usize>, f: impl FnOnce() -> T) -> T {
        let Some(l) = line else { return f() };
        let prev = self.line.replace(l as u32);
        let x = f();
        self.line.set(prev);
        x
    }
    fn close(&self, start: u32) -> Span {
        Span::new(start, self.open())
    }
    /// a node with nothing spanned inside it
    fn leaf(&self) -> Span {
        let s = self.open();
        self.close(s)
    }
    fn s(&self, x: &str) -> &'a str {
        self.alloc.alloc_str(x)
    }
    fn vec<T>(&self, it: impl IntoIterator<Item = T>) -> ArenaVec<'a, T> {
        ArenaVec::from_iter_in(it, &self.b)
    }
    fn boxed<T>(&self, x: T) -> ArenaBox<'a, T> {
        ArenaBox::new_in(x, &self.b)
    }

    /// The module, with `source_text` the blanks its layout spans (above).
    pub fn program(&self, body: &[S]) -> Program<'a> {
        let stmts = self.vec(body.iter().map(|s| self.stmt(s)));
        let len = self.at.get();
        let source_text = self.s(&" ".repeat(len as usize));
        Program::new(Span::new(0, len), SourceType::jsx().with_module(true), source_text, self.vec([]), None, self.vec([]), stmts, &self.b)
    }

    // ---- statements
    fn block(&self, ss: &[S]) -> ArenaVec<'a, Statement<'a>> {
        self.vec(ss.iter().map(|s| self.stmt(s)))
    }
    fn block_stmt(&self, ss: &[S]) -> ArenaBox<'a, BlockStatement<'a>> {
        self.boxed(BlockStatement::new(SPAN, self.block(ss), &self.b))
    }
    fn pattern(&self, p: &Pat) -> BindingPattern<'a> {
        match p {
            Pat::Id(n) => BindingPattern::new_binding_identifier(SPAN, self.s(n), &self.b),
            Pat::Arr(ns) => BindingPattern::new_array_pattern(
                SPAN,
                self.vec(ns.iter().map(|n| Some(BindingPattern::new_binding_identifier(SPAN, self.s(n), &self.b)))),
                None,
                &self.b,
            ),
        }
    }
    fn var(&self, kind: VariableDeclarationKind, p: &Pat, init: Option<&E>) -> Statement<'a> {
        let start = self.open();
        let init = init.map(|e| self.expr(e));
        let d = VariableDeclarator::new(self.close(start), self.pattern(p), None, init, false, &self.b);
        Statement::new_variable_declaration(SPAN, kind, self.vec([d]), false, &self.b)
    }
    fn stmt(&self, s: &S) -> Statement<'a> {
        if let S::At(l, s) = s {
            return self.on_line(Some(*l), || self.stmt(s));
        }
        let start = self.open();
        let mut st = self.stmt0(s);
        *st.span_mut() = self.close(start);
        st
    }
    fn stmt0(&self, s: &S) -> Statement<'a> {
        let b = &self.b;
        match s {
            S::At(..) => unreachable!(),
            S::Const(p, e) => self.var(VariableDeclarationKind::Const, p, Some(e)),
            S::Let(n, e) => self.var(VariableDeclarationKind::Let, &Pat::Id(n.clone()), e.as_ref()),
            S::Expr(e) => Statement::new_expression_statement(SPAN, self.expr(e), b),
            S::Return(e) => Statement::new_return_statement(SPAN, e.as_ref().map(|e| self.expr(e)), b),
            S::Throw(e) => Statement::new_throw_statement(SPAN, self.expr(e), b),
            S::If(c, t, f) => Statement::new_if_statement(
                SPAN,
                self.expr(c),
                Statement::new_block_statement(SPAN, self.block(t), b),
                f.as_ref().map(|f| Statement::new_block_statement(SPAN, self.block(f), b)),
                b,
            ),
            S::IfThen(c, t) => Statement::new_if_statement(SPAN, self.expr(c), self.stmt(t), None, b),
            S::Block(ss) => Statement::new_block_statement(SPAN, self.block(ss), b),
            S::Try { block, param, handler, fin } => {
                let block = self.block_stmt(block);
                let handler = handler.as_ref().map(|h| {
                    let param = param.as_ref().map(|p| CatchParameter::new(self.leaf(), BindingPattern::new_binding_identifier(SPAN, self.s(p), b), None, b));
                    self.boxed(CatchClause::new(SPAN, param, self.block_stmt(h), b))
                });
                Statement::new_try_statement(SPAN, block, handler, fin.as_ref().map(|f| self.block_stmt(f)), b)
            }
            S::Func(f) => {
                let (params, body) = self.func_parts(f, FormalParameterKind::FormalParameter);
                Statement::new_function_declaration(
                    SPAN,
                    FunctionType::FunctionDeclaration,
                    f.name.as_ref().map(|n| BindingIdentifier::new(SPAN, self.s(n), b)),
                    f.generator,
                    f.is_async,
                    false,
                    None,
                    None,
                    params,
                    None,
                    Some(body),
                    b,
                )
            }
            S::ImportDefault(local, src) => Statement::new_import_declaration(
                SPAN,
                Some(self.vec([ImportDeclarationSpecifier::new_import_default_specifier(self.leaf(), BindingIdentifier::new(SPAN, self.s(local), b), b)])),
                StringLiteral::new(SPAN, self.s(src), None, b),
                None,
                None,
                ImportOrExportKind::Value,
                b,
            ),
            S::ImportNamed(names, src) => Statement::new_import_declaration(
                SPAN,
                Some(self.vec(names.iter().map(|(name, local)| {
                    ImportDeclarationSpecifier::new_import_specifier(
                        self.leaf(),
                        ModuleExportName::new_identifier_name(SPAN, self.s(name), b),
                        BindingIdentifier::new(SPAN, self.s(local), b),
                        ImportOrExportKind::Value,
                        b,
                    )
                }))),
                StringLiteral::new(SPAN, self.s(src), None, b),
                None,
                None,
                ImportOrExportKind::Value,
                b,
            ),
            S::ExportDefault(f) => {
                let (params, body) = self.func_parts(f, FormalParameterKind::FormalParameter);
                let decl = ExportDefaultDeclarationKind::new_function_declaration(
                    SPAN,
                    FunctionType::FunctionDeclaration,
                    f.name.as_ref().map(|n| BindingIdentifier::new(SPAN, self.s(n), b)),
                    f.generator,
                    f.is_async,
                    false,
                    None,
                    None,
                    params,
                    None,
                    Some(body),
                    b,
                );
                Statement::new_export_default_declaration(SPAN, decl, b)
            }
        }
    }
    fn params(&self, ps: &[P], kind: FormalParameterKind) -> ArenaBox<'a, FormalParameters<'a>> {
        let b = &self.b;
        let items = self.vec(ps.iter().filter_map(|p| match p {
            P::Id(n) => Some(FormalParameter::new(SPAN, self.vec([]), BindingPattern::new_binding_identifier(SPAN, self.s(n), b), None, None, false, None, false, false, b)),
            P::Rest(_) => None,
        }));
        let rest = ps.iter().find_map(|p| match p {
            P::Rest(n) => Some(self.boxed(FormalParameterRest::new(
                SPAN,
                self.vec([]),
                BindingRestElement::new(SPAN, BindingPattern::new_binding_identifier(SPAN, self.s(n), b), b),
                None,
                b,
            ))),
            P::Id(_) => None,
        });
        self.boxed(FormalParameters::new(SPAN, kind, items, rest, b))
    }
    fn func_parts(&self, f: &Func, kind: FormalParameterKind) -> (ArenaBox<'a, FormalParameters<'a>>, ArenaBox<'a, FunctionBody<'a>>) {
        let b = &self.b;
        let directives = self.vec(f.directives.iter().map(|d| Directive::new(SPAN, StringLiteral::new(SPAN, self.s(d), None, b), self.s(d), b)));
        (self.params(&f.params, kind), self.boxed(FunctionBody::new(SPAN, directives, self.block(&f.body), b)))
    }

    // ---- expressions
    /// Whether an optional link is on `e`'s member/call spine (then the whole spine is one chain).
    fn optional_spine(e: &E) -> bool {
        match e {
            E::Member(o, _, opt) => *opt || Self::optional_spine(o),
            E::Index(o, _, opt) => *opt || Self::optional_spine(o),
            E::Call(f, _) => Self::optional_spine(f),
            _ => false,
        }
    }
    fn args(&self, args: &[E]) -> ArenaVec<'a, Argument<'a>> {
        self.vec(args.iter().map(|a| match a {
            E::Spread(x) => Argument::new_spread_element(SPAN, self.expr(x), &self.b),
            _ => Argument::from(self.expr(a)),
        }))
    }
    /// A link of a spine, unwrapped (the chain wraps the outermost).
    fn link(&self, e: &E) -> Expression<'a> {
        let b = &self.b;
        match e {
            E::Member(o, p, opt) => Expression::new_static_member_expression(SPAN, self.link(o), IdentifierName::new(SPAN, self.s(p), b), *opt, b),
            E::Index(o, i, opt) => Expression::new_computed_member_expression(SPAN, self.link(o), self.expr(i), *opt, b),
            E::Call(f, args) => Expression::new_call_expression(SPAN, self.link(f), None, self.args(args), false, b),
            _ => self.expr(e),
        }
    }
    pub fn expr(&self, e: &E) -> Expression<'a> {
        let b = &self.b;
        if matches!(e, E::Member(..) | E::Index(..) | E::Call(..)) && Self::optional_spine(e) {
            let el = match e {
                E::Member(o, p, opt) => ChainElement::new_static_member_expression(SPAN, self.link(o), IdentifierName::new(SPAN, self.s(p), b), *opt, b),
                E::Index(o, i, opt) => ChainElement::new_computed_member_expression(SPAN, self.link(o), self.expr(i), *opt, b),
                E::Call(f, args) => ChainElement::new_call_expression(SPAN, self.link(f), None, self.args(args), false, b),
                _ => unreachable!(),
            };
            return Expression::new_chain_expression(SPAN, el, b);
        }
        match e {
            E::Id(n) => Expression::new_identifier(SPAN, self.s(n), b),
            E::Str(s) => Expression::new_string_literal(SPAN, self.s(s), None, b),
            E::Num(n) => Expression::new_numeric_literal(SPAN, *n, None, NumberBase::Decimal, b),
            E::Bool(v) => Expression::new_boolean_literal(SPAN, *v, b),
            E::Null => Expression::new_null_literal(SPAN, b),
            E::Member(..) | E::Index(..) | E::Call(..) => self.link(e),
            E::Arrow { params, body, is_async } => {
                let body = match body {
                    Body::Expr(x) => ArrowFunctionBody::from(self.expr(x)),
                    Body::Block(ss) => ArrowFunctionBody::new_function_body(SPAN, self.vec([]), self.block(ss), b),
                };
                Expression::new_arrow_function_expression(SPAN, *is_async, None, self.params(params, FormalParameterKind::ArrowFormalParameters), None, body, b)
            }
            E::Func(f) => {
                let (params, body) = self.func_parts(f, FormalParameterKind::FormalParameter);
                Expression::new_function_expression(
                    SPAN,
                    FunctionType::FunctionExpression,
                    f.name.as_ref().map(|n| BindingIdentifier::new(SPAN, self.s(n), b)),
                    f.generator,
                    f.is_async,
                    false,
                    None,
                    None,
                    params,
                    None,
                    Some(body),
                    b,
                )
            }
            E::Bin(op, l, r) => {
                let (l, r) = (self.expr(l), self.expr(r));
                match *op {
                    "&&" => Expression::new_logical_expression(SPAN, l, LogicalOperator::And, r, b),
                    "||" => Expression::new_logical_expression(SPAN, l, LogicalOperator::Or, r, b),
                    "??" => Expression::new_logical_expression(SPAN, l, LogicalOperator::Coalesce, r, b),
                    op => Expression::new_binary_expression(SPAN, l, binary(op), r, b),
                }
            }
            E::Un(op, x) => Expression::new_unary_expression(
                SPAN,
                match *op {
                    "!" => UnaryOperator::LogicalNot,
                    "-" => UnaryOperator::UnaryNegation,
                    "+" => UnaryOperator::UnaryPlus,
                    "typeof" => UnaryOperator::Typeof,
                    op => panic!("unary operator {op}"),
                },
                self.expr(x),
                b,
            ),
            E::Cond(c, t, f) => Expression::new_conditional_expression(SPAN, self.expr(c), self.expr(t), self.expr(f), b),
            E::Arr(items) => Expression::new_array_expression(
                SPAN,
                self.vec(items.iter().map(|x| match x {
                    E::Spread(y) => ArrayExpressionElement::new_spread_element(SPAN, self.expr(y), b),
                    _ => ArrayExpressionElement::from(self.expr(x)),
                })),
                b,
            ),
            E::Obj(props) => Expression::new_object_expression(
                SPAN,
                self.vec(props.iter().map(|p| match p {
                    Prop::Kv(k, v) => {
                        let key = match k {
                            Key::Ident(n) => PropertyKey::new_static_identifier(SPAN, self.s(n), b),
                            Key::Str(s) => PropertyKey::new_string_literal(SPAN, self.s(s), None, b),
                        };
                        ObjectPropertyKind::new_object_property(SPAN, PropertyKind::Init, key, self.expr(v), false, false, false, b)
                    }
                    Prop::Spread(x) => ObjectPropertyKind::new_spread_property(SPAN, self.expr(x), b),
                })),
                b,
            ),
            E::Spread(_) => panic!("a spread outside an array or arguments"),
            E::Yield(x) => Expression::new_yield_expression(SPAN, false, Some(self.expr(x)), b),
            E::Await(x) => Expression::new_await_expression(SPAN, self.expr(x), b),
            E::Assign(op, t, x) => {
                let target = match &**t {
                    E::Id(n) => AssignmentTarget::new_assignment_target_identifier(SPAN, self.s(n), b),
                    E::Index(o, i, false) => AssignmentTarget::new_computed_member_expression(SPAN, self.expr(o), self.expr(i), false, b),
                    E::Member(o, p, false) => AssignmentTarget::new_static_member_expression(SPAN, self.expr(o), IdentifierName::new(SPAN, self.s(p), b), false, b),
                    t => panic!("not an assignment target: {t:?}"),
                };
                let op = match *op {
                    "=" => AssignmentOperator::Assign,
                    "??=" => AssignmentOperator::LogicalNullish,
                    op => panic!("assignment operator {op}"),
                };
                Expression::new_assignment_expression(SPAN, op, target, self.expr(x), b)
            }
            E::Jsx(j) => self.jsx(j),
        }
    }

    // ---- JSX
    fn jsx_name(&self, n: &JsxName) -> JSXElementName<'a> {
        let b = &self.b;
        match n {
            JsxName::Ident(t) if t.as_bytes()[0].is_ascii_lowercase() || t.contains('-') => {
                JSXElementName::Identifier(self.boxed(JSXIdentifier::new(SPAN, self.s(t), b)))
            }
            JsxName::Ident(t) => JSXElementName::new_identifier_reference(SPAN, self.s(t), b),
            JsxName::Member(o, p) => JSXElementName::new_member_expression(
                SPAN,
                JSXMemberExpressionObject::new_identifier_reference(SPAN, self.s(o), b),
                JSXIdentifier::new(SPAN, self.s(p), b),
                b,
            ),
        }
    }
    fn children(&self, cs: &[Child]) -> ArenaVec<'a, JSXChild<'a>> {
        self.vec(cs.iter().map(|c| match c {
            Child::Expr(e) => JSXChild::new_expression_container(SPAN, JSXExpression::from(self.expr(e)), &self.b),
            Child::Text(t) => JSXChild::new_text(SPAN, self.s(t), Some(self.s(t).into()), &self.b),
            Child::Jsx(Jsx::Frag(cs, line)) => self.on_line(*line, || {
                let start = self.open();
                let cs = self.children(cs);
                JSXChild::new_fragment(self.close(start), JSXOpeningFragment::new(SPAN, &self.b), cs, JSXClosingFragment::new(SPAN, &self.b), &self.b)
            }),
            Child::Jsx(j @ Jsx::El { line, .. }) => self.on_line(*line, || {
                let start = self.open();
                let (o, cs, c) = self.element_parts(j);
                JSXChild::new_element(self.close(start), o, cs, c, &self.b)
            }),
        }))
    }
    #[allow(clippy::type_complexity)]
    fn element_parts(&self, j: &Jsx) -> (ArenaBox<'a, JSXOpeningElement<'a>>, ArenaVec<'a, JSXChild<'a>>, Option<ArenaBox<'a, JSXClosingElement<'a>>>) {
        let b = &self.b;
        let Jsx::El { name, attrs, children, self_closing, .. } = j else { unreachable!() };
        let attrs = self.vec(attrs.iter().map(|(n, v)| {
            let start = self.open();
            // 07 §4: `{...e}`, Solid's spread
            if let ("...", AttrValue::Expr(e)) = (n.as_str(), v) {
                return JSXAttributeItem::new_spread_attribute(self.close(start), self.expr(e), b);
            }
            let name = match n.split_once(':') {
                Some((ns, local)) => JSXAttributeName::new_namespaced_name(SPAN, JSXIdentifier::new(SPAN, self.s(ns), b), JSXIdentifier::new(SPAN, self.s(local), b), b),
                None => JSXAttributeName::new_identifier(SPAN, self.s(n), b),
            };
            let value = match v {
                AttrValue::Str(s) => JSXAttributeValue::new_string_literal(SPAN, self.s(s), None, b),
                AttrValue::Expr(e) => JSXAttributeValue::new_expression_container(SPAN, JSXExpression::from(self.expr(e)), b),
            };
            JSXAttributeItem::new_attribute(self.close(start), name, Some(value), b)
        }));
        let opening = self.boxed(JSXOpeningElement::new(SPAN, self.jsx_name(name), None, attrs, b));
        let closing = if *self_closing { None } else { Some(self.boxed(JSXClosingElement::new(SPAN, self.jsx_name(name), b))) };
        (opening, self.children(children), closing)
    }
    fn jsx(&self, j: &Jsx) -> Expression<'a> {
        let b = &self.b;
        match j {
            Jsx::Frag(cs, line) => self.on_line(*line, || {
                let start = self.open();
                let cs = self.children(cs);
                Expression::new_jsx_fragment(self.close(start), JSXOpeningFragment::new(SPAN, b), cs, JSXClosingFragment::new(SPAN, b), b)
            }),
            Jsx::El { line, .. } => self.on_line(*line, || {
                let start = self.open();
                let (o, cs, c) = self.element_parts(j);
                Expression::new_jsx_element(self.close(start), o, cs, c, b)
            }),
        }
    }
}

fn binary(op: &str) -> BinaryOperator {
    match op {
        "+" => BinaryOperator::Addition,
        "-" => BinaryOperator::Subtraction,
        "*" => BinaryOperator::Multiplication,
        "/" => BinaryOperator::Division,
        "%" => BinaryOperator::Remainder,
        "**" => BinaryOperator::Exponential,
        "<" => BinaryOperator::LessThan,
        ">" => BinaryOperator::GreaterThan,
        "<=" => BinaryOperator::LessEqualThan,
        ">=" => BinaryOperator::GreaterEqualThan,
        "==" => BinaryOperator::Equality,
        "!=" => BinaryOperator::Inequality,
        "===" => BinaryOperator::StrictEquality,
        "!==" => BinaryOperator::StrictInequality,
        "in" => BinaryOperator::In,
        "instanceof" => BinaryOperator::Instanceof,
        op => panic!("binary operator {op}"),
    }
}
