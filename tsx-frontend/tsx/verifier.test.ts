// The verifier must not report readiness (or a valid comparison) from incomplete or failing evidence. These tests run
// scripts/report.ts on synthetic run directories; they do not touch the real observation or manifest files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const report = fileURLToPath(new URL("../scripts/report.ts", import.meta.url));
const outRoot = fileURLToPath(new URL("../.out/", import.meta.url));
const UP = ["test", "oracle", "compiled", "types", "ssr"];
type Row = { status: "pass" | "fail"; name: string; file?: string; error?: string };
type Run = {
  suite?: Row[] | null; browser?: Row[] | null; specCount?: Record<string, number>; noSummary?: string;
  exits?: Record<string, number>; manifest?: string[]; observed?: { failures: Record<string, { category: string; note: string }>; missing: string[] };
};
const pass = (name: string, file = "tsx/a.test.ts"): Row => ({ status: "pass", name, file });
const fail = (name: string, file = "tsx/a.test.ts"): Row => ({ status: "fail", name, file, error: "AssertionError: boom" });

function verdict(run: Run, mode: "ready" | "compare") {
  mkdirSync(outRoot, { recursive: true });
  const dir = mkdtempSync(outRoot + "verifier-");
  try {
    const suite = run.suite === undefined ? [pass("one"), pass("two")] : run.suite;
    const browser = run.browser === undefined ? [pass("hydrates", "tsx/browser.ts")] : run.browser;
    for (const [set, rows] of [["suite", suite], ["browser", browser]] as const) {
      if (rows === null) continue;
      writeFileSync(dir + "/" + set + ".jsonl", rows.map(r => JSON.stringify({ ...r, nesting: 0 })).join("\n") + "\n");
      const n = run.specCount?.[set] ?? rows.length;
      const f = rows.filter(r => r.status === "fail").length;
      writeFileSync(dir + "/" + set + ".spec.txt", run.noSummary === set ? "✔ partial output\n"
        : "ℹ tests " + n + "\nℹ pass " + (n - f) + "\nℹ fail " + f + "\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n");
    }
    const exits: Record<string, number> = { pins: 0, types: 0, suite: suite?.some(r => r.status === "fail") ? 1 : 0,
      browser: browser?.some(r => r.status === "fail") ? 1 : 0, ...Object.fromEntries(UP.map(s => ["upstream-" + s, 0])), ...run.exits };
    writeFileSync(dir + "/exits.txt", Object.entries(exits).map(([k, v]) => k + " " + v).join("\n") + "\n");
    for (const s of UP) writeFileSync(dir + "/upstream-" + s + ".log", s === "test" ? "PASS S-1\n" : "1 pass, 0 fail\n");
    writeFileSync(dir + "/pins.json", JSON.stringify({ upstreamBaseline: { test: "1 pass, 0 fail", oracle: "1 pass, 0 fail", compiled: "1 pass, 0 fail", types: "1 pass, 0 fail", ssr: "1 pass, 0 fail" } }));
    const all = [...(suite ?? []), ...(browser ?? [])].map(r => (r.file ?? "?") + " :: " + r.name);
    writeFileSync(dir + "/manifest.json", JSON.stringify({ tests: run.manifest ?? all }));
    writeFileSync(dir + "/observed.json", JSON.stringify(run.observed ?? { failures: {}, missing: [] }));
    const r = spawnSync(process.execPath, ["--experimental-strip-types", report, "--out", dir, "--mode", mode,
      "--pins", dir + "/pins.json", "--manifest", dir + "/manifest.json", "--observed", dir + "/observed.json"], { encoding: "utf8" });
    return { code: r.status, text: readFileSync(dir + "/REPORT.md", "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("verifier: a complete passing run is READY", () => {
  const v = verdict({}, "ready");
  assert.equal(v.code, 0, v.text);
  assert.match(v.text, /VERDICT: READY/);
});

test("verifier: a known (observed) frontend failure is never READY; comparison can only say it reproduces", () => {
  const observed = { failures: { "tsx/a.test.ts :: two": { category: "x", note: "y" } }, missing: [] };
  const run = { suite: [pass("one"), fail("two")], observed };
  const ready = verdict(run, "ready");
  assert.equal(ready.code, 1);
  assert.match(ready.text, /VERDICT: NOT READY/);
  const compare = verdict(run, "compare");
  assert.equal(compare.code, 0, compare.text);
  assert.match(compare.text, /COMPARISON ONLY/);
  assert.match(compare.text, /VERDICT: NOT READY/);
  assert.match(compare.text, /COMPARISON: reproduces/);
  assert.equal(verdict({ suite: [pass("one"), fail("two")] }, "compare").code, 1, "an unobserved failure differs");
});

test("verifier: a failing upstream runner or type check fails both modes, whatever its log says", () => {
  for (const step of ["upstream-ssr", "upstream-test", "types", "pins"]) {
    assert.equal(verdict({ exits: { [step]: 1 } }, "ready").code, 1, step);
    assert.equal(verdict({ exits: { [step]: 1 } }, "compare").code, 1, step);
  }
  assert.equal(verdict({ exits: { suite: 1 } }, "ready").code, 1, "a suite process failure with passing lines is not ready");
});

test("verifier: missing or truncated results fail both modes", () => {
  for (const run of [{ browser: null }, { suite: null }, { specCount: { suite: 3 } }, { noSummary: "browser" }] as Run[]) {
    assert.equal(verdict(run, "ready").code, 1, JSON.stringify(run));
    assert.equal(verdict(run, "compare").code, 1, JSON.stringify(run));
  }
});

test("verifier: dropped coverage is never READY and must be an observed gap to compare equal", () => {
  const manifest = ["tsx/a.test.ts :: one", "tsx/a.test.ts :: two", "tsx/a.test.ts :: three", "tsx/browser.ts :: hydrates"];
  const ready = verdict({ manifest }, "ready");
  assert.equal(ready.code, 1);
  assert.match(ready.text, /Coverage gaps \(manifest tests that did not run\): 1/);
  assert.equal(verdict({ manifest }, "compare").code, 1, "an unobserved gap differs");
  const observedGap = verdict({ manifest, observed: { failures: {}, missing: ["tsx/a.test.ts :: three"] } }, "compare");
  assert.equal(observedGap.code, 0);
  assert.match(observedGap.text, /VERDICT: NOT READY/);
});
