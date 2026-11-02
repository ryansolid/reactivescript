// What the agent runs in its directory: `./check` (the arm's compiler feedback) and `./test` (the visible tests).
// Every run is appended to `.runlog` (one JSON line each), which the score reads for iterations and when green came.
// Usage: node harness/agent-cli.mjs <check|test> <dir>
import { appendFileSync } from "node:fs";
import path from "node:path";
import { check } from "./check.mjs";
import { runFile } from "./test.mjs";

const [cmd, dirArg] = process.argv.slice(2);
const dir = path.resolve(dirArg);
const log = entry => appendFileSync(path.join(dir, ".runlog"), JSON.stringify({ at: new Date().toISOString(), cmd, ...entry }) + "\n");

if (cmd === "check") {
  const r = check(dir);
  console.log(r.out.trim());
  log({ ok: r.ok, out: r.out.trim().slice(0, 4000) });
  process.exit(r.ok ? 0 : 1);
} else if (cmd === "test") {
  // the agent's tests run a development build, so the framework's dev diagnostics reach the console and are shown below
  process.env.DEV_BUILD = "1";
  const { build, results } = await runFile(dir, path.join(dir, "tests/visible.mjs"));
  if (!build.ok) console.log(`build failed (${build.stage}):\n${build.output}\n`);
  for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n    ${r.error}`}`);
  const pass = results.filter(r => r.ok).length;
  console.log(`\n${pass}/${results.length} passed`);
  // console warnings and errors from the page, each once, with the tests that printed it
  const seen = new Map();
  for (const r of results) for (const l of r.logs ?? []) { const k = l.split("\n")[0]; if (!seen.has(k)) seen.set(k, { text: l, names: [] }); seen.get(k).names.push(r.name); }
  if (seen.size) {
    console.log(`\nconsole warnings and errors (${seen.size}):`);
    for (const { text, names } of [...seen.values()].slice(0, 20)) console.log(`- ${text}\n  (in ${names.length} test(s), first: ${names[0]})`);
    if (seen.size > 20) console.log(`- … ${seen.size - 20} more`);
  }
  log({ ok: build.ok && pass === results.length, build: build.ok, passed: pass, total: results.length });
  process.exit(pass === results.length ? 0 : 1);
} else { console.error("usage: agent-cli.mjs <check|test> <dir>"); process.exit(2); }
