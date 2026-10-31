// Verdict for a verification run directory written by scripts/verify-pinned.sh.
//
// Two modes, deliberately separate:
//   --mode ready (default)  READINESS. Exit 0 only when every recorded step exited 0, both result sets are complete
//                           (spec summary and JSONL agree), every test in the coverage manifest ran, nothing failed,
//                           nothing was skipped/todo, and the upstream runners ran and matched their pinned summaries.
//   --mode compare          COMPARISON ONLY. Says whether this run reproduces baselines/observed-failures.json
//                           (same failures, same coverage gaps). It never reports readiness: the verdict line is
//                           still NOT READY whenever anything fails. Integrity problems (missing or truncated results,
//                           failed upstream/type steps) fail this mode too.
// Nothing here writes the observation or manifest files; --proposal writes a separate file for human review.
//
// Usage: node --experimental-strip-types scripts/report.ts --out DIR [--mode ready|compare]
//          [--observed FILE] [--manifest FILE] [--pins FILE] [--proposal FILE]
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";

type Result = { status: string; file?: string; name: string; error?: string };
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const here = (p: string) => new URL("../" + p, import.meta.url).pathname;
const out = arg("--out");
if (!out) throw new Error("--out DIR is required");
const mode = arg("--mode") ?? "ready";
if (mode !== "ready" && mode !== "compare") throw new Error("--mode must be ready or compare");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const pins = readJson(arg("--pins") ?? here("pins.json"));
const manifestPath = arg("--manifest") ?? here("baselines/coverage-manifest.json");
const observedPath = arg("--observed") ?? here("baselines/observed-failures.json");
const manifest: { tests: string[] } = existsSync(manifestPath) ? readJson(manifestPath) : { tests: [] };
const observed: { failures: Record<string, { category: string; note: string }>; missing: string[] } =
  existsSync(observedPath) ? readJson(observedPath) : { failures: {}, missing: [] };

const problems: string[] = [];   // integrity: fail in every mode
const notReady: string[] = [];   // readiness blockers

// 1. Recorded process exits (verify-pinned.sh writes "name code" lines); never inferred from log text.
const exits = new Map<string, number>();
if (existsSync(out + "/exits.txt"))
  for (const line of readFileSync(out + "/exits.txt", "utf8").split("\n").filter(Boolean)) {
    const [name, code] = line.trim().split(/\s+/);
    exits.set(name, Number(code));
  }
else problems.push("exits.txt missing: process exit codes were not recorded");
const REQUIRED = ["types", "suite", "browser"];
const UPSTREAM = ["upstream-test", "upstream-oracle", "upstream-compiled", "upstream-types", "upstream-ssr"];
for (const step of REQUIRED) if (!exits.has(step)) problems.push("step " + step + " did not run (no recorded exit)");
for (const step of UPSTREAM) if (!exits.has(step)) notReady.push("upstream runner " + step + " did not run");
for (const [step, code] of exits) {
  if (code === 0) continue;
  if (step === "suite" || step === "browser") notReady.push(step + " exited " + code);
  else problems.push(step + " exited " + code);
}

// 2. Result integrity: the JSONL must be complete relative to the reporter's own summary.
const results: Result[] = [];
for (const set of ["suite", "browser"]) {
  const jsonl = out + "/" + set + ".jsonl", spec = out + "/" + set + ".spec.txt";
  if (!existsSync(jsonl) || !existsSync(spec)) { problems.push(set + ": result files missing"); continue; }
  const rows: Result[] = [];
  for (const line of readFileSync(jsonl, "utf8").split("\n").filter(Boolean)) {
    try { rows.push(JSON.parse(line)); } catch { problems.push(set + ": unparsable result line (truncated?)"); }
  }
  const text = readFileSync(spec, "utf8");
  const count = (label: string) => { const m = text.match(new RegExp("^ℹ " + label + " (\\d+)$", "m")); return m ? Number(m[1]) : undefined; };
  const tests = count("tests"), fail = count("fail"), cancelled = count("cancelled"), skipped = count("skipped"), todo = count("todo");
  if (tests === undefined || fail === undefined) problems.push(set + ": reporter summary missing (truncated run)");
  else {
    if (rows.length !== tests) problems.push(set + ": " + rows.length + " result lines but the reporter counted " + tests + " tests");
    if (rows.filter(r => r.status === "fail").length !== fail) problems.push(set + ": failing result lines disagree with the reporter's fail count " + fail);
  }
  if (cancelled) problems.push(set + ": " + cancelled + " cancelled");
  if (skipped || todo) notReady.push(set + ": " + (skipped ?? 0) + " skipped, " + (todo ?? 0) + " todo (policy: none)");
  if (rows.length === 0) problems.push(set + ": no results");
  results.push(...rows);
}

// 3. Identity (file :: name, with an occurrence index for repeated names) and coverage against the manifest.
const seen = new Map<string, number>();
const keyed = results.map(r => {
  const file = (r.file ?? "?").replace(/^.*\/tsx\//, "tsx/");
  const base = file + " :: " + r.name;
  const n = seen.get(base) ?? 0; seen.set(base, n + 1);
  return { ...r, id: n ? base + " #" + n : base };
});
const ran = new Set(keyed.map(r => r.id));
const missing = manifest.tests.filter(id => !ran.has(id));
const unlisted = keyed.filter(r => !manifest.tests.includes(r.id)).map(r => r.id);
if (!manifest.tests.length) problems.push("coverage manifest missing or empty");
if (missing.length) notReady.push(missing.length + " manifest tests did not run (coverage gap)");

// 4. Upstream summaries against the pins (only for runners that ran).
const summaries = UPSTREAM.filter(s => existsSync(out + "/" + s + ".log")).map(s => {
  const text = readFileSync(out + "/" + s + ".log", "utf8");
  const tally = (w: string) => text.split("\n").filter(l => l.startsWith(w + " ")).length;
  const line = text.split("\n").reverse().find(l => /\d+ pass, \d+ fail/.test(l));
  const summary = line ? line.match(/\d+ pass, \d+ fail(, \d+ skip)?/)![0] : tally("PASS") + tally("FAIL") ? tally("PASS") + " pass, " + tally("FAIL") + " fail" : "(no summary)";
  const expected = pins.upstreamBaseline?.[s.slice("upstream-".length)];
  if (expected !== summary) problems.push(s + ": " + summary + " (pinned " + expected + ")");
  return s + ": " + summary;
});

const failing = keyed.filter(r => r.status === "fail");
if (failing.length) notReady.push(failing.length + " failing tests");
const ready = !problems.length && !notReady.length;

// Comparison against the unapproved observation (compare mode only).
const freshFailures = failing.filter(r => !observed.failures[r.id]).map(r => r.id);
const nowPassing = Object.keys(observed.failures).filter(id => ran.has(id) && !failing.some(r => r.id === id));
const vanished = Object.keys(observed.failures).filter(id => !ran.has(id) && !observed.missing.includes(id));
const newGaps = missing.filter(id => !observed.missing.includes(id));
const closedGaps = observed.missing.filter(id => ran.has(id));
const reproduces = !freshFailures.length && !nowPassing.length && !vanished.length && !newGaps.length && !closedGaps.length;

const lines = [
  "# Verification report (" + (mode === "ready" ? "READINESS" : "COMPARISON ONLY: not a readiness check") + ")",
  "",
  "VERDICT: " + (ready ? "READY" : "NOT READY") + (ready ? "" : " (" + [...problems, ...notReady].length + " blockers)"),
  ...(mode === "compare" ? ["COMPARISON: " + (problems.length ? "INVALID (integrity problems below)" : reproduces ? "reproduces the observed (unapproved) failures and coverage gaps" : "DIFFERS from the observation")] : []),
  "",
  "Results: " + keyed.length + " tests, " + keyed.filter(r => r.status === "pass").length + " pass, " + failing.length + " fail; manifest " + manifest.tests.length + ", missing " + missing.length + ", unlisted " + unlisted.length,
  "Recorded exits: " + [...exits].map(([k, v]) => k + "=" + v).join(" "),
  "",
  "## Integrity problems: " + problems.length, ...problems.map(p => "- " + p),
  "## Readiness blockers: " + notReady.length, ...notReady.map(p => "- " + p),
  "## Upstream runners", ...summaries.map(s => "- " + s),
  "## Coverage gaps (manifest tests that did not run): " + missing.length, ...missing.map(id => "- " + id),
  "## Tests not in the manifest: " + unlisted.length, ...unlisted.map(id => "- " + id),
  "## Failing tests: " + failing.length,
  ...failing.map(r => "- " + r.id + (observed.failures[r.id] ? "  [observed: " + observed.failures[r.id].category + "]" : "  [NEW]") + "\n  " + (r.error ?? "").split("\n")[0].slice(0, 200)),
  ...(mode === "compare" ? [
    "## Comparison with " + observedPath,
    "- new failures: " + freshFailures.length, ...freshFailures.map(id => "  - " + id),
    "- observed failures now passing: " + nowPassing.length, ...nowPassing.map(id => "  - " + id),
    "- observed failures that did not run: " + vanished.length, ...vanished.map(id => "  - " + id),
    "- new coverage gaps: " + newGaps.length, ...newGaps.map(id => "  - " + id),
    "- observed gaps now closed: " + closedGaps.length, ...closedGaps.map(id => "  - " + id),
  ] : []),
];
writeFileSync(out + "/REPORT.md", lines.join("\n") + "\n");
console.log(lines.slice(0, 6).join("\n"));
const proposal = arg("--proposal");
if (proposal) {
  writeFileSync(proposal, JSON.stringify({ status: "PROPOSAL ONLY: unapproved observation, not a readiness baseline",
    failures: Object.fromEntries(failing.map(r => [r.id, observed.failures[r.id] ?? { category: "UNREVIEWED", note: (r.error ?? "").split("\n")[0].slice(0, 200) }])),
    missing }, null, 2) + "\n");
}
process.exitCode = mode === "ready" ? (ready ? 0 : 1) : (!problems.length && reproduces ? 0 : 1);
