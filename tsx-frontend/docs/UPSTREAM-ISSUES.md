# Upstream issues found while migrating (found at reactivescript aa85cbde, Solid ac28157)

The frontend's failing set is unchanged at the current pin (reactivescript 8518fa1e, Solid 5e68925c).

Every item is reproduced on the pinned upstream without this package's lowering: by handwritten RX (repro directory or
the handwritten-RX leg of a differential test), or by two upstream backends disagreeing on the same program. Nothing
here has been filed upstream (filing needs the user's approval). "Decision needed" marks items that are not adapter
work: they need an upstream fix (in both the reference and Rust implementations where the crate mirrors it) or a user
decision about the supported boundary.

## Patched (patches/0001-server-question-keys)

1. **Server questions keyed lossily.** Reference interpreter and all three compiled runtimes keyed a server-fn
   question as `name:` + `args.map(fmt).join(",")`. Repro: `upstream-repros/server-question-keys`; pin: interpreter
   and compiled `number/number/a,b/a,b`; expected and patched: `number/string/a,b/a`. Rust: none needed (runtime/
   interpreter only; crate parity re-run on the patched tree: 305/305, 176/176, 176/176).

## Not patched (decision needed)

2. **Aliased error-class imports lose declaration identity** (reference checker AND Rust checker). Repro:
   `upstream-repros/alias-failure-identity`. `scripts/run-rx-repro.ts` and `rxc conform` (the crate binary) both report
   `UNHANDLED_FAILURE main.rx:4 … can fail with Absent and no catch or errored boundary above it discharges Absent`
   although `Absent` and the boundary's `Lost` alias one `Missing`. Signatures also print the importer's alias
   (`rejects(Error | Lost)`). The fix is declaration-keyed failure identity in check.ts, signature.ts and the crate's
   checker together; the old prototype's reference-only refactor is not narrow and would break ref/Rust parity, so it
   is not carried. Affects failure-identities, contracts typed-failure tests.
3. **Same-named server fns in different components/modules share a question.** The key's name is the bare
   declaration name (interpreter `d.name`; emitter `serverRef(J(d.name), …)`). Handwritten RX leg reproduces
   (browser server-factories `4/4` vs `4/5`; server-identities "same-named server factories…"). Needs per-declaration
   identity from the emitter, i.e. emit.ts and the crate's emit.rs (crate --lower parity), so not a runtime patch.
4. **In-place server bodies run inside the client owner.** `serverCall` drives the body under `untrack` but not
   detached from the calling owner (server-identities owner tests). Only observable when bodies run in place (tests,
   local mode); needs an upstream decision whether in-place execution must mimic the server's ownerless context.
5. **Interpreter try/catch/finally approximation.** Callback finalizers: native and compiled TSX agree, the reference
   interpreter differs on the same program (callbacks.test.ts four cases). Upstream's own comment in runtime.ts calls
   its finally handling an approximation.
6. **Interpreter handler returns.** A suspended interpreted handler returns its run's value, never a Promise; compiled
   and native return Promises (async-handlers "lexically async callbacks…", RX interpreted leg; its authored TSX legs
   are refused for now, issue #20).
7. **Compiled callbacks become async when an await is only nested.** A callback whose only await sits inside a nested
   closure or an inline `action { }` compiles to an async function; native returns synchronously (async-handlers,
   handwritten RX compiled legs).
8. **Interpreter shows a pre-action question write early.** In `n := 1; draft := 1; action { … }`, the interpreter
   commits `draft` before the frame native and compiled show (`0/1/…` vs `0/0/…`; RX and TSX interpreted legs).
9. **Reference interpreter vs compiled differences from the old prototype's runtime patches** (own/non-self `pre`
   history, keyed row retention, effect ordering, optional chaining, derived-store pending probes): the
   "legacy core regression" and "upstream interpreter divergence" categories in baselines/observed-failures.json. In
   each, the compiled legs (or the handwritten RX legs) show the same behavior with no TSX involved.
10. **Parser does not terminate** on some non-program inputs, e.g. `parseProgram("<p>x</p>}")` (killed after 10 s).

## Semantic boundaries decided in this package (not defects)

- AC-1b/AC-1c: a plain Solid callback that writes before an await has no RX spelling (upstream holds the write in an
  inferred action and refuses it as HELD_WRITE); the TSX is refused at the callback. Tests prove the refusal on every
  leg and keep the native evidence.
- AC-1d STALE_OWN_READ and IO-2 IO_IN_REACTIVE refuse forms Solid accepts; the refusals are the pinned semantics.
- `untrack(() => storePath)` returning a structured object: RX has only a value snapshot. Accepted only when nothing
  can update the captured object in place (no derived store, no write inside the captured path); otherwise refused.
