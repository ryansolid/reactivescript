# desk9 in Contract (Exact)

Exact team's hand-written reference, from expo/exact `bench/reactivescript/harness.patch` (main 8c742e6a, 2026-11-13).
MIT License, Copyright (c) 2026 650 Industries, Inc. (Expo).

The `contract` arm (`harness/contract.mjs` and its hooks in build, check, scaffold, prompt-arms and score) comes from
the same patch, ported to this harness. It needs `EXACT2` (an Exact checkout, `bun install` and `cargo fetch` run in
it; the web build compiles Exact's Rust workspace once) and Bun on PATH.

Graded here on 2026-11-13 (`harness/grade.sh`): 77/77 hidden, 38/38 overlap, 0/20 fuzz, 0 defects, as in Exact's own
harness.
