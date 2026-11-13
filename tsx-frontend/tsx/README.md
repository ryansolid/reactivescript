# TSX frontend

This is the checked subset described in [docs/SUBSET.md](../docs/SUBSET.md), not the former broad Solid port.

- subset.ts refuses syntax outside the kept tests and fuzzer.
- lower.ts builds the pinned RX AST; the upstream checker still decides reactive validity.
- modules.ts loads TSX, handwritten RX and .d.rx declarations for the tests and yield frontend.
- build.ts checks and emits universal-renderer modules.
- rx/ is the only direct upstream import boundary.

Run npm run verify:subset. See [results](../docs/RESULTS.md) and [upstream limits](../docs/UPSTREAM-ISSUES.md).
