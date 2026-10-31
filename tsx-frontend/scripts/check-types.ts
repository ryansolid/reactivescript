// Strict type check of this package against the pinned upstream. Upstream's own .ts sources are type-checked too
// (they are imported as source), and upstream does not build under these strict options; those diagnostics are
// compared with baselines/upstream-tsc.txt and reported separately. Any diagnostic in this package fails the check.
// Usage: node --experimental-strip-types scripts/check-types.ts [--out DIR]
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const tsc = spawnSync(process.execPath, [root + "node_modules/typescript/bin/tsc", "-p", root + "tsconfig.json"], { encoding: "utf8", cwd: root });
const diags = tsc.stdout.split("\n").filter(l => /error TS\d+/.test(l));
// In-tree, upstream's sources are the repository's ref/, reported relative to this package as ../ref/.
const UPSTREAM = "../ref/";
const ours = diags.filter(l => !l.startsWith(UPSTREAM));
const normalize = (l: string) => l.replace(/\(\d+,\d+\)/, "").trim();
const theirs = diags.filter(l => l.startsWith(UPSTREAM)).map(normalize).sort();
const expected = readFileSync(root + "baselines/upstream-tsc.txt", "utf8").split("\n").filter(Boolean).sort();
const added = theirs.filter(l => !expected.includes(l));
const removed = expected.filter(l => !theirs.includes(l));
const report = [
  "package diagnostics: " + ours.length, ...ours,
  "upstream strict diagnostics: " + theirs.length + " (baseline " + expected.length + ")",
  ...added.map(l => "  new upstream: " + l), ...removed.map(l => "  gone upstream: " + l),
].join("\n");
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
if (out) writeFileSync(out + "/types.txt", report + "\n");
console.log(report);
process.exitCode = ours.length || added.length || removed.length ? 1 : 0;
