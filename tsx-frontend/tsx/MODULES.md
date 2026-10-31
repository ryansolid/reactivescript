# Mixed Modules

The prototype loader accepts explicit .tsx and .rx imports in either direction.
Both languages become one dependency-ordered ModuleSet, then use the existing
checkModules, module signatures and compileModules. It does not introduce another
checker or translate RX into TSX. Module cycles and missing files are diagnostics.

TSX modules lower to ReactiveScript's existing AST only, so their exports are
ordinary RX exports. An exported TSX `const` is an exported snapshot source
(`export source x := peek(e)`, or an equation for a function value): RX importers
see a read-only source (MO-2, writes are `WRITE_TO_NON_SOURCE`), and TSX importers
read a plain value. Which exports are TSX consts is frontend bookkeeping kept in
`tsx/lower.ts` (`immutableExports`), not an AST field or a signature kind; there
is no `const` signature. A TSX importer cannot assign one, and an `.rx` importer's
root or path write is `WRITE_TO_NON_SOURCE (MO-2)` (see `setup-values.test.ts`).

From ref/:

~~~sh
npm run build -- tsx/fixtures/counter.tsx --mount Counter --target dom --out .out/tsx-counter
~~~

The command checks before emitting. It writes one ES module per input module and
prints the emitted entry path. The outputs are the existing ReactiveScript
per-application factories, not ordinary named Solid component exports. They still
need the target's ReactiveScript runtime and bundling; this is not a standalone
browser bundle or a production server-function transport.

Choosing a mount is explicit. A TSX module that exports components does not run
them merely because it was imported. An RX entry with its own view needs no
mount option. API consumers can call buildTsx or loadTsxModules with an in-memory
source reader, just like the RX loader.

Relative JS declaration files beside mixed-language imports retain their .d.rx
contracts. Arbitrary npm implementation bodies are not made pure by this loader,
and the reference compiler's existing JS prelude restrictions still apply.
Component signatures also retain HTML content models: a row exported by either
frontend still requires an explicit table section at its application. Caller
error boundaries do not discharge failures that a child action reads later.

## Browser Verification

The separate real-browser test renders RX and TSX through SSR, checks that
hydration adopts their existing button nodes, and clicks them after takeover:

~~~sh
npx playwright install chromium
npm run test:browser
~~~

The paired cases cover synchronous counters, typed input callbacks, branch
remounts, keyed rows, async answers and streams, two-input `createRxEffect` effects, provider
snapshots, writable source contexts, typed failures, and isolated in-process
server-loader factories.
The direct JS API and server-loader cases currently invoke the API once again
during hydration in both syntaxes;
the test records that shared limitation, rather than claiming request reuse.
This tests full hydration, not resumability or server-only components. Fast
module, checker, and compiler tests run with npm test without a browser.

The setup script builds Solid's generated declaration files as well as its JS
packages. These declarations are required by npm run check, which also checks
the shared interpreter and emitter; ambient any-type stubs are not used to hide
missing dependencies. The native Solid compiler at
the current pin requires Rust 1.95 or later.
