// Billed cost of agent runs (round 5's primary measure), from the agents' transcripts.
// A run's cost is its tokens weighted by their price relative to an uncached input token:
//   input × 1 + cache write × 1.25 + cache read × 0.1 + output × 5
// summed over the run's model calls (each call counted once, however many transcript lines repeat it).
// The test: one-sided permutation test that React's mean cost is higher than .rx's (100,000 relabellings, seeded).
// Usage: node harness/cost.mjs <agents.txt> <transcripts-dir> [out.json]
//   agents.txt: one run per line, `<task>-<arm>-<n> <agent id>`; the transcript is <transcripts-dir>/agent-<id>.jsonl
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

export function usage(file) {
  const seen = new Set();
  const t = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: 0 };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const m = e.message; const u = m?.usage;
    if (!u || seen.has(m.id)) continue;
    seen.add(m.id);
    t.input += u.input_tokens ?? 0; t.cacheWrite += u.cache_creation_input_tokens ?? 0;
    t.cacheRead += u.cache_read_input_tokens ?? 0; t.output += u.output_tokens ?? 0; t.calls++;
  }
  t.billed = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + t[k] * w, 0);
  return t;
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = xs => Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1));

/** one-sided p that mean(a) - mean(b) is this large by chance */
export function permutation(a, b, n = 100000, seed = 5) {
  let s = seed; const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const all = [...a, ...b]; const obs = mean(a) - mean(b); let hits = 0;
  for (let i = 0; i < n; i++) {
    const p = [...all];
    for (let j = p.length - 1; j > 0; j--) { const k = Math.floor(rand() * (j + 1)); [p[j], p[k]] = [p[k], p[j]]; }
    if (mean(p.slice(0, a.length)) - mean(p.slice(a.length)) >= obs) hits++;
  }
  return (hits + 1) / (n + 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [list, dir, out] = process.argv.slice(2);
  const runs = readFileSync(list, "utf8").trim().split("\n").map(l => l.trim().split(/\s+/)).map(([run, id]) => {
    const [, task, arm, n] = run.match(/^(\w+)-(rx|react|xstate|solid|foldkit|vanilla)-(\d+)$/);
    return { run, task, arm, n: Number(n), ...usage(path.join(dir, `agent-${id}.jsonl`)) };
  });
  for (const r of runs) console.log(`${r.run.padEnd(16)} billed ${Math.round(r.billed).toString().padStart(7)}  calls ${r.calls}  out ${r.output}  cacheRead ${r.cacheRead}  cacheWrite ${r.cacheWrite}`);
  const by = arm => runs.filter(r => r.arm === arm).map(r => r.billed);
  const react = by("react"), rx = by("rx"), solid = by("solid");
  for (const [arm, xs] of [["react", react], ["rx", rx], ["solid", solid]]) if (xs.length) console.log(`${arm.padEnd(6)} n ${xs.length}  mean ${Math.round(mean(xs))}  sd ${Math.round(sd(xs))}`);
  const summary = { weights: WEIGHTS, runs };
  if (react.length && rx.length) {
    summary.diff = mean(react) - mean(rx); summary.ratio = mean(rx) / mean(react); summary.p = permutation(react, rx);
    console.log(`React - .rx = ${Math.round(summary.diff)} (.rx/React ${summary.ratio.toFixed(3)}), one-sided permutation p = ${summary.p.toFixed(4)}`);
  }
  if (solid.length && rx.length) {
    summary.solid = { diff: mean(solid) - mean(rx), ratio: mean(rx) / mean(solid), p: permutation(solid, rx) };
    console.log(`Solid - .rx = ${Math.round(summary.solid.diff)} (.rx/Solid ${summary.solid.ratio.toFixed(3)}), one-sided permutation p = ${summary.solid.p.toFixed(4)}`);
  }
  if (out) writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
}
