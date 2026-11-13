# ReactiveScript for VS Code

Highlighting for `.rx` and `.d.rx`: TypeScript's grammar for expressions,
statements and JSX, with ReactiveScript's forms injected on top — `source`, `:=`,
equations, `effect`, `action`, `server fn`, `context`/`provide`/`use`,
`loading`/`errored`/`fallback`, `for … in`, `pre`/`peek`/`latest`/`pending?`,
`await*`, `->`, the `pure`/`server`/`client` import rows, and scoped `<style>` as CSS.

Everything else comes from the `.rx` language server
([`../rx-language-server`](../rx-language-server)), which this extension starts
for `.rx` documents: TypeScript's hover, go to definition, references, rename,
completion and type errors, asked of the TSX projection (spec/13 TY-1c) and
mapped back onto the `.rx` (spec/11 CP-8), and the compiler's own diagnostics,
each with its rule.

In Markdown, ` ```rx ` (or ` ```reactivescript `) blocks are highlighted too: in
the editor with the full `.rx` grammar (`syntaxes/rx.markdown.tmLanguage.json`,
injected into Markdown), and in the preview with a highlight.js language built
on TypeScript's plus the `.rx` words (`markdown.js`). The language server only
starts once a `.rx` file is open.

## Installing

From the VS Marketplace or Open VSX (Cursor, VSCodium), once published: search
for **ReactiveScript**. Until then, from a `.vsix`: download the `vsix`
artifact of a run of the repository's `editor` workflow, or build one (below),
then run **Extensions: Install from VSIX…** in the command palette, or

```sh
code --install-extension reactivescript-0.3.0.vsix
```

The project needs a `tsconfig.json` with Solid's JSX (`"jsx": "preserve"`,
`"jsxImportSource": "@solidjs/web"`) and `@solidjs/web` in its `node_modules`;
the server writes the projection's prelude to `node_modules/.reactivescript/`.
It uses the workspace's TypeScript, else the one VS Code ships.

One `.vsix` serves every platform: the compiler comes in it as WebAssembly
(`dist/rxc.wasm`), run in the server's process.

## Building it

```sh
cargo build --lib --release --target wasm32-unknown-unknown --manifest-path compiler/Cargo.toml
npm --prefix tooling/rx-language-server install
cd tooling/vscode-rx && npm install && npm run package   # dist/, then reactivescript-<version>.vsix
```

`npm run build` makes `dist/` alone; then
`code --extensionDevelopmentPath=$PWD examples/shop` (from this folder, with
the path adjusted) runs it without installing. The settings
`reactivescript.server.path`, `reactivescript.rxc.path` and
`reactivescript.typescript.tsdk` point at another server, an `rxc` binary (run
per request instead of the WebAssembly build) or TypeScript.

## Publishing

The repository's `editor` workflow builds and tests the extension on every
change to `compiler/` or `tooling/`, and publishes a new `version` to the VS
Marketplace and Open VSX when it reaches `main`: see
[`../RELEASING.md`](../RELEASING.md).

Other editors: see [`../rx-language-server`](../rx-language-server#editors).
