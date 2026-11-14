#!/bin/sh
# Builds the crate's WebAssembly library (serve.rs requests, with the `app` method) into public/rxc.wasm.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="${RX_CRATE:-$HERE/../../compiler}"
export CARGO_HOME="${CARGO_HOME:-$HOME/.local/share/cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.local/share/rustup}"
export PATH="$CARGO_HOME/bin:$PATH"
cargo build --lib --release --target wasm32-unknown-unknown --manifest-path "$CRATE/Cargo.toml"
cp "$CRATE/target/wasm32-unknown-unknown/release/reactivescript.wasm" "$HERE/public/rxc.wasm"
ls -la "$HERE/public/rxc.wasm"
