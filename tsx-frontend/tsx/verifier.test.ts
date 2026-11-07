import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTests, checkFuzz, type Row } from "../scripts/report.ts";
const row: Row = { file: "/tmp/work/tsx/a.test.ts", name: "one", status: "pass" };
const expected = ["tsx/a.test.ts :: one"];
const summary = "ℹ tests 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n";
test("verifier: the exact passing test set is accepted", () => {
  assert.deepEqual(checkTests([row], expected, summary), []);
});
test("verifier: a missing, duplicate, renamed, failed, or skipped test fails the gate", () => {
  for (const rows of [[], [row, row], [{ ...row, name: "renamed" }], [{ ...row, status: "fail" }], [{ ...row, status: "skip" }], [{ ...row, status: "todo" }]])
    assert.ok(checkTests(rows, expected, summary).length);
});
test("verifier: a missing or incomplete runner summary fails the gate", () => {
  for (const text of ["", summary.replace("tests 1", "tests 2"), summary.replace("skipped 0", "skipped 1"), summary.replace("cancelled 0", "cancelled 1")])
    assert.ok(checkTests([row], expected, text).length);
});
test("verifier: only listed upstream fuzz differences are informational", () => {
  const finding = { seed: 14, status: "divergent", classes: ["upstream: interpreter vs compiled"] };
  const run = { start: 0, seeds: 200, tally: { ok: 199, divergent: 1 }, findings: [finding] };
  assert.deepEqual(checkFuzz(run, [14]), []);
  assert.ok(checkFuzz(run, []).length);
  for (const classes of [["adapter"], ["semantics"], ["upstream: interpreter vs compiled", "adapter"]])
    assert.ok(checkFuzz({ ...run, findings: [{ ...finding, classes }] }, [14]).length);
  assert.ok(checkFuzz({ ...run, seeds: 199 }, [14]).length);
  assert.ok(checkFuzz({ ...run, findings: [{ seed: 1, status: "generator-bug" }] }, [14]).length);
});
