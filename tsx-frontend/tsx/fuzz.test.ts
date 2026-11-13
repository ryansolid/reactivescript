// Fixed-seed smoke test for the differential fuzzer (tsx/fuzz/, docs/FUZZ.md). For seeds 0..19 the generator must
// emit programs the frontend and the checker accept, TSX and RX must have equal canonical facts and equal frames on
// each backend, and the compiled handwritten RX must match native Solid. The interpreter's divergences from the
// compiled RX are upstream (docs/FUZZ.md, U1/U2) and are asserted exactly, so a change in them is noticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "./fuzz/gen.ts";
import { runCase } from "./fuzz/run.ts";

const SEEDS = Array.from({ length: 20 }, (_, i) => i);
/** Seeds whose only divergence is the interpreter against the compiled RX (docs/FUZZ.md). */
const INTERPRETER_DIVERGES = [14, 17];

test("fuzz smoke: seeds 0..19 are accepted, TSX and RX agree on facts and on every backend, and compiled RX matches native", async () => {
  const interpreter: number[] = [];
  for (const seed of SEEDS) {
    const outcome = await runCase(generate(seed));
    assert.notEqual(outcome.status, "generator-bug", "seed " + seed + ": " + (outcome.status === "generator-bug" ? outcome.message : ""));
    if (outcome.status === "generator-bug") continue;
    for (const [leg, trace] of Object.entries(outcome.traces))
      assert.ok(!trace.some(step => step.startsWith("CRASH")), "seed " + seed + " " + leg + ": " + trace.join(" "));
    if (outcome.status === "ok") continue;
    assert.ok(outcome.facts, "seed " + seed + ": TSX and RX facts differ");
    assert.deepEqual(outcome.classes, ["upstream: interpreter vs compiled"], "seed " + seed);
    interpreter.push(seed);
  }
  assert.deepEqual(interpreter, INTERPRETER_DIVERGES);
});

test("fuzz smoke: generation is deterministic", () => {
  for (const seed of [0, 7, 19]) assert.deepEqual(generate(seed), generate(seed));
});
