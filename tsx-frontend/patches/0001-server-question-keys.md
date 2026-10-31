# 0001 server-question-keys (temporary upstream patch)

- **Applies to:** reactivescript 8518fa1ee28b135cabc8c6c151e3e7d9ef589070 (the pin; rebased from aa85cbde with the same
  changes, only blob ids and hunk offsets differ). Files: ref/compile/rt.ts,
  ref/compile/rt-web.ts, ref/compile/rt-server.ts, ref/src/failure.ts, ref/src/runtime.ts (5 files, +53/-5).
- **Defect:** a server fn asked in reactive scope is a question with one flight per argument list (SF-2), but every
  runtime keyed that flight as `name + ":" + args.map(fmt).join(",")`, where `fmt` leaves strings bare and
  JSON-encodes the rest. Distinct wire arguments therefore shared one flight and one answer: `load(1)`/`load("1")`,
  `first("a,b","c")`/`first("a","b,c")`, `undefined`/`"undefined"`, `NaN`/`null`/`Infinity`, `-0`/`0`,
  `{a: undefined}`/`{}`, `[undefined]`/`Array(1)`; and `{a:1,b:2}`/`{b:2,a:1}` did NOT share one.
- **Reproduction (handwritten RX, no TSX):** `upstream-repros/server-question-keys/main.rx`. At the pin:
  interpreter `number/number/a,b/a,b`, compiled `number/number/a,b/a,b`; expected (and with this patch, both)
  `number/string/a,b/a`. Run: `node --experimental-strip-types --conditions=browser --conditions=development
  scripts/run-rx-repro.ts upstream-repros/server-question-keys`.
- **Regression test:** `tsx/server-identities.test.ts` "server loader keys preserve wire argument types, delimiters
  and numeric edge cases" (native, compiled questions via the emitter's serverRef/serverCall bridge, interpreter and
  compiled handwritten RX).
- **Change:** one key function `wireKey` (lossless for wire data, record keys sorted) used at the four key sites.
  The runtimes are self-contained by design ("served alone"), so the helper is repeated in rt.ts/rt-web.ts/rt-server.ts
  as upstream already does for wireCopy. Server and client compute the same key, so streamed answers still hydrate.
- **Not fixed here:** same-named server fns in different components/modules still share a key (bare declaration name);
  that needs per-declaration identity from the emitter (emit.ts) and its Rust counterpart (compiler/src emit.rs), so it
  is reported, not patched (docs/UPSTREAM-ISSUES.md).
- **Rust parity:** no Rust change is needed: the patch changes only the JS runtimes and the reference interpreter, not
  the checker, model or emitter the crate mirrors; `npm run crate`, `crate --lower` and `crate --project` are
  run on the patched tree (docs/RESULTS.md) to show the crate still agrees with ref/.
- **Upstream issue:** none filed (needs approval).
- **Remove when:** upstream keys server questions losslessly (the regression test passes on an unpatched candidate:
  `sh scripts/canary.sh REV` reports the patch no longer applies or the test passing without it).
