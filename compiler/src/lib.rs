//! ReactiveScript's compiler (spec/11): `ref/src/`'s parse and check stages and `ref/compile/emit.ts`'s lowering, ported so
//! that they give the same answers on every program (CP-5); the resolved model between check and lower (CP-6); and the
//! lowered modules handed to Solid's `solidjs-compiler` as Oxc programs (CP-1).

pub mod app;
pub mod ast;
pub mod awaits;
pub mod check;
pub mod content;
pub mod emit;
pub mod infer;
pub mod js;
pub mod model;
pub mod modules;
#[cfg(feature = "node")]
pub mod node;
pub mod oxc;
pub mod parse;
pub mod project;
pub mod serve;
pub mod signature;
pub mod spans;
#[cfg(target_arch = "wasm32")]
pub mod wasm;
