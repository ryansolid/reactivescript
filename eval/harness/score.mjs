// Scores finished runs: for each run directory (named <task>-<arm>-<n>), the arm's check, the visible and the hidden
// tests, and the agent's own log of `./check` and `./test` runs. Writes results.json and prints a summary table.
// Time: `toolMs` is the agent's time inside `./check` and `./test` (each `.runlog` entry's `ms`), `greenAfterMs` the time
// from its first run to its first passing `./test`; `agentMs`, the whole run's wall time, comes from `<run>/.agent.json`
// (`{ "ms": … }`, written by whoever ran the agent) when there is one. The model's own time is agentMs - toolMs.
// With --overlap, each task's hidden-overlap.mjs (round 3) runs too and counts toward the defect.
// Tests named in `alongside` are run and reported but do not count toward the defect (round 4 pre-registration).
// Usage: node harness/score.mjs <runs-dir> [out.json] [--overlap]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "./check.mjs";
import { runFile } from "./test.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tasksDir = path.resolve(here, "../tasks");
const overlap = process.argv.includes("--overlap");
const [runsArg, outArg] = process.argv.slice(2).filter(a => a !== "--overlap");
const runs = path.resolve(runsArg);
// solidjs/solid#4336: the .rx idiom for this case shows the bug in the runtime, not in the app's code.
const round4Alongside = new Set(["a post on one issue does not show on another"]);
// solidjs/solid#4425 (round 5, rc.20): an Errored recovering after a retry waits for async under a nested Loading;
// it shows in the related task's .rx and Solid references alike.
const round5Alongside = new Set(["a post on one issue does not show on another", "base: retry after not found shows the issue"]);
const round5 = new Set(["desk", "labels", "related", "count", "chain1", "chain2", "chain3", "chain4"]);

const rows = [];
for (const name of readdirSync(runs).sort()) {
  const dir = path.join(runs, name);
  const m = name.match(/^(\w+)-(rx|react|solid|foldkit|vanilla|contract)-(\d+)$/);
  if (!m) continue;
  const [, task, arm, n] = m;
  const alongside = round5.has(task) ? round5Alongside : round4Alongside;
  const log = existsSync(path.join(dir, ".runlog")) ? readFileSync(path.join(dir, ".runlog"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  const firstGreen = log.findIndex(e => e.cmd === "test" && e.ok);
  const startOf = e => Date.parse(e.at) - (e.ms ?? 0);
  const toolMs = log.every(e => e.ms != null) && log.length ? log.reduce((t, e) => t + e.ms, 0) : null;
  const greenAfterMs = firstGreen < 0 || !log.length ? null : Date.parse(log[firstGreen].at) - startOf(log[0]);
  const agent = existsSync(path.join(dir, ".agent.json")) ? JSON.parse(readFileSync(path.join(dir, ".agent.json"), "utf8")) : null;
  const checked = check(dir);
  const visible = await runFile(dir, path.join(tasksDir, task, "visible.mjs"));
  const hidden = await runFile(dir, path.join(tasksDir, task, "hidden.mjs"));
  const extra = overlap ? await runFile(dir, path.join(tasksDir, task, "hidden-overlap.mjs")) : null;
  const failedHidden = hidden.results.filter(r => !r.ok && !alongside.has(r.name));
  const failedOverlap = extra ? extra.results.filter(r => !r.ok && !alongside.has(r.name)) : [];
  const failedAlongside = [...hidden.results, ...(extra ? extra.results : [])].filter(r => !r.ok && alongside.has(r.name));
  rows.push({
    run: name, task, arm, n: Number(n),
    checks: log.filter(e => e.cmd === "check").length, tests: log.filter(e => e.cmd === "test").length,
    cyclesToGreen: firstGreen < 0 ? null : firstGreen + 1,
    agentMs: agent?.ms ?? null, toolMs, greenAfterMs,
    checkOk: checked.ok, built: hidden.build.ok,
    visible: `${visible.results.filter(r => r.ok).length}/${visible.results.length}`,
    hidden: `${hidden.results.length - failedHidden.length}/${hidden.results.length}`,
    ...(extra ? { overlap: `${extra.results.length - failedOverlap.length}/${extra.results.length}`, failedOverlap: failedOverlap.map(r => ({ name: r.name, error: r.error })) } : {}),
    shippedDefect: !hidden.build.ok || visible.results.some(r => !r.ok) || failedHidden.length > 0 || failedOverlap.length > 0,
    failedHidden: failedHidden.map(r => ({ name: r.name, error: r.error })),
    failedAlongside: failedAlongside.map(r => ({ name: r.name, error: r.error })),
    failedVisible: visible.results.filter(r => !r.ok).map(r => ({ name: r.name, error: r.error })),
  });
  const r = rows.at(-1);
  console.log(`${r.run.padEnd(18)} check ${r.checkOk ? "ok " : "ERR"}  visible ${r.visible}  hidden ${r.hidden.padEnd(5)}${r.overlap ? `  overlap ${r.overlap}` : ""}  cycles ${r.checks + r.tests} (green after ${r.cyclesToGreen ?? "never"})${r.agentMs != null ? `  agent ${(r.agentMs / 60000).toFixed(1)}m` : ""}${r.toolMs != null ? `  tools ${(r.toolMs / 60000).toFixed(1)}m` : ""}${r.shippedDefect ? "  DEFECT" : ""}${r.failedAlongside.length ? "  (alongside failed)" : ""}`);
}
writeFileSync(outArg ? path.resolve(outArg) : path.join(runs, "results.json"), JSON.stringify(rows, null, 2) + "\n");
