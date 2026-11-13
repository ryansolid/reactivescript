// The contract arm: an Exact app (https://github.com/expo/exact), `app.contract` for the interface and `app.ts` for its
// data module, which imports the task's `src/api.js`. A desk is the directory `exact new` makes, with the eval's files
// beside it. EXACT2 names the Exact checkout the desk is made from; the desk's own `exact.mjs` keeps that path.
//
// The build is Exact's web JS target, a release build (`exact.mjs web-build --out`). The data module runs in the page's
// realm, so `src/flights.js` puts `__flights` on the page as it does in every other arm, and the driver is unchanged.
// BUN names the Bun to run `exact.mjs` with (default: `bun` on PATH).
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const bun = () => process.env.BUN ?? "bun";
const exactEnv = () => ({ ...process.env, EXACT_FEEDBACK: "0", NO_COLOR: "1" });

export function exact2() {
  const dir = process.env.EXACT2;
  if (!dir || !existsSync(path.join(dir, "scripts/exact.mjs"))) throw new Error("EXACT2 must name an Exact checkout (its scripts/exact.mjs)");
  return path.resolve(dir);
}

/** `<dir>/dist`, built by the desk's `exact.mjs` (Exact keeps a build inside an app in `dist`, which its source scans
 * skip); a compile error is the `compile` stage's output */
export function buildContract(dir) {
  const dist = path.join(dir, "dist");
  const r = spawnSync(bun(), ["exact.mjs", "web-build", "--out", dist], { cwd: dir, env: exactEnv(), encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) return { ok: false, stage: "compile", output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
  return { ok: true, dist };
}

/** the compiler's diagnostics, warnings included, as the agent's `./check` shows them */
export function checkContract(dir) {
  const r = spawnSync(bun(), ["exact.mjs", "contract", "build", "app.contract"], { cwd: dir, env: exactEnv(), encoding: "utf8", maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || "ok" };
}

/** `exact new <dir>`, then the scaffold's own files go in beside it. The placeholder test is removed: `./test` is the
 * desk's test command, as in every arm. */
export function newContractDesk(dir) {
  if (existsSync(dir)) throw new Error(`${dir} exists; a contract desk starts from \`exact new\``);
  execFileSync(bun(), [path.join(exact2(), "scripts/exact.mjs"), "new", dir], { env: exactEnv(), stdio: "pipe" });
  rmSync(path.join(dir, "app.test.contract"), { force: true });
}

/** Exact's one required guide, for the prompt's inline docs */
export const startHere = () => readFileSync(path.join(exact2(), "docs/start-here.md"), "utf8");

/** copies a reference app's files over a desk's placeholders */
export function copyContractReference(from, dir) {
  for (const f of ["app.contract", "app.ts"]) cpSync(path.join(from, f), path.join(dir, f));
}
